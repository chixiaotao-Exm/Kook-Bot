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
const help = rounds => (rounds === 0
  ? '直接发送问题，与两个机器人一起持续讨论，发送“停止”即可结束。\n'
  : `直接发送问题，让两个机器人轮流讨论，默认 ${rounds} 轮，共 ${rounds * 2} 次发言。\n`)
  + '讨论中可以随时补充或调整话题，下一位机器人会先回应你的补充。\n'
  + '“先暂停”：暂停讨论并保留上下文；“继续”：恢复暂停的讨论。\n'
  + '“停止”：停止发言并保留当前话题；“继续”可恢复。只有“新话题”会清空上下文，也可发送“新话题：问题”重新开始。\n'
  + '“互聊状态”：查看进度\n“帮助”：查看说明\n问题最多 2000 字，请勿包含密码或密钥。';

export function parseDuetCommand(content, selfId = '', defaultRounds = 0) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (validId(selfId)) text = text.replace(new RegExp(`^\\(met\\)${selfId}\\(met\\)\\s*`), '').trim();
  if (!text) return null;
  const fresh = /^新话题(?:(?:[：:]\s*|\s+)([\s\S]*))?$/.exec(text);
  if (fresh) {
    const topic = (fresh[1] || '').trim();
    if (CREDENTIAL.test(topic)) return { kind: 'credential' };
    if (topic.length > MAX_TOPIC || !topic.isWellFormed()) return { kind: 'too_long' };
    return { kind: 'new_topic', ...(topic ? { topic } : {}) };
  }
  if (['停止', '停止互聊', '/停止互聊', '/停止'].includes(text)) return { kind: 'stop' };
  if (/^(?:暂停|先暂停|暂停一下|先暂停一下)[。!！]*$/.test(text)) return { kind: 'pause' };
  if (/^(?:继续|恢复|继续讨论|开始)[。!！]*$/.test(text)) return { kind: 'resume' };
  if (text === '互聊状态' || text === '/互聊状态') return { kind: 'status' };
  if (['帮助', '/互聊帮助', '/帮助', '/互聊'].includes(text)) return { kind: 'help' };
  if (!/^\/互聊\s/.test(text)) {
    if (text.startsWith('/')) return null;
    if (CREDENTIAL.test(text)) return { kind: 'credential' };
    if (text.length > MAX_TOPIC || !text.isWellFormed()) return { kind: 'too_long' };
    return { kind: 'start', topic: text, rounds: defaultRounds };
  }
  text = text.replace(/^\/互聊\s+/, '').trim();
  if (!text) return { kind: 'help' };
  if (CREDENTIAL.test(text)) return { kind: 'credential' };
  let rounds = defaultRounds;
  const continuous = /^不限(?:\s+([\s\S]*))?$/.exec(text);
  if (continuous) {
    rounds = 0; text = (continuous[1] || '').trim();
    if (!text) return { kind: 'help' };
  }
  const numbered = /^([+-]?\d+(?:\.\d+)?)(?:\s+([\s\S]*))?$/.exec(text);
  if (numbered && !continuous) {
    if (!/^[0-6]$/.test(numbered[1])) return { kind: 'invalid' };
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
  #counts = { commands: 0, starts: 0, contributions: 0, newTopics: 0, pauses: 0, resumes: 0, stops: 0, replies: 0, failures: 0 };
  #lastError = null; #lastReplyAt = null;

  constructor({ session, reply, getSelfId, getParticipantIds = () => [], resolveAuthor,
    channelId, dataDir, now = Date.now, logger = () => {}, writeState = atomicJson, defaultRounds = 0 } = {}) {
    if (!session || typeof session.start !== 'function' || typeof session.stop !== 'function'
      || typeof session.snapshot !== 'function' || typeof reply !== 'function' || typeof getSelfId !== 'function'
      || typeof getParticipantIds !== 'function' || !validId(channelId) || typeof dataDir !== 'string' || !dataDir
      || typeof now !== 'function' || typeof writeState !== 'function'
      || !Number.isInteger(defaultRounds) || defaultRounds < 0 || defaultRounds > 6) throw new Error('Invalid duet command configuration');
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
    if (parsed.kind === 'new_topic') {
      try {
        const result = typeof this.#session.newTopic === 'function'
          ? await this.#session.newTopic({ ...(parsed.topic ? { topic: parsed.topic } : {}), userId: event.author_id,
            receiptId: event.msg_id, replyMessageId: event.msg_id }) : { accepted: false, reason: 'NOT_READY' };
        if (this.#closed) return;
        if (result?.accepted === true) {
          this.#counts.newTopics++; this.#lastError = null;
          this.#notice(event, parsed.topic ? '已新建话题，接下来围绕你的新问题讨论。' : '已清空话题，直接发问题开始。', true);
        } else if (result?.reason !== 'DUPLICATE') this.#notice(event, result?.reason === 'NOT_AUTHORIZED'
          ? '只有已授权的操作者可以重置当前代码任务的话题。' : '暂时无法新建话题，原话题未确认清空，请稍后重试。', true);
      } catch { this.#failed(event); }
      return;
    }
    if (parsed.kind === 'stop') {
      try {
        const before = this.#session.snapshot(), active = before.active;
        const result = await this.#session.stop({ userId: event.author_id });
        if (result?.reason === 'NOT_AUTHORIZED') { this.#notice(event, '只有已授权的操作者可以控制代码任务。', true); return; }
        this.#counts.stops++;
        this.#notice(event, active || before.threadId
          ? '已停止，保留当前话题；发送“继续”可恢复，发送“新话题”才清空。'
          : '当前没有正在进行的讨论。已有话题会保留，直接发送问题即可继续。');
      } catch { this.#failed(event); }
      return;
    }
    if (parsed.kind === 'pause' || parsed.kind === 'resume') {
      await this.#pauseResume(event, parsed.kind); return;
    }
    const time = this.#now();
    this.#prune(time);
    // Discussion inputs are admitted by the session's bounded pending-input
    // queue. Command/notice cooldowns must never silently discard an interjection.
    if (parsed.kind === 'start') {
      const state = this.#session.snapshot();
      if (state.active || state.paused || state.status === 'paused') {
        await this.#input(event, parsed, true); return;
      }
    }
    if (this.#users.has(event.author_id) || this.#recent.length >= 30) {
      if (parsed.kind === 'start') this.#notice(event, '问题暂未加入，请稍后重新发送。', true);
      return;
    }
    this.#users.set(event.author_id, time); this.#recent.push(time);
    if (parsed.kind === 'help') { this.#notice(event, help(this.#defaultRounds)); return; }
    if (parsed.kind === 'credential') { this.#notice(event, '问题似乎包含密钥，未开始讨论。请删除敏感内容后重试。'); return; }
    if (parsed.kind === 'too_long') { this.#notice(event, '问题过长，请控制在 2000 字以内。'); return; }
    if (parsed.kind === 'invalid') { this.#notice(event, '轮数不符合要求。直接发送问题即可开始讨论，发送“停止”结束。'); return; }
    if (parsed.kind === 'status') {
      const status = this.#session.snapshot();
      const topicHint = status.threadId ? '\n当前话题已保留，发送“新话题”才清空。' : '';
      if (status.mode === 'code') {
        const state = { creating: '准备工作区', coding: '实施中', reviewing: '复核中', running: '处理中', paused: '已暂停',
          publishing: '正在创建 PR', completed: '已完成', audited: '审查完成', needs_input: '需要补充信息', stopped: '已停止', interrupted: '已中断' }[status.status] || '处理中';
        this.#notice(event, `代码任务：${state}\n工具步骤：${Number.isSafeInteger(status.steps) ? status.steps : 0}`
          + (status.prUrl ? `\n${status.prUrl}` : '') + '\n可发送“先暂停”“继续”或“停止”。' + topicHint); return;
      }
      const labels = { idle: '未开始', running: '进行中', paused: '已暂停', completed: '已完成', stopped: '已停止',
        timeout: '已超时停止', failed: '已因错误停止', interrupted: '已中断' };
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const paused = status.paused === true || status.status === 'paused';
      const header = `互聊状态：${paused ? '已暂停' : labels[status.status] || (status.active ? '进行中' : '未开始')}\n`;
      const inputHint = paused ? '补充会被记录，发送“继续”恢复讨论。' : '你可以随时补充问题。';
      if (status.unlimited === true || status.rounds === 0) {
        const speaker = typeof status.currentSpeaker === 'string' && /^[\p{L}\p{N} _·-]{1,40}$/u.test(status.currentSpeaker)
          && !CREDENTIAL.test(status.currentSpeaker) ? status.currentSpeaker : '等待中';
        this.#notice(event, header + (status.active || paused
          ? `第 ${Math.max(1, count(status.currentRound))} 轮 · 已发 ${count(status.completedTurns)} 条\n当前发言方：${speaker}\n${inputHint}`
          : `已发 ${count(status.completedTurns)} 条。`) + topicHint);
      } else this.#notice(event, header + `已完成 ${count(status.completedTurns)} / ${count(status.totalTurns)} 次发言。`
        + (status.active || paused ? `\n${inputHint}` : '') + topicHint);
      return;
    }
    await this.#input(event, parsed, false);
  }

  async #pauseResume(event, kind) {
    try {
      const method = this.#session[kind];
      const result = typeof method === 'function' ? await method.call(this.#session, { userId: event.author_id, receiptId: event.msg_id, replyMessageId: event.msg_id }) : { reason: 'NOT_READY' };
      if (this.#closed) return;
      if (result?.reason === 'NOT_AUTHORIZED') { this.#notice(event, '只有已授权的操作者可以控制代码任务。', true); return; }
      if (kind === 'pause') {
        if (result?.paused === true) {
          this.#counts.pauses++; this.#lastError = null;
          this.#notice(event, '已暂停讨论，保留当前上下文。发送“继续”恢复，发送“停止”结束。', true);
        } else this.#notice(event, result?.reason === 'ALREADY_PAUSED'
          ? '讨论已经暂停。发送“继续”恢复，发送“停止”结束。'
          : result?.reason === 'NO_ACTIVE' ? '当前没有可暂停的讨论。直接发送一个问题即可开始。'
            : '暂时无法暂停讨论，请稍后重试。', true);
      } else if (result?.resumed === true) {
        this.#counts.resumes++; this.#lastError = null;
        this.#notice(event, '已恢复讨论，会继续回应暂停期间记录的补充。', true);
      } else this.#notice(event, result?.reason === 'NOT_PAUSED'
        ? '当前讨论没有暂停，你可以直接补充问题。'
        : result?.reason === 'NO_ACTIVE' ? '当前没有可恢复的讨论。直接发送一个问题即可开始。'
          : '暂时无法恢复讨论，请稍后重试。', true);
    } catch { this.#failed(event); }
  }

  async #input(event, parsed, contributeFirst) {
    const start = () => this.#session.start({ topic: parsed.topic, rounds: parsed.rounds,
      userId: event.author_id, receiptId: event.msg_id, replyMessageId: event.msg_id });
    const contribute = () => typeof this.#session.contribute === 'function'
      ? this.#session.contribute({ text: parsed.topic, userId: event.author_id, receiptId: event.msg_id, replyMessageId: event.msg_id })
      : { accepted: false, reason: 'NOT_READY' };
    let contribution = contributeFirst;
    try {
      let result = await (contribution ? contribute() : start());
      if (this.#closed) return;
      // The active state can change between snapshot and admission. Permit one
      // alternate route with the same receipt; never retry either operation.
      if (contribution && result?.reason === 'NO_ACTIVE') {
        contribution = false; result = await start();
      } else if (!contribution && result?.reason === 'BUSY') {
        contribution = true; result = await contribute();
      }
      if (this.#closed) return;
      if (result?.accepted === true) {
        if (result.mode === 'code') {
          this.#lastError = null;
          if (result.taskStarted || !contribution) this.#counts.starts++; else this.#counts.contributions++;
          this.#notice(event, result.taskStarted || !contribution
            ? '已开始代码任务：思维1读取和修改隔离副本，思维2复核；测试通过后创建 PR。可发送“先暂停”“继续”或“停止”。'
            : '已记录你的补充，后续代码操作与复核会结合新要求。'); return;
        }
        if (contribution) {
          this.#counts.contributions++; this.#lastError = null;
          const state = this.#session.snapshot();
          this.#notice(event, state.paused === true || state.status === 'paused'
            ? '已记录补充，发送“继续”恢复讨论。'
            : '已加入讨论，下一位机器人会先回应你的补充。'); return;
        }
        this.#counts.starts++; this.#lastError = null;
        const rounds = Number.isInteger(result.rounds) && result.rounds >= 0 && result.rounds <= 6 ? result.rounds : parsed.rounds;
        const totalTurns = Number.isInteger(result.totalTurns) && result.totalTurns >= 2 && result.totalTurns <= 12 ? result.totalTurns : rounds * 2;
        this.#notice(event, result.unlimited === true || rounds === 0
          ? '已开始持续讨论。你可以随时补充问题，发送“停止”可结束。'
          : `已开始讨论：${rounds} 轮，共 ${totalTurns} 次发言。你可以随时补充问题，发送“停止”可结束。`);
      } else if (result?.reason !== 'DUPLICATE') {
        this.#notice(event, result?.reason === 'NOT_AUTHORIZED' ? '只有已授权的操作者可以启动或修改代码任务。'
          : result?.reason === 'REPOSITORY_NOT_ALLOWED' ? '目前代码任务只支持 chixiaotao-Exm/Kook-Bot。'
          : result?.reason === 'CODE_DISABLED' ? '代码执行能力尚未启用。'
          : result?.reason === 'CAPACITY' ? '补充暂未加入：待回应内容较多，请稍后重新发送。'
          : result?.reason === 'FINISHING' ? '这轮讨论正在结束，这条补充暂未加入，请稍后再发。'
          : result?.reason === 'INVALID_INPUT' ? '问题或轮数不符合要求，请发送“帮助”查看说明。'
            : '问题暂未加入，讨论状态正在变化或暂时不可用，请稍后重新发送。', true);
      }
    } catch { this.#failed(event); }
  }

  #failed(event) {
    this.#counts.failures++; this.#lastError = 'SESSION'; this.#log('duet_session_command_failed');
    this.#notice(event, '互聊暂时不可用，请稍后重试。');
  }

  #notice(event, content, important = false) {
    const now = this.#now(); this.#prune(now);
    if (this.#closed || this.#tasks.size >= 2 || (!important && this.#noticeUsers.has(event.author_id)) || this.#recentNotices.length >= 30) return;
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
