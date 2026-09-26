import test from 'node:test';
import assert from 'node:assert/strict';
import { AllKeyUsage, AllKeyUsageError } from '../src/all-key-usage.js';

const NOW = Date.parse('2026-09-26T08:00:00Z');
const response = value => Response.json({ code: 0, data: value });
const page = (items, { total = items.length, page = 1, page_size = 100 } = {}) => ({ items, total, page, page_size, pages: Math.max(1, Math.ceil(total / page_size)) });
const key = (id, patch = {}) => ({ id, name: `Key ${id}`, key: `sk-private-secret-${id}`, status: 'active', quota: 0,
  quota_used: 12, user: { email: 'private@example.test' }, last_used_ip: '10.0.0.1', last_used_at: '2026-09-25T00:00:00Z', ...patch });
const stats = (patch = {}) => ({ total_requests: 2, total_tokens: 40, total_actual_cost: 1.5, total_cost: 99, total_account_cost: 88, ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(t, { fetch: custom, keys = [key(1), key(2)], ...config } = {}) {
  let now = NOW, clock = 0, active = 0, maximum = 0;
  const calls = [];
  const defaultResponse = (url, options) => {
    if (url.pathname === '/api/v1/admin/users') return response(page([{ id: 1, email: 'private@example.test', adminSecret: 'hidden' }]));
    if (url.pathname === '/api/v1/admin/users/1/api-keys') return response(page(keys));
    if (url.pathname === '/api/v1/admin/usage/stats') return response(stats());
    if (url.pathname === '/api/v1/admin/dashboard/api-keys-usage') return response({ stats: Object.fromEntries(JSON.parse(options.body).api_key_ids.map(id => [id,
      { api_key_id: id, today_actual_cost: 999999, total_actual_cost: 30 }])) });
    throw Error(`Unexpected route ${url.pathname}`);
  };
  const client = new AllKeyUsage({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-private-test-key', now: () => now,
    monotonicNow: () => clock, fetchImpl: async (url, options) => {
      const parsed = new URL(url); calls.push({ url: parsed, ...options }); active++; maximum = Math.max(active, maximum);
      try { return custom ? await custom(parsed, options, defaultResponse, calls.length) : defaultResponse(parsed, options); }
      finally { active--; }
    }, ...config });
  t.after(() => client.close());
  return { client, calls, maximum: () => maximum, advance(ms) { now += ms; clock += ms; }, tick(ms) { clock += ms; }, setWall(value) { now = value; } };
}

test('all keys use admin reads, Shanghai today and the correctly labelled rolling 30-day batch cost', async t => {
  const f = fixture(t, { keys: [key(1), key(2, { status: 'disabled', quota: 100, quota_used: 110 })] });
  const result = await f.client.get();
  assert.equal(result.day, '2026-09-26'); assert.equal(result.timeZone, 'Asia/Shanghai');
  assert.equal(result.scope, 'current_keys'); assert.equal(result.complete, true); assert.equal(result.loading, false);
  assert.equal(result.refreshIntervalMs, 600000); assert.equal(result.updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(result.totals, { keys: 2, activeKeys: 1, todayRequests: 4, todayTokens: 80, todayCost: 3, last30DaysCost: 60 });
  assert.deepEqual(result.rows[1].quota, { used: 110, limit: 100, remaining: 0, unlimited: false });
  assert.equal(result.rows[0].quota.unlimited, true); assert.equal(result.rows[0].keyHint, 'ID #1');
  assert.doesNotMatch(JSON.stringify(result), /private|secret|email|10\.0\.0\.1|999999|99|88/);
  assert.equal(f.calls.length, 5); assert.ok(f.maximum() <= 2);
  for (const call of f.calls) {
    assert.equal(call.redirect, 'manual'); assert.equal(call.headers['x-api-key'], 'admin-private-test-key');
    assert.equal(call.headers.authorization, undefined);
    if (call.url.pathname.endsWith('/stats')) {
      assert.equal(call.method, 'GET');
      assert.deepEqual([...call.url.searchParams.keys()].sort(), ['api_key_id', 'end_date', 'start_date', 'timezone']);
      assert.equal(call.url.searchParams.get('start_date'), '2026-09-26');
      assert.equal(call.url.searchParams.get('end_date'), '2026-09-26');
      assert.equal(call.url.searchParams.get('timezone'), 'Asia/Shanghai');
    } else if (call.method === 'POST') {
      assert.equal(call.url.pathname, '/api/v1/admin/dashboard/api-keys-usage');
      assert.deepEqual(JSON.parse(call.body), { api_key_ids: [1, 2] });
    }
  }
});

test('both user and per-user key pagination are completed, including inactive users and keys', async t => {
  const f = fixture(t, { fetch: (url, options, fallback) => {
    const current = Number(url.searchParams.get('page'));
    if (url.pathname === '/api/v1/admin/users') return response(page([{ id: current, status: 'disabled' }], { total: 2, page: current, page_size: 1 }));
    if (url.pathname === '/api/v1/admin/users/1/api-keys') return response(page([key(current)], { total: 2, page: current, page_size: 1 }));
    if (url.pathname === '/api/v1/admin/users/2/api-keys') return response(page([key(3, { status: 'expired' })]));
    return fallback(url, options);
  } });
  const result = await f.client.get();
  assert.equal(result.complete, true); assert.deepEqual(result.rows.map(row => row.id), ['1', '2', '3']);
  assert.ok(f.maximum() <= 2);
});

test('snapshot never waits for upstream; concurrent gets share one job and cache retains sample time', async t => {
  const gate = deferred();
  const f = fixture(t, { fetch: async (url, options, fallback) => { await gate.promise; return fallback(url, options); } });
  assert.equal(f.client.snapshot().totals.keys, null);
  const a = f.client.get(), b = f.client.get(); await flush();
  assert.equal(f.client.snapshot().loading, true); assert.equal(f.calls.length, 1);
  gate.resolve(); const [first, second] = await Promise.all([a, b]);
  first.rows[0].name = 'mutated'; assert.equal(second.rows[0].name, 'Key 1');
  f.advance(1000); const cached = await f.client.get();
  assert.equal(cached.updatedAt, second.updatedAt); assert.equal(cached.rows[0].name, 'Key 1'); assert.equal(f.calls.length, 5);
  f.advance(600000); assert.equal(f.client.snapshot().stale, true); assert.equal(f.client.snapshot().complete, false);
  await f.client.get(); assert.equal(f.calls.length, 10);
});

test('successful empty key inventory is zero; missing or failed inventory is unknown', async t => {
  const empty = fixture(t, { keys: [] }); const result = await empty.client.get();
  assert.equal(result.complete, true); assert.deepEqual(result.totals, { keys: 0, activeKeys: 0, todayRequests: 0, todayTokens: 0, todayCost: 0, last30DaysCost: 0 });
  assert.equal(empty.calls.length, 2);
  const failed = fixture(t, { fetch: () => new Response('', { status: 500 }) }); const unknown = await failed.client.get();
  assert.equal(unknown.complete, false); assert.equal(unknown.totals.keys, null); assert.equal(unknown.totals.todayCost, null);
});

test('failed refresh preserves sanitized old rows with stale state and cannot claim a complete current list', async t => {
  let fail = false;
  const f = fixture(t, { fetch: (url, options, fallback) => fail ? new Response('private-secret', { status: 403 }) : fallback(url, options) });
  const original = await f.client.get(); fail = true; f.advance(600000);
  const failed = await f.client.get();
  assert.equal(failed.stale, true); assert.equal(failed.complete, false); assert.equal(failed.updatedAt, original.updatedAt);
  assert.equal(failed.rows[0].today.cost, 1.5); assert.equal(failed.totals.keys, null); assert.equal(failed.totals.todayCost, null);
  assert.match(failed.error, /权限/); assert.doesNotMatch(JSON.stringify(failed), /secret|private/);
  const attempted = f.calls.length; await Promise.all(Array.from({ length: 20 }, () => f.client.get())); assert.equal(f.calls.length, attempted);
});

test('failed or missing per-key usage is null, not zero, and only a genuine zero enters sums', async t => {
  const f = fixture(t, { fetch: (url, options, fallback) => {
    if (url.pathname.endsWith('/stats')) return response(stats(url.searchParams.get('api_key_id') === '1'
      ? { total_requests: 0, total_tokens: 0, total_actual_cost: 0 } : { total_actual_cost: null }));
    return fallback(url, options);
  } });
  const result = await f.client.get();
  assert.equal(result.totals.keys, 2); assert.equal(result.rows[0].today.cost, 0); assert.equal(result.rows[1].today.cost, null);
  assert.equal(result.totals.todayCost, null); assert.equal(result.complete, false);
});

test('malformed batch data cannot silently turn a missing key into zero', async t => {
  for (const bad of [{ stats: {} }, { stats: { 1: { api_key_id: 1, total_actual_cost: 10 } } },
    { stats: { 1: { api_key_id: 2, total_actual_cost: 10 }, 2: { api_key_id: 2, total_actual_cost: 20 } } }]) {
    const f = fixture(t, { fetch: (url, options, fallback) => options.method === 'POST' ? response(bad) : fallback(url, options) });
    const result = await f.client.get();
    assert.equal(result.complete, false); assert.equal(result.totals.last30DaysCost, null); assert.equal(result.rows[0].last30DaysCost, null);
    assert.equal(result.totals.todayCost, 3);
  }
});

test('paging truncation, duplicate IDs and changing totals cannot be presented as all keys', async t => {
  const cases = [page([{ id: 1 }], { total: 3 }), page([{ id: 1 }, { id: 1 }]),
    { ...page([{ id: 1 }]), page: 2 }, { ...page([{ id: 1 }]), total: '1' }, page([{ id: Number.MAX_SAFE_INTEGER + 1 }])];
  for (const payload of cases) {
    const f = fixture(t, { fetch: () => response(payload) }); const result = await f.client.get();
    assert.equal(result.complete, false); assert.equal(result.totals.keys, null); assert.equal(result.rows.length, 0);
  }
  const changed = fixture(t, { fetch: url => response(page([{ id: Number(url.searchParams.get('page')) }],
    { total: Number(url.searchParams.get('page')) === 1 ? 3 : 2, page: Number(url.searchParams.get('page')), page_size: 1 })) });
  assert.equal((await changed.client.get()).totals.keys, null);
});

test('enumeration and cost chunks are bounded without truncating a successful result', async t => {
  const many = Array.from({ length: 101 }, (_, index) => key(index + 1));
  const f = fixture(t, { fetch: (url, options, fallback) => {
    if (url.pathname.endsWith('/1/api-keys')) {
      const current = Number(url.searchParams.get('page'));
      return response(page(many.slice((current - 1) * 100, current * 100), { total: 101, page: current }));
    }
    return fallback(url, options);
  } });
  const result = await f.client.get(); assert.equal(result.totals.keys, 101); assert.equal(result.complete, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).api_key_ids.length), [100, 1]);
  assert.ok(f.maximum() <= 2);
  const maxUsers = fixture(t, { maxUsers: 1, fetch: () => response(page([{ id: 1 }, { id: 2 }])) });
  assert.match((await maxUsers.client.get()).error, /上限/); assert.equal(maxUsers.calls.length, 1);
  const maxKeys = fixture(t, { maxKeys: 1 }); assert.match((await maxKeys.client.get()).error, /上限/);
});

test('old today values disappear at Shanghai midnight even without another request or successful refresh', async t => {
  let fail = false;
  const f = fixture(t, { fetch: (url, options, fallback) => fail ? new Response('', { status: 500 }) : fallback(url, options) });
  await f.client.get(); f.setWall(Date.parse('2026-09-26T16:00:00Z'));
  const snapshot = f.client.snapshot();
  assert.equal(snapshot.day, '2026-09-27'); assert.equal(snapshot.rows[0].today.cost, null);
  assert.equal(snapshot.totals.todayCost, null); assert.equal(snapshot.rows[0].last30DaysCost, 30); assert.match(snapshot.error, /日期/);
  fail = true; const failed = await f.client.get(); assert.equal(failed.rows[0].today.requests, null); assert.equal(failed.complete, false);
});

test('crossing midnight mid-query cannot label yesterday values as today', async t => {
  let f;
  f = fixture(t, { fetch: (url, options, fallback) => {
    if (options.method === 'POST') f.setWall(Date.parse('2026-09-26T16:00:00Z'));
    return fallback(url, options);
  } });
  const result = await f.client.get(); assert.equal(result.day, '2026-09-27');
  assert.equal(result.rows[0].today.cost, null); assert.equal(result.totals.todayRequests, null); assert.equal(result.complete, false);
});

test('timeouts bound ignored aborts and hanging response bodies; late success cannot overwrite the cache', async t => {
  const late = deferred(); const f = fixture(t, { timeoutMs: 15, fetch: () => late.promise });
  const result = await f.client.get(); assert.match(result.error, /超时/); assert.equal(result.totals.keys, null);
  late.resolve(response(page([{ id: 1 }]))); await flush();
  assert.equal((await f.client.get()).totals.keys, null); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
  let canceled = 0;
  const body = fixture(t, { timeoutMs: 15, fetch: () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled++; } })) });
  assert.equal((await body.client.get()).complete, false); assert.ok(canceled > 0);
});

test('global budget stops dispatching queued work and close aborts the current job', async t => {
  let f;
  f = fixture(t, { batchTimeoutMs: 20, fetch: (url, options, fallback) => { f.tick(21); return fallback(url, options); } });
  const result = await f.client.get(); assert.match(result.error, /时限/); assert.equal(f.calls.length, 1);
  const gate = deferred(), closed = fixture(t, { fetch: () => gate.promise });
  const pending = closed.client.get(); await flush(); const rejected = assert.rejects(pending, error => error instanceof AllKeyUsageError && error.code === 'CLOSED');
  await closed.client.close(); await rejected; assert.equal(closed.calls[0].signal.aborted, true);
  await assert.rejects(closed.client.get(), error => error.code === 'CLOSED'); gate.resolve(response(page([])));
});

test('redirects, oversized bodies, malformed envelopes and unsafe numbers are rejected without exposing upstream data', async t => {
  for (const make of [() => new Response('private', { status: 302 }), () => new Response('secret'),
    () => Response.json({ code: 0, data: [] }), () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), () => response(page([{ id: '1' }]))]) {
    const f = fixture(t, { fetch: make }); const result = await f.client.get();
    assert.equal(result.complete, false); assert.equal(result.totals.keys, null); assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  }
});

test('public display retains no key material or owner email even when pasted into a key name', async t => {
  const f = fixture(t, { keys: [key(1, { name: 'prefixsk-private-secret-1 sk-secret_123456789 owner@example.test admin-secret12345678\nlabel' })] });
  const result = await f.client.get(); const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|owner@example|private/); assert.match(result.rows[0].name, /label/);
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['checkedAt', 'id', 'keyHint', 'last30DaysCost', 'lastUsedAt', 'name', 'quota', 'stale', 'status', 'today'].sort());
});

test('backward wall clock movement cannot extend cache TTL', async t => {
  const f = fixture(t); await f.client.get(); f.tick(600001); f.setWall(NOW - 3600000);
  assert.equal(f.client.snapshot().stale, true); await f.client.get(); assert.equal(f.calls.length, 10);
});

test('partial usage refresh keeps the oldest retained sample time and recovers on the next successful cycle', async t => {
  let failBatch = false;
  const f = fixture(t, { fetch: (url, options, fallback) => options.method === 'POST' && failBatch ? new Response('', { status: 500 }) : fallback(url, options) });
  const first = await f.client.get(); f.advance(600000); failBatch = true;
  const partial = await f.client.get();
  assert.equal(partial.updatedAt, first.updatedAt); assert.equal(partial.rows[0].checkedAt, first.rows[0].checkedAt);
  assert.equal(partial.rows[0].last30DaysCost, 30); assert.equal(partial.stale, true); assert.equal(partial.complete, false);
  f.advance(600000); failBatch = false; const recovered = await f.client.get();
  assert.equal(recovered.complete, true); assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
  assert.notEqual(recovered.updatedAt, first.updatedAt);
});

test('a newly complete inventory removes deleted keys and adds new keys without retaining deleted usage', async t => {
  let changed = false;
  const f = fixture(t, { fetch: (url, options, fallback) => changed && url.pathname.endsWith('/1/api-keys') ? response(page([key(3)])) : fallback(url, options) });
  await f.client.get(); f.advance(600000); changed = true;
  const result = await f.client.get(); assert.equal(result.totals.keys, 1); assert.deepEqual(result.rows.map(row => row.id), ['3']);
  assert.equal(result.totals.todayCost, 1.5); assert.equal(result.complete, true);
});
