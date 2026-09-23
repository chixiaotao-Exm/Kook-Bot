import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './util.js';

const scrypt = promisify(scryptCallback);
export async function setPassword(dataDir, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('管理密码需要 12-200 个字符。');
  const salt = randomBytes(24).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  await atomicJson(path.join(dataDir, 'web-admin.json'), { salt, hash });
}
export class WebAuth {
  constructor(dataDir) { this.file = path.join(dataDir, 'web-admin.json'); this.sessions = new Map(); this.attempts = new Map(); }
  async init() {
    this.credentials = JSON.parse(await readFile(this.file, 'utf8'));
    if (!/^[a-f0-9]{128}$/.test(this.credentials.hash)) throw new Error('Web 管理密码文件无效。');
  }
  async verify(password, ip) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until < now) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) || { count: 0, until: now + 900000 };
    if (attempt.count >= 8) return { limited: true };
    attempt.count++; this.attempts.set(ip, attempt);
    if (typeof password !== 'string' || password.length > 200) return { ok: false };
    const actual = await scrypt(password, this.credentials.salt, 64);
    const ok = timingSafeEqual(actual, Buffer.from(this.credentials.hash, 'hex'));
    if (ok) this.attempts.delete(ip);
    return { ok };
  }
  create() {
    const now = Date.now();
    for (const [key, value] of this.sessions) if (value.expires < now) this.sessions.delete(key);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    const session = { csrf: randomBytes(24).toString('base64url'), expires: now + 43200000 };
    this.sessions.set(id, session); return { id, ...session };
  }
  get(cookie = '') {
    const id = cookie.split(';').map((x) => x.trim()).find((x) => x.startsWith('kook_session='))?.slice(13);
    const session = this.sessions.get(id);
    if (!session || session.expires < Date.now()) { this.sessions.delete(id); return null; }
    return { id, ...session };
  }
}
