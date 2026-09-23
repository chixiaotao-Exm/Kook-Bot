import { createHash } from 'node:crypto';

// Audited against Wei-Shaw/sub2api e8cb019fabf8b55199436229044cbf9aa7a82564:
// routes/gateway.go registers GET /v1/usage; GatewayHandler.Usage filters all
// usage queries by the authenticated key's ID. No administrator access or model
// request is needed. The native auth middleware can update key.last_used_at.
const USAGE_PATH = '/v1/usage';
const MAX_BYTES = 256 * 1024;
const TIME_ZONE = 'Asia/Shanghai';
const STAT_FIELDS = {
  requests: 'requests', tokens: 'total_tokens', inputTokens: 'input_tokens',
  outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens',
  cacheCreationTokens: 'cache_creation_tokens', cost: 'actual_cost', standardCost: 'cost',
};

export class KeyUsageError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'KeyUsageError'; this.code = code; this.status = status;
    if (status === 429) this.retryAfterSeconds = 2;
  }
}

export function validateUsageKey(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256 || !/^sk-[A-Za-z0-9_-]+$/.test(value)) {
    throw new KeyUsageError('INVALID_KEY', '请输入有效的 sk- 开头 API Key。', 400);
  }
  return value;
}

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const numeric = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
  && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : null;
const iso = value => {
  if (typeof value !== 'string' || value.length > 50) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const stats = (raw, daily = false) => Object.fromEntries(Object.entries(STAT_FIELDS).map(([key, upstream]) =>
  [key, numeric(object(raw)[daily && key === 'cacheCreationTokens' ? 'cache_write_tokens' : upstream])]));
const sumStats = rows => Object.fromEntries(Object.keys(STAT_FIELDS).map(key => {
  if (rows.some(row => row[key] === null)) return [key, null];
  const sum = rows.reduce((value, row) => value + row[key], 0);
  return [key, numeric(sum)];
}));

const shanghaiDay = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const nextShanghaiMidnight = now => (Math.floor((now + 8 * 3600000) / 86400000) + 1) * 86400000 - 8 * 3600000;

function periodStats(raw) {
  const daily = object(raw).daily_usage;
  // A successful empty array means no recorded usage. Missing/null means the
  // upstream's best-effort stats query failed, and must never become zero.
  if (Array.isArray(daily) && daily.length <= 90) {
    const dates = new Set();
    const rows = [];
    let valid = true;
    for (const point of daily) {
      const date = object(point).date;
      const midnight = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
      if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) { valid = false; break; }
      // The upstream filters by Shanghai midnight boundaries, but its SQL date
      // labels can use a different timezone. All returned buckets belong to the
      // requested range, including any bucket labelled the previous day.
      if (dates.has(date)) { valid = false; break; }
      dates.add(date);
      rows.push({ date, ...stats(point, true) });
    }
    if (valid) return sumStats(rows);
  }
  return stats(null);
}

function validateResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['quota_limited', 'unrestricted'].includes(raw.mode)) {
    throw new KeyUsageError('FORMAT', '用量服务返回的数据格式不正确。');
  }
  if (raw.isValid === false) throw new KeyUsageError('AUTH', 'API Key 无效、已停用或无查询权限。', 401);
  return raw;
}

function normalize(raw, apiKey, now, dailyRaw, sevenRaw) {
  let quota = { scope: 'unknown', used: null, limit: null, remaining: null, unlimited: null, currency: 'USD' };
  if (raw.mode === 'quota_limited') {
    const source = object(raw.quota);
    const limit = numeric(source.limit);
    quota = { ...quota, scope: 'key', used: numeric(source.used), limit,
      remaining: numeric(source.remaining), unlimited: limit !== null && limit > 0 ? false : null };
  } else if (numeric(raw.balance) !== null) {
    quota = { ...quota, scope: 'account', remaining: numeric(raw.balance), unlimited: false };
  } else if (raw.subscription && typeof raw.subscription === 'object' && !Array.isArray(raw.subscription)) {
    quota = { ...quota, scope: 'subscription', remaining: numeric(raw.remaining), unlimited: raw.remaining === -1 ? true : null };
  }
  const limits = [];
  for (const row of (Array.isArray(raw.rate_limits) ? raw.rate_limits.slice(0, 10) : [])) {
    if (!['5h', '1d', '7d'].includes(row?.window) || limits.some(limit => limit.window === row.window)) continue;
    limits.push({ window: row.window, used: numeric(row.used), limit: numeric(row.limit), remaining: numeric(row.remaining), resetAt: iso(row.reset_at) });
  }
  const periods = [
    { key: 'today', label: '今日', ...periodStats(dailyRaw) },
    { key: '7d', label: '近7天', ...periodStats(sevenRaw) },
  ];
  const notices = ['费用为本站记录的实际扣费；近7天含今天，按北京时间自然日统计。'];
  if (quota.scope === 'account') notices.push('余额由所属用户的多个 API Key 共享，并非当前 Key 独占。');
  if (quota.scope === 'subscription') notices.push('订阅剩余额度由所属用户共享。');
  if (periods.some(period => period.requests === null) || stats(object(raw.usage).total).requests === null) notices.push('部分用量暂不可读，未知项未按零计算。');
  return {
    keyHint: `sk-…${apiKey.slice(-4)}`,
    status: ['active', 'expired', 'quota_exhausted'].includes(raw.status) ? raw.status : 'unknown',
    mode: raw.mode, quota, totals: stats(object(raw.usage).total), periods, limits,
    expiresAt: iso(raw.expires_at), queriedAt: new Date(now).toISOString(), timeZone: TIME_ZONE,
    notice: notices.join(''),
  };
}

async function readBounded(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new KeyUsageError('FORMAT', '用量服务响应超过大小限制。');
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_BYTES) throw new KeyUsageError('FORMAT', '用量服务响应超过大小限制。');
    return body;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new KeyUsageError('FORMAT', '用量服务响应超过大小限制。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class KeyUsageClient {
  #url; #fetch; #now; #timeout; #ttl; #cacheSize; #maxConcurrent;
  #cache = new Map(); #pending = new Map();
  constructor({ baseUrl = 'http://127.0.0.1:8080', fetchImpl = globalThis.fetch, now = Date.now,
    timeoutMs = 12000, cacheMs = 30000, cacheSize = 64, maxConcurrent = 4 } = {}) {
    let base;
    try { base = new URL(baseUrl); } catch { throw new KeyUsageError('CONFIG', 'API Key 用量服务地址配置不正确。', 500); }
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.port !== '8080'
      || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new KeyUsageError('CONFIG', 'API Key 用量查询仅支持本机 Sub2API 服务。', 500);
    }
    this.#url = new URL(USAGE_PATH, base).href;
    this.#fetch = fetchImpl; this.#now = now;
    this.#timeout = Math.max(10, Math.min(30000, Number(timeoutMs) || 12000));
    this.#ttl = Math.max(0, Math.min(30000, Number(cacheMs) || 0));
    this.#cacheSize = Math.max(1, Math.min(256, Number(cacheSize) || 64));
    this.#maxConcurrent = Math.max(1, Math.min(4, Number(maxConcurrent) || 4));
  }
  async #request(apiKey) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new KeyUsageError('TIMEOUT', 'API Key 用量查询超时，请稍后重试。', 504)); }, this.#timeout);
    });
    try {
      const requestWindow = async days => {
        const url = `${this.#url}?days=${days}&timezone=Asia%2FShanghai`;
        const response = await this.#fetch(url, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` }, redirect: 'manual', signal: controller.signal });
        if (response.redirected || response.status >= 300 && response.status < 400) throw new KeyUsageError('REDIRECT', '用量服务发生重定向，查询已停止。');
        if (response.status === 401 || response.status === 403) throw new KeyUsageError('AUTH', 'API Key 无效、已停用或无查询权限。', 401);
        if (response.status === 429) throw new KeyUsageError('BUSY', '查询较频繁，请稍后重试。', 429);
        if (!response.ok) throw new KeyUsageError('UPSTREAM', '用量服务暂不可用，请稍后重试。');
        let parsed;
        try { parsed = JSON.parse(await readBounded(response)); }
        catch (error) { if (error instanceof KeyUsageError) throw error; throw new KeyUsageError('FORMAT', '用量服务返回的数据格式不正确。'); }
        return validateResponse(parsed);
      };
      const result = await Promise.race([timeout, (async () => {
        // A query may cross midnight while the upstream evaluates its relative
        // windows. Retry the whole pair once, within the original timeout.
        for (let attempt = 0; attempt < 2; attempt++) {
          const startedDay = shanghaiDay(this.#now());
          const windows = await Promise.allSettled([requestWindow(1), requestWindow(7)]);
          if (controller.signal.aborted) throw new KeyUsageError('TIMEOUT', 'API Key 用量查询超时，请稍后重试。', 504);
          const now = this.#now();
          if (shanghaiDay(now) !== startedDay) continue;
          const failure = windows.find(window => window.status === 'rejected' && window.reason?.code === 'AUTH');
          if (failure) throw failure.reason;
          const [dailyRaw, sevenRaw] = windows.map(window => window.status === 'fulfilled' ? window.value : null);
          if (!dailyRaw && !sevenRaw) throw windows[0].reason;
          // Retain available totals and quota if one period fails; the failed
          // period stays unknown and the partial result is not cached.
          return { value: normalize(sevenRaw || dailyRaw, apiKey, now, dailyRaw, sevenRaw),
            cacheable: Boolean(dailyRaw && sevenRaw) };
        }
        throw new KeyUsageError('DATE_CHANGED', '北京时间日期刚发生切换，请重新查询。', 503);
      })()]);
      return result;
    } catch (error) {
      if (error instanceof KeyUsageError) throw error;
      throw new KeyUsageError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', controller.signal.aborted ? 'API Key 用量查询超时，请稍后重试。' : '用量服务连接失败，请稍后重试。', controller.signal.aborted ? 504 : 502);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async query(apiKey) {
    validateUsageKey(apiKey);
    const hash = createHash('sha256').update(apiKey).digest('hex');
    const cached = this.#cache.get(hash);
    const now = this.#now();
    if (cached && cached.expiresAt > now && shanghaiDay(Date.parse(cached.value.queriedAt)) === shanghaiDay(now)) {
      this.#cache.delete(hash); this.#cache.set(hash, cached);
      return structuredClone(cached.value);
    }
    if (cached) this.#cache.delete(hash);
    if (this.#pending.has(hash)) return structuredClone(await this.#pending.get(hash));
    if (this.#pending.size >= this.#maxConcurrent) throw new KeyUsageError('BUSY', '查询繁忙，请稍后重试。', 429);
    const pending = this.#request(apiKey).then(({ value, cacheable }) => {
      const now = this.#now();
      if (shanghaiDay(now) !== shanghaiDay(Date.parse(value.queriedAt))) {
        throw new KeyUsageError('DATE_CHANGED', '北京时间日期刚发生切换，请重新查询。', 503);
      }
      if (cacheable) {
        this.#cache.set(hash, { value, expiresAt: Math.min(now + this.#ttl, nextShanghaiMidnight(now)) });
        while (this.#cache.size > this.#cacheSize) this.#cache.delete(this.#cache.keys().next().value);
      }
      return value;
    }).finally(() => { this.#pending.delete(hash); });
    this.#pending.set(hash, pending);
    return structuredClone(await pending);
  }
}
