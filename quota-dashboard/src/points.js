const CACHE_STALE_MS = 15 * 60 * 1000;
const ACTIVE_STALE_MS = 35 * 60 * 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => {
  const valid = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim());
  const number = valid ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
};

function iso(value) {
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  const time = numeric ? Number(value) * 1000 : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8640000000000000 ? new Date(time).toISOString() : null;
}

/** Account points are distinct from reset credits, invitations and currency. */
export function cleanPointCredits(raw) {
  if (!object(raw) || typeof raw.has_credits !== 'boolean' || typeof raw.unlimited !== 'boolean') return null;
  return { balance: raw.unlimited ? null : raw.has_credits ? amount(raw.balance) : 0,
    hasCredits: raw.has_credits, unlimited: raw.unlimited };
}

export function sanitizePointCredits(value) {
  if (!object(value)) return null;
  return cleanPointCredits({ balance: value.balance, has_credits: value.hasCredits, unlimited: value.unlimited });
}

function display(credits, observedAt, source, { now = Date.now(), staleAfterMs = CACHE_STALE_MS, stale = false } = {}) {
  const age = observedAt ? Number(now) - Date.parse(observedAt) : NaN;
  const ttl = source === 'sub2api-active-quota' ? ACTIVE_STALE_MS : staleAfterMs;
  const freshness = stale ? 'stale' : !Number.isFinite(age) || age < -60000 ? 'unknown' : age > ttl ? 'stale' : 'fresh';
  return { balance: credits?.balance ?? null, hasCredits: credits?.hasCredits ?? null, unlimited: credits?.unlimited ?? null,
    observedAt, freshness, source };
}

export function normalizePoints(rawAccount, options = {}) {
  if (!object(rawAccount) || rawAccount.platform !== 'openai' || !['oauth', 'setup-token'].includes(rawAccount.type)
    || rawAccount.parent_account_id !== undefined && rawAccount.parent_account_id !== null || rawAccount.is_shadow === true) return null;
  const extra = object(rawAccount.extra) ? rawAccount.extra : {};
  const snapshot = object(extra.codex_credits_snapshot) ? extra.codex_credits_snapshot : {};
  const observedAt = iso(snapshot.fetched_at);
  const source = observedAt && observedAt === iso(extra.codex_active_points_observed_at) ? 'sub2api-active-quota' : 'sub2api-cache';
  return display(cleanPointCredits(snapshot.credits), observedAt, source,
    { ...options, stale: extra.codex_active_points_stale === true });
}

/** Rebuild persisted display data without carrying arbitrary upstream fields. */
export function sanitizePoints(value, options = {}) {
  if (!object(value)) return null;
  const source = value.source === 'sub2api-active-quota' ? value.source : 'sub2api-cache';
  return display(sanitizePointCredits(value), iso(value.observedAt), source,
    { ...options, stale: options.stale === true || value.freshness === 'stale' });
}
