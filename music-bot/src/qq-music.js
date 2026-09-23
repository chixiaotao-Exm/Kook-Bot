import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UserError, UnavailableError } from './util.js';

const helper = fileURLToPath(new URL('../qq/provider.py', import.meta.url));
const MAX_RESPONSE = 2 * 1024 * 1024;
const ERRORS = {
  unavailable: 'QQ 音乐未提供完整可播放音源，可能需要会员、购买或当前地区无播放权限。',
  login: 'QQ 音乐登录已过期，请重新扫码登录。',
  login_device: 'QQ 音乐登录设备数量达到上限，请在官方客户端管理设备后重试。',
  login_restricted: 'QQ 音乐账号登录受限，请在官方客户端检查账号。',
  rate: 'QQ 音乐操作过于频繁，请稍后重试。',
  qr: 'QQ 音乐二维码已过期或状态不可用，请重新生成。',
  input: 'QQ 音乐请求参数无效。',
  dependency: 'QQ 音乐接口环境尚未就绪，请检查 Python 依赖。',
  credential_file: 'QQ 音乐登录文件无法读取，请重新扫码登录。',
};

export function qqId(input, kind = 'song') {
  const value = String(input || '').trim();
  if (/^[1-9]\d{0,18}$/.test(value)) return value;
  if (kind === 'song' && /^[A-Za-z0-9]{14}$/.test(value)) return value;
  if (kind === 'playlist' && /^top:[1-9]\d{0,5}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !['y.qq.com', 'i.y.qq.com'].includes(url.hostname) || url.username || url.password) return null;
  const route = url.pathname;
  if (kind === 'playlist') {
    if (/toplist|top/.test(route)) {
      const id = url.searchParams.get('topid') || route.match(/toplist\/([1-9]\d*)/)?.[1];
      return /^[1-9]\d{0,5}$/.test(id || '') ? `top:${id}` : null;
    }
    const id = url.searchParams.get('disstid') || url.searchParams.get('id') || route.match(/(?:playlist|taoge)\/([1-9]\d*)/)?.[1];
    return /playlist|taoge|playsquare|songlist/.test(route) && /^[1-9]\d{0,18}$/.test(id || '') ? id : null;
  }
  const id = url.searchParams.get('songmid') || url.searchParams.get('songid') || route.match(/(?:songDetail|song)\/([A-Za-z0-9]+)/i)?.[1];
  return /song/i.test(route) && (/^[1-9]\d{0,18}$/.test(id || '') || /^[A-Za-z0-9]{14}$/.test(id || '')) ? id : null;
}

export function validateQQMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new UnavailableError(ERRORS.unavailable); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !/(^|\.)stream\.qqmusic\.qq\.com$/.test(url.hostname) ||
      !/^\/M500[A-Za-z0-9]+\.mp3$/.test(url.pathname)) throw new UnavailableError(ERRORS.unavailable);
  return url.href;
}

function bounded(value, fallback, max) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new UserError('QQ 音乐请求数量无效。');
  return number;
}

function rateError(seconds = 60) {
  const error = new UserError(ERRORS.rate);
  error.code = 'QQ_RATE_LIMIT'; error.retryAfterSeconds = Math.max(1, Math.ceil(seconds));
  return error;
}

export class QQMusic {
  constructor(config, { spawnImpl = spawn, timeoutMs = 35000, queueTimeoutMs = 120000, bridge = null, now = Date.now } = {}) {
    Object.assign(this, { config, spawn: spawnImpl, timeoutMs, queueTimeoutMs, bridge, now });
    this.child = null; this.sequence = 0; this.pending = new Map(); this.closed = false;
    this.cooldowns = new Map(); this.waiting = [];
  }
  async init() { await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 }); }
  startBridge() {
    if (this.closed) throw new UserError('QQ 音乐接口正在关闭。');
    if (this.child) return this.child;
    const child = this.spawn(this.config.qqPython || 'python3', ['-u', helper, '--data-dir', path.resolve(this.config.dataDir)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.child = child; let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_RESPONSE) { this.failBridge(child); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { this.failBridge(child); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.ok !== 'boolean'
          || (message.ok ? !Object.hasOwn(message, 'result') : typeof message.error !== 'string')) {
          this.failBridge(child); return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        if (message.ok) this.finish(pending, null, message.result);
        else if (message.error === 'rate') {
          this.cooldowns.set(pending.method, this.now() + 60000);
          this.finish(pending, rateError());
        } else this.finish(pending, message.error === 'unavailable' ? new UnavailableError(ERRORS.unavailable) :
          new UserError(ERRORS[message.error] || 'QQ 音乐请求失败，请稍后重试。'));
      }
    });
    // The SDK may emit signed URLs, tokens, or upstream response bodies in diagnostics.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.failBridge(child));
    child.once('error', () => this.failBridge(child));
    child.once('close', () => this.failBridge(child));
    return child;
  }
  failBridge(child, message = 'QQ 音乐接口暂不可用，请检查 Python 服务或稍后重试。') {
    if (this.child !== child) return;
    this.child = null;
    const affected = [...this.pending.values(), ...this.waiting];
    this.pending.clear(); this.waiting = [];
    for (const pending of affected) this.finish(pending, new UserError(message), undefined, false);
    child.kill('SIGKILL');
  }
  finish(entry, error, value, drain = true) {
    if (entry.done) return;
    entry.done = true; clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    this.pending.delete(entry.id);
    const index = this.waiting.indexOf(entry);
    if (index !== -1) this.waiting.splice(index, 1);
    if (error) entry.reject(error); else entry.resolve(value);
    if (drain) this.drain();
  }
  cancel(entry, error) {
    const child = this.child;
    if (this.pending.has(entry.id) && child) {
      // Cancellation affects only this coroutine; the shared bridge stays alive.
      child.stdin.write(JSON.stringify({ id: entry.id, method: 'cancel', params: {} }) + '\n',
        (failure) => { if (failure) this.failBridge(child); });
    }
    this.finish(entry, error);
  }
  drain() {
    if (this.closed) return;
    while (this.waiting.length && this.pending.size < 4) {
      const entry = this.waiting.shift(); clearTimeout(entry.timer);
      const cooldown = (this.cooldowns.get(entry.method) || 0) - this.now();
      if (cooldown > 0) { this.finish(entry, rateError(cooldown / 1000), undefined, false); continue; }
      let child;
      try { child = this.startBridge(); } catch { this.finish(entry, new UserError('QQ 音乐接口暂不可用。'), undefined, false); continue; }
      this.pending.set(entry.id, entry);
      entry.timer = setTimeout(() => this.cancel(entry, new UserError('QQ 音乐请求超时，请稍后重试。')), this.timeoutMs);
      child.stdin.write(entry.line, (error) => { if (error) this.failBridge(child); });
    }
  }
  async call(method, params = {}, { signal } = {}) {
    if (this.closed) throw new UserError('QQ 音乐接口已关闭。');
    if (signal?.aborted) throw new UserError('QQ 音乐请求已取消。');
    const cooldown = (this.cooldowns.get(method) || 0) - this.now();
    if (cooldown > 0) throw rateError(cooldown / 1000);
    if (this.bridge) return this.bridge(method, params);
    if (this.pending.size + this.waiting.length >= 16) throw new UserError('QQ 音乐请求较多，请稍后重试。');
    const id = ++this.sequence, line = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(line) > 16384) throw new UserError('QQ 音乐请求过长。');
    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, method, line, signal };
      entry.abort = () => this.cancel(entry, new UserError('QQ 音乐请求已取消。'));
      signal?.addEventListener('abort', entry.abort, { once: true });
      entry.timer = setTimeout(() => this.finish(entry, new UserError('QQ 音乐请求排队超时，请稍后重试。')), this.queueTimeoutMs);
      this.waiting.push(entry); this.drain();
    });
  }
  search(keywords, limit = 8) {
    const input = String(keywords || '').trim();
    if (!input || input.length > 200) throw new UserError('请输入 1-200 字的歌曲名称。');
    return this.call('search', { keywords: input, limit: bounded(limit, 8, 100) });
  }
  async resolve(input) {
    const value = String(input || '').trim(); const id = qqId(value);
    if (id) return this.call('resolve', { id });
    if (/https?:\/\//i.test(value)) throw new UserError('请使用 QQ 音乐歌曲完整链接、歌曲 ID 或 MID。');
    const songs = await this.search(value, 1);
    if (!songs.length) throw new UserError('QQ 音乐没有找到该歌曲。');
    return songs[0];
  }
  playlist(input, limit = 100) {
    const id = qqId(input, 'playlist');
    if (!id) throw new UserError('请提供 QQ 音乐歌单 ID 或完整歌单链接。');
    return this.call('playlist', { id, limit: bounded(limit, 100, 500) });
  }
  playlistDetails(input, { offset = 0, limit = 50 } = {}) {
    const id = qqId(input, 'playlist');
    if (!id || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new UserError('QQ 音乐歌单或分页位置无效。');
    return this.call('playlistDetails', { id, offset, limit: bounded(limit, 50, 100) });
  }
  discover(category = 'hot') {
    if (!['hot', 'charts', 'acg', 'mine'].includes(category)) throw new UserError('QQ 音乐歌单分类无效。');
    return this.call('discover', { category });
  }
  hot(limit = 30) { return this.call('hot', { limit: bounded(limit, 30, 500) }); }
  account() { return this.call('account'); }
  qrCreate(type = 'qq') {
    if (!['qq', 'wx'].includes(type)) throw new UserError('请选择 QQ 或微信扫码登录。');
    return this.call('qrCreate', { type });
  }
  qrStatus() { return this.call('qrStatus'); }
  logout() { return this.call('logout'); }
  lyrics(track) {
    const id = qqId(typeof track === 'object' ? track?.mid || track?.id : track);
    if (!id) throw new UserError('QQ 音乐歌曲 ID 无效。');
    return this.call('lyrics', { id });
  }
  async stream(track) {
    const id = qqId(track?.mid || track?.id);
    if (!id) throw new UnavailableError(ERRORS.unavailable);
    const result = await this.call('stream', { id });
    if (!result?.full || result.preview || !result.url) throw new UnavailableError(ERRORS.unavailable);
    return validateQQMediaUrl(result.url);
  }
  close() {
    this.closed = true;
    if (this.child) this.failBridge(this.child, 'QQ 音乐接口已关闭。');
    else { for (const entry of [...this.waiting]) this.finish(entry, new UserError('QQ 音乐接口已关闭。'), undefined, false); }
  }
}
