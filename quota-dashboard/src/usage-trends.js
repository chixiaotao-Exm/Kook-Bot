// Sub2API e8cb019fabf8b55199436229044cbf9aa7a82564, UsageHandler.Stats:
// equal start/end dates cover one local day; the trend endpoint's SQL date
// buckets do not apply the requested timezone, so use explicit daily totals.
const TIME_ZONE = 'Asia/Shanghai', DAY = 86400000, MAX_BYTES = 256 * 1024;
const FIELDS = { requests: 'total_requests', tokens: 'total_tokens', accountCost: 'total_account_cost', userCost: 'total_actual_cost' };
const MESSAGES = {
  INVALID_RANGE: '请选择最近 7 天或 30 天。', INVALID_ACCOUNT: '账号不存在或当前不可见。',
  BUSY: '趋势查询较多，请稍后重试。', CLOSED: '趋势服务已关闭。',
  AUTH: '用量统计暂时不可读，请检查服务端权限。', FORMAT: '用量统计返回的数据不完整，保留已有记录。',
  UPSTREAM: '用量统计暂时读取失败，保留已有记录。', TIMEOUT: '用量统计读取超时，保留已有记录。',
  BUDGET: '本次趋势查询未能在时限内完成，保留已有记录。',
  DATE_CHANGED: '北京时间日期已变化，请刷新趋势。', UNKNOWN: '当天用量暂不可读。',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const validNumber = (value, field) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && value <= Number.MAX_SAFE_INTEGER && (!['requests', 'tokens'].includes(field) || Number.isSafeInteger(value));
const nullCounts = () => Object.fromEntries(Object.keys(FIELDS).map(field => [field, null]));
const dayAt = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const rangeDates = (endDate, days) => Array.from({ length: days }, (_, index) =>
  new Date(Date.parse(`${endDate}T00:00:00Z`) - (days - index - 1) * DAY).toISOString().slice(0, 10));
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

export class UsageTrendsError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'UsageTrendsError'; this.code = code; this.status = status; }
}
const fault = (code, status = 502) => new UsageTrendsError(code, MESSAGES[code] || MESSAGES.UPSTREAM, status);

/** Fixed, read-only daily aggregates. No logs, identities or upstream responses are cached. */
export class UsageTrends {
  #url; #key; #ids; #fetch; #now; #clock; #timeout; #budget; #ttl; #cacheSize;
  #cache = new Map(); #flights = new Map(); #jobs = new Map(); #controllers = new Set();
  #active = 0; #waiters = []; #closed = false;

  constructor({ baseUrl, adminApiKey, getAccountIds, fetchImpl = fetch, now = Date.now,
    monotonicNow = () => performance.now(), timeoutMs = 5000, batchTimeoutMs = 35000,
    cacheMs = 300000, maxCacheEntries = 1024 } = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/'
      || typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)
      || typeof getAccountIds !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof monotonicNow !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isInteger(batchTimeoutMs) || batchTimeoutMs < 1 || batchTimeoutMs > 60000
      || !Number.isInteger(cacheMs) || cacheMs < 1 || cacheMs > 3600000
      || !Number.isInteger(maxCacheEntries) || maxCacheEntries < 30 || maxCacheEntries > 5000) throw new Error('Invalid usage trends configuration');
    this.#url = new URL('/api/v1/admin/usage/stats', base.origin); this.#key = adminApiKey.trim();
    this.#ids = getAccountIds; this.#fetch = fetchImpl; this.#now = now; this.#clock = monotonicNow;
    this.#timeout = timeoutMs; this.#budget = batchTimeoutMs; this.#ttl = cacheMs; this.#cacheSize = maxCacheEntries;
  }

  #scope(accountId) {
    if (accountId === 'all') return;
    if (!validId(accountId)) throw fault('INVALID_ACCOUNT', 404);
    const ids = this.#ids();
    if (!Array.isArray(ids) || ids.length > 10000 || !ids.includes(accountId)) throw fault('INVALID_ACCOUNT', 404);
  }
  #keyFor(accountId, date) { return `${accountId}:${date}`; }
  #cached(key) {
    const entry = this.#cache.get(key);
    if (entry) { this.#cache.delete(key); this.#cache.set(key, entry); }
    return entry;
  }
  #store(key, entry) {
    this.#cache.delete(key); this.#cache.set(key, entry);
    while (this.#cache.size > this.#cacheSize) this.#cache.delete(this.#cache.keys().next().value);
    return entry;
  }
  #row(date, entry, fallback = 'UNKNOWN') {
    const stale = !entry || Boolean(entry.error) || this.#clock() >= entry.expiresAt;
    return { date, ...(entry?.counts || nullCounts()), observedAt: entry?.observedAt || null, stale,
      error: entry?.error ? MESSAGES[entry.error] || MESSAGES.UPSTREAM : stale ? MESSAGES[fallback] || MESSAGES.UNKNOWN : '' };
  }

  #available(batch) {
    if (this.#closed) throw fault('CLOSED', 503);
    if (batch.stopped || this.#clock() >= batch.deadline) throw fault('BUDGET', 504);
  }
  #release() {
    this.#active--;
    while (this.#active < 2 && this.#waiters.length) {
      const waiting = this.#waiters.shift(); clearTimeout(waiting.timer);
      try { this.#available(waiting.batch); }
      catch (error) { waiting.reject(error); continue; }
      this.#active++; waiting.resolve(this.#releaseOnce());
    }
  }
  #releaseOnce() { let released = false; return () => { if (!released) { released = true; this.#release(); } }; }
  #slot(batch) {
    this.#available(batch);
    if (this.#active < 2) { this.#active++; return Promise.resolve(this.#releaseOnce()); }
    return new Promise((resolve, reject) => {
      const waiting = { batch, resolve, reject, timer: null };
      waiting.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiting); if (index !== -1) this.#waiters.splice(index, 1);
        reject(fault('BUDGET', 504));
      }, Math.max(1, Math.ceil(batch.deadline - this.#clock())));
      this.#waiters.push(waiting);
    });
  }

  async #read(response, signal) {
    if (Number(response.headers?.get('content-length')) > MAX_BYTES) { cancelBody(response.body); throw fault('FORMAT'); }
    const reader = response.body?.getReader(); if (!reader) throw fault('FORMAT');
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks = []; let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw fault('TIMEOUT', 504);
        const { done, value } = await reader.read(); if (done) break;
        if (!(value instanceof Uint8Array)) throw fault('FORMAT');
        size += value.byteLength; if (size > MAX_BYTES) throw fault('FORMAT');
        chunks.push(Buffer.from(value));
      }
      if (signal.aborted) throw fault('TIMEOUT', 504);
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw fault('FORMAT'); }
      if (![0, 200].includes(body?.code) || !object(body.data)) throw fault('FORMAT');
      const counts = Object.fromEntries(Object.entries(FIELDS).map(([field, upstream]) => [field, body.data[upstream]]));
      if (Object.entries(counts).some(([field, value]) => !validNumber(value, field))) throw fault('FORMAT');
      return counts;
    } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
  }
  async #request(accountId, date) {
    const controller = new AbortController(); this.#controllers.add(controller);
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(fault(this.#closed ? 'CLOSED' : 'TIMEOUT', this.#closed ? 503 : 504));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), this.#timeout);
    });
    const work = async () => {
      const url = new URL(this.#url);
      url.search = new URLSearchParams({ start_date: date, end_date: date, timezone: TIME_ZONE,
        ...(accountId === 'all' ? {} : { account_id: accountId }) }).toString();
      const response = await this.#fetch(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'x-api-key': this.#key, accept: 'application/json' } });
      if (controller.signal.aborted || this.#closed) { cancelBody(response?.body); throw fault('CLOSED', 503); }
      if (!response?.ok || response.redirected || response.status >= 300 && response.status < 400) {
        cancelBody(response?.body); throw fault([401, 403].includes(response?.status) ? 'AUTH' : 'UPSTREAM');
      }
      return this.#read(response, controller.signal);
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (error) { throw error instanceof UsageTrendsError ? error : fault('UPSTREAM'); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controller.abort(); this.#controllers.delete(controller); }
  }
  async #query(accountId, date, batch) {
    const release = await this.#slot(batch);
    try {
      // Waiting for a global slot consumes this report's original budget.
      this.#available(batch); this.#scope(accountId);
      const key = this.#keyFor(accountId, date), previous = this.#cached(key);
      try {
        const counts = await this.#request(accountId, date);
        if (this.#closed) throw fault('CLOSED', 503);
        return this.#store(key, { counts, observedAt: new Date(this.#now()).toISOString(), error: '', expiresAt: this.#clock() + this.#ttl });
      } catch (error) {
        if (this.#closed || error.code === 'CLOSED') throw fault('CLOSED', 503);
        // Stop queued work before releasing the global slot, not only when a
        // worker later consumes this result through its promise chain.
        const code = Object.hasOwn(MESSAGES, error.code) ? error.code : 'UPSTREAM';
        batch.stopped = true; batch.reason ||= code;
        return this.#store(key, { counts: previous?.counts || null, observedAt: previous?.observedAt || null,
          error: code, expiresAt: this.#clock() + this.#ttl });
      }
    } finally { release(); }
  }
  async #sample(accountId, date, batch) {
    this.#available(batch);
    const key = this.#keyFor(accountId, date);
    if (this.#flights.has(key)) {
      let timer;
      // Another report can own this shared day query. Do not let its later
      // deadline extend this report beyond one final in-flight request.
      try { return await Promise.race([this.#flights.get(key), new Promise((_, reject) => {
        timer = setTimeout(() => reject(fault('BUDGET', 504)), Math.max(1, Math.ceil(batch.deadline - this.#clock() + this.#timeout)));
      })]); } finally { clearTimeout(timer); }
    }
    const task = this.#query(accountId, date, batch).finally(() => { if (this.#flights.get(key) === task) this.#flights.delete(key); });
    this.#flights.set(key, task); return task;
  }
  async #range(accountId, dates, batch) {
    const rows = new Map(); let next = dates.length - 1;
    const worker = async () => {
      while (next >= 0 && !batch.stopped) {
        const date = dates[next--], cached = this.#cached(this.#keyFor(accountId, date));
        if (cached && this.#clock() < cached.expiresAt) {
          rows.set(date, this.#row(date, cached));
          if (cached.error) { batch.stopped = true; batch.reason ||= cached.error; }
          continue;
        }
        try {
          const entry = await this.#sample(accountId, date, batch);
          rows.set(date, this.#row(date, entry));
          if (entry.error) { batch.stopped = true; batch.reason ||= entry.error; }
        } catch (error) { batch.stopped = true; batch.reason ||= error.code || 'UPSTREAM'; }
      }
    };
    await Promise.all([worker(), worker()]);
    return dates.map(date => rows.get(date) || this.#row(date, this.#cached(this.#keyFor(accountId, date)), batch.reason));
  }
  #result(days, accountId, dates, rows, reason = '') {
    const totals = Object.fromEntries(Object.keys(FIELDS).map(field => {
      if (rows.some(row => row[field] === null)) return [field, null];
      const value = rows.reduce((sum, row) => sum + row[field], 0);
      return [field, validNumber(value, field) ? value : null];
    }));
    const stale = rows.some(row => row.stale) || Boolean(reason);
    const complete = !stale && Object.values(totals).every(value => value !== null);
    const observed = rows.map(row => typeof row.observedAt === 'string' ? Date.parse(row.observedAt) : NaN).filter(Number.isFinite);
    return { days, accountId, timeZone: TIME_ZONE, startDate: dates[0], endDate: dates.at(-1), rows, totals,
      complete, stale, checkedAt: observed.length ? new Date(Math.min(...observed)).toISOString() : null, refreshIntervalMs: this.#ttl,
      lastError: complete ? '' : MESSAGES[reason] || '部分趋势数据暂不可读或已过期，未将未知值作为零。' };
  }
  async #report(days, accountId, endDate) {
    const batch = { deadline: this.#clock() + this.#budget, stopped: false, reason: '' };
    for (let pass = 0; pass < 2; pass++) {
      const dates = rangeDates(endDate, days), rows = await this.#range(accountId, dates, batch);
      const currentDate = dayAt(this.#now());
      if (currentDate === endDate) return this.#result(days, accountId, dates, rows, batch.reason);
      endDate = currentDate;
    }
    const dates = rangeDates(endDate, days);
    return this.#result(days, accountId, dates, dates.map(date => this.#row(date, this.#cached(this.#keyFor(accountId, date)), 'DATE_CHANGED')), 'DATE_CHANGED');
  }

  async get({ days = 7, accountId = 'all' } = {}) {
    if (this.#closed) throw fault('CLOSED', 503);
    if (![7, 30].includes(days)) throw fault('INVALID_RANGE', 400);
    this.#scope(accountId);
    const endDate = dayAt(this.#now()), key = `${accountId}:${days}:${endDate}`;
    let pending = this.#jobs.get(key);
    if (!pending) {
      if (this.#jobs.size >= 4) throw fault('BUSY', 429);
      pending = Promise.resolve().then(() => this.#report(days, accountId, endDate)).finally(() => { if (this.#jobs.get(key) === pending) this.#jobs.delete(key); });
      this.#jobs.set(key, pending);
    }
    const result = await pending;
    if (this.#closed) throw fault('CLOSED', 503);
    this.#scope(accountId);
    return structuredClone(result);
  }
  async close() {
    this.#closed = true;
    for (const waiting of this.#waiters.splice(0)) { clearTimeout(waiting.timer); waiting.reject(fault('CLOSED', 503)); }
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled([...this.#jobs.values()]);
  }
}
