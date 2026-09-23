import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { musicInputUrl, parseMusicInput, MUSIC_LINK_HOSTS } from './music-input.js';
import { UserError } from './util.js';

const HOSTS = new Set([...MUSIC_LINK_HOSTS.netease, ...MUSIC_LINK_HOSTS.qq,
  '163cn.tv', '163cn.com', 'c.y.qq.com', 'c3.y.qq.com', 'c5.y.qq.com', 'c6.y.qq.com']);
const MAX_BYTES = 256 * 1024;
const invalid = () => new UserError('这条分享链接暂时无法展开，请复制官方完整歌曲／歌单链接。');
const timedOut = () => new UserError('分享链接解析超时，请稍后重试。');

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Public global unicast only; exclude transition/documentation allocations.
    const words = address.toLowerCase().split(':');
    const first = parseInt(words[0], 16), second = parseInt(words[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
      && !(first === 0x3fff && second <= 0xfff);
  }
  return false;
}

function approved(value, base) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) throw invalid();
  let url; try { url = new URL(value, base); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw invalid();
  return url;
}

// No global agent, cookies, authorization, proxy or ambient DNS lookup is used.
// The address validated above is the only address the socket can connect to.
export function requestPinned(url, { address, family, signal, maxBytes = MAX_BYTES }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, family, signal, maxHeaderSize: 16384,
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [{ address, family }]) : callback(null, address, family),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KookMusicLink/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
    }, (response) => {
      const chunks = []; let bytes = 0;
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(invalid()); return; }
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); reject(invalid()); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end();
  });
}

function htmlTarget(body, base) {
  const normalized = body.replace(/\\\//g, '/').replace(/&amp;|&#38;|&#x26;/gi, '&').replace(/&quot;/gi, '"');
  const candidates = new Set();
  for (const meta of normalized.match(/<meta\b[^>]{1,3000}>/gi) || []) {
    if (!/http-equiv\s*=\s*["']?refresh\b/i.test(meta)) continue;
    const content = meta.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    const target = content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i)?.[1];
    if (target) candidates.add(approved(target, base).href);
  }
  if (candidates.size) {
    if (candidates.size !== 1) throw invalid();
    return [...candidates][0];
  }
  for (const raw of normalized.match(/https?:\/\/(?:music\.163\.com|y\.music\.163\.com|y\.qq\.com|i\.y\.qq\.com)\/[^\s<>"']+/gi) || []) {
    try { const url = approved(raw); parseMusicInput(url.href); candidates.add(url.href); } catch {}
  }
  if (candidates.size !== 1) throw invalid();
  return [...candidates][0];
}

export async function resolveShortLink(input, { lookupImpl = lookup, requestImpl = requestPinned, timeoutMs = 8000, maxRedirects = 5 } = {}) {
  const initial = musicInputUrl(input);
  if (!initial) throw invalid();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let aborted;
  const deadline = new Promise((_, reject) => { aborted = () => reject(timedOut()); controller.signal.addEventListener('abort', aborted, { once: true }); });
  const resolve = async () => {
    let url = approved(initial.href); const visited = new Set();
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      if (controller.signal.aborted) throw timedOut();
      try { parseMusicInput(url.href); return url.href; } catch (error) { if (error.code !== 'MUSIC_SHORT_LINK') throw invalid(); }
      if (visited.has(url.href)) throw invalid();
      visited.add(url.href);
      const addresses = await lookupImpl(url.hostname, { all: true, verbatim: true });
      if (controller.signal.aborted) throw timedOut();
      if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address) || entry.family !== isIP(entry.address))) throw invalid();
      const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
      const response = await requestImpl(url, { ...selected, signal: controller.signal, maxBytes: MAX_BYTES });
      if (controller.signal.aborted) throw timedOut();
      if (Buffer.byteLength(String(response.body || '')) > MAX_BYTES) throw invalid();
      let target;
      if ([301, 302, 303, 307, 308].includes(response.status)) target = response.headers?.location;
      else if (response.status === 200) target = htmlTarget(String(response.body || ''), url.href);
      else throw invalid();
      if (!target || redirects === maxRedirects) throw invalid();
      url = approved(target, url.href);
    }
    throw invalid();
  };
  try { return await Promise.race([resolve(), deadline]); }
  catch (error) { if (error instanceof UserError) throw error; throw invalid(); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); controller.abort(); }
}

export async function parseMusicInputAsync(input, options = {}, resolverOptions) {
  try { return parseMusicInput(input, options); }
  catch (error) {
    if (error.code !== 'MUSIC_SHORT_LINK') throw error;
    return { ...parseMusicInput(await resolveShortLink(input, resolverOptions), options), resolvedShortLink: true };
  }
}
