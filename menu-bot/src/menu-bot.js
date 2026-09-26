import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { KookGateway } from './kook-gateway.js';
import { createAuthorResolver } from './kook-identity.js';
import { atomicJson } from './storage.js';

const ID = /^\d{5,30}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const MAX_AGE = 5 * 60_000;
const RECEIPT_TTL = 24 * 60 * 60_000;
const MAX_RECEIPTS = 2000;
const validId = value => typeof value === 'string' && ID.test(value);
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const abortError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

export function parseMenuRequest(content, pageCount = 8) {
  if (typeof content !== 'string' || content.length > 32) return null;
  const match = /^(?:中文)?菜单(?:\s*([1-8１-８一二三四五六七八]))?\s*$/.exec(content.trim());
  if (!match) return null;
  if (!match[1]) return Array.from({ length: pageCount }, (_, index) => index);
  const label = match[1].normalize('NFKC');
  const page = /^[1-8]$/.test(label) ? Number(label) : '一二三四五六七八'.indexOf(label) + 1;
  return page > 0 && page <= pageCount ? [page - 1] : null;
}

/** Bound even injected or platform operations that do not honor AbortSignal. */
async function bounded(operation, { signal, timeoutMs, code }) {
  if (signal?.aborted) throw abortError();
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
    abort = () => reject(abortError());
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (signal?.aborted) throw abortError();
    return operation();
  }), deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** An independent, fixed-image menu bot. Receipts contain no message text or profiles. */
export class MenuBot {
  #sendMenu; #channelIds; #pageCount; #now; #writeState; #logger; #file; #resolveAuthor;
  #gateway; #seen = new Map(); #channelTimes = new Map(); #userTimes = new Map();
  #queue = Promise.resolve(); #pending = 0; #active = 0; #ready = false; #closed = false;
  #controller = new AbortController(); #lastGlobalAt = null; #storageTimeoutMs; #sendTimeoutMs;
  #lastError = null; #lastReplyAt = null; #counts = { requests: 0, replies: 0, failures: 0, rejected: 0 };

  constructor({ token, channelIds, pageCount = 8, sendMenu, logger = () => {}, dataDir,
    now = Date.now, Gateway = KookGateway, fetchImpl = fetch, resolveAuthor,
    writeState = atomicJson, storageTimeoutMs = 5000, sendTimeoutMs = 90_000 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
      || !Array.isArray(channelIds) || channelIds.length < 1 || channelIds.length > 20
      || !channelIds.every(validId) || typeof sendMenu !== 'function'
      || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 8
      || typeof dataDir !== 'string' || !dataDir || typeof now !== 'function'
      || typeof writeState !== 'function' || !Number.isInteger(storageTimeoutMs) || storageTimeoutMs < 1
      || storageTimeoutMs > 5000 || !Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 90_000)
      throw new Error('Invalid menu bot configuration');
    this.#sendMenu = sendMenu; this.#channelIds = new Set(channelIds); this.#pageCount = pageCount;
    this.#logger = logger; this.#now = now; this.#writeState = writeState;
    this.#file = path.join(dataDir, 'menu-receipts.json');
    this.#storageTimeoutMs = storageTimeoutMs; this.#sendTimeoutMs = sendTimeoutMs;
    this.#resolveAuthor = resolveAuthor ?? createAuthorResolver({ token, fetchImpl, now });
    this.#gateway = new Gateway({ token, fetchImpl, logger, now, eventTimeoutMs: 120_000,
      onEvent: (event, options) => this.handle(event, options) });
  }

  async init() {
    if (this.#ready || this.#closed) return this;
    try {
      const info = await bounded(() => stat(this.#file), { timeoutMs: this.#storageTimeoutMs, code: 'storage_timeout' });
      if (!info.isFile() || info.size > 512 * 1024) throw new Error('invalid_receipts');
      const raw = await bounded(() => readFile(this.#file, 'utf8'), { timeoutMs: this.#storageTimeoutMs, code: 'storage_timeout' });
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.receipts) || data.receipts.length > MAX_RECEIPTS)
        throw new Error('invalid_receipts');
      for (const receipt of data.receipts) {
        if (!validMessageId(receipt?.id) || !Number.isSafeInteger(receipt?.at)
          || receipt.at < 0 || receipt.at > this.#now() + 60_000) throw new Error('invalid_receipts');
        if (receipt.at >= this.#now() - RECEIPT_TTL) this.#seen.set(receipt.id, receipt.at);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#lastError = 'storage_failed'; this.#log('receipt_storage_failed'); return this; }
    }
    if (!this.#closed) this.#ready = true;
    return this;
  }

  async start() {
    if (!this.#ready || this.#closed) throw new Error('Menu bot is not ready');
    await this.#gateway.start();
  }

  async close() {
    this.#closed = true; this.#controller.abort(); this.#gateway.close();
    await this.#queue;
  }

  status() {
    return { enabled: this.#ready && !this.#closed, channelIds: [...this.#channelIds],
      pageCount: this.#pageCount, pending: this.#pending, active: this.#active,
      ...this.#counts, lastReplyAt: this.#lastReplyAt, lastError: this.#lastError,
      gateway: this.#gateway.snapshot() };
  }

  handle(event, { signal, botId = this.#gateway.snapshot().botId } = {}) {
    if (!this.#ready || this.#closed || signal?.aborted || this.#pending >= 8) return Promise.resolve();
    const author = event?.extra?.author;
    if (!event || event.channel_type !== 'GROUP' || ![1, 9].includes(event.type)
      || !this.#channelIds.has(event.target_id) || !validId(event.author_id) || !validId(botId)
      || event.author_id === botId || !validMessageId(event.msg_id)
      || !author || typeof author !== 'object' || Array.isArray(author)
      || (author.bot !== false && author.bot !== undefined)
      || (author.id !== undefined && author.id !== event.author_id)) return Promise.resolve();
    const pageIndices = parseMenuRequest(event.content, this.#pageCount);
    if (!pageIndices || !this.#validTime(event.msg_timestamp)) return Promise.resolve();
    // Retain only fields necessary to route and validate; content never enters the queue or disk.
    const input = { channelId: event.target_id, userId: event.author_id, guildId: event.extra.guild_id,
      messageId: event.msg_id, timestamp: event.msg_timestamp, verifyAuthor: author.bot === undefined, pageIndices };
    this.#pending++;
    const operationSignal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    const operation = this.#queue.then(() => this.#receive(input, operationSignal));
    this.#queue = operation.catch(() => { this.#lastError = 'request_failed'; this.#log('menu_request_failed'); });
    return this.#queue.finally(() => { this.#pending--; });
  }

  #validTime(value) {
    return Number.isSafeInteger(value) && value >= this.#now() - MAX_AGE && value <= this.#now() + 60_000;
  }

  #prune(now) {
    for (const [id, at] of this.#seen) if (at < now - RECEIPT_TTL) this.#seen.delete(id);
    for (const times of [this.#channelTimes, this.#userTimes])
      for (const [id, at] of times) if (at <= now - 10_000) times.delete(id);
  }

  async #receive(input, signal) {
    if (!this.#ready || this.#closed || signal.aborted || !this.#validTime(input.timestamp)) return;
    this.#prune(this.#now());
    if (this.#seen.has(input.messageId)) return;
    if (this.#seen.size >= MAX_RECEIPTS) { this.#lastError = 'receipt_capacity'; this.#counts.rejected++; return; }
    if (input.verifyAuthor) {
      if (!validId(input.guildId)) return;
      let author;
      try { author = await bounded(() => this.#resolveAuthor({ userId: input.userId, guildId: input.guildId }),
        { signal, timeoutMs: 5500, code: 'identity_timeout' }); }
      catch { return; }
      if (!author || author.id !== input.userId || author.bot !== false || signal.aborted || this.#closed
        || !this.#validTime(input.timestamp)) return;
    }
    const now = this.#now();
    this.#seen.set(input.messageId, now);
    try {
      await bounded(() => this.#writeState(this.#file,
        { version: 1, receipts: [...this.#seen].map(([id, at]) => ({ id, at })) }),
      { signal, timeoutMs: this.#storageTimeoutMs, code: 'storage_timeout' });
    } catch {
      // An uncertain write must never release a later request for sending.
      this.#ready = false; this.#lastError = 'storage_failed'; this.#log('receipt_storage_failed'); return;
    }
    if (this.#closed || signal.aborted || !this.#validTime(input.timestamp)) return;
    const time = this.#now();
    if ((this.#lastGlobalAt !== null && time < this.#lastGlobalAt + 1000)
      || (this.#channelTimes.has(input.channelId) && time < this.#channelTimes.get(input.channelId) + 10_000)
      || (this.#userTimes.has(input.userId) && time < this.#userTimes.get(input.userId) + 10_000)) {
      this.#counts.rejected++; return;
    }
    this.#lastGlobalAt = time; this.#channelTimes.set(input.channelId, time); this.#userTimes.set(input.userId, time);
    this.#active++; this.#counts.requests++;
    const controller = new AbortController();
    const sendSignal = AbortSignal.any([signal, controller.signal]);
    try {
      await bounded(() => this.#sendMenu({ channelId: input.channelId, replyMessageId: input.messageId,
        pageIndices: input.pageIndices }, { signal: sendSignal }),
      { signal: sendSignal, timeoutMs: this.#sendTimeoutMs, code: 'send_timeout' });
      if (!signal.aborted && !this.#closed) { this.#counts.replies++; this.#lastReplyAt = this.#now(); this.#lastError = null; }
    } catch {
      this.#counts.failures++; this.#lastError = signal.aborted ? 'cancelled' : 'send_failed';
      this.#log(this.#lastError);
    } finally { controller.abort(); this.#active--; }
  }

  #log(code) { try { if (typeof this.#logger === 'function') this.#logger(code); else this.#logger?.info?.(code); } catch {} }
}
