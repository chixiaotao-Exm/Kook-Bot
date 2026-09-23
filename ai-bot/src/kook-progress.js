import { modelFailureMessage, sanitizeFailureCode } from './failure.js';

const CREATE_URL = 'https://www.kookapp.cn/api/v3/message/create';
const UPDATE_URL = 'https://www.kookapp.cn/api/v3/message/update';
const CHANNEL_ID = /^\d{5,30}$/;
const MESSAGE_ID = /^[a-f0-9-]{16,100}$/i;
const MAX_BYTES = 32 * 1024;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS = [2000, 4000, 8000, 15000];
const MAX_RETRY_AFTER_MS = 300000;
const PHASES = Object.freeze({
  received: { active: '已接收', done: '已接收' },
  generating: { active: 'AI 生成中', done: 'AI 已生成' },
  rendering: { active: '渲染图片', done: '图片已渲染' },
  uploading: { active: '上传内容', done: '内容已上传' },
  sending: { active: '发送回复', done: '回复已发送' },
});
const PHASE_ORDER = Object.keys(PHASES);

export class KookProgressError extends Error {
  constructor(code) { super(code); this.name = 'KookProgressError'; this.code = code; }
}

const error = (code, retryable = false, retryAfterMs = 0) => Object.assign(new KookProgressError(code), { retryable, retryAfterMs });
const plain = content => ({ type: 'plain-text', content, emoji: false });
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }
function retryAfter(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed);
  // Do not interpret malformed values such as "1.5" as a calendar date.
  if (!seconds && !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return 0;
  const delay = seconds ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isNaN(delay) ? 0 : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
}

function elapsedLabel(duration) {
  const seconds = Number.isFinite(duration) && duration >= 0
    ? Math.floor(Math.min(duration, Number.MAX_SAFE_INTEGER) / 1000) : 0;
  const digits = number => String(number).padStart(2, '0');
  return seconds >= 3600 ? `${digits(Math.floor(seconds / 3600))}:${digits(Math.floor(seconds / 60) % 60)}:${digits(seconds % 60)}`
    : `${digits(Math.floor(seconds / 60))}:${digits(seconds % 60)}`;
}

function card({ visited, phase, terminal, duration, paused = false, detail = '' }) {
  const title = terminal ? { finished: '已完成', failed: '处理失败', cancelled: '已取消' }[terminal.kind] : paused ? '已暂停' : 'AI 正在处理';
  const lines = visited.map(step => {
    if (step !== phase || terminal?.kind === 'finished') return `✓ ${PHASES[step].done}`;
    if (terminal || paused) return `${terminal?.kind === 'failed' ? '✕' : '—'} ${PHASES[step].active}`;
    return `⏳ ${PHASES[step].active}`;
  });
  const modules = [{ type: 'header', text: plain(title) }, { type: 'section', text: plain(lines.join('\n')) }];
  if (detail) modules.push({ type: 'section', text: plain(detail) });
  if (terminal?.kind === 'failed') modules.push({ type: 'section', text: plain(modelFailureMessage(terminal.code)) });
  modules.push({ type: 'context', elements: [plain(`已用时 ${elapsedLabel(duration)}`)] });
  return JSON.stringify([{ type: 'card', size: 'sm', theme: terminal
    ? { finished: 'success', failed: 'danger', cancelled: 'warning' }[terminal.kind] : 'secondary', modules }]);
}

async function readJson(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) {
    cancelBody(response.body);
    throw error('KOOK_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw error('KOOK_INVALID_RESPONSE');
  const chunks = []; let size = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw error('KOOK_ABORTED');
      const { done, value } = await reader.read();
      if (signal.aborted) throw error('KOOK_ABORTED');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw error('KOOK_INVALID_RESPONSE');
      size += value.byteLength;
      if (size > MAX_BYTES) throw error('KOOK_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw error('KOOK_INVALID_RESPONSE'); }
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    try { reader.releaseLock(); } catch {}
  }
}

/** One status card per request. Updates show observable stages and elapsed time. */
export function createKookProgress({ token, fetchImpl = globalThis.fetch, now = Date.now,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, timeoutMs = 10000, intervalMs = 15000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || token.length > 512 || /[\x00-\x20\x7f]/.test(token.trim())
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || typeof setIntervalImpl !== 'function' || typeof clearIntervalImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) throw error('KOOK_INVALID_INPUT');
  const authorization = `Bot ${token.trim()}`;

  async function request(url, payload, signal) {
    if (signal?.aborted) throw error('KOOK_ABORTED');
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BYTES) throw error('KOOK_INVALID_INPUT');
    const controller = new AbortController(); let rejectInterrupted, timedOut = false;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    const abort = () => { rejectInterrupted(error('KOOK_ABORTED')); controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; rejectInterrupted(error('KOOK_TIMEOUT')); controller.abort(); }, timeoutMs);
    try {
      const send = async () => {
        const response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body });
        if (controller.signal.aborted) { cancelBody(response?.body); throw error('KOOK_ABORTED'); }
        if (!response?.ok || response.redirected || response.status >= 300 && response.status < 400) {
          cancelBody(response?.body);
          const retryable = !response?.redirected && RETRY_STATUSES.has(response?.status);
          throw error(response?.status === 429 ? 'KOOK_RATE_LIMITED' : 'KOOK_REJECTED', retryable,
            retryable ? retryAfter(response.headers?.get('retry-after'), now()) : 0);
        }
        const result = await readJson(response, controller.signal);
        if (result?.code !== 0) throw error('KOOK_REJECTED');
        return result.data;
      };
      return await Promise.race([send(), interrupted]);
    } catch (caught) {
      if (signal?.aborted) throw error('KOOK_ABORTED');
      if (timedOut) throw error('KOOK_TIMEOUT', true);
      if (caught instanceof KookProgressError) throw caught;
      throw error('KOOK_NETWORK', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  return {
    async start({ targetId, replyMessageId, signal } = {}) {
      if (typeof targetId !== 'string' || !CHANNEL_ID.test(targetId)
        || typeof replyMessageId !== 'string' || !MESSAGE_ID.test(replyMessageId)) throw error('KOOK_INVALID_INPUT');
      if (signal?.aborted) throw error('KOOK_ABORTED');
      const startedAt = now();
      const visited = ['received', 'generating'];
      let phase = 'generating', terminal = null, interval = null, dirty = false, running = null;
      let updatesStopped = false, retryPending = false, failures = 0, terminalAttempts = 0;
      let pausedAt = null, pausedDuration = 0, detail = '';
      const content = () => card({ visited, phase, terminal, paused: pausedAt !== null, detail,
        duration: (terminal?.at ?? pausedAt ?? now()) - startedAt - pausedDuration });
      const created = await request(CREATE_URL, { type: 10, target_id: targetId,
        content: card({ visited, phase, terminal, duration: 0 }), quote: replyMessageId, reply_msg_id: replyMessageId }, signal);
      if (typeof created?.msg_id !== 'string' || !MESSAGE_ID.test(created.msg_id)) throw error('KOOK_INVALID_RESPONSE');
      const messageId = created.msg_id;

      const clearTicker = () => {
        if (interval !== null) { clearIntervalImpl(interval); interval = null; }
      };
      const stopUpdates = () => {
        updatesStopped = true; dirty = false; retryPending = false; clearTicker();
        signal?.removeEventListener('abort', onAbort);
      };
      function schedule(delay, retry = false) {
        clearTicker();
        if (updatesStopped) return;
        const scheduled = setIntervalImpl(() => {
          if (interval !== scheduled) return;
          if (retry) { clearTicker(); retryPending = false; }
          void queue();
        }, delay);
        interval = scheduled; interval?.unref?.();
      }
      function scheduleNormal() {
        if (!updatesStopped && !terminal && pausedAt === null && !retryPending && interval === null) schedule(intervalMs);
      }

      async function drain() {
        try {
          while (dirty && !updatesStopped && !retryPending) {
            dirty = false;
            const isTerminal = Boolean(terminal);
            if (isTerminal) terminalAttempts++;
            try {
              // A cancellation still needs to edit this card. Its final update uses
              // a fresh bounded request, independent of the cancelled model signal.
              await request(UPDATE_URL, { msg_id: messageId, content: content() });
              failures = 0;
              if (isTerminal) { stopUpdates(); break; }
              scheduleNormal();
            } catch (caught) {
              if (!caught.retryable || isTerminal && terminalAttempts >= 3) { stopUpdates(); break; }
              const delay = Math.max(RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)],
                caught.retryAfterMs || 0, caught.code === 'KOOK_RATE_LIMITED' ? intervalMs : 0);
              // Updating a known card is retryable. Keep only the latest state
              // and return without making callers wait through the backoff.
              dirty = true; retryPending = true; schedule(delay, true); break;
            }
          }
        } finally {
          // Release ownership in the same turn as the last dirty check. Deferring
          // this to Promise.finally could lose a phase queued between microtasks.
          running = null;
        }
      }

      function queue() {
        if (updatesStopped) return running || Promise.resolve();
        dirty = true;
        if (retryPending) return running || Promise.resolve();
        if (!running) running = drain().catch(stopUpdates);
        return running;
      }

      function close(kind, code) {
        if (terminal) return running || Promise.resolve();
        const at = now();
        if (pausedAt !== null) { pausedDuration += Math.max(0, at - pausedAt); pausedAt = null; }
        terminal = { kind, code: sanitizeFailureCode(code), at };
        failures = 0;
        // Preserve an existing rate-limit deadline when switching to terminal.
        if (!retryPending) clearTicker();
        signal?.removeEventListener('abort', onAbort);
        return queue();
      }

      const handle = {
        setDetail(value) {
          if (terminal || typeof value !== 'string' || value.length > 160
            || /(?:sk-[A-Za-z0-9_-]{12,}|admin-[a-f0-9]{16,}|\d+\/[A-Za-z0-9+/=]+\/[A-Za-z0-9+/=]+)/i.test(value)) return running || Promise.resolve();
          detail = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); return queue();
        },
        pause() {
          if (terminal || pausedAt !== null) return running || Promise.resolve();
          pausedAt = now(); if (!retryPending) clearTicker(); return queue();
        },
        resume() {
          if (terminal || pausedAt === null) return running || Promise.resolve();
          pausedDuration += Math.max(0, now() - pausedAt); pausedAt = null;
          scheduleNormal();
          return queue();
        },
        setPhase(next) {
          if (terminal || typeof next !== 'string' || !Object.hasOwn(PHASES, next)
            || PHASE_ORDER.indexOf(next) <= PHASE_ORDER.indexOf(phase)) return running || Promise.resolve();
          phase = next; visited.push(next);
          return queue();
        },
        finish: () => close('finished'),
        fail: code => close('failed', code),
        cancel: () => close('cancelled'),
      };
      function onAbort() { void handle.cancel(); }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) await handle.cancel();
      else scheduleNormal();
      return handle;
    },
  };
}
