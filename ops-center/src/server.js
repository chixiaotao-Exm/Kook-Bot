import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { AdminAuth } from './auth.js';
import { OpsError } from './storage.js';

const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class OpsServer {
  constructor({ config, engine, auth, bodyTimeoutMs = 10000 }) {
    Object.assign(this, { config, engine, bodyTimeoutMs }); this.origin = new URL(config.publicUrl); this.basePath = this.origin.pathname.replace(/\/$/, '');
    this.auth = auth || new AdminAuth({ baseUrl: config.sub2apiUrl }); this.agentAttempts = new Map();
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.headersTimeout = 5000; this.server.requestTimeout = 15000; this.server.maxHeadersCount = 40;
  }
  json(res, status, data) {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
  }
  cookie(res, session) {
    res.setHeader('Set-Cookie', `ops_session=${session?.id || ''}; HttpOnly; SameSite=Strict; Path=${this.basePath}/; Max-Age=${session ? Math.max(1, Math.floor((session.expires - Date.now()) / 1000)) : 0}${this.origin.protocol === 'https:' ? '; Secure' : ''}`);
  }
  authorize(req, { admin = true } = {}) {
    if (req.headers.origin && req.headers.origin !== this.origin.origin) throw new OpsError('请求来源不匹配。', 403);
    const session = this.auth.get(req.headers.cookie);
    if (!session || admin && session.user?.role !== 'admin') throw new OpsError('请登录 Sub2API 管理员账号。', 401);
    if (req.method !== 'GET' && !equal(req.headers['x-csrf-token'], session.csrf)) throw new OpsError('会话已更新，请重新登录。', 403);
    return session;
  }
  async body(req, limit = 16384) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new OpsError('请提交 JSON 数据。', 415);
    if (Number(req.headers['content-length']) > limit) throw new OpsError('请求内容过长。', 413);
    let timer;
    try {
      return await Promise.race([(async () => {
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > limit) throw new OpsError('请求内容过长。', 413); chunks.push(part); }
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new OpsError('JSON 格式错误。'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpsError('请求格式错误。'); return value;
      })(), new Promise((_, reject) => { timer = setTimeout(() => { reject(new OpsError('请求超时。', 408)); req.destroy(); }, this.bodyTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = this.basePath && url.pathname.startsWith(this.basePath + '/') ? url.pathname.slice(this.basePath.length) : url.pathname;
      if (route === '/health' && req.method === 'GET') {
        const query = this.engine.queryBotStatus?.() || {};
        return this.json(res, this.engine.store.failed ? 503 : 200, { status: this.engine.store.failed ? 'degraded' : 'ok', ok: !this.engine.store.failed,
          gateway: { connected: query.connected === true }, chat: { enabled: query.enabled === true } });
      }
      if (route === '/api/agent/report' && req.method === 'POST') {
        const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        const host = this.config.hosts.find(item => equal(token, item.token));
        if (!host) throw new OpsError('采集凭据无效。', 401);
        const last = this.agentAttempts.get(host.id) || 0;
        if (Date.now() - last < 1000) throw new OpsError('采集过于频繁。', 429);
        this.agentAttempts.set(host.id, Date.now());
        const body = await this.body(req, 128 * 1024); return this.json(res, 200, await this.engine.ingest(host, body));
      }
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new OpsError('请求方法不支持。', 405);
        if (url.pathname === this.basePath) { res.writeHead(302, { Location: this.basePath + '/' }); return res.end(); }
        const file = files[route]; if (!file) throw new OpsError('页面不存在。', 404);
        const value = await readFile(new URL('../public/' + file[0], import.meta.url)); res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' }); return res.end(req.method === 'HEAD' ? undefined : value);
      }
      if (url.search) throw new OpsError('接口不接受 URL 参数。');
      if (!['GET', 'POST'].includes(req.method)) throw new OpsError('请求方法不支持。', 405);
      if (req.headers.origin && req.headers.origin !== this.origin.origin) throw new OpsError('请求来源不匹配。', 403);
      if (route === '/api/session' && req.method === 'GET') {
        let session = this.auth.get(req.headers.cookie); if (!session) { session = this.auth.create(); this.cookie(res, session); }
        return this.json(res, 200, { authenticated: session.user?.role === 'admin', csrf: session.csrf, user: session.user });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const before = this.authorize(req, { admin: false }), body = await this.body(req);
        this.authorize(req, { admin: false });
        const result = await this.auth.login(body, req.socket.remoteAddress || 'unknown');
        if (this.authorize(req, { admin: false }).id !== before.id) throw new OpsError('登录会话已改变。', 401);
        this.auth.logout(before); const session = this.auth.create(result.user, result.expires); this.cookie(res, session);
        return this.json(res, 200, { authenticated: true, csrf: session.csrf, user: session.user });
      }
      if (route === '/api/logout' && req.method === 'POST') {
        this.auth.logout(this.authorize(req, { admin: false })); this.cookie(res, null); return this.json(res, 200, { authenticated: false });
      }
      this.authorize(req);
      if (route === '/api/snapshot' && req.method === 'GET') return this.json(res, 200, this.engine.snapshot());
      if (route === '/api/commands' && req.method === 'POST') {
        const body = await this.body(req); const command = await this.engine.command(body, () => this.authorize(req)); return this.json(res, 202, { command });
      }
      if (route === '/api/maintenance' && req.method === 'POST') {
        const body = await this.body(req); return this.json(res, 200, await this.engine.maintenance(body, () => this.authorize(req)));
      }
      throw new OpsError('接口不存在。', 404);
    } catch (error) { return this.json(res, error instanceof OpsError ? error.status : 503, { error: error instanceof OpsError ? error.message : '运维服务暂时不可用。' }); }
  }
  async start() { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.host, resolve); }); return this.server.address(); }
  async close() { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
}
