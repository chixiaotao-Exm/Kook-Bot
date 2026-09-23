const DEFAULT_STALE_MS = 15 * 60 * 1000;
const PROGRAMS = Object.freeze({ codex_referral_consumer: '个人邀请', codex_referral_workspace: '工作区邀请' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit * 8).toWellFormed()
  .replace(/<[^>]*>/g, '')
  .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\b(?:admin-|sk-)[A-Za-z0-9_-]{8,}|\b\d+\/[A-Za-z0-9+/=]{4,}\/[A-Za-z0-9+/=]{8,}/g, '[已隐藏]')
  .replace(/\bBearer\s+\S+/gi, '[已隐藏]')
  .replace(/[^\s<>()[\]{}"'@]+@[^\s<>()[\]{}"'@]+/g, '[邮箱已隐藏]')
  .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|\b(?:mailto|tel):\S+|\b(?:www\.)?[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?:\/[^\s]*)?/gi, '[地址已隐藏]')
  .replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : '';

function isoSeconds(value) {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8640000000000000
    ? new Date(milliseconds).toISOString() : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

function display(fields, checkedAt, { now = Date.now(), staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const programId = typeof fields.programId === 'string' && Object.hasOwn(PROGRAMS, fields.programId) ? fields.programId : null;
  const age = checkedAt ? Number(now) - Date.parse(checkedAt) : NaN;
  const freshness = !Number.isFinite(age) || age < -60000 ? 'unknown' : age > staleAfterMs ? 'stale' : 'fresh';
  return { supported: true, availableCount: count(fields.availableCount), shouldShow: fields.shouldShow === true,
    programId, programLabel: programId ? PROGRAMS[programId] : '', requiresConfirmation: fields.requiresConfirmation !== false,
    title: text(fields.title, 160), description: text(fields.description, 1000),
    rules: (Array.isArray(fields.rules) ? fields.rules.slice(0, 20) : []).map(rule => text(rule, 300)).filter(Boolean), checkedAt, freshness };
}

/** Public display data only. Capability does not imply available invitations. */
export function normalizeInvitation(rawAccount, options = {}) {
  if (!object(rawAccount) || rawAccount.platform !== 'openai' || rawAccount.type !== 'oauth'
    || rawAccount.parent_account_id !== undefined && rawAccount.parent_account_id !== null || rawAccount.is_shadow === true) return null;
  const raw = object(rawAccount.extra?.codex_referral_snapshot) ? rawAccount.extra.codex_referral_snapshot : {};
  return display({ availableCount: raw.available_invites, shouldShow: raw.should_show, programId: raw.program_id,
    requiresConfirmation: raw.requires_explicit_confirmation, title: raw.title, description: raw.description, rules: raw.rules }, isoSeconds(raw.fetched_at), options);
}

/** Revalidate saved/live normalized values; never spread an upstream object. */
export function sanitizeInvitation(value, options = {}) {
  if (!object(value) || value.supported !== true) return null;
  return display(value, isoDate(value.checkedAt), options);
}
