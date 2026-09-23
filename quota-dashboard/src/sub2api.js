// Source contract audited against Wei-Shaw/sub2api e8cb019f (0.1.183).
// Account-list snapshots are deliberately used instead of quota/probe endpoints:
// even GET openai/quota can trigger automatic credit resets in that version.
import { accountPlan } from './account-plan.js';
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const PLATFORM_NAMES = { openai: 'OpenAI', anthropic: 'Claude', grok: 'Grok', deepseek: 'DeepSeek', kimi: 'Kimi', moonshot: 'Moonshot', zhipu: '智谱', gemini: 'Gemini', antigravity: 'Antigravity' };

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => { const n = number(value); return n !== null && n > 0 ? n : null; };
const nonnegative = value => { const n = number(value); return n !== null && n >= 0 ? n : null; };
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b(?:admin-|sk-)[a-zA-Z0-9_-]{8,}/g, '[已隐藏]').replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/https?:\/\/\S+/gi, '[地址已隐藏]').slice(0, max).trim() : '';
const iso = value => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? number(value) : null;
  const timestamp = numeric !== null ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8640000000000000 ? new Date(timestamp).toISOString() : null;
};

function freshness(observedAt, resetAt, now, staleAfterMs, { freshUntil, requireReset = false } = {}) {
  if (resetAt && Date.parse(resetAt) <= now) return 'stale';
  if (freshUntil && Date.parse(freshUntil) <= now) return 'stale';
  if (!observedAt) return 'unknown';
  const age = now - Date.parse(observedAt);
  if (age < -60000) return 'unknown';
  if (age > staleAfterMs || requireReset && !resetAt) return 'stale';
  return 'fresh';
}

function resetCredits(extra, now, staleAfterMs) {
  const snapshot = object(extra.codex_reset_credit_snapshot), state = object(extra.codex_auto_reset_credit_state);
  if (!Object.keys(snapshot).length && !Object.keys(state).length) return null;
  const cachedCount = nonnegative(snapshot.available_count);
  const expiresAt = (Array.isArray(snapshot.credits) ? snapshot.credits : []).map(row => iso(row?.expires_at)).filter(Boolean).sort();
  const usable = expiresAt.filter(time => Date.parse(time) > now);
  // A count without a timestamp/usable credit cannot be promoted to live availability.
  let availableCount = cachedCount === 0 ? 0 : cachedCount !== null && usable.length ? Math.min(cachedCount, usable.length) : null;
  const activeCheckedAt = iso(extra.codex_reset_credit_checked_at);
  const checkedAt = activeCheckedAt || iso(state.checked_at);
  const status = activeCheckedAt ? availableCount === 0 ? 'no_credit' : availableCount > 0 ? 'available' : 'unknown'
    : ['checking', 'available', 'resetting', 'success', 'no_credit', 'failed'].includes(state.status) ? state.status : 'unknown';
  if (!activeCheckedAt && status === 'no_credit' && checkedAt) availableCount = 0;
  return { cachedCount, availableCount, status, checkedAt, expiresAt,
    source: activeCheckedAt ? 'sub2api-active-quota' : 'sub2api-cache',
    freshness: extra.codex_active_quota_stale === true || cachedCount > 0 && availableCount === null ? 'stale' : freshness(checkedAt, null, now, activeCheckedAt ? 35 * 60000 : staleAfterMs),
    note: activeCheckedAt ? '已主动查询重置卡数量；“无卡”不表示账号额度用尽。本看板未调用重置接口。' : '次数是缓存的额度重置卡数量；“无卡”只表示无重置卡，不表示账号没有可用额度。未主动查询或消耗重置卡。' };
}

function localWindows(account, now) {
  return [[300, '5h', '5 小时'], [10080, '7d', '7 天']].map(([minutes, key, label]) => {
    const metric = account.metrics.find(row => row.windowMinutes === minutes && row.resetAt && Date.parse(row.resetAt) > now && Date.parse(row.resetAt) - minutes * 60000 <= now);
    const periodStart = metric ? iso(Date.parse(metric.resetAt) - minutes * 60000) : new Date(now - minutes * 60000).toISOString();
    return { key, label: metric ? `${label}额度窗口的本站用量` : `最近${label}本站用量`, source: 'sub2api-local-usage', scope: 'local',
      periodStart, periodEnd: new Date(now).toISOString(), periodKind: metric ? 'quota' : 'rolling', metricKey: metric?.key || null,
      requests: null, tokens: null, accountCost: null, userCost: null, standardCost: null, currency: 'USD',
      estimatedTotalCost: null, estimateObservedAt: null, observedAt: null, complete: false, error: null,
      note: metric ? '按平台额度窗口起点汇总本站记录；A 为账号计费，U 为用户计费，都不是余额。'
        : '缺少有效的平台额度窗口，单独显示滚动时间范围的本站记录，不把它当作平台额度。' };
  });
}

function normalAccount(raw, index, now, staleAfterMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !/^[1-9]\d*$/.test(String(raw.id))) throw new Error('Invalid account');
  const extra = object(raw.extra);
  const platform = text(raw.platform, 40).toLowerCase() || 'unknown';
  const type = text(raw.type, 40) || 'unknown';
  const account = {
    id: String(raw.id), name: text(raw.name) || `账号 ${raw.id}`, platform,
    platformLabel: PLATFORM_NAMES[platform] || platform, type,
    status: ['active', 'inactive', 'error', 'disabled'].includes(raw.status) ? raw.status : 'unknown',
    schedulable: typeof raw.schedulable === 'boolean' ? raw.schedulable : null,
    plan: '', ...accountPlan(raw), source: 'sub2api-cache', freshness: 'unknown', observedAt: null,
    metrics: [], windowStats: [], resetCredits: null, notes: [], error: null,
  };
  const metric = (key, label, kind, fields, observedAt, resetAt, options = {}) => {
    const observed = iso(observedAt), reset = iso(resetAt);
    const item = { key, label, kind, scope: 'upstream', ...fields, observedAt: observed, resetAt: reset,
      freshness: freshness(observed, reset, now, staleAfterMs, options) };
    if (options.note) item.note = options.note;
    account.metrics.push(item);
    return item;
  };
  const percent = (key, label, used, observedAt, resetAt, options = {}) => {
    const usedPercent = nonnegative(used);
    if (usedPercent === null) return;
    const fields = { unit: '%', usedPercent };
    if (!options.component) fields.remainingPercent = Math.max(0, 100 - usedPercent);
    const item = metric(key, label, 'percent', fields, observedAt, resetAt, options);
    if (options.windowMinutes) item.windowMinutes = options.windowMinutes;
    return item;
  };
  const money = (key, label, balance, currency, observedAt, resetAt, options = {}) => {
    const value = number(balance);
    if (value === null || !/^[A-Z]{3}$/.test(currency || '')) return;
    metric(key, label, 'balance', { unit: currency, value, ...options.fields }, observedAt, resetAt, options);
  };
  const counts = (key, label, unit, data, observedAt, resetAt, options = {}) => {
    const limit = positive(data.limit), remaining = nonnegative(data.remaining), used = nonnegative(data.used);
    if (remaining === null && used === null && limit === null) return;
    const fields = { unit };
    if (limit !== null) fields.limit = limit;
    if (remaining !== null) fields.remaining = remaining;
    if (used !== null) fields.used = used;
    else if (limit !== null && remaining !== null && remaining <= limit) fields.used = limit - remaining;
    if (limit !== null && fields.used !== undefined) {
      fields.usedPercent = fields.used / limit * 100;
      fields.remainingPercent = Math.max(0, 100 - fields.usedPercent);
    }
    metric(key, label, 'count', fields, observedAt, resetAt, options);
  };

  if (platform === 'openai' && /oauth|setup/i.test(type)) {
    account.plan = text(extra.codex_plan_type || extra.plan_type || extra.subscription_plan || object(raw.credentials).plan_type, 80);
    const observedAt = iso(extra.codex_usage_updated_at);
    const activeSample = observedAt && observedAt === iso(extra.codex_active_quota_observed_at);
    for (const window of ['primary', 'secondary']) {
      const prefix = `codex_${window}_`;
      const minutes = positive(extra[`${prefix}window_minutes`]);
      if (minutes === null) continue; // zero-length placeholder is not an unused quota.
      const resetSeconds = nonnegative(extra[`${prefix}reset_after_seconds`]);
      const resetAt = iso(extra[`${prefix}reset_at`]) || (observedAt && resetSeconds !== null ? new Date(Date.parse(observedAt) + resetSeconds * 1000).toISOString() : null);
      const duration = minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
      const item = percent(`codex-${window}`, `${duration}额度窗口`, extra[`${prefix}used_percent`], observedAt, resetAt,
        { windowMinutes: minutes, note: '平台额度使用比例，不能换算为精确剩余 Token。' });
      if (item && activeSample) {
        item.source = 'sub2api-active-quota';
        item.freshness = extra.codex_active_quota_stale === true ? 'stale' : freshness(observedAt, resetAt, now, 35 * 60000);
      }
    }
    const query = object(extra.dashboard_active_quota);
    if (['success', 'failed', 'skipped', 'pending'].includes(query.status)) {
      account.quotaQuery = { status: query.status, queriedAt: iso(query.queriedAt), message: query.status === 'failed' ? '主动查询失败，保留上次数据' : query.status === 'skipped' ? '主动查询已跳过，请检查自动用卡开关和账号状态' : '' };
    }
  }

  if (platform === 'anthropic' && /oauth|setup/i.test(type)) {
    const observedAt = extra.passive_usage_sampled_at;
    for (const [key, label, usedKey, resetAt] of [
      ['claude-5h', '5 小时额度窗口', 'session_window_utilization', raw.session_window_end || extra.session_window_end],
      ['claude-7d', '7 天额度窗口', 'passive_usage_7d_utilization', extra.passive_usage_7d_reset],
      ['claude-7d-fable', '7 天 Fable 额度窗口', 'passive_usage_7d_oi_utilization', extra.passive_usage_7d_oi_reset],
    ]) {
      const ratio = nonnegative(extra[usedKey]);
      if (ratio !== null) percent(key, label, ratio * 100, observedAt, resetAt, { windowMinutes: key === 'claude-5h' ? 300 : 10080, note: '从原服务的实际请求响应缓存读取；无样本时不估算额度。' });
    }
  }

  if (platform === 'grok') {
    const billing = object(extra.grok_billing_snapshot);
    const usage = object(extra.grok_usage_snapshot);
    account.plan = text(billing.plan || usage.subscription_tier, 80);
    const billingAt = billing.updated_at || billing.fetched_at;
    const weeklyAt = billing.weekly_updated_at || billingAt;
    const monthlyAt = billing.monthly_updated_at || billingAt;
    const periodLabel = billing.period_type === 'weekly' ? '每周' : billing.period_type === 'monthly' ? '每月' : '账单周期';
    percent('grok-billing', `${periodLabel}额度`, billing.usage_percent, weeklyAt, billing.period_end, { requireReset: true, windowMinutes: billing.period_type === 'weekly' ? 10080 : null });
    for (const [i, product] of (Array.isArray(billing.product_usage) ? billing.product_usage.slice(0, 30) : []).entries()) {
      const name = text(product?.product, 80);
      if (name) percent(`grok-product-${i}`, `${name} 用量占比`, product.usage_percent, weeklyAt, billing.period_end,
        { requireReset: true, component: true, note: '占整个账单额度的比例，不代表该产品拥有独立额度。' });
    }
    const monthlyLimit = number(billing.monthly_limit) ?? (number(billing.monthly_limit_cents) !== null ? number(billing.monthly_limit_cents) / 100 : null);
    const monthlyUsed = number(billing.monthly_used) ?? (number(billing.used_cents) !== null ? number(billing.used_cents) / 100 : null);
    if (monthlyLimit !== null && monthlyUsed !== null && monthlyLimit > 0) {
      const item = metric('grok-monthly', '月度账单额度', 'count', { unit: 'USD', limit: monthlyLimit, used: monthlyUsed,
        remaining: Math.max(0, monthlyLimit - monthlyUsed), usedPercent: monthlyUsed / monthlyLimit * 100,
        remainingPercent: Math.max(0, (monthlyLimit - monthlyUsed) / monthlyLimit * 100) }, monthlyAt, billing.billing_period_end, { requireReset: true });
      item.note = '按上游账单数据计算；与每周额度可能重叠，不相加。';
    }
    money('grok-prepaid', '预付余额', billing.prepaid_balance, 'USD', billingAt);
    for (const [key, label, unit] of [['requests', '请求窗口剩余', 'requests'], ['tokens', 'Token 窗口剩余', 'tokens']]) {
      const value = object(usage[key]);
      counts(`grok-${key}`, label, unit, value, usage.last_headers_seen_at || usage.updated_at,
        value.reset_at || value.reset_unix, { requireReset: true, note: '这是上次响应头记录的限流窗口，不是永久套餐总额度。缺少重置时间时标为旧缓存。' });
    }
    if (billing.partial || Array.isArray(billing.failed_windows) && billing.failed_windows.length) account.notes.push('Grok 账单快照不完整，部分窗口读取失败。');
  }

  if (['deepseek', 'kimi', 'moonshot'].includes(platform)) {
    const prefix = platform === 'moonshot' ? 'kimi' : platform;
    const observedAt = extra[`${prefix}_balance_updated_at`];
    const balances = Array.isArray(extra[`${prefix}_balances`]) ? extra[`${prefix}_balances`] : [];
    const seen = new Set();
    for (const entry of balances.slice(0, 20)) {
      const currency = typeof entry?.currency === 'string' ? entry.currency.toUpperCase() : '';
      if (seen.has(currency) || number(entry?.balance) === null || !/^[A-Z]{3}$/.test(currency)) continue;
      seen.add(currency);
      money(`${prefix}-${currency}`, `${currency}余额`, entry.balance, currency, observedAt);
    }
    const currency = typeof extra[`${prefix}_balance_currency`] === 'string' ? extra[`${prefix}_balance_currency`].toUpperCase() : '';
    if (!seen.has(currency)) money(`${prefix}-${currency}`, `${currency}余额`, extra[`${prefix}_balance`], currency, observedAt);
    if (extra[`${prefix}_balance_available`] === false) account.notes.push('上游余额快照标记账号当前不可用。');
  }

  // These are operator-configured sub2api spending caps, NOT upstream balances.
  if (/apikey|api_key|bedrock/i.test(type)) {
    for (const [prefix, label] of [['quota', '本站设置的总消费限额'], ['quota_daily', '本站设置的日消费限额'], ['quota_weekly', '本站设置的周消费限额']]) {
      const limit = positive(extra[`${prefix}_limit`]);
      const used = nonnegative(extra[`${prefix}_used`]);
      if (limit === null) continue;
      const fields = { unit: 'USD', limit, scope: 'local' };
      if (used !== null) Object.assign(fields, { used, remaining: Math.max(0, limit - used), usedPercent: used / limit * 100, remainingPercent: Math.max(0, 100 - used / limit * 100) });
      metric(prefix.replaceAll('_', '-'), label, 'count', fields, null, extra[`${prefix}_reset_at`],
        { note: '本站自行设置的消费限制，不代表上游账户余额；缺少可靠采样时间。' });
    }
  }

  const probe = object(extra.upstream_billing_probe);
  if (Object.keys(probe).length) {
    account.notes.push(probe.status === 'unsupported' ? '上游未支持 sub2api 倍率查询；该查询本身不提供账户余额。'
      : probe.status === 'failed' ? '原服务的上游倍率查询失败；该查询本身不提供账户余额。'
        : '上游账单缓存仅提供计费倍率，不能据此计算账户余额。');
  }
  const upstreamMetrics = account.metrics.filter(item => item.scope === 'upstream');
  if (!upstreamMetrics.length) account.notes.push('暂无可用的上游额度缓存；未将缺失数据显示为 0 或无限额度。');
  if (account.status === 'error') account.error = '原服务将此账号标记为异常，请在 sub2api 查看详细错误。';
  const observed = upstreamMetrics.map(item => item.observedAt).filter(Boolean).sort();
  account.observedAt = observed.at(-1) || null;
  account.freshness = upstreamMetrics.some(item => item.freshness === 'stale') ? 'stale'
    : upstreamMetrics.length && upstreamMetrics.every(item => item.freshness === 'fresh') ? 'fresh' : 'unknown';
  if (account.freshness === 'stale') account.notes.push('包含旧缓存或已结束的额度窗口，数值不代表当前剩余额度。');
  account.windowStats = localWindows(account, now);
  if (platform === 'openai' && /oauth|setup/i.test(type)) account.resetCredits = resetCredits(extra, now, staleAfterMs);
  return account;
}

export function normalizeAccounts(rawAccounts, options = {}) {
  const { now = Date.now(), staleAfterMs = DEFAULT_STALE_MS } = typeof options === 'number' ? { now: options } : options;
  if (!Array.isArray(rawAccounts)) throw new Error('账号列表格式不正确。');
  return rawAccounts.map((raw, index) => {
    try { return normalAccount(raw, index, Number(now), staleAfterMs); }
    catch {
      return { id: `invalid-${index}`, name: '无法解析的账号', platform: 'unknown', platformLabel: '未知平台', type: 'unknown',
        status: 'unknown', schedulable: null, plan: '', ...accountPlan(null), source: 'sub2api-cache', freshness: 'unknown', observedAt: null,
        metrics: [], windowStats: [], resetCredits: null, notes: ['此账号数据异常，其他账号仍正常显示。'], error: '账号缓存格式不正确。' };
    }
  });
}

export class Sub2apiError extends Error {
  constructor(code, message, status = null) { super(message); this.name = 'Sub2apiError'; this.code = code; this.status = status; }
}

export class Sub2apiClient {
  #base; #key; #fetch; #timeout; #now; #stale; #pending = null; #includeStats; #statsTtl; #statsCache = new Map(); #overlay;
  constructor({ baseUrl, adminApiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now, staleAfterMs = DEFAULT_STALE_MS, includeWindowStats = true, statsCacheMs = 300000, accountOverlay } = {}) {
    let base;
    try { base = new URL(baseUrl); } catch { throw new Sub2apiError('CONFIG', 'sub2api 地址配置不正确。'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Sub2apiError('CONFIG', 'sub2api 地址必须是独立的 HTTP 或 HTTPS 服务地址。');
    if (typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)) throw new Sub2apiError('CONFIG', '尚未配置有效的管理员 API Key。');
    this.#base = base.origin; this.#key = adminApiKey.trim(); this.#fetch = fetchImpl;
    this.#timeout = timeoutMs; this.#now = now; this.#stale = staleAfterMs;
    this.#includeStats = includeWindowStats; this.#statsTtl = statsCacheMs;
    this.#overlay = accountOverlay;
  }
  async #page(page, usage = null) {
    // The only two allowed paths both read this deployment's database/cache.
    // No account /usage endpoint, quota endpoint or upstream probe is used.
    const url = new URL(usage ? '/api/v1/admin/usage' : '/api/v1/admin/accounts', this.#base);
    url.search = new URLSearchParams({ page: String(page), page_size: usage ? '1000' : '100', ...(usage || {}) }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    timer.unref?.();
    try {
      const response = await this.#fetch(url.href, { method: 'GET', headers: { 'x-api-key': this.#key, accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Sub2apiError('REDIRECT', 'sub2api 返回了重定向；为保护管理员密钥，已停止请求。', response.status);
      if (response.status === 401 || response.status === 403) throw new Sub2apiError('AUTH', '管理员 API Key 无效或权限不足。', response.status);
      if (!response.ok) throw new Sub2apiError('UPSTREAM', `sub2api 读取失败（HTTP ${Number(response.status) || 0}）。`, response.status);
      if (Number(response.headers?.get('content-length')) > 4 * 1024 * 1024) throw new Sub2apiError('FORMAT', 'sub2api 账号响应过大。');
      const body = await response.text();
      if (body.length > 4 * 1024 * 1024) throw new Sub2apiError('FORMAT', 'sub2api 账号响应过大。');
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new Sub2apiError('FORMAT', 'sub2api 返回的账号数据无法解析。'); }
      if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 200) throw new Sub2apiError('UPSTREAM', 'sub2api 未返回成功的账号列表。');
      const data = parsed.data ?? parsed;
      const items = Array.isArray(data) ? data : data?.items;
      if (!Array.isArray(items)) throw new Sub2apiError('FORMAT', 'sub2api 账号列表格式不正确。');
      return { items, total: nonnegative(data?.total), pages: positive(data?.pages ?? data?.total_pages), pageSize: positive(data?.page_size) || (usage ? 1000 : 100) };
    } catch (error) {
      if (error instanceof Sub2apiError) throw error;
      if (controller.signal.aborted) throw new Sub2apiError('TIMEOUT', '读取 sub2api 超时，保留上次数据。');
      throw new Sub2apiError('NETWORK', '无法连接 sub2api，保留上次数据。');
    } finally { clearTimeout(timer); }
  }
  async fetchAccounts() {
    const accounts = [], ids = new Set();
    for (let page = 1; page <= 100; page++) {
      const result = await this.#page(page);
      for (const item of result.items) {
        if (item?.id !== undefined) {
          const id = String(item.id);
          if (ids.has(id)) throw new Sub2apiError('PAGINATION', '账号分页数据发生变化，请稍后刷新。');
          ids.add(id);
        }
        accounts.push(item);
      }
      if ((result.items.length === 0 || result.pages !== null && page >= result.pages) && result.total !== null && accounts.length < result.total) throw new Sub2apiError('PAGINATION', '账号分页返回不完整，请稍后刷新。');
      if (result.total !== null && accounts.length >= result.total || result.pages !== null && page >= result.pages || result.items.length === 0 || result.total === null && result.pages === null && result.items.length < 100) return accounts;
    }
    throw new Sub2apiError('PAGINATION', '账号数量超过单次读取上限。');
  }
  async #readLocalWindows(account, now) {
    const windows = account.windowStats.map(window => ({ ...window, requests: 0, tokens: 0, accountCost: 0, userCost: 0, standardCost: 0 }));
    const start = Math.min(...windows.map(window => Date.parse(window.periodStart)));
    const params = { account_id: account.id, start_date: new Date(start).toISOString().slice(0, 10),
      end_date: new Date(now).toISOString().slice(0, 10), timezone: 'UTC', sort_by: 'created_at', sort_order: 'asc', exact_total: 'true' };
    const ids = new Set();
    let count = 0, complete = false;
    for (let page = 1; page <= 20; page++) {
      const result = await this.#page(page, params);
      for (const row of result.items) {
        if (row?.id === undefined || ids.has(String(row.id)) || row.account_id !== undefined && String(row.account_id) !== account.id) throw new Sub2apiError('PAGINATION', '本站用量分页发生变化，请稍后刷新。');
        ids.add(String(row.id)); count++;
        const createdAt = iso(row.created_at);
        if (!createdAt) throw new Sub2apiError('FORMAT', '本站用量记录缺少可靠时间。');
        const timestamp = Date.parse(createdAt);
        if (timestamp >= now) continue;
        const tokenParts = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'].map(key => nonnegative(row[key]));
        const tokens = tokenParts.every(value => value !== null) ? tokenParts.reduce((sum, value) => sum + value, 0) : null;
        const standardCost = nonnegative(row.total_cost), userCost = nonnegative(row.actual_cost);
        const costBase = nonnegative(row.account_stats_cost) ?? standardCost;
        const multiplier = row.account_rate_multiplier === null || row.account_rate_multiplier === undefined ? 1 : nonnegative(row.account_rate_multiplier);
        const accountCost = costBase !== null && multiplier !== null ? costBase * multiplier : null;
        for (const window of windows) {
          if (timestamp < Date.parse(window.periodStart)) continue;
          window.requests++;
          for (const [key, value] of Object.entries({ tokens, accountCost, userCost, standardCost })) {
            window[key] = value !== null && window[key] !== null ? window[key] + value : null;
          }
        }
      }
      if ((result.items.length === 0 || result.pages !== null && page >= result.pages) && result.total !== null && count < result.total) throw new Sub2apiError('PAGINATION', '本站用量分页不完整。');
      if (result.total !== null && count >= result.total || result.pages !== null && page >= result.pages || !result.items.length || result.total === null && result.pages === null && result.items.length < result.pageSize) { complete = true; break; }
    }
    for (const window of windows) {
      // Never publish a truncated scan as an apparently complete usage/cost total.
      if (!complete) Object.assign(window, { requests: null, tokens: null, accountCost: null, userCost: null, standardCost: null, error: '本窗口记录超过单次统计上限，未显示不完整合计。' });
      window.complete = complete;
      window.observedAt = new Date(this.#now()).toISOString();
    }
    return windows;
  }
  #estimate(windows, account) {
    for (const window of windows) {
      const metric = account.metrics.find(row => row.key === window.metricKey);
      window.estimatedTotalCost = null; window.estimateObservedAt = null;
      if (window.complete && window.periodKind === 'quota' && window.accountCost > 0 && metric?.freshness === 'fresh' && metric.usedPercent > 0
        && metric.observedAt && Date.parse(metric.observedAt) <= Date.parse(window.periodEnd)) {
        const estimate = window.accountCost / (metric.usedPercent / 100);
        if (Number.isFinite(estimate)) {
          window.estimatedTotalCost = estimate;
          window.estimateObservedAt = metric.observedAt;
          window.estimateNote = '以同一真实额度窗口的本站 A 费用 ÷ 平台已用比例推算满额费用；两种数据采样时间可能不同，仅供参考，不是官方余额。';
        }
      }
    }
  }
  async #enrichLocalStats(accounts, now) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < accounts.length) {
        const account = accounts[cursor++];
        if (!/^[1-9]\d*$/.test(account.id) || !account.windowStats.length) continue;
        const key = account.windowStats.map(window => `${window.key}:${window.periodKind}:${window.metricKey || ''}:${window.periodKind === 'quota' ? window.periodStart : ''}`).join('|');
        const cached = this.#statsCache.get(account.id);
        if (cached && cached.key === key && now - cached.at < this.#statsTtl) account.windowStats = structuredClone(cached.windows);
        else {
          try {
            account.windowStats = await this.#readLocalWindows(account, now);
            if (account.windowStats.every(window => window.complete)) this.#statsCache.set(account.id, { key, at: now, windows: structuredClone(account.windowStats) });
          } catch {
            for (const window of account.windowStats) window.error = '本站窗口统计暂时读取失败；额度缓存仍可查看。';
          }
        }
        this.#estimate(account.windowStats, account);
      }
    };
    await Promise.all([worker(), worker()]);
    const activeIds = new Set(accounts.map(account => account.id));
    for (const id of this.#statsCache.keys()) if (!activeIds.has(id)) this.#statsCache.delete(id);
  }
  async refresh() {
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      const rawAccounts = await this.fetchAccounts();
      const now = this.#now();
      const merged = this.#overlay ? await this.#overlay(rawAccounts) : rawAccounts;
      const accounts = normalizeAccounts(merged, { now, staleAfterMs: this.#stale });
      if (this.#includeStats) await this.#enrichLocalStats(accounts, now);
      return { accounts, checkedAt: new Date(now).toISOString() };
    })();
    try { return await this.#pending; } finally { this.#pending = null; }
  }
}
