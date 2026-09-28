import { KookGateway } from './kook-gateway.js';
import { OPS_CHANNELS, createKookSender, safeOpsText } from './kook.js';

const ID = /^\d{5,30}$/;
const RECEIPT = /^[a-f0-9-]{16,100}$/i;
const COMMANDS = new Set(['状态', '服务器状态', '机器人状态', '网站状态', '修复状态', '运维帮助']);
const MESSAGE_AGE = 5 * 60000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) === null ? '未知' : `${Math.min(100, value).toFixed(0)}%`;
const NAMES = { up: '正常', down: '异常', unknown: '未知', maintenance: '维护中',
  online: '在线', offline: '离线', stopped: '已停止' };
const named = (value, fallback) => safeOpsText(value?.name || value?.id || fallback, 70);
const label = value => NAMES[value] || '未知';

function summary(command, snapshot, category) {
  if (command === '运维帮助') return { category, theme: 'info', title: '运维帮助',
    lines: ['发送：状态、服务器状态、机器人状态、网站状态、修复状态。', '查询指令只读。自动修复按服务器白名单与冷却策略执行，计划停用服务不会被启动。'] };
  if(command==='修复状态'){
    const repair=snapshot?.autoRepair,states=Array.isArray(repair?.states)?repair.states:[],events=Array.isArray(repair?.events)?repair.events:[];
    return{category,theme:states.some(s=>['failed','blocked','unknown'].includes(s.phase))?'warning':'info',title:'自动修复状态',
      lines:[repair?.enabled?`自动修复已开启：连续${repair.policy?.failureThreshold||2}次未获取到健康状态或确认异常后重启，连续2次正常确认恢复；15分钟冷却，每服务每小时最多2次。`:'自动修复尚未开启。',
        ...states.filter(s=>!['idle','recovered'].includes(s.phase)).slice(0,5).map(s=>safeOpsText(s.message||'修复状态待确认')),
        ...events.slice(0,3).map(e=>safeOpsText(`${e.title}：${e.message}`))]};
  }
  const hosts = Array.isArray(snapshot?.hosts) ? snapshot.hosts.slice(0, 100) : [];
  const monitors = Array.isArray(snapshot?.monitors) ? snapshot.monitors.slice(0, 100) : [];
  const showHosts = command === '服务器状态' || command === '状态' && category === 'infra';
  const showBots = command === '机器人状态' || command === '状态' && category === 'infra';
  const showWeb = command === '网站状态' || command === '状态' && category === 'web';
  const lines = []; let problems = false, unknown = false;
  if (showHosts) for (const host of hosts) {
    const state = host.maintenance ? 'maintenance' : host.state;
    problems ||= state === 'down'; unknown ||= !['up', 'down', 'maintenance'].includes(state);
    lines.push(`${named(host, '服务器')}：${label(state)} · CPU ${percent(host.metrics?.cpuPercent)} · 内存 ${percent(host.metrics?.memoryPercent)} · 磁盘 ${percent(host.metrics?.diskPercent)}`);
    const services = Array.isArray(host.services) ? host.services : [];
    const failed = services.filter(service => service.expected !== 'stopped' && service.ok === false);
    if (failed.length) { problems = true; lines.push(`服务需关注：${failed.slice(0, 4).map(service => named(service, '服务')).join('、')}${failed.length > 4 ? '…' : ''}`); }
  }
  if (showBots) for (const host of hosts) for (const bot of (Array.isArray(host.bots) ? host.bots.slice(0, 100) : [])) {
    problems ||= bot.state === 'offline' || bot.health === 'degraded'; unknown ||= !['online', 'offline', 'stopped'].includes(bot.state) || bot.health === 'unknown';
    const healthLabel = bot.health === 'degraded' ? '异常' : bot.health === 'unknown' ? '待确认' : label(bot.state);
    lines.push(`${named(bot, '机器人')}：${healthLabel}${bot.playing === true && !['degraded', 'unknown'].includes(bot.health) ? ' · 正在播放' : ''}${bot.health === 'degraded' && bot.lastError ? ` · ${safeOpsText(bot.lastError, 100)}` : ''}${bot.channelName ? ` · ${safeOpsText(bot.channelName, 70)}` : ''}`);
  }
  if (showWeb) for (const monitor of monitors) {
    const state = monitor.maintenance ? 'maintenance' : monitor.state;
    problems ||= state === 'down'; unknown ||= !['up', 'down', 'maintenance'].includes(state);
    const latency = number(monitor.latencyMs), tlsDays = number(monitor.tlsDays);
    lines.push(`${named(monitor, '网站')}：${label(state)}${latency === null ? '' : ` · ${Math.round(latency)}ms`}${tlsDays === null ? '' : ` · 证书余 ${Math.floor(tlsDays)} 天`}`);
  }
  if (!lines.length) { lines.push('尚无可用监控记录，请打开运维中心查看采集状态。'); unknown = true; }
  if (lines.length > 12) lines.splice(11, lines.length - 11, `另有 ${lines.length - 11} 项，请打开运维中心查看。`);
  return { category, theme: problems || unknown ? 'warning' : 'success',
    title: command === '状态' ? category === 'web' ? '网站与接口状态' : '服务器与机器人状态' : command,
    lines: lines.map(line => safeOpsText(line, 500)) };
}

function bounded(operation, signal, timeoutMs) {
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(Error('cancelled'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(Error('timeout')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), interrupted]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}

async function lookupAuthor({ token, userId, guildId, signal, fetchImpl }) {
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let reader;
  try {
    return await bounded(async () => {
      const url = new URL('https://www.kookapp.cn/api/v3/user/view');
      url.search = new URLSearchParams({ user_id: userId, guild_id: guildId }).toString();
      const response = await fetchImpl(url.href, { redirect: 'manual', method: 'GET', signal: controller.signal, headers: { Authorization: `Bot ${token}` } });
      if (controller.signal.aborted || !response?.ok || response.redirected || Number(response.headers?.get('content-length')) > 32768 || !response.body?.getReader) {
        try { void response?.body?.cancel()?.catch(() => {}); } catch {} return false;
      }
      reader = response.body.getReader(); const chunks = []; let bytes = 0;
      for (;;) {
        if (controller.signal.aborted) return false;
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 32768) return false; chunks.push(Buffer.from(value));
      }
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      return raw?.code === 0 && raw.data?.id === userId && raw.data.bot === false;
    }, signal, 3000);
  } catch { return false; }
  finally { signal.removeEventListener('abort', abort); controller.abort(); try { void reader?.cancel()?.catch(() => {}); } catch {} }
}

/** Read-only explicit queries from humans in the two configured channels; no model calls. */
export class OpsQueryBot {
  #token; #channels; #getSnapshot; #send; #logger; #now; #fetch; #resolveAuthor; #gateway;
  #tail = Promise.resolve(); #controller = new AbortController(); #seen = new Map(); #users = new Map(); #recent = [];
  #identities = new Map(); #identityRecent = [];
  #running = false; #closed = false; #waiting = 0; #counts = { queries: 0, replies: 0, failures: 0 }; #lastError = null; #lastReplyAt = null;
  constructor({ token, channelIds = OPS_CHANNELS, getSnapshot, sendReply, publicUrl = 'https://api.chixiaotao.cn/ops/', logger = () => {},
    fetchImpl = fetch, now = Date.now, Gateway = KookGateway, gatewayOptions = {}, resolveAuthor } = {}) {
    if (typeof token !== 'string' || !/^\S{1,512}$/.test(token) || Object.keys(OPS_CHANNELS).some(key => channelIds?.[key] !== OPS_CHANNELS[key])
      || typeof getSnapshot !== 'function' || sendReply !== undefined && typeof sendReply !== 'function'
      || typeof logger !== 'function' || typeof now !== 'function' || typeof Gateway !== 'function') throw Error('Invalid ops query configuration');
    this.#token = token; this.#channels = { ...OPS_CHANNELS }; this.#getSnapshot = getSnapshot; this.#now = now; this.#fetch = fetchImpl;
    this.#send = sendReply || createKookSender({ token, channelIds, publicUrl, fetchImpl }); this.#logger = logger; this.#resolveAuthor = resolveAuthor;
    this.#gateway = new Gateway({ ...gatewayOptions, token, fetchImpl, logger: event => this.#log(event),
      onEvent: (event, options) => this.handle(event, options) });
  }
  #log(event) { try { this.#logger({ event: /^[a-z_]{1,70}$/.test(event) ? event : 'ops_query_event' }); } catch {} }
  status() { return { enabled: this.#running && !this.#closed, ...this.#counts, connected: this.#gateway.snapshot().connected === true,
    gateway: this.#gateway.snapshot(), lastError: this.#lastError, lastReplyAt: this.#lastReplyAt }; }
  async start() { if (this.#closed || this.#running) return; this.#running = true; await this.#gateway.start(); }
  async #human(userId, guildId, signal) {
    const key = `${guildId}:${userId}`, now = this.#now(), cached = this.#identities.get(key);
    if (cached?.until > now) return cached.human;
    this.#identities.delete(key);
    this.#identityRecent = this.#identityRecent.filter(at => at > now - 60000);
    if (this.#identityRecent.length >= 30) return false;
    this.#identityRecent.push(now);
    const params = { token: this.#token, userId, guildId, signal, fetchImpl: this.#fetch };
    let identity;
    try { identity = await (this.#resolveAuthor ? bounded(() => this.#resolveAuthor(params), signal, 3000) : lookupAuthor(params)); }
    catch { identity = false; }
    const human = identity === true || identity?.id === userId && identity.bot === false;
    if (this.#closed || signal.aborted) return false;
    this.#identities.set(key, { human, until: this.#now() + (human ? 300000 : 10000) });
    while (this.#identities.size > 256) this.#identities.delete(this.#identities.keys().next().value);
    return human;
  }
  handle(event, { signal } = {}) {
    if (this.#closed || !this.#running || this.#waiting >= 32) return Promise.resolve();
    this.#waiting++;
    const task = this.#tail.then(() => this.#handle(event, signal)).catch(() => { this.#counts.failures++; this.#lastError = 'QUERY'; this.#log('ops_query_failed'); })
      .finally(() => { this.#waiting--; });
    this.#tail = task; return task;
  }
  async #handle(event, signal) {
    if (this.#closed || signal?.aborted || !object(event) || event.channel_type !== 'GROUP' || ![1, 9].includes(event.type)
      || typeof event.author_id !== 'string' || !ID.test(event.author_id) || event.author_id === this.#gateway.snapshot().botId
      || typeof event.msg_id !== 'string' || !RECEIPT.test(event.msg_id)) return;
    const category = Object.keys(this.#channels).find(key => this.#channels[key] === event.target_id);
    if (!category) return;
    const author = event.extra?.author;
    if (author?.id !== undefined && author.id !== event.author_id || author?.bot !== undefined && author.bot !== false) return;
    const command = typeof event.extra?.kmarkdown?.raw_content === 'string' ? event.extra.kmarkdown.raw_content.trim()
      : typeof event.content === 'string' ? event.content.trim() : '';
    if (!COMMANDS.has(command)) return;
    const timestamp = event.msg_timestamp, now = this.#now();
    if (!Number.isSafeInteger(timestamp) || timestamp < now - MESSAGE_AGE || timestamp > now + 60000) return;
    for (const [id, at] of this.#seen) if (at < now - MESSAGE_AGE * 2) this.#seen.delete(id);
    for (const [id, at] of this.#users) if (at < now - 3000) this.#users.delete(id);
    this.#recent = this.#recent.filter(at => at > now - 60000);
    if (this.#seen.has(event.msg_id) || this.#seen.size >= 2048 || this.#users.has(event.author_id) || this.#recent.length >= 30) return;
    const combined = signal ? AbortSignal.any([this.#controller.signal, signal]) : this.#controller.signal;
    if (author?.bot !== false) {
      const guildId = event.extra?.guild_id;
      if (typeof guildId !== 'string' || !ID.test(guildId)) return;
      if (!await this.#human(event.author_id, guildId, combined)) return;
    }
    if (this.#closed || combined.aborted || timestamp < this.#now() - MESSAGE_AGE) return;
    this.#seen.set(event.msg_id, now); this.#users.set(event.author_id, now); this.#recent.push(now); this.#counts.queries++;
    const snapshot = command === '运维帮助' ? {} : await bounded(() => this.#getSnapshot(), combined, 5000);
    if (this.#closed || combined.aborted) return;
    try {
      await bounded(() => this.#send(summary(command, snapshot, category), { signal: combined }), combined, 10000);
      if (this.#closed || combined.aborted) return;
      this.#counts.replies++; this.#lastReplyAt = new Date(this.#now()).toISOString(); this.#lastError = null;
    } catch { this.#counts.failures++; this.#lastError = 'DELIVERY'; this.#log('ops_query_delivery_failed'); }
  }
  async close() { if (this.#closed) return; this.#closed = true; this.#running = false; this.#controller.abort(); this.#gateway.close(); await this.#tail; }
}
