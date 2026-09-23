import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveQuotaClient, applyActiveQuota, sanitizeActiveQuotaRecord } from '../src/active-quota.js';
import { normalizeAccounts } from '../src/sub2api.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const raw = () => ({ id: 6255, platform: 'openai', type: 'oauth', status: 'active', extra: { auto_reset_credit_enabled: false } });
const usage = () => ({ fetched_at: NOW / 1000, cache_persisted: true, plan_type: 'pro_lite',
  email: 'secret@example.com', account_id: 'private-account', user_id: 'private-user', credentials: { access_token: 'private-token' },
  rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18000, reset_at: NOW / 1000 + 600, reset_after_seconds: 600 },
    secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 86400 } },
  rate_limit_reset_credits: { available_count: 1, credits: [{ expires_at: '2026-10-01T12:00:00Z', token: 'credit-secret' }] } });
const response = data => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
const fixture = ({ account = raw(), payload = usage(), finalAccount = account, fetchImpl, timeoutMs = 1000 } = {}) => {
  const calls = [];
  const client = new ActiveQuotaClient({ adminApiKey: 'admin-test-key', now: () => NOW, timeoutMs,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (fetchImpl) return fetchImpl(url, options, calls.length);
      return response(options.method === 'POST' ? payload : calls.length === 1 ? account : finalAccount);
    } });
  return { client, calls };
};

test('active quota uses exact guarded endpoints once and returns only safe quota fields', async () => {
  const { client, calls } = fixture();
  const result = await client.refreshAccount(6255);
  assert.deepEqual(calls.map(row => [new URL(row.url).pathname, row.method]), [
    ['/api/v1/admin/accounts/6255', 'GET'], ['/api/v1/admin/openai/accounts/6255/quota/refresh', 'POST'], ['/api/v1/admin/accounts/6255', 'GET'],
  ]);
  assert.ok(calls.every(row => row.headers['x-api-key'] === 'admin-test-key' && row.redirect === 'manual'));
  assert.equal(calls[1].body, '{}');
  assert.deepEqual(result, { accountId: '6255', queriedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW).toISOString(), cachePersisted: true,
    usage: { primary: { usedPercent: 60, windowMinutes: 300, resetAt: new Date(NOW + 600000).toISOString(), resetAfterSeconds: 600 },
      secondary: { usedPercent: 15, windowMinutes: 10080, resetAt: new Date(NOW + 86400000).toISOString(), resetAfterSeconds: 86400 },
      resetCredits: { availableCount: 1, expiresAt: ['2026-10-01T12:00:00.000Z'] }, points: null }, planType: 'prolite' });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|token|email|user_id|account_id/i);
});

test('all auto-reset values except boolean false or absent are blocked before POST', async () => {
  for (const value of [true, 'true', 'false', 'unknown', 1, 0, null, {}, []]) {
    const account = raw(); account.extra.auto_reset_credit_enabled = value;
    const { client, calls } = fixture({ account });
    await assert.rejects(client.refreshAccount('6255'), error => error.code === 'AUTO_RESET');
    assert.equal(calls.length, 1);
  }
  for (const extra of [undefined, null, {}, { auto_reset_credit_enabled: false }]) {
    const { client, calls } = fixture({ account: { ...raw(), extra } });
    await client.refreshAccount('6255'); assert.equal(calls.length, 3);
  }
});

test('different identity, ineligible type, disabled and shadow accounts never reach POST', async () => {
  for (const patch of [{ id: 6256 }, { platform: 'anthropic' }, { type: 'apikey' }, { type: 'setup-token' }, { status: 'inactive' }, { status: 'error' },
    { parent_account_id: 5 }, { parent_account_id: 0 }, { is_shadow: true }, { quota_dimension: 'spark' }, { extra: 'unknown' }, { deleted_at: '2026-09-20' }]) {
    const { client, calls } = fixture({ account: { ...raw(), ...patch } });
    await assert.rejects(client.refreshAccount(6255), error => error.code === 'INELIGIBLE');
    assert.equal(calls.length, 1);
  }
});

test('post-query guard discards data when an operator re-enables automatic card use', async () => {
  const { client, calls } = fixture({ finalAccount: { ...raw(), extra: { auto_reset_credit_enabled: true } } });
  await assert.rejects(client.refreshAccount(6255), error => error.code === 'AUTO_RESET');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('an absent quota window clears older fake 100% values without clearing unknown credit counts', async () => {
  const payload = usage(); delete payload.rate_limit.secondary_window; delete payload.rate_limit_reset_credits;
  const { client } = fixture({ payload });
  const result = await client.refreshAccount(6255), account = raw();
  Object.assign(account.extra, { codex_usage_updated_at: new Date(NOW - 60000).toISOString(), codex_secondary_used_percent: 100, codex_secondary_window_minutes: 10080,
    codex_secondary_reset_at: new Date(NOW + 86400000).toISOString(), codex_secondary_reset_after_seconds: 86400, codex_reset_credit_snapshot: { available_count: 2 } });
  const merged = applyActiveQuota(account, result);
  assert.equal(merged.extra.codex_secondary_used_percent, undefined);
  assert.equal(merged.extra.codex_secondary_window_minutes, undefined);
  assert.equal(merged.extra.codex_active_quota_observed_at, result.observedAt);
  assert.equal(merged.extra.codex_reset_credit_snapshot.available_count, 2);
  assert.equal(merged.extra.codex_reset_credit_checked_at, undefined);
  assert.equal(account.extra.codex_secondary_used_percent, 100);
  const [normalized] = normalizeAccounts([merged], { now: NOW });
  assert.equal(normalized.metrics.length, 1); assert.equal(normalized.metrics[0].usedPercent, 60);
});

test('newer native metric and credit observations win independently', async () => {
  const { client } = fixture(), result = await client.refreshAccount(6255), account = raw();
  Object.assign(account.extra, { codex_usage_updated_at: new Date(NOW + 5000).toISOString(), codex_primary_used_percent: 90, codex_primary_window_minutes: 300,
    codex_reset_credit_snapshot: { available_count: 3 }, codex_auto_reset_credit_state: { status: 'available', checked_at: new Date(NOW + 5000).toISOString() } });
  const merged = applyActiveQuota(account, result);
  assert.equal(merged.extra.codex_primary_used_percent, 90);
  assert.equal(merged.extra.codex_active_quota_observed_at, undefined);
  assert.equal(merged.extra.codex_reset_credit_snapshot.available_count, 3);
  delete account.extra.codex_auto_reset_credit_state;
  const newerCredit = applyActiveQuota(account, result);
  assert.equal(newerCredit.extra.codex_primary_used_percent, 90);
  assert.equal(newerCredit.extra.codex_reset_credit_snapshot.available_count, 1);
  assert.equal(newerCredit.extra.codex_reset_credit_checked_at, result.queriedAt);
  assert.equal(account.extra.codex_reset_credit_snapshot.available_count, 3);
});

test('cache sanitization retains known data but strips arbitrary text and nested credentials', async () => {
  const { client } = fixture(), result = await client.refreshAccount(6255);
  const polluted = structuredClone(result);
  polluted.token = 'sk-sensitive'; polluted.email = 'secret@example.com'; polluted.extraPatch = { credentials: 'private' };
  polluted.planType = 'sk-sensitive'; polluted.usage.primary.access_token = 'private';
  polluted.usage.resetCredits.expiresAt.push({ expiresAt: new Date(NOW).toISOString(), token: 'private' });
  const safe = sanitizeActiveQuotaRecord(polluted);
  assert.doesNotMatch(JSON.stringify(safe), /secret|private|sensitive|extraPatch|token|email/);
  assert.equal(safe.planType, null); assert.equal(safe.usage.resetCredits.expiresAt.length, 1);
  for (const patch of [{ accountId: '../reset' }, { queriedAt: '' }, { observedAt: new Date(NOW + 61000).toISOString() }, { usage: null }]) assert.equal(sanitizeActiveQuotaRecord({ ...result, ...patch }), null);
  assert.equal(applyActiveQuota({ ...raw(), id: 8888 }, result).extra.codex_usage_updated_at, undefined);
});

test('an accepted active quota sample updates the displayed plan without rewriting credentials', async () => {
  const { client } = fixture(), result = await client.refreshAccount(6255);
  const account = { ...raw(), credentials: { plan_type: 'plus', access_token: 'private-token' } };
  const overlaid = applyActiveQuota(account, result);
  const [displayed] = normalizeAccounts([overlaid], { now: NOW });
  assert.equal(displayed.planLabel, 'Pro 5x'); assert.equal(displayed.planSource, 'upstream');
  assert.equal(account.credentials.plan_type, 'plus'); assert.equal(overlaid.credentials.plan_type, 'plus');
  assert.doesNotMatch(JSON.stringify(displayed), /private-token|access_token|codex_active_quota_plan_type/);

  const noPlan = applyActiveQuota(account, { ...result, planType: null });
  assert.equal(normalizeAccounts([noPlan], { now: NOW })[0].planLabel, 'Plus');
  const newer = { ...account, extra: { ...overlaid.extra, codex_usage_updated_at: new Date(NOW + 1000).toISOString() } };
  const retained = applyActiveQuota(newer, result);
  assert.equal(retained.extra.codex_active_quota_plan_type, undefined);
  assert.equal(normalizeAccounts([retained], { now: NOW + 1000 })[0].planLabel, 'Plus');
});

test('missing credits remain unknown; actual zero credits remain zero even without dates', async () => {
  for (const [value, expected] of [[null, null], [{}, null], [{ available_count: -1 }, null], [{ available_count: '0' }, null], [{ available_count: 0 }, { availableCount: 0, expiresAt: [] }]]) {
    const payload = usage(); payload.rate_limit_reset_credits = value;
    const { client } = fixture({ payload });
    assert.deepEqual((await client.refreshAccount(6255)).usage.resetCredits, expected);
  }
});

test('invalid windows and unexpected plan text are not promoted to valid quota', async () => {
  const payload = usage(); payload.rate_limit.primary_window.limit_window_seconds = 0;
  payload.rate_limit.secondary_window.used_percent = Number.MAX_SAFE_INTEGER + 1; payload.plan_type = 'Bearer private';
  const { client } = fixture({ payload }); const result = await client.refreshAccount(6255);
  assert.equal(result.usage.primary, null); assert.equal(result.usage.secondary, null); assert.equal(result.planType, null);
  for (const fetched_at of [undefined, 'untrusted', NOW / 1000 + 61]) {
    const { client: invalid } = fixture({ payload: { ...usage(), fetched_at } });
    await assert.rejects(invalid.refreshAccount(6255), error => error.code === 'FORMAT');
  }
});

test('refresh HTTP errors are sanitized and never retried', async () => {
  for (const status of [302, 401, 403, 404, 429, 500]) {
    const { client, calls } = fixture({ fetchImpl: async (_, options) => options.method === 'POST'
      ? new Response('private upstream key admin-secret', { status }) : response(raw()) });
    await assert.rejects(client.refreshAccount(6255), error => !/private|admin-secret/.test(error.message));
    assert.equal(calls.length, 2);
  }
});

test('response size limits apply to both content length and streaming responses', async () => {
  for (const upstream of [new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const { client, calls } = fixture({ fetchImpl: async () => upstream });
    await assert.rejects(client.refreshAccount(6255), error => error.code === 'FORMAT'); assert.equal(calls.length, 1);
  }
});

test('total timeout is bounded even if a mocked fetch ignores abort signals', async () => {
  const { client, calls } = fixture({ timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(client.refreshAccount(6255), error => error.code === 'TIMEOUT'); assert.equal(calls.length, 1);
});

test('abort before and during refresh prevents later calls', async () => {
  const controller = new AbortController(); controller.abort('private reason');
  const { client, calls } = fixture();
  await assert.rejects(client.refreshAccount(6255, { signal: controller.signal }), error => error.code === 'ABORTED'); assert.equal(calls.length, 0);
  const inFlight = new AbortController();
  const paused = fixture({ fetchImpl: async () => { inFlight.abort('private reason'); return response(raw()); } });
  await assert.rejects(paused.client.refreshAccount(6255, { signal: inFlight.signal }), error => error.code === 'ABORTED');
  assert.equal(paused.calls.length, 1);
});

test('configuration and IDs cannot redirect the administrator key or target reset actions', async () => {
  for (const baseUrl of ['https://api.example.com', 'http://localhost:8080', 'http://127.0.0.1:8081', 'http://127.0.0.1:8080/path', 'http://key@127.0.0.1:8080', 'http://127.0.0.1:8080/?x=1'])
    assert.throws(() => new ActiveQuotaClient({ baseUrl, adminApiKey: 'test' }), error => error.code === 'CONFIG');
  const { client, calls } = fixture();
  for (const value of ['1/../../quota/reset', '1?reset=true', '0', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808'])
    await assert.rejects(client.refreshAccount(value), error => error.code === 'ACCOUNT_ID');
  assert.equal(calls.length, 0);
});
