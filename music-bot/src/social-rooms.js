import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJson, UserError } from './util.js';

const ranks = { guest: 0, member: 1, dj: 2, owner: 3 };
const themes = new Set(['bamboo', 'blossom', 'night']);
const plain = (value, length = 160) => String(value || '').replace(/[\x00-\x1f\x7f]/g, '').replace(/https?:\/\/\S+/gi, '[链接]').slice(0, length);
const duration = (track) => Number.isFinite(track?.durationMs) && track.durationMs > 0 ? track.durationMs / 1000 : null;
const actions = { pause: '暂停了播放', resume: '恢复了播放', skip: '切换了下一首', previous: '切换了上一首', volume: '调整了音量', loop: '调整了循环模式',
  stop: '停止了播放', remove: '移除了待播歌曲', clear: '清空了待播歌曲', seek: '调整了播放进度', move: '调整了队列顺序', shuffle: '随机排列了队列', stay: '调整了频道常驻设置' };
const memberControls = new Set(['pause', 'resume', 'previous', 'skip', 'volume', 'loop', 'seek', 'clear', 'shuffle']);
const interruptingControls = new Set(['pause', 'resume', 'previous', 'skip', 'seek', 'clear']);

export class SocialRooms {
  constructor({ config, manager, music, access, now = Date.now }) {
    Object.assign(this, { config, manager, music, access, now });
    this.file = path.join(config.dataDir, 'social-rooms.json');
    this.profiles = {}; this.events = {}; this.presence = new Map(); this.voice = new Map(); this.bindings = new Map();
    this.pending = new Map(); this.controlPending = new Set(); this.cooldowns = new Map(); this.tail = Promise.resolve(); this.closed = false;
    this.reads = new Set();
  }
  text(value, limit = 160) { return plain(this.manager.publicText?.(value) ?? value, limit)
    .replace(/\b[0-9]+\/[A-Za-z0-9+/=]{6,}\/[A-Za-z0-9+/=]{8,}/g, '[凭据已隐藏]')
    .replace(/\b(?:MUSIC_U|MUSIC_A|uin|qm_keyst|qqmusic_key|cookie|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '[凭据已隐藏]'); }
  async init() {
    let stored;
    try { stored = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('房间资料文件无法读取，请先备份 social-rooms.json。'); }
    if (stored !== undefined) {
      if (stored.version !== 1 || !stored.profiles || !stored.events || Array.isArray(stored.profiles) || Array.isArray(stored.events)) throw new Error('房间资料文件格式无效。');
      for (const [id, profile] of Object.entries(stored.profiles)) if (this.validBotId(id)) this.profiles[id] = this.profileInput(profile);
      for (const [id, events] of Object.entries(stored.events)) if (this.validBotId(id) && Array.isArray(events)) this.events[id] = events.slice(-100)
        .filter((event) => event && Number.isFinite(event.time) && typeof event.id === 'string')
        .map((event) => ({ id: this.text(event.id, 64), time: event.time, kind: this.text(event.kind, 30), actorName: this.text(event.actorName, 60), message: this.text(event.message, 200) }));
    }
    return this;
  }
  validBotId(id) { return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id); }
  serialize(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  save() { return atomicJson(this.file, { version: 1, profiles: this.profiles, events: this.events }); }
  profileInput(input) {
    if (!input || typeof input.title !== 'string' || input.title.length > 60 || typeof input.description !== 'string' || input.description.length > 300 || !themes.has(input.theme)) throw new UserError('房间名称最多 60 字，介绍最多 300 字，请选择有效主题。');
    return { title: this.text(input.title, 60).trim(), description: this.text(input.description, 300).trim(), theme: input.theme };
  }
  start() {
    if (this.closed) throw new UserError('房间服务正在关闭。');
    this.bindAll();
    if (!this.unsubscribeManager) this.unsubscribeManager = this.manager.subscribe?.(({ kind, runtime }) => {
      if (kind === 'ready') this.bind(runtime);
      if (kind === 'stopping') this.unbind(runtime.id);
    });
    if (!this.timer) { this.timer = setInterval(() => { this.prune(); this.bindAll(); }, 15000); this.timer.unref?.(); }
    return this;
  }
  bindAll() { for (const runtime of this.manager.runtimes?.values() || []) if (runtime.status === 'ready') this.bind(runtime); }
  bind(runtime) {
    if (this.closed || this.manager.closed || runtime.status !== 'ready' || !runtime.player?.subscribe || this.bindings.get(runtime.id)?.player === runtime.player) return;
    this.unbind(runtime.id);
    const unsubscribe = runtime.player.subscribe((event) => this.playerEvent(runtime.id, event));
    this.bindings.set(runtime.id, { player: runtime.player, unsubscribe });
  }
  unbind(id) {
    this.bindings.get(id)?.unsubscribe(); this.bindings.delete(id); this.voice.delete(id);
    for (const read of this.reads) if (read.botId === id) read.cancel();
  }
  async read(botId, operation) {
    let record;
    const aborted = new Promise((_, reject) => {
      record = { botId, cancel: () => reject(new UserError('机器人或房间服务正在关闭。')) }; this.reads.add(record);
      if (this.closed) record.cancel();
    });
    try { const value = await Promise.race([operation, aborted]); if (this.closed) throw new UserError('房间服务正在关闭。'); return value; }
    finally { this.reads.delete(record); }
  }
  playerEvent(botId, event) {
    if (this.closed || this.manager.closed || !this.bindings.has(botId) || this.manager.get(botId).status !== 'ready') return;
    if (event.kind === 'request') {
      const requester = this.requester(event.tracks[0]);
      this.record(botId, { kind: 'request', actorName: requester.name, message: `加入了 ${event.tracks.length} 首歌曲${event.tracks.length === 1 ? `：${event.tracks[0].name}` : ''}` });
    } else if (event.kind === 'withdraw') this.record(botId, { kind: 'withdraw', actorName: this.requester(event.track).name, message: `撤回了待播歌曲：${event.track.name}` });
    else if (event.kind === 'playing') this.record(botId, { kind: 'playing', actorName: '机器人', message: `正在播放：${event.track.name}` });
    else if (event.kind === 'join' || event.kind === 'leave') this.record(botId, { kind: event.kind, actorName: '机器人', message: event.kind === 'join' ? '进入了语音频道' : '离开了语音频道' });
    else if (event.kind === 'leave_pending') this.record(botId, { kind: event.kind, actorName: '机器人', message: '播放已停止，退出语音频道尚未确认。' });
    else if (event.kind === 'control' && actions[event.action]) this.record(botId, { kind: 'control', actorName: event.actorName || (event.automated ? '定时计划' : '控制台'), message: actions[event.action] });
  }
  record(botId, event) {
    if (this.closed || !this.validBotId(botId)) return;
    const entry = { id: randomUUID(), time: this.now(), kind: this.text(event.kind, 30), actorName: this.text(event.actorName || '系统', 60), message: this.text(event.message, 200) };
    if (!this.events[botId]) this.events[botId] = [];
    this.events[botId].push(entry); this.events[botId] = this.events[botId].slice(-100);
    void this.serialize(() => this.save()).catch(() => {});
    return entry;
  }
  identity(actorId, botId) {
    const actor = actorId ? this.access.actor(actorId) : null;
    const role = actor ? this.access.role(actor.id, botId) : 'guest', rank = ranks[role] || 0;
    return { actor: actor ? { id: actor.id, name: this.text(actor.name, 60), siteAdmin: Boolean(actor.siteAdmin) } : null, role,
      permissions: { request: rank >= 1, withdrawOwn: rank >= 1, playbackControl: rank >= 1, control: rank >= 2, manageRoom: rank >= 3, manageRoles: rank >= 3, manageSite: Boolean(actor?.siteAdmin) } };
  }
  runtime(botId) {
    if (this.closed) throw new UserError('房间服务正在关闭。');
    if (!this.validBotId(botId)) throw new UserError('房间标识无效。');
    const runtime = this.manager.get(botId); this.bind(runtime); return runtime;
  }
  requester(track) {
    const who = String(track?.requestedBy || '');
    if (who.startsWith('room:')) return { id: who.slice(5), name: this.text(track.requestedByName || '网页成员', 60), kind: 'web', verified: false };
    if (/^[1-9]\d{0,29}$/.test(who)) return { id: who, name: this.text(track.requestedByName || 'KOOK 成员', 60), kind: 'kook', verified: true };
    return { name: who === 'auto-radio' ? '自动电台' : who.startsWith('schedule:') ? '定时计划' : '控制台', kind: 'system', verified: false };
  }
  queueState(player, actorId) {
    if (!player) return { player: null, queue: [], mine: [] };
    const snapshot = player.snapshot();
    const own = (track) => Boolean(actorId && track?.requestedBy === `room:${actorId}`);
    let waitNotice = snapshot.status === 'paused' ? '播放已暂停，暂无法估算等待时间。' : snapshot.mode === 'one' ? '当前歌曲单曲循环，暂无法估算等待时间。' : snapshot.current && snapshot.status !== 'playing' ? '播放正在恢复或等待，暂无法估算等待时间。' : '';
    let remaining = snapshot.current ? duration(snapshot.current) : 0;
    if (remaining === null) waitNotice ||= '歌曲时长不完整，暂无法估算等待时间。';
    else remaining = Math.max(0, remaining - (snapshot.seconds || 0));
    const queue = snapshot.queue.map((track, index) => {
      if (duration(track) === null) waitNotice ||= '歌曲时长不完整，暂无法估算等待时间。';
      const seconds = waitNotice ? null : Math.max(0, Math.round(remaining));
      const entry = { entryId: track.entryId, track: { ...track }, requester: this.requester(track), mine: own(track), position: index + 1,
        ahead: index + (snapshot.current ? 1 : 0), waitSeconds: seconds, waitNotice: waitNotice || '仅按当前队列估算，切歌或插播后会变化。' };
      const length = duration(track); if (length === null) waitNotice ||= '前方歌曲时长不完整，暂无法估算等待时间。';
      else if (remaining !== null) remaining += length;
      return entry;
    });
    const { queue: waiting, ...state } = snapshot;
    return { player: { ...state, queueCount: waiting.length, current: snapshot.current ? { ...snapshot.current, requester: this.requester(snapshot.current), mine: own(snapshot.current) } : null }, queue, mine: queue.filter((entry) => entry.mine) };
  }
  prune() {
    for (const [botId, members] of this.presence) {
      for (const [id, member] of members) if (this.now() - member.seen >= 60000 || !this.access.actor(id)) {
        members.delete(id); this.record(botId, { kind: 'web_leave', actorName: member.name, message: '离开了网页房间' });
      }
      if (!members.size) this.presence.delete(botId);
    }
    for (const [key, time] of this.cooldowns) if (this.now() - time > 60000) this.cooldowns.delete(key);
  }
  async heartbeat(botId, actorId) {
    this.runtime(botId); this.prune(); const actor = this.access.actor(actorId);
    if (!actor) throw new UserError('请刷新页面后重新进入房间。');
    if (!this.presence.has(botId)) this.presence.set(botId, new Map());
    const members = this.presence.get(botId), first = !members.has(actor.id);
    members.set(actor.id, { name: this.text(actor.name || '访客', 60), seen: this.now() });
    if (first) this.record(botId, { kind: 'web_join', actorName: actor.name || '访客', message: '进入了网页房间' });
    return { present: true, expiresAt: this.now() + 60000 };
  }
  async voiceMembers(runtime) {
    const context = runtime.player?.context;
    if (!context || runtime.status !== 'ready') return { voice: [], voiceCount: context ? null : 0, voiceCheckedAt: null, voiceError: context ? '机器人暂不可用，语音成员未知。' : '', voiceStale: false, voiceLoading: false };
    const roomKey = `${context.guildId}:${context.voiceChannelId}`;
    let cache = this.voice.get(runtime.id);
    if (!cache || cache.roomKey !== roomKey || cache.api !== runtime.api) { cache = { roomKey, api: runtime.api, items: [], checkedAt: null, attemptedAt: null, error: '', pending: null }; this.voice.set(runtime.id, cache); }
    if (!cache.pending && (cache.attemptedAt === null || this.now() - cache.attemptedAt >= 30000)) {
      cache.attemptedAt = this.now();
      cache.pending = (async () => {
        try {
          const response = await this.read(runtime.id, runtime.api.request('channel/user-list', { channel_id: context.voiceChannelId }));
          const list = Array.isArray(response) ? response : response?.items;
          if (!Array.isArray(list)) throw new Error('Invalid voice members');
          if (this.closed || this.voice.get(runtime.id) !== cache || runtime.player?.context?.voiceChannelId !== context.voiceChannelId) return;
          const unique = new Map();
          for (const member of list) if (member && /^[1-9]\d{0,29}$/.test(String(member.id || ''))) unique.set(String(member.id), { id: String(member.id), name: this.text(member.nickname || member.username || 'KOOK 成员', 60), bot: Boolean(member.bot) });
          if (cache.checkedAt !== null) {
            const previous = new Map(cache.items.filter((member) => !member.bot).map((member) => [member.id, member]));
            for (const member of unique.values()) if (!member.bot && !previous.has(member.id)) this.record(runtime.id, { kind: 'voice_join', actorName: member.name, message: '进入了 KOOK 语音频道' });
            for (const member of previous.values()) if (!unique.has(member.id)) this.record(runtime.id, { kind: 'voice_leave', actorName: member.name, message: '离开了 KOOK 语音频道' });
          }
          cache.items = [...unique.values()]; cache.checkedAt = this.now(); cache.error = '';
        } catch { if (!this.closed) cache.error = '暂时无法读取 KOOK 语音成员，当前人数未知。'; }
        finally { cache.pending = null; }
      })();
    }
    if (this.voice.get(runtime.id) !== cache || runtime.player?.context?.voiceChannelId !== context.voiceChannelId) return { voice: [], voiceCount: null, voiceCheckedAt: null, voiceError: '频道已变化，请稍后刷新。', voiceStale: false, voiceLoading: false };
    return { voice: structuredClone(cache.items), voiceCount: cache.error || cache.checkedAt === null ? null : cache.items.filter((member) => !member.bot).length,
      voiceCheckedAt: cache.checkedAt, voiceError: cache.error, voiceStale: Boolean((cache.error || cache.pending) && cache.checkedAt !== null), voiceLoading: Boolean(cache.pending) };
  }
  async room(botId, actorId) {
    const runtime = this.runtime(botId); this.prune(); const descriptor = this.manager.describe(runtime);
    const voice = await this.voiceMembers(runtime), identity = this.identity(actorId, botId);
    if (this.closed || this.manager.closed || this.manager.get(botId) !== runtime) throw new UserError('机器人或房间服务正在关闭。');
    const web = [...(this.presence.get(botId) || new Map())].map(([id, member]) => ({ id, name: member.name, role: this.access.role(id, botId), isSelf: id === actorId, verified: false }));
    return { botId, name: descriptor.name, online: descriptor.online, status: descriptor.status,
      profile: { title: descriptor.name, description: '一起分享喜欢的音乐', theme: 'bamboo', ...this.profiles[botId] },
      ...this.queueState(runtime.player, actorId), members: { web, webCount: web.length, ...voice }, events: structuredClone((this.events[botId] || []).slice(-100)), ...identity };
  }
  async lobby(actorId) {
    this.prune();
    return Promise.all(this.manager.list().map(async (bot) => {
      const runtime = this.runtime(bot.id), voice = await this.voiceMembers(runtime), identity = this.identity(actorId, bot.id);
      const snapshot = runtime.player?.snapshot(), current = snapshot?.current;
      return { botId: bot.id, name: bot.name, online: bot.online, status: bot.status,
        profile: { title: bot.name, description: '一起分享喜欢的音乐', theme: 'bamboo', ...this.profiles[bot.id] },
        role: identity.role, permissions: identity.permissions, queueCount: snapshot?.queue.length || 0,
        player: snapshot ? { current: current ? { ...current, requester: this.requester(current), mine: current.requestedBy === `room:${actorId}` } : null,
          status: snapshot.status, seconds: snapshot.seconds, volume: snapshot.volume, context: snapshot.context, connected: snapshot.connected, queueCount: snapshot.queue.length } : null,
        members: { webCount: this.presence.get(bot.id)?.size || 0, voiceCount: voice.voiceCount, voiceCheckedAt: voice.voiceCheckedAt, voiceError: voice.voiceError, voiceStale: voice.voiceStale, voiceLoading: voice.voiceLoading } };
    }));
  }
  async updateProfile(botId, actorId, data) {
    this.runtime(botId); this.access.require(actorId, botId, 'owner'); const profile = this.profileInput(data);
    return this.serialize(async () => {
      this.runtime(botId); this.access.require(actorId, botId, 'owner'); const previous = this.profiles[botId]; this.profiles[botId] = profile;
      try { await this.save(); } catch (error) { if (previous) this.profiles[botId] = previous; else delete this.profiles[botId]; throw error; }
      return { ...profile };
    });
  }
  async request(botId, actorId, input) {
    const runtime = this.runtime(botId), actor = this.access.require(actorId, botId, 'member');
    if (runtime.status !== 'ready' || !runtime.player?.context) throw new UserError('机器人尚未进入语音频道，请联系房主。');
    if (!input || typeof input.input !== 'string') throw new UserError('请输入歌曲或歌单链接。');
    const key = `${botId}:${actor.id}`;
    if (this.pending.has(key)) throw new UserError('上一条点歌正在处理，请稍候。');
    if (this.now() - (this.cooldowns.get(key) ?? -Infinity) < 2000) throw new UserError('点歌过于频繁，请稍后再试。');
    if (input.maxItems !== undefined && (!Number.isInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 500)) throw new UserError('导入数量范围为 1-500。');
    const player = runtime.player, context = { ...player.context }, epoch = player.operationEpoch;
    if (input.expectedVoiceChannelId !== undefined && input.expectedVoiceChannelId !== context.voiceChannelId) throw new UserError('房间频道已变化，请刷新后重试。');
    const role = this.access.role(actor.id, botId), memberLimit = runtime.features?.rules.enabled ? runtime.features.rules.perUserLimit : 5;
    const quota = ranks[role] >= 2 ? player.capacity() : Math.max(0, memberLimit - [player.current, ...player.queue].filter((track) => track?.requestedBy === `room:${actor.id}`).length);
    const limit = Math.min(input.maxItems ?? 500, player.capacity(), quota);
    if (!limit) throw new UserError('已达到个人点歌上限，或房间队列已满。');
    this.cooldowns.set(key, this.now());
    const job = (async () => {
      const parsed = await this.read(botId, this.music.parseInput(input.input, { source: input.source || 'netease', kind: input.kind }));
      const tracks = parsed.kind === 'playlist' ? await this.read(botId, this.music.playlist(parsed.id, limit, parsed.source))
        : [await this.read(botId, this.music.resolve(parsed.id || parsed.query || parsed.input, parsed.source))];
      const received = [];
      const added = await player.add(context, tracks.slice(0, limit), { expectedVoiceChannelId: context.voiceChannelId, expectedEpoch: epoch,
          onAdded: (accepted) => received.push(...accepted),
          checkState: () => !this.closed && !this.manager.closed && runtime.status === 'ready' && runtime.player === player,
          authorize: () => {
            const current = this.access.require(actor.id, botId, 'member'), currentRole = this.access.role(actor.id, botId);
            const rules = runtime.features?.rules, maximum = ranks[currentRole] >= 2 ? 500 : rules?.enabled ? rules.perUserLimit : 5;
            return { requestedBy: `room:${current.id}`, requestedByName: this.text(current.name || '网页成员', 60),
              policy: { userId: `room:${current.id}`, perUserLimit: maximum, preventDuplicates: Boolean(rules?.enabled && rules.preventDuplicates) } };
          } });
      const entries = this.queueState(player, actor.id).queue.filter((entry) => received.some((track) => track.entryId === entry.entryId));
      return { added, entries, notice: parsed.kind === 'playlist' ? `已按个人额度和房间容量加入 ${added} 首。` : `已加入 ${added} 首歌曲。` };
    })();
    this.pending.set(key, job);
    try { return await job; } finally { this.pending.delete(key); }
  }
  async withdraw(botId, actorId, entryId) {
    const runtime = this.runtime(botId); this.access.require(actorId, botId, 'member');
    if (runtime.status !== 'ready' || !runtime.player) throw new UserError('机器人暂不可用。');
    const player = runtime.player, epoch = player.operationEpoch, room = player.context?.voiceChannelId;
    await player.removeEntry(entryId, { expectedEpoch: epoch, expectedVoiceChannelId: room, authorize: (track) => {
      this.access.require(actorId, botId, 'member');
      if (this.closed || runtime.status !== 'ready' || runtime.player !== player || track.requestedBy !== `room:${actorId}`) throw new UserError('只能撤回自己的待播歌曲。');
      return true;
    } });
    return { removed: entryId };
  }
  async control(botId, actorId, input) {
    const runtime = this.runtime(botId), actor = this.access.require(actorId, botId, 'member');
    if (!input || typeof input !== 'object' || Array.isArray(input) || !memberControls.has(input.action)) throw new UserError('用户房间不支持此操作。');
    const { action, value, expectedVoiceChannelId } = input;
    if (action === 'volume') {
      if (!Number.isInteger(value) || value < 0 || value > 100) throw new UserError('音量范围为 0-100 的整数。');
    } else if (action === 'loop') {
      if (!['off', 'one', 'all'].includes(value)) throw new UserError('循环模式无效。');
    } else if (action === 'seek') {
      if (!Number.isFinite(value) || value < 0) throw new UserError('播放位置无效。');
    } else if (value !== undefined) throw new UserError('此播放操作不需要额外参数。');
    if (runtime.status !== 'ready' || !runtime.player?.context) throw new UserError('机器人尚未进入语音频道，请联系房主。');
    const player = runtime.player, context = { ...player.context };
    if (typeof expectedVoiceChannelId !== 'string' || !expectedVoiceChannelId || expectedVoiceChannelId !== context.voiceChannelId) throw new UserError('房间频道已变化，请刷新后重试。');
    if (this.controlPending.has(botId)) throw Object.assign(new UserError('房间正在处理上一项播放操作，请稍后再试。'), { statusCode: 409 });
    // Player increments manual interruptions synchronously before taking its lock.
    // Include our own increment while rejecting any later stop or channel change.
    const expectedEpoch = player.operationEpoch + (interruptingControls.has(action) ? 1 : 0);
    const checkState = () => !this.closed && !this.manager.closed && runtime.status === 'ready' &&
      this.manager.get(botId) === runtime && runtime.player === player && !player.closed &&
      player.operationEpoch === expectedEpoch && player.context?.guildId === context.guildId &&
      player.context?.voiceChannelId === context.voiceChannelId;
    this.controlPending.add(botId);
    try {
      const message = await player.control(action, value, { expectedEpoch, expectedVoiceChannelId, checkState,
        actorName: this.text(actor.name || '网页成员', 60), authorize: () => {
          this.access.require(actor.id, botId, 'member');
          if (!checkState()) throw new UserError('房间状态已变化，请刷新后重试。');
        } });
      return { message };
    } finally { this.controlPending.delete(botId); }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.unsubscribeManager?.();
    for (const read of this.reads) read.cancel();
    for (const id of this.bindings.keys()) this.unbind(id);
    await this.tail;
  }
}
