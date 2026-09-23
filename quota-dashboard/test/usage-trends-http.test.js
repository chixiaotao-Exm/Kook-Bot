import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaServer } from '../src/server.js';
import { AdminAuth } from '../src/auth.js';
import { UsageTrendsError } from '../src/usage-trends.js';

async function fixture(t, { publicAccess = true, usageTrends } = {}) {
  const calls = [];
  const auth = new AdminAuth({ baseUrl: 'http://127.0.0.1:8080', preview: true });
  const server = new QuotaServer({ host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080', publicAccess, auth,
    dashboard: { snapshot: () => ({ accounts: [], refreshIntervalMs: 600000 }), refresh: () => { throw new Error('Must not refresh quota'); } },
    scheduler: { snapshot: () => ({ available: false, history: [] }) },
    usageTrends: usageTrends === null ? undefined : usageTrends || { get: async options => { calls.push(options); return { ...options, rows: [], complete: true, timeZone: 'Asia/Shanghai' }; } },
  });
  const address = await server.start(); t.after(() => server.close());
  return { calls, auth, url: `http://127.0.0.1:${address.port}/quota/api/usage-trends` };
}

test('public trend reads use fixed default and explicit filters without refreshing quota', async t => {
  const f = await fixture(t);
  const first = await fetch(f.url); assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal((await first.json()).timeZone, 'Asia/Shanghai');
  const second = await fetch(f.url + '?days=30&accountId=6269'); assert.equal(second.status, 200);
  assert.deepEqual(f.calls, [{ days: 7, accountId: 'all' }, { days: 30, accountId: '6269' }]);
});

test('private trend reads retain administrator login and session expiration requirements', async t => {
  const f = await fixture(t, { publicAccess: false });
  assert.equal((await fetch(f.url)).status, 401);
  const guest = f.auth.create(); assert.equal((await fetch(f.url, { headers: { Cookie: 'quota_session=' + guest.id } })).status, 401);
  const admin = f.auth.create({ role: 'admin' });
  assert.equal((await fetch(f.url, { headers: { Cookie: 'quota_session=' + admin.id } })).status, 200);
  f.auth.logout(admin);
  assert.equal((await fetch(f.url, { headers: { Cookie: 'quota_session=' + admin.id } })).status, 401);
  assert.equal(f.calls.length, 1);
});

test('unsupported ranges, duplicate filters and arbitrary upstream parameters cannot reach the reader', async t => {
  const f = await fixture(t);
  for (const query of ['days=0', 'days=365', 'days=', 'days=07', 'days=7&days=30', 'accountId=1&accountId=2',
    'accountId=', 'accountId=../usage', 'accountId=0', 'timezone=UTC', 'start_date=2026-01-01', 'url=https://evil.test']) {
    assert.equal((await fetch(f.url + '?' + query)).status, 400, query);
  }
  assert.deepEqual(f.calls, []);
});

test('trend endpoint refuses writes and cross-origin requests', async t => {
  const f = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal((await fetch(f.url, { method })).status, 405);
  assert.equal((await fetch(f.url, { headers: { Origin: 'https://elsewhere.test' } })).status, 403);
  assert.deepEqual(f.calls, []);
});

test('known query errors remain structured; unexpected internals are not returned', async t => {
  const busy = await fixture(t, { usageTrends: { get: async () => { throw Object.assign(new UsageTrendsError('BUSY', '请稍后重试。', 429), { retryAfterSeconds: 5 }); } } });
  const response = await fetch(busy.url); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '5');
  assert.equal((await response.json()).error.code, 'BUSY');
  const failed = await fixture(t, { usageTrends: { get: async () => { throw new Error('admin-private upstream URL and key'); } } });
  const error = await fetch(failed.url); assert.equal(error.status, 500); assert.doesNotMatch(await error.text(), /admin-private|upstream/);
  const absent = await fixture(t, { usageTrends: null }); assert.equal((await fetch(absent.url)).status, 503);
});
