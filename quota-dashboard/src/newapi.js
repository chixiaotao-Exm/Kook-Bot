// Read-only adapter for the verified ark717 New API deployment. This is a
// personal query token, never the sub2api administrator key or a model key.
const ORIGIN = 'https://api.ark717.com';
const PATHS = new Set(['/api/status', '/api/user/self', '/api/subscription/self', '/api/user/quota_grants', '/api/global-quota/self']);
const MAX_BYTES = 1024 * 1024;
const SOURCE = 'newapi-ark717';
const FIELDS = ['id', 'name', 'platform', 'platformLabel', 'type', 'status', 'schedulable', 'plan', 'planLabel', 'planSource', 'source', 'freshness', 'observedAt', 'metrics', 'windowStats', 'resetCredits', 'points', 'invitation', 'quotaQuery', 'notes', 'error'];
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const amount = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const data = envelope => envelope?.success === true ? obj(envelope.data) : {};
const iso = value => {
  const n = amount(value);
  const time = n !== null ? n < 1e12 ? n * 1000 : n : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8640000000000000 ? new Date(time).toISOString() : null;
};
const cloneAccount = account => Object.fromEntries(FIELDS.filter(key => Object.hasOwn(account, key)).map(key => [key, structuredClone(account[key])]));

export class NewApiError extends Error {
  constructor(code, message) { super(message); this.name = 'NewApiError'; this.code = code; }
}

/** Whitelist only amounts, counts and validity times; never return user info. */
export function normalizeNewApi(payload = {}, { now = Date.now() } = {}) {
  const self = data(payload.self), status = data(payload.status);
  const perUnit = amount(status.quota_per_unit);
  const usd = status.quota_display_type === 'USD' && perUnit !== null && perUnit > 0;
  const convert = value => { const n = amount(value); return usd && n !== null ? n / perUnit : null; };
  const observedAt = new Date(now).toISOString();
  const metrics = [], notes = [
    '小鸡毛：只读查询上游账号；钱包是该上游账号所有令牌共享的美元计价额度，不是现金余额。',
    '上游累计使用及请求数覆盖该上游账号，不等同于本站 A/U 费用或本站请求数；不同额度项不相加。',
  ];
  const add = (key, label, kind, fields, note, resetAt = null) => {
    const known = Object.values(fields).some(value => typeof value === 'number' && Number.isFinite(value));
    const metric = { key: `newapi-${key}`, source: SOURCE, label: `小鸡毛·${label}`, kind, scope: 'upstream', ...fields,
      observedAt, resetAt, freshness: known ? 'fresh' : 'unknown', note };
    metrics.push(metric);
    return metric;
  };
  const wallet = convert(self.quota);
  add('wallet', '钱包可用计价额度', 'balance', { value: wallet, unit: 'USD' }, '上游账号共享计价额度，非现金；未与订阅或共享池相加。');
  add('used', '上游累计使用', 'count', { used: convert(self.used_quota), unit: 'USD' }, '上游账号累计计价使用量，不是本站 A/U 费用。');
  add('requests', '上游累计请求', 'count', { used: amount(self.request_count), unit: 'requests' }, '上游账号所有令牌的累计请求数，不是本站请求数。');
  if (!usd) notes.push('上游美元计价换算信息缺失或不受支持，金额显示未知；未使用充值价格或汇率换算。');
  if (wallet === null) notes.push('本次未取得有效钱包额度；未知不表示 0 或无限额度。');

  // Additional entitlement schemas are deliberately explicit. Historical or
  // expired rows must never be promoted into currently spendable amounts.
  const subscriptions = data(payload.subscriptions);
  const activeSubscriptions = Array.isArray(subscriptions.subscriptions) ? subscriptions.subscriptions : [];
  let validSubscriptions = 0;
  for (const [index, row] of activeSubscriptions.slice(0, 40).entries()) {
    const subscription = obj(row?.subscription || row);
    const end = iso(subscription.end_time), start = iso(subscription.start_time);
    if (subscription.status !== 'active' || !end || Date.parse(end) <= now || start && Date.parse(start) > now) continue;
    const limit = convert(subscription.amount_total), used = convert(subscription.amount_used);
    if (limit === null || limit <= 0 || used === null) continue;
    const next = iso(subscription.next_reset_time);
    add(`subscription-${index}`, `有效订阅 ${++validSubscriptions}`, 'count', { limit, used, remaining: Math.max(0, limit - used), unit: 'USD', validUntil: end },
      `订阅独立额度，不与钱包相加；有效期截至 ${end}。`, next && Date.parse(next) > now ? next : null);
  }
  if (payload.subscriptions?.success === true && !activeSubscriptions.length) notes.push('当前没有有效订阅；历史或已过期订阅未计入可用额度。');
  else if (activeSubscriptions.length && !validSubscriptions) notes.push('订阅未提供可确认的有效期和剩余额度；历史、过期或信息不完整的订阅未计入可用额度。');
  const grants = data(payload.grants);
  if (payload.grants?.success === true && Array.isArray(grants.items) && !grants.items.length) notes.push('当前没有独立额度包；这不表示钱包没有额度。');
  let validGrants = 0;
  for (const [index, row] of (Array.isArray(grants.items) ? grants.items : []).slice(0, 40).entries()) {
    const grant = obj(row), end = iso(grant.expires_at);
    if (grant.status !== undefined && grant.status !== 'active' || !end || Date.parse(end) <= now) continue;
    const limit = convert(grant.amount), remaining = convert(grant.remaining);
    if (limit === null || limit <= 0 || remaining === null || remaining > limit) continue;
    add(`grant-${index}`, `有效额度包 ${++validGrants}`, 'count', { limit, remaining, used: limit - remaining, unit: 'USD', validUntil: end },
      `独立额度包，不与钱包相加；有效期截至 ${end}。`);
  }
  if (Array.isArray(grants.items) && grants.items.length && !validGrants) notes.push('额度包已过期或缺少可核实的有效期、金额，未计入可用额度。');

  const global = data(payload.globalQuota);
  if (global.enabled === true && global.exempt === true) {
    notes.push('上游全局共享池已启用；此账号获豁免，共享池数字不作为个人余额或可用额度。');
  } else if (global.enabled === true && global.exempt === false) {
    add('global-daily', '共享池日额度（非个人）', 'count', {
      limit: convert(global.daily_limit), remaining: convert(global.daily_remaining), unit: 'USD',
    }, '共享池受其他用户使用影响，不是个人独占额度，不与钱包相加。', iso(global.daily_reset_at));
    const current = (Array.isArray(global.windows) ? global.windows : []).find(window => window?.is_current === true);
    if (current) add('global-current-window', '共享池当前时段（非个人）', 'count', {
      limit: convert(current.limit), remaining: convert(current.remaining), used: convert(current.consumed), unit: 'USD',
    }, '上游标记的当前共享时段；包含其他用户及预留消耗，不是个人独占额度，不与钱包相加。');
  }
  return { source: SOURCE, observedAt, freshness: wallet !== null ? 'fresh' : 'unknown', metrics, notes };
}

async function readBounded(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new NewApiError('FORMAT', '小鸡毛查询响应超过大小限制。');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new NewApiError('FORMAT', '小鸡毛查询响应超过大小限制。');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new NewApiError('FORMAT', '小鸡毛查询响应超过大小限制。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class NewApiAccountSource {
  #base; #key; #id; #fetch; #now; #ttl; #timeout;
  #pending = null; #last = null; #cached = null; #nextAt = 0;
  constructor({ baseUrl = ORIGIN, queryKey, accountId, fetchImpl = globalThis.fetch, now = Date.now, cacheMs = 300000, timeoutMs = 10000 } = {}) {
    let base;
    try { base = new URL(baseUrl); } catch { throw new NewApiError('CONFIG', '小鸡毛查询地址配置不正确。'); }
    if (base.origin !== ORIGIN || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new NewApiError('CONFIG', '小鸡毛查询只允许已核实的 HTTPS 官方服务地址。');
    if (typeof queryKey !== 'string' || !queryKey.trim() || /[\r\n]/.test(queryKey) || queryKey.length > 4096) throw new NewApiError('CONFIG', '小鸡毛查询 Key 配置不正确。');
    if (!/^[1-9]\d*$/.test(String(accountId))) throw new NewApiError('CONFIG', '必须指定小鸡毛对应的 sub2api 账号 ID。');
    this.#base = base.origin; this.#key = queryKey.trim(); this.#id = String(accountId); this.#fetch = fetchImpl; this.#now = now;
    this.#ttl = Math.max(1000, Number(cacheMs) || 300000); this.#timeout = Math.max(10, Number(timeoutMs) || 10000);
  }
  // Startup fallback uses only previously normalized numeric metrics. It never
  // suppresses the first live refresh and never restores user-info responses.
  seed(accounts) {
    if (this.#last || this.#pending || !Array.isArray(accounts)) return;
    const account = accounts.find(row => String(row?.id) === this.#id && row.platform === 'openai' && /^(apikey|api_key)$/i.test(row.type));
    if (!account || !Array.isArray(account.metrics)) return;
    const fixed = { wallet: ['钱包可用计价额度', 'balance', 'USD'], used: ['上游累计使用', 'count', 'USD'], requests: ['上游累计请求', 'count', 'requests'],
      'global-daily': ['共享池日额度（非个人）', 'count', 'USD'], 'global-current-window': ['共享池当前时段（非个人）', 'count', 'USD'] };
    const metrics = [];
    for (const row of account.metrics.slice(0, 100)) {
      if (row?.source !== SOURCE || typeof row.key !== 'string' || !row.key.startsWith('newapi-')) continue;
      const key = row.key.slice(7), numbered = /^(subscription|grant)-(\d{1,2})$/.exec(key);
      const definition = Object.hasOwn(fixed, key) ? fixed[key] : numbered && [`${numbered[1] === 'subscription' ? '有效订阅' : '有效额度包'} ${Number(numbered[2]) + 1}`, 'count', 'USD'];
      const observedAt = iso(row.observedAt);
      if (!definition || !observedAt || Date.parse(observedAt) > this.#now() + 60000) continue;
      const values = Object.fromEntries(['value', 'used', 'remaining', 'limit'].filter(field => amount(row[field]) !== null).map(field => [field, amount(row[field])]));
      if (!Object.keys(values).length) continue;
      metrics.push({ key: row.key, source: SOURCE, scope: 'upstream', label: `小鸡毛·${definition[0]}`, kind: definition[1], unit: definition[2],
        ...values, observedAt, resetAt: iso(row.resetAt), validUntil: iso(row.validUntil), freshness: 'stale', note: '上次成功读取的上游账号计价快照，非现金；各额度项不相加，当前可用量须等待重新查询。' });
    }
    if (!metrics.some(metric => metric.key === 'newapi-wallet' && typeof metric.value === 'number')) return;
    const rank = key => ({ 'newapi-wallet': 0, 'newapi-used': 1, 'newapi-requests': 2 })[key] ?? 3;
    metrics.sort((a, b) => rank(a.key) - rank(b.key));
    this.#last = { source: SOURCE, observedAt: metrics.map(metric => metric.observedAt).sort().at(-1), freshness: 'stale', metrics,
      notes: ['小鸡毛：已恢复上次保存的安全额度快照；当前查询成功前，所有数值均为陈旧数据。', '钱包由上游账号所有令牌共享，是美元计价额度而非现金；累计使用不是本站 A/U 费用，各额度项不相加。'] };
  }
  async #request(path) {
    if (!PATHS.has(path)) throw new NewApiError('PATH', '小鸡毛查询路径不受支持。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout); timer.unref?.();
    try {
      const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; ReadOnlyQuotaDashboard/1.0)' };
      if (path !== '/api/status') headers.authorization = `Bearer ${this.#key}`;
      const response = await this.#fetch(new URL(path, this.#base).href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (response.redirected || response.status >= 300 && response.status < 400) throw new NewApiError('REDIRECT', '小鸡毛查询返回重定向，已停止请求。');
      if (response.status === 401 || response.status === 403) throw new NewApiError('AUTH', '小鸡毛查询 Key 无效或权限不足。');
      if (!response.ok) throw new NewApiError('UPSTREAM', '小鸡毛暂时无法返回额度数据。');
      let parsed;
      try { parsed = JSON.parse(await readBounded(response)); }
      catch (error) { if (error instanceof NewApiError) throw error; throw new NewApiError('FORMAT', '小鸡毛查询数据无法解析。'); }
      if (parsed?.success !== true || !parsed.data || typeof parsed.data !== 'object') throw new NewApiError('UPSTREAM', '小鸡毛未返回成功的查询结果。');
      return parsed;
    } catch (error) {
      if (error instanceof NewApiError) throw error;
      throw new NewApiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', controller.signal.aborted ? '小鸡毛额度查询超时。' : '小鸡毛额度查询连接失败。');
    } finally { clearTimeout(timer); }
  }
  async #refresh() {
    const keys = ['status', 'self', 'subscriptions', 'grants', 'globalQuota'];
    const paths = ['/api/status', '/api/user/self', '/api/subscription/self', '/api/user/quota_grants', '/api/global-quota/self'];
    const results = await Promise.allSettled(paths.map(path => this.#request(path)));
    let failure = results.slice(0, 2).find(result => result.status === 'rejected');
    const now = this.#now();
    const payload = Object.fromEntries(results.map((result, index) => [keys[index], result.status === 'fulfilled' ? result.value : null]));
    const normalized = normalizeNewApi(payload, { now });
    if (!failure && normalized.metrics[0].value === null) failure = { reason: new NewApiError('FORMAT', '小鸡毛未返回有效钱包金额或美元换算信息。') };
    if (failure) {
      const message = failure.reason instanceof NewApiError ? failure.reason.message : '小鸡毛额度查询失败。';
      this.#cached = this.#last ? { ...structuredClone(this.#last), freshness: 'stale',
        metrics: this.#last.metrics.map(metric => ({ ...metric, freshness: 'stale' })),
        notes: [...this.#last.notes, `${message} 以下为上次成功读取的数据，不能视为当前可用额度。`],
      } : { ...normalizeNewApi({}, { now }), observedAt: null, freshness: 'unknown',
        metrics: normalizeNewApi({}, { now }).metrics.map(metric => ({ ...metric, observedAt: null })),
        notes: [message, '未取得小鸡毛上游额度，数值未知；其他账号和本站统计不受影响。'] };
      this.#nextAt = now + Math.min(this.#ttl, 60000);
      return;
    }
    this.#cached = normalized;
    if (results.slice(2).some(result => result.status === 'rejected')) this.#cached.notes.push('部分订阅、额度包或共享池信息暂时不可读；未将缺失部分视为 0。');
    this.#last = structuredClone(this.#cached);
    this.#nextAt = now + this.#ttl;
  }
  async enrich(accounts) {
    if (!Array.isArray(accounts)) throw new NewApiError('FORMAT', '账号列表格式不正确。');
    const match = account => String(account?.id) === this.#id && account.platform === 'openai' && /^(apikey|api_key)$/i.test(account.type);
    const copies = accounts.map(cloneAccount);
    if (!copies.some(match)) return copies;
    if (!this.#cached || this.#now() >= this.#nextAt) {
      if (!this.#pending) this.#pending = this.#refresh().finally(() => { this.#pending = null; });
      await this.#pending;
    }
    const update = this.#cached;
    return copies.map(account => {
      if (!match(account)) return account;
      const originalMetrics = (account.metrics || []).filter(metric => !String(metric.key).startsWith('newapi-'));
      const metrics = [...originalMetrics, ...structuredClone(update.metrics)];
      const notes = (account.notes || []).filter(note => !/^小鸡毛[:：·]/.test(note) && !(typeof update.metrics[0].value === 'number' && /暂无可用的上游额度缓存/.test(note)));
      const upstream = metrics.filter(metric => metric.scope === 'upstream');
      const observed = upstream.map(metric => metric.observedAt).filter(Boolean).sort();
      return { ...account, source: SOURCE, sourceLabel: 'Sub2API + 小鸡毛上游查询', metrics, notes: [...notes, ...update.notes], observedAt: observed.at(-1) || null,
        freshness: upstream.some(metric => metric.freshness === 'stale') ? 'stale' : upstream.every(metric => metric.freshness === 'fresh') ? 'fresh' : 'unknown' };
    });
  }
}
