import { randomBytes } from 'node:crypto';
import { OpsError } from './storage.js';

export class AdminAuth {
  constructor({ baseUrl, fetchImpl = fetch, now = Date.now } = {}) {
    this.baseUrl = new URL(baseUrl); this.fetch = fetchImpl; this.now = now; this.sessions = new Map(); this.attempts = new Map(); this.inFlight = 0;
  }
  create(user = null, expires = this.now() + 3600000) {
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 500) this.sessions.delete(this.sessions.keys().next().value);
    const value = { id: randomBytes(32).toString('base64url'), csrf: randomBytes(24).toString('base64url'), user, expires };
    this.sessions.set(value.id, value); return value;
  }
  get(cookie = '') {
    const id = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('ops_session='))?.slice(12), value = this.sessions.get(id);
    if (!value || value.expires <= this.now()) { this.sessions.delete(id); return null; } return value;
  }
  logout(session) { if (session) this.sessions.delete(session.id); }
  async upstream(route, { body, token } = {}) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([(async () => {
        const response = await this.fetch(new URL(route, this.baseUrl), { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new OpsError('管理员登录无效，请使用 Sub2API 管理员账号。', response.status === 429 ? 429 : 401); }
        const reader = response.body?.getReader(); if (!reader) throw new OpsError('登录响应异常。', 502);
        const chunks = []; let size = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) throw new Error('too large'); chunks.push(Buffer.from(value)); } }
        finally { void reader.cancel().catch(() => {}); }
        const value = JSON.parse(Buffer.concat(chunks).toString()); if (value.code !== 0) throw new OpsError('管理员登录无效。', 401); return value.data;
      })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OpsError('登录服务暂时不可用。', 502)); }, 12000); })]);
    } catch (error) { throw error instanceof OpsError ? error : new OpsError('登录服务暂时不可用。', 502); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async login(data, key) {
    const now = this.now(); for (const [id, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(id);
    if (this.attempts.size > 1000 || this.inFlight >= 4) throw new OpsError('登录繁忙，请稍后重试。', 429);
    const bucket = this.attempts.get(key) || { count: 0, until: now + 900000 };
    if (bucket.count >= 10) throw new OpsError('尝试过于频繁，请稍后重试。', 429);
    bucket.count++; this.attempts.set(key, bucket);
    if (data.token !== undefined ? typeof data.token !== 'string' || !data.token || data.token.length > 8192
      : typeof data.email !== 'string' || data.email.length > 254 || typeof data.password !== 'string' || data.password.length > 200) throw new OpsError('请输入管理员邮箱和密码，或使用已有 Sub2API 登录。');
    this.inFlight++;
    try {
      const result = data.token ? null : await this.upstream('/api/v1/auth/login', { body: { email: data.email, password: data.password } });
      const token = data.token || result?.access_token || result?.token;
      if (typeof token !== 'string' || token.length > 8192) throw new OpsError('请先在 Sub2API 完成验证码或双因素登录。', 401);
      await this.upstream('/api/v1/admin/accounts?page=1&page_size=1', { token });
      let claims = {}; try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch {}
      const expires = Number.isFinite(claims.exp) ? Math.min(now + 8 * 3600000, claims.exp * 1000) : now + 3600000;
      if (expires <= now) throw new OpsError('登录已过期。', 401);
      return { user: { email: String(data.email || claims.email || 'Sub2API 管理员').slice(0, 254), role: 'admin' }, expires };
    } finally { this.inFlight--; }
  }
}
