const ENDPOINT = 'https://www.kookapp.cn/api/v3/message/create';
const CHANNEL_ID = /^\d{5,30}$/;
const MESSAGE_ID = /^[a-f0-9-]{16,100}$/i;
const MAX_TEXT = 6000;
const MAX_PAYLOAD = 8000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const TRUNCATED = '\n\n（回答较长，后续内容已截断）';

export class KookReplyError extends Error {
  constructor(code) { super(code); this.name = 'KookReplyError'; this.code = code; }
}

function prefix(text, length) {
  let end = Math.min(length, text.length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function card(text) {
  const modules = [];
  while (text) {
    let section = prefix(text, 1800);
    if (text.length > section.length) {
      const newline = section.lastIndexOf('\n');
      if (newline >= 900) section = section.slice(0, newline + 1);
    }
    modules.push({ type: 'section', text: { type: 'plain-text', content: section, emoji: false } });
    text = text.slice(section.length);
  }
  return [{ type: 'card', theme: 'secondary', size: 'lg', modules }];
}

function payload({ targetId, replyMessageId, content }) {
  if (!CHANNEL_ID.test(targetId || '') || typeof targetId !== 'string'
    || typeof replyMessageId !== 'string' || !MESSAGE_ID.test(replyMessageId)
    || typeof content !== 'string') throw new KookReplyError('KOOK_INVALID_INPUT');
  // Plain-text card elements do not parse AI-provided KMarkdown mentions or links.
  // Keep line breaks, tabs and code punctuation; discard other control characters.
  const text = content.slice(0, 256 * 1024).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text) throw new KookReplyError('KOOK_INVALID_INPUT');
  const encode = value => JSON.stringify({ type: 10, target_id: targetId,
    content: JSON.stringify(card(value)),
    // Official API: quote displays the reference; reply_msg_id grants first-reply quota credit.
    quote: replyMessageId, reply_msg_id: replyMessageId });
  const truncated = text.length > MAX_TEXT || content.length > 256 * 1024;
  const first = truncated ? prefix(text, MAX_TEXT - TRUNCATED.length) + TRUNCATED : text;
  let encoded = encode(first);
  if (encoded.length <= MAX_PAYLOAD) return encoded;
  // JSON escapes can expand code snippets considerably. Bound the whole request,
  // including the JSON-encoded card, instead of measuring only visible text.
  let low = 0, high = Math.min(text.length, MAX_TEXT - TRUNCATED.length);
  encoded = encode(TRUNCATED.trim());
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = encode(prefix(text, middle) + TRUNCATED);
    if (candidate.length <= MAX_PAYLOAD) { encoded = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return encoded;
}

async function readResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new KookReplyError('KOOK_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new KookReplyError('KOOK_INVALID_RESPONSE');
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new KookReplyError('KOOK_RESPONSE_TOO_LARGE');
      parts.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new KookReplyError('KOOK_INVALID_RESPONSE'); }
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Sends one bounded reply. Never retries an ambiguous send or exposes remote errors. */
export function createKookReply({ token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new KookReplyError('KOOK_INVALID_INPUT');
  }
  const authorization = `Bot ${token.trim()}`;
  return async ({ targetId, replyMessageId, content, signal } = {}) => {
    const body = payload({ targetId, replyMessageId, content });
    if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new KookReplyError(response.status === 429 ? 'KOOK_RATE_LIMITED' : 'KOOK_REJECTED');
      }
      const result = await readResponse(response);
      if (result?.code !== 0) throw new KookReplyError('KOOK_REJECTED');
      if (typeof result?.data?.msg_id !== 'string' || !MESSAGE_ID.test(result.data.msg_id)) {
        throw new KookReplyError('KOOK_INVALID_RESPONSE');
      }
      if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
      if (timedOut) throw new KookReplyError('KOOK_TIMEOUT');
      return { messageId: result.data.msg_id };
    } catch (error) {
      if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
      if (timedOut) throw new KookReplyError('KOOK_TIMEOUT');
      if (error instanceof KookReplyError) throw error;
      throw new KookReplyError('KOOK_NETWORK');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  };
}
