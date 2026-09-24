import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeGithubEvent } from './events.js';

const EVENTS = new Set(['push', 'pull_request', 'workflow_run', 'ping']);
const DELIVERY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
class RequestError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

export function verifySignature(raw, signature, secret) {
  if (!(raw instanceof Uint8Array) || typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), 'hex');
  return timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), actual);
}

export class BridgeServer {
  constructor({ host = '127.0.0.1', port = 18997, repository, secret, queue, logger = () => {}, maxBodyBytes = 1024 * 1024, bodyTimeoutMs = 10000 }) {
    if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535
      || typeof repository !== 'string' || typeof secret !== 'string' || secret.length < 32
      || typeof queue?.enqueue !== 'function' || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 2 * 1024 * 1024
      || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 10000) throw new Error('Invalid bridge listener');
    Object.assign(this, { host, port, repository, secret, queue, logger, maxBodyBytes, bodyTimeoutMs });
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 10000; this.server.headersTimeout = 5000;
    this.server.maxHeadersCount = 32;
  }
  json(res, status, data) {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
  singleHeader(req, name) {
    const values = req.headersDistinct?.[name];
    if (!values || values.length !== 1) throw new RequestError(400, 'invalid_headers');
    return values[0];
  }
  async body(req) {
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > this.maxBodyBytes)) throw new RequestError(413, 'payload_too_large');
    let timer, expired = false;
    const timeout = new Promise((_, reject) => {
      // Node's requestTimeout is checked periodically (30s by default). This
      // absolute body deadline also stops slow trickles and releases the socket.
      timer = setTimeout(() => {
        expired = true; reject(new RequestError(408, 'request_timeout')); req.destroy();
      }, this.bodyTimeoutMs);
    });
    const read = async () => {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        if (expired) throw new RequestError(408, 'request_timeout');
        size += chunk.length;
        if (size > this.maxBodyBytes) throw new RequestError(413, 'payload_too_large');
        chunks.push(chunk);
      }
      if (expired) throw new RequestError(408, 'request_timeout');
      return Buffer.concat(chunks);
    };
    try { return await Promise.race([read(), timeout]); }
    finally { clearTimeout(timer); }
  }
  async handle(req, res) {
    try {
      if (req.url === '/health' && req.method === 'GET') return this.json(res, 200, { status: 'ok', queue: this.queue.snapshot?.() || {} });
      if (req.url !== '/github') return this.json(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed' });
      const eventName = this.singleHeader(req, 'x-github-event'), deliveryId = this.singleHeader(req, 'x-github-delivery');
      const signature = this.singleHeader(req, 'x-hub-signature-256');
      if (!EVENTS.has(eventName) || !DELIVERY.test(deliveryId)) throw new RequestError(400, 'invalid_event');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
        || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new RequestError(415, 'unsupported_content_type');
      const raw = await this.body(req);
      if (!verifySignature(raw, signature, this.secret)) throw new RequestError(401, 'invalid_signature');
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { throw new RequestError(400, 'invalid_json'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof payload.repository?.full_name !== 'string'
        || payload.repository.full_name.toLowerCase() !== this.repository.toLowerCase()) throw new RequestError(403, 'repository_not_allowed');
      if (eventName === 'ping') { this.logger({ event: 'github_ping' }); return this.json(res, 200, { pong: true }); }
      const notification = normalizeGithubEvent(eventName, payload, { repository: this.repository, deliveryId });
      if (!notification) return this.json(res, 200, { ignored: true });
      const result = await this.queue.enqueue(notification);
      this.logger({ event: 'github_event', kind: notification.kind, outcome: result.duplicate ? 'duplicate' : 'queued' });
      return this.json(res, result.duplicate ? 200 : 202, { accepted: !result.duplicate, duplicate: Boolean(result.duplicate) });
    } catch (error) {
      if (error instanceof RequestError) return this.json(res, error.status, { error: error.code });
      this.logger({ event: 'bridge_request_failed' });
      return this.json(res, 503, { error: 'bridge_temporarily_unavailable' });
    }
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); });
    return this.server.address();
  }
  async close() { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
}
