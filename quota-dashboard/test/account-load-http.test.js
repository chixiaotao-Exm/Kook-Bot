import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuth } from '../src/auth.js';
import { QuotaServer } from '../src/server.js';

const checkedAt = '2026-09-24T02:00:00.000Z';
const snapshot = () => ({ enabled: true, accounts: [
  { id: '1', current: 2, limit: 5, percent: 40, observedAt: checkedAt, freshness: 'fresh' },
  { id: '2', current: 0, limit: null, percent: null, observedAt: checkedAt, freshness: 'unknown' },
], checkedAt, refreshIntervalMs: 10000, lastError: '' });
const disabled = { enabled: false, accounts: [], refreshIntervalMs: 10000, checkedAt: null, lastError: '' };

async function fixture(t, { publicAccess = true, configured = true, get } = {}) {
  let now = Date.now(); const calls = [], quotaReads = [], writes = [];
  const auth = new AdminAuth({ baseUrl: 'http://127.0.0.1:8080', preview: true, now: () => now,
    fetchImpl: async () => { throw Error('Tests must not contact a real authentication service'); } });
  const accountLoad = configured ? { async get(...args) { calls.push(args); return get ? await get() : snapshot(); } } : undefined;
  const web = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080',
    auth, publicAccess, accountLoad,
    dashboard: { snapshot() { quotaReads.push('snapshot'); return { accounts: [], refreshIntervalMs: 600000 }; },
      async refresh() { writes.push('quota-refresh'); throw Error('Load reads must not refresh quota'); } },
    scheduler: { snapshot: () => ({ enabled: false, available: false, history: [] }),
      async configure() { writes.push('schedule'); throw Error('Load reads must not change configuration'); } },
    invitations: { async refresh() { writes.push('invitation-refresh'); }, async invite() { writes.push('invite'); } },
  });
  const address = await web.start(), origin = `http://127.0.0.1:${address.port}`;
  t.after(() => web.close());
  let cookie = '', csrf = '';
  async function request(route, { method = 'GET', body, headers = {}, prefix = '/quota/api' } = {}) {
    const response = await fetch(origin + prefix + route, { method, headers: {
      Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const updated = response.headers.getSetCookie().find(value => value.startsWith('quota_session='));
    if (updated) cookie = updated.split(';')[0];
    const text = await response.text(), result = text ? JSON.parse(text) : null;
    if (result?.csrf) csrf = result.csrf;
    return { response, body: result };
  }
  async function login() {
    await request('/session');
    const loggedIn = await request('/login', { method: 'POST', body: { email: 'admin@example.test', password: 'preview-only-password' } });
    assert.equal(loggedIn.response.status, 200);
  }
  return { request, login, calls, quotaReads, writes, cookie: () => cookie, csrf: () => csrf, advance(ms) { now += ms; } };
}

test('public account load is an uncached HTTP read of the separate ten-second dependency', async t => {
  const f = await fixture(t);
  for (const prefix of ['/quota/api', '/api']) {
    const result = await f.request('/account-load', { prefix });
    assert.equal(result.response.status, 200); assert.deepEqual(result.body, snapshot());
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.response.headers.has('set-cookie'), false);
  }
  assert.deepEqual(f.calls, [[], []]);
  assert.deepEqual(f.quotaReads, []); assert.deepEqual(f.writes, []);
  const session = await f.request('/session');
  assert.equal(session.body.authenticated, false); assert.equal(session.body.canManage, false);
  const status = await f.request('/status');
  assert.equal(status.body.refreshIntervalMs, 600000, 'Quota collection retains its existing ten-minute interval');
  assert.equal(f.calls.length, 2);
});

test('an unconfigured collector returns the explicit disabled contract', async t => {
  const f = await fixture(t, { configured: false });
  const result = await f.request('/account-load');
  assert.equal(result.response.status, 200); assert.deepEqual(result.body, disabled);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.quotaReads, []); assert.deepEqual(f.writes, []);
});

test('private load reads require the existing administrator login and reject expired or logged-out sessions', async t => {
  const f = await fixture(t, { publicAccess: false });
  assert.equal((await f.request('/account-load')).response.status, 401);
  await f.request('/session'); const guestCookie = f.cookie();
  assert.equal((await f.request('/account-load')).response.status, 401);
  assert.deepEqual(f.calls, []);
  await f.login();
  assert.equal((await f.request('/account-load', { headers: { Cookie: guestCookie } })).response.status, 401);
  assert.equal((await f.request('/account-load')).response.status, 200);
  assert.equal((await f.request('/logout', { method: 'POST', body: {} })).response.status, 200);
  assert.equal((await f.request('/account-load')).response.status, 401);
  await f.login(); f.advance(3600001);
  assert.equal((await f.request('/account-load')).response.status, 401);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.quotaReads, []); assert.deepEqual(f.writes, []);
});

test('account load never accepts mutation methods or bypasses the existing Origin check', async t => {
  for (const publicAccess of [true, false]) await t.test(publicAccess ? 'public' : 'private', async t => {
    const f = await fixture(t, { publicAccess });
    if (!publicAccess) await f.login();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const result = await f.request('/account-load', { method, ...(method === 'POST' ? { body: { refresh: true, accountId: '1' } } : {}) });
      assert.equal(result.response.status, 405, method);
    }
    assert.equal((await f.request('/account-load', { headers: { Origin: 'https://other.invalid' } })).response.status, 403);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.quotaReads, []); assert.deepEqual(f.writes, []);
  });
});

test('query parameters cannot be forwarded as upstream targets or force quota refresh', async t => {
  const f = await fixture(t);
  const result = await f.request('/account-load?url=https%3A%2F%2Fother.invalid&refresh=true&accountId=1');
  assert.equal(result.response.status, 200); assert.deepEqual(result.body, snapshot());
  assert.deepEqual(f.calls, [[]]); assert.deepEqual(f.quotaReads, []); assert.deepEqual(f.writes, []);
});

test('unknown and stale values survive HTTP transport and unexpected failures remain private', async t => {
  const stale = { ...snapshot(), accounts: [{ id: '1', current: null, limit: 5, percent: null,
    observedAt: checkedAt, freshness: 'stale' }], lastError: '负载暂时不可读，显示上次记录。' };
  const f = await fixture(t, { get: async () => stale });
  assert.deepEqual((await f.request('/account-load')).body, stale);
  const failed = await fixture(t, { get: async () => { throw Error('admin-private-credential user@example.test'); } });
  const result = await failed.request('/account-load');
  assert.equal(result.response.status, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /admin-private|user@|credential/);
  assert.deepEqual(failed.quotaReads, []); assert.deepEqual(failed.writes, []);
});
