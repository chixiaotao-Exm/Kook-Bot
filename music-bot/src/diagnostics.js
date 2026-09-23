import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, log, UserError } from './util.js';

const LIMIT = 300;
const levels = new Set(['info', 'warning', 'error']);

export class Diagnostics {
  constructor(config, manager, music, { now = Date.now, accountIntervalMs = 300000 } = {}) {
    Object.assign(this, { config, manager, music, now, accountIntervalMs });
    this.file = path.join(config.dataDir, 'health-events.json');
    this.events = []; this.accounts = {}; this.previous = new Map(); this.attached = new WeakSet();
    this.writeTail = Promise.resolve(); this.closed = false; this.persistDisabled = false;
    this.accountPending = null; this.lastAccountAttempt = null; this.storageError = '';
    this.accountVersions = { netease: 0, qq: 0 }; this.recheckAccounts = false;
    for (const source of ['netease', 'qq']) this.accounts[source] = { loggedIn: false, status: 'checking', checkedAt: 0, error: '' };
  }
  async init() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.events)) throw new Error('Invalid health history');
      this.events = value.events.filter((entry) => entry && typeof entry.id === 'string' && Number.isFinite(entry.time) &&
        levels.has(entry.level) && typeof entry.kind === 'string' && typeof entry.message === 'string')
        .slice(0, LIMIT).map((entry) => this.safeEvent(entry));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.persistDisabled = true;
        this.storageError = '历史故障记录无法读取，原文件已保留；本次记录暂存在内存中。';
      }
    }
    return this;
  }
  redact(value) {
    let text = String(value || '');
    const secrets = [this.config.token, this.config.cookie];
    for (const bot of this.manager.list()) {
      try { secrets.push(this.manager.get(bot.id).config?.token); } catch {}
    }
    for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
    return text.replace(/https?:\/\/\S+/gi, '[链接]')
      .replace(/["']?(?:cookie|authorization|token|musickey|refresh_token)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\r\n}]+)/gi, '[凭据已隐藏]').slice(0, 500);
  }
  safeEvent(event) {
    const bot = this.manager.list().find((item) => item.id === event.botId);
    return { id: String(event.id || randomUUID()).slice(0, 80), time: Number.isFinite(event.time) ? event.time : this.now(),
      ...(typeof event.botId === 'string' ? { botId: event.botId.slice(0, 64) } : {}),
      botName: this.redact(bot?.name || event.botName || '系统'),
      level: levels.has(event.level) ? event.level : 'info',
      kind: /^[a-z][a-z0-9_]{0,63}$/.test(event.kind || event.code || '') ? event.kind || event.code : 'notice',
      message: this.redact(event.message) };
  }
  record(event) {
    if (this.closed) return;
    const item = this.safeEvent(event), last = this.events[0];
    if (last && last.botId === item.botId && last.kind === item.kind && last.message === item.message && item.time - last.time < 60000) return;
    this.events.unshift(item); this.events.length = Math.min(LIMIT, this.events.length);
    if (this.persistDisabled) return;
    const snapshot = { version: 1, events: structuredClone(this.events) };
    this.writeTail = this.writeTail.then(() => atomicJson(this.file, snapshot)).catch(() => {
      this.storageError = '故障记录暂时无法保存，请检查数据目录空间与权限。'; log('health_history_save_failed');
    });
  }
  sample() {
    const list = this.manager.list(), currentIds = new Set(list.map((bot) => bot.id));
    for (const id of this.previous.keys()) if (!currentIds.has(id)) this.previous.delete(id);
    return list.map((bot) => {
      const runtime = this.manager.get(bot.id), player = runtime.player;
      if (runtime.features?.setReporter && !this.attached.has(runtime.features)) {
        runtime.features.setReporter((event) => this.record({ ...event, botId: bot.id, botName: bot.name, kind: event.kind || event.code }));
        this.attached.add(runtime.features);
      }
      const state = player?.snapshot(), features = runtime.features?.snapshot(), now = this.now();
      const prior = this.previous.get(bot.id) || { firstSeen: now, issue: '' };
      let issue = '', level = 'info', kind = 'healthy';
      if (bot.status === 'error') { issue = bot.error || '机器人启动失败，请检查配置和权限。'; level = 'error'; kind = 'bot_failed'; }
      else if (!bot.online && now - prior.firstSeen >= 15000) { issue = '消息连接暂时中断，正在等待重连。'; level = 'warning'; kind = 'gateway_offline'; }
      else if (state?.recoveryError) { issue = state.recoveryError; level = 'warning'; kind = 'playback_recovery'; }
      else if (state?.context && state.stayConnected && !state.connected) { issue = '常驻已开启，语音频道尚未连接。'; level = 'warning'; kind = 'voice_disconnected'; }
      else if (state?.connected && player.audio?.connected === false) { issue = '语音发送连接已中断，等待恢复。'; level = 'error'; kind = 'audio_disconnected'; }
      else if (state?.status === 'playing' && Number.isFinite(player.audio?.source?.lastProgress) && now - player.audio.source.lastProgress > 12000) {
        issue = '音源读取超过 12 秒没有新进度，请留意播放恢复情况。'; level = 'warning'; kind = 'source_stalled';
      }
      else if (features?.radio?.enabled && !features.radio.suspended && features.radio.lastError) {
        issue = `自动电台：${features.radio.lastError}`; level = 'warning'; kind = 'radio_failed';
      } else {
        const failed = features?.schedules?.find((rule) => rule.enabled && rule.lastError);
        if (failed) { issue = `定时计划“${failed.name || failed.time}”：${failed.lastError}`; level = 'warning'; kind = 'schedule_failed'; }
      }
      const fingerprint = `${kind}:${issue}`;
      if (issue && fingerprint !== prior.issue) this.record({ botId: bot.id, level, kind, message: issue });
      else if (!issue && prior.issue && prior.issue !== 'healthy:') this.record({ botId: bot.id, level: 'info', kind: 'recovered', message: '机器人连接与播放状态已恢复正常。' });
      this.previous.set(bot.id, { firstSeen: prior.firstSeen, issue: fingerprint });
      return { id: bot.id, name: this.redact(bot.name), online: Boolean(bot.online), connected: Boolean(state?.connected),
        status: state?.status || 'unavailable', source: state?.current?.source || (state?.current ? 'netease' : null),
        trackName: this.redact(state?.current?.name), channelId: state?.context?.voiceChannelId || null,
        volume: state?.volume ?? null, queue: state?.queue?.length ?? 0,
        transport: state?.connected && player?.audio?.connected !== false ? 'connected' : 'disconnected',
        issue: this.redact(issue), level, radio: features?.radio, schedules: features?.schedules };
    });
  }
  invalidateAccount(source, loggedIn) {
    if (this.closed || !(source in this.accountVersions)) return;
    this.accountVersions[source]++;
    this.accounts[source] = { loggedIn: Boolean(loggedIn), status: typeof loggedIn === 'boolean' ? loggedIn ? 'logged_in' : 'logged_out' : 'checking', checkedAt: this.now(), error: '' };
    this.lastAccountAttempt = null;
    if (this.accountPending) this.recheckAccounts = true;
  }
  async refreshAccounts({ force = false } = {}) {
    if (this.closed) return this.accounts;
    if (this.accountPending) return this.accountPending;
    const interval = force ? 60000 : this.accountIntervalMs;
    if (this.lastAccountAttempt !== null && this.now() - this.lastAccountAttempt < interval) return this.accounts;
    this.lastAccountAttempt = this.now();
    const task = Promise.allSettled(['netease', 'qq'].map(async (source) => {
      const version = this.accountVersions[source];
      let next;
      try {
        const account = await this.music.account(source);
        next = { loggedIn: Boolean(account.loggedIn), status: account.loggedIn ? 'logged_in' : account.expired ? 'expired' : 'logged_out', checkedAt: this.now(), error: '' };
      } catch (error) {
        next = { loggedIn: false, status: 'error', checkedAt: this.now(), error: error instanceof UserError ? this.redact(error.message) : '账号状态暂时无法读取。' };
      }
      if (this.closed || this.accountVersions[source] !== version) return;
      const previous = this.accounts[source]; this.accounts[source] = next;
      const name = source === 'qq' ? 'QQ 音乐' : '网易云音乐';
      if (['expired', 'error'].includes(next.status) && (previous.status !== next.status || previous.error !== next.error)) {
        this.record({ level: 'warning', kind: 'account_attention', message: `${name}：${next.status === 'expired' ? '登录已失效，请重新扫码。' : next.error}` });
      } else if (next.loggedIn && ['expired', 'error'].includes(previous.status)) {
        this.record({ level: 'info', kind: 'account_recovered', message: `${name}账号状态已恢复。` });
      }
    })).then(() => this.accounts).finally(() => {
      if (this.accountPending === task) this.accountPending = null;
      if (!this.closed && this.recheckAccounts) { this.recheckAccounts = false; this.lastAccountAttempt = null; void this.refreshAccounts(); }
    });
    this.accountPending = task; return task;
  }
  snapshot() {
    const bots = this.sample();
    return { generatedAt: this.now(), summary: { bots: bots.length, online: bots.filter((b) => b.online).length,
      connected: bots.filter((b) => b.connected).length, playing: bots.filter((b) => b.status === 'playing').length,
      issues: bots.filter((b) => b.issue).length + Object.values(this.accounts).filter((a) => ['expired', 'error'].includes(a.status)).length + (this.storageError ? 1 : 0) },
      bots, accounts: structuredClone(this.accounts), events: this.events.map((event) => this.safeEvent(event)), storageError: this.storageError,
      limitations: '状态反映服务器连接与音源读取情况，实际听音以 KOOK 客户端为准。' };
  }
  start() {
    if (this.timer || this.closed) return;
    this.sample(); void this.refreshAccounts();
    this.timer = setInterval(() => {
      try { this.sample(); } catch { log('health_sample_failed'); }
      void this.refreshAccounts();
    }, 10000);
    this.timer.unref?.();
  }
  async close() { this.closed = true; clearInterval(this.timer); this.timer = null; await this.writeTail; }
}
