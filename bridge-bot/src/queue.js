import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const KEY = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const STATES = new Set(['queued', 'sending', 'sent', 'rejected', 'uncertain']);
const TERMINAL = new Set(['sent', 'rejected', 'uncertain']);
const THEMES = new Set(['info', 'success', 'warning', 'danger', 'secondary']);
const CODES = new Set(['STORAGE', 'CAPACITY', 'RATE_LIMITED', 'REJECTED', 'DELIVERY_UNKNOWN', 'INVALID_CONFIRMATION', 'SEND_TIMEOUT', 'INTERRUPTED']);
const NOTIFICATION_FIELDS = ['key', 'kind', 'title', 'lines', 'theme', 'url'];
const RECORD_FIELDS = ['key', 'state', 'attempts', 'createdAt', 'updatedAt', 'nextAttemptAt', 'notification', 'messageId', 'errorCode'];
const MAX_RETRY_MS = 300000;
const RECORD_BYTES = 32768;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit, empty = false) => typeof value === 'string' && (empty || Boolean(value.trim())) && value.length <= limit
  && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

export class QueueError extends Error {
  constructor(code, statusCode = 503) {
    super(code === 'INVALID_NOTIFICATION' ? 'Invalid notification.' : 'Notification queue unavailable.');
    this.name = 'QueueError'; this.code = code; this.statusCode = statusCode;
  }
}

async function atomicState(file, value, { signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync();
    await handle.close(); handle = null;
    signal?.throwIfAborted();
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(caught => { if (caught.code !== 'ENOENT') throw caught; });
  }
}

/** Durable at-most-once delivery for bounded, already-normalized notifications. */
export class NotificationQueue {
  #file; #send; #validate; #now; #write; #setTimeout; #clearTimeout;
  #interval; #maxRecords; #retention; #retryFloor; #sendTimeout; #writeTimeout; #maxPending; #pending = 0;
  #records = []; #tail = Promise.resolve(); #initializing = null; #worker = null; #closing = null;
  #timer = null; #ready = false; #closed = false; #started = false; #lastError = null; #nextSendAt = 0;

  constructor({ dataDir, send, validate = () => true, now = Date.now, writeState = atomicState,
    intervalMs = 1000, maxRecords = 1000, retentionMs = 7 * 86400000, retryFloorMs = 15000,
    sendTimeoutMs = 10000, writeTimeoutMs = 5000, maxPending = 32, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || /[\x00]/.test(dataDir) || typeof send !== 'function'
      || typeof validate !== 'function' || typeof now !== 'function' || typeof writeState !== 'function'
      || typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function'
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000
      || !Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > 365 * 86400000
      || !Number.isSafeInteger(retryFloorMs) || retryFloorMs < 1 || retryFloorMs > MAX_RETRY_MS
      || !Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 10000
      || !Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 10000
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 128) throw new QueueError('CONFIG', 400);
    this.#file = path.join(dataDir, 'bridge-queue.json');
    this.#send = send; this.#validate = validate; this.#now = now; this.#write = writeState;
    this.#interval = intervalMs; this.#maxRecords = maxRecords; this.#retention = retentionMs;
    this.#retryFloor = retryFloorMs; this.#sendTimeout = sendTimeoutMs;
    this.#writeTimeout = writeTimeoutMs; this.#maxPending = maxPending;
    this.#setTimeout = setTimeoutImpl; this.#clearTimeout = clearTimeoutImpl;
  }

  #clock() { const value = this.#now(); if (!time(value)) throw new QueueError('STORAGE'); return value; }
  #serial(work) { const task = this.#tail.then(work); this.#tail = task.catch(() => {}); return task; }
  #assertReady() {
    if (this.#closed) throw new QueueError('CLOSED');
    if (!this.#ready) throw new QueueError(this.#lastError === 'STORAGE' ? 'STORAGE' : 'NOT_READY');
  }
  #notification(value) {
    try {
      if (!object(value) || Object.keys(value).length !== NOTIFICATION_FIELDS.length
        || NOTIFICATION_FIELDS.some(field => !Object.hasOwn(value, field)) || !KEY.test(value.key)
        || !text(value.kind, 30) || !/^[a-z][a-z0-9_-]*$/.test(value.kind) || !text(value.title, 100)
        || !Array.isArray(value.lines) || value.lines.length > 8 || value.lines.some(line => !text(line, 500, true))
        || !THEMES.has(value.theme) || !text(value.url, 2048)) throw 0;
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw 0;
      const notification = Object.fromEntries(NOTIFICATION_FIELDS.map(field => [field, field === 'lines' ? [...value.lines] : value[field]]));
      if (this.#validate(structuredClone(notification)) !== true || Buffer.byteLength(JSON.stringify(notification)) > RECORD_BYTES) throw 0;
      return notification;
    } catch { throw new QueueError('INVALID_NOTIFICATION', 400); }
  }
  #readState(value) {
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'records', 'nextSendAt'].includes(key))
      || value.nextSendAt !== undefined && !time(value.nextSendAt)
      || !Array.isArray(value.records) || value.records.length > this.#maxRecords) throw new QueueError('STORAGE');
    const keys = new Set();
    return value.records.map(record => {
      if (!object(record) || Object.keys(record).some(field => !RECORD_FIELDS.includes(field)) || !KEY.test(record.key)
        || keys.has(record.key) || !STATES.has(record.state) || !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > 3
        || !time(record.createdAt) || !time(record.updatedAt) || record.updatedAt < record.createdAt
        || record.errorCode !== undefined && !CODES.has(record.errorCode)) throw new QueueError('STORAGE');
      keys.add(record.key);
      if (record.state === 'queued') {
        if (record.attempts >= 3 || !time(record.nextAttemptAt) || record.nextAttemptAt < record.updatedAt || record.messageId !== undefined) throw new QueueError('STORAGE');
      } else if (record.attempts < 1 || record.nextAttemptAt !== null) throw new QueueError('STORAGE');
      if (record.state === 'sent' ? typeof record.messageId !== 'string' || !MESSAGE_ID.test(record.messageId) : record.messageId !== undefined) throw new QueueError('STORAGE');
      if (TERMINAL.has(record.state)) {
        if (record.notification !== undefined) throw new QueueError('STORAGE');
        return { ...record };
      }
      let notification;
      try { notification = this.#notification(record.notification); } catch { throw new QueueError('STORAGE'); }
      if (notification.key !== record.key) throw new QueueError('STORAGE');
      return { ...record, notification };
    });
  }
  #prune(records, now) { return records.filter(record => !TERMINAL.has(record.state) || now - record.updatedAt < this.#retention); }
  #failStorage() {
    this.#lastError = 'STORAGE'; this.#ready = false; this.#started = false; this.#clearTicker();
    // The durable journal may still say sending. Both forms are terminal on
    // restart; expose uncertainty rather than pretending a send is still active.
    this.#records = this.#records.map(record => record.state === 'sending' ? this.#terminal(record, 'uncertain', 'STORAGE') : record);
  }
  async #commit(records, nextSendAt = this.#nextSendAt) {
    if (this.#lastError === 'STORAGE') throw new QueueError('STORAGE');
    const controller = new AbortController(); let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.#write(this.#file, structuredClone({ version: 1, records, nextSendAt }), { signal: controller.signal })),
        new Promise((_, reject) => { timer = this.#setTimeout(() => {
          controller.abort(); reject(new QueueError('STORAGE'));
        }, this.#writeTimeout); }),
      ]);
    }
    catch { this.#failStorage(); throw new QueueError('STORAGE'); }
    finally { this.#clearTimeout(timer); controller.abort(); }
    if (this.#lastError === 'STORAGE') throw new QueueError('STORAGE');
    this.#records = records; this.#nextSendAt = nextSendAt;
  }
  #terminal(record, state, errorCode, messageId) {
    const { notification, ...metadata } = record;
    return { ...metadata, state, updatedAt: Math.max(record.updatedAt, this.#clock()), nextAttemptAt: null,
      ...(errorCode ? { errorCode } : {}), ...(messageId ? { messageId } : {}) };
  }

  init() {
    if (this.#closed) return Promise.reject(new QueueError('CLOSED'));
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#serial(async () => {
      try {
        let saved;
        try {
          if ((await stat(this.#file)).size > this.#maxRecords * (RECORD_BYTES + 512)) throw new QueueError('STORAGE');
          saved = JSON.parse(await readFile(this.#file, 'utf8'));
        } catch (caught) { if (caught.code !== 'ENOENT') throw caught; }
        const now = this.#clock();
        const records = saved === undefined ? [] : this.#readState(saved);
        this.#records = records;
        this.#nextSendAt = Math.max(saved?.nextSendAt || 0, ...records.filter(record => record.state === 'queued' && record.errorCode === 'RATE_LIMITED').map(record => record.nextAttemptAt));
        let interrupted = false;
        const restored = this.#prune(records.map(record => {
          if (record.state !== 'sending') return record;
          interrupted = true; return this.#terminal(record, 'uncertain', 'INTERRUPTED');
        }), now);
        if (saved === undefined || interrupted || restored.length !== records.length) await this.#commit(restored);
        if (interrupted) this.#lastError = 'INTERRUPTED';
        this.#ready = true; return this;
      } catch { this.#failStorage(); throw new QueueError('STORAGE'); }
    });
    return this.#initializing;
  }

  enqueue(value) {
    let notification;
    try {
      this.#assertReady();
      if (this.#pending >= this.#maxPending) throw new QueueError('CAPACITY');
      notification = this.#notification(value);
    }
    catch (caught) { return Promise.reject(caught); }
    this.#pending++;
    return this.#serial(async () => {
      this.#assertReady();
      const now = this.#clock(), records = this.#prune(this.#records, now);
      if (records.some(record => record.key === notification.key)) return { accepted: false, duplicate: true };
      if (records.length >= this.#maxRecords) { this.#lastError = 'CAPACITY'; throw new QueueError('CAPACITY'); }
      records.push({ key: notification.key, state: 'queued', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now, notification });
      await this.#commit(records);
      if (this.#lastError === 'CAPACITY') this.#lastError = null;
      return { accepted: true, duplicate: false };
    }).finally(() => { this.#pending--; });
  }

  start() {
    this.#assertReady();
    if (this.#started) return this;
    this.#started = true; this.#schedule(0); return this;
  }
  #clearTicker() { if (this.#timer !== null) this.#clearTimeout(this.#timer); this.#timer = null; }
  #schedule(delay = this.#interval) {
    this.#clearTicker();
    if (!this.#started || this.#closed || !this.#ready) return;
    const timer = this.#setTimeout(() => {
      if (this.#timer !== timer) return;
      this.#timer = null; return this.#pump();
    }, delay);
    timer?.unref?.(); this.#timer = timer;
  }
  #pump() {
    if (this.#worker) return this.#worker;
    const task = this.#runOnce().catch(() => { if (this.#ready) this.#failStorage(); }).finally(() => {
      if (this.#worker === task) this.#worker = null;
      this.#schedule();
    });
    this.#worker = task; return task;
  }
  async #deliver(notification) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.#setTimeout(() => {
        controller.abort(); reject(Object.assign(new QueueError('SEND_TIMEOUT'), { delivery: 'uncertain' }));
      }, this.#sendTimeout);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => this.#send(structuredClone(notification), { signal: controller.signal })), timeout]);
    } finally { this.#clearTimeout(timer); }
  }
  async #runOnce() {
    const claim = await this.#serial(async () => {
      if (!this.#started || this.#closed || !this.#ready) return null;
      const now = this.#clock(), records = this.#prune(this.#records, now);
      const previous = now >= this.#nextSendAt ? records.find(record => record.state === 'queued' && record.nextAttemptAt <= now) : null;
      if (!previous) { if (records.length !== this.#records.length) await this.#commit(records); return null; }
      const sending = { ...previous, state: 'sending', attempts: previous.attempts + 1, updatedAt: Math.max(now, previous.updatedAt), nextAttemptAt: null };
      await this.#commit(records.map(record => record.key === previous.key ? sending : record));
      return { previous, sending };
    });
    if (!claim || !this.#ready) return;
    if (this.#closed) {
      await this.#serial(async () => { if (this.#ready) await this.#commit(this.#records.map(record => record.key === claim.sending.key ? claim.previous : record)); });
      return;
    }
    let result, failure;
    try { result = await this.#deliver(claim.sending.notification); } catch (caught) { failure = caught; }
    await this.#serial(async () => {
      if (!this.#ready) return;
      const record = this.#records.find(item => item.key === claim.sending.key);
      let updated, delay = this.#interval;
      if (!failure && typeof result?.messageId === 'string' && MESSAGE_ID.test(result.messageId)) {
        updated = this.#terminal(record, 'sent', null, result.messageId); delete updated.errorCode;
      } else if (failure?.delivery === 'rejected') {
        const limited = ['RATE_LIMITED', 429, '429'].includes(failure.code);
        const validDelay = Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0;
        const retryable = limited && validDelay && record.attempts < 3;
        if (limited) delay = Math.max(delay, this.#retryFloor, validDelay ? Math.min(MAX_RETRY_MS, failure.retryAfterMs) : 0);
        if (retryable) {
          const now = Math.max(this.#clock(), record.updatedAt);
          updated = { ...record, state: 'queued', updatedAt: now, nextAttemptAt: now + delay, errorCode: 'RATE_LIMITED' };
        } else updated = this.#terminal(record, 'rejected', limited ? 'RATE_LIMITED' : 'REJECTED');
      } else updated = this.#terminal(record, 'uncertain', failure?.code === 'SEND_TIMEOUT' ? 'SEND_TIMEOUT' : failure ? 'DELIVERY_UNKNOWN' : 'INVALID_CONFIRMATION');
      // Rate limits apply to the sending identity, not just this notification.
      // Persist the cooldown even when the limited record exhausts its attempts.
      await this.#commit(this.#records.map(item => item.key === record.key ? updated : item), Math.max(this.#clock(), updated.updatedAt) + delay);
      this.#lastError = updated.errorCode || null;
    });
  }

  snapshot() {
    const counts = { queued: 0, sending: 0, sent: 0, rejected: 0, uncertain: 0 };
    for (const record of this.#records) counts[record.state]++;
    return { ...counts, ready: this.#ready && !this.#closed, pending: this.#pending, lastError: this.#lastError };
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#started = false; this.#clearTicker();
    this.#closing = (async () => { await this.#worker; await this.#tail; })();
    return this.#closing;
  }
}
