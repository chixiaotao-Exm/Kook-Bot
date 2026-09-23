// Official upload/card schema:
// https://github.com/kaiheila/api-docs/blob/master/docs/zh-cn/http/asset.md
// https://github.com/kaiheila/api-docs/blob/master/docs/zh-cn/cardmessage.md
const API_ROOT = 'https://www.kookapp.cn/api/v3/';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_RESPONSE_BYTES = 65536;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class KookImageDeliveryError extends Error {
  constructor(message, { code, delivery = 'not_sent', status } = {}) {
    super(message);
    this.name = 'KookImageDeliveryError';
    this.code = code;
    this.delivery = delivery;
    if (Number.isInteger(status)) this.status = status;
  }
}

function invalidImages() {
  return new KookImageDeliveryError('播报图片格式或大小不正确，本次未发送。', { code: 'INVALID_IMAGES' });
}

function checkedImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) throw invalidImages();
  let total = 0;
  return images.map(image => {
    if (!image || image.mimeType !== 'image/png' || !(image.buffer instanceof Uint8Array)) throw invalidImages();
    const bytes = image.buffer.byteLength;
    total += bytes;
    if (bytes < 33 || bytes > MAX_IMAGE_BYTES || total > MAX_IMAGES * MAX_IMAGE_BYTES) throw invalidImages();
    // Snapshot bytes before awaiting uploads, so caller mutation cannot change a validated file.
    const buffer = Buffer.from(image.buffer);
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw invalidImages();
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
      || width !== image.width || height !== image.height || width < 1 || height < 1
      || width > 16384 || height > 16384 || width * height > 64000000) throw invalidImages();
    return { buffer, width, height };
  });
}

function assetUrl(value) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  try {
    const url = new URL(value);
    const official = ['kookapp.cn', 'kaiheila.cn', 'kookapp.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    if (!official || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function dashboardLink(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 1000) throw new Error('额度看板链接格式不正确');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    url.search = ''; url.hash = '';
    if (url.href.length > 300) throw new Error();
    return url.href;
  } catch { throw new Error('额度看板链接格式不正确'); }
}

async function limitedJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) throw new Error('response too large');
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
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response too large'); }
        body += decoder.decode(item.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  } else {
    body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('response too large');
  }
  return JSON.parse(body);
}

/** Upload all images, then send exactly one KOOK card. Never retries a POST. */
export function createKookImageSender({ token, channelId, fetchImpl = globalThis.fetch, dashboardUrl = '', requestTimeoutMs = 10000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('KOOK Token 未配置或格式不正确');
  if (typeof channelId !== 'string' || !/^\d{5,30}$/.test(channelId)) throw new Error('KOOK 文字频道 ID 格式不正确');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持发送请求');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) throw new Error('KOOK 请求超时配置不正确');
  const link = dashboardLink(dashboardUrl);
  const authorization = `Bot ${token.trim()}`;

  async function request(path, options, callerSignal) {
    const upload = path === 'asset/create';
    const label = upload ? '图片上传' : '消息发送';
    const controller = new AbortController();
    let timeout, onAbort, started = false;
    const timeoutCode = upload ? 'KOOK_UPLOAD_TIMEOUT' : 'KOOK_SEND_TIMEOUT';
    const error = (code, message, status, rejected = false) => new KookImageDeliveryError(message, {
      code, status, delivery: upload || !started ? 'not_sent' : rejected ? 'rejected' : 'uncertain',
    });
    const abortError = () => error(upload || !started ? 'SEND_CANCELLED' : 'SEND_INTERRUPTED', `KOOK ${label}已取消。`);
    if (callerSignal?.aborted) throw abortError();
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => { controller.abort(); reject(abortError()); };
      callerSignal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => {
        controller.abort();
        reject(error(timeoutCode, `KOOK ${label}超时。`));
      }, requestTimeoutMs);
    });
    const operation = async () => {
      let response;
      try {
        controller.signal.throwIfAborted();
        started = true;
        response = await fetchImpl(`${API_ROOT}${path}`, { ...options, method: 'POST', redirect: 'error', signal: controller.signal });
      } catch { throw error(upload ? 'KOOK_UPLOAD_NETWORK' : 'KOOK_NETWORK', `KOOK ${label}连接异常。`); }
      if (!response?.ok) {
        const status = response?.status;
        // Cancel unread error bodies without reflecting upstream text (which may contain credentials).
        try { void response?.body?.cancel?.().catch(() => {}); } catch {}
        throw error(upload ? 'KOOK_UPLOAD_HTTP' : 'KOOK_HTTP', `KOOK ${label}请求失败。`, status, status >= 400 && status < 500);
      }
      let payload;
      try { payload = await limitedJson(response, controller.signal); }
      catch {
        try { void response.body?.cancel?.().catch(() => {}); } catch {}
        throw error(upload ? 'KOOK_UPLOAD_RESPONSE' : 'KOOK_RESPONSE', `KOOK ${label}响应无法确认。`);
      }
      if (!Number.isInteger(payload?.code)) throw error(upload ? 'KOOK_UPLOAD_RESPONSE' : 'KOOK_RESPONSE', `KOOK ${label}响应无法确认。`);
      if (payload.code !== 0) throw error(upload ? 'KOOK_UPLOAD_API' : 'KOOK_API', `KOOK ${label}接口返回错误。`, payload.code, true);
      return payload.data;
    };
    try { return await Promise.race([operation(), interrupted]); }
    finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  return async function send(text, { images, signal } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
      throw new KookImageDeliveryError('播报文本长度不正确', { code: 'INVALID_MESSAGE' });
    }
    const files = checkedImages(images);
    const elements = [];
    for (let index = 0; index < files.length; index += 1) {
      const form = new FormData();
      form.append('file', new Blob([files[index].buffer], { type: 'image/png' }), `quota-report-${index + 1}.png`);
      const data = await request('asset/create', { headers: { Authorization: authorization }, body: form }, signal);
      const src = assetUrl(data?.url);
      if (!src) throw new KookImageDeliveryError('KOOK 图片上传未返回有效资源地址，本次未发送。', { code: 'KOOK_UPLOAD_RESPONSE' });
      // Do not interpolate renderer metadata or full summary text into a message.
      elements.push({ type: 'image', src, alt: files.length === 1 ? 'OpenAI 额度播报 · 高清总览' : `OpenAI 额度播报 · 第 ${index + 1} 张` });
    }
    const modules = [{ type: 'container', elements }];
    if (link) modules.push({ type: 'action-group', elements: [{ type: 'button', theme: 'info', click: 'link', value: link, text: { type: 'plain-text', content: '打开额度看板' } }] });
    const content = JSON.stringify([{ type: 'card', theme: 'invisible', size: 'lg', modules }]);
    if (content.length > 8000) throw new KookImageDeliveryError('播报卡片长度超过限制，本次未发送。', { code: 'INVALID_MESSAGE' });
    const data = await request('message/create', {
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 10, target_id: channelId, content }),
    }, signal);
    if (typeof data?.msg_id !== 'string' || !/^[\w-]{1,128}$/.test(data.msg_id)) {
      throw new KookImageDeliveryError('KOOK 未返回可确认的消息编号。', { code: 'KOOK_RESPONSE', delivery: 'uncertain' });
    }
    return { messageId: data.msg_id };
  };
}
