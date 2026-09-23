import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';
import { modelFailureMessage, sanitizeDurationMs, sanitizeFailureCode } from './failure.js';

const ID = /^\d{5,30}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const validId = value => typeof value === 'string' && ID.test(value);
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const MAX_EVENT_AGE = 5 * 60_000;
const SEEN_TTL = 10 * 60_000;
const MAX_RECEIPTS = 2048;
const MAX_ASSISTANT_HISTORY_CHARS = 6000;
const HISTORY_TRUNCATED = '\n\n（本条回复较长，历史上下文仅保留前部内容。）';
const HELP = '直接在本频道发送文字即可与 AI 对话，回复在本频道公开可见。每位用户的对话独立保留 2 小时。\n/重置 或 /清空对话：开始新对话\n/模型：查看模型\n/帮助：查看帮助\n请勿发送密码、API Key 或机器人 Token。';
const CREDENTIAL = /(?:\bsk-[a-z0-9_-]{12,}|\badmin-[a-f0-9]{16,}|\b\d{1,4}\/[a-z0-9+/=]{4,}\/[a-z0-9+/=]{10,}|\bauthorization\s*:\s*bearer\s+\S{12,})/i;

function assistantHistory(response) {
  if (typeof response.historyText === 'string' && response.historyText.trim()
    && response.historyText.length <= MAX_ASSISTANT_HISTORY_CHARS && response.historyText.isWellFormed()) return response.historyText;
  const text = response.text.toWellFormed();
  if (text.length <= MAX_ASSISTANT_HISTORY_CHARS) return text;
  return text.slice(0, MAX_ASSISTANT_HISTORY_CHARS - HISTORY_TRUNCATED.length)
    .replace(/[\uD800-\uDBFF]$/, '').trimEnd() + HISTORY_TRUNCATED;
}

export function parseChatMessage(content, selfId = '') {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (validId(selfId)) text = text.replace(new RegExp(`^\\(met\\)${selfId}\\(met\\)\\s*`), '').trim();
  if (!text) return null;
  if (text === '/重置' || text === '/清空对话') return { kind: 'reset' };
  if (text === '/帮助') return { kind: 'help' };
  if (text === '/模型') return { kind: 'model' };
  if (CREDENTIAL.test(text)) return { kind: 'credential' };
  return { kind: 'chat', text };
}

/** A receipt is persisted before model work; conversation content stays in memory. */
export class AiChatBot {
  #generate; #reply; #progress; #getSelfId; #resolveAuthor; #channelId; #now; #writeState; #logger; #file; #config;
  #seen = new Map(); #contexts = new Map(); #active = new Set(); #perUser = new Map();
  #controllers = new Set(); #tasks = new Set(); #recent = []; #hints = new Map(); #recentHints = [];
  #receipts = Promise.resolve(); #ready = false; #closed = false;
  #counts = { requests: 0, replies: 0, failures: 0, resets: 0, rejected: 0 };
  #lastReplyAt = null; #lastError = null; #lastErrorCode = null;

  constructor({ generate, reply, progress, getSelfId, resolveAuthor, channelId, dataDir, now = Date.now,
    writeState = atomicJson, logger = () => {}, model = 'gpt-6-astra',
    maxInputChars = 4000, maxHistoryChars = 20_000, maxHistoryTurns = 10,
    historyTtlMs = 2 * 60 * 60_000, cooldownMs = 3000, maxConcurrent = 2,
    maxRequestsPerMinute = 30, closeTimeoutMs = 1500 } = {}) {
    if (typeof generate !== 'function' || typeof reply !== 'function' || !validId(channelId) || !dataDir)
      throw new Error('Invalid chat bot configuration');
    this.#generate = generate; this.#reply = reply; this.#progress = progress;
    this.#getSelfId = getSelfId; this.#resolveAuthor = resolveAuthor;
    this.#channelId = channelId; this.#now = now; this.#writeState = writeState; this.#logger = logger;
    this.#file = path.join(dataDir, 'seen.json');
    this.#config = { model, maxInputChars, maxHistoryChars, maxHistoryTurns, historyTtlMs,
      cooldownMs, maxConcurrent, maxRequestsPerMinute, closeTimeoutMs };
  }

  async init() {
    try {
      const source = await readFile(this.#file, 'utf8');
      if (source.length > 512 * 1024) throw new Error('size');
      const saved = JSON.parse(source);
      if (saved.version !== 1 || !Array.isArray(saved.seen) || saved.seen.length > MAX_RECEIPTS) throw new Error('format');
      for (const row of saved.seen) {
        if (!row || !validMessageId(row.id) || !Number.isSafeInteger(row.at) || row.at > this.#now() + 60_000)
          throw new Error('record');
        if (row.at >= this.#now() - SEEN_TTL) this.#seen.set(row.id, row.at);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#lastError = 'STORAGE'; this.#lastErrorCode = null; return this; }
    }
    this.#ready = true; return this;
  }

  snapshot() {
    this.#prune(this.#now());
    return { enabled: this.#ready && !this.#closed, model: this.#config.model, channelId: this.#channelId,
      ...this.#counts, active: this.#active.size, activeRequests: this.#active.size, conversations: this.#contexts.size,
      lastReplyAt: this.#lastReplyAt, lastError: this.#lastError, lastErrorCode: this.#lastErrorCode };
  }

  handle(event) {
    const operation = this.#receipts.then(() => this.#receive(event));
    this.#receipts = operation.catch(() => {});
    return operation;
  }

  #prune(now) {
    for (const [id, at] of this.#seen) if (at < now - SEEN_TTL) this.#seen.delete(id);
    for (const [id, state] of this.#contexts) {
      if (!this.#perUser.has(id) && state.at < now - this.#config.historyTtlMs) this.#contexts.delete(id);
    }
    for (const [id, at] of this.#hints) if (at <= now - 10_000) this.#hints.delete(id);
    this.#recent = this.#recent.filter(at => at > now - 60_000);
    this.#recentHints = this.#recentHints.filter(at => at > now - 60_000);
  }

  async #receive(event) {
    const selfId = this.#getSelfId?.(), author = event?.extra?.author;
    if (!this.#ready || this.#closed || !validId(selfId) || !event
      || ![1, 9].includes(event.type) || event.channel_type !== 'GROUP' || event.target_id !== this.#channelId
      || !author || typeof author !== 'object' || Array.isArray(author)
      || (author.bot !== false && author.bot !== undefined)
      || !validId(event.author_id) || event.author_id === selfId
      || (author.id !== undefined && author.id !== event.author_id)
      || !validMessageId(event.msg_id)) return;
    const now = this.#now();
    if (!Number.isSafeInteger(event.msg_timestamp) || event.msg_timestamp < now - MAX_EVENT_AGE
      || event.msg_timestamp > now + 60_000) return;
    const parsed = parseChatMessage(event.content, selfId);
    if (!parsed) return;
    this.#prune(now);
    if (this.#seen.has(event.msg_id)) return;
    if (this.#seen.size >= MAX_RECEIPTS) { this.#lastError = 'CAPACITY'; this.#lastErrorCode = null; return; }
    if (author.bot === undefined) {
      if (typeof this.#resolveAuthor !== 'function' || !validId(event.extra.guild_id)) return;
      try {
        const resolved = await this.#resolveAuthor({ userId: event.author_id, guildId: event.extra.guild_id });
        if (!resolved || resolved.id !== event.author_id || resolved.bot !== false) return;
      } catch { return; }
      if (this.#closed || event.msg_timestamp < this.#now() - MAX_EVENT_AGE) return;
    }
    this.#seen.set(event.msg_id, now);
    try { await this.#writeState(this.#file, { version: 1, seen: [...this.#seen].map(([id, at]) => ({ id, at })) }); }
    catch { this.#ready = false; this.#lastError = 'STORAGE'; this.#lastErrorCode = null; this.#log('receipt_storage_failed'); return; }
    if (this.#closed) return;
    const key = `${this.#channelId}:${event.author_id}`;
    let state = this.#contexts.get(key);
    if (parsed.kind === 'reset') {
      if (state) { state.epoch++; state.messages = []; state.at = now; state.requestAt = null; }
      this.#perUser.get(key)?.controller.abort();
      this.#perUser.delete(key);
      this.#counts.resets++;
      this.#notice(event, key, '已清空你的对话，下一条消息将开始新对话。', 'reset'); return;
    }
    if (parsed.kind === 'help') { this.#notice(event, key, HELP, 'help'); return; }
    if (parsed.kind === 'model') { this.#notice(event, key, `当前模型：${this.#config.model}`, 'model'); return; }
    if (parsed.kind === 'credential') {
      this.#counts.rejected++;
      this.#notice(event, key, '这条消息似乎包含 API Key 或机器人 Token，未发送给 AI。请删除敏感内容后重发。'); return;
    }
    if (parsed.text.length > this.#config.maxInputChars || parsed.text.length > this.#config.maxHistoryChars) {
      this.#counts.rejected++;
      this.#notice(event, key, `消息过长，请控制在 ${this.#config.maxInputChars} 字以内。`); return;
    }
    if (this.#perUser.has(key)) { this.#notice(event, key, '你的上一条消息还在处理中，请稍候。'); return; }
    if (state?.requestAt != null && state.requestAt > now - this.#config.cooldownMs) {
      this.#notice(event, key, '消息发送太快，请稍后再试。'); return;
    }
    if (this.#active.size >= this.#config.maxConcurrent || this.#recent.length >= this.#config.maxRequestsPerMinute) {
      this.#notice(event, key, '当前对话较多，请稍后再试。'); return;
    }
    if (!state) {
      // The receipt limit bounds how many new users may arrive in ten minutes.
      if (this.#contexts.size >= 2048) {
        const oldest = [...this.#contexts].find(([id]) => !this.#perUser.has(id));
        if (oldest) this.#contexts.delete(oldest[0]);
      }
      state = { epoch: 0, messages: [], at: now, requestAt: null };
      this.#contexts.set(key, state);
    }
    if (state.at < now - this.#config.historyTtlMs) state.messages = [];
    let history = state.messages.map(item => ({ ...item }));
    while (history.length && history.reduce((size, item) => size + item.content.length, parsed.text.length) > this.#config.maxHistoryChars)
      history.splice(0, 2);
    const controller = new AbortController();
    const operation = { controller, state, epoch: state.epoch };
    state.requestAt = now; this.#recent.push(now); this.#counts.requests++;
    this.#active.add(operation); this.#perUser.set(key, operation); this.#controllers.add(controller);
    this.#track(async () => {
      const startedAt = this.#now();
      const current = () => !this.#closed && !controller.signal.aborted && state.epoch === operation.epoch;
      let progressHandle, progressEnded = false;
      const progressCall = async (method, ...args) => {
        try { await progressHandle?.[method]?.(...args); }
        catch (error) { this.#log('progress_failed', { code: sanitizeFailureCode(error?.code) }); }
      };
      const endProgress = async (method, code) => {
        if (!progressHandle || progressEnded) return;
        progressEnded = true;
        await progressCall(method, ...(code === undefined ? [] : [code]));
      };
      const cancelProgress = () => { void endProgress('cancel'); };
      controller.signal.addEventListener('abort', cancelProgress, { once: true });
      try {
        if (typeof this.#progress?.start === 'function') {
          try {
            progressHandle = await this.#progress.start({ targetId: this.#channelId, replyMessageId: event.msg_id, signal: controller.signal });
          } catch (error) { this.#log('progress_failed', { code: sanitizeFailureCode(error?.code) }); }
        }
        if (!current()) return;
        const messages = [...history, { role: 'user', content: parsed.text }];
        const response = await this.#generate(messages, { signal: controller.signal });
        if (!current()) return;
        if (typeof response?.text !== 'string' || !response.text.trim()) throw Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE' });
        let deliveryCode = 'UNKNOWN';
        const delivered = await this.#deliver(event, response.text, controller.signal, response.incomplete === true, {
          onStage: phase => current() && !progressEnded ? progressCall('setPhase', phase) : undefined,
          onFailure: code => { deliveryCode = code; },
        });
        if (!current()) return;
        if (!delivered) { await endProgress('fail', deliveryCode); return; }
        history = [...messages, { role: 'assistant', content: assistantHistory(response) }];
        while (history.length && (history.length > this.#config.maxHistoryTurns * 2
          || history.reduce((size, item) => size + item.content.length, 0) > this.#config.maxHistoryChars)) history.splice(0, 2);
        state.messages = history; state.at = this.#now(); this.#lastError = null; this.#lastErrorCode = null;
        await endProgress('finish');
      } catch (error) {
        const code = sanitizeFailureCode(error?.code);
        if (current() && code !== 'CANCELLED') {
          this.#counts.failures++; this.#lastError = 'MODEL'; this.#lastErrorCode = code;
          this.#log('model_failed', { code, durationMs: this.#now() - startedAt });
          await endProgress('fail', code);
          await this.#deliver(event, modelFailureMessage(code), controller.signal);
        } else await endProgress('cancel');
      } finally {
        if (!current()) await endProgress('cancel');
        controller.signal.removeEventListener('abort', cancelProgress);
        this.#active.delete(operation); this.#controllers.delete(controller);
        if (this.#perUser.get(key) === operation) this.#perUser.delete(key);
      }
    });
  }

  #notice(event, key, content, kind = 'hint') {
    const now = this.#now();
    const hintKey = `${key}:${kind}`, ttl = kind === 'hint' ? 10_000 : 1000;
    if ((this.#hints.get(hintKey) ?? -Infinity) > now - ttl || this.#recentHints.length >= 30) return;
    this.#hints.set(hintKey, now); this.#recentHints.push(now);
    const controller = new AbortController(); this.#controllers.add(controller);
    this.#track(async () => {
      try { await this.#deliver(event, content, controller.signal); }
      finally { this.#controllers.delete(controller); }
    });
  }

  #track(work) {
    const task = Promise.resolve().then(work).catch(() => { this.#lastError = 'INTERNAL'; this.#lastErrorCode = 'UNKNOWN'; this.#log('operation_failed'); });
    this.#tasks.add(task); task.finally(() => this.#tasks.delete(task));
  }

  async #deliver(event, content, signal, incomplete = false, { onStage, onFailure } = {}) {
    if (this.#closed || signal.aborted) return false;
    const startedAt = this.#now();
    try {
      await this.#reply({ targetId: this.#channelId, replyMessageId: event.msg_id, content, signal, incomplete, onStage });
      if (this.#closed || signal.aborted) return false;
      this.#counts.replies++; this.#lastReplyAt = new Date(this.#now()).toISOString(); this.#log('reply_sent'); return true;
    } catch (error) {
      if (!this.#closed && !signal.aborted) {
        const code = sanitizeFailureCode(error?.code);
        onFailure?.(code);
        this.#counts.failures++; this.#lastError = 'DELIVERY'; this.#lastErrorCode = code;
        this.#log('delivery_failed', { code, durationMs: this.#now() - startedAt });
      }
      // Ambiguous delivery is never retried; the receipt was already committed.
      return false;
    }
  }

  #log(event, details = {}) {
    const record = { event };
    if (details.code !== undefined) record.code = sanitizeFailureCode(details.code);
    if (details.durationMs !== undefined) record.durationMs = sanitizeDurationMs(details.durationMs);
    try { this.#logger(record); } catch {}
  }

  async close() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([this.#receipts, ...this.#tasks]),
        new Promise(resolve => { timer = setTimeout(resolve, this.#config.closeTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); this.#contexts.clear(); }
  }
}
