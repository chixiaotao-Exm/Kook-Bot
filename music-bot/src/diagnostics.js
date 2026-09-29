import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, log } from './util.js';
import { SOURCE_NAMES } from './music-sources.js';

const LIMIT = 300;
const levels = new Set(['info', 'warning', 'error']);

export class Diagnostics {
  constructor(config, manager, music, { now = Date.now, accountIntervalMs = 300000, accountTimeoutMs = 25000 } = {}) {
    Object.assign(this, { config, manager, music, now, accountIntervalMs, accountTimeoutMs });
    this.file = path.join(config.dataDir, 'health-events.json');
    this.events = []; this.accounts = {}; this.previous = new Map(); this.attached = new WeakSet();
    this.writeTail = Promise.resolve(); this.closed = false; this.persistDisabled = false;
    this.accountPending = null; this.lastAccountAttempt = null; this.storageError = '';
    this.accountSources = this.music.sources?.().filter((item) => item.enabled).map((item) => item.id) || ['netease', 'qq'];
    this.accountVersions = Object.fromEntries(this.accountSources.map((source) => [source, 0])); this.recheckAccounts = false;
    this.accountRequests = new Map();
    for (const source of this.accountSources) this.accounts[source] = { loggedIn: false, status: 'checking', cookieStatus: 'checking', checkedAt: 0,
      lastSuccessAt: null, nextCheckAt: this.now(), checkIntervalMs: this.accountIntervalMs, stale: false, error: '' };
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
    const secrets = [this.config.token, this.config.cookie, this.config.qishuiApiToken];
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
    this.accountRequests.get(source)?.controller.abort();
    this.accounts[source] = { loggedIn: false, status: loggedIn === false ? 'logged_out' : 'checking', cookieStatus: loggedIn === false ? 'missing' : 'checking',
      checkedAt: loggedIn === false ? this.now() : 0, lastSuccessAt: null, nextCheckAt: this.now(), checkIntervalMs: this.accountIntervalMs, stale: false, error: '' };
    this.lastAccountAttempt = null;
    if (this.accountPending) this.recheckAccounts = true;
  }
  async checkAccount(source) {
    // An uncooperative provider may outlive our deadline. Keep its slot until
    // the real call settles so recurring checks cannot pile up hidden requests.
    if (this.accountRequests.has(source)) throw new Error('ACCOUNT_CHECK_PENDING');
    const controller = new AbortController(), entry = { controller, version: this.accountVersions[source] };
    const request = Promise.resolve().then(() => this.music.account(source, { signal: controller.signal }));
    this.accountRequests.set(source, entry);
    const settled = request.finally(() => { if (this.accountRequests.get(source) === entry) this.accountRequests.delete(source); });
    let timer, aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(new Error('ACCOUNT_CHECK_CANCELLED'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => { reject(new Error('ACCOUNT_CHECK_TIMEOUT')); controller.abort(); }, this.accountTimeoutMs);
    });
    try { return await Promise.race([settled, cancellation]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); }
  }
  async refreshAccounts({ force = false } = {}) {
    if (this.closed) return this.accounts;
    if (this.accountPending) return this.accountPending;
    const interval = force ? 60000 : this.accountIntervalMs;
    if (this.lastAccountAttempt !== null && this.now() - this.lastAccountAttempt < interval) return this.accounts;
    this.lastAccountAttempt = this.now();
    const task = Promise.allSettled(this.accountSources.map(async (source) => {
      const version = this.accountVersions[source], previous = this.accounts[source];
      const nextCheckAt = this.lastAccountAttempt + this.accountIntervalMs;
      if (previous.cookieStatus === 'missing' && this.accountRequests.has(source) && this.accountRequests.get(source).version !== version) {
        this.accounts[source] = { ...previous, nextCheckAt }; return;
      }
      this.accounts[source] = { ...previous, loggedIn: false, status: 'checking', cookieStatus: 'checking', stale: false, nextCheckAt, error: '' };
      let next;
      try {
        const account = await this.checkAccount(source);
        if (!account || typeof account !== 'object' || typeof account.loggedIn !== 'boolean'
          || account.status === 'unknown' || account.status === 'error' || account.cookieStatus === 'unknown') throw new Error('ACCOUNT_CHECK_UNKNOWN');
        const cookieStatus = account.unavailable ? 'unavailable' : account.loggedIn ? 'valid' : account.expired ? 'expired' : 'missing';
        next = { loggedIn: cookieStatus === 'valid', status: { valid: 'logged_in', expired: 'expired', missing: 'logged_out', unavailable: 'unavailable' }[cookieStatus],
          cookieStatus, checkedAt: this.now(), lastSuccessAt: cookieStatus === 'valid' ? this.now() : previous.lastSuccessAt,
          nextCheckAt, checkIntervalMs: this.accountIntervalMs, stale: false, error: '' };
      } catch (error) {
        next = { loggedIn: false, status: 'error', cookieStatus: 'unknown', checkedAt: this.now(), lastSuccessAt: previous.lastSuccessAt,
          nextCheckAt, checkIntervalMs: this.accountIntervalMs, stale: false,
          error: ['ACCOUNT_CHECK_TIMEOUT','ACCOUNT_CHECK_PENDING'].includes(error?.message) ? '账号检测超时，暂无法确认 Cookie 是否有效。' : '账号状态暂时无法读取，未判定 Cookie 失效。' };
      }
      if (this.closed || this.accountVersions[source] !== version) return;
      this.accounts[source] = next;
      const name = SOURCE_NAMES[source];
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
    const bots = this.sample(), now = this.now();
    const accounts = Object.fromEntries(Object.entries(this.accounts).map(([source, account]) => {
      const stale = account.checkedAt > 0 && (now < account.checkedAt || now - account.checkedAt > this.accountIntervalMs + this.accountTimeoutMs + 10000);
      return [source, stale && account.cookieStatus !== 'checking' ? { ...account, loggedIn: false, status: 'error', cookieStatus: 'unknown', stale: true,
        error: '账号检测结果已过期，等待重新检测。' } : { ...account, stale: false }];
    }));
    return { generatedAt: this.now(), summary: { bots: bots.length, online: bots.filter((b) => b.online).length,
      connected: bots.filter((b) => b.connected).length, playing: bots.filter((b) => b.status === 'playing').length,
      issues: bots.filter((b) => b.issue).length + Object.values(accounts).filter((a) => ['expired', 'error'].includes(a.status)).length + (this.storageError ? 1 : 0) },
      bots, accounts, events: this.events.map((event) => this.safeEvent(event)), storageError: this.storageError,
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
  async close() { this.closed = true; clearInterval(this.timer); this.timer = null; for (const entry of this.accountRequests.values()) entry.controller.abort(); await this.writeTail; }
}
