const ID = /^[1-9]\d{0,18}$/;
const MAX_ACCOUNTS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validId = value => typeof value === 'string' && ID.test(value);
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }
const unknown = id => ({ id, current: null, limit: null, percent: null, observedAt: null, freshness: 'unknown' });

/** One shared, demand-driven cache for the read-only Sub2API concurrency endpoint. */
export class AccountLoad {
  #url; #key; #fetch; #ids; #now; #timeout; #interval; #staleAfter;
  #rows = new Map(); #checkedAt = null; #lastAttempt = null; #error = ''; #enabled = true;
  #pending = null; #closed = false; #controller = null;
  constructor({ baseUrl, adminApiKey, getAccountIds, fetchImpl = fetch, now = Date.now,
    timeoutMs = 5000, refreshIntervalMs = 10000, staleAfterMs = 25000 } = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/'
      || typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)
      || typeof getAccountIds !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1000 || refreshIntervalMs > 60000
      || !Number.isInteger(staleAfterMs) || staleAfterMs < refreshIntervalMs || staleAfterMs > 120000) throw new Error('Invalid account load configuration');
    this.#url = new URL('/api/v1/admin/ops/concurrency', base.origin).href;
    this.#key = adminApiKey.trim(); this.#fetch = fetchImpl; this.#ids = getAccountIds; this.#now = now;
    this.#timeout = timeoutMs; this.#interval = refreshIntervalMs; this.#staleAfter = staleAfterMs;
  }
  #visibleIds() {
    const ids = this.#ids();
    if (!Array.isArray(ids) || ids.length > MAX_ACCOUNTS) throw new Error('Invalid visible accounts');
    return [...new Set(ids.filter(validId))];
  }
  snapshot() {
    const now = this.#now();
    const accounts = !this.#enabled ? [] : this.#visibleIds().map(id => {
      const cached = this.#rows.get(id); if (!cached) return unknown(id);
      const age = cached.observedAt ? now - Date.parse(cached.observedAt) : NaN;
      const freshness = !Number.isFinite(age) || age < -1000 ? 'unknown'
        : this.#error || age > this.#staleAfter ? 'stale' : 'fresh';
      return { ...cached, freshness };
    });
    return { enabled: this.#enabled, accounts, checkedAt: this.#checkedAt,
      refreshIntervalMs: this.#interval, lastError: this.#error };
  }
  async #read(signal) {
    const response = await this.#fetch(this.#url, { method: 'GET', redirect: 'manual', signal,
      headers: { 'x-api-key': this.#key, accept: 'application/json' } });
    if (signal.aborted || !response?.ok || response.redirected || response.status >= 300 && response.status < 400
      || Number(response.headers?.get('content-length')) > MAX_BYTES) { cancelBody(response?.body); throw new Error('Load request failed'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing load response');
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks = []; let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error('Load request aborted');
        const { done, value } = await reader.read(); if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid load response');
        size += value.byteLength; if (size > MAX_BYTES) throw new Error('Oversized load response');
        chunks.push(Buffer.from(value));
      }
      if (signal.aborted) throw new Error('Load request aborted');
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (![0, 200].includes(raw?.code) || !object(raw.data) || typeof raw.data.enabled !== 'boolean'
        || raw.data.enabled && (!object(raw.data.account) || Object.keys(raw.data.account).length > MAX_ACCOUNTS)) throw new Error('Invalid load response');
      return raw.data;
    } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
  }
  async #refresh() {
    const controller = new AbortController(); this.#controller = controller;
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Load request aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), this.#timeout);
    });
    try {
      const data = await Promise.race([this.#read(controller.signal), interrupted]);
      if (this.#closed || controller.signal.aborted) return;
      const now = this.#now(), parsedAt = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
      const observedAt = Number.isFinite(parsedAt) && parsedAt > 0 && parsedAt <= now + 1000 ? new Date(parsedAt).toISOString() : null;
      const rows = new Map();
      if (data.enabled) for (const id of this.#visibleIds()) {
        const row = Object.hasOwn(data.account, id) ? data.account[id] : null;
        if (!object(row) || !(typeof row.account_id === 'string' && row.account_id === id
          || Number.isSafeInteger(row.account_id) && String(row.account_id) === id)) continue;
        const current = count(row.current_in_use), maximum = count(row.max_capacity), limit = maximum > 0 ? maximum : null;
        const percent = current !== null && limit !== null ? current / limit * 100 : null;
        rows.set(id, { id, current, limit, percent, observedAt });
      }
      this.#rows = rows; this.#enabled = data.enabled; this.#checkedAt = new Date(now).toISOString(); this.#error = '';
    } catch {
      if (!this.#closed) this.#error = '负载暂时读取失败，保留上次数据。';
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      controller.abort(); if (this.#controller === controller) this.#controller = null;
    }
  }
  async get() {
    if (this.#closed) return { ...this.snapshot(), enabled: false, accounts: [] };
    if (this.#pending) { await this.#pending; return this.snapshot(); }
    const now = this.#now();
    if (this.#lastAttempt !== null && now >= this.#lastAttempt && now - this.#lastAttempt < this.#interval) return this.snapshot();
    if (!this.#visibleIds().length) return this.snapshot();
    this.#lastAttempt = now;
    const task = this.#refresh(); this.#pending = task;
    try { await task; } finally { if (this.#pending === task) this.#pending = null; }
    return this.snapshot();
  }
  async close() { this.#closed = true; this.#controller?.abort(); await this.#pending; }
}
