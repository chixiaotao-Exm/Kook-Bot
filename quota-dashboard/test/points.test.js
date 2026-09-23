import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPointCredits, sanitizePointCredits, normalizePoints, sanitizePoints } from '../src/points.js';

const NOW = Date.parse('2026-09-23T18:00:00.000Z');
const credits = (balance = '12.5', has_credits = true, unlimited = false) => ({ balance, has_credits, unlimited });
const account = (value, fetched_at = NOW / 1000, extra = {}) => ({ platform: 'openai', type: 'oauth',
  extra: { codex_credits_snapshot: { credits: value, fetched_at }, ...extra } });

test('points distinguish an exact zero, available unknown balance and unlimited before numeric balance', () => {
  assert.deepEqual(cleanPointCredits(credits()), { balance: 12.5, hasCredits: true, unlimited: false });
  assert.deepEqual(cleanPointCredits(credits(null, false)), { balance: 0, hasCredits: false, unlimited: false });
  assert.deepEqual(cleanPointCredits(credits('999', false)), { balance: 0, hasCredits: false, unlimited: false });
  assert.deepEqual(cleanPointCredits(credits(null, true)), { balance: null, hasCredits: true, unlimited: false });
  assert.deepEqual(cleanPointCredits(credits('999', false, true)), { balance: null, hasCredits: false, unlimited: true });
  assert.deepEqual(cleanPointCredits(credits('0', true)), { balance: 0, hasCredits: true, unlimited: false });
});

test('only finite nonnegative decimal balances within the safe range are exposed', () => {
  for (const [value, expected] of [['0', 0], [0, 0], ['001.25', 1.25], [' 25.5 ', 25.5],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [null, null], [undefined, null], ['', null], [' ', null],
    [false, null], [[], null], [{}, null], [-1, null], ['-1', null], ['+1', null], ['0x10', null], ['1e3', null],
    ['Infinity', null], [Infinity, null], [NaN, null], [Number.MAX_SAFE_INTEGER + 1, null], ['9007199254740992', null]]) {
    assert.equal(cleanPointCredits({ ...credits(), balance: value }).balance, expected, String(value));
  }
});

test('missing or malformed flags cannot invent zero or unlimited points', () => {
  for (const value of [undefined, null, {}, [], { balance: '0' }, { has_credits: false }, { unlimited: true },
    credits('1', 'false', false), credits('1', false, 0), credits('1', null, true)]) assert.equal(cleanPointCredits(value), null);
  const unknown = normalizePoints({ platform: 'openai', type: 'oauth' }, { now: NOW });
  assert.deepEqual(unknown, { balance: null, hasCredits: null, unlimited: null, observedAt: null,
    freshness: 'unknown', source: 'sub2api-cache' });
  const invalid = normalizePoints(account({ has_credits: 'false', unlimited: false }), { now: NOW });
  assert.equal(invalid.balance, null); assert.equal(invalid.hasCredits, null); assert.equal(invalid.unlimited, null);
});

test('points apply only to exact supported OpenAI account types and never to shadow accounts', () => {
  for (const type of ['oauth', 'setup-token']) {
    assert.equal(normalizePoints({ ...account(credits()), type }, { now: NOW }).balance, 12.5);
  }
  for (const patch of [{ type: 'setup' }, { type: 'oauth-untrusted' }, { type: 'apikey' }, { platform: 'anthropic' },
    { platform: 'deepseek' }, { parent_account_id: 1 }, { parent_account_id: 0 }, { is_shadow: true }]) {
    assert.equal(normalizePoints({ ...account(credits()), ...patch }, { now: NOW }), null);
  }
  assert.equal(normalizePoints({ ...account(credits()), parent_account_id: null }, { now: NOW }).balance, 12.5);
  assert.equal(normalizePoints(null), null);
});

test('active points must match the exact sample and age on 35 minutes instead of the 15-minute cache lifetime', () => {
  const observedAt = new Date(NOW).toISOString();
  const raw = account(credits(), NOW / 1000, { codex_active_points_observed_at: observedAt });
  const active = normalizePoints(raw, { now: NOW + 20 * 60000, staleAfterMs: 900000 });
  assert.equal(active.source, 'sub2api-active-quota'); assert.equal(active.observedAt, observedAt); assert.equal(active.freshness, 'fresh');
  assert.equal(normalizePoints(raw, { now: NOW + 35 * 60000 + 1 }).freshness, 'stale');
  assert.equal(normalizePoints(account(credits()), { now: NOW + 20 * 60000 }).freshness, 'stale');
  raw.extra.codex_active_points_observed_at = new Date(NOW - 1000).toISOString();
  assert.equal(normalizePoints(raw, { now: NOW + 20 * 60000 }).source, 'sub2api-cache');
  raw.extra.codex_active_points_stale = true;
  assert.equal(normalizePoints(raw, { now: NOW }).freshness, 'stale');
  assert.equal(sanitizePoints(normalizePoints(raw, { now: NOW }), { now: NOW }).freshness, 'stale');
});

test('unknown, future and stale sample times remain explicit and persisted points are safely re-aged', () => {
  for (const at of [undefined, null, '', 0, -1, 'invalid', Infinity]) {
    const raw = account(credits()); raw.extra.codex_credits_snapshot.fetched_at = at;
    const result = normalizePoints(raw, { now: NOW });
    assert.equal(result.observedAt, null); assert.equal(result.freshness, 'unknown');
  }
  assert.equal(normalizePoints(account(credits(), (NOW + 61000) / 1000), { now: NOW }).freshness, 'unknown');
  const result = normalizePoints(account(credits(), new Date(NOW).toISOString()), { now: NOW });
  assert.equal(result.observedAt, new Date(NOW).toISOString());
  assert.equal(sanitizePoints(result, { now: NOW + 900001 }).freshness, 'stale');
  assert.equal(sanitizePoints(result, { now: NOW, stale: true }).freshness, 'stale');
  assert.equal(sanitizePoints(null), null);
});

test('raw, saved and public point records contain only approved fields and never mix other credit systems', () => {
  const raw = account({ ...credits('42.25'), token: 'private-credit-token', email: 'private@example.test' });
  raw.credentials = { access_token: 'private-account-token' };
  raw.extra.codex_reset_credit_snapshot = { available_count: 99 };
  raw.extra.codex_referral_snapshot = { available_invites: 123 };
  raw.extra.codex_credits_snapshot.url = 'https://private.example/points';
  const result = normalizePoints(raw, { now: NOW });
  assert.deepEqual(Object.keys(result), ['balance', 'hasCredits', 'unlimited', 'observedAt', 'freshness', 'source']);
  assert.equal(result.balance, 42.25);
  const sanitized = sanitizePoints({ ...result, credentials: raw.credentials, email: 'private@example.test', currency: 'USD', percent: 80 }, { now: NOW });
  assert.deepEqual(sanitized, result);
  assert.doesNotMatch(JSON.stringify(sanitized), /private|token|email|USD|percent|99|123/);
  assert.deepEqual(sanitizePointCredits({ ...result, secret: 'private' }), { balance: 42.25, hasCredits: true, unlimited: false });
  assert.equal(sanitizePointCredits({ balance: 1, hasCredits: 'true', unlimited: false }), null);
});
