import test from 'node:test';
import assert from 'node:assert/strict';
import { NewApiAccountSource, normalizeNewApi } from '../src/newapi.js';
import { normalizeAccounts } from '../src/sub2api.js';

const NOW = Date.parse('2026-09-19T14:00:00Z');
const SECRET = 'fixture-personal-query-token+/=';
const envelope = data => ({ success: true, data });
const fixture = (overrides = {}) => ({
  self: envelope({ quota: 5000035198613, used_quota: 842903443, request_count: 18950,
    username: 'private-name', email: 'private@example.invalid', access_token: SECRET }),
  status: envelope({ quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 5, price: 5 }),
  subscriptions: envelope({ subscriptions: [], all_subscriptions: [{ subscription: { amount_total: 750000000, amount_used: 303032614, end_time: 1784823826, status: 'expired' } }] }),
  grants: envelope({ summary: null, items: [] }),
  globalQuota: envelope({ enabled: true, exempt: true, paid_balance: 0, daily_limit: 2500000000, daily_remaining: 2400000000,
    windows: [{ is_current: true, limit: 500000000, consumed: 1000000, remaining: 499000000 }] }),
  ...overrides,
});
const paths = { '/api/status': 'status', '/api/user/self': 'self', '/api/subscription/self': 'subscriptions', '/api/user/quota_grants': 'grants', '/api/global-quota/self': 'globalQuota' };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const accounts = () => normalizeAccounts([
  { id: 6270, name: '小鸡毛', platform: 'openai', type: 'apikey', status: 'active', schedulable: false },
  { id: 6273, name: '另一上游', platform: 'openai', type: 'apikey', status: 'active', schedulable: true },
  { id: 6269, name: 'OAuth', platform: 'openai', type: 'oauth', status: 'error', schedulable: true },
], { now: NOW });
const source = (fetchImpl, options = {}) => new NewApiAccountSource({ baseUrl: 'https://api.ark717.com/', queryKey: SECRET, accountId: 6270, fetchImpl, now: () => NOW, ...options });
const fetchFixture = (payload = fixture()) => async url => json(payload[paths[new URL(url).pathname]]);

test('verified wallet conversion uses quota_per_unit, not recharge price or exchange rate; output is whitelisted', () => {
  const result = normalizeNewApi(fixture(), { now: NOW });
  assert.equal(result.metrics[0].value, 10000070.397226);
  assert.equal(result.metrics[1].used, 1685.806886);
  assert.equal(result.metrics[2].used, 18950);
  assert.equal(result.metrics[0].unit, 'USD');
  assert.ok(result.metrics.every(metric => metric.source === 'newapi-ark717' && metric.scope === 'upstream'));
  assert.equal(result.freshness, 'fresh');
  const printed = JSON.stringify(result);
  for (const privateText of [SECRET, 'private-name', 'private@example.invalid', 'access_token', 'all_subscriptions', 'paid_balance']) assert.ok(!printed.includes(privateText));
  assert.ok(result.notes.some(note => note.includes('所有令牌共享')));
  assert.ok(result.notes.some(note => note.includes('不等同于本站 A/U')));
});

test('observed zero is valid but missing, negative, nonnumeric and infinite quota are unknown', () => {
  for (const quota of [0, '0']) assert.equal(normalizeNewApi(fixture({ self: envelope({ quota }) }), { now: NOW }).metrics[0].value, 0);
  for (const quota of [undefined, null, '', ' ', -1, '-5', NaN, Infinity, {}, 'abc', true]) {
    const result = normalizeNewApi(fixture({ self: envelope({ quota }) }), { now: NOW });
    assert.equal(result.metrics[0].value, null, `quota=${String(quota)}`);
    assert.equal(result.metrics[0].freshness, 'unknown');
  }
  for (const status of [{ quota_per_unit: 0, quota_display_type: 'USD' }, { quota_per_unit: 500000, quota_display_type: 'CNY' }, {}]) {
    assert.equal(normalizeNewApi(fixture({ status: envelope(status) }), { now: NOW }).metrics[0].value, null);
  }
});

test('expired subscription history and an exempt global pool do not inflate personal quota', () => {
  const result = normalizeNewApi(fixture(), { now: NOW });
  assert.equal(result.metrics.length, 3);
  assert.ok(result.notes.some(note => note.includes('获豁免')));
  assert.ok(result.notes.some(note => note.includes('当前没有独立额度包')));
  assert.ok(result.notes.some(note => note.includes('历史或已过期订阅未计入')));
});

test('active subscription, no-card quota grant and nonexempt pool stay independent from the wallet', () => {
  const future = (NOW + 86400000) / 1000;
  const result = normalizeNewApi(fixture({
    subscriptions: envelope({ subscriptions: [
      { subscription: { amount_total: 10000000, amount_used: 2500000, end_time: future, next_reset_time: future - 100, status: 'active' } },
      { subscription: { amount_total: 10000000, amount_used: 1, end_time: future, status: 'expired' } },
      { subscription: { amount_total: 10000000, amount_used: 1, end_time: NOW / 1000 - 1, status: 'active' } },
      { subscription: { amount_total: 10000000, amount_used: 1, status: 'active' } },
    ] }),
    grants: envelope({ items: [
      { amount: 2000000, remaining: 1500000, expires_at: future, source_type: 'no_card', secret: SECRET },
      { amount: 2000000, remaining: 2000000, expires_at: NOW / 1000 - 1 },
      { amount: 2000000, remaining: 2000000, expires_at: future, status: 'revoked' },
    ] }),
    globalQuota: envelope({ enabled: true, exempt: false, daily_limit: 5000000, daily_remaining: 4500000,
      windows: [{ is_current: false, limit: 90000000, remaining: 90000000 }, { is_current: true, limit: 2500000, consumed: 500000, remaining: 2000000 }] }),
  }), { now: NOW });
  assert.equal(result.metrics[0].value, 10000070.397226);
  const sub = result.metrics.filter(metric => metric.key.startsWith('newapi-subscription'));
  assert.equal(sub.length, 1); assert.equal(sub[0].remaining, 15);
  const grants = result.metrics.filter(metric => metric.key.startsWith('newapi-grant'));
  assert.equal(grants.length, 1); assert.equal(grants[0].remaining, 3);
  const pool = result.metrics.filter(metric => metric.key.startsWith('newapi-global'));
  assert.equal(pool.length, 2); assert.ok(pool.every(metric => metric.label.includes('非个人')));
  assert.equal(pool[1].remaining, 4);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('only the explicitly bound OpenAI API account is enriched; local stats and schedulability stay unchanged', async () => {
  const original = accounts();
  original.forEach(account => { account.planLabel = 'API 计费'; account.planSource = 'type'; });
  const saved = structuredClone(original);
  original[0].credentials = { api_key: 'must-never-copy' };
  const result = await source(fetchFixture()).enrich(original);
  assert.deepEqual(result[1], saved[1]); assert.deepEqual(result[2], saved[2]);
  assert.deepEqual(result[0].windowStats, saved[0].windowStats);
  assert.equal(result[0].schedulable, false);
  assert.equal(result[0].planLabel, 'API 计费'); assert.equal(result[0].planSource, 'type');
  assert.ok(!Object.hasOwn(result[0], 'credentials'));
  assert.ok(!result[0].notes.some(note => note.includes('暂无可用的上游额度缓存')));
  assert.equal(original[0].metrics.length, 0);
  assert.equal(result[0].metrics.length, 3);
  let calls = 0;
  const noop = source(async () => { calls++; return json(fixture().self); });
  await noop.enrich(saved.filter(account => account.id !== '6270'));
  await noop.enrich([{ ...saved[0], type: 'oauth' }]);
  await noop.enrich([{ ...saved[0], platform: 'anthropic' }]);
  assert.equal(calls, 0);
});

test('only the five verified GET paths are called; status is anonymous, token never reaches model endpoints', async () => {
  const calls = [];
  await source(async (url, options) => {
    calls.push({ url, options });
    return json(fixture()[paths[new URL(url).pathname]]);
  }).enrich(accounts());
  assert.equal(calls.length, 5);
  for (const { url, options } of calls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.ark717.com');
    assert.ok(Object.hasOwn(paths, parsed.pathname));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, parsed.pathname === '/api/status' ? undefined : `Bearer ${SECRET}`);
    assert.equal(options.headers['x-api-key'], undefined);
    assert.equal(options.headers['New-Api-User'], undefined);
    assert.match(options.headers['user-agent'], /^Mozilla\/5\.0/);
  }
});

test('unverified origins, path/query credentials and missing explicit account binding are rejected', () => {
  for (const baseUrl of ['http://api.ark717.com', 'https://api.ark717.com.evil.invalid/', 'https://other.invalid', 'https://api.ark717.com:444', 'https://user:pass@api.ark717.com/', 'https://api.ark717.com/api/', 'https://api.ark717.com/?key=abc']) {
    assert.throws(() => source(fetchFixture(), { baseUrl }), error => error.code === 'CONFIG');
  }
  for (const accountId of [undefined, '', '6270/a', 0]) assert.throws(() => source(fetchFixture(), { accountId }), error => error.code === 'CONFIG');
});

test('concurrent refreshes share requests and successful values are cached five minutes', async () => {
  let time = NOW, count = 0;
  const adapter = source(async url => { count++; return json(fixture()[paths[new URL(url).pathname]]); }, { now: () => time });
  await Promise.all([adapter.enrich(accounts()), adapter.enrich(accounts()), adapter.enrich(accounts())]);
  assert.equal(count, 5);
  time += 299999; await adapter.enrich(accounts()); assert.equal(count, 5);
  time++; await adapter.enrich(accounts()); assert.equal(count, 10);
});

test('failure retains last successful value with original observation time and retries within sixty seconds', async () => {
  let time = NOW, failed = false, count = 0;
  const adapter = source(async url => {
    count++;
    if (failed) throw new Error(`server error ${SECRET} private@example.invalid`);
    return json(fixture()[paths[new URL(url).pathname]]);
  }, { now: () => time });
  const first = await adapter.enrich(accounts());
  time += 300000; failed = true;
  const result = await adapter.enrich(accounts());
  assert.equal(result[0].metrics[0].value, first[0].metrics[0].value);
  assert.equal(result[0].observedAt, first[0].observedAt);
  assert.equal(result[0].freshness, 'stale');
  assert.ok(result[0].metrics.every(metric => metric.freshness === 'stale'));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
  assert.equal(count, 10);
  time += 59999; await adapter.enrich(accounts()); assert.equal(count, 10);
  time++; failed = false;
  assert.equal((await adapter.enrich(accounts()))[0].freshness, 'fresh'); assert.equal(count, 15);
});

test('redirect, unauthorized, invalid JSON, oversize and malformed amount fail closed without raw error disclosure', async () => {
  const failures = [
    () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } }),
    () => new Response(SECRET, { status: 401 }),
    () => new Response(SECRET),
    () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => json({ success: false, message: SECRET }),
    () => json(envelope({ quota: -1 })),
  ];
  for (const failure of failures) {
    const result = await source(async url => new URL(url).pathname === '/api/user/self' ? failure() : json(fixture()[paths[new URL(url).pathname]])).enrich(accounts());
    assert.equal(result[0].metrics[0].value, null);
    assert.equal(result[0].metrics[0].observedAt, null);
    assert.equal(result[0].freshness, 'unknown');
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.deepEqual(result[1], accounts()[1]);
  }
});

test('optional entitlement failures do not invalidate a successfully read wallet', async () => {
  const adapter = source(async url => {
    const path = new URL(url).pathname;
    if (!['/api/status', '/api/user/self'].includes(path)) throw new Error(SECRET);
    return json(fixture()[paths[path]]);
  });
  const [result] = await adapter.enrich(accounts());
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.metrics[0].value, 10000070.397226);
  assert.ok(result.notes.some(note => note.includes('部分订阅')));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('startup seeds only safe prior metrics and marks them stale if the mandatory live refresh fails', async () => {
  const first = await source(fetchFixture()).enrich(accounts());
  first[0].metrics[0].label = SECRET;
  first[0].metrics[0].note = 'private@example.invalid';
  first[0].metrics[0].raw = { token: SECRET };
  first[0].notes.push(SECRET);
  first[0].metrics.push({ key: 'newapi-unverified', source: 'newapi-ark717', value: 99999, observedAt: new Date(NOW).toISOString() });
  let count = 0;
  const adapter = source(async () => { count++; throw new Error(SECRET); });
  adapter.seed(first);
  const result = await adapter.enrich(accounts());
  assert.equal(count, 5, 'seeding must not suppress the first live refresh');
  assert.equal(result[0].metrics.length, 3);
  assert.equal(result[0].metrics[0].value, 10000070.397226);
  assert.equal(result[0].observedAt, new Date(NOW).toISOString());
  assert.equal(result[0].freshness, 'stale');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
  const wrong = source(async () => { throw new Error('unavailable'); });
  wrong.seed(first.map(account => ({ ...account, id: '9999' })));
  assert.equal((await wrong.enrich(accounts()))[0].metrics[0].value, null);
});

test('timed-out requests are aborted and return unknown without exposing transport errors', async () => {
  const guard = setInterval(() => {}, 1000);
  try {
    const signals = [];
    const adapter = source(async (_url, { signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(SECRET)), { once: true }));
    }, { timeoutMs: 10 });
    const [result] = await adapter.enrich(accounts());
    assert.equal(signals.length, 5);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(result.metrics[0].value, null);
    assert.ok(result.notes.some(note => note.includes('超时')));
    assert.ok(!JSON.stringify(result).includes(SECRET));
  } finally { clearInterval(guard); }
});
