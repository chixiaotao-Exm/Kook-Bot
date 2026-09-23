import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyUsageClient, KeyUsageError, validateUsageKey } from '../src/key-usage.js';

const KEY = 'sk-test_secret_only_in_fixture_1234';
const NOW = Date.parse('2026-09-20T03:00:00Z');
const day = (date, requests = 2) => ({ date, requests, total_tokens: 150, input_tokens: 50, output_tokens: 20,
  cache_read_tokens: 60, cache_write_tokens: 20, actual_cost: .25, cost: .5 });
const raw = () => ({ mode: 'quota_limited', isValid: true, status: 'active', quota: { used: 12, limit: 50, remaining: 38, unit: 'USD' },
  usage: { total: { requests: 22, total_tokens: 2200, input_tokens: 600, output_tokens: 400, cache_read_tokens: 1000, cache_creation_tokens: 200, actual_cost: 12, cost: 20 },
    today: { requests: 999 } },
  daily_usage: [day('2026-09-19'), day('2026-09-20', 3)],
  rate_limits: [{ window: '5h', used: 1, limit: 4, remaining: 3, reset_at: '2026-09-20T08:00:00Z' }],
  expires_at: '2027-01-01T00:00:00Z', key: KEY, name: KEY, user: { keys: [KEY] }, model_stats: [{ model: KEY }] });
const response = (body = raw(), status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const make = (fetchImpl, options = {}) => new KeyUsageClient({ fetchImpl, now: () => NOW, ...options });

test('uses only authenticated native key usage GET and returns a numeric whitelist', async () => {
  const calls = [];
  const result = await make(async (url, options) => {
    calls.push({ url, options });
    const source = raw();
    if (new URL(url).searchParams.get('days') === '1') source.daily_usage = [day('2026-09-20', 3)];
    return response(source);
  }).query(KEY);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), [1, 7].map(days => `http://127.0.0.1:8080/v1/usage?days=${days}&timezone=Asia%2FShanghai`));
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
    assert.deepEqual(call.options.headers, { accept: 'application/json', authorization: `Bearer ${KEY}` });
  }
  assert.equal(result.keyHint, 'sk-…1234');
  assert.equal(result.totals.requests, 22);
  assert.equal(result.totals.cost, 12);
  assert.equal(result.totals.standardCost, 20);
  assert.equal(result.periods[0].requests, 3);
  assert.equal(result.periods[1].requests, 5);
  assert.equal(result.periods[1].cacheCreationTokens, 40);
  assert.equal(result.quota.scope, 'key');
  assert.equal(result.limits[0].resetAt, '2026-09-20T08:00:00.000Z');
  assert.equal(result.timeZone, 'Asia/Shanghai');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  for (const field of ['key', 'name', 'user', 'model_stats']) assert.equal(Object.hasOwn(result, field), false);
});

test('account balances and subscription balances are marked shared, not key quota', async () => {
  const wallet = await make(async () => response({ mode: 'unrestricted', isValid: true, balance: 21, remaining: 21, planName: KEY })).query(KEY);
  assert.equal(wallet.quota.scope, 'account'); assert.equal(wallet.quota.remaining, 21);
  assert.equal(wallet.quota.limit, null); assert.equal(wallet.status, 'unknown');
  assert.match(wallet.notice, /共享/);
  const subscription = await make(async () => response({ mode: 'unrestricted', isValid: true, subscription: {}, remaining: -1 })).query(KEY);
  assert.equal(subscription.quota.scope, 'subscription'); assert.equal(subscription.quota.unlimited, true);
  assert.equal(subscription.quota.remaining, null);
});

test('unknown metrics stay null; empty successful daily stats are zero', async () => {
  let source = { mode: 'quota_limited', status: 'expired' };
  const client = make(async () => response(source), { cacheMs: 0 });
  let result = await client.query(KEY);
  assert.equal(result.totals.requests, null); assert.equal(result.periods[0].requests, null);
  assert.equal(result.quota.used, null); assert.equal(result.status, 'expired');
  source.daily_usage = [];
  result = await client.query(KEY);
  assert.equal(result.periods[0].requests, 0); assert.equal(result.periods[1].cost, 0);
  source.daily_usage = [day('2026-09-20'), { date: '2026-09-19', requests: 1 }];
  result = await client.query(KEY);
  assert.equal(result.periods[1].requests, 3); assert.equal(result.periods[1].tokens, null);
  for (const rows of [[day('2026-09-20'), day('2026-09-20')], [day(KEY)], [day('2026-02-30')], [day('2026-99-99')]]) {
    source.daily_usage = rows;
    result = await client.query(KEY);
    assert.equal(result.periods[1].requests, null);
  }
});

test('today sums the requested Shanghai window even when SQL labels it yesterday', async () => {
  // Production regression: Beijing Sept 23 09:03, daily SQL labels Sept 22.
  const now = Date.parse('2026-09-23T01:03:00Z');
  const result = await make(async url => {
    const source = raw();
    source.usage.today = { requests: 999, actual_cost: 888 };
    source.daily_usage = new URL(url).searchParams.get('days') === '1'
      ? [{ ...day('2026-09-22', 701), total_tokens: 43729364, actual_cost: 127.067322 }]
      : [{ ...day('2026-09-16', 10821), actual_cost: 1036.76360976 },
        { ...day('2026-09-22', 701), total_tokens: 43729364, actual_cost: 127.067322 }];
    return response(source);
  }, { now: () => now }).query(KEY);
  assert.equal(result.periods[0].requests, 701);
  assert.equal(result.periods[0].tokens, 43729364);
  assert.equal(result.periods[0].cost, 127.067322);
  assert.equal(result.periods[1].requests, 11522);
  assert.ok(Math.abs(result.periods[1].cost - 1163.83093176) < 1e-8);
});

test('includes partial UTC buckets at both boundaries of each Shanghai window', async () => {
  const result = await make(async url => {
    const source = raw();
    source.daily_usage = new URL(url).searchParams.get('days') === '1'
      ? [day('2026-09-19', 3), day('2026-09-20', 8)]
      : Array.from({ length: 8 }, (_, index) => day(`2026-09-${13 + index}`, index + 1));
    return response(source);
  }).query(KEY);
  assert.equal(result.periods[0].requests, 11);
  assert.equal(result.periods[1].requests, 36);
});

test('failed or missing period stays unknown without discarding available key statistics or caching failure', async () => {
  let calls = 0;
  const client = make(async url => {
    calls++;
    if (new URL(url).searchParams.get('days') === '1') throw new Error(KEY);
    return response();
  });
  const first = await client.query(KEY);
  assert.equal(first.periods[0].requests, null);
  assert.equal(first.periods[1].requests, 5);
  assert.equal(first.totals.requests, 22);
  assert.match(first.notice, /暂不可读/);
  assert.equal(JSON.stringify(first).includes(KEY), false);
  await client.query(KEY);
  assert.equal(calls, 4);

  const inverse = await make(async url => {
    if (new URL(url).searchParams.get('days') === '7') return response({}, 500);
    return response({ ...raw(), daily_usage: [] });
  }).query(KEY);
  assert.equal(inverse.periods[0].requests, 0);
  assert.equal(inverse.periods[1].requests, null);

  await assert.rejects(make(async url => new URL(url).searchParams.get('days') === '1'
    ? response({}, 401) : response()).query(KEY), error => error.code === 'AUTH');
});

test('requeries both periods once when the first pair crosses Shanghai midnight', async () => {
  const midnight = Date.parse('2026-09-20T16:00:00Z');
  let now = midnight - 10, calls = 0;
  const client = make(async () => {
    const call = ++calls;
    if (call === 2) now = midnight + 1;
    return response({ ...raw(), daily_usage: [day(call <= 2 ? '2026-09-20' : '2026-09-21', call <= 2 ? 99 : 3)] });
  }, { now: () => now });
  const result = await client.query(KEY);
  assert.equal(calls, 4);
  assert.equal(result.periods[0].requests, 3);
  assert.equal(result.periods[1].requests, 3);
  assert.equal(result.queriedAt, new Date(now).toISOString());
});

test('midnight retries are bounded and cannot cache an inconsistent pair', async () => {
  let now = NOW, calls = 0;
  const client = make(async () => {
    if (++calls % 2 === 0) now += 86400000;
    return response();
  }, { now: () => now });
  await assert.rejects(client.query(KEY), error => error.code === 'DATE_CHANGED');
  assert.equal(calls, 4);
  await assert.rejects(client.query(KEY), error => error.code === 'DATE_CHANGED');
  assert.equal(calls, 8);
});

test('cache expires at Shanghai midnight even if its TTL has not elapsed', async () => {
  const midnight = Date.parse('2026-09-20T16:00:00Z');
  let now = midnight - 5, calls = 0;
  const client = make(async () => {
    calls++;
    return response({ ...raw(), daily_usage: [day('2026-09-20', now < midnight ? 99 : 2)] });
  }, { now: () => now, cacheMs: 30000 });
  assert.equal((await client.query(KEY)).periods[0].requests, 99);
  now = midnight - 1;
  assert.equal((await client.query(KEY)).periods[0].requests, 99);
  assert.equal(calls, 2);
  now = midnight;
  assert.equal((await client.query(KEY)).periods[0].requests, 2);
  assert.equal(calls, 4);
});

test('midnight retry shares the original timeout budget and aborts both new requests', async () => {
  let now = NOW, calls = 0;
  const signals = [];
  const client = make(async (url, options) => {
    signals.push(options.signal);
    const call = ++calls;
    if (call > 2) return new Promise(() => {});
    if (call === 2) now += 86400000;
    return response();
  }, { now: () => now, timeoutMs: 15 });
  await assert.rejects(client.query(KEY), error => error.code === 'TIMEOUT');
  assert.equal(calls, 4);
  assert.equal(new Set(signals).size, 1);
  assert.ok(signals.every(signal => signal.aborted));
});

test('rejects malformed keys and nonlocal service addresses before any request', async () => {
  let calls = 0;
  const client = make(async () => { calls++; return response(); });
  for (const key of ['', null, undefined, 'sk-short', 'other-test-secret-key', `${KEY}\r\nx-api-key:admin`, ` ${KEY}`, `${KEY} `, 'sk-' + 'a'.repeat(254), `sk-test_${'界'.repeat(20)}`]) {
    await assert.rejects(client.query(key), error => error instanceof KeyUsageError && error.status === 400);
  }
  assert.equal(calls, 0);
  assert.equal(validateUsageKey('sk-' + 'x'.repeat(13)), 'sk-' + 'x'.repeat(13));
  for (const baseUrl of ['https://attacker.test', 'http://127.0.0.1:9999', 'http://127.0.0.1:8080/evil', 'http://user:secret@localhost:8080', 'http://localhost:8080?key=secret']) {
    assert.throws(() => new KeyUsageClient({ baseUrl }), error => error.code === 'CONFIG');
  }
});

test('HTTP errors, redirects, invalid JSON and upstream messages never echo secrets', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'BUSY'], [500, 'UPSTREAM'], [302, 'REDIRECT']]) {
    await assert.rejects(make(async () => response({ error: KEY }, status)).query(KEY), error => error.code === code && !error.message.includes(KEY));
  }
  for (const value of [KEY, '[]', JSON.stringify({ error: { message: KEY } })]) {
    await assert.rejects(make(async () => response(value)).query(KEY), error => error.code === 'FORMAT' && !error.message.includes(KEY));
  }
  await assert.rejects(make(async () => { throw new Error(KEY); }).query(KEY), error => error.code === 'NETWORK' && !error.message.includes(KEY));
});

test('bounded content and streamed body reject oversized responses', async () => {
  await assert.rejects(make(async () => response({}, 200, { 'content-length': '262145' })).query(KEY), error => error.code === 'FORMAT');
  await assert.rejects(make(async () => response('x'.repeat(262145))).query(KEY), error => error.code === 'FORMAT');
});

test('timeouts abort transport, hide errors and release concurrency', async () => {
  let signal, calls = 0;
  const client = make(async (url, options) => {
    signal = options.signal;
    if (++calls === 1) return new Promise(() => {});
    return response();
  }, { timeoutMs: 15, maxConcurrent: 1 });
  await assert.rejects(client.query(KEY), error => error.code === 'TIMEOUT' && error.status === 504);
  assert.equal(signal.aborted, true);
  assert.equal((await client.query(KEY)).totals.requests, 22);
});

test('single-flight, concurrency cap, bounded LRU and cache expiration', async () => {
  let release;
  let calls = 0, now = NOW;
  let held = new Promise(resolve => { release = resolve; });
  const client = make(async () => { calls++; await held; return response(); }, { now: () => now, maxConcurrent: 2, cacheSize: 2 });
  const first = client.query(KEY), duplicate = client.query(KEY), second = client.query(`${KEY}A`);
  await assert.rejects(client.query(`${KEY}B`), error => error.status === 429);
  assert.equal(calls, 4);
  release();
  const [a, b] = await Promise.all([first, duplicate, second]);
  a.totals.requests = 999;
  assert.equal(b.totals.requests, 22);
  assert.equal((await client.query(KEY)).totals.requests, 22);
  assert.equal(calls, 4);
  await client.query(`${KEY}B`); // evicts A; KEY was most recently read
  await client.query(`${KEY}A`);
  assert.equal(calls, 8);
  now += 31000;
  await client.query(`${KEY}A`);
  assert.equal(calls, 10);
});
