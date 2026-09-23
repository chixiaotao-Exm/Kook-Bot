import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AdminAuth, AuthError } from './auth.js';
import { KeyUsageError, validateUsageKey } from './key-usage.js';
import { InvitationError } from './invitations.js';

const staticRoot = fileURLToPath(new URL('../public/', import.meta.url));
export class QuotaServer {
  #keyPresets; #keyUsage; #keyQueryTimes = []; #invitations; #accountLoad;
  constructor({ host = '127.0.0.1', port = 18998, publicUrl, sub2apiUrl, dashboard, scheduler, reporter = {}, auth, preview = false, publicAccess = false, keyUsage, keyPresets = [], queryBotStatus, activeQuotaStatus, invitations, publicInvites = false, accountLoad }) {
    Object.assign(this, { host, port, dashboard, scheduler, reporter, preview, publicAccess });
    this.queryBotStatus = queryBotStatus;
    this.activeQuotaStatus = activeQuotaStatus;
    this.#keyUsage = keyUsage;
    this.#invitations = invitations;
    this.#accountLoad = accountLoad;
    this.publicInvites = publicInvites === true;
    this.#keyPresets = keyPresets.filter(preset => preset.key).map(({ id, label, key }) => ({ id, label, key: validateUsageKey(key) }));
    this.publicUrl = new URL(publicUrl); this.basePath = this.publicUrl.pathname.replace(/\/$/, '');
    this.auth = auth || new AdminAuth({ baseUrl: sub2apiUrl, preview });
    this.server = http.createServer((req, res) => void this.handle(req, res)); this.server.requestTimeout = 30000; this.server.headersTimeout = 10000;
  }
  json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  cookie(res, session) { res.setHeader('Set-Cookie', `quota_session=${session?.id || ''}; HttpOnly; SameSite=Strict; Path=${this.basePath || ''}/; Max-Age=${session ? Math.max(1, Math.floor((session.expires - Date.now()) / 1000)) : 0}${this.publicUrl.protocol === 'https:' ? '; Secure' : ''}`); }
  status() { return { ...this.dashboard.snapshot(), reporter: this.reportConfig(), preview: this.preview, ...(this.activeQuotaStatus ? { activeQuota: this.activeQuotaStatus() } : {}) }; }
  reportConfig() { return { ...this.scheduler.snapshot(), configured: this.scheduler.snapshot().available, ...this.reporter }; }
  invitationCapabilities(session) {
    const enabled = Boolean(this.#invitations);
    return { enabled, publicInvites: this.publicInvites, canInvite: enabled && (this.publicInvites || Boolean(session?.user)) };
  }
  authorizeInvitation(req) {
    // Re-read the original request's session for every preflight/dispatch check.
    // Logout and login rotate/delete it even if an earlier request is still waiting.
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || origin.origin !== req.headers.origin || origin.host !== req.headers.host || origin.protocol !== this.publicUrl.protocol) {
        throw new AuthError('请求来源不匹配。', 403);
      }
    }
    const session = this.auth.get(req.headers.cookie);
    if (!session) throw new AuthError('会话已失效，请刷新页面后重试。');
    if (req.headers['x-csrf-token'] !== session.csrf) throw new AuthError('会话已更新，请刷新页面重试。', 403);
    if (!this.publicInvites && !session.user) throw new AuthError('请使用 sub2api 管理员身份发送邀请。');
    return true;
  }
  async invitationRoute(req, res, route, url, session) {
    if (route !== '/api/invitations' && !route.startsWith('/api/invitations/')) return false;
    if (url.search) throw new InvitationError('INVALID_REQUEST', '邀请参数只能通过表单提交。', 400);
    if (route === '/api/invitations') {
      if (req.method !== 'GET') throw new InvitationError('METHOD', '请求方法不支持。', 405);
      if (!this.publicAccess && !session?.user) throw new AuthError('请先登录管理员账号。');
      const accounts = this.dashboard.snapshot().accounts.filter(account => account.invitation)
        .map(({ id, invitation }) => ({ id, invitation }));
      this.json(res, 200, { ...this.invitationCapabilities(session), accounts }); return true;
    }
    const target = /^\/api\/invitations\/([1-9]\d{0,15})\/(refresh|invite)$/.exec(route);
    if (!target) throw new InvitationError('NOT_FOUND', '邀请接口不存在。', 404);
    if (req.method !== 'POST') throw new InvitationError('METHOD', '请求方法不支持。', 405);
    this.authorizeInvitation(req);
    if (!this.#invitations) throw new InvitationError('UNAVAILABLE', '邀请功能暂未配置。', 503);
    const body = await this.body(req), fields = Object.keys(body), [, id, action] = target;
    if (action === 'refresh' ? fields.length !== 0
      : fields.length !== 4 || !['email', 'programId', 'confirmed', 'requestId'].every(field => Object.hasOwn(body, field))
        || typeof body.confirmed !== 'boolean' || typeof body.requestId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId)) {
      throw new InvitationError('INVALID_REQUEST', '邀请请求格式不正确，请重新填写表单。', 400);
    }
    const authorize = () => this.authorizeInvitation(req);
    authorize();
    // requestTimeout bounds incoming headers/body; it does not impose a 30s
    // response deadline on the upstream invitation plus its preflight reads.
    const result = action === 'refresh' ? await this.#invitations.refresh(id, { authorize })
      : await this.#invitations.invite(id, body, { authorize });
    this.json(res, 200, { ...(action === 'invite' ? { sent: result.sent === true, refreshFailed: result.refreshFailed === true } : {}),
      invitation: result.invitation, cachePersisted: result.cachePersisted === true }); return true;
  }
  reportImage(req, res, route) {
    if (!route.startsWith('/api/report-images/')) return false;
    const id = /^\/api\/report-images\/([a-f0-9]{32,64})\.png$/.exec(route)?.[1];
    const image = id && req.method === 'GET' ? this.scheduler.previewImage?.(id) : null;
    if (!image) { this.json(res, req.method === 'GET' ? 404 : 405, { error: '图片已过期，请刷新播报预览。' }); return true; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Length': image.buffer.length });
    res.end(image.buffer); return true;
  }
  async keyRoute(req, res, route, url) {
    if (!['/api/key-presets', '/api/key-usage'].includes(route)) return false;
    if (url.search) throw new KeyUsageError('INVALID_REQUEST', '请通过查询输入框提交 API Key。', 400);
    if (route === '/api/key-presets' && req.method === 'GET') {
      this.json(res, 200, { presets: this.#keyPresets.map(({ id, label }) => ({ id, label })) }); return true;
    }
    if (route !== '/api/key-usage' || req.method !== 'POST') {
      throw new KeyUsageError('METHOD', '请求方法不支持。', 405);
    }
    if (!this.#keyUsage) throw new KeyUsageError('UNAVAILABLE', 'API Key 查询暂未配置。', 503);
    const now = Date.now(); this.#keyQueryTimes = this.#keyQueryTimes.filter(time => time > now - 60000);
    if (this.#keyQueryTimes.length >= 120) throw new KeyUsageError('BUSY', '查询较频繁，请稍后重试。', 429);
    this.#keyQueryTimes.push(now);
    const body = await this.body(req), fields = Object.keys(body);
    if (fields.length !== 1 || !['key', 'presetId'].includes(fields[0])) {
      throw new KeyUsageError('INVALID_REQUEST', '请输入 API Key 或选择一个快捷查询。', 400);
    }
    let preset, key;
    if (fields[0] === 'presetId') {
      preset = this.#keyPresets.find(item => item.id === body.presetId);
      if (!preset) throw new KeyUsageError('INVALID_PRESET', '快捷查询不存在。', 400);
      key = preset.key;
    } else { key = validateUsageKey(typeof body.key === 'string' ? body.key.trim() : body.key); }
    const result = await this.#keyUsage.query(key);
    this.json(res, 200, { ...result, ...(preset ? { label: preset.label } : {}) }); return true;
  }
  async body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AuthError('请求格式必须为JSON。', 400);
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 16384) throw new AuthError('请求内容过长。', 400); parts.push(part); }
    try { const value = JSON.parse(Buffer.concat(parts).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
    catch { throw new AuthError('请求格式无效。', 400); }
  }
  async handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      let route = this.basePath && url.pathname.startsWith(this.basePath + '/') ? url.pathname.slice(this.basePath.length) : url.pathname;
      if (route === '/health' && req.method === 'GET') return this.json(res, 200, { status: 'ok', ...(this.queryBotStatus ? { keyQueryBot: this.queryBotStatus() } : {}) });
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return this.json(res, 405, { error: '请求方法不支持。' });
        if (url.pathname === this.basePath && this.basePath) { res.writeHead(302, { Location: this.basePath + '/' }); return res.end(); }
        const allowed = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const file = allowed[route]; if (!file) return this.json(res, 404, { error: '页面不存在。' });
        const contents = await readFile(staticRoot + file[0]); res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' }); return res.end(req.method === 'HEAD' ? undefined : contents);
      }
      if (!['GET', 'POST'].includes(req.method)) return this.json(res, 405, { error: '请求方法不支持。' });
      if (req.headers.origin) { let origin; try { origin = new URL(req.headers.origin); } catch {} if (!origin || origin.host !== req.headers.host) throw new AuthError('请求来源不匹配。', 403); }
      let session = this.auth.get(req.headers.cookie);
      if (route === '/api/session' && req.method === 'GET') {
        if (!session) { session = this.auth.create(); this.cookie(res, session); }
        return this.json(res, 200, { authenticated: Boolean(session.user), publicAccess: this.publicAccess, canManage: Boolean(session.user), csrf: session.csrf, user: session.user, preview: this.preview,
          invitations: this.invitationCapabilities(session) });
      }
      if (route === '/api/account-load') {
        if (req.method !== 'GET') return this.json(res, 405, { error: '请求方法不支持。' });
        if (!this.publicAccess && !session?.user) throw new AuthError('请先登录管理员账号。');
        const snapshot = this.#accountLoad ? await this.#accountLoad.get()
          : { enabled: false, accounts: [], refreshIntervalMs: 10000, checkedAt: null, lastError: '' };
        return this.json(res, 200, snapshot);
      }
      if (await this.invitationRoute(req, res, route, url, session)) return;
      if (this.publicAccess && await this.keyRoute(req, res, route, url)) return;
      if (this.publicAccess && this.reportImage(req, res, route)) return;
      if (this.publicAccess) {
        if (req.method === 'GET') {
          if (route === '/api/status') return this.json(res, 200, this.status());
          if (route === '/api/report-config') return this.json(res, 200, this.reportConfig());
          if (route === '/api/reports') return this.json(res, 200, { records: this.scheduler.snapshot().history });
          if (route === '/api/report-preview') return this.json(res, 200, await this.scheduler.preview());
        }
        if (req.method === 'POST' && route === '/api/refresh') {
          await this.body(req); await this.dashboard.refresh({ force: true }); return this.json(res, 200, this.status());
        }
      }
      if (!session) throw new AuthError('请先登录管理员账号。');
      if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw new AuthError('会话已更新，请刷新页面重试。', 403);
      if (route === '/api/login' && req.method === 'POST') {
        const verified = await this.auth.login(await this.body(req), req.socket.remoteAddress || 'unknown'); this.auth.logout(session);
        session = this.auth.create(verified.user, verified.expires); this.cookie(res, session);
        return this.json(res, 200, { authenticated: true, publicAccess: this.publicAccess, canManage: true, user: session.user, csrf: session.csrf,
          invitations: this.invitationCapabilities(session) });
      }
      if (!session.user) throw new AuthError('请使用 sub2api 管理员身份登录。');
      if (this.reportImage(req, res, route)) return;
      if (await this.keyRoute(req, res, route, url)) return;
      if (route === '/api/logout' && req.method === 'POST') { this.auth.logout(session); this.cookie(res, null); return this.json(res, 200, { ok: true }); }
      if (req.method === 'GET') {
        if (route === '/api/status') return this.json(res, 200, this.status());
        if (route === '/api/report-config') return this.json(res, 200, this.reportConfig());
        if (route === '/api/reports') return this.json(res, 200, { records: this.scheduler.snapshot().history });
        if (route === '/api/report-preview') return this.json(res, 200, await this.scheduler.preview());
      } else {
        if (route === '/api/refresh') { await this.dashboard.refresh({ force: true }); return this.json(res, 200, this.status()); }
        if (route === '/api/report-config') {
          const value = await this.body(req);
          try { await this.scheduler.configure({ enabled: value.enabled, times: value.times, timeZone: value.timeZone }); }
          catch { throw new AuthError('播报设置未保存，请检查时间、时区和机器人配置。', 400); }
          return this.json(res, 200, this.reportConfig());
        }
      }
      return this.json(res, 404, { error: '接口不存在。' });
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof KeyUsageError || error instanceof InvitationError) {
        if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
        return this.json(res, error.status, { error: { code: error.code, message: error.message } });
      }
      this.json(res, error instanceof AuthError ? error.status : 500, { error: error instanceof AuthError ? error.message : '服务暂时不可用，请稍后重试。' });
    }
  }
  async start() { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); }); return this.server.address(); }
  async close() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); }
}
