import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { QuotaServer } from '../src/server.js';
import { AdminAuth, AuthError } from '../src/auth.js';
import { BroadcastScheduler } from '../src/broadcast.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settings = { enabled: false, times: ['09:00'], timeZone: 'Asia/Shanghai' };
async function fixture(t, { auth, scheduler, guest = false } = {}) {
  auth ||= new AdminAuth({ baseUrl: 'http://identity.invalid', fetchImpl: () => { throw Error('Unexpected network request'); } });
  const session = auth.create(guest ? null : { email: 'admin@example.test', role: 'admin' });
  const server = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://identity.invalid',
    dashboard: { snapshot: () => ({ accounts: [] }) }, scheduler: scheduler || { snapshot: () => ({}), configure: async () => {} }, auth, publicManagement: guest });
  const address = await server.start(); t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}/quota/api/`;
  const headers = { cookie: `quota_session=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  return { auth, session, server, base, headers, post };
}

test('a login response cannot recreate a session after logout or another login rotated it', async t => {
  for (const replacement of [false, true]) await t.test(replacement ? 'rotated session' : 'logout', async t => {
    const entered = gate(), release = gate(); t.after(() => release.resolve());
    const auth = new AdminAuth({ baseUrl: 'http://identity.invalid', fetchImpl: async () => {
      entered.resolve(); await release.promise; return Response.json({ code: 0, data: {} });
    } });
    const f = await fixture(t, { auth });
    const pending = f.post('login', { token: 'fixture-admin-token' }); await entered.promise;
    assert.equal((await f.post('logout')).status, 200);
    const successor = replacement ? auth.create({ email: 'next@example.test', role: 'admin' }) : null;
    release.resolve(); const result = await pending;
    assert.equal(result.status, 401); assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(auth.get(f.headers.cookie), null); assert.equal(auth.sessions.size, replacement ? 1 : 0);
    if (successor) assert.equal(auth.get(`quota_session=${successor.id}`), successor);
  });
});

test('logout while a login body is incomplete prevents upstream verification', async t => {
  let calls = 0;
  const auth = new AdminAuth({ baseUrl: 'http://identity.invalid', fetchImpl: async () => { calls++; return Response.json({ code: 0, data: {} }); } });
  const f = await fixture(t, { auth });
  assert.equal(await slowBody(f, 'login', { token: 'fixture-admin-token' }), 401); assert.equal(calls, 0);
});

async function slowBody(f, route, body) {
  const received = gate(); f.server.server.prependListener('request', req => { if (req.url.endsWith('/' + route)) received.resolve(); });
  return new Promise((resolve, reject) => {
    const req = http.request(f.base + route, { method: 'POST', headers: f.headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
    void received.promise.then(async () => { assert.equal((await f.post('logout')).status, 200); req.end(JSON.stringify(body).slice(1)); }).catch(reject);
  });
}

test('logout during report-config body still prevents the write', async t => {
  let writes = 0;
  const f = await fixture(t, { scheduler: { snapshot: () => ({}), configure: async () => { writes++; } } });
  assert.equal(await slowBody(f, 'report-config', settings), 401); assert.equal(writes, 0);
});

test('queued report configuration rechecks the original session and current guest policy before writing', async t => {
  for (const mode of ['logout', 'guest-session-expired', 'guest-management-disabled', 'valid-guest']) await t.test(mode, async t => {
    const block = gate(), queued = gate(); let saved = 0; t.after(() => block.resolve());
    const scheduler = new BroadcastScheduler({ dataDir: 'unused-fixture', getSnapshot: () => ({ accounts: [] }), writeState: async () => { saved++; } });
    scheduler.initialized = true;
    const first = scheduler.enqueue(() => block.promise);
    const original = scheduler.configure.bind(scheduler);
    scheduler.configure = (...args) => { const pending = original(...args); queued.resolve(); return pending; };
    const f = await fixture(t, { scheduler, guest: mode !== 'logout' });
    const change = f.post('report-config', settings); await queued.promise;
    if (mode === 'logout') assert.equal((await f.post('logout')).status, 200);
    if (mode === 'guest-session-expired') f.auth.logout(f.session);
    if (mode === 'guest-management-disabled') f.server.publicManagement = false;
    block.resolve(); await first;
    const result = await change;
    assert.equal(result.status, mode === 'valid-guest' ? 200 : 401);
    assert.equal(saved, mode === 'valid-guest' ? 1 : 0);
    assert.deepEqual(scheduler.snapshot().times, mode === 'valid-guest' ? ['09:00'] : []);
  });
});

test('configuration performs its final authorization check immediately before persistence', async () => {
  let checks = 0, writes = 0;
  const scheduler = new BroadcastScheduler({ dataDir: 'unused-fixture', getSnapshot: () => ({ accounts: [] }), writeState: async () => { writes++; } });
  scheduler.initialized = true;
  await assert.rejects(scheduler.configure(settings, { authorize: () => { if (++checks === 2) throw new AuthError('Session expired'); } }), AuthError);
  assert.equal(writes, 0); assert.deepEqual(scheduler.snapshot().times, []); assert.equal(scheduler.storageError, null);
});
