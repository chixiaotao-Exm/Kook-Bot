import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';
import { sanitizeFailureCode } from './failure.js';

const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const validId = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
const STATUSES = new Set(['running', 'paused', 'completed', 'stopped', 'timeout', 'failed', 'interrupted']);
const RECEIPT_TTL = 10 * 60_000;
const MAX_RECEIPTS = 2048;
const MAX_TURN_CHARS = 1200;
const MAX_PENDING_INPUTS = 10;
const MAX_PENDING_CHARS = 20_000;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_MODEL_HISTORY_CHARS = 42_000;
const TRUNCATED = '\n（本轮内容已截短。）';
const INCOMPLETE = '\n（本轮回复未完整生成。）';
const failure = code => Object.assign(new Error('Duet operation failed'), { code });
const safeCode = error => error?.code === 'STORAGE' ? 'STORAGE' : sanitizeFailureCode(error?.code);
const prefix = (text, limit) => text.slice(0, Math.max(0, limit)).replace(/[\uD800-\uDBFF]$/, '');

/** One explicitly requested conversation; gateway bot messages are never inputs. */
export class DuetSession {
  #participants; #channelId; #file; #rounds; #maxRounds; #deadlineMs; #betweenTurnsMs;
  #now; #writeState; #logger; #setTimeout; #clearTimeout; #closeTimeoutMs;
  #ready = false; #closed = false; #runs = 0; #lastRun = null; #lastErrorCode = null;
  #seen = new Map(); #active = null; #operations = Promise.resolve(); #tasks = new Set(); #notices = new Set();

  constructor({ participants, channelId, dataDir, rounds = 0, maxRounds = 6, deadlineMs = 0,
    betweenTurnsMs = 2000, now = Date.now, writeState = atomicJson, logger = () => {},
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, closeTimeoutMs = 1500 } = {}) {
    if (!Array.isArray(participants) || participants.length !== 2
      || participants.some(item => typeof item?.generate !== 'function' || typeof item?.reply !== 'function')
      || !validId(channelId) || typeof dataDir !== 'string' || !dataDir
      || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 6
      || !Number.isInteger(rounds) || rounds < 0 || rounds > maxRounds
      || !Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 600_000
      || !Number.isInteger(betweenTurnsMs) || betweenTurnsMs < 0 || betweenTurnsMs > 30_000)
      throw new Error('Invalid duet session configuration');
    this.#participants = participants.map((item, index) => ({ ...item,
      label: typeof item.label === 'string' && item.label.trim() && item.label.length <= 32
        ? item.label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : `角色 ${index ? 'B' : 'A'}` }));
    this.#channelId = channelId; this.#file = path.join(dataDir, 'duet-state.json');
    this.#rounds = rounds; this.#maxRounds = maxRounds; this.#deadlineMs = deadlineMs; this.#betweenTurnsMs = betweenTurnsMs;
    this.#now = now; this.#writeState = writeState; this.#logger = logger;
    this.#setTimeout = setTimeoutImpl; this.#clearTimeout = clearTimeoutImpl; this.#closeTimeoutMs = closeTimeoutMs;
  }

  async init() {
    try {
      const source = await readFile(this.#file, 'utf8');
      if (source.length > 512 * 1024) throw failure('STORAGE');
      const saved = JSON.parse(source);
      if (saved.version !== 1 || !Number.isSafeInteger(saved.runs) || saved.runs < 0
        || !Array.isArray(saved.seen) || saved.seen.length > MAX_RECEIPTS) throw failure('STORAGE');
      for (const receipt of saved.seen) {
        if (!validMessageId(receipt?.id) || !Number.isSafeInteger(receipt.at) || receipt.at < 0
          || receipt.at > this.#now() + 60_000) throw failure('STORAGE');
        if (receipt.at >= this.#now() - RECEIPT_TTL) this.#seen.set(receipt.id, receipt.at);
      }
      const run = saved.lastRun;
      if (run !== null && (!run || !validMessageId(run.runId) || !validMessageId(run.receiptId)
        || !STATUSES.has(run.status) || !Number.isInteger(run.rounds) || run.rounds < 0 || run.rounds > 6
        || !Number.isSafeInteger(run.completedTurns) || run.completedTurns < 0 || (run.rounds > 0 && run.completedTurns > run.rounds * 2)
        || (run.contributions !== undefined && (!Number.isSafeInteger(run.contributions) || run.contributions < 0))
        || (run.threadId != null && (typeof run.threadId !== 'string' || !THREAD_ID.test(run.threadId)))
        || !Number.isSafeInteger(run.startedAt) || run.startedAt < 0
        || !Number.isSafeInteger(run.updatedAt) || run.updatedAt < 0)) throw failure('STORAGE');
      this.#runs = saved.runs;
      // Copy only known metadata fields, never arbitrary data from a corrupt ledger.
      this.#lastRun = run === null ? null : { runId: run.runId, receiptId: run.receiptId, startedAt: run.startedAt,
        updatedAt: run.updatedAt, rounds: run.rounds, completedTurns: run.completedTurns, contributions: run.contributions ?? 0,
        status: run.status, threadId: run.threadId ?? null, errorCode: run.errorCode === null ? null : safeCode({ code: run.errorCode }) };
      if (['running', 'paused'].includes(this.#lastRun?.status)) {
        this.#lastRun.status = 'interrupted'; this.#lastRun.updatedAt = this.#now();
        await this.#write();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') { this.#lastErrorCode = 'STORAGE'; this.#log('duet_storage_failed'); return this; }
    }
    this.#ready = true; return this;
  }

  snapshot() {
    const run = this.#active, last = this.#lastRun;
    const turn = run ? run.nextTurn : null;
    const currentRound = run ? Math.floor(turn / 2) + 1 : null;
    const speaker = run ? this.#participants[turn % 2].label : null;
    const rounds = run?.rounds ?? last?.rounds ?? this.#rounds;
    return { enabled: this.#ready && !this.#closed, active: Boolean(run), paused: Boolean(run?.paused), status: run ? run.status : last?.status || 'idle',
      rounds, unlimited: rounds === 0, totalTurns: rounds === 0 ? null : rounds * 2,
      defaultRounds: this.#rounds, deadlineMs: this.#deadlineMs, historyMessages: run?.transcript.length ?? 0,
      completedTurns: run?.completedTurns ?? last?.completedTurns ?? 0,
      threadId: run?.threadId ?? last?.threadId ?? null,
      contributions: run?.contributions ?? last?.contributions ?? 0, pendingInputs: run ? this.#pending(run).length : 0,
      currentRound, round: currentRound, currentSpeaker: speaker, currentParticipant: speaker,
      startedAt: run?.startedAt ?? last?.startedAt ?? null,
      deadlineAt: run?.deadlineAt ?? null, deadlineRemainingMs: run?.paused ? run.deadlineRemainingMs : null,
      runs: this.#runs, lastErrorCode: this.#lastErrorCode ?? last?.errorCode ?? null };
  }

  start(input = {}) { return this.#serialize(() => this.#admit(input)); }

  contribute(input = {}) { return this.#serialize(() => this.#contribute(input)); }

  pause() {
    if (!this.#ready || this.#closed) return Promise.resolve({ paused: false, reason: 'NOT_READY' });
    const run = this.#active;
    if (!run || !this.#current(run)) return Promise.resolve({ paused: false, reason: 'NO_ACTIVE' });
    if (run.paused) return Promise.resolve({ paused: false, reason: 'ALREADY_PAUSED' });
    run.paused = true; run.status = 'paused';
    if (run.deadlineAt !== null) run.deadlineRemainingMs = Math.max(0, run.deadlineAt - this.#now());
    run.deadlineAt = null; this.#clearTimeout(run.timer); run.timer = null;
    run.generationController?.abort(failure('PAUSED')); run.delayController?.abort(failure('PAUSED'));
    return this.#serialize(async () => {
      if (!this.#current(run)) return { paused: false, reason: 'NO_ACTIVE' };
      this.#lastRun = this.#metadata(run);
      try { await this.#write(); }
      catch {
        this.#ready = false; run.failureCode = 'STORAGE'; run.endReason = 'failed'; run.controller.abort(failure('STORAGE'));
        void this.#finalize(run, 'failed', 'STORAGE'); return { paused: false, reason: 'NOT_READY' };
      }
      if (!this.#current(run)) return { paused: false, reason: 'NO_ACTIVE' };
      this.#progressState(run, 'pause'); return { paused: true };
    });
  }

  resume() {
    return this.#serialize(async () => {
      if (!this.#ready || this.#closed) return { resumed: false, reason: 'NOT_READY' };
      const run = this.#active;
      if (!run || !this.#current(run)) return { resumed: false, reason: 'NO_ACTIVE' };
      if (!run.paused) return { resumed: false, reason: 'NOT_PAUSED' };
      this.#lastRun = { ...this.#metadata(run), status: 'running' };
      try { await this.#write(); }
      catch {
        this.#ready = false; run.failureCode = 'STORAGE'; run.endReason = 'failed'; run.controller.abort(failure('STORAGE'));
        void this.#finalize(run, 'failed', 'STORAGE'); return { resumed: false, reason: 'NOT_READY' };
      }
      if (!this.#current(run)) return { resumed: false, reason: 'NO_ACTIVE' };
      run.paused = false; run.status = 'running'; this.#armDeadline(run);
      for (const resolve of run.resumeWaiters) resolve(); run.resumeWaiters.clear();
      this.#progressState(run, 'resume'); return { resumed: true };
    });
  }

  #pending(run) { return run.transcript.filter(item => item.kind === 'human' && item.seenBy !== 3); }

  #finishing(run) {
    return run.rounds > 0 && run.nextTurn >= run.rounds * 2 - 1 && ['delivering', 'finishing'].includes(run.stage);
  }

  async #contribute({ text, userId, receiptId, replyMessageId = receiptId }) {
    if (!this.#ready || this.#closed) return { accepted: false, reason: 'NOT_READY' };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || !validId(userId)
      || !validMessageId(receiptId) || !validMessageId(replyMessageId)) return { accepted: false, reason: 'INVALID_INPUT' };
    const run = this.#active;
    if (!run || !this.#current(run)) return { accepted: false, reason: 'NO_ACTIVE' };
    if (this.#finishing(run)) return { accepted: false, reason: 'FINISHING' };
    const now = this.#now(), pending = this.#pending(run);
    for (const [id, at] of this.#seen) if (at < now - RECEIPT_TTL) this.#seen.delete(id);
    if (this.#seen.has(receiptId)) return { accepted: false, reason: 'DUPLICATE' };
    if (this.#seen.size >= MAX_RECEIPTS || pending.length >= MAX_PENDING_INPUTS
      || pending.reduce((size, item) => size + item.text.length, text.trim().length) > MAX_PENDING_CHARS)
      return { accepted: false, reason: 'CAPACITY' };
    this.#seen.set(receiptId, now);
    this.#lastRun = { ...this.#metadata(run), contributions: run.contributions + 1 };
    try { await this.#write(); }
    catch {
      this.#ready = false; this.#lastErrorCode = 'STORAGE'; run.failureCode = 'STORAGE'; run.endReason = 'failed';
      run.controller.abort(failure('STORAGE')); void this.#finalize(run, 'failed', 'STORAGE');
      this.#log('duet_storage_failed'); return { accepted: false, reason: 'NOT_READY' };
    }
    if (!this.#current(run) || this.#finishing(run)) {
      const reason = this.#current(run) ? 'FINISHING' : 'NO_ACTIVE';
      // A deadline/stop may win during the atomic write. Release the receipt durably
      // before allowing the command layer to start a fresh conversation with it.
      this.#seen.delete(receiptId); this.#lastRun = this.#metadata(run, run.failureCode ?? null);
      try { await this.#write(); }
      catch { this.#ready = false; this.#lastErrorCode = 'STORAGE'; this.#log('duet_storage_failed'); return { accepted: false, reason: 'NOT_READY' }; }
      return { accepted: false, reason };
    }
    run.contributions++; run.revision++;
    run.transcript.push({ kind: 'human', text: text.trim().toWellFormed(), receiptId, replyMessageId, seenBy: 0 });
    this.#trimHistory(run);
    if (run.stage === 'generating') run.generationController?.abort(failure('TURN_UPDATED'));
    return { accepted: true, contributions: run.contributions, pendingInputs: this.#pending(run).length };
  }

  #trimHistory(run) {
    const recent = new Set(run.transcript.filter(item => item.kind !== 'human' || item.seenBy === 3).slice(-10));
    run.transcript = run.transcript.filter(item => (item.kind === 'human' && item.seenBy !== 3) || recent.has(item));
    while (run.transcript.reduce((size, item) => size + item.text.length + 80, 0) > MAX_MODEL_HISTORY_CHARS) {
      const disposable = run.transcript.findIndex(item => item.kind !== 'human' || item.seenBy === 3);
      if (disposable < 0) break;
      run.transcript.splice(disposable, 1);
    }
  }

  #threadContext(value) {
    if (!Array.isArray(value) || value.length > 20) return null;
    let total = 0;
    const transcript = [];
    for (const item of value) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
        || !item.content.trim() || !item.content.isWellFormed() || item.content.length > 6000) return null;
      total += item.content.length;
      if (total > 24_000) return null;
      if (item.role === 'user') transcript.push({ kind: 'human', text: item.content, seenBy: 3 });
      else {
        const speaker = [0, 1].find(index => item.speaker === index || item.speaker === String(index)
          || item.speaker === this.#participants[index].label);
        if (speaker === undefined) return null;
        transcript.push({ kind: 'ai', speaker, text: item.content });
      }
    }
    return transcript;
  }

  async #admit({ topic, userId, receiptId, replyMessageId = receiptId, rounds = this.#rounds, threadId = null, threadContext = [] }) {
    if (!this.#ready || this.#closed) return { accepted: false, reason: 'NOT_READY' };
    if (typeof topic !== 'string' || !topic.trim() || topic.length > 2000 || !validId(userId)
      || !validMessageId(receiptId) || !validMessageId(replyMessageId)
      || !Number.isInteger(rounds) || rounds < 0 || rounds > this.#maxRounds
      || (threadId !== null && (typeof threadId !== 'string' || !THREAD_ID.test(threadId)))) return { accepted: false, reason: 'INVALID_INPUT' };
    const transcript = this.#threadContext(threadContext);
    if (!transcript) return { accepted: false, reason: 'INVALID_INPUT' };
    const now = this.#now();
    for (const [id, at] of this.#seen) if (at < now - RECEIPT_TTL) this.#seen.delete(id);
    if (this.#seen.has(receiptId)) return { accepted: false, reason: 'DUPLICATE' };
    if (this.#active) return { accepted: false, reason: 'BUSY' };
    if (this.#seen.size >= MAX_RECEIPTS) return { accepted: false, reason: 'NOT_READY' };
    const run = { runId: randomUUID(), receiptId, replyMessageId, topic: topic.trim(), rounds, threadId,
      startedAt: now, deadlineAt: this.#deadlineMs > 0 ? now + this.#deadlineMs : null, completedTurns: 0, nextTurn: 0,
      transcript, contributions: 0, revision: 0, stage: 'between', generationController: null,
      paused: false, resumeWaiters: new Set(), delayController: null, deadlineRemainingMs: this.#deadlineMs || null,
      controller: new AbortController(), progress: null, progressEnded: false,
      status: 'running', endReason: null, finalizing: null, timer: null };
    this.#seen.set(receiptId, now); this.#runs++; this.#lastRun = this.#metadata(run);
    try { await this.#write(); }
    catch { this.#ready = false; this.#lastErrorCode = 'STORAGE'; this.#log('duet_storage_failed'); return { accepted: false, reason: 'NOT_READY' }; }
    if (this.#closed) {
      this.#lastRun.status = 'interrupted'; this.#lastRun.updatedAt = this.#now();
      await this.#write().catch(() => { this.#lastErrorCode = 'STORAGE'; });
      return { accepted: false, reason: 'NOT_READY' };
    }
    this.#lastErrorCode = null; this.#active = run;
    this.#armDeadline(run);
    const task = Promise.resolve().then(() => this.#execute(run)).catch(() => {
      this.#lastErrorCode = 'UNKNOWN'; this.#log('duet_failed', 'UNKNOWN');
    });
    this.#tasks.add(task); task.finally(() => this.#tasks.delete(task));
    return { accepted: true, runId: run.runId, rounds, unlimited: rounds === 0, totalTurns: rounds === 0 ? null : rounds * 2 };
  }

  #armDeadline(run) {
    this.#clearTimeout(run.timer); run.timer = null;
    if (this.#deadlineMs <= 0 || run.paused) return;
    run.deadlineAt = this.#now() + run.deadlineRemainingMs;
    run.timer = this.#setTimeout(() => {
      if (this.#active !== run || run.paused) return;
      run.endReason = 'timeout'; run.controller.abort(failure('TIMEOUT'));
      void this.#finalize(run, 'timeout', 'TIMEOUT');
    }, Math.max(0, run.deadlineRemainingMs));
  }

  #metadata(run, errorCode = null) {
    return { runId: run.runId, receiptId: run.receiptId, startedAt: run.startedAt, updatedAt: this.#now(),
      rounds: run.rounds, completedTurns: run.completedTurns, contributions: run.contributions, threadId: run.threadId,
      status: run.status, errorCode };
  }

  #serialize(work) {
    const result = this.#operations.then(work); this.#operations = result.catch(() => {}); return result;
  }

  #write() {
    return this.#writeState(this.#file, { version: 1, runs: this.#runs, lastRun: this.#lastRun,
      seen: [...this.#seen].map(([id, at]) => ({ id, at })) });
  }

  #current(run) { return !this.#closed && this.#active === run && ['running', 'paused'].includes(run.status) && !run.controller.signal.aborted; }
  #cancelCode(run) { return run.endReason === 'timeout' ? 'TIMEOUT' : run.failureCode || 'CANCELLED'; }
  #assertCurrent(run) { if (!this.#current(run)) throw failure(this.#cancelCode(run)); }

  async #wait(run, work) {
    this.#assertCurrent(run);
    const { signal } = run.controller;
    let aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(failure(this.#cancelCode(run)));
      signal.addEventListener('abort', aborted, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => { this.#assertCurrent(run); return work(); }), cancellation]);
    } finally { signal.removeEventListener('abort', aborted); }
  }

  async #waitUntilResumed(run) {
    this.#assertCurrent(run);
    while (run.paused) {
      let wake;
      try { await this.#wait(run, () => new Promise(resolve => {
        if (!run.paused) { resolve(); return; }
        wake = resolve; run.resumeWaiters.add(resolve);
      })); }
      finally { if (wake) run.resumeWaiters.delete(wake); }
    }
    this.#assertCurrent(run);
  }

  async #delay(run) {
    let remaining = this.#betweenTurnsMs;
    while (remaining > 0) {
      await this.#waitUntilResumed(run);
      let timer, interrupted; const began = this.#now();
      const controller = new AbortController(); run.delayController = controller;
      const paused = new Promise((_, reject) => {
        interrupted = () => reject(failure('PAUSED'));
        controller.signal.addEventListener('abort', interrupted, { once: true });
      });
      void paused.catch(() => {});
      try {
        await this.#wait(run, () => {
          if (run.paused || controller.signal.aborted) throw failure('PAUSED');
          return Promise.race([new Promise(resolve => { timer = this.#setTimeout(resolve, remaining); }), paused]);
        });
        return;
      } catch (error) {
        if (error?.code !== 'PAUSED' || !this.#current(run)) throw error;
        remaining = Math.max(0, remaining - Math.max(0, this.#now() - began));
      } finally {
        this.#clearTimeout(timer); controller.signal.removeEventListener('abort', interrupted);
        if (run.delayController === controller) run.delayController = null;
      }
    }
  }

  #messages(run, speaker) {
    const participant = this.#participants[speaker], other = this.#participants[1 - speaker];
    const history = run.transcript.map(item => item.kind === 'human'
      ? { role: 'user', content: prefix(`【用户补充】\n${item.text}`, 6000) }
      : { role: item.speaker === speaker ? 'assistant' : 'user', content: item.text });
    const humans = run.transcript.filter(item => item.kind === 'human'), latest = humans.at(-1);
    const priority = latest ? '请优先回应上文用户最新的补充，将用户意见与已有讨论结合，不要忽略用户。' : '';
    return { revision: run.revision, humanReceipts: new Set(humans.map(item => item.receiptId).filter(Boolean)),
      replyMessageId: run.replyMessageId,
      messages: [{ role: 'user', content: `本场互聊话题：${run.topic}` }, ...history,
      { role: 'user', content: run.nextTurn === 0
        ? `请作为${participant.label}${history.length ? '根据上文既有对话继续本场交流' : '围绕上述话题开始第 1 轮交流'}。${priority}按用户最新的长度和格式要求回复，未指定时约 100–200 字。直接输出对话内容。`
        : `现在是第 ${Math.floor(run.nextTurn / 2) + 1} 轮，请作为${participant.label}回应${other.label}最新的发言，继续围绕本场话题交流。${priority}按用户最新的长度和格式要求回复，未指定时约 100–200 字。直接输出对话内容。` }] };
  }

  async #generate(run, participant, view) {
    await this.#waitUntilResumed(run);
    if (run.paused) throw failure('PAUSED');
    if (view.revision !== run.revision) throw failure('TURN_UPDATED');
    const controller = new AbortController(); run.generationController = controller; run.stage = 'generating';
    const cancel = () => controller.abort(failure(this.#cancelCode(run)));
    run.controller.signal.addEventListener('abort', cancel, { once: true });
    let aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(controller.signal.reason || failure('CANCELLED'));
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    void cancellation.catch(() => {});
    try {
      return await this.#wait(run, () => Promise.race([
        Promise.resolve().then(() => {
          if (run.paused) throw failure('PAUSED');
          if (controller.signal.aborted) throw controller.signal.reason;
          return participant.generate(view.messages, { signal: controller.signal });
        }), cancellation,
      ]));
    } finally {
      run.controller.signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', aborted);
      if (run.generationController === controller) run.generationController = null;
    }
  }

  #turnText(run, speaker, response) {
    if (typeof response?.text !== 'string' || !response.text.trim()) throw failure('EMPTY_RESPONSE');
    const round = Math.floor(run.nextTurn / 2) + 1;
    const heading = `【第 ${round}${run.rounds ? `/${run.rounds}` : ''} 轮 · ${this.#participants[speaker].label}】\n`;
    const body = response.text.toWellFormed().trim()
      .replace(/^(?:【\s*第\s*\d+(?:\s*\/\s*\d+)?\s*轮\s*·\s*[^】\r\n]{1,80}】\s*)+/u, '').trim();
    if (!body) throw failure('EMPTY_RESPONSE');
    const suffix = body.length + heading.length > MAX_TURN_CHARS ? TRUNCATED : response.incomplete === true ? INCOMPLETE : '';
    return heading + prefix(body, MAX_TURN_CHARS - heading.length - suffix.length).trimEnd() + suffix;
  }

  async #progress(run, method, code) {
    if (!run.progress || run.progressEnded) return;
    run.progressEnded = true;
    try { await run.progress[method]?.(...(code ? [code] : [])); }
    catch (error) { this.#log('duet_progress_failed', safeCode(error)); }
  }

  #progressState(run, method) {
    const task = Promise.resolve().then(async () => {
      if (!this.#current(run) || run.progressEnded || !run.progress || run.paused !== (method === 'pause')) return;
      try { await run.progress[method]?.(); }
      catch (error) { this.#log('duet_progress_failed', safeCode(error)); }
    });
    this.#tasks.add(task); task.finally(() => this.#tasks.delete(task));
  }

  async #execute(run) {
    const abortProgress = () => { void this.#progress(run, run.endReason === 'timeout' ? 'fail' : 'cancel', run.endReason === 'timeout' ? 'TIMEOUT' : undefined); };
    run.controller.signal.addEventListener('abort', abortProgress, { once: true });
    try {
      await this.#waitUntilResumed(run);
      const progress = this.#participants[0].progress;
      if (typeof progress?.start === 'function') {
        try {
          await this.#wait(run, async () => {
            if (run.paused) throw failure('PAUSED');
            const handle = await progress.start({ targetId: this.#channelId, replyMessageId: run.replyMessageId, signal: run.controller.signal });
            run.progress = handle;
            if (!this.#current(run)) await this.#progress(run, run.endReason === 'timeout' ? 'fail' : 'cancel', run.endReason === 'timeout' ? 'TIMEOUT' : undefined);
            else if (run.paused) this.#progressState(run, 'pause');
          });
        } catch (error) {
          if (!this.#current(run)) throw error;
          if (error?.code !== 'PAUSED') this.#log('duet_progress_failed', safeCode(error));
        }
      }
      for (let turn = 0; run.rounds === 0 || turn < run.rounds * 2; turn++) {
        run.nextTurn = turn; run.stage = 'between';
        if (turn) await this.#delay(run);
        const speaker = turn % 2, participant = this.#participants[speaker];
        for (;;) {
          try {
            await this.#waitUntilResumed(run);
            const view = await this.#serialize(() => { this.#assertCurrent(run); return this.#messages(run, speaker); });
            const response = await this.#generate(run, participant, view);
            this.#assertCurrent(run);
            await this.#waitUntilResumed(run);
            await this.#serialize(() => {
              this.#assertCurrent(run);
              if (view.revision !== run.revision) throw failure('TURN_UPDATED');
            });
            const text = this.#turnText(run, speaker, response);
            const delivered = await this.#wait(run, () => {
              if (run.paused) throw failure('PAUSED');
              if (view.revision !== run.revision) throw failure('TURN_UPDATED');
              run.stage = 'delivering';
              return participant.reply({ targetId: this.#channelId, replyMessageId: view.replyMessageId,
                content: text, incomplete: false, textOnly: true, signal: run.controller.signal });
            });
            this.#assertCurrent(run);
            if (!validMessageId(delivered?.messageId)) throw failure('KOOK_INVALID_RESPONSE');
            await this.#serialize(async () => {
              this.#assertCurrent(run);
              run.transcript.push({ kind: 'ai', speaker, text }); run.completedTurns++;
              for (const item of run.transcript) if (item.kind === 'human' && view.humanReceipts.has(item.receiptId)) item.seenBy |= 1 << speaker;
              this.#trimHistory(run); run.stage = run.rounds > 0 && turn === run.rounds * 2 - 1 ? 'finishing' : 'between';
              this.#lastRun = this.#metadata(run);
              try { await this.#write(); } catch { this.#ready = false; throw failure('STORAGE'); }
            });
            break;
          } catch (error) {
            if (['TURN_UPDATED', 'PAUSED'].includes(error?.code) && this.#current(run)) continue;
            throw error;
          }
        }
      }
      // This final notice is fixed text and does not create another model request.
      for (;;) {
        await this.#waitUntilResumed(run);
        try {
          await this.#wait(run, () => {
            if (run.paused) throw failure('PAUSED');
            return this.#participants[0].reply({ targetId: this.#channelId,
              replyMessageId: run.replyMessageId, content: `互聊已完成：${run.rounds} 轮，共 ${run.completedTurns} 条 AI 发言。`,
              incomplete: false, textOnly: true, signal: run.controller.signal });
          });
          break;
        } catch (error) {
          if (!this.#current(run)) throw error;
          if (error?.code === 'PAUSED') continue;
          this.#log('duet_notice_failed', safeCode(error)); break;
        }
      }
      const stored = await this.#finalize(run, 'completed');
      await this.#progress(run, stored === false ? 'fail' : 'finish', stored === false ? 'STORAGE' : undefined);
    } catch (error) {
      const status = run.endReason || (error?.code === 'CANCELLED' ? 'stopped' : 'failed');
      const code = status === 'timeout' ? 'TIMEOUT' : ['stopped', 'interrupted'].includes(status) ? null : run.failureCode || safeCode(error);
      await this.#finalize(run, status, code);
      await this.#progress(run, ['stopped', 'interrupted'].includes(status) ? 'cancel' : 'fail', code);
      if (status === 'timeout' && !this.#closed) await this.#deadlineNotice(run);
    } finally {
      run.controller.signal.removeEventListener('abort', abortProgress);
      run.transcript = []; run.topic = '';
    }
  }

  #finalize(run, status, code = null) {
    if (run.finalizing) return run.finalizing;
    run.status = status; this.#clearTimeout(run.timer);
    if (this.#active === run) this.#active = null;
    if (code) { this.#lastErrorCode = code; this.#log('duet_failed', code); }
    run.finalizing = this.#serialize(async () => {
      if (this.#lastRun?.runId !== run.runId) return true;
      this.#lastRun = this.#metadata(run, code);
      try { await this.#write(); return true; }
      catch {
        this.#ready = false; this.#lastErrorCode = 'STORAGE'; run.status = 'failed';
        this.#lastRun = this.#metadata(run, 'STORAGE'); this.#log('duet_storage_failed'); return false;
      }
    });
    return run.finalizing;
  }

  async #deadlineNotice(run) {
    if (this.#closed || this.#lastRun?.runId !== run.runId) return;
    const controller = new AbortController(); this.#notices.add(controller);
    let timer;
    try {
      await Promise.race([
        this.#participants[0].reply({ targetId: this.#channelId, replyMessageId: run.replyMessageId,
          content: '互聊已达到本次时间上限，已停止。', incomplete: false, textOnly: true, signal: controller.signal }),
        new Promise(resolve => { timer = this.#setTimeout(() => { controller.abort(); resolve(); }, 5000); }),
      ]);
    } catch (error) { this.#log('duet_notice_failed', safeCode(error)); }
    finally { this.#clearTimeout(timer); this.#notices.delete(controller); }
  }

  async stop() {
    if (!this.#active) await this.#operations;
    const run = this.#active;
    if (!run) return { stopped: false };
    run.endReason = 'stopped'; run.controller.abort(failure('CANCELLED'));
    await this.#finalize(run, 'stopped'); return { stopped: true };
  }

  #log(event, code) {
    try { this.#logger({ event, ...(code ? { code: sanitizeFailureCode(code) } : {}) }); } catch {}
  }

  async close() {
    this.#closed = true;
    for (const controller of this.#notices) controller.abort();
    const run = this.#active;
    if (run) { run.endReason = 'interrupted'; run.controller.abort(failure('CANCELLED')); void this.#finalize(run, 'interrupted'); }
    let timer;
    try { await Promise.race([Promise.allSettled([this.#operations, ...this.#tasks]),
      new Promise(resolve => { timer = this.#setTimeout(resolve, this.#closeTimeoutMs); })]); }
    finally { this.#clearTimeout(timer); }
  }
}
