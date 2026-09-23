import { randomBytes } from 'node:crypto';

export class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}
export class AdminAuth {
  constructor({ baseUrl, fetchImpl = fetch, now = Date.now, preview = false }) {
    Object.assign(this, { baseUrl: new URL(baseUrl), fetch: fetchImpl, now, preview }); this.sessions = new Map(); this.attempts = new Map(); this.inFlight = 0;
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) throw new Error('Invalid sub2api origin');
  }
  create(user = null, expires = this.now() + 3600000) {
    for (const [id, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(id);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url'), session = { id, csrf: randomBytes(24).toString('base64url'), user, expires };
    this.sessions.set(id, session); return session;
  }
  get(cookie = '') {
    const id = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith('quota_session='))?.slice(14), value = this.sessions.get(id);
    if (!value || value.expires <= this.now()) { this.sessions.delete(id); return null; }
    return value;
  }
  async upstream(route, { token, body } = {}) {
    let response;
    try { response = await this.fetch(new URL(route, this.baseUrl), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new AuthError('暂时无法连接 sub2api，请稍后再试。', 502); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new AuthError(response.status === 429 ? '登录尝试过于频繁，请稍后重试。' : '管理员登录无效，请使用现有 sub2api 管理员账号。', response.status === 429 ? 429 : 401); }
    let result;
    try { const raw = await response.text(); if (raw.length > 1048576) throw new Error('Too large'); result = JSON.parse(raw); } catch { throw new AuthError('sub2api 登录响应异常。', 502); }
    if (result.code !== 0) throw new AuthError('管理员登录无效，请使用现有 sub2api 管理员账号。');
    return result.data;
  }
  async login(data, rateKey) {
    const now = this.now(); for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const key = String(rateKey).slice(0, 100), bucket = this.attempts.get(key) || { count: 0, until: now + 900000 };
    if (bucket.count >= 12 || this.inFlight >= 4) throw new AuthError('登录尝试过于频繁，请稍后重试。', 429);
    bucket.count++; this.attempts.set(key, bucket); this.inFlight++;
    try {
      if (this.preview && data.email === 'admin@example.test' && data.password === 'preview-only-password') return { user: { email: data.email, role: 'admin' }, expires: now + 3600000 };
      let token = data.token;
      if (token !== undefined) {
        if (typeof token !== 'string' || token.length > 8192 || !token) throw new AuthError('请先在 sub2api 登录管理员账号，再使用已有登录。');
      } else {
        if (typeof data.email !== 'string' || data.email.length > 254 || typeof data.password !== 'string' || data.password.length > 200) throw new AuthError('请输入管理员邮箱和密码。');
        const loggedIn = await this.upstream('/api/v1/auth/login', { body: { email: data.email, password: data.password } });
        token = loggedIn?.access_token || loggedIn?.token;
        if (!token) throw new AuthError('请先在 sub2api 完成验证码或双因素登录，再使用已有登录。');
      }
      await this.upstream('/api/v1/admin/accounts?page=1&page_size=1', { token });
      let claims = {};
      try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch {}
      const expires = Number.isFinite(claims.exp) ? Math.min(now + 8 * 3600000, claims.exp * 1000) : now + 3600000;
      if (expires <= now) throw new AuthError('sub2api 登录已过期，请重新登录。');
      return { user: { email: String(data.email || claims.email || 'Sub2API 管理员').slice(0, 254), role: 'admin' }, expires };
    } finally { this.inFlight--; }
  }
  logout(session) { this.sessions.delete(session.id); }
}
