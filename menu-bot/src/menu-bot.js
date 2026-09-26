import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { KookGateway } from './kook-gateway.js';
import { createAuthorResolver, createButtonAuthorResolver } from './kook-identity.js';
import { atomicJson } from './storage.js';
import { calculate, parseCalculationRequest, CalculatorError } from './calculator.js';

const ID = /^\d{5,30}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const MAX_AGE = 5 * 60_000;
const RECEIPT_TTL = 24 * 60 * 60_000;
const MAX_RECEIPTS = 2000;
const validId = value => typeof value === 'string' && ID.test(value);
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const abortError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
const CALCULATOR_HELP = '发送“计算 12+14×2”即可计算。\n支持加减乘除、小数和括号。\n示例：计算 (12+18)÷3\n菜单价格均以美元（USD）结算；计算器不进行汇率换算。';

function calculationText(request) {
  if (request.kind === 'help') return CALCULATOR_HELP;
  try {
    const value = calculate(request.expression);
    return `计算结果\n${value.expression.replace(/\s+/g, ' ')} ${value.approximate ? '≈' : '='} ${value.result}`;
  } catch (error) {
    const reason = error instanceof CalculatorError ? error.message : '请检查算式后重试。';
    return `无法计算：${reason}\n仅支持数字、加减乘除和括号，不支持货币符号、汇率换算或文字。\n示例：计算 12+14×2`;
  }
}

export function parseMenuRequest(content, pageCount = 8) {
  if (typeof content !== 'string' || content.length > 32) return null;
  const match = /^(?:中文|双语|中西双语)?菜单(?:\s*([1-8１-８一二三四五六七八]))?\s*$/.exec(content.trim());
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

/** An independent menu and arithmetic bot. Receipts contain no message text or profiles. */
export class MenuBot {
  #sendMenu; #sendText; #waiter; #searchPages; #resolveButtonAuthor; #channelIds; #pageCount; #now; #writeState; #logger; #file; #resolveAuthor;
  #gateway; #seen = new Map(); #channelTimes = new Map(); #userTimes = new Map();
  #queue = Promise.resolve(); #pending = 0; #active = 0; #ready = false; #closed = false;
  #controller = new AbortController(); #lastGlobalAt = null; #storageTimeoutMs; #sendTimeoutMs;
  #lastError = null; #lastReplyAt = null; #counts = { requests: 0, replies: 0, failures: 0, rejected: 0, pageUpdates: 0 };

  constructor({ token, channelIds, pageCount = 8, sendMenu, sendText, waiter, searchPages, resolveButtonAuthor, logger = () => {}, dataDir,
    now = Date.now, Gateway = KookGateway, fetchImpl = fetch, resolveAuthor,
    writeState = atomicJson, storageTimeoutMs = 5000, sendTimeoutMs = 90_000 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
      || !Array.isArray(channelIds) || channelIds.length < 1 || channelIds.length > 20
      || !channelIds.every(validId) || typeof sendMenu !== 'function'
      || (sendText !== undefined && typeof sendText !== 'function')
      || (waiter !== undefined && (typeof waiter?.accepts !== 'function' || typeof waiter?.reply !== 'function' || typeof sendText !== 'function'))
      || (searchPages !== undefined && (typeof searchPages?.create !== 'function' || typeof searchPages?.bind !== 'function'
        || typeof searchPages?.resolve !== 'function' || typeof searchPages?.context !== 'function' || typeof sendText?.update !== 'function'))
      || (resolveButtonAuthor !== undefined && typeof resolveButtonAuthor !== 'function')
      || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 8
      || typeof dataDir !== 'string' || !dataDir || typeof now !== 'function'
      || typeof writeState !== 'function' || !Number.isInteger(storageTimeoutMs) || storageTimeoutMs < 1
      || storageTimeoutMs > 5000 || !Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 90_000)
      throw new Error('Invalid menu bot configuration');
    this.#sendMenu = sendMenu; this.#sendText = sendText; this.#waiter = waiter; this.#channelIds = new Set(channelIds); this.#pageCount = pageCount;
    this.#searchPages = searchPages;
    this.#logger = logger; this.#now = now; this.#writeState = writeState;
    this.#file = path.join(dataDir, 'menu-receipts.json');
    this.#storageTimeoutMs = storageTimeoutMs; this.#sendTimeoutMs = sendTimeoutMs;
    this.#resolveAuthor = resolveAuthor ?? createAuthorResolver({ token, fetchImpl, now });
    this.#resolveButtonAuthor = resolveButtonAuthor ?? createButtonAuthorResolver({ token, channelIds, fetchImpl, now });
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
      waiter: this.#waiter?.status?.() ?? { enabled: false },
      gateway: this.#gateway.snapshot() };
  }

  handle(event, { signal, botId = this.#gateway.snapshot().botId } = {}) {
    if (!this.#ready || this.#closed || signal?.aborted || this.#pending >= 8) return Promise.resolve();
    if (event?.type === 255 && event.extra?.type === 'message_btn_click') {
      const body = event.extra.body, info = body?.user_info;
      if (!this.#searchPages || !body || !this.#channelIds.has(body.target_id) || !validId(body.user_id)
        || !validId(botId) || body.user_id === botId || !validMessageId(body.msg_id) || !validMessageId(event.msg_id)
        || !this.#validTime(event.msg_timestamp) || typeof body.value !== 'string'
        || !/^menu-page:[A-Za-z0-9:_-]{1,246}$/.test(body.value)
        || (info !== undefined && (!info || typeof info !== 'object' || Array.isArray(info)
          || (info.id !== undefined && info.id !== body.user_id) || (info.bot !== undefined && info.bot !== false)))) return Promise.resolve();
      const destination = this.#searchPages.resolve(body.value, { channelId: body.target_id, messageId: body.msg_id });
      if (!destination || destination.error === 'invalid') return Promise.resolve();
      const context = this.#searchPages.context(body.value, { channelId: body.target_id, messageId: body.msg_id });
      return this.#enqueue({ kind: 'page', channelId: body.target_id, userId: body.user_id, guildId: context?.guildId,
        messageId: event.msg_id, timestamp: event.msg_timestamp, verifyAuthor: info?.bot !== false,
        cardMessageId: body.msg_id, buttonValue: body.value }, signal);
    }
    const author = event?.extra?.author;
    if (!event || event.channel_type !== 'GROUP' || ![1, 9].includes(event.type)
      || !this.#channelIds.has(event.target_id) || !validId(event.author_id) || !validId(botId)
      || event.author_id === botId || !validMessageId(event.msg_id)
      || !author || typeof author !== 'object' || Array.isArray(author)
      || (author.bot !== false && author.bot !== undefined)
      || (author.id !== undefined && author.id !== event.author_id)) return Promise.resolve();
    const pageIndices = parseMenuRequest(event.content, this.#pageCount);
    const calculation = !pageIndices && this.#sendText ? parseCalculationRequest(event.content) : null;
    const waiterRequest = !pageIndices && !calculation && this.#waiter?.accepts(event.content);
    if ((!pageIndices && !calculation && !waiterRequest) || !this.#validTime(event.msg_timestamp)) return Promise.resolve();
    // Waiter input is bounded and remains in memory only; receipts never contain message text.
    const input = { channelId: event.target_id, userId: event.author_id, guildId: event.extra.guild_id,
      messageId: event.msg_id, timestamp: event.msg_timestamp, verifyAuthor: author.bot === undefined,
      kind: pageIndices ? 'menu' : calculation ? 'calculator' : 'waiter', pageIndices,
      waiterText: waiterRequest ? event.content : undefined, calculationText: calculation ? calculationText(calculation) : undefined };
    return this.#enqueue(input, signal);
  }

  #enqueue(input, signal) {
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
      if (input.kind !== 'page' && !validId(input.guildId)) return;
      let author;
      try { author = await bounded(() => input.kind === 'page'
        ? this.#resolveButtonAuthor({ userId: input.userId, guildId: input.guildId, channelId: input.channelId, signal })
        : this.#resolveAuthor({ userId: input.userId, guildId: input.guildId }),
        { signal, timeoutMs: input.kind === 'page' ? 8000 : 5500, code: 'identity_timeout' }); }
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
    const channelKey = `${input.kind}:${input.channelId}`, userKey = `${input.kind}:${input.userId}`;
    const cooldown = input.kind === 'menu' ? 10_000 : input.kind === 'page' ? 1000 : 3000;
    if ((this.#lastGlobalAt !== null && time < this.#lastGlobalAt + 1000)
      || (this.#channelTimes.has(channelKey) && time < this.#channelTimes.get(channelKey) + cooldown)
      || (this.#userTimes.has(userKey) && time < this.#userTimes.get(userKey) + cooldown)) {
      this.#counts.rejected++; return;
    }
    this.#lastGlobalAt = time; this.#channelTimes.set(channelKey, time); this.#userTimes.set(userKey, time);
    this.#active++; this.#counts.requests++;
    const controller = new AbortController();
    const sendSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const send = input.kind === 'page'
        ? async () => {
          const page = this.#searchPages.resolve(input.buttonValue, { channelId: input.channelId, messageId: input.cardMessageId });
          if (!page || page.error === 'invalid') return;
          if (page.error === 'expired') return this.#sendText({ channelId: input.channelId,
            title: '中文菜单 · 菜品搜索', text: '这张搜索卡片的按钮已失效，请重新发送“搜索鱼”或原搜索词获取新卡片。' }, { signal: sendSignal });
          const updated = await this.#sendText.update({ channelId: input.channelId, messageId: input.cardMessageId,
            title: page.title, text: page.text, buttons: page.buttons }, { signal: sendSignal });
          if (!sendSignal.aborted) this.#counts.pageUpdates++;
          return updated;
        }
        : input.kind === 'menu'
        ? () => this.#sendMenu({ channelId: input.channelId, replyMessageId: input.messageId,
          pageIndices: input.pageIndices }, { signal: sendSignal })
        : async () => {
          const search = input.kind === 'waiter' ? this.#searchPages?.create(input.waiterText,
            { channelId: input.channelId, guildId: input.guildId }) : null;
          if (search) {
            const sent = await this.#sendText({ channelId: input.channelId, replyMessageId: input.messageId,
              title: search.title, text: search.text, buttons: search.buttons }, { signal: sendSignal });
            if (search.sessionId && !sendSignal.aborted) this.#searchPages.bind(search.sessionId, sent?.messageId);
            return sent;
          }
          const title = input.kind === 'waiter' ? '中文菜单 · 点餐服务员' : '中文菜单 · 计算器';
          const text = input.kind === 'waiter' ? await this.#waiter.reply(input.waiterText, { signal: sendSignal,
            onThinking: async () => { await this.#sendText({ channelId: input.channelId, replyMessageId: input.messageId,
              title, text: '正在用 gpt-6-astra 理解你的点餐需求，随后核对原菜单并计算美元金额。' }, { signal: sendSignal }); } }) : input.calculationText;
          sendSignal.throwIfAborted();
          return this.#sendText({ channelId: input.channelId, replyMessageId: input.messageId,
            text, ...(input.kind === 'waiter' ? { title } : {}) }, { signal: sendSignal });
        };
      await bounded(send,
      { signal: sendSignal, timeoutMs: this.#sendTimeoutMs, code: 'send_timeout' });
      if (!signal.aborted && !this.#closed) { this.#counts.replies++; this.#lastReplyAt = this.#now(); this.#lastError = null; }
    } catch {
      this.#counts.failures++; this.#lastError = signal.aborted ? 'cancelled' : 'send_failed';
      this.#log(this.#lastError);
    } finally { controller.abort(); this.#active--; }
  }

  #log(code) { try { if (typeof this.#logger === 'function') this.#logger(code); else this.#logger?.info?.(code); } catch {} }
}
