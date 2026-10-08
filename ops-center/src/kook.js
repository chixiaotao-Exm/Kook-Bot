import { configuredChannels } from './channels.js';

const ENDPOINT = 'https://www.kookapp.cn/api/v3/message/create';
const MAX_BYTES = 32 * 1024;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const THEMES = new Set(['danger', 'success', 'warning', 'info']);
const MESSAGES = { CONFIG: '运维通知配置无效。', INPUT: '运维通知格式无效。', CANCELLED: '通知发送已取消。',
  TIMEOUT: '通知发送超时，送达状态待确认。', NETWORK: '通知连接失败，送达状态待确认。',
  REDIRECT: '通知接口发生重定向，送达状态待确认。', RATE_LIMITED: 'KOOK 通知暂时限流。',
  REJECTED: 'KOOK 未接受通知。', RESPONSE: '未取得可靠消息编号，送达状态待确认。' };
export class KookDeliveryError extends Error {
  constructor(code, delivery = 'uncertain') {
    super(MESSAGES[code] || MESSAGES.RESPONSE); this.name = 'KookDeliveryError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'RESPONSE'; this.delivery = delivery;
  }
}
const failure = (code, delivery) => new KookDeliveryError(code, delivery);
const plain = content => ({ type: 'plain-text', content, emoji: false });
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

export function safeOpsText(value, limit = 500) {
  return typeof value === 'string' ? value.toWellFormed()
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,}|\b(?:sk-|admin-)[A-Za-z0-9_-]{8,}|\b\d{1,4}\/[A-Za-z0-9+/=]{4,}\/[A-Za-z0-9+/=]{8,}/g, '[已隐藏]')
    .replace(/\bBearer\s+\S+/gi, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|cookie)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '[已隐藏]')
    .replace(/\((?:met|rol|chn|emj)\)[\s\S]*?\((?:met|rol|chn|emj)\)/gi, '[提及已省略]')
    .replace(/\((?:met|rol|chn|emj)\)|<@!?[^>]*>|<@&[^>]*>/gi, '')
    .replace(/@(?:all|everyone|here|全体成员|所有人)/gi, '[群体提及已省略]')
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/[^\s<>()[\]{}"'@]+@[^\s<>()[\]{}"'@]+/g, '[邮箱已隐藏]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : '';
}

async function readResponse(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES || !response.body?.getReader) {
    cancelBody(response.body); throw failure('RESPONSE');
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw failure('CANCELLED');
      const { done, value } = await reader.read();
      if (signal.aborted) throw failure('CANCELLED');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure('RESPONSE');
      bytes += value.byteLength; if (bytes > MAX_BYTES) throw failure('RESPONSE'); chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw failure('RESPONSE'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

/** A single attempt, bound to the two authorized channels. Unknown delivery is never replayed here. */
export function createKookSender({ token, channelIds, publicUrl, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let link, channels;
  try { link = new URL(publicUrl); channels = configuredChannels(channelIds); } catch { throw failure('CONFIG', 'rejected'); }
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token)
    || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
    || link.protocol !== 'https:' || link.username || link.password || link.search || link.hash || link.href.length > 500) throw failure('CONFIG', 'rejected');
  return async function send(notification, { signal } = {}) {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification)
      || Object.keys(notification).some(key => !['category', 'title', 'lines', 'theme'].includes(key))
      || !Object.hasOwn(channels, notification.category) || !THEMES.has(notification.theme)
      || typeof notification.title !== 'string' || notification.title.length > 100 || !notification.title.trim()
      || !Array.isArray(notification.lines) || notification.lines.length > 12
      || notification.lines.some(line => typeof line !== 'string' || line.length > 500)
      || signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INPUT', 'rejected');
    if (signal?.aborted) throw failure('CANCELLED', 'rejected');
    const clean = value => safeOpsText(value.split(token).join('[已隐藏]'));
    const title = safeOpsText(notification.title.split(token).join('[已隐藏]'), 100); if (!title) throw failure('INPUT', 'rejected');
    const card = [{ type: 'card', size: 'lg', theme: notification.theme, modules: [
      { type: 'header', text: plain(title) },
      ...notification.lines.map(clean).filter(Boolean).map(content => ({ type: 'section', text: plain(content) })),
      { type: 'context', elements: [plain(`运维中心：${link.href}`)] },
    ] }];
    const content = JSON.stringify(card), body = JSON.stringify({ type: 10, target_id: channels[notification.category], content });
    if (content.length > 8000 || Buffer.byteLength(body) > MAX_BYTES) throw failure('INPUT', 'rejected');
    const controller = new AbortController(); let timer, abort, started = false;
    const interrupted = new Promise((_, reject) => {
      abort = () => { reject(failure('CANCELLED', started ? 'uncertain' : 'rejected')); controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { reject(failure('TIMEOUT')); controller.abort(); }, timeoutMs);
    });
    const operation = async () => {
      if (controller.signal.aborted) throw failure('CANCELLED', 'rejected');
      started = true;
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
      if (controller.signal.aborted) { cancelBody(response?.body); throw failure('CANCELLED'); }
      if (response?.redirected || response?.status >= 300 && response.status < 400) { cancelBody(response?.body); throw failure('REDIRECT'); }
      if (response?.status === 429) { cancelBody(response.body); throw failure('RATE_LIMITED', 'rejected'); }
      if (!response?.ok) { cancelBody(response?.body); throw failure('REJECTED', response?.status >= 400 && response.status < 500 ? 'rejected' : 'uncertain'); }
      const value = await readResponse(response, controller.signal);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.code)) throw failure('RESPONSE');
      if (value.code !== 0) throw failure('REJECTED', 'rejected');
      if (typeof value.data?.msg_id !== 'string' || !MESSAGE_ID.test(value.data.msg_id) || value.data.msg_id === token) throw failure('RESPONSE');
      return { messageId: value.data.msg_id };
    };
    try { return await Promise.race([operation(), interrupted]); }
    catch (error) { throw error instanceof KookDeliveryError ? error : failure('NETWORK'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
