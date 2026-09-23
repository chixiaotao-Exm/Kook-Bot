import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KeyUsageError, validateUsageKey } from './key-usage.js';
import { atomicJson } from './storage.js';

const ID = /^\d{5,30}$/;
const MAX_AGE = 5 * 60000;
const MAX_RECORDS = 2048;

export function parseKeyQuery(content, selfId = '') {
  if (typeof content !== 'string' || content.length > 1024) return null;
  let text = content.trim();
  if (ID.test(selfId)) text = text.replace(new RegExp(`^\\(met\\)${selfId}\\(met\\)\\s*`), '');
  const command = /^\/?(?:查询|用量)(?:\s+|$)/.test(text);
  if (command) text = text.replace(/^\/?(?:查询|用量)(?:\s+|$)/, '').trim();
  if (!text && command) return { kind: 'help' };
  if (text.startsWith('```') && text.endsWith('```')) text = text.slice(3, -3).trim();
  else if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1).trim();
  if (!text.startsWith('sk-') && !command) return null;
  try { return { kind: 'key', key: validateUsageKey(text) }; }
  catch { return { kind: 'invalid' }; }
}

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = value => numeric(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '未知';
const money = value => numeric(value) ? value > 0 && value < .01 ? '$<0.01'
  : `$${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未知';
const tokens = value => !numeric(value) ? '未知' : value >= 1e9 ? `${(value / 1e9).toFixed(2)}B`
  : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(2)}K` : number(value);
const timestamp = value => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '未知';
};

export function formatKeyUsageReply(result) {
  const hint = /^sk-…[A-Za-z0-9_-]{4}$/.test(result?.keyHint || '') ? result.keyHint : '已隐藏';
  const lines = [`API Key · ${hint}`];
  const quota = result?.quota || {};
  const remaining = quota.unlimited === true ? '不限额' : money(quota.remaining);
  if (quota.scope === 'account') lines.push(`账户共享余额 ${remaining}`);
  else if (quota.scope === 'subscription') lines.push(`订阅共享剩余 ${remaining}`);
  else if (quota.scope === 'key') {
    lines.push(`Key 剩余 ${remaining}`);
    lines.push(`已用 ${money(quota.used)} / 限额 ${quota.unlimited === true ? '不限额' : money(quota.limit)}`);
  } else lines.push('剩余额度 未知');
  const status = { expired: '已过期', quota_exhausted: '额度用尽', disabled: '已停用' }[result?.status];
  if (status) lines.push(status);
  for (const [key, label] of [['today', '今日'], ['7d', '近7天'], ['total', '累计']]) {
    const stats = key === 'total' ? result?.totals : result?.periods?.find(period => period.key === key);
    lines.push(`${label} ${number(stats?.requests)} 次 · ${tokens(stats?.tokens)} Token · ${money(stats?.cost)}`);
  }
  for (const limit of (Array.isArray(result?.limits) ? result.limits.slice(0, 3) : [])) {
    if (['5h', '1d', '7d'].includes(limit.window)) lines.push(`${limit.window} 限额 ${money(limit.used)} / ${money(limit.limit)} · 剩余 ${money(limit.remaining)}`);
  }
  lines.push(`更新 ${timestamp(result?.queriedAt)} · 北京时间 · 实际扣费 USD`);
  return lines.join('\n');
}

/** Queries only keys explicitly submitted by real users. No message content is persisted. */
export class KookKeyQueryBot {
  #keyUsage; #reply; #getSelfId; #resolveAuthor; #channelIds; #now; #writeState; #logger;
  #file; #seen = new Map(); #users = new Map(); #recent = []; #closed = false;
  #operations = Promise.resolve(); #controller = new AbortController(); #ready = false;
  #counts = { queries: 0, replies: 0, failures: 0 }; #lastReplyAt = null; #lastError = null;
  constructor({ keyUsage, reply, getSelfId, resolveAuthor, channelIds = [], dataDir, now = Date.now, writeState = atomicJson, logger = () => {} }) {
    this.#keyUsage = keyUsage; this.#reply = reply; this.#getSelfId = getSelfId;
    this.#resolveAuthor = resolveAuthor;
    this.#channelIds = new Set(channelIds.filter(value => ID.test(value)));
    this.#now = now; this.#writeState = writeState; this.#logger = logger;
    this.#file = path.join(dataDir, 'key-query-seen.json');
  }
  async init() {
    try {
      const source = await readFile(this.#file, 'utf8');
      if (source.length > 512 * 1024) throw new Error('size');
      const saved = JSON.parse(source);
      if (saved.version !== 1 || !Array.isArray(saved.seen) || saved.seen.length > MAX_RECORDS) throw new Error('format');
      for (const record of saved.seen) {
        if (!record || !/^[a-f0-9-]{16,100}$/i.test(record.id) || !Number.isSafeInteger(record.at)) throw new Error('record');
        if (record.at > this.#now() - MAX_AGE * 2) this.#seen.set(record.id, record.at);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#lastError = 'STORAGE'; return this; }
    }
    this.#ready = true; return this;
  }
  snapshot() { return { enabled: this.#ready && !this.#closed, ...this.#counts, lastReplyAt: this.#lastReplyAt, lastError: this.#lastError }; }
  handle(event) {
    // Gateway awaits each call and applies its own bounded input queue.
    const run = this.#operations.then(() => this.#handle(event));
    this.#operations = run.catch(() => {}); return run;
  }
  async #handle(event) {
    const selfId = this.#getSelfId?.(), author = event?.extra?.author;
    if (this.#closed || !this.#ready || !ID.test(selfId || '') || !event || ![1, 9].includes(event.type)
      || !['GROUP', 'PERSON'].includes(event.channel_type) || event.author_id === selfId
      || !author || typeof author !== 'object' || Array.isArray(author)
      || author.bot !== false && author.bot !== undefined
      || author.id !== undefined && author.id !== event.author_id
      || !ID.test(event.author_id || '') || !/^[a-f0-9-]{16,100}$/i.test(event.msg_id || '')) return;
    if (event.channel_type === 'GROUP' && !this.#channelIds.has(event.target_id)) return;
    const now = this.#now(), time = event.msg_timestamp;
    if (!Number.isSafeInteger(time) || time < now - MAX_AGE || time > now + 60000 || this.#seen.has(event.msg_id)) return;
    // content retains KOOK's machine-readable mention markup; raw_content is
    // also accepted for simple messages whose formatting contains no mention.
    const candidates = [parseKeyQuery(event.content, selfId), parseKeyQuery(event.extra?.kmarkdown?.raw_content, selfId)];
    const parsed = candidates.find(value => value?.kind === 'key') || candidates.find(Boolean);
    if (!parsed) return;
    if (author.bot === undefined) {
      const guildId = event.channel_type === 'PERSON' ? null : event.extra.guild_id;
      if (typeof this.#resolveAuthor !== 'function' || guildId !== null && !ID.test(guildId || '')) return;
      let identity;
      try { identity = await this.#resolveAuthor({ userId: event.author_id, guildId }); }
      catch { return; }
      if (!identity || identity.id !== event.author_id || identity.bot !== false
        || this.#closed || event.msg_timestamp < this.#now() - MAX_AGE) return;
    }
    for (const [id, at] of this.#seen) if (at < now - MAX_AGE * 2) this.#seen.delete(id);
    for (const [id, at] of this.#users) if (at < now - 3000) this.#users.delete(id);
    this.#recent = this.#recent.filter(at => at > now - 60000);
    if (this.#users.has(event.author_id) || this.#recent.length >= 30 || this.#seen.size >= MAX_RECORDS) return;
    this.#seen.set(event.msg_id, now); this.#users.set(event.author_id, now); this.#recent.push(now);
    try {
      await this.#writeState(this.#file, { version: 1, seen: [...this.#seen].map(([id, at]) => ({ id, at })) });
    } catch {
      this.#lastError = 'STORAGE'; this.#ready = false;
      this.#logger({ event: 'key_query_storage_failed' }); return;
    }
    if (this.#closed) return;
    let content;
    if (parsed.kind === 'help') content = '直接发送本站 sk- 开头的完整 API Key，即可查询用量与额度。也支持：查询 API_KEY';
    else if (parsed.kind === 'invalid') content = '每条消息请发送一个完整的 sk- 开头 API Key。';
    else {
      this.#counts.queries++;
      try { content = formatKeyUsageReply(await this.#keyUsage.query(parsed.key)); this.#lastError = null; }
      catch (error) {
        this.#counts.failures++; this.#lastError = 'QUERY';
        content = error instanceof KeyUsageError ? error.message : '用量查询暂不可用，请稍后重试。';
      }
      parsed.key = undefined;
    }
    if (this.#closed) return;
    try {
      await this.#reply({ channelType: event.channel_type, targetId: event.target_id, authorId: event.author_id, content, signal: this.#controller.signal });
      this.#counts.replies++; this.#lastReplyAt = new Date(this.#now()).toISOString();
      this.#logger({ event: 'key_query_replied', channelType: event.channel_type });
    } catch {
      this.#counts.failures++; this.#lastError = 'DELIVERY';
      this.#logger({ event: 'key_query_reply_failed' });
      // The persisted message ID prevents automatic resend after an ambiguous response.
    }
  }
  async close() { this.#closed = true; this.#controller.abort(); await this.#operations; }
}
