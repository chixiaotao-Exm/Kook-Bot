const KOOK_API = 'https://www.kookapp.cn/api/v3/';
const MAX_RESPONSE_BYTES = 65536;
const TIMEOUT_MS = 10000;
const ID = /^\d{5,30}$/;
const SECRET = /(?:sk(?:-proj)?-[A-Za-z0-9_-]{13,}|admin-[a-f\d]{16,}|\b1\/[A-Za-z\d+/=]+\/[A-Za-z\d+/=]+)/gi;

/** Only fixed, non-sensitive messages are allowed to leave this transport. */
export class KookQueryReplyError extends Error {
  constructor(code, delivery = 'uncertain') {
    const messages = {
      CONFIG: 'KOOK 查询回复配置不正确。',
      INPUT: 'KOOK 查询回复参数不正确。',
      CANCELLED: 'KOOK 查询回复已取消。',
      TIMEOUT: 'KOOK 查询回复超时，送达状态待确认。',
      NETWORK: 'KOOK 查询回复连接失败，送达状态待确认。',
      HTTP: 'KOOK 拒绝了查询回复。',
      API: 'KOOK 未接受查询回复。',
      RESPONSE: 'KOOK 查询回复的送达状态无法确认。',
    };
    super(messages[code] || messages.RESPONSE);
    this.name = 'KookQueryReplyError';
    this.code = Object.hasOwn(messages, code) ? code : 'RESPONSE';
    this.delivery = ['not_sent', 'rejected', 'uncertain'].includes(delivery) ? delivery : 'uncertain';
  }
}

function cardText(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 3800) {
    throw new KookQueryReplyError('INPUT', 'not_sent');
  }
  // Defense in depth: callers format a numeric whitelist, but never re-post a full credential.
  return content.replace(SECRET, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏]')
    .replace(/\((?:met|rol|chn|emj)\)/gi, '')
    .replace(/@(?:everyone|here|全体成员)/gi, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}

function cardContent(text) {
  const modules = [];
  while (text) {
    let end = Math.min(1800, text.length);
    if (/^[\uDC00-\uDFFF]$/.test(text[end])) end -= 1;
    modules.push({ type: 'section', text: { type: 'plain-text', content: text.slice(0, end), emoji: false } });
    text = text.slice(end);
  }
  const content = JSON.stringify([{ type: 'card', theme: 'secondary', size: 'lg', modules }]);
  if (!modules.length || content.length > 8000) throw new KookQueryReplyError('INPUT', 'not_sent');
  return content;
}

async function readJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) {
    response.body?.cancel?.().catch(() => {});
    throw new KookQueryReplyError('RESPONSE');
  }
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          reader.cancel().catch(() => {});
          throw new KookQueryReplyError('RESPONSE');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new KookQueryReplyError('RESPONSE');
  }
  return JSON.parse(text);
}

/**
 * One attempt only: a timeout may have delivered, so callers must not retry a reply.
 * GROUP targets the originating channel. PERSON targets its author (not chat_code).
 * No quote/reply metadata is sent because the triggering message contains a secret.
 */
export function createKookQueryReply({ token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token) || typeof fetchImpl !== 'function') {
    throw new KookQueryReplyError('CONFIG', 'not_sent');
  }
  return async function reply({ channelType, targetId, authorId, content, signal } = {}) {
    const recipient = channelType === 'GROUP' ? targetId : authorId;
    if (!['GROUP', 'PERSON'].includes(channelType) || typeof recipient !== 'string' || !ID.test(recipient)
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new KookQueryReplyError('INPUT', 'not_sent');
    }
    const card = cardContent(cardText(content));
    if (signal?.aborted) throw new KookQueryReplyError('CANCELLED', 'not_sent');
    const controller = new AbortController();
    let timer, abortListener;
    const cancelled = new Promise((_, reject) => {
      abortListener = () => {
        reject(new KookQueryReplyError('CANCELLED'));
        controller.abort();
      };
      signal?.addEventListener('abort', abortListener, { once: true });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new KookQueryReplyError('TIMEOUT'));
        controller.abort();
      }, TIMEOUT_MS);
    });
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(`${KOOK_API}${channelType === 'GROUP' ? 'message/create' : 'direct-message/create'}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ type: 10, target_id: recipient, content: card }),
        });
      } catch { throw new KookQueryReplyError('NETWORK'); }
      if (!response?.ok || response.redirected) {
        response?.body?.cancel?.().catch(() => {});
        throw new KookQueryReplyError('HTTP', response?.status >= 400 && response?.status < 500 ? 'rejected' : 'uncertain');
      }
      let data;
      try { data = await readJson(response); }
      catch { throw new KookQueryReplyError('RESPONSE'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isSafeInteger(data.code)) {
        throw new KookQueryReplyError('RESPONSE');
      }
      if (data.code !== 0) throw new KookQueryReplyError('API', 'rejected');
      const messageId = data.data?.msg_id;
      if (typeof messageId !== 'string' || !/^[\w-]{1,128}$/.test(messageId)
        || messageId.replace(SECRET, '') !== messageId || messageId === token) {
        throw new KookQueryReplyError('RESPONSE');
      }
      return { messageId };
    };
    try { return await Promise.race([operation(), cancelled, timeout]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortListener);
    }
  };
}
