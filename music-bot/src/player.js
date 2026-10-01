import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { atomicJson, label, log, sleep, AuthRequiredError, UnavailableError, UserError } from './util.js';
import { validTrack } from './music-sources.js';

const HISTORY_LIMIT = 50;
const LEAVE_ATTEMPTS = 3;
const LEAVE_PENDING = '播放已停止，退出语音频道尚未确认；请稍后核对频道或重试退出。';

export class Player {
  constructor(config, api, music, audio, notify) {
    Object.assign(this, { config, api, music, audio, notify });
    this.file = path.join(config.dataDir, 'queue.json');
    this.queue = []; this.history = []; this.current = null; this.context = null; this.stream = null;
    this.volume = config.volume; this.mode = 'off'; this.tail = Promise.resolve(); this.persistTail = Promise.resolve();
    this.closed = false; this.voiceJoined = false; this.voiceConnection = null;
    this.pendingLeave = null; this.leaveTimer = null;
    // Invalidate provider work immediately when a user interrupts or leaves.
    this.operationEpoch = 0; this.trackEpoch = 0;
    this.listeners = new Set();
    this.stayConnected = config.stayConnected;
    this.position = 0; this.intent = 'idle'; this.hasStarted = false;
    this.retryCount = 0; this.recoveryError = ''; this.keepaliveFailures = 0;
    this.checkpoint = setInterval(() => {
      if (!this.closed && this.current) {
        if (this.stream && !this.stream.paused && this.stream.seconds - this.stream.startOffset >= 10) this.retryCount = 0;
        void this.save().catch(() => log('progress_save_failed'));
      }
    }, 5000);
    this.checkpoint.unref?.();
  }
  exclusive(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) { try { listener(event); } catch { log('player_observer_failed'); } } }
  ensureEntries() {
    const seen = new Set();
    const entry = (track) => {
      if (!track) return track;
      let entryId = track.entryId;
      if (typeof entryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entryId) || seen.has(entryId)) entryId = randomUUID();
      seen.add(entryId); return entryId === track.entryId ? track : { ...track, entryId };
    };
    this.current = entry(this.current); this.queue = this.queue.map(entry);
    this.history = this.history.map((track) => track.entryId ? track : { ...track, entryId: randomUUID() });
  }
  async restore() {
    let state;
    try { state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('播放队列文件无法读取，请先备份并检查 data/queue.json。'); }
    const valid = validTrack;
    if (![1, 2].includes(state.version) || !Array.isArray(state.queue) || !state.queue.every(valid) ||
        (state.current && !valid(state.current)) ||
        (state.history !== undefined && (!Array.isArray(state.history) || !state.history.every(valid)))) throw new Error('播放队列文件格式无效。');
    if (state.pendingLeave != null) {
      const pending = state.pendingLeave;
      if (typeof pending !== 'object' || Array.isArray(pending) || !this.config.guilds.has(pending.guildId)
        || typeof pending.channelId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pending.channelId)
        || !Number.isInteger(pending.attempts) || pending.attempts < 0 || pending.attempts > LEAVE_ATTEMPTS) throw new Error('待退出频道记录无效。');
      this.pendingLeave = { guildId: pending.guildId, channelId: pending.channelId, attempts: pending.attempts };
      this.recoveryError = LEAVE_PENDING;
    }
    if (state.context && this.config.guilds.has(state.context.guildId)) {
      this.context = state.context;
      this.current = state.current || null;
      this.queue = state.queue.slice(0, this.config.maxQueue - (this.current ? 1 : 0));
      this.history = (state.history || []).slice(-HISTORY_LIMIT);
      this.ensureEntries();
      this.position = this.clampPosition(state.version === 2 ? state.positionSeconds : 0);
      this.intent = (this.current || this.queue.length) && state.version === 2 && ['playing', 'paused', 'idle'].includes(state.intent) ? state.intent : 'idle';
      this.hasStarted = Boolean(this.current && (state.version === 1 || state.hasStarted));
      this.volume = Number.isInteger(state.volume) && state.volume >= 0 && state.volume <= 100 ? state.volume : this.volume;
      this.mode = ['off', 'one', 'all'].includes(state.mode) ? state.mode : 'off';
      this.stayConnected = typeof state.stayConnected === 'boolean' ? state.stayConnected : this.stayConnected;
      // Persist generated legacy entry IDs before exposing the restored queue.
      if (JSON.stringify([state.current, ...state.queue].filter(Boolean).map((track) => track.entryId)) !==
          JSON.stringify([this.current, ...this.queue].filter(Boolean).map((track) => track.entryId))) await this.save();
      log('queue_restored', { tracks: this.queue.length });
      this.armIdle();
    }
    this.scheduleLeave();
  }
  save() {
    this.ensureEntries();
    this.capturePosition();
    const state = structuredClone({ version: 2, context: this.context, current: this.current,
      queue: this.queue, history: this.history, volume: this.volume, mode: this.mode, stayConnected: this.stayConnected,
      positionSeconds: this.position, intent: this.intent, hasStarted: this.hasStarted, pendingLeave: this.pendingLeave, savedAt: Date.now() });
    // Network operations may hold the player lock; checkpoints use their own write order.
    const writing = this.persistTail.then(() => atomicJson(this.file, state));
    this.persistTail = writing.catch(() => {});
    return writing;
  }
  clampPosition(value) {
    const n = Number(value);
    const limit = this.current?.durationMs > 0 ? Math.max(0, this.current.durationMs / 1000 - 0.25) : 86400;
    return Number.isFinite(n) ? Math.min(limit, Math.max(0, n)) : 0;
  }
  capturePosition() {
    if (this.stream && Number.isFinite(this.stream.seconds)) this.position = this.clampPosition(this.stream.seconds);
    return this.current ? this.position : 0;
  }
  snapshot() {
    return { current: this.current, queue: this.queue, context: this.context, volume: this.volume,
      mode: this.mode, stayConnected: this.stayConnected, connected: this.voiceJoined,
      status: this.stream ? (this.stream.paused ? 'paused' : 'playing') : this.current ? (this.intent === 'playing' ? 'recovering' : this.intent === 'paused' ? 'paused' : 'ready') : 'idle',
      seconds: this.capturePosition(), canResume: Boolean(this.current), recoveryError: this.recoveryError,
      leaving: Boolean(this.pendingLeave),
      canPrevious: this.history.length > 0 && this.capacity() > 0, historyCount: this.history.length,
      capacity: this.capacity(), maxQueue: this.config.maxQueue };
  }
  join(context, { authorize, expectedEpoch } = {}) {
    return this.exclusive(async () => {
      const admission = authorize?.();
      if (admission && typeof admission.then === 'function') await admission;
      if (this.closed) throw new UserError('机器人正在关闭。');
      if (expectedEpoch !== undefined && expectedEpoch !== this.operationEpoch) throw new UserError('播放状态已变化，请重新选择频道。');
      if (this.context && (this.context.guildId !== context.guildId || this.context.voiceChannelId !== context.voiceChannelId)) {
        throw new UserError('请先离开当前频道，再加入其他频道。');
      }
      if (this.pendingLeave && !await this.finishLeave({ manual: true })) throw new UserError(LEAVE_PENDING);
      if (this.closed || expectedEpoch !== undefined && expectedEpoch !== this.operationEpoch) throw new UserError('播放状态已变化，请重新选择频道。');
      const previous = this.context;
      if (!this.context) this.operationEpoch++;
      this.context = context;
      try { await this.joinVoice(); }
      catch (error) {
        if (!this.voiceJoined) { this.context = previous; await this.save(); }
        throw error;
      }
      await this.save(); this.armIdle();
      this.emit({ kind: 'join', context: { ...context } });
    });
  }
  async joinVoice() {
    if (this.closed || !this.context) throw new UserError('没有可连接的语音频道。');
    if (this.pendingLeave && !await this.finishLeave()) throw new UserError(LEAVE_PENDING);
    if (this.voiceJoined && this.voiceConnection && this.audio.connected !== false) return this.voiceConnection;
    if (this.voiceJoined && !await this.releaseVoice()) throw new UserError(LEAVE_PENDING);
    const cooldown = 3000 - (Date.now() - (this.lastLeave || 0));
    if (cooldown > 0) await sleep(cooldown);
    const voice = await this.api.post('voice/join', {
      // FFmpeg uses separate source sockets for RTP and RTCP; KOOK must separate them too.
      channel_id: this.context.voiceChannelId, audio_ssrc: '1111', audio_pt: '111', rtcp_mux: false,
    });
    this.voiceJoined = true;
    this.voiceConnection = voice;
    if (this.closed) { await this.releaseVoice(); throw new UserError('机器人正在关闭。'); }
    try { await this.audio.connect?.(voice, this.volume); }
    catch (error) {
      await this.releaseVoice();
      if (this.stayConnected && !this.closed) this.startKeepalive();
      throw error;
    }
    this.startKeepalive(); return voice;
  }
  async say(text) {
    if (this.context) {
      try { await this.notify(this.context.textChannelId, text); }
      catch { log('notification_failed'); }
    }
  }
  capacity() { return this.config.maxQueue - this.queue.length - (this.current ? 1 : 0); }
  rememberCurrent() {
    // Only completed or manually skipped playback enters history; retries and back navigation do not.
    if (!this.current || !this.hasStarted) return;
    this.history.push(this.current);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }
  add(context, tracks, { expectedVoiceChannelId, expectedEpoch, checkState, authorize, onAdded, policy, filterDuplicates = false, avoidKeys = [] } = {}) {
    return this.exclusive(async () => {
      if (this.closed) throw new UserError('机器人正在关闭。');
      const decision = authorize?.();
      const admission = decision && typeof decision.then === 'function' ? await decision : decision;
      if (this.closed) throw new UserError('机器人正在关闭。');
      if (admission?.policy) policy = admission.policy;
      if (expectedEpoch !== undefined && expectedEpoch !== this.operationEpoch) throw new UserError('播放状态已变化，已取消本次自动添加。');
      if (checkState && !checkState()) throw new UserError('房间设置已变化，已取消本次自动添加。');
      if (expectedVoiceChannelId !== undefined && (typeof expectedVoiceChannelId !== 'string' ||
          !expectedVoiceChannelId.trim() || expectedVoiceChannelId.length > 64 || !this.context ||
          this.context.voiceChannelId !== expectedVoiceChannelId || this.context.voiceChannelId !== context.voiceChannelId ||
          this.context.guildId !== context.guildId)) {
        throw new UserError('机器人频道已变化，请重新预览后再加入。');
      }
      if (this.context && (this.context.guildId !== context.guildId || this.context.voiceChannelId !== context.voiceChannelId)) {
        throw new UserError('机器人正在另一个语音频道使用中，请先在原频道停止播放。');
      }
      if (!tracks.length) throw new UserError('没有可加入的歌曲。');
      if (!tracks.every(validTrack)) throw new UserError('歌曲标识无效，请重新搜索。');
      if (filterDuplicates || policy?.preventDuplicates) {
        const key = (track) => `${track.source || 'netease'}:${track.id}`;
        const seen = new Set([...avoidKeys, ...[this.current, ...this.queue].filter(Boolean).map(key)]);
        tracks = tracks.filter((track) => { const id = key(track); if (seen.has(id)) return false; seen.add(id); return true; });
      }
      if (policy?.userId) {
        const used = [this.current, ...this.queue].filter((track) => track?.requestedBy === policy.userId).length;
        tracks = tracks.slice(0, Math.max(0, policy.perUserLimit - used));
      }
      if (!tracks.length) throw new UserError('歌曲已在队列中，或已达到每人点歌上限。');
      if (filterDuplicates || policy) tracks = tracks.slice(0, Math.max(0, this.capacity()));
      if (!tracks.length) throw new UserError(`队列最多容纳 ${this.config.maxQueue} 首歌曲。`);
      if (this.capacity() < tracks.length) throw new UserError(`队列最多容纳 ${this.config.maxQueue} 首歌曲。`);
      tracks = tracks.map((track) => ({ ...track, entryId: randomUUID(),
        ...(admission?.requestedBy ? { requestedBy: admission.requestedBy, requestedByName: admission.requestedByName } : {}) }));
      const entered = !this.context;
      this.context = context;
      this.queue.push(...tracks); await this.save();
      if (onAdded) { try { onAdded(tracks); } catch { log('player_observer_failed'); } }
      if (entered) this.emit({ kind: 'join', context: { ...context } });
      this.emit({ kind: 'request', tracks });
      if (!this.current) await this.next();
      return tracks.length;
    });
  }
  removeEntry(entryId, { authorize, expectedEpoch, expectedVoiceChannelId } = {}) {
    return this.exclusive(async () => {
      if (this.closed) throw new UserError('机器人正在关闭。');
      if (typeof entryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entryId)) throw new UserError('待播歌曲标识无效。');
      if (this.current?.entryId === entryId) throw new UserError('当前歌曲已开始播放，不能撤回。');
      const index = this.queue.findIndex((track) => track.entryId === entryId);
      if (index < 0) throw new UserError('这首歌已不在待播队列中。');
      const track = this.queue[index];
      if (!authorize) throw new UserError('只能撤回自己的待播歌曲。');
      const decision = authorize(track);
      if ((decision && typeof decision.then === 'function' ? await decision : decision) === false) throw new UserError('只能撤回自己的待播歌曲。');
      if (this.closed || expectedEpoch !== undefined && expectedEpoch !== this.operationEpoch || expectedVoiceChannelId !== undefined && expectedVoiceChannelId !== this.context?.voiceChannelId) throw new UserError('播放状态已变化，请刷新后重试。');
      this.queue.splice(index, 1); await this.save(); this.emit({ kind: 'withdraw', track });
      return track;
    });
  }
  async halt() {
    this.capturePosition();
    const handle = this.stream; this.stream = null;
    if (handle) await handle.stop();
  }
  async open(track, offset = 0) {
    const media = await this.music.stream(track);
    if (this.closed) throw new UserError('机器人正在关闭。');
    const voice = await this.joinVoice();
    if (this.audio.setVolume) await this.syncVolume(() => this.audio.setVolume(this.volume));
    clearTimeout(this.idleTimer);
    let handle;
    handle = this.audio.start(media, voice, this.volume, offset, (error) => {
      void this.exclusive(async () => {
        if (this.closed || this.stream !== handle) return;
        this.capturePosition();
        this.stream = null;
        if (error) { await this.failed(error); return; }
        this.rememberCurrent();
        const finished = this.current; this.current = null; this.position = 0; this.hasStarted = false;
        this.retryCount = 0; this.recoveryError = '';
        if (this.mode === 'one') this.queue.unshift(finished);
        else if (this.mode === 'all') this.queue.push(finished);
        await this.save(); await this.next();
      }).catch(() => log('playback_transition_failed'));
    });
    this.stream = handle;
    handle.startOffset = offset;
    this.position = offset; this.hasStarted = true;
    this.recoveryError = ''; this.keepaliveFailures = 0;
  }
  clearRetry() { clearTimeout(this.retryTimer); this.retryTimer = null; }
  async syncVolume(apply) {
    try { await apply(); }
    catch (error) {
      if (this.audio.connected === false) throw error;
      log('volume_sync_failed');
    }
  }
  async failed(error) {
    await this.halt();
    this.recoveryError = error instanceof UserError ? error.message : '播放暂时中断。';
    this.clearRetry();
    if (this.intent === 'playing' && !this.closed && this.current) {
      this.retryCount++;
      if (this.retryCount <= 5) {
        const delay = Math.min(60000, 3000 * 2 ** (this.retryCount - 1));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.exclusive(async () => {
            if (!this.closed && this.current && this.intent === 'playing' && !this.stream) await this.attemptCurrent();
          }).catch(() => log('playback_retry_failed'));
        }, delay);
        log('playback_recovery_scheduled', { delayMs: delay, attempt: this.retryCount });
      } else {
        this.intent = 'idle'; this.armIdle();
        await this.say(`暂时无法恢复播放，歌曲和进度已保存。发送 ${this.config.prefix}继续 可从断点重试。`);
      }
    }
    if (this.stayConnected && this.context && !this.closed && !this.voiceJoined) this.startKeepalive();
    await this.save();
  }
  async attemptCurrent() {
    if (!this.current || this.closed) return;
    try { await this.open(this.current, this.position); await this.save(); }
    catch (error) {
      if (error instanceof AuthRequiredError) {
        this.clearRetry(); this.recoveryError = error.message; this.intent = 'paused';
        await this.save();
        await this.say(`汽水音乐账号需要重新登录，已保留《${this.current.name}》和播放进度。重新登录后发送 ${this.config.prefix}继续。`);
      } else if (error instanceof UnavailableError && !this.hasStarted && this.position === 0) {
        const skipped = this.current; this.current = null; this.position = 0;
        await this.say(`跳过 ${label(skipped)}：${error.message}`); await this.save();
        this.advanceTimer = setTimeout(() => {
          void this.exclusive(async () => { if (!this.closed && !this.current) await this.next(); }).catch(() => log('playback_transition_failed'));
        }, 0);
      } else await this.failed(error);
    }
  }
  async next() {
    if (!this.closed && this.queue.length) {
      this.clearRetry(); this.retryCount = 0; this.recoveryError = '';
      this.current = this.queue.shift(); this.trackEpoch++; this.position = 0; this.intent = 'playing'; this.hasStarted = false;
      await this.save(); await this.attemptCurrent();
      if (this.stream && this.current) this.emit({ kind: 'playing', track: this.current });
      if (this.stream) await this.say(`正在播放：${label(this.current)}`);
      return;
    }
    this.current = null; this.position = 0; this.intent = 'idle'; this.hasStarted = false;
    await this.save(); this.armIdle();
  }
  startKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      void this.exclusive(() => this.maintainVoice()).catch(() => log('voice_keepalive_failed'));
    }, 45000);
  }
  async maintainVoice() {
    if (this.pendingLeave && !this.closed) { await this.finishLeave(); return; }
    if (!this.context || this.closed) return;
    if (this.voiceJoined && this.audio.connected === false) {
      this.clearRetry(); await this.halt(); await this.releaseVoice(); await this.save();
      if (this.current && this.intent === 'playing') await this.attemptCurrent();
      else if (this.stayConnected) {
        try { await this.joinVoice(); } catch { this.startKeepalive(); log('voice_rejoin_retry'); }
      }
      return;
    }
    if (!this.voiceJoined) {
      if (this.stayConnected) {
        try { await this.joinVoice(); } catch { this.startKeepalive(); log('voice_rejoin_retry'); }
      }
      return;
    }
    let joined;
    try {
      await this.api.post('voice/keep-alive', { channel_id: this.context.voiceChannelId });
    } catch {
      this.keepaliveFailures++;
      log('voice_health_request_failed', { count: this.keepaliveFailures });
    }
    try {
      joined = await this.api.request('voice/list'); this.keepaliveFailures = 0;
    } catch {
      log('voice_membership_request_failed');
      return;
    }
    if (joined.items?.some((channel) => channel.id === this.context.voiceChannelId)) return;
    this.clearRetry(); await this.halt(); await this.audio.disconnect?.();
    this.voiceJoined = false; this.voiceConnection = null; this.lastLeave = Date.now();
    await this.save();
    if (this.current && this.intent === 'playing') {
      await this.attemptCurrent();
    } else if (this.stayConnected) {
      try { await this.joinVoice(); log('voice_reconnected'); }
      catch { this.startKeepalive(); log('voice_rejoin_retry'); }
    }
  }
  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.stayConnected) return;
    this.idleTimer = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.closed || (this.current && this.intent === 'playing') || (this.stream && !this.stream.paused)) return;
        const channel = this.context?.textChannelId;
        const left = await this.reset();
        if (channel) { try { await this.notify(channel, left ? '空闲超时，已清空队列并离开语音频道。' : LEAVE_PENDING); } catch { log('notification_failed'); } }
      }).catch(() => log('idle_cleanup_failed'));
    }, this.config.idleMs);
    this.idleTimer.unref?.();
  }
  scheduleLeave() {
    clearTimeout(this.leaveTimer); this.leaveTimer = null;
    const pending = this.pendingLeave;
    if (!pending || this.closed || pending.attempts >= LEAVE_ATTEMPTS) return;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      void this.exclusive(async () => {
        if (!this.closed && this.pendingLeave === pending) await this.finishLeave();
      }).catch(() => log('voice_leave_retry_failed'));
    }, 3000 * 3 ** pending.attempts);
    this.leaveTimer.unref?.();
  }
  async finishLeave({ manual = false } = {}) {
    const pending = this.pendingLeave;
    if (!pending) return true;
    clearTimeout(this.leaveTimer); this.leaveTimer = null;
    if (!manual && pending.attempts >= LEAVE_ATTEMPTS) return false;
    // A previous timeout may already have left remotely. Verify the old target
    // before retrying; every caller holds the player lock, including timers.
    let absent = false;
    if (pending.attempts && typeof this.api.request === 'function') {
      try {
        const listed = await this.api.request('voice/list');
        absent = Array.isArray(listed?.items) && !listed.items.some(item => String(item.id) === pending.channelId);
      } catch { /* The bounded leave attempt below remains authoritative. */ }
    }
    pending.attempts = Math.min(LEAVE_ATTEMPTS, pending.attempts + 1);
    try { await this.save(); }
    catch (error) {
      // Shutdown/removal still releases the remote allocation if its checkpoint
      // cannot be written. A live player must preserve the cleanup intent first.
      if (!this.closed) throw error;
      log('voice_leave_checkpoint_failed');
    }
    try {
      if (!absent) await this.api.post('voice/leave', { channel_id: pending.channelId });
    } catch {
      this.recoveryError = LEAVE_PENDING; this.scheduleLeave(); log('voice_leave_failed'); return false;
    }
    this.lastLeave = Date.now(); this.pendingLeave = null;
    if (this.recoveryError === LEAVE_PENDING) this.recoveryError = '';
    try { await this.save(); } catch (error) { if (!this.closed) throw error; log('voice_leave_checkpoint_failed'); }
    return true;
  }
  async releaseVoice({ manual = false } = {}) {
    clearInterval(this.keepalive);
    await this.audio.disconnect?.();
    if (this.voiceJoined && this.context && !this.pendingLeave) this.pendingLeave = {
      channelId: this.context.voiceChannelId, guildId: this.context.guildId, attempts: 0,
    };
    this.voiceJoined = false; this.voiceConnection = null;
    return this.finishLeave({ manual });
  }
  async reset({ retryLeave = false } = {}) {
    const previousContext = this.context ? { ...this.context } : null;
    this.operationEpoch++;
    this.features?.onControl('stop');
    this.clearRetry(); clearTimeout(this.idleTimer); clearTimeout(this.advanceTimer); await this.halt();
    this.current = null; this.queue = []; this.history = []; this.mode = 'off';
    this.position = 0; this.intent = 'idle'; this.hasStarted = false; this.retryCount = 0;
    // The first cleanup checkpoint must already represent the user's Stop.
    // Keep only the departure target; a restored resident context would rejoin.
    if (this.voiceJoined && previousContext && !this.pendingLeave) this.pendingLeave = {
      channelId: previousContext.voiceChannelId, guildId: previousContext.guildId, attempts: 0,
    };
    this.context = null;
    const left = await this.releaseVoice({ manual: retryLeave });
    this.recoveryError = left ? '' : LEAVE_PENDING;
    await this.save();
    if (previousContext) this.emit({ kind: left ? 'leave' : 'leave_pending', context: previousContext });
    return left;
  }
  async restartCurrent(paused = false, offset = this.capturePosition()) {
    this.clearRetry(); await this.halt();
    this.position = this.clampPosition(offset); this.intent = paused ? 'paused' : 'playing';
    this.retryCount = 0; this.recoveryError = ''; await this.save();
    if (paused) this.armIdle(); else await this.attemptCurrent();
  }
  async resumeAfterRestart() {
    if (this.intent === 'playing') await this.exclusive(() => this.current ? this.attemptCurrent() : this.next());
  }
  control(action, value, { expectedEpoch, expectedVoiceChannelId, expectedTrackEpoch, checkState, authorize, actorName, automated = false } = {}) {
    // This occurs before waiting for the player lock so a stale auto-fill cannot
    // recreate a queue while a stop/pause is already pending.
    if (!automated && ['stop', 'pause', 'resume', 'skip', 'previous', 'clear', 'seek'].includes(action)) this.operationEpoch++;
    return this.exclusive(async () => {
      if (this.closed) throw new UserError('机器人正在关闭。');
      const admission = authorize?.();
      if (admission && typeof admission.then === 'function') await admission;
      if (this.closed) throw new UserError('机器人正在关闭。');
      if (checkState && !checkState()) throw new UserError('房间设置已变化，已取消本次自动操作。');
      if (expectedEpoch !== undefined && expectedEpoch !== this.operationEpoch ||
          expectedTrackEpoch !== undefined && expectedTrackEpoch !== this.trackEpoch ||
          expectedVoiceChannelId !== undefined && this.context?.voiceChannelId !== expectedVoiceChannelId) {
        throw new UserError('播放状态已变化，已取消本次自动操作。');
      }
      if (action === 'stay') {
        this.stayConnected = Boolean(value); this.armIdle(); await this.save();
        if (this.stayConnected && this.context && !this.voiceJoined) {
          this.startKeepalive();
          try { await this.joinVoice(); } catch { this.startKeepalive(); log('voice_rejoin_retry'); }
        }
        return this.stayConnected ? '已开启常驻频道。' : '已关闭常驻频道。';
      }
      if (!this.context && !(action === 'stop' && this.pendingLeave)) throw new UserError('当前没有播放队列，请先点歌。');
      switch (action) {
        case 'stop': return await this.reset({ retryLeave: true }) ? '已停止播放，清空队列并离开频道。' : LEAVE_PENDING;
        case 'skip':
          this.clearRetry(); await this.halt(); this.rememberCurrent();
          this.current = null; this.position = 0; this.hasStarted = false;
          await this.save(); await this.next(); return '已切换下一首。';
        case 'previous': {
          if (!this.history.length) throw new UserError('还没有可播放的上一首歌曲。');
          if (this.capacity() < 1) throw new UserError(`队列已达到 ${this.config.maxQueue} 首上限，请先移除一首待播歌曲，再播放上一首。`);
          this.clearRetry(); clearTimeout(this.advanceTimer); await this.halt();
          if (this.current) this.queue.unshift(this.current);
          const previous = this.history.pop();
          this.current = this.queue.some((track) => track.entryId === previous.entryId) ? { ...previous, entryId: randomUUID() } : previous; this.trackEpoch++;
          // Like Skip, Previous starts playback even when the old song was paused.
          this.position = 0; this.intent = 'playing'; this.hasStarted = false;
          this.retryCount = 0; this.recoveryError = '';
          await this.save(); await this.attemptCurrent(); return '已切换上一首，原歌曲已放回待播队列。';
        }
        case 'pause':
          if (!this.current) throw new UserError('当前没有正在播放的歌曲。');
          this.features?.onControl('pause');
          this.clearRetry(); this.intent = 'paused';
          // Keep RTP alive, but do not retain an idle HTTP source across a long pause.
          await this.halt();
          await this.save(); this.armIdle(); return '已暂停，进度已保存。';
        case 'resume':
          this.features?.onControl('resume');
          if (this.current && (!this.stream || this.stream.paused)) await this.restartCurrent();
          else if (!this.current) await this.next();
          return this.stream ? '已从保存的进度继续播放。' : this.current ? '正在按保存的进度恢复播放。' : '队列为空，请先点歌。';
        case 'volume': {
          if (!Number.isInteger(value) || value < 0 || value > 100) throw new UserError('音量范围为 0-100。');
          this.volume = value; await this.save();
          if (this.stream && !this.stream.paused) await this.stream.setVolume(value);
          return `音量已设为 ${value}%。`;
        }
        case 'loop': this.mode = value; await this.save(); return `循环模式：${{ off: '关闭', one: '单曲', all: '队列' }[value]}。`;
        case 'remove':
          if (value < 1 || value > this.queue.length) throw new UserError('队列序号不存在。');
          const [removed] = this.queue.splice(value - 1, 1); await this.save(); return `已移除：${label(removed)}`;
        case 'clear': this.queue = []; await this.save(); return '已清空待播歌曲。';
        case 'seek':
          if (!this.current || !Number.isFinite(value) || value < 0 || value * 1000 >= this.current.durationMs) throw new UserError('播放位置无效。');
          await this.restartCurrent(this.intent !== 'playing', value); return '已调整并保存播放位置。';
        case 'move': {
          const { from, to } = value;
          if (![from, to].every((i) => Number.isInteger(i) && i >= 1 && i <= this.queue.length)) throw new UserError('队列序号无效。');
          this.queue.splice(to - 1, 0, this.queue.splice(from - 1, 1)[0]); await this.save(); return '队列已调整。';
        }
        case 'shuffle':
          for (let i = this.queue.length - 1; i > 0; i--) { const j = randomInt(i + 1); [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; }
          await this.save(); return '待播队列已随机排序。';
      }
    }).then((result) => { if (result !== undefined) this.emit({ kind: 'control', action, value, actorName, automated }); return result; });
  }
  async shutdown() {
    this.closed = true;
    this.clearRetry(); clearInterval(this.checkpoint);
    clearTimeout(this.idleTimer); clearTimeout(this.advanceTimer); clearInterval(this.keepalive);
    clearTimeout(this.leaveTimer); this.leaveTimer = null;
    await this.exclusive(async () => {
      let failure;
      try { await this.save(); } catch (error) { failure = error; }
      try { await this.halt(); } catch (error) { failure ||= error; }
      try { await this.releaseVoice(); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    });
  }
}
