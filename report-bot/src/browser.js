import { ORIGIN, submitReport, validateProfile } from './protocol.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const SESSION = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const failure = kind => ({ kind, message: kind === 'not_sent' ? '浏览器会话尚未就绪，未发送举报。' : '提交结果未知，请先查看邮箱或官网；不会自动重试。' });

async function readJson(response, signal, maxBytes = 2 * 1024 * 1024) {
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > maxBytes) throw Error('Browser unavailable');
  const reader = response.body?.getReader(); if (!reader) throw Error('Browser unavailable');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > maxBytes) throw Error('Browser response too large'); chunks.push(value);
    }
    signal.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const validBrowserUrl = value => typeof value === 'string' && /^http:\/\/127\.0\.0\.1:819[1-4]$/.test(value);

/** A read-only readiness probe never creates a browser or sends an official request. */
export async function browserAvailable(baseUrl, { signal, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  if (!validBrowserUrl(baseUrl)) throw Error('Invalid browser configuration');
  const controller = new AbortController();
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(Error('Browser health check interrupted'));
    active.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try {
    active.throwIfAborted();
    const result = await Promise.race([stopped, (async () => {
      const response = await fetchImpl(baseUrl + '/health', { method: 'GET', redirect: 'error', signal: active });
      return readJson(response, active, 1024);
    })()]);
    return result?.ok === true && result?.available === true;
  } finally { clearTimeout(timer); active.removeEventListener('abort', abort); controller.abort(); }
}

// This private adapter never uses FlareSolverr request.post, which can replay a POST.
export function createBrowserSubmitter(profile, enabled, { baseUrl, token, fetchImpl = fetch,
  prepareTimeoutMs = 45000, requestTimeoutMs = 25000, closeTimeoutMs = 12000 } = {}) {
  if (enabled) validateProfile(profile);
  if (!validBrowserUrl(baseUrl) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid browser configuration');
  for (const timeout of [prepareTimeoutMs, requestTimeoutMs, closeTimeoutMs]) if (!Number.isInteger(timeout) || timeout < 1 || timeout > 45000) throw Error('Invalid browser timeout');
  const safeProfile = Object.fromEntries(['email', 'steam', 'nickname', 'language', 'category'].map(key => [key, profile?.[key]]));
  async function api(route, body, timeout, signal) {
    const controller = new AbortController(); const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let abort, timer;
    const deadline = new Promise((_, reject) => {
      abort = () => reject(Error('Browser request interrupted')); active.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), timeout);
    });
    try {
      active.throwIfAborted();
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(baseUrl + route, { method: 'POST', redirect: 'error', signal: active,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return readJson(response, active);
      })()]);
    } finally { clearTimeout(timer); active.removeEventListener('abort', abort); controller.abort(); }
  }
  return async function submit(draft, { signal } = {}) {
    if (!enabled) return failure('not_sent');
    let sessionId, postStarted = false;
    try {
      const prepared = await api('/prepare', {}, prepareTimeoutMs, signal);
      if (!SESSION.test(prepared?.sessionId || '')) throw Error('Invalid browser session');
      sessionId = prepared.sessionId;
      const browserFetch = async (url, options = {}) => {
        options.signal?.throwIfAborted();
        const method = options.method || 'GET';
        if (method === 'POST') { if (postStarted) throw Error('POST replay refused'); postStarted = true; }
        const answer = await api('/request', { sessionId, method, url: String(url), ...(method === 'POST' ? { body: options.body } : {}) }, requestTimeoutMs, options.signal);
        if (!Number.isInteger(answer?.status) || answer.status < 0 || answer.status > 599 || typeof answer.body !== 'string'
          || Buffer.byteLength(answer.body) > 512 * 1024 || typeof answer.url !== 'string') throw Error('Invalid browser result');
        const returned = new URL(answer.url);
        if (returned.origin !== ORIGIN || returned.username || returned.password) throw Error('Invalid browser destination');
        const response = new Response(answer.body, { status: 200 });
        Object.defineProperties(response, { status: { value: answer.status }, ok: { value: answer.status >= 200 && answer.status < 300 }, url: { value: answer.url } });
        return response;
      };
      return await submitReport({ ...safeProfile, subject: draft?.subject }, draft?.player, draft?.description, browserFetch, undefined,
        { signal, sessionTimeoutMs: 12000, submitTimeoutMs: requestTimeoutMs, wasPostSent: () => postStarted });
    } catch { return failure(postStarted ? 'unknown' : 'not_sent'); }
    finally {
      if (sessionId) {
        // A timed-out request can briefly hold the adapter lock. Closing this
        // exact session is idempotent; only cleanup may be retried, never POST.
        const deadline = Date.now() + closeTimeoutMs;
        while (Date.now() < deadline) {
          try { await api('/close', { sessionId }, Math.max(1, deadline - Date.now())); break; }
          catch { await sleep(Math.min(200, Math.max(0, deadline - Date.now()))); }
        }
      }
    }
  };
}
