import tls from 'node:tls';
import { isIP } from 'node:net';

const MAX_BYTES = 128 * 1024;
const ERRORS = { CONFIG: '监控配置无效。', TIMEOUT: '监控请求超时。', NETWORK: '网站或接口连接失败。',
  REDIRECT: '监控地址发生重定向。', HTTP: '接口状态码不符合预期。', BODY: '响应内容过大或格式无效。',
  JSON: '接口健康字段不符合预期。', TLS: 'TLS 证书验证或有效期检查失败。' };
const fault = code => Object.assign(new Error(ERRORS[code]), { code });
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

async function readBody(response, signal, json) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) {
    cancelBody(response.body); throw fault('BODY');
  }
  if (!response.body) { if (!json) return null; throw fault('BODY'); }
  if (!response.body.getReader) { cancelBody(response.body); throw fault('BODY'); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw fault('TIMEOUT');
      const { done, value } = await reader.read();
      if (signal.aborted) throw fault('TIMEOUT');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fault('BODY');
      bytes += value.byteLength; if (bytes > MAX_BYTES) throw fault('BODY');
      if (json) chunks.push(Buffer.from(value));
    }
    if (!json) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw fault('BODY'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

function certificateDays(url, { signal, now, connect }) {
  return new Promise((resolve, reject) => {
    let socket, finished = false;
    const settle = (error, days) => {
      if (finished) return; finished = true;
      signal.removeEventListener('abort', abort);
      socket?.destroy();
      if (error) reject(error); else resolve(days);
    };
    const abort = () => settle(fault('TIMEOUT'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      socket = connect({ host: hostname, port: Number(url.port || 443), rejectUnauthorized: true,
        ...(isIP(hostname) ? {} : { servername: hostname }) });
      socket.once('secureConnect', () => {
        try {
          const expires = Date.parse(socket.getPeerCertificate()?.valid_to), remaining = expires - now();
          if (socket.authorized !== true || !Number.isFinite(remaining) || remaining <= 0) { settle(fault('TLS')); return; }
          settle(null, Math.floor(remaining / 86400000));
        } catch { settle(fault('TLS')); }
      });
      socket.once('error', () => settle(fault('TLS')));
      socket.once('close', () => { if (!finished) settle(fault('TLS')); });
      if (signal.aborted) abort();
    } catch { settle(fault('TLS')); }
  });
}

/** Call only with server-owned monitor definitions; browsers never provide targets. */
export async function probeMonitor(monitor, { fetchImpl = fetch, now = Date.now, monotonicNow = () => performance.now(),
  tlsConnectImpl = tls.connect, timeoutMs = 8000 } = {}) {
  const checkedAt = new Date(now()).toISOString();
  let url, keys;
  try {
    url = new URL(monitor?.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname
      || typeof monitor.url !== 'string' || monitor.url.length > 2048 || /[\x00-\x20\x7f\\]/.test(monitor.url)
      || !Number.isInteger(monitor.expectedStatus) || monitor.expectedStatus < 100 || monitor.expectedStatus > 599
      || typeof fetchImpl !== 'function' || typeof tlsConnectImpl !== 'function' || typeof monotonicNow !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw 0;
    if (monitor.jsonPath !== undefined) {
      if (typeof monitor.jsonPath !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/.test(monitor.jsonPath)
        || !['string', 'number', 'boolean'].includes(typeof monitor.jsonEquals) && monitor.jsonEquals !== null
        || typeof monitor.jsonEquals === 'number' && !Number.isFinite(monitor.jsonEquals)) throw 0;
      keys = monitor.jsonPath.split('.');
      if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw 0;
    }
  } catch { return { ok: false, latencyMs: null, httpStatus: null, tlsDays: null, error: ERRORS.CONFIG, checkedAt }; }
  const started = monotonicNow(), controller = new AbortController();
  let httpStatus = null, tlsDays = null, timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(fault('TIMEOUT'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  const http = async () => {
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: keys ? 'application/json' : '*/*' } });
    if (controller.signal.aborted) { cancelBody(response?.body); throw fault('TIMEOUT'); }
    httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (response?.redirected || response?.type === 'opaqueredirect' || httpStatus >= 300 && httpStatus < 400) {
      cancelBody(response?.body); throw fault('REDIRECT');
    }
    if (httpStatus !== monitor.expectedStatus) { cancelBody(response?.body); throw fault('HTTP'); }
    const data = await readBody(response, controller.signal, Boolean(keys));
    if (keys) {
      let value = data;
      for (const key of keys) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
      if (value !== monitor.jsonEquals) throw fault('JSON');
    }
  };
  const certificate = url.protocol === 'https:' ? certificateDays(url, { signal: controller.signal, now, connect: tlsConnectImpl })
    .then(days => { if (!controller.signal.aborted) tlsDays = days; }) : Promise.resolve();
  try {
    await Promise.race([Promise.all([http(), certificate]), interrupted]);
    return { ok: true, latencyMs: Math.max(0, Math.round(monotonicNow() - started)), httpStatus, tlsDays, error: null, checkedAt };
  } catch (error) {
    return { ok: false, latencyMs: Math.max(0, Math.round(monotonicNow() - started)), httpStatus, tlsDays,
      error: ERRORS[error?.code] || ERRORS.NETWORK, checkedAt };
  } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controller.abort(); }
}
