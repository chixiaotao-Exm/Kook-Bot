import { createHash } from 'node:crypto';

const API_ROOT = 'https://www.kookapp.cn/api/v3/';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 65536;
const SEND_TIMEOUT_MS = 90000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MESSAGE_ID = /^[A-Za-z0-9_-]{16,100}$/;
const CHANNEL_ID = /^\d{5,30}$/;

export class KookMenuDeliveryError extends Error {
  constructor(code, message, { delivery = 'not_sent', status } = {}) {
    super(message);
    this.name = 'KookMenuDeliveryError';
    this.code = code;
    this.delivery = delivery;
    if (Number.isInteger(status)) this.status = status;
  }
}

function invalidPages() {
  return new KookMenuDeliveryError('INVALID_PAGES', '中文菜单图片格式或大小不正确。');
}

function checkedPages(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 8) throw invalidPages();
  let total = 0;
  return pages.map((page, index) => {
    if (!(page?.buffer instanceof Uint8Array)) throw invalidPages();
    total += page.buffer.byteLength;
    if (page.buffer.byteLength < 33 || page.buffer.byteLength >= MAX_IMAGE_BYTES || total >= MAX_TOTAL_BYTES) throw invalidPages();
    // Keep the validated snapshot private, including across subsequent cached sends.
    const buffer = Buffer.from(page.buffer);
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8) !== 13
      || buffer.toString('ascii', 12, 16) !== 'IHDR') throw invalidPages();
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!Number.isInteger(page.width) || !Number.isInteger(page.height)
      || width !== page.width || height !== page.height || width < 1 || height < 1
      || width > 16384 || height > 16384 || width * height > 64000000) throw invalidPages();
    const title = page.title == null ? `第 ${index + 1} 页` : page.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)) throw invalidPages();
    return { buffer, title: title.trim(), hash: createHash('sha256').update(buffer).digest('hex') };
  });
}

function assetUrl(value) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  try {
    const url = new URL(value);
    const official = ['kookapp.cn', 'kaiheila.cn', 'kookapp.com']
      .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    if (!official || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

async function limitedJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) throw new Error('response size');
  let body = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response size'); }
        body += decoder.decode(item.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  } else {
    body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('response size');
  }
  signal.throwIfAborted();
  return JSON.parse(body);
}

function cancelled(signal, delivery = 'not_sent') {
  const deadline = signal?.reason === 'menu-deadline';
  return new KookMenuDeliveryError(deadline ? 'MENU_TIMEOUT' : delivery === 'uncertain' ? 'SEND_INTERRUPTED' : 'SEND_CANCELLED',
    deadline ? '中文菜单发送超时。' : '中文菜单发送已取消。', { delivery });
}

function waitForUpload(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled(signal)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Upload validated PNG pages and publish a single card. POST requests are never retried. */
export function createMenuSender({ token, channelIds, pages, fetchImpl = globalThis.fetch, now = Date.now,
  requestTimeoutMs = 10000, uploadTimeoutMs = 15000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('KOOK Token 未配置或格式不正确');
  if (!(Array.isArray(channelIds) || channelIds instanceof Set) || !channelIds.size && !channelIds.length) throw new Error('KOOK 菜单频道未配置');
  const allowedChannels = new Set(channelIds);
  if ([...allowedChannels].some(id => typeof id !== 'string' || !CHANNEL_ID.test(id))) throw new Error('KOOK 菜单频道格式不正确');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new Error('菜单发送运行环境不正确');
  for (const timeout of [requestTimeoutMs, uploadTimeoutMs]) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('KOOK 请求超时配置不正确');
  }
  const files = checkedPages(pages);
  const authorization = `Bot ${token.trim()}`;
  // At most one entry per configured page hash (maximum eight), not per user/channel.
  const cache = new Map();
  const uploading = new Map();

  async function request(path, options, callerSignal) {
    const upload = path === 'asset/create';
    const label = upload ? '图片上传' : '消息发送';
    const controller = new AbortController();
    let timeout, onAbort, started = false;
    const failure = (code, message, status, rejected = false) => new KookMenuDeliveryError(code, message, {
      delivery: upload || !started ? 'not_sent' : rejected ? 'rejected' : 'uncertain', status,
    });
    const abortError = () => cancelled(callerSignal, upload || !started ? 'not_sent' : 'uncertain');
    if (callerSignal?.aborted) throw abortError();
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => { controller.abort(); reject(abortError()); };
      callerSignal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => {
        controller.abort();
        reject(failure(upload ? 'KOOK_UPLOAD_TIMEOUT' : 'KOOK_SEND_TIMEOUT', `KOOK ${label}超时。`));
      }, upload ? uploadTimeoutMs : requestTimeoutMs);
    });
    const operation = async () => {
      let response;
      try {
        controller.signal.throwIfAborted();
        started = true;
        response = await fetchImpl(`${API_ROOT}${path}`, { ...options, method: 'POST', redirect: 'error', signal: controller.signal });
      } catch { throw failure(upload ? 'KOOK_UPLOAD_NETWORK' : 'KOOK_NETWORK', `KOOK ${label}连接异常。`); }
      if (!response?.ok) {
        const status = response?.status;
        try { void response?.body?.cancel?.().catch(() => {}); } catch {}
        throw failure(upload ? 'KOOK_UPLOAD_HTTP' : 'KOOK_HTTP', `KOOK ${label}请求失败。`, status, status >= 400 && status < 500);
      }
      let payload;
      try { payload = await limitedJson(response, controller.signal); }
      catch {
        try { void response.body?.cancel?.().catch(() => {}); } catch {}
        throw failure(upload ? 'KOOK_UPLOAD_RESPONSE' : 'KOOK_RESPONSE', `KOOK ${label}响应无法确认。`);
      }
      if (!Number.isInteger(payload?.code)) throw failure(upload ? 'KOOK_UPLOAD_RESPONSE' : 'KOOK_RESPONSE', `KOOK ${label}响应无法确认。`);
      if (payload.code !== 0) throw failure(upload ? 'KOOK_UPLOAD_API' : 'KOOK_API', `KOOK ${label}接口返回错误。`, payload.code, true);
      return payload.data;
    };
    try { return await Promise.race([operation(), interrupted]); }
    finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  async function uploadedPage(page, index) {
    const existing = cache.get(page.hash);
    const timestamp = now();
    if (existing && timestamp >= existing.at && timestamp - existing.at < CACHE_TTL_MS) return existing.url;
    cache.delete(page.hash);
    if (uploading.has(page.hash)) return uploading.get(page.hash);
    const pending = (async () => {
      const form = new FormData();
      form.append('file', new Blob([page.buffer], { type: 'image/png' }), `chinese-menu-${index + 1}.png`);
      // An individual caller cannot cancel an upload another caller is sharing.
      // The upload still has its own bounded timeout and never sends a message.
      const data = await request('asset/create', { headers: { Authorization: authorization }, body: form });
      const url = assetUrl(data?.url);
      if (!url) throw new KookMenuDeliveryError('KOOK_UPLOAD_RESPONSE', 'KOOK 图片上传未返回有效资源地址。');
      cache.set(page.hash, { url, at: now() });
      return url;
    })();
    uploading.set(page.hash, pending);
    try { return await pending; }
    finally { uploading.delete(page.hash); }
  }

  return async function sendMenu({ channelId, replyMessageId, pageIndices } = {}, { signal } = {}) {
    if (!allowedChannels.has(channelId)) throw new KookMenuDeliveryError('CHANNEL_NOT_ALLOWED', '此频道未启用中文菜单。');
    if (replyMessageId != null && (typeof replyMessageId !== 'string' || !MESSAGE_ID.test(replyMessageId))) {
      throw new KookMenuDeliveryError('INVALID_REPLY', '菜单引用消息编号不正确。');
    }
    const selected = pageIndices === undefined ? files.map((_, index) => index) : Array.isArray(pageIndices) ? [...pageIndices] : pageIndices;
    if (!Array.isArray(selected) || !selected.length || selected.length > files.length
      || new Set(selected).size !== selected.length
      || selected.some(index => !Number.isInteger(index) || index < 0 || index >= files.length)) {
      throw new KookMenuDeliveryError('INVALID_SELECTION', '中文菜单页码不正确。');
    }
    if (signal?.aborted) throw cancelled(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort('menu-deadline'), SEND_TIMEOUT_MS);
    try {
      const modules = [
        { type: 'header', text: { type: 'plain-text', content: 'Gran Furama · 中文菜单' } },
        { type: 'context', elements: [{ type: 'plain-text', content: '全部价格以美元（USD）结算。点击图片查看原图。' }] },
      ];
      for (const index of selected) {
        if (controller.signal.aborted) throw cancelled(controller.signal);
        const page = files[index];
        const src = await waitForUpload(uploadedPage(page, index), controller.signal);
        modules.push({ type: 'section', text: { type: 'plain-text', content: `${page.title} · ${index + 1}/${files.length}` } });
        // A separate full-width container for every page avoids tiny gallery thumbnails.
        modules.push({ type: 'container', elements: [{ type: 'image', src, alt: `${page.title} · 第 ${index + 1} 页` }] });
      }
      const content = JSON.stringify([{ type: 'card', theme: 'invisible', size: 'lg', modules }]);
      if (content.length > 8000) throw new KookMenuDeliveryError('INVALID_MESSAGE', '中文菜单卡片长度超过限制。');
      const message = { type: 10, target_id: channelId, content };
      if (replyMessageId) {
        message.quote = replyMessageId;
        message.reply_msg_id = replyMessageId;
      }
      const data = await request('message/create', {
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      }, controller.signal);
      if (typeof data?.msg_id !== 'string' || !MESSAGE_ID.test(data.msg_id)) {
        throw new KookMenuDeliveryError('KOOK_RESPONSE', 'KOOK 未返回可确认的消息编号。', { delivery: 'uncertain' });
      }
      return { messageId: data.msg_id };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
