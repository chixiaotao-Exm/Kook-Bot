import { crc32 } from 'node:zlib';

const ENDPOINT = 'https://www.kookapp.cn/api/v3/message/create';
const ASSET_ENDPOINT = 'https://www.kookapp.cn/api/v3/asset/create';
const CHANNEL_ID = /^\d{5,30}$/;
const MESSAGE_ID = /^[a-f0-9-]{16,100}$/i;
const MAX_TEXT = 6000;
const MAX_PAYLOAD = 8000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_ATTACHMENT_BYTES = 256 * 1024;
const ASSET_DOMAINS = ['kookapp.cn', 'kaiheila.cn', 'kookapp.com', 'kaiheila.com'];
const SVG_TAGS = new Set(('svg g path defs linearGradient radialGradient stop rect circle ellipse line polyline polygon '
  + 'text tspan title desc clipPath mask pattern use symbol style filter feGaussianBlur feOffset feBlend '
  + 'feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feFlood feMerge feMergeNode '
  + 'feMorphology feTurbulence feDisplacementMap feConvolveMatrix feDiffuseLighting feSpecularLighting '
  + 'feDistantLight fePointLight feSpotLight').split(' '));

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

// This deliberately recognizes a conservative subset of static SVG. Unknown or
// malformed markup remains downloadable source text; it is never run or rendered.
function staticSvg(content) {
  const opens = [...content.matchAll(/<svg\b/g)], closes = [...content.matchAll(/<\/svg\s*>/g)];
  if (opens.length !== 1 || closes.length !== 1 || closes[0].index <= opens[0].index) return null;
  const svg = content.slice(opens[0].index, closes[0].index + closes[0][0].length);
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|image|animate\w*|set)\b/i.test(content)
    || /<\?/.test(svg) || /<style\b[^>]*>[\s\S]*?&[\s\S]*?<\/style>/i.test(svg)
    || /\s(?:on[\w:-]+|src|xml:base)\s*=|javascript\s*:|@import|@font-face|\\/i.test(svg)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(svg)) return null;
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2])) return null;
  }
  for (const match of svg.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^\s*(["']?)#[A-Za-z_][\w:.-]*\1\s*$/.test(match[1])) return null;
  }
  const stack = []; let cursor = 0;
  // Tokenize quoted attributes without interpreting XML entities or external resources.
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>/g;
  for (const match of svg.matchAll(tag)) {
    const between = svg.slice(cursor, match.index);
    if (between.includes('<') || between.includes(']]>')) return null;
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!--')) {
      if (match[0].slice(4, -3).includes('--')) return null;
      continue;
    }
    if (match[0].startsWith('<![CDATA[')) continue;
    const closing = /^<\//.test(match[0]), name = /^<\/?([\w:.-]+)/.exec(match[0])[1];
    if (!SVG_TAGS.has(name)) return null;
    if (closing) {
      if (!/^<\/[\w:.-]+\s*>$/.test(match[0]) || stack.pop() !== name) return null;
    } else {
      const attributes = match[0].slice(name.length + 1).replace(/\/?\s*>$/, '');
      let rest = attributes; const names = new Set();
      while (rest.trim()) {
        const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/.exec(rest);
        if (!attribute || names.has(attribute[1])) return null;
        names.add(attribute[1]);
        if (attribute[2].includes('&') || attribute[2].includes('<')) return null;
        if (attribute[1].startsWith('xmlns') && !((attribute[1] === 'xmlns'
          && attribute[2].slice(1, -1) === 'http://www.w3.org/2000/svg') || (attribute[1] === 'xmlns:xlink'
          && attribute[2].slice(1, -1) === 'http://www.w3.org/1999/xlink'))) return null;
        rest = rest.slice(attribute[0].length);
      }
      if (!/\/\s*>$/.test(match[0])) stack.push(name);
    }
    if (!stack.length && cursor !== svg.length) return null;
  }
  if (stack.length || cursor !== svg.length || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(svg)) return null;
  return svg;
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
export function createKookReply({ token, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new KookReplyError('KOOK_INVALID_INPUT');
  }
  const authorization = `Bot ${token.trim()}`;
  return async ({ targetId, replyMessageId, content, signal, incomplete = false } = {}) => {
    const plan = prepared({ targetId, replyMessageId, content, incomplete });
    if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
    const controller = new AbortController(); let timedOut = false, asset = Boolean(plan.attachment), rejectInterrupted;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    const abort = () => { controller.abort(); rejectInterrupted(new KookReplyError('KOOK_ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true; controller.abort();
      rejectInterrupted(new KookReplyError(asset ? 'KOOK_ASSET_TIMEOUT' : 'KOOK_TIMEOUT'));
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
          const archiveName = attachment.type === 'svg' ? 'drawing.zip' : 'answer.zip';
          form.append('file', new Blob([sourceZip(attachment)], { type: 'application/zip' }), archiveName);
          const uploaded = await request(ASSET_ENDPOINT, { headers: { Authorization: authorization }, body: form });
          const url = assetUrl(uploaded?.url);
          if (!url) throw new KookReplyError('KOOK_ASSET_INVALID_RESPONSE');
          if (controller.signal.aborted) throw new KookReplyError('KOOK_ABORTED');
          const cards = card(attachment.type === 'svg' ? 'SVG 已生成，请下载 ZIP 并解压获取 drawing.svg。'
            : incomplete ? '回复尚未生成完整，请下载 ZIP 并解压 answer.txt 查看现有内容。'
              : '完整回复已保存，请下载 ZIP 并解压获取 answer.txt。');
          cards[0].modules.push({ type: 'file', src: url, title: archiveName });
          body = encode(targetId, replyMessageId, cards);
          if (body.length > MAX_PAYLOAD) throw new KookReplyError('KOOK_INVALID_INPUT');
        }
        asset = false;
        const data = await request(ENDPOINT, {
          headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body });
        if (typeof data?.msg_id !== 'string' || !MESSAGE_ID.test(data.msg_id)) throw new KookReplyError('KOOK_INVALID_RESPONSE');
        return { messageId: data.msg_id, ...(plan.attachment ? { attachmentType: plan.attachment.type } : {}) };
      };
      return await Promise.race([send(), interrupted]);
    } catch (error) {
      if (signal?.aborted) throw new KookReplyError('KOOK_ABORTED');
      if (timedOut) throw new KookReplyError(asset ? 'KOOK_ASSET_TIMEOUT' : 'KOOK_TIMEOUT');
      if (error instanceof KookReplyError) throw error;
      throw new KookReplyError(asset ? 'KOOK_ASSET_NETWORK' : 'KOOK_NETWORK');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  };
}
