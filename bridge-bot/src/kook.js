const ENDPOINT = 'https://www.kookapp.cn/api/v3/message/create';
const MAX_BYTES = 32 * 1024;
const THEMES = new Set(['info', 'success', 'warning', 'danger', 'secondary']);
const KINDS = new Set(['push', 'pr', 'ci']);
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const SECRET = /(?:\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,}|\bsk(?:-proj)?-[A-Za-z0-9_-]{12,}|\badmin-[A-Za-z0-9_-]{16,}|\b\d{1,4}\/[A-Za-z0-9+/=]{4,}\/[A-Za-z0-9+/=]{10,}|\bBearer\s+\S+)/gi;
const MESSAGES = {
  CONFIG: 'KOOK 通知配置无效。', INVALID_NOTIFICATION: '通知格式不正确，本次未发送。',
  CANCELLED: '通知发送已取消。', TIMEOUT: '通知发送超时，送达状态待确认。',
  NETWORK: '通知连接失败，送达状态待确认。', REDIRECT: '通知接口发生重定向，送达状态待确认。',
  RATE_LIMITED: 'KOOK 暂时限流，通知已等待重试。', REJECTED: 'KOOK 未接受通知。',
  UPSTREAM: 'KOOK 服务异常，送达状态待确认。', RESPONSE: '未取得可靠的消息编号，送达状态待确认。',
};

export class DeliveryError extends Error {
  constructor(code, delivery = 'uncertain', retryAfterMs) {
    super(MESSAGES[code] || MESSAGES.RESPONSE);
    this.name = 'DeliveryError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'RESPONSE';
    this.delivery = delivery === 'rejected' ? 'rejected' : 'uncertain';
    if (this.code === 'RATE_LIMITED' && this.delivery === 'rejected' && Number.isFinite(retryAfterMs)) {
      this.retryAfterMs = Math.max(15000, Math.min(300000, Math.ceil(retryAfterMs)));
    }
  }
}
const failInput = () => { throw new DeliveryError('INVALID_NOTIFICATION', 'rejected'); };
const plain = content => ({ type: 'plain-text', content, emoji: false });
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }
function clean(value) {
  return value.replace(SECRET, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|cookie)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '[已隐藏]')
    .replace(/\((?:met|rol|chn|emj)\)[\s\S]*?\((?:met|rol|chn|emj)\)/gi, '')
    .replace(/\((?:met|rol|chn|emj)\)/gi, '')
    .replace(/@(?:all|everyone|here|全体成员|所有人)/gi, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function checkedUrl(value, repository) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) failInput();
  let url, decoded;
  try { url = new URL(value); decoded = decodeURIComponent(url.pathname); } catch { failInput(); }
  const root = `/${repository}`.toLowerCase(), pathname = decoded.toLowerCase(), rawPath = url.pathname.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash
    || !(rawPath === root || rawPath.startsWith(root + '/')) || !(pathname === root || pathname.startsWith(root + '/')) || /[\x00-\x20\x7f\\?#]/.test(decoded)
    || decoded.split('/').some(part => part === '.' || part === '..') || decoded.replace(SECRET, '') !== decoded) failInput();
  return url.href;
}
function prepare(notification, channelId, repository) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)
    || Object.keys(notification).some(key => !['key', 'kind', 'title', 'lines', 'theme', 'url'].includes(key))
    || typeof notification.key !== 'string' || !/^[a-f0-9]{64}$/i.test(notification.key) || !KINDS.has(notification.kind)
    || !THEMES.has(notification.theme) || typeof notification.title !== 'string' || !notification.title.trim()
    || notification.title.length > 100 || !notification.title.isWellFormed()
    || !Array.isArray(notification.lines) || notification.lines.length > 8
    || notification.lines.some(line => typeof line !== 'string' || line.length > 500 || !line.isWellFormed())) failInput();
  const title = clean(notification.title), lines = notification.lines.map(clean).filter(Boolean);
  if (!title) failInput();
  const url = checkedUrl(notification.url, repository);
  const cards = [{ type: 'card', size: 'lg', theme: notification.theme, modules: [
    { type: 'header', text: plain(title) },
    ...lines.map(line => ({ type: 'section', text: plain(line) })),
    { type: 'action-group', elements: [{ type: 'button', theme: 'info', click: 'link', value: url, text: plain('打开 GitHub') }] },
  ] }];
  const content = JSON.stringify(cards);
  const body = JSON.stringify({ type: 10, target_id: channelId, content });
  if (content.length > 8000 || Buffer.byteLength(body) > MAX_BYTES) failInput();
  return body;
}
function retryDelay(response) {
  const raw = response.headers?.get('retry-after');
  const seconds = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : typeof raw === 'string' ? Date.parse(raw) - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.max(15000, Math.min(300000, Math.ceil(delay))) : 15000;
}
async function readResponse(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) { cancelBody(response.body); throw new DeliveryError('RESPONSE'); }
  const reader = response.body?.getReader(); if (!reader) throw new DeliveryError('RESPONSE');
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DeliveryError('CANCELLED');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DeliveryError('CANCELLED');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new DeliveryError('RESPONSE');
      bytes += value.byteLength; if (bytes > MAX_BYTES) throw new DeliveryError('RESPONSE');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new DeliveryError('RESPONSE'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

/** One attempt only. Only a confirmed HTTP 429 carries a retry hint to the queue. */
export function createKookSender({ token, channelId, repository = 'chixiaotao-Exm/Kook-Bot', fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token) || typeof channelId !== 'string' || !/^\d{5,30}$/.test(channelId)
    || typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..') || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new DeliveryError('CONFIG', 'rejected');
  return async function send(notification, { signal } = {}) {
    const body = prepare(notification, channelId, repository);
    if (signal !== undefined && !(signal instanceof AbortSignal)) failInput();
    if (signal?.aborted) throw new DeliveryError('CANCELLED', 'rejected');
    const controller = new AbortController(); let timer, onAbort, started = false;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => { reject(new DeliveryError('CANCELLED', started ? 'uncertain' : 'rejected')); controller.abort(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { reject(new DeliveryError('TIMEOUT')); controller.abort(); }, timeoutMs);
    });
    const operation = async () => {
      if (controller.signal.aborted) throw new DeliveryError('CANCELLED', 'rejected');
      started = true;
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
      if (controller.signal.aborted) { cancelBody(response?.body); throw new DeliveryError('CANCELLED'); }
      if (response?.redirected || response?.status >= 300 && response.status < 400) { cancelBody(response?.body); throw new DeliveryError('REDIRECT'); }
      if (response?.status === 429) { cancelBody(response.body); throw new DeliveryError('RATE_LIMITED', 'rejected', retryDelay(response)); }
      if (!response?.ok) {
        cancelBody(response?.body);
        throw new DeliveryError(response?.status >= 400 && response.status < 500 ? 'REJECTED' : 'UPSTREAM',
          response?.status >= 400 && response.status < 500 ? 'rejected' : 'uncertain');
      }
      const value = await readResponse(response, controller.signal);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.code)) throw new DeliveryError('RESPONSE');
      if (value.code !== 0) throw new DeliveryError('REJECTED', 'rejected');
      if (typeof value.data?.msg_id !== 'string' || !MESSAGE_ID.test(value.data.msg_id) || value.data.msg_id === token) throw new DeliveryError('RESPONSE');
      return { messageId: value.data.msg_id };
    };
    try { return await Promise.race([operation(), interrupted]); }
    catch (error) { throw error instanceof DeliveryError ? error : new DeliveryError('NETWORK'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort(); }
  };
}
