// Read-only Sub2API admin APIs, audited against e8cb019:
// users + users/:id/api-keys are paginated; search-api-keys only returns 30.
// dashboard/api-keys-usage.total_actual_cost is a rolling 30-day sum. Its
// today field uses the server timezone, so query today's stats explicitly.
const TIME_ZONE = 'Asia/Shanghai', MAX_BYTES = 2 * 1024 * 1024;
const MESSAGES = {
  AUTH: 'API Key 用量暂不可读，请检查服务端权限。',
  FORMAT: 'API Key 用量数据不完整，已保留可用记录。',
  UPSTREAM: 'API Key 用量读取失败，已保留可用记录。',
  TIMEOUT: 'API Key 用量读取超时，已保留可用记录。',
  BUDGET: '本次 API Key 用量查询超过时限，已保留可用记录。',
  LIMIT: 'API Key 列表超过查询上限，未将部分列表作为全部。',
  DATE_CHANGED: '北京时间日期已变化，今日用量等待刷新。',
  STALE: 'API Key 用量等待刷新。', CLOSED: 'API Key 用量服务已关闭。',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idOf = value => Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const todayAt = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const nullToday = () => ({ requests: null, tokens: null, cost: null });
const iso = value => typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function safeName(value, id, secret) {
  if (typeof value !== 'string') return `API Key #${id}`;
  // Raw key material is used only to redact a user-provided name here; neither
  // the original value nor a suffix/hash is retained in the public snapshot.
  if (typeof secret === 'string' && secret) value = value.replaceAll(secret, '[已隐藏密钥]');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:sk|admin)-[A-Za-z0-9_-]{8,}/g, '[已隐藏密钥]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐藏邮箱]').trim().slice(0, 100) || `API Key #${id}`;
}
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

export class AllKeyUsageError extends Error {
  constructor(code, status = 502) { super(MESSAGES[code] || MESSAGES.UPSTREAM); this.name = 'AllKeyUsageError'; this.code = code; this.status = status; }
}
const fault = (code, status) => new AllKeyUsageError(code, status);

function keyMetadata(raw) {
  const id = idOf(raw?.id);
  if (!id) throw fault('FORMAT');
  const limit = number(raw.quota), used = number(raw.quota_used);
  return { id, name: safeName(raw.name, id, raw.key), keyHint: `ID #${id}`,
    status: ['active', 'inactive', 'disabled', 'expired', 'quota_exhausted'].includes(raw.status) ? raw.status : 'unknown',
    quota: { used, limit, remaining: limit !== null && limit > 0 && used !== null ? Math.max(0, limit - used) : null,
      unlimited: limit === null ? null : limit === 0 }, lastUsedAt: iso(raw.last_used_at) };
}
function total(rows, value) {
  const values = rows.map(value);
  return values.some(item => item === null) ? null : number(values.reduce((sum, item) => sum + item, 0));
}
function totals(rows, known) {
  return { keys: known ? rows.length : null, activeKeys: known ? rows.filter(row => row.status === 'active').length : null,
    todayRequests: known ? total(rows, row => row.today.requests) : null,
    todayTokens: known ? total(rows, row => row.today.tokens) : null,
    todayCost: known ? total(rows, row => row.today.cost) : null,
    last30DaysCost: known ? total(rows, row => row.last30DaysCost) : null };
}

/** Only normalized public display fields are retained, never raw keys/users. */
export class AllKeyUsage {
  #base; #key; #fetch; #now; #clock; #timeout; #budget; #ttl; #maxUsers; #maxKeys;
  #cache = null; #flight = null; #controllers = new Set(); #closed = false; #expiresAt = 0;

  constructor({ baseUrl, adminApiKey, fetchImpl = fetch, now = Date.now, monotonicNow = () => performance.now(),
    timeoutMs = 8000, batchTimeoutMs = 90000, cacheMs = 600000, maxUsers = 2000, maxKeys = 5000 } = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/'
      || typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)
      || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof monotonicNow !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(batchTimeoutMs) || batchTimeoutMs < 1 || batchTimeoutMs > 120000
      || !Number.isInteger(cacheMs) || cacheMs < 1 || cacheMs > 3600000
      || !Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 10000
      || !Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 10000) throw new Error('Invalid all-key usage configuration');
    this.#base = base; this.#key = adminApiKey.trim(); this.#fetch = fetchImpl; this.#now = now; this.#clock = monotonicNow;
    this.#timeout = timeoutMs; this.#budget = batchTimeoutMs; this.#ttl = cacheMs; this.#maxUsers = maxUsers; this.#maxKeys = maxKeys;
  }

  snapshot() {
    const day = todayAt(this.#now());
    const result = this.#cache ? structuredClone(this.#cache) : { enabled: true, updatedAt: null, refreshIntervalMs: this.#ttl,
      stale: true, complete: false, error: null, timeZone: TIME_ZONE, day, rows: [], totals: totals([], false), scope: 'current_keys' };
    result.loading = Boolean(this.#flight);
    if (result.day !== day) {
      result.day = day; result.stale = true; result.complete = false; result.error = MESSAGES.DATE_CHANGED;
      for (const row of result.rows) { row.today = nullToday(); row.stale = true; }
      result.totals.todayRequests = null; result.totals.todayTokens = null; result.totals.todayCost = null;
    }
    if (this.#cache && this.#clock() >= this.#expiresAt) {
      result.stale = true; result.complete = false; result.error ||= MESSAGES.STALE;
      for (const row of result.rows) row.stale = true;
    }
    return result;
  }

  #available(batch) {
    if (this.#closed) throw fault('CLOSED', 503);
    if (batch.reason) throw fault(batch.reason);
    if (this.#clock() >= batch.deadline) throw fault('BUDGET', 504);
  }

  async #read(response, signal) {
    if (Number(response.headers?.get('content-length')) > MAX_BYTES) { cancelBody(response.body); throw fault('FORMAT'); }
    const reader = response.body?.getReader(); if (!reader) throw fault('FORMAT');
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
    signal.addEventListener('abort', cancel, { once: true });
    let size = 0; const chunks = [];
    try {
      for (;;) {
        if (signal.aborted) throw fault('TIMEOUT', 504);
        const { done, value } = await reader.read(); if (done) break;
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > MAX_BYTES) throw fault('FORMAT');
        chunks.push(Buffer.from(value));
      }
      if (signal.aborted) throw fault('TIMEOUT', 504);
      let raw;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw fault('FORMAT'); }
      if (![0, 200].includes(raw?.code) || !object(raw.data)) throw fault('FORMAT');
      return raw.data;
    } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
  }

  async #request(path, params, batch, data) {
    this.#available(batch);
    const controller = new AbortController(); this.#controllers.add(controller);
    const remaining = Math.max(1, Math.ceil(batch.deadline - this.#clock()));
    const duration = Math.min(this.#timeout, remaining); let timer, onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(fault(this.#closed ? 'CLOSED' : duration < this.#timeout ? 'BUDGET' : 'TIMEOUT', this.#closed ? 503 : 504));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), duration);
    });
    const work = async () => {
      const url = new URL(path, this.#base); if (params) url.search = new URLSearchParams(params).toString();
      const response = await this.#fetch(url.href, { method: data ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'x-api-key': this.#key, accept: 'application/json', ...(data ? { 'content-type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
      if (controller.signal.aborted || this.#closed) { cancelBody(response?.body); throw fault('CLOSED', 503); }
      if (!response?.ok || response.redirected || response.status >= 300 && response.status < 400) {
        cancelBody(response?.body); throw fault([401, 403].includes(response?.status) ? 'AUTH' : 'UPSTREAM');
      }
      return this.#read(response, controller.signal);
    };
    try { return await Promise.race([work(), stopped]); }
    catch (error) { throw error instanceof AllKeyUsageError ? error : fault('UPSTREAM'); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controller.abort(); this.#controllers.delete(controller); }
  }

  async #list(path, batch, maximum, normalize) {
    const rows = [], seen = new Set(); let expectedTotal = null;
    for (let page = 1; ; page++) {
      const data = await this.#request(path, { page: String(page), page_size: '100', sort_by: 'id', sort_order: 'asc' }, batch);
      if (!Array.isArray(data.items) || count(data.total) === null || !Number.isInteger(data.page_size)
        || data.page_size < 1 || data.page_size > 1000 || data.page !== page || data.items.length > data.page_size
        || data.total < rows.length || expectedTotal !== null && data.total !== expectedTotal) throw fault('FORMAT');
      if (data.total > maximum) throw fault('LIMIT');
      expectedTotal = data.total;
      for (const item of data.items) {
        const row = normalize(item), id = typeof row === 'string' ? row : row.id;
        if (!id || seen.has(id)) throw fault('FORMAT');
        seen.add(id); rows.push(row);
      }
      if (rows.length === data.total) return rows;
      if (rows.length > data.total || !data.items.length || data.items.length < data.page_size || rows.length > maximum) throw fault('FORMAT');
    }
  }

  async #workers(items, batch, visit) {
    let next = 0;
    const worker = async () => {
      while (next < items.length && !batch.reason) {
        const item = items[next++];
        try { this.#available(batch); await visit(item); }
        catch (error) { batch.reason ||= error instanceof AllKeyUsageError ? error.code : 'UPSTREAM'; }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async #inventory(batch) {
    const users = await this.#list('/api/v1/admin/users', batch, this.#maxUsers, raw => {
      const id = idOf(raw?.id); if (!id) throw fault('FORMAT'); return id;
    });
    const keys = new Map();
    await this.#workers(users, batch, async userId => {
      const rows = await this.#list(`/api/v1/admin/users/${userId}/api-keys`, batch, this.#maxKeys, keyMetadata);
      for (const row of rows) {
        if (keys.has(row.id)) throw fault('FORMAT');
        keys.set(row.id, row); if (keys.size > this.#maxKeys) throw fault('LIMIT');
      }
    });
    if (batch.reason) throw fault(batch.reason);
    return [...keys.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  async #refresh() {
    const batch = { deadline: this.#clock() + this.#budget, reason: '' }, day = todayAt(this.#now());
    const previous = this.#cache, oldRows = new Map((previous?.rows || []).map(row => [row.id, row]));
    let rows;
    try {
      const inventory = await this.#inventory(batch);
      rows = inventory.map(meta => ({ ...meta, today: nullToday(), last30DaysCost: null, checkedAt: null, stale: true }));
      const byId = new Map(rows.map(row => [row.id, row]));
      const jobs = rows.map(row => ({ row }));
      for (let index = 0; index < rows.length; index += 100) jobs.push({ ids: rows.slice(index, index + 100).map(row => row.id) });
      await this.#workers(jobs, batch, async job => {
        if (job.row) {
          const raw = await this.#request('/api/v1/admin/usage/stats', { api_key_id: job.row.id, start_date: day, end_date: day, timezone: TIME_ZONE }, batch);
          const today = { requests: count(raw.total_requests), tokens: count(raw.total_tokens), cost: number(raw.total_actual_cost) };
          if (Object.values(today).some(value => value === null)) throw fault('FORMAT');
          job.row.today = today; job.row.checkedAt = new Date(this.#now()).toISOString();
        } else {
          const raw = await this.#request('/api/v1/admin/dashboard/api-keys-usage', null, batch, { api_key_ids: job.ids.map(Number) });
          if (!object(raw.stats)) throw fault('FORMAT');
          const values = job.ids.map(id => {
            const value = raw.stats[id];
            if (!object(value) || idOf(value.api_key_id) !== id || number(value.total_actual_cost) === null) throw fault('FORMAT');
            return { id, cost: value.total_actual_cost };
          });
          for (const value of values) byId.get(value.id).last30DaysCost = value.cost;
        }
      });
      if (this.#closed) throw fault('CLOSED', 503);
      const crossedDate = todayAt(this.#now()) !== day;
      if (crossedDate) batch.reason = 'DATE_CHANGED';
      for (const row of rows) {
        const old = oldRows.get(row.id);
        row.stale = row.today.cost === null || row.last30DaysCost === null || crossedDate;
        if (row.today.cost === null && old && previous.day === day) { row.today = { ...old.today }; row.checkedAt = old.checkedAt; }
        if (row.last30DaysCost === null && old) {
          row.last30DaysCost = old.last30DaysCost;
          // The display timestamp must not make an older retained 30-day
          // sample look newly observed just because today's query succeeded.
          if (old.checkedAt && (!row.checkedAt || Date.parse(old.checkedAt) < Date.parse(row.checkedAt))) row.checkedAt = old.checkedAt;
        }
      }
      const observed = rows.map(row => Date.parse(row.checkedAt)).filter(Number.isFinite);
      const stale = Boolean(batch.reason) || rows.some(row => row.stale);
      this.#cache = { enabled: true, updatedAt: observed.length ? new Date(Math.min(...observed)).toISOString() : rows.length ? null : new Date(this.#now()).toISOString(),
        refreshIntervalMs: this.#ttl, stale, complete: !stale, error: stale ? MESSAGES[batch.reason] || MESSAGES.FORMAT : null,
        timeZone: TIME_ZONE, day, rows, totals: totals(rows, true), scope: 'current_keys' };
    } catch (error) {
      if (this.#closed || error.code === 'CLOSED') throw fault('CLOSED', 503);
      const saved = this.snapshot();
      saved.stale = true; saved.complete = false; saved.error = MESSAGES[error.code] || MESSAGES.UPSTREAM;
      for (const row of saved.rows) row.stale = true;
      // Inventory could have changed. Do not claim a previous or partial count
      // is the current complete key list after a failed enumeration.
      saved.totals = totals(saved.rows, false); this.#cache = saved;
    }
    this.#expiresAt = this.#clock() + this.#ttl;
  }

  async get() {
    if (this.#closed) throw fault('CLOSED', 503);
    if (!this.#flight && (!this.#cache || this.#clock() >= this.#expiresAt || this.#cache.day !== todayAt(this.#now()))) {
      const pending = Promise.resolve().then(() => this.#refresh()).finally(() => { if (this.#flight === pending) this.#flight = null; });
      this.#flight = pending;
    }
    if (this.#flight) await this.#flight;
    if (this.#closed) throw fault('CLOSED', 503);
    return this.snapshot();
  }

  async close() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    if (this.#flight) await Promise.allSettled([this.#flight]);
  }
}
