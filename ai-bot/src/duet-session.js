import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';
import { sanitizeFailureCode } from './failure.js';

const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const validMessageId = value => typeof value === 'string' && MESSAGE_ID.test(value);
const validId = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
const STATUSES = new Set(['running', 'completed', 'stopped', 'timeout', 'failed', 'interrupted']);
const RECEIPT_TTL = 10 * 60_000;
const MAX_RECEIPTS = 2048;
const MAX_TURN_CHARS = 1200;
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
        || !Number.isSafeInteger(run.startedAt) || run.startedAt < 0
        || !Number.isSafeInteger(run.updatedAt) || run.updatedAt < 0)) throw failure('STORAGE');
      this.#runs = saved.runs;
      // Copy only known metadata fields, never arbitrary data from a corrupt ledger.
      this.#lastRun = run === null ? null : { runId: run.runId, receiptId: run.receiptId, startedAt: run.startedAt,
        updatedAt: run.updatedAt, rounds: run.rounds, completedTurns: run.completedTurns,
        status: run.status, errorCode: run.errorCode === null ? null : safeCode({ code: run.errorCode }) };
      if (this.#lastRun?.status === 'running') {
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
    return { enabled: this.#ready && !this.#closed, active: Boolean(run), status: run ? 'running' : last?.status || 'idle',
      rounds, unlimited: rounds === 0, totalTurns: rounds === 0 ? null : rounds * 2,
      defaultRounds: this.#rounds, deadlineMs: this.#deadlineMs, historyMessages: run?.transcript.length ?? 0,
      completedTurns: run?.completedTurns ?? last?.completedTurns ?? 0,
      currentRound, round: currentRound, currentSpeaker: speaker, currentParticipant: speaker,
      startedAt: run?.startedAt ?? last?.startedAt ?? null,
      deadlineAt: run?.deadlineAt ?? null, runs: this.#runs, lastErrorCode: this.#lastErrorCode ?? last?.errorCode ?? null };
  }

  start(input = {}) { return this.#serialize(() => this.#admit(input)); }

  async #admit({ topic, userId, receiptId, replyMessageId = receiptId, rounds = this.#rounds }) {
    if (!this.#ready || this.#closed) return { accepted: false, reason: 'NOT_READY' };
    if (typeof topic !== 'string' || !topic.trim() || topic.length > 2000 || !validId(userId)
      || !validMessageId(receiptId) || !validMessageId(replyMessageId)
      || !Number.isInteger(rounds) || rounds < 0 || rounds > this.#maxRounds) return { accepted: false, reason: 'INVALID_INPUT' };
    const now = this.#now();
    for (const [id, at] of this.#seen) if (at < now - RECEIPT_TTL) this.#seen.delete(id);
    if (this.#seen.has(receiptId)) return { accepted: false, reason: 'DUPLICATE' };
    if (this.#active) return { accepted: false, reason: 'BUSY' };
    if (this.#seen.size >= MAX_RECEIPTS) return { accepted: false, reason: 'NOT_READY' };
    const run = { runId: randomUUID(), receiptId, replyMessageId, topic: topic.trim(), rounds,
      startedAt: now, deadlineAt: this.#deadlineMs > 0 ? now + this.#deadlineMs : null, completedTurns: 0, nextTurn: 0,
      transcript: [], controller: new AbortController(), progress: null, progressEnded: false,
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
    if (this.#deadlineMs > 0) run.timer = this.#setTimeout(() => {
      if (this.#active !== run) return;
      run.endReason = 'timeout'; run.controller.abort(failure('TIMEOUT'));
      void this.#finalize(run, 'timeout', 'TIMEOUT');
    }, Math.max(0, run.deadlineAt - this.#now()));
    const task = Promise.resolve().then(() => this.#execute(run)).catch(() => {
      this.#lastErrorCode = 'UNKNOWN'; this.#log('duet_failed', 'UNKNOWN');
    });
    this.#tasks.add(task); task.finally(() => this.#tasks.delete(task));
    return { accepted: true, runId: run.runId, rounds, unlimited: rounds === 0, totalTurns: rounds === 0 ? null : rounds * 2 };
  }

  #metadata(run, errorCode = null) {
    return { runId: run.runId, receiptId: run.receiptId, startedAt: run.startedAt, updatedAt: this.#now(),
      rounds: run.rounds, completedTurns: run.completedTurns, status: run.status, errorCode };
  }

  #serialize(work) {
    const result = this.#operations.then(work); this.#operations = result.catch(() => {}); return result;
  }

  #write() {
    return this.#writeState(this.#file, { version: 1, runs: this.#runs, lastRun: this.#lastRun,
      seen: [...this.#seen].map(([id, at]) => ({ id, at })) });
  }

  #current(run) { return !this.#closed && this.#active === run && run.status === 'running' && !run.controller.signal.aborted; }
  #assertCurrent(run) { if (!this.#current(run)) throw failure(run.endReason === 'timeout' ? 'TIMEOUT' : 'CANCELLED'); }

  async #wait(run, work) {
    this.#assertCurrent(run);
    const { signal } = run.controller;
    let aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(failure(run.endReason === 'timeout' ? 'TIMEOUT' : 'CANCELLED'));
      signal.addEventListener('abort', aborted, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => { this.#assertCurrent(run); return work(); }), cancellation]);
    } finally { signal.removeEventListener('abort', aborted); }
  }

  async #delay(run) {
    if (!this.#betweenTurnsMs) return;
    let timer;
    try { await this.#wait(run, () => new Promise(resolve => { timer = this.#setTimeout(resolve, this.#betweenTurnsMs); })); }
    finally { this.#clearTimeout(timer); }
  }

  #messages(run, speaker) {
    const participant = this.#participants[speaker], other = this.#participants[1 - speaker];
    const history = run.transcript.map(item => ({ role: item.speaker === speaker ? 'assistant' : 'user', content: item.text }));
    return [{ role: 'user', content: `本场互聊话题：${run.topic}` }, ...history,
      { role: 'user', content: run.nextTurn === 0
        ? `请作为${participant.label}围绕上述话题开始第 1 轮交流。用约 100–200 字自然表达观点，直接输出对话内容。`
        : `现在是第 ${Math.floor(run.nextTurn / 2) + 1} 轮，请作为${participant.label}回应${other.label}最新的发言，继续围绕本场话题交流。用约 100–200 字，直接输出对话内容。` }];
  }

  #turnText(run, speaker, response) {
    if (typeof response?.text !== 'string' || !response.text.trim()) throw failure('EMPTY_RESPONSE');
    const round = Math.floor(run.nextTurn / 2) + 1;
    const heading = `【第 ${round}${run.rounds ? `/${run.rounds}` : ''} 轮 · ${this.#participants[speaker].label}】\n`;
    const body = response.text.toWellFormed().trim();
    const suffix = body.length + heading.length > MAX_TURN_CHARS ? TRUNCATED : response.incomplete === true ? INCOMPLETE : '';
    return heading + prefix(body, MAX_TURN_CHARS - heading.length - suffix.length).trimEnd() + suffix;
  }

  async #progress(run, method, code) {
    if (!run.progress || run.progressEnded) return;
    run.progressEnded = true;
    try { await run.progress[method]?.(...(code ? [code] : [])); }
    catch (error) { this.#log('duet_progress_failed', safeCode(error)); }
  }

  async #execute(run) {
    const abortProgress = () => { void this.#progress(run, run.endReason === 'timeout' ? 'fail' : 'cancel', run.endReason === 'timeout' ? 'TIMEOUT' : undefined); };
    run.controller.signal.addEventListener('abort', abortProgress, { once: true });
    try {
      const progress = this.#participants[0].progress;
      if (typeof progress?.start === 'function') {
        try {
          await this.#wait(run, async () => {
            const handle = await progress.start({ targetId: this.#channelId, replyMessageId: run.replyMessageId, signal: run.controller.signal });
            run.progress = handle;
            if (!this.#current(run)) await this.#progress(run, run.endReason === 'timeout' ? 'fail' : 'cancel', run.endReason === 'timeout' ? 'TIMEOUT' : undefined);
          });
        } catch (error) {
          if (!this.#current(run)) throw error;
          this.#log('duet_progress_failed', safeCode(error));
        }
      }
      for (let turn = 0; run.rounds === 0 || turn < run.rounds * 2; turn++) {
        run.nextTurn = turn;
        if (turn) await this.#delay(run);
        const speaker = turn % 2, participant = this.#participants[speaker];
        const response = await this.#wait(run, () => participant.generate(this.#messages(run, speaker), { signal: run.controller.signal }));
        this.#assertCurrent(run);
        const text = this.#turnText(run, speaker, response);
        const delivered = await this.#wait(run, () => participant.reply({ targetId: this.#channelId, replyMessageId: run.replyMessageId,
          content: text, incomplete: false, textOnly: true, signal: run.controller.signal }));
        this.#assertCurrent(run);
        if (!validMessageId(delivered?.messageId)) throw failure('KOOK_INVALID_RESPONSE');
        run.transcript.push({ speaker, text }); run.completedTurns++;
        if (run.transcript.length > 10) run.transcript.splice(0, run.transcript.length - 10);
        await this.#serialize(async () => {
          this.#assertCurrent(run); this.#lastRun = this.#metadata(run);
          try { await this.#write(); } catch { this.#ready = false; throw failure('STORAGE'); }
        });
      }
      // This final notice is fixed text and does not create another model request.
      try { await this.#wait(run, () => this.#participants[0].reply({ targetId: this.#channelId,
        replyMessageId: run.replyMessageId, content: `互聊已完成：${run.rounds} 轮，共 ${run.completedTurns} 条 AI 发言。`,
        incomplete: false, textOnly: true, signal: run.controller.signal })); }
      catch (error) { if (!this.#current(run)) throw error; this.#log('duet_notice_failed', safeCode(error)); }
      const stored = await this.#finalize(run, 'completed');
      await this.#progress(run, stored === false ? 'fail' : 'finish', stored === false ? 'STORAGE' : undefined);
    } catch (error) {
      const status = run.endReason || (error?.code === 'CANCELLED' ? 'stopped' : 'failed');
      const code = status === 'timeout' ? 'TIMEOUT' : ['stopped', 'interrupted'].includes(status) ? null : safeCode(error);
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
