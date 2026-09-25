import http from 'node:http';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebAuth } from './web-auth.js';
import { atomicJson, log, UserError } from './util.js';
import { musicSource } from './music-sources.js';
import { parseMusicInput } from './music-input.js';
import { qqId } from './qq-music.js';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.vrm': 'model/gltf-binary', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
const actions = new Set(['pause', 'resume', 'previous', 'skip', 'stop', 'volume', 'loop', 'remove', 'clear', 'seek', 'move', 'shuffle']);
const botRoutes = new Set(['/api/channel', '/api/play', '/api/playlist', '/api/heart', '/api/hot', '/api/control', '/api/settings', '/api/features']);

export class WebConsole {
  constructor({ config, api, music, player, gateway, self, manager, diagnostics, access, rooms, writeCredential = atomicJson, preview = false }) {
    Object.assign(this, { config, api, music, player, gateway, self, manager, diagnostics, access, rooms, writeCredential, preview });
    this.auth = new WebAuth(config.dataDir); this.started = Date.now(); this.cache = new Map(); this.activity = [];
    this.activities = new Map([['default', this.activity]]); this.mutations = new Set(); this.accountTail = Promise.resolve();
    this.qr = null; this.mutating = false; this.stateVersion = 0;
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000;
  }
  async start() {
    if (this.config.webRequirePassword !== false) await this.auth.init();
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.webPort, this.config.webHost, resolve); });
    log('web_started', { port: this.server.address().port });
    return this.server.address();
  }
  async close() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); }
  json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  async body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求格式应为 JSON。');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new UserError('请求内容过长。'); chunks.push(chunk); }
    try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || Array.isArray(data) || typeof data !== 'object') throw 0; return data; }
    catch { throw new UserError('请求内容无效。'); }
  }
  cookie(res, id, maxAge = 43200) {
    this.setCookie(res, 'kook_session', id, maxAge);
  }
  setCookie(res, name, value, maxAge) {
    const previous = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : [previous]),
      `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.config.webSecure ? '; Secure' : ''}`]);
  }
  identityToken(req) {
    return (req.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith('kook_identity='))?.slice(14);
  }
  get accessControlled() { return Boolean(this.access && this.rooms); }
  renewAdminSession(res, actor, token) {
    for (const [id, session] of this.auth.sessions) if (session.identityId === actor.id) this.auth.sessions.delete(id);
    const session = this.auth.create(); this.auth.sessions.get(session.id).identityId = actor.id;
    this.cookie(res, session.id);
    if (token) this.setCookie(res, 'kook_identity', token, 90 * 86400);
    return { ok: true, actor, csrf: session.csrf };
  }
  permissions(actor, botId) {
    if (!this.accessControlled) return { request: true, playbackControl: true, control: true, manageRoom: true, manageRoles: true, manageSite: true };
    const role = actor ? this.access.role(actor.id, botId) : 'guest';
    return { request: role !== 'guest', playbackControl: role !== 'guest', control: ['dj', 'owner'].includes(role), manageRoom: role === 'owner',
      manageRoles: role === 'owner', manageSite: Boolean(actor?.siteAdmin) };
  }
  authorizeLegacy(route, data, actor, method = 'POST') {
    if (!this.accessControlled) return;
    if (method === 'GET') {
      if (route === '/api/account' || route === '/api/account/qr' || route === '/api/discover' && data.category === 'mine') this.access.requireAdmin(actor.id);
      if (route === '/api/features') this.access.require(actor.id, this.botId(data.botId), 'owner');
      return;
    }
    if (['/api/play', '/api/playlist', '/api/heart', '/api/hot'].includes(route) || route.startsWith('/api/account/') || route.startsWith('/api/bots/')) {
      this.access.requireAdmin(actor.id); return;
    }
    if (['/api/channel', '/api/settings', '/api/features'].includes(route) || route === '/api/control' && data.action === 'stop') {
      this.access.require(actor.id, this.botId(data.botId), 'owner'); return;
    }
    if (route === '/api/control') this.access.require(actor.id, this.botId(data.botId), 'dj');
  }
  roomBase(req) {
    const host = req.headers.host;
    if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new UserError('网页地址无效。');
    return new URL(`${this.config.webSecure ? 'https' : 'http'}://${host}`);
  }
  async socialGet(url, actor, req) {
    if (url.pathname === '/api/rooms') return { rooms: await this.rooms.lobby(actor.id) };
    const botId = this.runtime(url.searchParams.get('botId') ?? undefined).id;
    if (url.pathname === '/api/room') return this.rooms.room(botId, actor.id);
    if (url.pathname === '/api/room/roles') {
      this.access.require(actor.id, botId, 'owner');
      return { members: this.access.members(botId), invites: this.access.invites(actor.id, botId) };
    }
    if (url.pathname === '/api/room/share') {
      const link = new URL(`/room/${encodeURIComponent(botId)}`, this.roomBase(req)).href;
      return { url: link, qr: await QRCode.toDataURL(link, { width: 240, margin: 2 }) };
    }
    throw new UserError('接口不存在。');
  }
  async socialPost(route, data, actor) {
    if (route === '/api/identity/profile') return { ok: true, actor: await this.access.profile(actor.id, data.name) };
    if (route === '/api/access/redeem') {
      const result = await this.access.redeem(actor.id, data.token);
      if (result.botId) this.rooms.record(result.botId, { kind: 'role_joined', actorName: actor.name || '网页成员', message: `接受了${result.role === 'owner' ? '房主' : 'DJ'}邀请。` });
      return { ok: true, ...result, actor: this.access.actor(actor.id) };
    }
    const botId = this.runtime(data.botId).id;
    const run = async () => {
      if (route === '/api/room/heartbeat') { await this.rooms.heartbeat(botId, actor.id); return { ok: true }; }
      if (route === '/api/room/request') return { ok: true, ...await this.rooms.request(botId, actor.id, data) };
      if (route === '/api/room/control') return { ok: true, ...await this.rooms.control(botId, actor.id, data) };
      if (route === '/api/room/withdraw') return { ok: true, ...await this.rooms.withdraw(botId, actor.id, data.entryId) };
      if (route === '/api/room/profile') {
        const profile = await this.rooms.updateProfile(botId, actor.id, data);
        this.rooms.record(botId, { kind: 'room_updated', actorName: actor.name || '房主', message: '更新了房间介绍与外观。' });
        return { ok: true, profile };
      }
      if (route === '/api/room/invite') {
        const result = await this.access.issueInvite(actor.id, botId, data.role);
        this.rooms.record(botId, { kind: 'role_invited', actorName: actor.name || '房主', message: `创建了${data.role === 'owner' ? '房主' : 'DJ'}邀请。` });
        return { ok: true, ...result };
      }
      if (route === '/api/room/revoke') {
        await this.access.revoke(actor.id, botId, data.targetId);
        this.rooms.record(botId, { kind: 'role_revoked', actorName: actor.name || '房主', message: '收回了一项房间管理权限。' });
        return { ok: true };
      }
      if (route === '/api/room/revoke-invite') { await this.access.revokeInvite(actor.id, botId, data.inviteId); return { ok: true }; }
      throw new UserError('接口不存在。');
    };
    return this.manager?.withBot ? this.manager.withBot(botId, run) : run();
  }
  async cached(key, loader, ttl = 60000) {
    if (this.cache.size > 200) {
      for (const [name, item] of this.cache) if (item.until < Date.now()) this.cache.delete(name);
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    const entry = this.cache.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    const value = Promise.resolve().then(loader);
    this.cache.set(key, { value, until: Date.now() + ttl });
    try { return await value; } catch (error) { this.cache.delete(key); throw error; }
  }
  clearAccountCache(source = 'netease') {
    this.cache.delete('account'); this.cache.delete('discover:mine');
    for (const key of this.cache.keys()) if (key.startsWith('playlist:') || key.startsWith('joint-search:') || key.startsWith(`source:${source}:`)) this.cache.delete(key);
  }
  botId(value) {
    if (value === undefined) return 'default';
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new UserError('机器人编号无效。');
    return value;
  }
  runtime(value) {
    const id = this.botId(value);
    if (this.manager) return this.manager.get(id);
    if (id !== 'default') throw new UserError('机器人不存在，请刷新列表。');
    return { id, config: this.config, api: this.api, player: this.player, gateway: this.gateway, self: this.self, status: 'ready', managed: false };
  }
  safeMessage(value, extraSecrets = []) {
    let result = typeof value === 'string' ? value : '';
    const secrets = [this.config.token, ...extraSecrets];
    if (this.manager) {
      for (const item of this.manager.list()) {
        try { secrets.push(this.manager.get(item.id)?.config?.token); } catch {}
      }
    }
    for (const secret of secrets) if (typeof secret === 'string' && secret) result = result.split(secret).join('[已隐藏]');
    return result;
  }
  descriptor(item) {
    return { id: item.id, name: this.safeMessage(item.name || item.username || '机器人'), username: this.safeMessage(item.username || ''),
      online: Boolean(item.online), status: item.status || 'ready', error: this.safeMessage(item.error), managed: Boolean(item.managed),
      guildIds: Array.isArray(item.guildIds) ? item.guildIds.filter((id) => typeof id === 'string') : [],
      context: item.context ? { guildId: item.context.guildId, voiceChannelId: item.context.voiceChannelId, textChannelId: item.context.textChannelId } : null,
      playing: Boolean(item.playing) };
  }
  bots() {
    if (this.manager) return this.manager.list().map((item) => this.descriptor(item));
    return [this.descriptor({ id: 'default', name: this.self?.username, username: this.self?.username, online: this.gateway?.ready,
      status: 'ready', managed: false, guildIds: [...this.config.guilds], context: this.player?.context,
      playing: Boolean(this.player?.stream && !this.player.stream.paused) })];
  }
  requirePlayer(runtime) {
    if (!runtime.player || ['error', 'failed', 'stopping', 'removed', 'starting'].includes(runtime.status)) throw new UserError('此机器人当前不可用，请先在机器人管理中重试连接。');
    return runtime.player;
  }
  accountExclusive(fn) {
    const next = this.accountTail.then(fn);
    this.accountTail = next.catch(() => {});
    return next;
  }
  emptySnapshot(runtime) {
    return { current: null, queue: [], context: null, volume: runtime.config?.volume ?? this.config.volume, mode: 'off', stayConnected: false,
      connected: false, status: 'unavailable', disabled: true, seconds: 0, canResume: false, recoveryError: this.safeMessage(runtime.error),
      capacity: 0, maxQueue: runtime.config?.maxQueue ?? this.config.maxQueue, canPrevious: false, historyCount: 0 };
  }
  provider(source) { return this.music.forSource ? this.music.forSource(source) : this.music; }
  async parseInput(input, options) {
    return this.music.parseInput ? this.music.parseInput(input, options) : parseMusicInput(input, options);
  }
  async catalog(runtime = this.runtime()) {
    if (!runtime.api || !runtime.player) throw new UserError('此机器人当前不可用，请先重试连接。');
    return this.cached(`bot:${runtime.id}:catalog`, async () => {
      const result = [];
      for (const guildId of runtime.config.guilds) {
        const guild = await runtime.api.request('guild/view', { guild_id: guildId });
        const channels = [];
        for (const type of [1, 2]) {
          for (let page = 1; page <= 20; page++) {
            const data = await runtime.api.request('channel/list', { guild_id: guildId, type, page, page_size: 50 });
            channels.push(...(data.items || []).filter((x) => !x.is_category && [1, 2].includes(x.type)).map((x) => ({ id: x.id, name: x.name, type: x.type })));
            if (page >= (data.meta?.page_total || 1)) break;
          }
        }
        result.push({ id: guildId, name: guild.name, channels: [...new Map(channels.map((x) => [x.id, x])).values()] });
      }
      return result;
    });
  }
  async context(data, runtime = this.runtime(data.botId)) {
    const player = this.requirePlayer(runtime);
    if (!data.guildId && player.context) return player.context;
    const guild = (await this.catalog(runtime)).find((x) => x.id === data.guildId);
    const voice = guild?.channels.find((x) => x.id === data.voiceChannelId && x.type === 2);
    const textId = data.textChannelId || data.voiceChannelId;
    const text = guild?.channels.find((x) => x.id === textId);
    if (!guild || !voice || !text) throw new UserError('请选择有效的服务器和语音频道。');
    if (runtime.config.textChannels.size && !runtime.config.textChannels.has(textId)) throw new UserError('通知频道不在允许列表中。');
    return { guildId: guild.id, voiceChannelId: voice.id, textChannelId: text.id };
  }
  channelBinding(data, player, context) {
    const expectedVoiceChannelId = data.expectedVoiceChannelId;
    if (expectedVoiceChannelId === undefined) return {};
    if (typeof expectedVoiceChannelId !== 'string' || !expectedVoiceChannelId.trim() || expectedVoiceChannelId.length > 64) {
      throw new UserError('预览频道无效，请重新预览后再加入。');
    }
    if (!player.context || !context || player.context.voiceChannelId !== expectedVoiceChannelId ||
        player.context.voiceChannelId !== context.voiceChannelId || player.context.guildId !== context.guildId) {
      throw new UserError('机器人频道已变化，请重新预览后再加入。');
    }
    return { expectedVoiceChannelId };
  }
  record(message, botId = 'default') {
    if (!this.activities.has(botId)) this.activities.set(botId, []);
    const activity = this.activities.get(botId);
    activity.unshift({ time: Date.now(), message: this.safeMessage(message) }); activity.length = Math.min(20, activity.length); this.stateVersion++;
  }
  async handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let submittedToken, requestBotId, submittedSecrets = [];
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return await this.static(req, res, url.pathname);
      const queryKeys = [...url.searchParams.keys()];
      if (new Set(queryKeys).size !== queryKeys.length) throw new UserError('请求包含重复参数，请重新操作。');
      if (!['GET', 'POST'].includes(req.method)) return this.json(res, 405, { error: '请求方法不支持。' });
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch {}
        if (!origin || origin.host !== req.headers.host) return this.json(res, 403, { error: '请求来源不匹配。' });
      }
      let session = this.auth.get(req.headers.cookie);
      let actor = this.accessControlled ? this.access.get(this.identityToken(req)) : null;
      const passwordRequired = this.config.webRequirePassword !== false;
      if (url.pathname === '/api/session' && req.method === 'GET') {
        if (!passwordRequired && !session) { session = this.auth.create(); this.cookie(res, session.id); }
        if (this.accessControlled && session) {
          const identity = await this.access.ensure(this.identityToken(req)); actor = identity.actor;
          if (identity.token) this.setCookie(res, 'kook_identity', identity.token, 90 * 86400);
          if (session.identityId && session.identityId !== actor.id) {
            this.auth.sessions.delete(session.id); session = this.auth.create(); this.cookie(res, session.id);
          }
          this.auth.sessions.get(session.id).identityId = actor.id;
        }
        return this.json(res, 200, { authenticated: Boolean(session), csrf: session?.csrf, passwordRequired, preview: this.preview,
          accessControlled: this.accessControlled, actor,
          adminLoginEnabled: Boolean(this.accessControlled && this.access.adminLoginStatus?.().enabled),
          roles: this.accessControlled && actor ? Object.fromEntries(this.bots().map((bot) => [bot.id, this.access.role(actor.id, bot.id)])) : {} });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!passwordRequired) return this.json(res, 404, { error: '当前控制台无需密码。' });
        const data = await this.body(req); const result = await this.auth.verify(data.password, req.socket.remoteAddress);
        if (!result.ok) return this.json(res, result.limited ? 429 : 401, { error: result.limited ? '尝试次数过多，请 15 分钟后重试。' : '管理密码不正确。' });
        const created = this.auth.create(); this.cookie(res, created.id); return this.json(res, 200, { csrf: created.csrf });
      }
      if (!session) return this.json(res, 401, { error: passwordRequired ? '请先登录控制台。' : '会话已过期，请刷新页面。' });
      if (this.accessControlled && !actor) return this.json(res, 401, { error: '房间身份已过期，请刷新页面。' });
      if (this.accessControlled && session.identityId !== actor.id) return this.json(res, 401, { error: '房间身份已变化，请刷新页面。' });
      if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) return this.json(res, 403, { error: '会话验证失败，请刷新页面。' });
      if (req.method === 'GET') {
        if (this.accessControlled && url.pathname === '/api/admin/status') {
          this.access.requireAdmin(actor.id); return this.json(res, 200, this.access.adminLoginStatus());
        }
        if (this.accessControlled && (url.pathname === '/api/rooms' || url.pathname === '/api/room' || url.pathname.startsWith('/api/room/'))) {
          return this.json(res, 200, await this.socialGet(url, actor, req));
        }
        this.authorizeLegacy(url.pathname, Object.fromEntries(url.searchParams), actor, 'GET');
        return this.json(res, 200, await this.get(url, actor));
      }
      const data = await this.body(req);
      if (url.pathname === '/api/bots/add') submittedToken = data.token;
      if (this.accessControlled && url.pathname.startsWith('/api/admin/')) {
        submittedSecrets = [data.password, data.currentPassword, data.newPassword];
        if (url.pathname === '/api/admin/login') {
          const result = await this.access.loginAdmin(actor.id, data.username, data.password, req.socket.remoteAddress || 'unknown');
          return this.json(res, 200, this.renewAdminSession(res, result.actor, result.token));
        }
        if (url.pathname === '/api/admin/password') {
          this.access.requireAdmin(actor.id);
          const result = await this.access.setAdminLogin(this.access.adminLoginStatus().username, data.newPassword,
            { actorId: actor.id, currentPassword: data.currentPassword });
          return this.json(res, 200, this.renewAdminSession(res, result.actor, result.token));
        }
        if (url.pathname === '/api/admin/logout') {
          const updated = await this.access.logoutAdmin(actor.id);
          return this.json(res, 200, this.renewAdminSession(res, updated));
        }
        throw new UserError('接口不存在。');
      }
      if (url.pathname === '/api/logout') {
        if (this.accessControlled) await this.access.logout(actor.id);
        this.auth.sessions.delete(session.id); this.cookie(res, '', 0);
        if (this.accessControlled) this.setCookie(res, 'kook_identity', '', 0);
        return this.json(res, 200, { ok: true });
      }
      if (this.accessControlled && (url.pathname.startsWith('/api/room/') || ['/api/identity/profile', '/api/access/redeem'].includes(url.pathname))) {
        return this.json(res, 200, await this.socialPost(url.pathname, data, actor));
      }
      this.authorizeLegacy(url.pathname, data, actor);
      const scoped = botRoutes.has(url.pathname);
      const lifecycle = ['/api/bots/remove', '/api/bots/retry'].includes(url.pathname);
      const id = scoped || lifecycle ? this.runtime(data.botId).id : undefined;
      requestBotId = id;
      const lock = id ? `bot:${id}` : url.pathname.startsWith('/api/account/') ? 'accounts' : 'bot-management';
      if (this.mutations.has(lock) || (!this.manager && this.mutating)) return this.json(res, 409, { error: '正在处理上一项操作，请稍后再试。' });
      this.mutations.add(lock);
      if (!this.manager) this.mutating = true;
      try {
        const run = (runtime) => {
          // A shared-account queue or bot lease may wait past logout/revocation.
          this.authorizeLegacy(url.pathname, data, actor);
          return this.post(url.pathname, data, runtime, actor);
        };
        const result = scoped && this.manager?.withBot ? await this.manager.withBot(id, run)
          : lock === 'accounts' ? await this.accountExclusive(() => run()) : await run(scoped ? this.runtime(id) : undefined);
        return this.json(res, 200, result);
      } finally { this.mutations.delete(lock); if (!this.manager) this.mutating = false; }
    } catch (error) {
      if (!res.headersSent) this.json(res, error.code === 'QQ_RATE_LIMIT' ? 429 : [401, 403, 409, 429].includes(error.statusCode) ? error.statusCode : error instanceof UserError ? 400 : 500,
        { error: error instanceof UserError ? this.safeMessage(error.message, [submittedToken, ...submittedSecrets]) : '请求失败，请稍后再试。',
          ...(error.code === 'QQ_RATE_LIMIT' ? { code: 'QQ_RATE_LIMIT', retryAfterSeconds: error.retryAfterSeconds } : {}),
          ...(error.statusCode === 429 && Number.isFinite(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
      log('web_request_error', { kind: error.constructor.name });
      if (!(error instanceof UserError) || /(?:QQ|网易云).*(?:登录|过期|超时|音源|接口)/.test(error.message)) {
        this.diagnostics?.record({ botId: requestBotId, level: 'warning', kind: 'request_failed',
          message: error instanceof UserError ? this.safeMessage(error.message, [submittedToken, ...submittedSecrets]) : '控制台请求失败，请检查服务器日志。' });
      }
    }
  }
  async get(url, actor) {
    const source = musicSource(url.searchParams.get('source') ?? undefined);
    switch (url.pathname) {
      case '/api/sources': return { sources: [{ id: 'netease', name: '网易云音乐', enabled: true }, { id: 'qq', name: 'QQ音乐', enabled: Boolean(this.music.forSource) }] };
      case '/api/bots': return { bots: this.bots(), defaultBotId: 'default' };
      case '/api/features': {
        const runtime = this.runtime(url.searchParams.get('botId') ?? undefined);
        if (!runtime.features) throw new UserError('机器人尚未就绪，暂时无法读取房间设置。');
        return { botId: runtime.id, features: runtime.features.snapshot() };
      }
      case '/api/health': {
        if (!this.diagnostics) throw new UserError('健康监测尚未启动。');
        if (url.searchParams.get('refresh') === '1') await this.diagnostics.refreshAccounts({ force: true });
        return this.diagnostics.snapshot();
      }
      case '/api/state': {
        const runtime = this.runtime(url.searchParams.get('botId') ?? undefined);
        const bots = this.bots(); const bot = bots.find((item) => item.id === runtime.id);
        return { botId: runtime.id, player: runtime.player ? runtime.player.snapshot() : this.emptySnapshot(runtime), bot, bots,
          permissions: this.permissions(actor, runtime.id),
          uptime: Math.floor((Date.now() - this.started) / 1000), busy: this.mutations.has(`bot:${runtime.id}`) || (!this.manager && this.mutating),
          activity: this.activities.get(runtime.id) || [], preview: this.preview };
      }
      case '/api/catalog': {
        const runtime = this.runtime(url.searchParams.get('botId') ?? undefined);
        const read = (current) => this.catalog(current);
        return { botId: runtime.id, guilds: this.manager?.withBot ? await this.manager.withBot(runtime.id, read) : await read(runtime) };
      }
      case '/api/search': {
        const q = url.searchParams.get('q')?.trim();
        if (!q || q.length > 200) throw new UserError('请输入 1-200 字的歌名或歌手。');
        return { tracks: await this.cached(`source:${source}:search:${q}`, () => this.music.search(q, 20, source), 30000) };
      }
      case '/api/search-all': {
        const query = url.searchParams.get('q')?.trim();
        if (!query || query.length > 200) throw new UserError('请输入 1-200 字的歌名或歌手。');
        if (!this.music.searchAll) throw new UserError('联合搜索暂不可用。');
        const result = await this.cached(`joint-search:${query}`, () => this.music.searchAll(query, 20), 15000);
        const groups = ['netease', 'qq'].map((id) => ({ source: id, name: id === 'qq' ? 'QQ音乐' : '网易云音乐',
          tracks: result.results?.[id]?.tracks || [], ...(result.results?.[id]?.error ? { error: this.safeMessage(result.results[id].error) } : {}) }));
        return { groups, tracks: result.tracks || groups.flatMap((group) => group.tracks),
          errors: groups.filter((group) => group.error).map((group) => ({ source: group.source, message: group.error })) };
      }
      case '/api/lyrics': {
        if (!this.music.lyrics) throw new UserError('歌词服务暂不可用。');
        const parsed = parseMusicInput(url.searchParams.get('id') || '', { source, kind: 'song' });
        if (parsed.kind !== 'song') throw new UserError('请输入有效的歌曲 ID。');
        return this.cached(`source:${parsed.source}:lyrics:${parsed.id}`, () => this.music.lyrics(parsed.id, parsed.source), 600000);
      }
      case '/api/resolve': {
        const parsed = await this.parseInput(url.searchParams.get('input') || '', { source, kind: url.searchParams.get('kind') ?? undefined });
        if (parsed.kind === 'search') return parsed;
        const details = await this.cached(`source:${parsed.source}:resolve:${parsed.kind}:${parsed.id}`, () => parsed.kind === 'song'
          ? this.music.resolve(parsed.input, parsed.source).then((track) => ({ track }))
          : this.music.playlistDetails(parsed.input, { offset: 0, limit: 5 }, parsed.source), 30000);
        return { ...details, ...parsed };
      }
      case '/api/discover': {
        const category = url.searchParams.get('category') || 'hot';
        if (!['hot', 'charts', 'acg', 'mine'].includes(category)) throw new UserError('歌单分类无效。');
        return { playlists: await this.cached(`source:${source}:discover:${category}`, () => this.music.discover(category, source), 120000) };
      }
      case '/api/playlist': {
        const id = url.searchParams.get('id') || '';
        const offsetText = url.searchParams.get('offset') ?? '0';
        const limitText = url.searchParams.get('limit') ?? '50';
        const offset = Number(offsetText); const limit = Number(limitText);
        if (source === 'qq' ? qqId(id, 'playlist') !== id : !/^[1-9]\d{0,17}$/.test(id)) throw new UserError('请输入有效的歌单 ID。');
        if (!/^\d+$/.test(offsetText) || !/^\d+$/.test(limitText) || !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError('歌单分页位置无效，每页可读取 1-100 首歌曲。');
        return this.cached(`source:${source}:playlist:${id}:${offset}:${limit}`, () => this.music.playlistDetails(id, { offset, limit }, source));
      }
      case '/api/account': return this.cached(`source:${source}:account`, async () => {
        const account = await this.music.account(source);
        return { ...account, status: account.loggedIn ? 'logged_in' : account.expired ? 'expired' : 'logged_out' };
      }, 30000);
      case '/api/account/qr': {
        return this.accountExclusive(async () => {
          this.authorizeLegacy(url.pathname, { source }, actor, 'GET');
          if (source === 'netease') return this.qrStatus();
          const status = await this.provider(source).qrStatus();
          if (status.status === 'success') { this.clearAccountCache(source); this.diagnostics?.invalidateAccount(source, true); }
          return { ...status, status: status.status === 'refused' ? 'rejected' : status.status };
        });
      }
      default: throw new UserError('接口不存在。');
    }
  }
  async post(route, data, selectedRuntime, actor) {
    const source = musicSource(data.source);
    const runtime = botRoutes.has(route) ? selectedRuntime || this.runtime(data.botId) : null;
    const player = runtime ? this.requirePlayer(runtime) : null;
    // Music lookups run outside the player lock. A later room/KOOK control must
    // win even when the earlier lookup or link expansion finishes afterwards.
    const playbackEpoch = player?.operationEpoch;
    const record = (message) => this.record(message, runtime?.id);
    const authorize = () => { this.authorizeLegacy(route, data, actor); return true; };
    switch (route) {
      case '/api/bots/add': {
        if (!this.manager?.add) throw new UserError('此环境不支持添加机器人。');
        const bot = await this.manager.add({ token: data.token, name: data.name, guildIds: data.guildIds });
        return { ok: true, bot: this.descriptor(bot), bots: this.bots() };
      }
      case '/api/bots/remove':
      case '/api/bots/retry': {
        const id = this.runtime(data.botId).id;
        const operation = route.endsWith('/remove') ? 'remove' : 'retry';
        if (!this.manager?.[operation]) throw new UserError('此环境不支持管理机器人。');
        await this.manager[operation](id);
        this.cache.delete(`bot:${id}:catalog`);
        if (operation === 'remove') this.activities.delete(id);
        else this.record('已重新尝试连接机器人', id);
        return { ok: true, bots: this.bots() };
      }
      case '/api/channel': await player.join(await this.context(data, runtime), { authorize, expectedEpoch: playbackEpoch }); record('已加入语音频道'); break;
      case '/api/features': {
        if (!runtime.features) throw new UserError('机器人尚未就绪，暂时无法修改房间设置。');
        if (!['radio', 'schedules', 'rules'].includes(data.section)) throw new UserError('房间设置类型无效。');
        await runtime.features.configure(data.section, data.value, { authorize });
        record(`已保存${{ radio: '自动电台', schedules: '定时任务', rules: '点歌规则' }[data.section]}设置`);
        this.diagnostics?.record({ botId: runtime.id, level: 'info', kind: 'settings_saved', message: `已保存${{ radio: '自动电台', schedules: '定时任务', rules: '点歌规则' }[data.section]}设置。` });
        return { ok: true, botId: runtime.id, features: runtime.features.snapshot() };
      }
      case '/api/play': {
        const parsed = await this.parseInput(String(data.input || ''), { source });
        if (parsed.kind === 'playlist') throw new UserError('识别到歌单，请先预览歌单再确认导入。');
        this.channelBinding(data, player, player.context);
        if (player.capacity() < 1) throw new UserError('播放队列已满。');
        const ctx = await this.context(data, runtime); const binding = this.channelBinding(data, player, ctx);
        const track = await this.music.resolve(parsed.input, parsed.source);
        await player.add(ctx, [{ ...track, requestedBy: this.accessControlled ? `room:${actor.id}` : 'web-admin',
          ...(this.accessControlled ? { requestedByName: actor.name || '站点管理者' } : {}) }], { ...binding, expectedEpoch: playbackEpoch, checkState: authorize }); record(`点歌：${track.name}`);
        return { ok: true, added: 1 };
      }
      case '/api/playlist': {
        const parsed = await this.parseInput(String(data.id || ''), { source, kind: 'playlist' });
        if (parsed.kind !== 'playlist') throw new UserError('识别到歌曲，请使用歌曲加入按钮。');
        if (data.maxItems !== undefined && (!Number.isInteger(data.maxItems) || data.maxItems < 1 || data.maxItems > 500)) throw new UserError('歌单导入数量应为 1-500 首。');
        this.channelBinding(data, player, player.context);
        if (player.capacity() < 1) throw new UserError('播放队列已满。');
        const ctx = await this.context(data, runtime);
        const binding = this.channelBinding(data, player, ctx);
        const limit = Math.min(data.maxItems ?? 500, player.capacity());
        const available = await this.music.playlist(parsed.input, limit, parsed.source);
        const tracks = available.slice(0, Math.min(limit, player.capacity()));
        await player.add(ctx, this.accessControlled ? tracks.map((track) => ({ ...track, requestedBy: `room:${actor.id}`, requestedByName: actor.name || '站点管理者' })) : tracks,
          { ...binding, expectedEpoch: playbackEpoch, checkState: authorize }); record(`歌单已导入 ${tracks.length} 首歌曲`);
        return { ok: true, added: tracks.length };
      }
      case '/api/heart':
      case '/api/hot': {
        if (route === '/api/hot' && data.full !== undefined && typeof data.full !== 'boolean') throw new UserError('热歌导入选项无效。');
        if (player.capacity() < 1) throw new UserError('播放队列已满。');
        const ctx = await this.context(data, runtime);
        const limit = route === '/api/hot' && data.full === true ? player.capacity() : Math.min(30, player.capacity());
        const seed = (player.current?.source ?? 'netease') === source ? player.current?.id : undefined;
        const result = route === '/api/heart' ? await this.music.heart({ playlistId: data.playlistId, songId: seed, limit }, source) : await this.music.hot(limit, source);
        await player.add(ctx, this.accessControlled ? result.tracks.map((track) => ({ ...track, requestedBy: `room:${actor.id}`, requestedByName: actor.name || '站点管理者' })) : result.tracks,
          { expectedEpoch: playbackEpoch, checkState: authorize }); record(result.notice || `${result.name}：已添加 ${result.tracks.length} 首`);
        return { ok: true, notice: result.notice || `${result.name}：已加入 ${result.tracks.length} 首。`, mode: result.mode, added: result.tracks.length };
      }
      case '/api/control': {
        if (!actions.has(data.action)) throw new UserError('播放操作无效。');
        if (data.action === 'volume' && (!Number.isInteger(data.value) || data.value < 0 || data.value > 100)) throw new UserError('音量范围为 0-100。');
        if (data.action === 'loop' && !['off', 'one', 'all'].includes(data.value)) throw new UserError('循环模式无效。');
        if (data.action === 'remove' && !Number.isInteger(data.value)) throw new UserError('队列序号无效。');
        if (data.action === 'move' && (!data.value || typeof data.value !== 'object')) throw new UserError('移动序号无效。');
        record(await player.control(data.action, data.value, { checkState: authorize, actorName: actor?.name || (actor?.siteAdmin ? '站点管理者' : '控制台') })); break;
      }
      case '/api/settings':
        if (typeof data.stayConnected !== 'boolean') throw new UserError('常驻设置无效。');
        record(await player.control('stay', data.stayConnected, { checkState: authorize, actorName: actor?.name || '房主' })); break;
      case '/api/account/qr': {
        if (source === 'qq') {
          if (!['qq', 'wx'].includes(data.type ?? 'qq')) throw new UserError('请选择 QQ 或微信扫码。');
          return this.provider(source).qrCreate(data.type ?? 'qq');
        }
        if (this.config.cookie) throw new UserError('请先清空服务器的 NETEASE_COOKIE 配置，再使用扫码登录。');
        const key = (await this.provider(source).call('login_qr_key', { cookie: '' })).data?.unikey;
        if (!key) throw new UserError('生成二维码失败。');
        const created = await this.provider(source).call('login_qr_create', { key, cookie: '' });
        const image = await QRCode.toDataURL(created.data.qrurl, { width: 300, margin: 3 });
        this.qr = { key, image, expires: Date.now() + 180000, status: 'waiting', checkedAt: 0 };
        return { image, expires: this.qr.expires };
      }
      case '/api/account/logout':
        if (source === 'qq') { await this.provider(source).logout(); this.clearAccountCache(source); this.diagnostics?.invalidateAccount(source, false); this.record('QQ 音乐账号已退出'); break; }
        if (this.config.cookie) throw new UserError('账号由环境变量配置，需先在服务器清空 NETEASE_COOKIE。');
        await unlink(path.join(this.config.dataDir, 'netease-cookie.json')).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        this.clearAccountCache(); this.diagnostics?.invalidateAccount(source, false); this.qr = null; this.record('网易云账号已退出'); break;
      default: throw new UserError('接口不存在。');
    }
    return { ok: true };
  }
  async qrStatus() {
    const qr = this.qr;
    if (!qr) return { status: 'none' };
    if (qr.status === 'success') return { status: 'success' };
    if (Date.now() > qr.expires) return { status: 'expired' };
    if (Date.now() - qr.checkedAt < 2500) return { status: qr.status };
    if (qr.pending) return qr.pending;
    qr.checkedAt = Date.now();
    qr.pending = (async () => {
      const result = await this.provider('netease').call('login_qr_check', { key: qr.key, cookie: '' }, [800, 801, 802, 803]);
      if (this.qr !== qr) return { status: 'expired' };
      if (result.code === 803) {
        if (!result.cookie) throw new UserError('登录未返回凭据，请重新扫码。');
        await this.writeCredential(path.join(this.config.dataDir, 'netease-cookie.json'), { cookie: result.cookie });
        qr.status = 'success';
        this.diagnostics?.invalidateAccount('netease', true);
        this.clearAccountCache(); this.record('网易云扫码登录成功');
      } else qr.status = ({ 800: 'expired', 801: 'waiting', 802: 'scanned' })[result.code];
      return { status: qr.status };
    })();
    try { return await qr.pending; } finally { qr.pending = null; }
  }
  async static(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let decoded; try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
    const query = new URL(req.url, 'http://localhost').search;
    const consolePage = decoded === '/admin/console' || decoded === '/admin/console/';
    if (this.accessControlled && decoded === '/index.html') {
      res.writeHead(302, { Location: `/admin/console${query}`, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (this.accessControlled && consolePage) {
      const actor = this.access.get(this.identityToken(req));
      const mayManage = actor && (actor.siteAdmin || this.bots().some((bot) => ['dj', 'owner'].includes(this.access.role(actor.id, bot.id))));
      if (!mayManage) {
        const returnTo = `/admin/console${query}`;
        res.writeHead(302, { Location: `/admin?${new URLSearchParams({ returnTo })}`, 'Cache-Control': 'no-store' }); return res.end();
      }
    }
    const portal = this.accessControlled && decoded === '/' || decoded === '/rooms' || decoded === '/rooms/' || /^\/room\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/?$/.test(decoded);
    const relative = portal ? 'rooms.html' : consolePage || decoded === '/' ? 'index.html' : decoded === '/admin' || decoded === '/admin/' ? 'admin.html' : decoded.replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || relative.split(/[\\/]/).some((x) => x.startsWith('.')) || !mime[path.extname(file)]) { res.writeHead(404); return res.end(); }
    let info; try { info = await stat(file); } catch { res.writeHead(404); return res.end(); }
    if (!info.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Content-Length': info.size,
      'Cache-Control': ['.html', '.css', '.js'].includes(path.extname(file)) ? 'no-cache' : 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}
