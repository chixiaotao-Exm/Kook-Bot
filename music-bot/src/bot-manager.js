import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Kook } from './kook.js';
import { Gateway } from './gateway.js';
import { PersistentAudio } from './audio-session.js';
import { Player } from './player.js';
import { Bot, parseCommand } from './bot.js';
import { RoomFeatures } from './room-features.js';
import { atomicJson, log, sleep, UserError } from './util.js';

const connectionError = '机器人连接失败，请检查 Token、网络和 KOOK 权限后重试。';
const duplicateError = '此 KOOK 机器人已添加，不能重复使用同一个机器人账号。';
const validId = (id) => typeof id === 'string' && /^[1-9]\d{0,29}$/.test(id);
const validGuildInput = (id) => typeof id === 'string' && /^\d{1,30}$/.test(id);
const guildListError = '无法读取机器人已加入的 KOOK 服务器，请检查网络与权限后重试。';
class GuildConfigurationError extends UserError {}
const safeError = (error) => error instanceof GuildConfigurationError ? error.message :
  error instanceof UserError && error.message === duplicateError ? duplicateError : connectionError;
const apiId = (value) => (typeof value === 'string' || Number.isSafeInteger(value)) && validId(String(value)) ? String(value) : null;

export class BotManager {
  constructor(config, music, dependencies = {}) {
    Object.assign(this, { config, music });
    this.dependencies = {
      createApi: (token) => new Kook(token),
      createAudio: (cfg) => new PersistentAudio(cfg.ffmpeg),
      createPlayer: (...args) => new Player(...args),
      createBot: (...args) => new Bot(...args),
      createGateway: (...args) => new Gateway(...args),
      createFeatures: (options) => new RoomFeatures(options),
      sleep, ...dependencies,
    };
    this.file = path.join(config.dataDir, 'bots.json');
    this.runtimes = new Map(); this.definitions = []; this.tail = Promise.resolve();
    this.owners = new Map(); this.claims = new Map(); this.closed = false;
    this.listeners = new Set();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) { try { listener(event); } catch { log('manager_observer_failed'); } } }
  exclusive(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  assertOpen() { if (this.closed) throw new UserError('机器人管理服务正在关闭。'); }
  definition(input, id = randomUUID()) {
    if (!input || typeof input.token !== 'string' || !input.token.trim() || input.token.length > 1024 || /\s/.test(input.token.trim())) {
      throw new UserError('请填写有效的 KOOK Bot Token。');
    }
    const guildIds = input.guildIds === undefined ? [...this.config.guilds] : input.guildIds;
    if (!Array.isArray(guildIds) || !guildIds.length || guildIds.length > 100 || !guildIds.every(validGuildInput)) {
      throw new UserError('服务器 ID 需要填写数字 ID，至少填写一个。');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new UserError('机器人备注最多 60 个字，不能包含控制字符。');
    return { id, token: input.token.trim(), name, guildIds: [...new Set(guildIds)] };
  }
  runtime(definition, managed) {
    const config = { ...this.config, token: definition.token,
      guilds: new Set(definition.guildIds), textChannels: new Set(this.config.textChannels), admins: new Set(this.config.admins),
      dataDir: managed ? path.join(this.config.dataDir, 'bots', definition.id) : this.config.dataDir };
    const runtime = { id: definition.id, name: definition.name, managed, config,
      api: null, self: null, player: null, gateway: null, bot: null,
      status: 'starting', error: '', leases: new Set(), definition };
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }
  async init() {
    return this.exclusive(async () => {
      this.assertOpen();
      if (this.runtimes.size) return;
      let stored;
      try { stored = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('多机器人配置无法读取，请检查 data/bots.json。'); }
      if (stored !== undefined) {
        if (stored.version !== 1 || !Array.isArray(stored.bots)) throw new Error('多机器人配置格式无效。');
        const ids = new Set();
        this.definitions = stored.bots.map((entry) => {
          if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id)) throw new Error('多机器人配置标识无效。');
          ids.add(entry.id);
          return { ...this.definition(entry, entry.id), ...(validId(entry.botId) ? { botId: entry.botId } : {}) };
        });
      }
      const main = this.runtime({ id: 'default', name: '', token: this.config.token, guildIds: [...this.config.guilds] }, false);
      const additional = this.definitions.map((definition) => this.runtime(definition, true));
      this.initializing = true;
      try {
        await this.start(main);
        for (const runtime of additional) await this.start(runtime);
      } finally { this.initializing = false; }
    });
  }
  get(id = 'default') {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new UserError('找不到这个机器人，请重新选择。');
    return runtime;
  }
  publicText(value) {
    let result = String(value || '');
    for (const secret of [this.config.token, ...this.definitions.map((item) => item.token)]) {
      if (secret) result = result.split(secret).join('***');
    }
    return result;
  }
  describe(runtime) {
    const context = runtime.player?.context;
    return { id: runtime.id, name: this.publicText(runtime.name || runtime.self?.username || '音乐机器人'),
      username: this.publicText(runtime.self?.username || ''),
      online: runtime.status === 'ready' && Boolean(runtime.gateway?.ready), status: runtime.status,
      error: runtime.error, managed: runtime.managed, guildIds: [...runtime.config.guilds],
      context: context ? { guildId: context.guildId, voiceChannelId: context.voiceChannelId, textChannelId: context.textChannelId } : null,
      playing: Boolean(runtime.player?.stream && !runtime.player.stream.paused) };
  }
  list() { return [...this.runtimes.values()].map((runtime) => this.describe(runtime)); }
  async withBot(id, fn) {
    this.assertOpen();
    const runtime = this.get(id);
    if (['starting', 'stopping'].includes(runtime.status)) throw new UserError('机器人正在连接或关闭，请稍后重试。');
    const operation = Promise.resolve().then(() => fn(runtime));
    runtime.leases.add(operation);
    try { return await operation; } finally { runtime.leases.delete(operation); }
  }
  assertIdentity(runtime, self) {
    if (!self || !validId(String(self.id || ''))) throw new UserError(connectionError);
    for (const other of this.runtimes.values()) {
      // The .env bot has precedence over not-yet-started definitions. Failed
      // additional bots retain their durable account reservation across retries.
      if (runtime.id === 'default' && !other.self) continue;
      const reservedId = other.self?.id || (runtime.id !== 'default' ? other.definition?.botId : '');
      if (other.id !== runtime.id && (other.config.token === runtime.config.token || String(reservedId || '') === String(self.id))) {
        throw new UserError(duplicateError);
      }
    }
    if (runtime.id !== 'default' && runtime.config.token === this.config.token) throw new UserError(duplicateError);
  }
  async identify(runtime) {
    runtime.api = this.dependencies.createApi(runtime.config.token);
    const self = await runtime.api.request('user/me');
    this.assertIdentity(runtime, self);
    runtime.self = self;
    return self;
  }
  async normalizeGuilds(runtime, persist = false) {
    if (!runtime.managed) return;
    const byId = new Map(), byOpenId = new Map();
    let finished = false;
    for (let page = 1; page <= 100; page++) {
      this.assertOpen();
      let result;
      try { result = await runtime.api.request('guild/list', { page, page_size: 50 }); }
      catch { throw new GuildConfigurationError(guildListError); }
      this.assertOpen();
      if (!Array.isArray(result?.items)) throw new GuildConfigurationError(guildListError);
      for (const guild of result.items) {
        const id = apiId(guild.id);
        const openId = (typeof guild.open_id === 'string' || Number.isSafeInteger(guild.open_id)) && validGuildInput(String(guild.open_id)) ? String(guild.open_id) : null;
        if (!id) throw new GuildConfigurationError(guildListError);
        byId.set(id, id);
        if (openId) {
          if (!byOpenId.has(openId)) byOpenId.set(openId, new Set());
          byOpenId.get(openId).add(id);
        }
      }
      const total = result.meta?.page_total;
      if (total !== undefined && (!Number.isInteger(total) || total < 0 || total > 100 ||
          (result.meta?.page !== undefined && result.meta.page !== page))) throw new GuildConfigurationError(guildListError);
      if (total !== undefined ? page >= total : result.items.length < 50) { finished = true; break; }
      if (!result.items.length) throw new GuildConfigurationError(guildListError);
    }
    if (!finished) throw new GuildConfigurationError(guildListError);
    const guildIds = [...new Set(runtime.definition.guildIds.map((input) => {
      if (byId.has(input)) return input;
      const matches = byOpenId.get(input);
      if (!matches?.size) throw new GuildConfigurationError('机器人尚未加入所填服务器，或服务器 ID 不正确。请先邀请机器人，再填写服务器公开 ID 或开发者 ID（不是语音频道 ID）。');
      if (matches.size !== 1) throw new GuildConfigurationError('公开服务器 ID 匹配到多个服务器，请改填开发者模式下复制的服务器 ID。');
      return [...matches][0];
    }))];
    if (guildIds.length === runtime.definition.guildIds.length && guildIds.every((id, i) => id === runtime.definition.guildIds[i])) return;
    const definition = { ...runtime.definition, guildIds };
    if (persist) {
      const definitions = this.definitions.map((item) => item.id === runtime.id ? definition : item);
      await this.persist(definitions); this.definitions = definitions;
    }
    runtime.definition = definition; runtime.config.guilds = new Set(guildIds);
    this.claims.delete(runtime.id);
  }
  async start(runtime, identified = false) {
    runtime.status = 'starting'; runtime.error = '';
    try {
      this.assertOpen();
      if (!identified) {
        await this.identify(runtime);
        await this.normalizeGuilds(runtime, true);
      }
      this.assertOpen();
      // Identity checks must finish before releasing allocations: two different
      // tokens can still refer to the same KOOK bot account.
      const voice = await runtime.api.request('voice/list');
      for (const channel of voice.items || []) await runtime.api.post('voice/leave', { channel_id: channel.id });
      if (voice.items?.length) await this.dependencies.sleep(3000);
      this.assertOpen();
      runtime.stateRestored = false;
      runtime.player = this.dependencies.createPlayer(runtime.config, runtime.api, this.music,
        this.dependencies.createAudio(runtime.config), (channel, message) => runtime.api.reply(channel, message));
      await runtime.player.restore();
      runtime.stateRestored = true;
      runtime.features = this.dependencies.createFeatures({ config: runtime.config, player: runtime.player,
        api: runtime.api, music: this.music, selfId: runtime.self.id });
      await runtime.features.init();
      this.assertOpen();
      if (runtime.player.stayConnected && runtime.player.context) runtime.player.startKeepalive();
      if (runtime.player.stayConnected && runtime.player.context && runtime.player.intent !== 'playing') {
        try { await runtime.player.join(runtime.player.context); }
        catch { runtime.player.startKeepalive(); log('voice_restore_retry', { id: runtime.id }); }
      }
      runtime.bot = this.dependencies.createBot(runtime.config, runtime.api, this.music, runtime.player,
        (event, command) => this.owns(runtime.id, event, command));
      runtime.bot.selfId = runtime.self.id;
      runtime.gateway = this.dependencies.createGateway(runtime.api, (event) => runtime.bot.accept(event));
      this.assertOpen();
      runtime.status = 'ready'; runtime.gateway.start();
      await runtime.player.resumeAfterRestart();
      this.emit({ kind: 'ready', runtime });
      log('bot_started', { id: runtime.id, botId: runtime.self.id });
    } catch (error) {
      await this.stopRuntime(runtime);
      runtime.status = 'error';
      runtime.error = safeError(error);
      log('bot_start_failed', { id: runtime.id });
    }
    return this.describe(runtime);
  }
  persist(definitions = this.definitions) { return atomicJson(this.file, { version: 1, bots: definitions }); }
  add(input) {
    return this.exclusive(async () => {
      this.assertOpen();
      const definition = this.definition(input);
      if (definition.token === this.config.token || this.definitions.some((item) => item.token === definition.token)) throw new UserError(duplicateError);
      const runtime = this.runtime(definition, true);
      try {
        await this.identify(runtime);
        this.assertOpen();
        await this.normalizeGuilds(runtime);
        runtime.definition.botId = String(runtime.self.id);
        const definitions = [...this.definitions, runtime.definition];
        await this.persist(definitions); this.definitions = definitions;
      } catch (error) {
        this.runtimes.delete(runtime.id);
        throw new UserError(safeError(error));
      }
      return this.start(runtime, true);
    });
  }
  async stopRuntime(runtime) {
    runtime.status = 'stopping';
    this.emit({ kind: 'stopping', runtime });
    runtime.gateway?.stop();
    const command = runtime.bot?.stop();
    await runtime.features?.close();
    await Promise.allSettled([...runtime.leases, command]);
    if (runtime.player) {
      if (!runtime.stateRestored) {
        // An unreadable queue must remain untouched. The new player has never
        // played anything, so dispose its timers without checkpointing emptiness.
        runtime.player.closed = true;
        clearInterval(runtime.player.checkpoint); clearInterval(runtime.player.keepalive);
        clearTimeout(runtime.player.idleTimer); clearTimeout(runtime.player.advanceTimer); clearTimeout(runtime.player.retryTimer);
        try { await runtime.player.audio.disconnect?.(); } catch { log('bot_shutdown_failed', { id: runtime.id }); }
      } else {
        try { await runtime.player.shutdown(); }
        catch {
          log('bot_shutdown_failed', { id: runtime.id });
          // A checkpoint write can fail before Player.shutdown releases audio.
          try { await runtime.player.halt(); } catch {}
          try { await runtime.player.releaseVoice(); } catch {}
        }
      }
    }
    runtime.gateway = null; runtime.bot = null; runtime.player = null; runtime.features = null;
    this.claims.delete(runtime.id);
  }
  remove(id) {
    return this.exclusive(async () => {
      this.assertOpen();
      const runtime = this.get(id);
      if (!runtime.managed) throw new UserError('默认机器人由服务器配置管理，不能在控制台删除。');
      await this.stopRuntime(runtime);
      const definitions = this.definitions.filter((item) => item.id !== id);
      try { await this.persist(definitions); }
      catch { runtime.status = 'error'; runtime.error = '配置保存失败，请重试。'; throw new UserError(runtime.error); }
      this.definitions = definitions; this.runtimes.delete(id);
      return { removed: id };
    });
  }
  retry(id) {
    return this.exclusive(async () => {
      this.assertOpen();
      const runtime = this.get(id);
      if (runtime.managed && runtime.status === 'ready' && !runtime.player?.context) {
        runtime.status = 'starting';
        await Promise.allSettled([...runtime.leases, runtime.bot?.draining]);
        if (!runtime.player?.context) {
          try { await this.normalizeGuilds(runtime, true); runtime.error = ''; }
          catch (error) { throw new UserError(safeError(error)); }
          finally { runtime.status = 'ready'; }
          return this.describe(runtime);
        }
      }
      await this.stopRuntime(runtime);
      return this.start(runtime);
    });
  }
  shutdown() {
    this.closed = true;
    return this.exclusive(async () => {
      await Promise.all([...this.runtimes.values()].map((runtime) => this.stopRuntime(runtime)));
      this.owners.clear(); this.claims.clear();
    });
  }
  async owns(id, event, command) {
    if (this.closed || this.initializing) return false;
    const key = `${event.extra?.guild_id}:${event.msg_id}:${event.author_id}`;
    const now = Date.now();
    for (const [key, entry] of this.owners) if (now - entry.time > 600000) this.owners.delete(key);
    let entry = this.owners.get(key);
    if (!entry) {
      entry = { time: now, owner: this.chooseOwner(event, command) };
      this.owners.set(key, entry);
      if (this.owners.size > 2000) this.owners.delete(this.owners.keys().next().value);
    }
    return await entry.owner === id;
  }
  async chooseOwner(event, command) {
    const guildId = event.extra?.guild_id;
    const candidates = [...this.runtimes.values()].filter((runtime) => runtime.status === 'ready' && !runtime.bot?.closed &&
      runtime.config.guilds.has(guildId) && (!runtime.config.textChannels.size || runtime.config.textChannels.has(event.target_id)) &&
      parseCommand(event.extra?.kmarkdown?.raw_content || event.content, runtime.config.prefix));
    candidates.sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id));
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].id;
    let room;
    try {
      const joined = await candidates[0].api.request('channel-user/get-joined-channel', { guild_id: guildId, user_id: event.author_id });
      room = joined.items?.find((item) => item.type === 2)?.id;
    } catch {
      // One responder owns a failed lookup; each gateway must not reply with
      // its own identical error message.
      return candidates[0].id;
    }
    const now = Date.now();
    for (const [botId, claim] of this.claims) {
      const runtime = this.runtimes.get(botId);
      if (!runtime || runtime.status !== 'ready' || runtime.player?.context || now - claim.time > 300000) this.claims.delete(botId);
    }
    const active = candidates.find((runtime) => runtime.player?.context?.guildId === guildId && runtime.player.context.voiceChannelId === room);
    if (active) return active.id;
    const assigned = room && candidates.find((runtime) => {
      const claim = this.claims.get(runtime.id);
      return claim?.guildId === guildId && claim.voiceChannelId === room;
    });
    const routedCommand = command || parseCommand(event.extra?.kmarkdown?.raw_content || event.content, candidates[0].config.prefix);
    const reservesRoom = ['play', 'pick', 'playlist', 'heart', 'hot', 'search'].includes(routedCommand?.action);
    if (assigned) { if (reservesRoom) this.claims.get(assigned.id).time = now; return assigned.id; }
    const idle = candidates.find((runtime) => !runtime.player?.context && !this.claims.has(runtime.id));
    if (idle && room && reservesRoom) this.claims.set(idle.id, { guildId, voiceChannelId: room, time: now });
    // Outside a voice channel, preserve help/search and the ordinary friendly
    // "join a voice channel" error, with exactly one responder.
    return idle?.id || (!room ? candidates[0].id : null);
  }
}
