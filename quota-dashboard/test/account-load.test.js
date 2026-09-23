import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountLoad } from '../src/account-load.js';

const NOW = Date.parse('2026-09-24T04:00:00Z');
const row = (id, current = 2, limit = 10) => ({ account_id: Number(id), current_in_use: current, max_capacity: limit,
  load_percentage: 999, account_name: 'private@example.test', group_name: 'private-group', access_token: 'private-token' });
const payload = (accounts = { 1: row('1'), 2: row('2', 0, 20) }, patch = {}) => ({ enabled: true, account: accounts,
  timestamp: new Date(NOW).toISOString(), group: { private: true }, ...patch });
const response = data => Response.json({ code: 0, data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, { fetchImpl, ids = ['1', '2'], ...overrides } = {}) {
  let now = NOW, visible = ids; const calls = [];
  const client = new AccountLoad({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'fixture-secret', now: () => now,
    getAccountIds: () => visible, fetchImpl: async (url, init) => { calls.push({ url, ...init }); return fetchImpl ? fetchImpl(url, init) : response(payload()); }, ...overrides });
  t.after(() => client.close());
  return { client, calls, advance: ms => { now += ms; }, setIds: value => { visible = value; } };
}

test('load reads only the verified GET monitor endpoint and exports whitelisted account counters', async t => {
  const f = fixture(t); const result = await f.client.get();
  assert.deepEqual(f.calls.map(({ url, method, redirect }) => ({ url, method, redirect })), [
    { url: 'http://127.0.0.1:8080/api/v1/admin/ops/concurrency', method: 'GET', redirect: 'manual' },
  ]);
  assert.equal(f.calls[0].headers['x-api-key'], 'fixture-secret');
  assert.deepEqual(result.accounts, [
    { id: '1', current: 2, limit: 10, percent: 20, observedAt: new Date(NOW).toISOString(), freshness: 'fresh' },
    { id: '2', current: 0, limit: 20, percent: 0, observedAt: new Date(NOW).toISOString(), freshness: 'fresh' },
  ]);
  assert.equal(result.refreshIntervalMs, 10000); assert.doesNotMatch(JSON.stringify(result), /private|token|secret|group/);
});

test('all visitors share one in-flight request and the ten-second success cache', async t => {
  const gate = deferred(); let samples = 0;
  const f = fixture(t, { fetchImpl: async () => { samples++; await gate.promise; return response(payload()); } });
  const calls = Array.from({ length: 30 }, () => f.client.get());
  assert.equal(samples, 1); gate.resolve();
  const results = await Promise.all(calls); assert.ok(results.every(value => value.accounts[0].current === 2));
  results[0].accounts[0].current = 700;
  f.advance(9999); assert.equal((await f.client.get()).accounts[0].current, 2); assert.equal(samples, 1);
  f.advance(1); await f.client.get(); assert.equal(samples, 2);
});

test('failure retains the prior counters as stale and throttles retries globally', async t => {
  let fail = false;
  const f = fixture(t, { fetchImpl: async () => { if (fail) throw new Error('private token'); return response(payload()); } });
  const first = await f.client.get(); fail = true; f.advance(10000);
  const failed = await f.client.get();
  assert.equal(failed.accounts[0].current, 2); assert.equal(failed.accounts[0].freshness, 'stale');
  assert.equal(failed.checkedAt, first.checkedAt); assert.ok(failed.lastError); assert.doesNotMatch(JSON.stringify(failed), /private|token/);
  await Promise.all(Array.from({ length: 20 }, () => f.client.get())); assert.equal(f.calls.length, 2);
  fail = false; f.advance(10000); assert.equal((await f.client.get()).accounts[0].freshness, 'fresh');
});

test('missing or malformed values stay unknown, including zero limits, with actual over-capacity preserved', async t => {
  const f = fixture(t, { ids: ['1', '2', '3', '4', '5', '6'], fetchImpl: async () => response(payload({
    1: row('1', null, 10), 2: row('2', 0, 0), 3: row('3', -1, 10), 4: row('4', 15, 10),
    5: row('5', '2', '10'), 6: { ...row('6'), account_id: 7 },
  })) });
  const rows = (await f.client.get()).accounts;
  assert.equal(rows[0].current, null); assert.equal(rows[0].percent, null);
  assert.equal(rows[1].current, 0); assert.equal(rows[1].limit, null); assert.equal(rows[1].percent, null);
  assert.equal(rows[2].current, null); assert.equal(rows[3].percent, 150);
  assert.equal(rows[4].current, null); assert.equal(rows[4].limit, null);
  assert.deepEqual(rows[5], { id: '6', current: null, limit: null, percent: null, observedAt: null, freshness: 'unknown' });
});

test('hidden, deleted and newly added accounts follow the current public dashboard list', async t => {
  const f = fixture(t, { ids: ['1'], fetchImpl: async () => response(payload({ 1: row('1'), 2: row('2'), 3: row('3') })) });
  assert.deepEqual((await f.client.get()).accounts.map(row => row.id), ['1']);
  f.setIds(['2']); const added = await f.client.get(); assert.equal(added.accounts[0].freshness, 'unknown');
  assert.doesNotMatch(JSON.stringify(added), /private/);
  f.advance(10000); assert.equal((await f.client.get()).accounts[0].current, 2);
  f.setIds([]); assert.deepEqual((await f.client.get()).accounts, []);
});

test('measurement age uses the monitor timestamp, not the webpage fetch time', async t => {
  const f = fixture(t); await f.client.get(); f.advance(25001);
  assert.equal(f.client.snapshot().accounts[0].freshness, 'stale');
  for (const timestamp of [null, 'bad-time', new Date(NOW + 60000).toISOString()]) {
    const g = fixture(t, { fetchImpl: async () => response(payload(undefined, { timestamp })) });
    assert.equal((await g.client.get()).accounts[0].freshness, 'unknown');
  }
  const nano = fixture(t, { fetchImpl: async () => response(payload(undefined, { timestamp: '2026-09-24T04:00:00.000396283Z' })) });
  assert.equal((await nano.client.get()).accounts[0].observedAt, '2026-09-24T04:00:00.000Z');
});

test('a disabled upstream monitor clears prior measurements and empty visible lists make no request', async t => {
  let enabled = true;
  const f = fixture(t, { fetchImpl: async () => response(enabled ? payload() : { enabled: false }) });
  await f.client.get(); enabled = false; f.advance(10000);
  const result = await f.client.get(); assert.equal(result.enabled, false); assert.deepEqual(result.accounts, []);
  const empty = fixture(t, { ids: [] }); await empty.client.get(); assert.equal(empty.calls.length, 0);
});

test('timeout, hanging body and shutdown are bounded without late response publication', async t => {
  const late = deferred(); let signal;
  const f = fixture(t, { timeoutMs: 15, fetchImpl: async (_url, init) => { signal = init.signal; return late.promise; } });
  const result = await f.client.get(); assert.equal(signal.aborted, true); assert.ok(result.lastError);
  late.resolve(response(payload())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.snapshot().accounts[0].current, null);
  let cancelled = false;
  const body = fixture(t, { timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
  })) });
  await body.client.get(); assert.equal(cancelled, true);
  const closing = fixture(t, { fetchImpl: () => new Promise(() => {}) });
  const pending = closing.client.get(); await closing.client.close(); await pending;
  assert.equal((await closing.client.get()).enabled, false); assert.equal(closing.calls.length, 1);
});

test('redirects, HTTP refusal and malformed or oversized envelopes do not masquerade as idle accounts', async t => {
  for (const make of [() => new Response('', { status: 302 }), () => Response.json({ message: 'fixture-secret' }, { status: 403 }),
    () => new Response('bad'), () => response({ enabled: true, account: [] }), () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const f = fixture(t, { fetchImpl: make }); const result = await f.client.get();
    assert.equal(result.accounts[0].current, null); assert.equal(result.accounts[0].freshness, 'unknown');
    assert.ok(result.lastError); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  }
});
