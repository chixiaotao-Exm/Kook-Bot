import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageTrends, UsageTrendsError } from '../src/usage-trends.js';

const NOW = Date.parse('2026-03-01T04:00:00Z');
const stats = (patch = {}) => ({ total_requests: 2, total_tokens: 30, total_account_cost: 1.25, total_actual_cost: 2.5,
  total_cost: 99999, endpoints: [{ user: 'private@example.test', token: 'private-token' }], ...patch });
const response = value => Response.json({ code: 0, data: value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function fixture(t, { fetch, ids = ['1', '2', '3', '4'], startNow = NOW, ...config } = {}) {
  let wall = startNow, clock = 0, visible = ids, active = 0, maximum = 0;
  const calls = [];
  const client = new UsageTrends({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-private-fixture',
    getAccountIds: () => visible, now: () => wall, monotonicNow: () => clock,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), ...options }); active++; maximum = Math.max(maximum, active);
      try { return fetch ? await fetch(new URL(url), options, calls.length) : response(stats()); }
      finally { active--; }
    }, ...config });
  t.after(() => client.close());
  return { client, calls, maximum: () => maximum, setIds(value) { visible = value; },
    advance(ms) { wall += ms; clock += ms; }, tick(ms) { clock += ms; }, setWall(value) { wall = value; } };
}

test('each day uses the fixed read-only Shanghai window and the top-level account/user cost meanings', async t => {
  const f = fixture(t); const result = await f.client.get();
  assert.equal(result.startDate, '2026-02-23'); assert.equal(result.endDate, '2026-03-01');
  assert.equal(result.timeZone, 'Asia/Shanghai'); assert.equal(result.accountId, 'all');
  assert.equal(result.rows.length, 7); assert.equal(result.complete, true); assert.equal(result.stale, false);
  assert.deepEqual(result.totals, { requests: 14, tokens: 210, accountCost: 8.75, userCost: 17.5 });
  assert.equal(result.refreshIntervalMs, 300000); assert.equal(result.checkedAt, new Date(NOW).toISOString());
  for (const call of f.calls) {
    assert.equal(call.method, 'GET'); assert.equal(call.redirect, 'manual');
    assert.equal(call.url.pathname, '/api/v1/admin/usage/stats');
    assert.equal(call.url.searchParams.get('start_date'), call.url.searchParams.get('end_date'));
    assert.equal(call.url.searchParams.get('timezone'), 'Asia/Shanghai');
    assert.deepEqual([...call.url.searchParams.keys()].sort(), ['end_date', 'start_date', 'timezone']);
    assert.equal(call.headers['x-api-key'], 'admin-private-fixture'); assert.equal(call.body, undefined);
  }
  assert.doesNotMatch(JSON.stringify(result), /private|endpoint|99999|total_cost/);
  assert.equal(f.calls.length, 7); assert.ok(f.maximum() <= 2);
});

test('scope and range validation cannot read hidden accounts or change the upstream endpoint', async t => {
  const f = fixture(t);
  for (const days of [0, 6, 8, 31, '7', null]) await assert.rejects(f.client.get({ days }), error => error.code === 'INVALID_RANGE');
  for (const accountId of ['0', '-1', '01', '999', '1/../2', 1, '', null, '9999999999999999999']) {
    await assert.rejects(f.client.get({ accountId }), error => error.code === 'INVALID_ACCOUNT');
  }
  assert.equal(f.calls.length, 0);
  const result = await f.client.get({ accountId: '1' }); assert.equal(result.accountId, '1');
  assert.ok(f.calls.every(call => call.url.searchParams.get('account_id') === '1'));
  f.setIds(['2']); await assert.rejects(f.client.get({ accountId: '1' }), error => error.code === 'INVALID_ACCOUNT');
  const global = fixture(t, { ids: [] }); assert.equal((await global.client.get()).complete, true);
});

test('calendar generation includes today in Shanghai and handles leap days, month and year boundaries', async t => {
  for (const [startNow, days, first, last] of [
    [Date.parse('2024-02-29T16:00:00Z'), 7, '2024-02-24', '2024-03-01'],
    [Date.parse('2025-12-31T16:00:00Z'), 7, '2025-12-26', '2026-01-01'],
    [Date.parse('2024-03-01T00:00:00Z'), 30, '2024-02-01', '2024-03-01'],
  ]) {
    const f = fixture(t, { startNow }); const result = await f.client.get({ days });
    assert.equal(result.startDate, first); assert.equal(result.endDate, last); assert.equal(result.rows.length, days);
    assert.equal(new Set(result.rows.map(row => row.date)).size, days);
    assert.deepEqual(result.rows.map(row => row.date), result.rows.map(row => row.date).sort());
  }
});

test('shared daily cache survives report size changes without fabricating a new checkedAt time', async t => {
  const f = fixture(t);
  const first = await f.client.get(); const observedAt = first.checkedAt;
  first.rows[0].requests = 999;
  f.advance(1000); const cached = await f.client.get();
  assert.equal(cached.checkedAt, observedAt); assert.equal(cached.rows[0].requests, 2); assert.equal(f.calls.length, 7);
  const month = await f.client.get({ days: 30 }); assert.equal(f.calls.length, 30);
  assert.equal(month.checkedAt, observedAt, 'The report uses its earliest actual day sample');
  f.advance(300000); await f.client.get(); assert.equal(f.calls.length, 37);
});

test('daily caches have a bounded size across independently selected account scopes', async t => {
  const f = fixture(t, { maxCacheEntries: 30 });
  await f.client.get({ days: 30 }); await f.client.get({ days: 30, accountId: '1' });
  assert.equal(f.calls.length, 60);
  await f.client.get(); assert.equal(f.calls.length, 67);
});

test('same reports share work, overlapping dates share requests and all reports use at most two slots', async t => {
  const gate = deferred();
  const f = fixture(t, { fetch: async () => { await gate.promise; return response(stats()); } });
  const first = f.client.get(), duplicate = f.client.get(), month = f.client.get({ days: 30 });
  await flush(); assert.equal(f.calls.length, 2); gate.resolve();
  const results = await Promise.all([first, duplicate, month]);
  assert.equal(f.calls.length, 30); assert.ok(f.maximum() <= 2);
  results[0].rows[0].tokens = 999; assert.equal(results[1].rows[0].tokens, 30);
});

test('only four distinct report jobs may queue, while duplicates reuse an admitted job', async t => {
  const gate = deferred(), f = fixture(t, { fetch: async () => { await gate.promise; return response(stats()); } });
  const jobs = ['all', '1', '2', '3'].map(accountId => f.client.get({ accountId }));
  const duplicate = f.client.get();
  try { await assert.rejects(f.client.get({ accountId: '4' }), error => error instanceof UsageTrendsError && error.status === 429); }
  finally { gate.resolve(); }
  const results = await Promise.all([...jobs, duplicate]);
  assert.ok(results.every(result => result.complete)); assert.equal(f.calls.length, 28); assert.ok(f.maximum() <= 2);
});

test('offline and malformed batches stop after the in-flight pair and failures share the five-minute throttle', async t => {
  for (const make of [() => { throw Error('admin-private-fixture'); }, () => new Response('private', { status: 403 }),
    () => response(stats({ total_actual_cost: null }))]) {
    const f = fixture(t, { fetch: make });
    const result = await f.client.get({ days: 30 });
    assert.equal(result.complete, false); assert.equal(result.stale, true); assert.equal(result.checkedAt, null);
    assert.ok(result.rows.every(row => row.requests === null && row.tokens === null));
    assert.deepEqual(result.totals, { requests: null, tokens: null, accountCost: null, userCost: null });
    assert.ok(result.lastError); assert.doesNotMatch(JSON.stringify(result), /admin-private|private/);
    assert.ok(f.calls.length <= 2); const attempted = f.calls.length;
    await Promise.all(Array.from({ length: 10 }, () => f.client.get({ days: 30 })));
    assert.equal(f.calls.length, attempted);
    f.advance(300000); await f.client.get({ days: 30 }); assert.ok(f.calls.length <= attempted + 2);
  }
});

test('old complete values remain usable sums but are explicitly incomplete and stale after a failed update', async t => {
  let fail = false;
  const f = fixture(t, { fetch: () => { if (fail) throw Error('offline'); return response(stats()); } });
  const old = await f.client.get(); f.advance(300000); fail = true;
  const failed = await f.client.get();
  assert.deepEqual(failed.totals, old.totals); assert.equal(failed.checkedAt, old.checkedAt);
  assert.equal(failed.complete, false); assert.equal(failed.stale, true);
  assert.ok(failed.rows.every(row => row.stale)); assert.ok(f.calls.length <= 9);
});

test('only a genuine successful zero becomes zero and partial reports never advertise a partial total as complete', async t => {
  const zero = fixture(t, { fetch: () => response(stats({ total_requests: 0, total_tokens: 0, total_account_cost: 0, total_actual_cost: 0 })) });
  assert.deepEqual((await zero.client.get()).totals, { requests: 0, tokens: 0, accountCost: 0, userCost: 0 });
  const partial = fixture(t, { fetch: (_url, _options, count) => count <= 2 ? response(stats()) : new Response('', { status: 500 }) });
  const result = await partial.client.get(); assert.equal(result.complete, false);
  assert.ok(result.rows.some(row => row.requests === 2)); assert.ok(result.rows.some(row => row.requests === null));
  assert.deepEqual(result.totals, { requests: null, tokens: null, accountCost: null, userCost: null });
  assert.ok(partial.calls.length <= 4);
});

test('an expired batch never dispatches work after finally acquiring a busy global slot', async t => {
  const gate = deferred();
  const f = fixture(t, { batchTimeoutMs: 100, fetch: async () => { await gate.promise; return response(stats()); } });
  const first = f.client.get(), queued = f.client.get({ accountId: '1' }); await flush();
  assert.equal(f.calls.length, 2); f.tick(101); gate.resolve();
  const [a, b] = await Promise.all([first, queued]);
  assert.equal(f.calls.length, 2); assert.equal(a.complete, false); assert.equal(b.complete, false);
  assert.ok(b.rows.every(row => row.requests === null)); assert.match(b.lastError, /时限/);
});

test('timeouts and hanging response bodies are bounded, and late success cannot replace the failed cache', async t => {
  const late = deferred(); const signals = [];
  const f = fixture(t, { timeoutMs: 15, fetch: (_url, options) => { signals.push(options.signal); return late.promise; } });
  const result = await f.client.get(); assert.equal(result.complete, false); assert.ok(signals.every(signal => signal.aborted));
  late.resolve(response(stats())); await flush();
  assert.equal((await f.client.get()).totals.requests, null); assert.ok(f.calls.length <= 2);
  let cancelled = 0;
  const bodies = fixture(t, { timeoutMs: 15, fetch: () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled++; },
  })) });
  assert.equal((await bodies.client.get()).complete, false); assert.ok(cancelled > 0);
});

test('redirects, invalid envelopes, nonnumeric counters and oversized bodies cannot leak or become zero', async t => {
  for (const make of [() => new Response('', { status: 302 }), () => new Response('invalid'),
    () => response(stats({ total_requests: '2' })), () => response(stats({ total_tokens: -1 })),
    () => response(stats({ total_account_cost: -1 })), () => response({}), () => response([]),
    () => new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } }),
    () => new Response('x'.repeat(256 * 1024 + 1))]) {
    const f = fixture(t, { fetch: make }); const result = await f.client.get();
    assert.equal(result.complete, false); assert.equal(result.totals.requests, null); assert.ok(f.calls.length <= 2);
  }
});

test('crossing Shanghai midnight rolls the window once without requerying shared dates', async t => {
  let f;
  f = fixture(t, { startNow: Date.parse('2024-02-29T15:59:59.999Z'), fetch: (_url, _options, call) => {
    if (call === 1) f.setWall(Date.parse('2024-02-29T16:00:00Z'));
    return response(stats());
  } });
  const result = await f.client.get();
  assert.equal(result.startDate, '2024-02-24'); assert.equal(result.endDate, '2024-03-01');
  assert.equal(result.complete, true); assert.equal(f.calls.length, 8);
  await f.client.get(); assert.equal(f.calls.length, 8);
});

test('closing aborts in-flight reads and releases queued reports without later requests', async t => {
  const signals = [];
  const f = fixture(t, { fetch: (_url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
  const first = f.client.get().catch(error => error), second = f.client.get({ accountId: '1' }).catch(error => error);
  await flush(); assert.equal(f.calls.length, 2); await f.client.close();
  assert.equal((await first).code, 'CLOSED'); assert.equal((await second).code, 'CLOSED');
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(f.calls.length, 2);
  await assert.rejects(f.client.get(), error => error.code === 'CLOSED');
});
