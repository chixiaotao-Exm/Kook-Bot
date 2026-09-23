import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';

const ID = /^\d{5,30}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const validId = value => typeof value === 'string' && ID.test(value);
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const MAX_AGE = 5 * 60_000, SEEN_TTL = 10 * 60_000, MAX_RECEIPTS = 2048;
const MAX_TOPIC = 2000;
const CREDENTIAL = /(?:\bsk-[a-z0-9_-]{12,}|\badmin-[a-f0-9]{16,}|\b\d{1,4}\/[a-z0-9+/=]{4,}\/[a-z0-9+/=]{10,}|\bauthorization\s*:\s*bearer\s+\S{12,})/i;
const help = rounds => `发送 /互聊 话题，让两个机器人轮流讨论，默认 ${rounds} 轮，共 ${rounds * 2} 次发言。\n`
  + '也可发送 /互聊 2 话题，指定 1～6 轮。\n/停止互聊：停止当前讨论，任何用户都可以停止。\n'
  + '/互聊状态：查看进度\n/互聊帮助：查看说明\n话题最多 2000 字，请勿包含密码或密钥。';

export function parseDuetCommand(content, selfId = '', defaultRounds = 6) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (validId(selfId)) text = text.replace(new RegExp(`^\\(met\\)${selfId}\\(met\\)\\s*`), '').trim();
  if (text === '/停止互聊' || text === '/停止') return { kind: 'stop' };
  if (text === '/互聊状态') return { kind: 'status' };
  if (text === '/互聊帮助' || text === '/帮助' || text === '/互聊') return { kind: 'help' };
  if (!/^\/互聊\s/.test(text)) return null;
  text = text.replace(/^\/互聊\s+/, '').trim();
  if (!text) return { kind: 'help' };
  if (CREDENTIAL.test(text)) return { kind: 'credential' };
  let rounds = defaultRounds;
  const numbered = /^([+-]?\d+(?:\.\d+)?)(?:\s+([\s\S]*))?$/.exec(text);
  if (numbered) {
    if (!/^[1-6]$/.test(numbered[1])) return { kind: 'invalid' };
    rounds = Number(numbered[1]); text = (numbered[2] || '').trim();
    if (!text) return { kind: 'help' };
  }
  if (text.length > MAX_TOPIC || !text.isWellFormed()) return { kind: 'too_long' };
  return { kind: 'start', topic: text, rounds };
}

/** Human-only controls; message receipts persist, topics and user identities do not. */
export class DuetCommands {
  #session; #reply; #getSelfId; #getParticipantIds; #resolveAuthor; #channelId; #file;
  #now; #writeState; #logger; #defaultRounds; #seen = new Map(); #users = new Map(); #recent = [];
  #noticeUsers = new Map(); #recentNotices = []; #tasks = new Set(); #controllers = new Set();
  #operations = Promise.resolve(); #ready = false; #closed = false;
  #counts = { commands: 0, starts: 0, stops: 0, replies: 0, failures: 0 };
  #lastError = null; #lastReplyAt = null;

  constructor({ session, reply, getSelfId, getParticipantIds = () => [], resolveAuthor,
    channelId, dataDir, now = Date.now, logger = () => {}, writeState = atomicJson, defaultRounds = 6 } = {}) {
    if (!session || typeof session.start !== 'function' || typeof session.stop !== 'function'
      || typeof session.snapshot !== 'function' || typeof reply !== 'function' || typeof getSelfId !== 'function'
      || typeof getParticipantIds !== 'function' || !validId(channelId) || typeof dataDir !== 'string' || !dataDir
      || typeof now !== 'function' || typeof writeState !== 'function'
      || !Number.isInteger(defaultRounds) || defaultRounds < 1 || defaultRounds > 6) throw new Error('Invalid duet command configuration');
    this.#session = session; this.#reply = reply; this.#getSelfId = getSelfId;
    this.#getParticipantIds = getParticipantIds; this.#resolveAuthor = resolveAuthor; this.#channelId = channelId;
    this.#file = path.join(dataDir, 'duet-seen.json'); this.#now = now; this.#writeState = writeState; this.#logger = logger;
    this.#defaultRounds = defaultRounds;
  }

  async init() {
    try {
      const source = await readFile(this.#file, 'utf8');
      if (source.length > 512 * 1024) throw new Error('size');
      const saved = JSON.parse(source);
      if (saved.version !== 1 || !Array.isArray(saved.seen) || saved.seen.length > MAX_RECEIPTS) throw new Error('format');
      for (const row of saved.seen) {
        if (!row || !validMessageId(row.id) || !Number.isSafeInteger(row.at) || row.at > this.#now() + 60_000) throw new Error('record');
        if (row.at >= this.#now() - SEEN_TTL) this.#seen.set(row.id, row.at);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#lastError = 'STORAGE'; return this; }
    }
    this.#ready = true; return this;
  }

  snapshot() {
    this.#prune(this.#now());
    return { enabled: this.#ready && !this.#closed, ...this.#counts, seenCount: this.#seen.size,
      pendingNotices: this.#tasks.size, lastError: this.#lastError, lastReplyAt: this.#lastReplyAt };
  }

  handle(event) {
    const operation = this.#operations.then(() => this.#receive(event)).catch(() => {
      this.#counts.failures++; this.#lastError = 'INTERNAL'; this.#log('duet_command_failed');
    });
    this.#operations = operation; return operation;
  }

  #prune(now) {
    for (const [id, at] of this.#seen) if (at < now - SEEN_TTL) this.#seen.delete(id);
    for (const map of [this.#users, this.#noticeUsers]) for (const [id, at] of map) if (at <= now - 3000) map.delete(id);
    this.#recent = this.#recent.filter(at => at > now - 60_000);
    this.#recentNotices = this.#recentNotices.filter(at => at > now - 60_000);
  }

  async #receive(event) {
    const selfId = this.#getSelfId(), author = event?.extra?.author;
    if (!this.#ready || this.#closed || !validId(selfId) || !event
      || ![1, 9].includes(event.type) || event.channel_type !== 'GROUP' || event.target_id !== this.#channelId
      || !validId(event.author_id) || event.author_id === selfId || !validMessageId(event.msg_id)
      || !author || typeof author !== 'object' || Array.isArray(author)
      || (author.bot !== false && author.bot !== undefined)
      || (author.id !== undefined && author.id !== event.author_id)) return;
    const participants = this.#getParticipantIds();
    if ((Array.isArray(participants) || participants instanceof Set) && [...participants].includes(event.author_id)) return;
    const now = this.#now();
    if (!Number.isSafeInteger(event.msg_timestamp) || event.msg_timestamp < now - MAX_AGE || event.msg_timestamp > now + 60_000) return;
    const parsed = parseDuetCommand(event.content, selfId, this.#defaultRounds);
    if (!parsed) return;
    this.#prune(now);
    if (this.#seen.has(event.msg_id)) return;
    if (this.#seen.size >= MAX_RECEIPTS) { this.#lastError = 'CAPACITY'; return; }
    if (author.bot === undefined) {
      if (typeof this.#resolveAuthor !== 'function' || !validId(event.extra.guild_id)) return;
      try {
        const identity = await this.#resolveAuthor({ userId: event.author_id, guildId: event.extra.guild_id });
        if (!identity || identity.id !== event.author_id || identity.bot !== false) return;
      } catch { return; }
      if (this.#closed || event.msg_timestamp < this.#now() - MAX_AGE) return;
    }
    this.#seen.set(event.msg_id, this.#now());
    try { await this.#writeState(this.#file, { version: 1, seen: [...this.#seen].map(([id, at]) => ({ id, at })) }); }
    catch { this.#ready = false; this.#counts.failures++; this.#lastError = 'STORAGE'; this.#log('duet_receipt_storage_failed'); return; }
    if (this.#closed) return;
    this.#counts.commands++;
    if (parsed.kind === 'stop') {
      try {
        const active = this.#session.snapshot().active;
        await this.#session.stop(); this.#counts.stops++;
        this.#notice(event, active ? '已停止互聊。' : '当前没有正在进行的互聊。');
      } catch { this.#failed(event); }
      return;
    }
    const time = this.#now();
    this.#prune(time);
    if (this.#users.has(event.author_id) || this.#recent.length >= 30) return;
    this.#users.set(event.author_id, time); this.#recent.push(time);
    if (parsed.kind === 'help') { this.#notice(event, help(this.#defaultRounds)); return; }
    if (parsed.kind === 'credential') { this.#notice(event, '话题似乎包含密钥，未启动互聊。请删除敏感内容后重试。'); return; }
    if (parsed.kind === 'too_long') { this.#notice(event, '话题过长，请控制在 2000 字以内。'); return; }
    if (parsed.kind === 'invalid') { this.#notice(event, '轮数应为 1～6。例如：/互聊 2 人工智能如何改变生活'); return; }
    if (parsed.kind === 'status') {
      const status = this.#session.snapshot();
      const labels = { idle: '未开始', running: '进行中', completed: '已完成', stopped: '已停止',
        timeout: '已超时停止', failed: '已因错误停止', interrupted: '已中断' };
      const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 12 ? value : 0;
      this.#notice(event, `互聊状态：${labels[status.status] || (status.active ? '进行中' : '未开始')}\n`
        + `已完成 ${count(status.completedTurns)} / ${count(status.totalTurns)} 次发言。`); return;
    }
    try {
      const result = await this.#session.start({ topic: parsed.topic, rounds: parsed.rounds,
        userId: event.author_id, receiptId: event.msg_id, replyMessageId: event.msg_id });
      if (result?.accepted === true) {
        this.#counts.starts++; this.#lastError = null;
        const rounds = Number.isInteger(result.rounds) && result.rounds >= 1 && result.rounds <= 6 ? result.rounds : parsed.rounds;
        const totalTurns = Number.isInteger(result.totalTurns) && result.totalTurns >= 2 && result.totalTurns <= 12 ? result.totalTurns : rounds * 2;
        this.#notice(event, `已开始互聊：${rounds} 轮，共 ${totalTurns} 次发言。发送 /停止互聊 可随时停止。`);
      } else if (result?.reason !== 'DUPLICATE') {
        this.#notice(event, result?.reason === 'BUSY' ? '已有互聊正在进行。可发送 /停止互聊 后重新开始。'
          : result?.reason === 'INVALID_INPUT' ? '话题或轮数不符合要求，请发送 /互聊帮助 查看用法。'
            : '互聊暂时不可用，请稍后重试。');
      }
    } catch { this.#failed(event); }
  }

  #failed(event) {
    this.#counts.failures++; this.#lastError = 'SESSION'; this.#log('duet_session_command_failed');
    this.#notice(event, '互聊暂时不可用，请稍后重试。');
  }

  #notice(event, content) {
    const now = this.#now(); this.#prune(now);
    if (this.#closed || this.#tasks.size >= 2 || this.#noticeUsers.has(event.author_id) || this.#recentNotices.length >= 30) return;
    this.#noticeUsers.set(event.author_id, now); this.#recentNotices.push(now);
    const controller = new AbortController(); this.#controllers.add(controller);
    const task = (async () => {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 10000); });
      try {
        await Promise.race([this.#reply({ targetId: this.#channelId, replyMessageId: event.msg_id, content, signal: controller.signal }), timeout]);
        if (!this.#closed && !controller.signal.aborted) { this.#counts.replies++; this.#lastReplyAt = new Date(this.#now()).toISOString(); }
      } catch {
        if (!this.#closed) { this.#counts.failures++; this.#lastError = 'DELIVERY'; this.#log('duet_command_reply_failed'); }
      } finally { clearTimeout(timer); this.#controllers.delete(controller); }
    })();
    this.#tasks.add(task); void task.finally(() => this.#tasks.delete(task));
  }

  #log(event) { try { this.#logger({ event }); } catch {} }

  async close() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    let timer;
    try { await Promise.race([Promise.allSettled([this.#operations, ...this.#tasks]), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(timer); }
  }
}
