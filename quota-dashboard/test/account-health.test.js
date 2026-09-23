import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccountHealth, sanitizeAccountHealth } from '../src/account-health.js';
import { normalizeAccounts } from '../src/sub2api.js';
import { NewApiAccountSource } from '../src/newapi.js';

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const iso = offset => new Date(NOW + offset).toISOString();
const account = patch => ({ id: 1, name: 'Account', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, ...patch });
const health = patch => normalizeAccountHealth(account(patch), { now: NOW });

test('health is an observed scheduling state and does not invent credential validation', () => {
  const result = health({ last_used_at: (NOW - 60000) / 1000 });
  assert.equal(result.state, 'healthy'); assert.equal(result.observedAt, iso(0));
  assert.equal(result.lastUsedAt, iso(-60000)); assert.equal(result.recoverAt, null); assert.deepEqual(result.issues, []);
  assert.doesNotMatch(result.reason, /凭据正常|订阅有效|封禁/);
  assert.equal(health({ credentials_status: { has_access_token: false, has_refresh_token: true } }).state, 'healthy');
  const paused = health({ schedulable: false });
  assert.equal(paused.state, 'paused'); assert.match(paused.reason, /不代表账号失效/);
  for (const patch of [{ type: 'unknown' }, { type: 'oauth-suffix' }, { status: undefined }, { status: 'new_status' }, { schedulable: null }]) {
    assert.equal(health(patch).state, 'unknown');
  }
});

test('confirmed error, configured expiry and disabled state take priority over temporary limits', () => {
  const blocking = { expires_at: iso(-1000), rate_limit_reset_at: iso(60000), overload_until: iso(120000), schedulable: false };
  assert.equal(health({ ...blocking, status: 'error' }).state, 'error');
  assert.equal(health({ ...blocking, status: 'disabled' }).state, 'expired');
  assert.match(health(blocking).reason, /账号配置到期/);
  for (const status of ['disabled', 'inactive']) {
    const result = health({ ...blocking, expires_at: iso(180000), status });
    assert.equal(result.state, 'disabled'); assert.equal(result.recoverAt, null);
  }
});

test('future rate limits and temporary blocks expose only known deadlines and fixed issue labels', () => {
  const result = health({ rate_limit_reset_at: iso(60000), overload_until: iso(120000), temp_unschedulable_until: iso(90000) });
  assert.equal(result.state, 'limited'); assert.equal(result.recoverAt, iso(120000));
  assert.deepEqual(result.issues.map(item => item.code), ['rate_limit', 'overload', 'temporary']);
  assert.equal(health({ overload_until: iso(60000) }).state, 'temporary');
  assert.equal(health({ temp_unschedulable_until: iso(60000) }).state, 'temporary');
  assert.equal(health({ rate_limited_at: iso(-500000), rate_limit_reset_at: iso(-1000) }).state, 'healthy');
});

test('a saved blocking window can expire without falsely announcing recovery', () => {
  const original = health({ rate_limit_reset_at: iso(60000), overload_until: iso(120000) });
  const partlyEnded = sanitizeAccountHealth(original, { now: NOW + 60000 });
  assert.equal(partlyEnded.state, 'temporary'); assert.equal(partlyEnded.recoverAt, iso(120000));
  assert.equal(partlyEnded.issues[0].code, 'rate_limit_ended');
  const ended = sanitizeAccountHealth(original, { now: NOW + 120000 });
  assert.equal(ended.state, 'unknown'); assert.equal(ended.recoverAt, null); assert.match(ended.reason, /等待刷新/);
  assert.ok(ended.issues.every(item => item.code.endsWith('_ended')));
  assert.equal(sanitizeAccountHealth(ended, { now: NOW + 130000 }).state, 'unknown');
  const newlyObserved = normalizeAccountHealth(account({ rate_limit_reset_at: iso(60000), overload_until: iso(120000) }), { now: NOW + 130000 });
  assert.equal(newlyObserved.state, 'healthy'); assert.deepEqual(newlyObserved.issues, []);
});

test('configured account expiry may worsen a saved observation but unknown block times never imply recovery', () => {
  const original = health({ expires_at: iso(60000) });
  assert.equal(original.state, 'healthy');
  const expired = sanitizeAccountHealth(original, { now: NOW + 60000 });
  assert.equal(expired.state, 'expired'); assert.match(expired.reason, /配置到期/);
  const broken = sanitizeAccountHealth({ ...original, expiresAt: null, state: 'limited', issues: [{ code: 'rate_limit', until: 'invalid' }] }, { now: NOW });
  assert.equal(broken.state, 'unknown'); assert.equal(broken.recoverAt, null);
  assert.equal(broken.issues[0].code, 'rate_limit_unknown'); assert.doesNotMatch(broken.reason, /时间已结束/);
});

test('health has its own account-list freshness and no raw errors or credential presence fields escape', () => {
  const result = health({ status: 'error', error_message: '401 token sk-private-secret member@example.test https://secret.example',
    credentials: { access_token: 'private-credential' }, credentials_status: { has_access_token: true, private: 'private-marker' } });
  assert.equal(result.state, 'error'); assert.equal(result.issues[0].code, 'authentication');
  assert.match(result.reason, /鉴权或令牌/);
  assert.doesNotMatch(JSON.stringify(result), /sk-private|member@example|secret\.example|private-credential|private-marker|has_access_token|封禁/);
  assert.equal(sanitizeAccountHealth(result, { now: NOW + 20 * 60000 }).freshness, 'fresh');
  assert.equal(sanitizeAccountHealth(result, { now: NOW + 30 * 60000 + 1 }).freshness, 'stale');
  assert.equal(sanitizeAccountHealth(result, { now: NOW, stale: true }).freshness, 'stale');
  assert.equal(sanitizeAccountHealth({ ...result, observedAt: iso(61000) }, { now: NOW }).freshness, 'unknown');
  assert.equal(sanitizeAccountHealth(null, { now: NOW }).freshness, 'unknown');
  const polluted = sanitizeAccountHealth({ ...result, label: 'private-label', reason: 'private-reason', credentials: 'private',
    issues: [{ code: 'authentication', label: 'private-email', until: null, token: 'private' }, { code: 'unknown-private', label: 'private' }] }, { now: NOW });
  assert.deepEqual(polluted, result);
});

test('authentication hints require explicit credential failures rather than token usage or input limits', () => {
  for (const error_message of ['HTTP 401', 'Unauthorized', 'invalid_token', 'token_expired', 'invalid_grant', 'invalid_api_key',
    'Invalid access token', 'Your token has expired', 'Incorrect API key provided', '鉴权失败', '访问令牌已过期', '凭据错误']) {
    const result = health({ status: 'error', error_message });
    assert.equal(result.state, 'error'); assert.equal(result.issues[0].code, 'authentication', error_message);
  }
  for (const error_message of ['token limit exceeded', 'input tokens too large', 'maximum token usage reached',
    'token budget exhausted', 'token endpoint timeout', '凭据已配置，输入长度超限', '鉴权成功，但请求过大', 'HTTP 503']) {
    const result = health({ status: 'error', error_message });
    assert.equal(result.state, 'error'); assert.equal(result.issues[0].code, 'account_error', error_message);
    assert.doesNotMatch(result.reason, /鉴权|令牌|凭据|封禁/);
  }
});

test('normalized accounts and unrelated NewAPI enrichment retain independent safe health metadata', async () => {
  const [result] = normalizeAccounts([account({ last_used_at: iso(-2000), expires_at: iso(60000), rate_limit_reset_at: iso(30000),
    credentials_status: { has_access_token: true, detail: 'private-status' }, error_message: 'private-error' })], { now: NOW });
  assert.equal(result.health.state, 'limited'); assert.equal(result.health.observedAt, iso(0));
  assert.equal(result.observedAt, null, 'No quota sample was invented from the account-list time');
  assert.equal('credentials_status' in result, false); assert.equal('rate_limit_reset_at' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /private-status|private-error/);
  const source = new NewApiAccountSource({ baseUrl: 'https://api.ark717.com', queryKey: 'fixture-only-key', accountId: '99',
    fetchImpl: () => { throw new Error('No matching NewAPI account'); } });
  const [enriched] = await source.enrich([result]);
  assert.deepEqual(enriched.health, result.health);
  enriched.health.issues[0].label = 'changed'; assert.notEqual(enriched.health.issues[0].label, result.health.issues[0].label);
});
