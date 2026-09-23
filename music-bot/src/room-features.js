import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJson, UserError } from './util.js';

const defaults = {
  radio: { enabled: false, source: 'netease', strategy: 'hot', playlistId: '', lowWatermark: 2, batchSize: 10, avoidRecent: 50 },
  rules: { enabled: false, perUserLimit: 5, preventDuplicates: true, voteSkip: true, voteThreshold: 2, managerIds: [] },
};
const key = (track) => `${track.source || 'netease'}:${track.id}`;
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new UserError(`${label}范围为 ${min}-${max}。`);
  return value;
};
const flag = (value) => { if (typeof value !== 'boolean') throw new UserError('开关值无效。'); return value; };
const source = (value, mixed = false) => {
  if (!(mixed ? ['netease', 'qq', 'mixed'] : ['netease', 'qq']).includes(value)) throw new UserError('音乐平台无效。');
  return value;
};
const playlistId = (value) => {
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw new UserError('歌单 ID 或链接无效。');
  return value.trim();
};
function radioConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('自动电台配置无效。');
  const result = { enabled: flag(input.enabled), source: source(input.source, true), strategy: input.strategy,
    playlistId: playlistId(input.playlistId), lowWatermark: integer(input.lowWatermark, 0, 20, '补歌水位'),
    batchSize: integer(input.batchSize, 1, 50, '每次补歌数量'), avoidRecent: integer(input.avoidRecent, 0, 200, '避免重复数量') };
  if (!['hot', 'playlist', 'acg'].includes(result.strategy)) throw new UserError('自动电台选曲方式无效。');
  if (result.strategy === 'playlist' && (!result.playlistId || result.source === 'mixed')) throw new UserError('指定歌单需要选择单个平台并填写歌单。');
  return result;
}
function rulesConfig(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.managerIds) || input.managerIds.length > 100 ||
      !input.managerIds.every((id) => typeof id === 'string' && /^[1-9]\d{0,29}$/.test(id))) throw new UserError('房间管理员需要填写有效的 KOOK 用户数字 ID。');
  return { enabled: flag(input.enabled), perUserLimit: integer(input.perUserLimit, 1, 500, '每人点歌上限'),
    preventDuplicates: flag(input.preventDuplicates), voteSkip: flag(input.voteSkip),
    voteThreshold: integer(input.voteThreshold, 1, 100, '切歌票数'), managerIds: [...new Set(input.managerIds)] };
}
function scheduleConfig(input) {
  if (!Array.isArray(input) || input.length > 20) throw new UserError('最多设置 20 条定时计划。');
  const ids = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new UserError('定时计划无效。');
    const id = entry.id || randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) throw new UserError('定时计划 ID 无效或重复。');
    ids.add(id);
    if (typeof entry.name !== 'string' || entry.name.length > 60 || /[\x00-\x1f\x7f]/.test(entry.name)) throw new UserError('计划名称最多 60 个字。');
    if (!Array.isArray(entry.days) || !entry.days.length || entry.days.length > 7 || !entry.days.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) throw new UserError('请选择有效的星期。');
    if (typeof entry.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.time)) throw new UserError('时间格式应为 HH:mm。');
    if (typeof entry.timeZone !== 'string' || entry.timeZone.length > 80) throw new UserError('时区无效。');
    try { new Intl.DateTimeFormat('en', { timeZone: entry.timeZone }).format(); } catch { throw new UserError('时区无效，请填写 Asia/Shanghai 等 IANA 时区。'); }
    if (!['playlist', 'hot', 'pause', 'resume', 'volume'].includes(entry.action)) throw new UserError('计划操作无效。');
    const result = { id, name: entry.name.trim(), enabled: flag(entry.enabled), days: [...new Set(entry.days)], time: entry.time,
      timeZone: entry.timeZone, action: entry.action, source: source(entry.source || 'netease'),
      playlistId: playlistId(entry.playlistId || ''), volume: integer(entry.volume ?? 50, 0, 100, '音量') };
    if (result.action === 'playlist' && !result.playlistId) throw new UserError('定时播放歌单需要填写歌单。');
    return result;
  });
}

// One worker per bot. Network reads never hold the player's operation lock;
// guarded mutations reject work started before a room change or manual stop.
export class RoomFeatures {
  constructor({ config, player, api, music, selfId, report = () => {}, now = Date.now, intervalMs = 10000 }) {
    Object.assign(this, { config, player, api, music, selfId, report, now, intervalMs });
    this.file = path.join(config.dataDir, 'room-features.json');
    this.radio = structuredClone(defaults.radio); this.rules = structuredClone(defaults.rules); this.schedules = [];
    this.radioState = { suspended: player.intent === 'paused', lastRunAt: null, lastError: '', recent: [] };
    this.ledger = {}; this.enabledAfter = new Map(); this.tail = Promise.resolve(); this.voteTail = Promise.resolve();
    this.generation = 0; this.configurationEpoch = 0; this.closed = false; this.votes = new Set(); this.voteTrack = null; this.requiredVotes = 0;
    this.pendingReads = new Set();
    this.scheduleJobs = new Map();
  }
  async init() {
    let stored;
    try { stored = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('房间功能配置无法读取，请先备份检查 room-features.json。'); }
    if (stored !== undefined) {
      if (stored?.version !== 1) throw new Error('房间功能配置格式无效。');
      this.radio = radioConfig(stored.radio); this.rules = rulesConfig(stored.rules); this.schedules = scheduleConfig(stored.schedules);
      if (!stored.radioState || typeof stored.radioState.suspended !== 'boolean' || !Array.isArray(stored.radioState.recent) ||
          !stored.radioState.recent.every((item) => typeof item === 'string') || !stored.ledger || typeof stored.ledger !== 'object' || Array.isArray(stored.ledger)) throw new Error('房间运行状态格式无效。');
      this.radioState = { suspended: stored.radioState.suspended || this.player.intent === 'paused', lastRunAt: stored.radioState.lastRunAt || null,
        lastError: '', recent: stored.radioState.recent.slice(-200) };
      for (const rule of this.schedules) {
        const entry = stored.ledger[rule.id];
        if (entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && Number.isFinite(entry.at)) this.ledger[rule.id] = { date: entry.date, at: entry.at, error: '' };
      }
    }
    const minute = Math.floor(this.now() / 60000);
    for (const rule of this.schedules) this.enabledAfter.set(rule.id, minute);
    this.player.features = this;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs); this.timer.unref?.();
    return this;
  }
  setReporter(report) { this.report = report; }
  emit(level, code, message) { if (!this.closed) { try { this.report({ level, code, message }); } catch {} } }
  serialize(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  save() {
    const state = structuredClone({ version: 1, radio: this.radio, rules: this.rules, schedules: this.schedules, radioState: this.radioState, ledger: this.ledger });
    return atomicJson(this.file, state);
  }
  persist() { return this.serialize(() => this.closed ? undefined : this.save()); }
  async read(operation) {
    // Provider requests may outlive a bot being removed. Detach their wait while
    // retaining a rejection handler; none of their results can mutate a closed room.
    let cancel;
    const aborted = new Promise((_, reject) => {
      cancel = () => reject(new UserError('机器人正在关闭。')); this.pendingReads.add(cancel);
      if (this.closed) cancel();
    });
    try {
      const value = await Promise.race([operation, aborted]);
      if (this.closed) throw new UserError('机器人正在关闭。');
      return value;
    } finally { this.pendingReads.delete(cancel); }
  }
  snapshot() {
    this.syncVotes();
    return structuredClone({ radio: { ...this.radio, suspended: this.radioState.suspended, lastRunAt: this.radioState.lastRunAt, lastError: this.radioState.lastError },
      schedules: this.schedules.map((rule) => ({ ...rule, lastRunAt: this.ledger[rule.id]?.at || null, lastError: this.ledger[rule.id]?.error || '' })),
      rules: this.rules, votes: { count: this.votes.size, required: this.requiredVotes, trackId: this.player.current?.id || null } });
  }
  configure(section, data, { authorize } = {}) {
    if (this.closed) return Promise.reject(new UserError('机器人正在关闭。'));
    if (!['radio', 'schedules', 'rules'].includes(section)) return Promise.reject(new UserError('房间设置类型无效。'));
    return this.serialize(async () => {
      const admission = authorize?.();
      if (admission && typeof admission.then === 'function') await admission;
      if (this.closed) throw new UserError('机器人正在关闭。');
      const previous = { radio: this.radio, rules: this.rules, schedules: this.schedules, radioState: structuredClone(this.radioState), ledger: structuredClone(this.ledger), enabledAfter: new Map(this.enabledAfter) };
      if (section === 'radio') {
        this.radio = radioConfig({ ...this.radio, ...data });
        if (this.radio.enabled) { this.radioState.suspended = false; this.radioState.lastError = ''; this.nextRadioAt = 0; }
      } else if (section === 'rules') this.rules = rulesConfig({ ...this.rules, ...data });
      else {
        const before = new Map(this.schedules.map((rule) => [rule.id, JSON.stringify(rule)]));
        this.schedules = scheduleConfig(data);
        for (const rule of this.schedules) if (before.get(rule.id) !== JSON.stringify(rule)) this.enabledAfter.set(rule.id, Math.floor(this.now() / 60000));
        const keep = new Set(this.schedules.map((rule) => rule.id));
        this.ledger = Object.fromEntries(Object.entries(this.ledger).filter(([id]) => keep.has(id)));
        for (const id of this.enabledAfter.keys()) if (!keep.has(id)) this.enabledAfter.delete(id);
      }
      this.generation++; this.configurationEpoch++;
      try { await this.save(); }
      catch (error) { Object.assign(this, previous); throw error; }
      this.votes.clear(); this.requiredVotes = 0; return this.snapshot();
    });
  }
  onControl(action) {
    if (this.closed) return;
    if (['pause', 'stop', 'resume'].includes(action)) {
      this.radioState.suspended = action !== 'resume';
      this.generation++; this.nextRadioAt = 0;
      void this.persist().catch(() => this.emit('error', 'room_save_failed', '房间设置保存失败。'));
    }
  }
  guard() { return { epoch: this.player.operationEpoch, generation: this.generation, configurationEpoch: this.configurationEpoch, context: this.player.context ? { ...this.player.context } : null }; }
  valid(guard) {
    return !this.closed && !this.player.closed && guard.generation === this.generation && guard.epoch === this.player.operationEpoch && guard.context &&
      this.player.context?.guildId === guard.context.guildId && this.player.context?.voiceChannelId === guard.context.voiceChannelId;
  }
  validScheduleControl(guard, minute) {
    // Pause invalidates slow song fetches, but controls dispatched for the same
    // minute still follow saved order (e.g. pause, then lower volume). Manual
    // actions/config changes still invalidate them; stale minutes never replay.
    return this.valid({ ...guard, generation: this.generation }) && guard.configurationEpoch === this.configurationEpoch && Math.floor(this.now() / 60000) === minute;
  }
  tick() {
    if (this.closed) return Promise.resolve();
    // A slow music provider must never hide the minute of a pause or volume
    // schedule. Each worker retains its own lock so timer ticks may check the
    // clock while an earlier refill is still waiting on a shared provider.
    if (!this.scheduleWorking) {
      this.scheduleWorking = this.runSchedules()
        .catch(() => this.emit('error', 'schedule_tick_failed', '定时任务检查暂时失败。'))
        .finally(() => { this.scheduleWorking = null; });
    }
    if (!this.radioWorking) {
      this.radioWorking = this.fillRadio()
        .catch(() => this.emit('error', 'radio_tick_failed', '自动电台检查暂时失败。'))
        .finally(() => { this.radioWorking = null; });
    }
    const scheduled = this.scheduleWorking.then((jobs) => Promise.allSettled(jobs || []));
    const working = Promise.allSettled([scheduled, this.radioWorking]);
    this.working = working;
    void working.then(() => { if (this.working === working) this.working = null; });
    return working;
  }
  async candidates(settings, limit) {
    if (settings.strategy === 'playlist') return this.playlist(settings.playlistId, limit, settings.source);
    const sources = settings.source === 'mixed' ? ['netease', 'qq'] : [settings.source];
    const results = await Promise.allSettled(sources.map(async (platform) => {
      if (settings.strategy !== 'acg') return (await this.read(this.music.hot(limit, platform))).tracks;
      const lists = await this.read(this.music.discover('acg', platform));
      if (!lists.length) return [];
      // Rotating by successful fill time explores the category without an unbounded fetch loop.
      const index = Math.floor((this.radioState.lastRunAt || 0) / 60000) % Math.min(3, lists.length);
      return this.playlist(lists[index].id, limit, platform);
    }));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    if (!fulfilled.length) throw new UserError('音乐平台暂不可用。');
    const pools = fulfilled.map((result) => result.value);
    const tracks = [];
    for (let i = 0; i < Math.max(...pools.map((pool) => pool.length)); i++) for (const pool of pools) if (pool[i]) tracks.push(pool[i]);
    return tracks;
  }
  async playlist(input, limit, platform) {
    if (this.closed) throw new UserError('机器人正在关闭。');
    if (this.music.parseInput) {
      const parsed = await this.read(this.music.parseInput(input, { source: platform, kind: 'playlist' }));
      if (parsed.kind !== 'playlist') throw new UserError('请填写歌单链接或歌单 ID。');
      return this.read(this.music.playlist(parsed.id, limit, parsed.source));
    }
    return this.read(this.music.playlist(input, limit, platform));
  }
  async fillRadio() {
    if (this.closed || !this.radio.enabled || this.radioState.suspended || this.player.intent === 'paused' || this.player.current && this.player.intent !== 'playing' ||
        !this.player.context || this.player.capacity() < 1 || this.player.queue.length > this.radio.lowWatermark || this.now() < (this.nextRadioAt || 0)) return;
    const guard = this.guard(), settings = { ...this.radio };
    // Bound even empty/unplayable upstream results to one attempt per minute.
    this.nextRadioAt = this.now() + 60000;
    try {
      const avoid = [...this.radioState.recent.slice(-settings.avoidRecent || this.radioState.recent.length),
        ...(this.player.history || []).slice(-settings.avoidRecent || this.player.history.length).map(key)];
      if (!settings.avoidRecent) avoid.length = 0;
      const seen = new Set([...avoid, ...[this.player.current, ...this.player.queue].filter(Boolean).map(key)]);
      const pool = await this.candidates(settings, Math.min(500, settings.batchSize + settings.avoidRecent + this.player.queue.length + 1));
      if (!this.valid(guard) || this.radioState.suspended) return;
      const tracks = pool.filter((track) => { const id = key(track); if (seen.has(id)) return false; seen.add(id); return true; })
        .slice(0, Math.min(settings.batchSize, this.player.capacity()));
      if (!tracks.length) throw new UserError('暂时没有未重复的可补充歌曲。');
      const count = await this.player.add(guard.context, tracks.map((track) => ({ ...track, requestedBy: 'auto-radio' })), {
        expectedEpoch: guard.epoch, expectedVoiceChannelId: guard.context.voiceChannelId, checkState: () => this.valid(guard), filterDuplicates: true, avoidKeys: avoid });
      if (!this.valid(guard)) return;
      this.radioState.recent.push(...tracks.slice(0, count).map(key)); this.radioState.recent = this.radioState.recent.slice(-200);
      this.radioState.lastRunAt = this.now(); this.radioState.lastError = '';
      await this.persist(); this.emit('info', 'radio_fill', `自动电台已补充 ${count} 首歌曲。`);
    } catch {
      if (!this.valid(guard)) return;
      this.radioState.lastError = '自动补歌暂不可用，或没有未重复歌曲；将在一分钟后重试。';
      this.emit('warning', 'radio_failed', this.radioState.lastError);
    }
  }
  localTime(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    return { date, time: `${values.hour}:${values.minute}`, day: new Date(`${date}T12:00:00Z`).getUTCDay() };
  }
  async runSchedules() {
    const jobs = [];
    if (this.closed || !this.player.context) return jobs;
    for (const rule of [...this.schedules]) {
      const now = this.now(), minute = Math.floor(now / 60000), local = this.localTime(now, rule.timeZone);
      if (!rule.enabled || this.scheduleJobs.has(rule.id) || minute <= (this.enabledAfter.get(rule.id) ?? minute) || !rule.days.includes(local.day) || rule.time !== local.time || this.ledger[rule.id]?.date >= local.date) continue;
      const guard = this.guard();
      if (!this.valid(guard)) return jobs;
      // Durable at-most-once dispatch. A crash never repeats a playlist or volume
      // action; missed minutes and the startup minute are deliberately skipped.
      await this.serialize(async () => {
        if (!this.validScheduleControl(guard, minute)) return;
        const previous = this.ledger[rule.id];
        this.ledger[rule.id] = { date: local.date, at: now, error: '' };
        try { await this.save(); }
        catch (error) {
          // No action was dispatched. Keep the due minute eligible for retry
          // instead of displaying an execution that never reached the player.
          if (previous) this.ledger[rule.id] = previous; else delete this.ledger[rule.id];
          throw error;
        }
      });
      if (!this.validScheduleControl(guard, minute) || this.ledger[rule.id]?.at !== now) continue;
      // Dispatch in saved rule order, but never await a provider here. A slow
      // playlist has its own lease and cannot hide another rule's due minute.
      const job = this.executeSchedule(rule, { ...guard, generation: this.generation }, minute)
        .catch(() => this.emit('error', 'schedule_task_failed', '定时计划执行暂时失败。'))
        .finally(() => { if (this.scheduleJobs.get(rule.id) === job) this.scheduleJobs.delete(rule.id); });
      this.scheduleJobs.set(rule.id, job); jobs.push(job);
    }
    return jobs;
  }
  async executeSchedule(rule, guard, minute) {
    if (!this.valid(guard)) return;
    try {
      if (['hot', 'playlist'].includes(rule.action)) {
        if (!this.player.capacity()) throw new UserError('播放队列已满。');
        const limit = this.player.capacity();
        const tracks = rule.action === 'hot' ? (await this.read(this.music.hot(limit, rule.source))).tracks : await this.playlist(rule.playlistId, limit, rule.source);
        if (!this.valid(guard)) return;
        await this.player.add(guard.context, tracks.map((track) => ({ ...track, requestedBy: `schedule:${rule.id}` })), {
          expectedEpoch: guard.epoch, expectedVoiceChannelId: guard.context.voiceChannelId, checkState: () => this.valid(guard), filterDuplicates: true });
        if (this.valid(guard) && this.player.intent === 'paused') {
          await this.player.control('resume', undefined, { expectedEpoch: guard.epoch,
            expectedVoiceChannelId: guard.context.voiceChannelId, checkState: () => this.valid(guard), automated: true });
        }
      } else {
        await this.player.control(rule.action, rule.action === 'volume' ? rule.volume : undefined, {
          expectedEpoch: guard.epoch, expectedVoiceChannelId: guard.context.voiceChannelId, checkState: () => this.validScheduleControl(guard, minute), automated: true });
      }
      this.emit('info', 'schedule_run', `定时计划“${rule.name || rule.time}”已执行。`);
    } catch {
      if (this.closed) return;
      if (this.ledger[rule.id]) this.ledger[rule.id].error = '计划执行失败：请检查频道、队列容量和音乐账号。';
      await this.persist(); this.emit('warning', 'schedule_failed', `定时计划“${rule.name || rule.time}”未完成，请检查频道、队列容量和音乐账号。`);
    }
  }
  isManager(userId) { return this.config.admins.has(userId) || this.rules.managerIds.includes(userId); }
  policy(userId) { return this.rules.enabled && !this.isManager(userId) ? { userId, perUserLimit: this.rules.perUserLimit, preventDuplicates: this.rules.preventDuplicates } : undefined; }
  authorize(action, userId) {
    if (!this.rules.enabled || this.isManager(userId)) return;
    if (!['search', 'play', 'pick', 'playlist', 'heart', 'hot', 'queue', 'now', 'help', 'rules', 'skip', 'vote'].includes(action)) throw new UserError('已开启房间点歌规则，此操作需要房间管理员。');
    if (['skip', 'vote'].includes(action) && !this.rules.voteSkip) throw new UserError('此房间仅管理员可以切歌。');
  }
  rulesText() {
    return this.rules.enabled ? `每人最多 ${this.rules.perUserLimit} 首（含当前播放）；${this.rules.preventDuplicates ? '重复歌曲不加入队列' : '允许重复点歌'}。\n${this.rules.voteSkip ? `切歌需 ${this.rules.voteThreshold} 票，人数不足时按频道实际人数；仅在频道中的真人用户可投票。` : '仅管理员可以切歌。'}\n暂停、继续、上一首、音量、常驻及队列管理由房间管理员操作。` : '本房间暂未开启多人点歌规则。';
  }
  syncVotes() {
    const track = this.player.current ? `${key(this.player.current)}:${this.player.trackEpoch || 0}` : null;
    if (track !== this.voteTrack) { this.votes.clear(); this.requiredVotes = 0; this.voteTrack = track; }
  }
  vote(userId) {
    const next = this.voteTail.then(async () => {
      if (this.closed) throw new UserError('机器人正在关闭。');
      this.authorize('vote', userId);
      if (!this.rules.enabled || !this.rules.voteSkip) throw new UserError('本房间尚未开启投票切歌。');
      if (!this.player.context || !this.player.current) throw new UserError('当前没有可投票切换的歌曲。');
      this.syncVotes(); const track = this.voteTrack, guard = this.guard(), trackEpoch = this.player.trackEpoch;
      const result = await this.read(this.api.request('channel/user-list', { channel_id: guard.context.voiceChannelId }));
      const members = Array.isArray(result) ? result : result?.items;
      if (!Array.isArray(members)) throw new UserError('暂时无法核实频道成员，请稍后重试。');
      const humans = new Set(members.filter((member) => member && !member.bot && member.id && String(member.id) !== String(this.selfId)).map((member) => String(member.id)));
      if (!humans.has(userId)) throw new UserError('请进入机器人所在的语音频道后再投票。');
      this.syncVotes(); if (!this.valid(guard) || track !== this.voteTrack) throw new UserError('歌曲已变化，请为当前歌曲重新投票。');
      for (const id of this.votes) if (!humans.has(id)) this.votes.delete(id);
      this.requiredVotes = Math.min(this.rules.voteThreshold, humans.size);
      const duplicate = this.votes.has(userId); this.votes.add(userId);
      if (this.votes.size >= this.requiredVotes) {
        await this.player.control('skip', undefined, { expectedEpoch: guard.epoch, expectedVoiceChannelId: guard.context.voiceChannelId, expectedTrackEpoch: trackEpoch, checkState: () => this.valid(guard), automated: true });
        this.syncVotes(); return '投票通过，已切换下一首。';
      }
      return `${duplicate ? '你已投过票' : '已收到切歌投票'}：${this.votes.size}/${this.requiredVotes}。`;
    });
    this.voteTail = next.catch(() => {}); return next;
  }
  async close() {
    this.closed = true; this.generation++; clearInterval(this.timer);
    for (const cancel of this.pendingReads) cancel(); this.pendingReads.clear();
    // Do not hold service shutdown behind a shared provider queue. Local writes
    // already admitted are drained; detached workers have guards at every mutation.
    await this.tail;
    if (this.player.features === this) this.player.features = null;
  }
}
