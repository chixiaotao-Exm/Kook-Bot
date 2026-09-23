import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './storage.js';
import { applyActiveQuota, sanitizeActiveQuotaRecord } from './active-quota.js';

const HALF_HOUR = 30 * 60 * 1000;
const MAX_ACCOUNTS = 10000;
const ID = /^[1-9]\d{0,18}$/;
const ERROR_MESSAGES = {
  AUTO_RESET_ENABLED: '自动用卡已开启，已跳过主动查询。',
  AUTO_RESET_UNSAFE: '无法确认自动用卡已关闭，已跳过主动查询。',
  INELIGIBLE: '账号不符合主动查询条件。',
  TIMEOUT: '本次主动查询超时，保留上次数据。',
  CANCELLED: '本次主动查询已中止，保留上次数据。',
  QUERY_FAILED: '本次主动查询失败，保留上次数据。',
};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_ACCOUNTS ? value : 0;

function abortedError(signal) {
  const error = new Error('Active quota cancelled');
  error.code = signal?.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED';
  return error;
}

// Abort racing also bounds injected clients that fail to honor AbortSignal.
function waitFor(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortedError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortedError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

function eligibility(account) {
  if (!account || typeof account !== 'object' || !ID.test(String(account.id))) return 'INELIGIBLE';
  if (account.platform !== 'openai' || account.type !== 'oauth' || account.status !== 'active') return 'INELIGIBLE';
  if (account.parent_account_id !== undefined && account.parent_account_id !== null) return 'INELIGIBLE';
  if (account.quota_dimension !== undefined && account.quota_dimension !== null && !['', 'global'].includes(account.quota_dimension)) return 'INELIGIBLE';
  if (account.is_shadow === true || account.deleted_at) return 'INELIGIBLE';
  const extra = account.extra;
  if (extra !== undefined && extra !== null && (typeof extra !== 'object' || Array.isArray(extra))) return 'INELIGIBLE';
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && Object.hasOwn(extra, 'auto_reset_credit_enabled')) {
    if (extra.auto_reset_credit_enabled === true) return 'AUTO_RESET_ENABLED';
    if (extra.auto_reset_credit_enabled !== false) return 'AUTO_RESET_UNSAFE';
  }
  return null;
}

function sanitizeAccountState(value) {
  if (!value || !ID.test(String(value.id)) || !['success', 'failed', 'skipped', 'pending'].includes(value.status)) return null;
  const code = Object.hasOwn(ERROR_MESSAGES, value.code) ? value.code : null;
  return { id: String(value.id), status: value.status, queriedAt: iso(value.queriedAt), ...(code ? { code, error: ERROR_MESSAGES[code] } : {}) };
}

function sanitizeCycle(value, intervalMs) {
  if (!value || !iso(value.slot) || Date.parse(value.slot) % intervalMs !== 0 || !iso(value.startedAt) ||
      !['running', 'success', 'partial', 'failed', 'cancelled'].includes(value.status)) return null;
  const accounts = Array.isArray(value.accounts) ? value.accounts.slice(0, MAX_ACCOUNTS).map(sanitizeAccountState).filter(Boolean) : [];
  return { slot: iso(value.slot), startedAt: iso(value.startedAt), finishedAt: iso(value.finishedAt), status: value.status,
    counts: { success: count(value.counts?.success), failed: count(value.counts?.failed), skipped: count(value.counts?.skipped) }, accounts,
    error: ['LIST_FAILED', 'TIMEOUT', 'CANCELLED', 'STORAGE_FAILED', 'INTERRUPTED'].includes(value.error) ? value.error : null };
}

export class ActiveQuotaSchedule {
  #records = Object.create(null);
  #controller = null;
  #pending = null;
  #lastCycle = null;
  #storageError = '';

  constructor({ dataDir, listAccounts, queryAccount, enabled = true, now = Date.now,
    intervalMs = HALF_HOUR, pollMs = 15000, concurrency = 2, timeoutMs = 120000, queryTimeoutMs = 16000, onUpdated = null } = {}) {
    if (!dataDir || typeof listAccounts !== 'function' || typeof queryAccount !== 'function') throw new TypeError('Active quota dependencies are required');
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new TypeError('Invalid interval');
    Object.assign(this, { file: join(dataDir, 'active-quota.json'), listAccounts, queryAccount, enabled: enabled === true, now, intervalMs,
      pollMs: Math.max(1000, pollMs), concurrency: Math.max(1, Math.min(2, Math.floor(concurrency))),
      timeoutMs: Math.max(1, Math.min(120000, timeoutMs)), queryTimeoutMs: Math.max(1, Math.min(30000, queryTimeoutMs)), onUpdated });
    this.closed = false;
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.recordsById || typeof saved.recordsById !== 'object' || Array.isArray(saved.recordsById) ||
          Object.keys(saved.recordsById).length > MAX_ACCOUNTS) throw new Error('Invalid active quota cache');
      for (const [id, value] of Object.entries(saved.recordsById)) {
        const safe = sanitizeActiveQuotaRecord(value);
        if (ID.test(id) && safe?.accountId === id) this.#records[id] = safe;
      }
      this.#lastCycle = sanitizeCycle(saved.lastCycle, this.intervalMs);
      if (saved.lastCycle && !this.#lastCycle) throw new Error('Invalid active quota cycle');
      if (this.#lastCycle?.status === 'running') {
        this.#lastCycle.status = 'cancelled'; this.#lastCycle.error = 'INTERRUPTED';
        for (const account of this.#lastCycle.accounts) if (account.status === 'pending') Object.assign(account,
          { status: 'failed', code: 'CANCELLED', error: ERROR_MESSAGES.CANCELLED });
        this.#lastCycle.counts = this.#counts(this.#lastCycle.accounts);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#storageError = '上次主动查询记录无法读取；本时段暂不重复查询。';
        this.#lastCycle = { slot: this.#slot(), startedAt: new Date(this.now()).toISOString(), finishedAt: null,
          status: 'failed', counts: { success: 0, failed: 0, skipped: 0 }, accounts: [], error: 'STORAGE_FAILED' };
      }
    }
    return this;
  }

  #slot() { return new Date(Math.floor(this.now() / this.intervalMs) * this.intervalMs).toISOString(); }
  #counts(accounts) { return Object.fromEntries(['success', 'failed', 'skipped'].map(status => [status, accounts.filter(account => account.status === status).length])); }

  get records() { return Object.fromEntries(Object.entries(this.#records).map(([id, value]) => [id, structuredClone(value)])); }
  record(id) { const value = this.#records[String(id)]; return value ? structuredClone(value) : null; }

  apply(rawAccounts) {
    if (!Array.isArray(rawAccounts)) return rawAccounts;
    const states = new Map((this.#lastCycle?.accounts || []).map(state => [state.id, state]));
    return rawAccounts.map(raw => {
      const id = String(raw?.id);
      const state = states.get(id) || (this.#records[id] && this.#lastCycle?.error ? {
        status: 'failed', queriedAt: this.#records[id].queriedAt, error: ERROR_MESSAGES.QUERY_FAILED,
      } : null);
      const account = applyActiveQuota(raw, this.#records[id]);
      if (!account || typeof account !== 'object' || Array.isArray(account) || !state) return account;
      const extra = account.extra && typeof account.extra === 'object' && !Array.isArray(account.extra) ? account.extra : {};
      const stale = ['failed', 'skipped'].includes(state.status) && extra.codex_active_quota_observed_at;
      const pointsStale = ['failed', 'skipped'].includes(state.status) && extra.codex_active_points_observed_at;
      return { ...account, extra: { ...extra, ...(stale ? { codex_active_quota_stale: true } : {}),
        ...(pointsStale ? { codex_active_points_stale: true } : {}), dashboard_active_quota: {
        status: state.status, queriedAt: state.queriedAt, error: state.error || null,
      } } };
    });
  }

  snapshot() {
    const cycle = this.#lastCycle;
    const error = this.#storageError || (cycle?.error === 'LIST_FAILED' ? '无法读取账号列表，保留上次数据。'
      : cycle?.error === 'TIMEOUT' ? '本次主动查询超时，保留上次数据。'
        : cycle?.error === 'INTERRUPTED' ? '上次查询被中断，等待下一时段。' : cycle?.error === 'CANCELLED' ? '本次主动查询已中止。'
          : cycle?.counts.failed ? '部分账号查询失败，保留上次数据。' : '');
    return { enabled: this.enabled, intervalMs: this.intervalMs, running: Boolean(this.#pending),
      lastStartedAt: cycle?.startedAt || null, lastFinishedAt: cycle?.finishedAt || null,
      nextRunAt: this.enabled && !this.closed ? new Date((Math.floor(this.now() / this.intervalMs) + 1) * this.intervalMs).toISOString() : null,
      successCount: cycle?.counts.success || 0, failedCount: cycle?.counts.failed || 0, skippedCount: cycle?.counts.skipped || 0,
      accounts: (cycle?.accounts || []).map(account => ({ ...account })), lastError: error };
  }

  async #persist() {
    await atomicJson(this.file, { version: 1, recordsById: this.records, lastCycle: this.#lastCycle });
    this.#storageError = '';
  }

  run({ signal } = {}) {
    if (!this.enabled || this.closed) return Promise.resolve(this.snapshot());
    if (this.#pending) return waitFor(this.#pending, signal);
    if (signal?.aborted) return Promise.reject(abortedError(signal));
    const slot = this.#slot();
    // Also guard against a backward system-clock adjustment replaying older slots.
    if (this.#lastCycle && Date.parse(this.#lastCycle.slot) >= Date.parse(slot)) return Promise.resolve(this.snapshot());
    this.#controller = new AbortController();
    const cycleSignal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => this.#execute(slot, cycleSignal));
    this.#pending = task.finally(() => { this.#pending = null; this.#controller = null; }).then(() => this.snapshot());
    return this.#pending;
  }

  ensureCurrent(options = {}) { return this.run(options); }

  async #execute(slot, signal) {
    const cycle = { slot, startedAt: new Date(this.now()).toISOString(), finishedAt: null, status: 'running',
      counts: { success: 0, failed: 0, skipped: 0 }, accounts: [], error: null };
    this.#lastCycle = cycle;
    try {
      // Claim the current half-hour durably before any upstream query is allowed.
      await this.#persist();
    } catch {
      cycle.status = 'failed'; cycle.error = 'STORAGE_FAILED'; cycle.finishedAt = new Date(this.now()).toISOString();
      this.#storageError = '无法保存主动查询记录；已停止本时段查询。';
      return this.snapshot();
    }
    try {
      if (signal.aborted) throw abortedError(signal);
      let accounts;
      try {
        accounts = await waitFor(Promise.resolve().then(() => this.listAccounts({ signal })), signal);
        if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS) throw new Error('Invalid accounts');
      } catch (error) {
        cycle.error = signal.aborted ? abortedError(signal).code : 'LIST_FAILED';
        throw error;
      }
      const seen = new Set();
      const eligible = [];
      for (const account of accounts) {
        const id = String(account?.id);
        if (!ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        const code = eligibility(account);
        const state = { id, status: code ? 'skipped' : 'pending', queriedAt: this.#records[id]?.queriedAt || null,
          ...(code ? { code, error: ERROR_MESSAGES[code] } : {}) };
        cycle.accounts.push(state);
        if (!code) eligible.push(state);
      }
      for (const id of Object.keys(this.#records)) if (!seen.has(id)) delete this.#records[id];
      // Raw account objects are deliberately never stored or passed to the cache.
      accounts = null;
      let cursor = 0;
      const worker = async () => {
        while (cursor < eligible.length && !signal.aborted) {
          const state = eligible[cursor++];
          const querySignal = AbortSignal.any([signal, AbortSignal.timeout(this.queryTimeoutMs)]);
          try {
            const raw = await waitFor(Promise.resolve().then(() => this.queryAccount(state.id, { signal: querySignal })), querySignal);
            if (signal.aborted) throw abortedError(signal);
            const record = sanitizeActiveQuotaRecord(raw);
            if (!record || record.accountId !== state.id) throw new Error('Invalid active quota result');
            this.#records[state.id] = record;
            state.status = 'success'; state.queriedAt = record.queriedAt;
          } catch (error) {
            const code = querySignal.aborted ? abortedError(querySignal).code
              : error.code === 'AUTO_RESET' ? 'AUTO_RESET_UNSAFE'
                : ['AUTO_RESET_ENABLED', 'AUTO_RESET_UNSAFE', 'INELIGIBLE'].includes(error.code) ? error.code
                : error.code === 'TIMEOUT' ? 'TIMEOUT' : 'QUERY_FAILED';
            Object.assign(state, { status: ['AUTO_RESET_ENABLED', 'AUTO_RESET_UNSAFE', 'INELIGIBLE'].includes(code) ? 'skipped' : 'failed', code, error: ERROR_MESSAGES[code] });
          }
          cycle.counts = this.#counts(cycle.accounts);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, eligible.length) }, worker));
      if (signal.aborted) throw abortedError(signal);
      cycle.status = cycle.counts.failed ? cycle.counts.success ? 'partial' : 'failed' : 'success';
    } catch {
      const code = signal.aborted ? abortedError(signal).code : 'QUERY_FAILED';
      cycle.error ||= code;
      cycle.status = code === 'CANCELLED' ? 'cancelled' : 'failed';
      for (const state of cycle.accounts) if (state.status === 'pending') Object.assign(state, { status: 'failed', code, error: ERROR_MESSAGES[code] });
    }
    cycle.counts = this.#counts(cycle.accounts);
    cycle.finishedAt = new Date(this.now()).toISOString();
    try { await this.#persist(); }
    catch { this.#storageError = '主动查询完成，但本地记录保存失败。'; }
    if (!this.closed && !signal.aborted && typeof this.onUpdated === 'function') {
      try { await waitFor(Promise.resolve().then(() => this.onUpdated()), signal); } catch { /* A dashboard refresh can recover independently. */ }
    }
    return this.snapshot();
  }

  start() {
    if (this.timer || this.closed || !this.enabled) return;
    this.timer = setInterval(() => { void this.ensureCurrent().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
    void this.ensureCurrent().catch(() => {});
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer); this.timer = null;
    this.#controller?.abort();
    await this.#pending?.catch(() => {});
  }
}
