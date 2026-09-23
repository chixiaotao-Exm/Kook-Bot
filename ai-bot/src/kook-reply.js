import { crc32 } from 'node:zlib';
import { staticSvg, renderSvgPng, SvgRenderError } from './svg-render.js';

const ENDPOINT = 'https://www.kookapp.cn/api/v3/message/create';
const ASSET_ENDPOINT = 'https://www.kookapp.cn/api/v3/asset/create';
const CHANNEL_ID = /^\d{5,30}$/;
const MESSAGE_ID = /^[a-f0-9-]{16,100}$/i;
const MAX_TEXT = 6000;
const MAX_PAYLOAD = 8000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_ATTACHMENT_BYTES = 256 * 1024;
const ASSET_DOMAINS = ['kookapp.cn', 'kaiheila.cn', 'kookapp.com', 'kaiheila.com'];


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

function encode(targetId, replyMessageId, cards) {
  return JSON.stringify({ type: 10, target_id: targetId, content: JSON.stringify(cards),
    // quote displays the reference; reply_msg_id grants first-reply quota credit.
    quote: replyMessageId, reply_msg_id: replyMessageId });
}


function prepared({ targetId, replyMessageId, content, incomplete }) {
  if (!CHANNEL_ID.test(targetId || '') || typeof targetId !== 'string'
    || typeof replyMessageId !== 'string' || !MESSAGE_ID.test(replyMessageId)
    || typeof content !== 'string' || typeof incomplete !== 'boolean'
    || Buffer.byteLength(content) > MAX_ATTACHMENT_BYTES) throw new KookReplyError('KOOK_INVALID_INPUT');
  // Plain-text card elements do not parse AI-provided KMarkdown mentions or links.
  // Keep line breaks, tabs and code punctuation; discard other control characters.
  const text = content.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text) throw new KookReplyError('KOOK_INVALID_INPUT');
  const svgLike = /<\s*\/?svg\b|```(?:svg|xml)\b/i.test(content);
  const svg = svgLike && !incomplete ? staticSvg(content) : null;
  if (svg) return { attachment: { type: 'svg', name: 'drawing.svg', text: svg } };
  const body = encode(targetId, replyMessageId, card(text));
  if (svgLike || text.length > MAX_TEXT || body.length > MAX_PAYLOAD) {
    return { attachment: { type: 'text', name: 'answer.txt', text: content } };
  }
  return { body };
}

function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

async function readResponse(response, signal, asset) {
  const code = name => `KOOK_${asset ? 'ASSET_' : ''}${name}`;
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    cancelBody(response.body);
    throw new KookReplyError(code('RESPONSE_TOO_LARGE'));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new KookReplyError(code('INVALID_RESPONSE'));
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new KookReplyError('KOOK_ABORTED');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new KookReplyError(code('RESPONSE_TOO_LARGE'));
      parts.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new KookReplyError(code('INVALID_RESPONSE')); }
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    try { reader.releaseLock(); } catch {}
  }
}

function assetUrl(value) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !ASSET_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.href;
  } catch { return null; }
}

// One fixed-name UTF-8 source file, stored without compression. KOOK rejects SVG
// content even when uploaded with a .txt extension; package once before upload.
function sourceZip(attachment) {
  const name = Buffer.from(attachment.name, 'ascii');
  const data = Buffer.from(attachment.text, 'utf8');
  const checksum = crc32(data);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12); // Fixed DOS date: 1980-01-01.
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  const archive = Buffer.concat([local, name, data, central, name, end]);
  if (archive.length > MAX_ATTACHMENT_BYTES) throw new KookReplyError('KOOK_INVALID_INPUT');
  return archive;
}

/** Sends one bounded reply. Never retries an ambiguous send or exposes remote errors. */
export function createKookReply({ token, fetchImpl = fetch, timeoutMs = 60000, renderSvgImpl = renderSvgPng } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof renderSvgImpl !== 'function') {
    throw new KookReplyError('KOOK_INVALID_INPUT');
  }
  const authorization = `Bot ${token.trim()}`;
  return async ({ targetId, replyMessageId, content, signal, incomplete = false, onStage } = {}) => {
    const plan = prepared({ targetId, replyMessageId, content, incomplete });
    if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
    const controller = new AbortController(); let timedOut = false, asset = Boolean(plan.attachment), rejectInterrupted;
    let stage = plan.attachment?.type === 'svg' ? 'rendering' : asset ? 'uploading' : 'sending';
    const notify = next => {
      stage = next;
      try { Promise.resolve(onStage?.(next)).catch(() => {}); } catch {}
    };
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    const abort = () => { controller.abort(); rejectInterrupted(new KookReplyError('KOOK_ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true; controller.abort();
      rejectInterrupted(new KookReplyError(stage === 'rendering' ? 'KOOK_RENDER_TIMEOUT' : asset ? 'KOOK_ASSET_TIMEOUT' : 'KOOK_TIMEOUT'));
    }, timeoutMs);
    try {
      const request = async (endpoint, options) => {
        if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
        const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', ...options, signal: controller.signal });
        if (controller.signal.aborted) { cancelBody(response?.body); throw new KookReplyError('KOOK_ABORTED'); }
        if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) {
          cancelBody(response.body);
          throw new KookReplyError(asset ? 'KOOK_ASSET_REJECTED' : response.status === 429 ? 'KOOK_RATE_LIMITED' : 'KOOK_REJECTED');
        }
        const result = await readResponse(response, controller.signal, asset);
        if (result?.code !== 0) throw new KookReplyError(asset ? 'KOOK_ASSET_REJECTED' : 'KOOK_REJECTED');
        return result.data;
      };
      const send = async () => {
        let body = plan.body;
        if (plan.attachment) {
          const attachment = plan.attachment, form = new FormData();
          if (attachment.type === 'svg') {
            notify('rendering');
            let png;
            try { png = await renderSvgImpl(attachment.text, { signal: controller.signal }); }
            catch (error) {
              if (error instanceof SvgRenderError && error.code === 'SVG_TIMEOUT') throw new KookReplyError('KOOK_RENDER_TIMEOUT');
              throw new KookReplyError('KOOK_RENDER_FAILED');
            }
            if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
            if (!Buffer.isBuffer(png) || png.length < 24 || png.length > 4 * 1024 * 1024
              || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
              throw new KookReplyError('KOOK_RENDER_FAILED');
            }
            form.append('file', new Blob([png], { type: 'image/png' }), 'drawing.png');
          } else form.append('file', new Blob([sourceZip(attachment)], { type: 'application/zip' }), 'answer.zip');
          if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
          notify('uploading');
          const uploaded = await request(ASSET_ENDPOINT, { headers: { Authorization: authorization }, body: form });
          const url = assetUrl(uploaded?.url);
          if (!url) throw new KookReplyError('KOOK_ASSET_INVALID_RESPONSE');
          if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
          const cards = attachment.type === 'svg' ? [{ type: 'card', theme: 'secondary', size: 'lg',
            modules: [{ type: 'image-group', elements: [{ type: 'image', src: url, alt: 'AI 生成的图片' }] }] }]
            : card(incomplete ? '回复尚未生成完整，请下载 ZIP 并解压 answer.txt 查看现有内容。'
              : '完整回复已保存，请下载 ZIP 并解压获取 answer.txt。');
          if (attachment.type !== 'svg') cards[0].modules.push({ type: 'file', src: url, title: 'answer.zip' });
          body = encode(targetId, replyMessageId, cards);
          if (body.length > MAX_PAYLOAD) throw new KookReplyError('KOOK_INVALID_INPUT');
        }
        asset = false;
        if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
        notify('sending');
        const data = await request(ENDPOINT, {
          headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body });
        if (typeof data?.msg_id !== 'string' || !MESSAGE_ID.test(data.msg_id)) throw new KookReplyError('KOOK_INVALID_RESPONSE');
        return { messageId: data.msg_id, ...(plan.attachment ? { attachmentType: plan.attachment.type === 'svg' ? 'image' : 'text' } : {}) };
      };
      return await Promise.race([send(), interrupted]);
    } catch (error) {
      if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
      if (timedOut) throw new KookReplyError(stage === 'rendering' ? 'KOOK_RENDER_TIMEOUT' : asset ? 'KOOK_ASSET_TIMEOUT' : 'KOOK_TIMEOUT');
      if (error instanceof KookReplyError) throw error;
      throw new KookReplyError(asset ? 'KOOK_ASSET_NETWORK' : 'KOOK_NETWORK');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  };
}
