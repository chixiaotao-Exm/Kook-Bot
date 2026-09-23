// Audited against Sub2API e8cb019f: quota/refresh also notifies its automatic
// reset service. Never call it until the account's automatic-use flag is off.
// This adapter does not call a reset endpoint or change account configuration.
const ORIGIN = 'http://127.0.0.1:8080';
const MAX_BYTES = 1024 * 1024;
const PLANS = new Set(['free', 'basic', 'plus', 'chatgptplus', 'pro', 'chatgptpro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'selfservebusiness', 'selfservebusinessprolite', 'selfservebusinessusagebased']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const date = value => {
  const time = typeof value === 'number' && value > 0 ? value < 1e12 ? value * 1000 : value : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8640000000000000 ? new Date(time).toISOString() : null;
};
const accountId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
};
const plan = value => {
  if (typeof value !== 'string' || value.length > 80) return null;
  const normalized = value.toLowerCase().replace(/[\s_-]/g, '');
  return PLANS.has(normalized) ? normalized : null;
};

export class ActiveQuotaError extends Error {
  constructor(code, message) { super(message); this.name = 'ActiveQuotaError'; this.code = code; }
}

function eligible(raw, id) {
  const row = object(raw), extra = row?.extra;
  if (!row || accountId(row.id) !== id || row.platform !== 'openai' || row.type !== 'oauth' || row.status !== 'active'
    || row.parent_account_id !== undefined && row.parent_account_id !== null
    || row.quota_dimension !== undefined && row.quota_dimension !== null && !['', 'global'].includes(row.quota_dimension)
    || row.is_shadow === true || row.deleted_at
    || extra !== undefined && extra !== null && !object(extra)) {
    throw new ActiveQuotaError('INELIGIBLE', '账号身份、类型或状态不符合主动查询条件，已跳过。');
  }
  if (extra && Object.hasOwn(extra, 'auto_reset_credit_enabled') && extra.auto_reset_credit_enabled !== false) {
    throw new ActiveQuotaError('AUTO_RESET', '账号自动用卡未明确关闭，已跳过主动查询。');
  }
}

function cleanWindow(value) {
  const row = object(value);
  if (!row) return null;
  const usedPercent = number(row.usedPercent), windowMinutes = number(row.windowMinutes);
  if (usedPercent === null || usedPercent > Number.MAX_SAFE_INTEGER || windowMinutes === null || windowMinutes <= 0 || windowMinutes > 525600) return null;
  return { usedPercent, windowMinutes, resetAt: date(row.resetAt), resetAfterSeconds: number(row.resetAfterSeconds) };
}

function cleanCredits(value) {
  const row = object(value), availableCount = number(row?.availableCount);
  if (!row || availableCount === null || !Number.isSafeInteger(availableCount)) return null;
  return { availableCount, expiresAt: (Array.isArray(row.expiresAt) ? row.expiresAt : []).slice(0, 1000).map(date).filter(Boolean).sort() };
}

/** Rebuild persisted records from an explicit whitelist, never rehydrate raw API data. */
export function sanitizeActiveQuotaRecord(value) {
  const row = object(value), id = accountId(row?.accountId), queriedAt = date(row?.queriedAt), observedAt = date(row?.observedAt), usage = object(row?.usage);
  if (!row || !id || !queriedAt || !observedAt || !usage || Date.parse(observedAt) > Date.parse(queriedAt) + 60000) return null;
  return { accountId: id, queriedAt, observedAt, cachePersisted: row.cachePersisted === true,
    usage: { primary: cleanWindow(usage.primary), secondary: cleanWindow(usage.secondary), resetCredits: cleanCredits(usage.resetCredits) }, planType: plan(row.planType) };
}

function normalizeUsage(data, id, now) {
  const queriedAt = date(now), observedAt = date(data.fetched_at);
  if (!queriedAt || !observedAt || Date.parse(observedAt) > now + 60000) throw new ActiveQuotaError('FORMAT', '主动查询缺少可靠的额度采样时间。');
  const window = value => {
    const row = object(value);
    if (!row) return null;
    const resetAfterSeconds = number(row.reset_after_seconds);
    const resetAt = date(row.reset_at) || (resetAfterSeconds !== null ? date(Date.parse(observedAt) + resetAfterSeconds * 1000) : null);
    return cleanWindow({ usedPercent: row.used_percent, windowMinutes: number(row.limit_window_seconds) === null ? null : row.limit_window_seconds / 60, resetAt, resetAfterSeconds });
  };
  const rate = object(data.rate_limit), credits = object(data.rate_limit_reset_credits);
  return sanitizeActiveQuotaRecord({ accountId: id, queriedAt, observedAt, cachePersisted: data.cache_persisted === true,
    usage: { primary: window(rate?.primary_window), secondary: window(rate?.secondary_window),
      resetCredits: credits ? { availableCount: credits.available_count, expiresAt: Array.isArray(credits.credits) ? credits.credits.slice(0, 1000).map(row => row?.expires_at) : [] } : null }, planType: data.plan_type });
}

/** Overlay only data newer than the original account cache; never mutate it. */
export function applyActiveQuota(rawAccount, inputRecord) {
  const row = object(rawAccount), record = sanitizeActiveQuotaRecord(inputRecord);
  if (!row || !record || accountId(row.id) !== record.accountId || row.platform !== 'openai' || row.type !== 'oauth'
    || row.parent_account_id !== undefined && row.parent_account_id !== null) return rawAccount;
  const extra = { ...(object(row.extra) || {}) };
  const previousUsageAt = date(extra.codex_usage_updated_at);
  if (!previousUsageAt || Date.parse(record.observedAt) >= Date.parse(previousUsageAt)) {
    for (const key of ['primary', 'secondary']) {
      const prefix = `codex_${key}_`, value = record.usage[key];
      // Explicitly clear absent windows so an old 100% sample cannot survive a
      // newer response that no longer supplies that quota window.
      for (const suffix of ['used_percent', 'window_minutes', 'reset_at', 'reset_after_seconds']) delete extra[prefix + suffix];
      if (value) Object.assign(extra, { [prefix + 'used_percent']: value.usedPercent, [prefix + 'window_minutes']: value.windowMinutes,
        [prefix + 'reset_at']: value.resetAt, [prefix + 'reset_after_seconds']: value.resetAfterSeconds });
    }
    extra.codex_usage_updated_at = record.observedAt;
    extra.codex_active_quota_observed_at = record.observedAt;
    delete extra.codex_active_quota_stale;
    if (record.planType) extra.codex_plan_type = record.planType;
  } else {
    delete extra.codex_active_quota_observed_at;
    delete extra.codex_active_quota_stale;
  }
  const state = object(extra.codex_auto_reset_credit_state);
  const creditTimes = [date(extra.codex_reset_credit_checked_at), date(state?.checked_at)].filter(Boolean).map(Date.parse);
  const previousCreditAt = creditTimes.length ? Math.max(...creditTimes) : 0;
  if (record.usage.resetCredits && Date.parse(record.queriedAt) >= previousCreditAt) {
    extra.codex_reset_credit_snapshot = { available_count: record.usage.resetCredits.availableCount,
      credits: record.usage.resetCredits.expiresAt.map(expires_at => ({ expires_at })) };
    extra.codex_reset_credit_checked_at = record.queriedAt;
  }
  return { ...row, extra };
}

async function boundedBody(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new ActiveQuotaError('FORMAT', '主动查询响应超过大小限制。');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new ActiveQuotaError('FORMAT', '主动查询响应超过大小限制。');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new ActiveQuotaError('FORMAT', '主动查询响应超过大小限制。'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export class ActiveQuotaClient {
  #key; #fetch; #timeout; #now;
  constructor({ baseUrl = ORIGIN, adminApiKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    let base;
    try { base = new URL(baseUrl); } catch { throw new ActiveQuotaError('CONFIG', '主动查询地址配置不正确。'); }
    if (base.origin !== ORIGIN || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new ActiveQuotaError('CONFIG', '主动查询仅允许本机 sub2api 服务。');
    if (typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)) throw new ActiveQuotaError('CONFIG', '尚未配置有效的管理员 API Key。');
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new ActiveQuotaError('CONFIG', '主动查询运行参数不正确。');
    this.#key = adminApiKey.trim(); this.#fetch = fetchImpl; this.#now = now; this.#timeout = timeoutMs;
  }
  async #request(path, method, signal) {
    signal.throwIfAborted();
    const response = await this.#fetch(ORIGIN + path, { method, headers: { 'x-api-key': this.#key, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) throw new ActiveQuotaError('REDIRECT', '主动查询返回重定向，已停止请求。');
    if (response.status === 401 || response.status === 403) throw new ActiveQuotaError('AUTH', '主动查询管理员密钥无效或权限不足。');
    if (!response.ok) throw new ActiveQuotaError('UPSTREAM', 'sub2api 主动查询失败，保留上次数据。');
    const body = await boundedBody(response);
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new ActiveQuotaError('FORMAT', '主动查询响应无法解析。'); }
    if (![0, 200].includes(parsed?.code) || !object(parsed.data)) throw new ActiveQuotaError('UPSTREAM', 'sub2api 未返回有效的主动查询结果。');
    return parsed.data;
  }
  async refreshAccount(value, { signal } = {}) {
    const id = accountId(value);
    if (!id) throw new ActiveQuotaError('ACCOUNT_ID', '主动查询账号 ID 不正确。');
    const controller = new AbortController();
    const abort = () => controller.abort(new ActiveQuotaError('ABORTED', '主动查询已取消。'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ActiveQuotaError('TIMEOUT', '主动查询超时，保留上次数据。')), this.#timeout);
    let rejectAbort;
    const stopped = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const work = async () => {
      controller.signal.throwIfAborted();
      eligible(await this.#request(`/api/v1/admin/accounts/${id}`, 'GET', controller.signal), id);
      const data = await this.#request(`/api/v1/admin/openai/accounts/${id}/quota/refresh`, 'POST', controller.signal);
      // Detect an operator changing eligibility while the query was in flight.
      // This is a consistency check, not an atomic lock of Sub2API settings.
      eligible(await this.#request(`/api/v1/admin/accounts/${id}`, 'GET', controller.signal), id);
      return normalizeUsage(data, id, this.#now());
    };
    try { return await Promise.race([work(), stopped]); }
    catch (error) {
      if (error instanceof ActiveQuotaError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new ActiveQuotaError('NETWORK', '无法连接 sub2api 主动查询接口，保留上次数据。');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
    }
  }
}
