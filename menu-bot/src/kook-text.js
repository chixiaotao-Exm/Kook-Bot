const API_URL = 'https://www.kookapp.cn/api/v3/message/create';
const UPDATE_URL = 'https://www.kookapp.cn/api/v3/message/update';
const CHANNEL_ID = /^\d{5,30}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const BUTTON_VALUE = /^menu-page:[A-Za-z0-9:_-]+$/;
const TITLES = new Set(['中文菜单 · 计算器', '中文菜单 · 点餐服务员', '中文菜单 · 菜品搜索', '中文菜单 · 中国菜相似度']);
const MAX_RESPONSE_BYTES = 32 * 1024;

export class KookTextDeliveryError extends Error {
  constructor(code, { delivery = 'not_sent' } = {}) {
    super(code);
    this.name = 'KookTextDeliveryError'; this.code = code; this.delivery = delivery;
  }
}

async function readJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) throw new Error('response_size');
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('response_size');
    signal.throwIfAborted();
    return JSON.parse(body);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new Error('response_size'); }
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function cardContent({ text, title, buttons }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
    throw new KookTextDeliveryError('INVALID_TEXT');
  if (!TITLES.has(title)) throw new KookTextDeliveryError('INVALID_TITLE');
  if (buttons !== undefined && (!Array.isArray(buttons) || buttons.length > 2))
    throw new KookTextDeliveryError('INVALID_BUTTONS');
  const labels = new Set(), values = new Set();
  const elements = Array.from(buttons ?? []).map(button => {
    if (!button || !['上一页', '下一页'].includes(button.label) || labels.has(button.label) ||
      typeof button.value !== 'string' || button.value.length > 256 || !BUTTON_VALUE.test(button.value) || values.has(button.value))
      throw new KookTextDeliveryError('INVALID_BUTTONS');
    labels.add(button.label); values.add(button.value);
    return { type: 'button', theme: 'primary', click: 'return-val', value: button.value,
      text: { type: 'plain-text', content: button.label } };
  });
  const modules = [
    { type: 'header', text: { type: 'plain-text', content: title } },
    { type: 'section', text: { type: 'plain-text', content: text } },
  ];
  if (elements.length) modules.push({ type: 'action-group', elements });
  return JSON.stringify([{ type: 'card', theme: 'secondary', size: 'lg', modules }]);
}

/** Fixed official endpoints and allowlisted channels. No uploads, markup, retries or logging. */
export function createTextSender({ token, channelIds, fetchImpl = globalThis.fetch, requestTimeoutMs = 10_000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('KOOK Token 未配置或格式不正确');
  if (!(Array.isArray(channelIds) || channelIds instanceof Set)) throw new Error('KOOK 计算器频道未配置');
  const allowed = new Set(channelIds);
  if (!allowed.size || allowed.size > 20 || [...allowed].some(id => typeof id !== 'string' || !CHANNEL_ID.test(id)))
    throw new Error('KOOK 计算器频道格式不正确');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10_000)
    throw new Error('KOOK 计算器请求配置不正确');
  const authorization = `Bot ${token.trim()}`;
  async function deliver(url, payload, { signal, updatedMessageId } = {}) {
    if (signal?.aborted) throw new KookTextDeliveryError('SEND_CANCELLED');
    const controller = new AbortController();
    let started = false, timer, abort;
    const failure = (code, rejected = false) => new KookTextDeliveryError(code,
      { delivery: !started ? 'not_sent' : rejected ? 'rejected' : 'uncertain' });
    const interrupted = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(failure('SEND_CANCELLED')); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(failure('SEND_TIMEOUT')); }, requestTimeoutMs);
    });
    const operation = async () => {
      let response;
      try {
        controller.signal.throwIfAborted(); started = true;
        response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } catch { throw failure('SEND_NETWORK'); }
      if (!response?.ok) {
        try { void response?.body?.cancel?.().catch(() => {}); } catch {}
        throw failure('SEND_HTTP', response?.status >= 400 && response.status < 500);
      }
      let result;
      try { result = await readJson(response, controller.signal); }
      catch { try { void response.body?.cancel?.().catch(() => {}); } catch {} throw failure('SEND_RESPONSE'); }
      if (!Number.isInteger(result?.code)) throw failure('SEND_RESPONSE');
      if (result.code !== 0) throw failure('SEND_API', true);
      if (updatedMessageId) return { messageId: updatedMessageId };
      if (typeof result.data?.msg_id !== 'string' || !MESSAGE_ID.test(result.data.msg_id)) throw failure('SEND_RESPONSE');
      return { messageId: result.data.msg_id };
    };
    try { return await Promise.race([operation(), interrupted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  async function sendText({ channelId, replyMessageId, text, title = '中文菜单 · 计算器', buttons } = {}, { signal } = {}) {
    if (!allowed.has(channelId)) throw new KookTextDeliveryError('CHANNEL_NOT_ALLOWED');
    if (replyMessageId != null && (typeof replyMessageId !== 'string' || !MESSAGE_ID.test(replyMessageId)))
      throw new KookTextDeliveryError('INVALID_REPLY');
    const payload = { type: 10, target_id: channelId, content: cardContent({ text, title, buttons }) };
    if (replyMessageId) { payload.quote = replyMessageId; payload.reply_msg_id = replyMessageId; }
    return deliver(API_URL, payload, { signal });
  }
  // The caller must bind a previously sent search-card ID to its original channel.
  sendText.update = async function update({ channelId, messageId, text, title = '中文菜单 · 菜品搜索', buttons } = {}, { signal } = {}) {
    if (!allowed.has(channelId)) throw new KookTextDeliveryError('CHANNEL_NOT_ALLOWED');
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw new KookTextDeliveryError('INVALID_MESSAGE');
    const payload = { msg_id: messageId, content: cardContent({ text, title, buttons }) };
    return deliver(UPDATE_URL, payload, { signal, updatedMessageId: messageId });
  };
  return sendText;
}
