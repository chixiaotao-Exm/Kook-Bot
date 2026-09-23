const DEFAULT_STALE_MS = 30 * 60 * 1000;
const TYPES = new Set(['oauth', 'setup-token', 'apikey', 'api_key', 'bedrock']);
const STATUSES = new Set(['active', 'inactive', 'disabled', 'error']);
const LABELS = { healthy: '正常', limited: '限流中', temporary: '暂不可用', expired: '已到期', error: '异常',
  disabled: '已关闭', paused: '暂停调度', unknown: '待确认' };
const ISSUES = {
  account_error: '账号异常', authentication: '鉴权异常', expired: '账号已到期', disabled: '账号已关闭', paused: '暂停调度',
  rate_limit: '请求限流', overload: '服务过载', temporary: '临时暂停调度',
  rate_limit_ended: '原限流时间已结束', overload_ended: '原过载时间已结束', temporary_ended: '原暂停时间已结束',
  rate_limit_unknown: '限流记录时间未知', overload_unknown: '过载记录时间未知', temporary_unknown: '临时阻断时间未知',
  unknown_type: '账号类型未识别', unknown_status: '账号状态未识别', scheduling_unknown: '调度状态未知',
};
const REASONS = {
  healthy: '账号已启用且可调度，未发现已知阻断。', limited: '原服务记录的限流时间尚未结束。',
  temporary: '原服务记录了尚未结束的临时阻断。', expired: '超过账号配置到期时间，请在原服务核对。',
  error: '原服务将此账号标记为异常，请在原服务核对。',
  authentication: '原服务记录了鉴权或令牌错误，请核对凭据。',
  disabled: '账号在原服务中已关闭。', paused: '账号暂停参与调度，不代表账号失效。',
  unknown: '信息不足，等待新的账号状态观测。', ended: '原阻断时间已结束，等待刷新确认是否恢复。',
};
const BLOCKS = ['rate_limit', 'overload', 'temporary'];
const AUTH_FAILURE = /\b(?:401|unauthori[sz]ed|invalid_token|token_expired|expired_token|invalid_grant|invalid_api_key|invalid_credentials)\b|\b(?:invalid|incorrect|expired|revoked)\s+(?:(?:access|refresh)\s+)?(?:token|api[ _-]?key)\b|\b(?:(?:access|refresh)\s+)?token\s+(?:(?:has|is)\s+)?(?:expired|invalid|revoked)\b|(?:鉴权|认证)(?:失败|错误|出错)|凭据(?:无效|错误|过期|失效)|令牌(?:已)?(?:过期|无效|错误|失效)/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  const time = numeric ? (Number(value) < 1e12 ? Number(value) * 1000 : Number(value))
    : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8640000000000000 ? new Date(time).toISOString() : null;
}
const issue = (code, until = null) => ({ code, label: ISSUES[code], until });
const isFuture = (until, now) => until && Date.parse(until) > now;

function display({ state, issues, lastUsedAt, expiresAt, observedAt }, { now = Date.now(), staleAfterMs = DEFAULT_STALE_MS, stale = false } = {}) {
  const age = observedAt ? Number(now) - Date.parse(observedAt) : NaN;
  const freshness = stale ? 'stale' : !Number.isFinite(age) || age < -60000 ? 'unknown' : age > staleAfterMs ? 'stale' : 'fresh';
  const remaining = issues.filter(item => BLOCKS.includes(item.code) && isFuture(item.until, now));
  const recoverAt = ['limited', 'temporary'].includes(state) ? remaining.map(item => item.until).sort().at(-1) || null : null;
  const ended = issues.some(item => item.code.endsWith('_ended'));
  return { state, label: LABELS[state], reason: state === 'error' && issues.some(item => item.code === 'authentication')
    ? REASONS.authentication : state === 'unknown' && ended ? REASONS.ended : REASONS[state],
  lastUsedAt, expiresAt, recoverAt, observedAt, freshness, issues };
}

/** Health describes a saved account-list observation, never a new credential probe. */
export function normalizeAccountHealth(raw, { now = Date.now(), staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const value = object(raw) ? raw : {}, issues = [];
  const sampledAt = Number(now);
  const observedAt = Number.isFinite(sampledAt) && sampledAt > 0 && sampledAt < 8640000000000000 ? new Date(sampledAt).toISOString() : null;
  const lastUsedAt = iso(value.last_used_at), expiresAt = iso(value.expires_at);
  const typeKnown = TYPES.has(value.type), statusKnown = STATUSES.has(value.status);
  if (!typeKnown) issues.push(issue('unknown_type'));
  if (!statusKnown) issues.push(issue('unknown_status'));
  if (value.status === 'error') {
    const authentication = typeof value.error_message === 'string' && AUTH_FAILURE.test(value.error_message.slice(0, 4000));
    issues.push(issue(authentication ? 'authentication' : 'account_error'));
  }
  if (expiresAt && Date.parse(expiresAt) <= now) issues.push(issue('expired', expiresAt));
  if (['disabled', 'inactive'].includes(value.status)) issues.push(issue('disabled'));
  for (const [code, field] of [['rate_limit', 'rate_limit_reset_at'], ['overload', 'overload_until'], ['temporary', 'temp_unschedulable_until']]) {
    const until = iso(value[field]);
    // A new list observation can establish that an old blocking window ended.
    if (isFuture(until, now)) issues.push(issue(code, until));
  }
  if (value.schedulable === false) issues.push(issue('paused'));
  else if (value.schedulable !== true) issues.push(issue('scheduling_unknown'));
  const has = code => issues.some(item => item.code === code);
  const state = !typeKnown || !statusKnown ? 'unknown'
    : value.status === 'error' ? 'error' : has('expired') ? 'expired' : has('disabled') ? 'disabled'
      : has('rate_limit') ? 'limited' : has('overload') || has('temporary') ? 'temporary'
        : has('paused') ? 'paused' : value.status === 'active' && value.schedulable === true ? 'healthy' : 'unknown';
  return display({ state, issues, lastUsedAt, expiresAt, observedAt }, { now, staleAfterMs });
}

/** Re-age only saved safe facts. Passing a deadline never proves recovery. */
export function sanitizeAccountHealth(raw, options = {}) {
  const value = object(raw) ? raw : {}, now = options.now ?? Date.now();
  let state = typeof value.state === 'string' && Object.hasOwn(LABELS, value.state) ? value.state : 'unknown';
  const issues = [], seen = new Set();
  for (const entry of Array.isArray(value.issues) ? value.issues.slice(0, 20) : []) {
    if (!object(entry) || typeof entry.code !== 'string' || !Object.hasOwn(ISSUES, entry.code)) continue;
    let code = entry.code; const until = iso(entry.until);
    if (BLOCKS.includes(code) && !isFuture(until, now)) code += until ? '_ended' : '_unknown';
    if (seen.has(code)) continue;
    seen.add(code); issues.push(issue(code, until));
  }
  const expiresAt = iso(value.expiresAt);
  if (issues.some(item => ['unknown_type', 'unknown_status'].includes(item.code))) state = 'unknown';
  else if (state === 'error' || issues.some(item => ['account_error', 'authentication'].includes(item.code))) state = 'error';
  else if (state !== 'unknown' && expiresAt && Date.parse(expiresAt) <= now) {
    state = 'expired'; if (!seen.has('expired')) issues.push(issue('expired', expiresAt));
  } else if (state === 'disabled' || seen.has('disabled')) state = 'disabled';
  else if (['limited', 'temporary'].includes(state) || issues.some(item => BLOCKS.includes(item.code))) {
    state = issues.some(item => item.code === 'rate_limit' && isFuture(item.until, now)) ? 'limited'
      : issues.some(item => ['overload', 'temporary'].includes(item.code) && isFuture(item.until, now)) ? 'temporary' : 'unknown';
  } else if (state === 'healthy' && issues.some(item => item.code.endsWith('_unknown'))) state = 'unknown';
  else if (state === 'healthy' && seen.has('paused')) state = 'paused';
  return display({ state, issues, lastUsedAt: iso(value.lastUsedAt), expiresAt, observedAt: iso(value.observedAt) }, options);
}
