import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
export const label = (track) => `${track.name} - ${track.artists}`;
export const duration = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export class UserError extends Error {}
export class UnavailableError extends UserError {}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
  if (process.platform !== 'win32') await chmod(file, 0o600);
}

export async function withTimeout(promise, ms, message = '请求超时，请稍后重试。') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new UserError(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Only numeric IDs and known NetEase URLs enter the music provider.
export function musicId(input, kind = 'song') {
  if (/^[1-9]\d{0,17}$/.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !['music.163.com', 'y.music.163.com'].includes(url.hostname)) return null;
  const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
  if (!route.pathname.split('/').includes(kind)) return null;
  const id = route.searchParams.get('id');
  return /^[1-9]\d{0,17}$/.test(id || '') ? id : null;
}

export function validateMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new UserError('网易云未返回有效音源。'); }
  const allowed = ['music.126.net', 'music.163.com', 'music.163.net', 'music.127.net'];
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      !allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new UserError('音源域名不在网易云允许列表中。');
  }
  return url.href;
}
