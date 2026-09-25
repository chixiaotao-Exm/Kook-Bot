import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { OpsServer } from '../src/server.js';
import { AdminAuth } from '../src/auth.js';
import { OpsError } from '../src/storage.js';

async function fixture(t) {
  const auth = new AdminAuth({ baseUrl: 'http://127.0.0.1/' }); let commands = 0, reports = 0;
  const engine = { store: { failed: false }, snapshot: () => ({ hosts: [{ name: 'private-host' }] }),
    ingest: async () => { reports++; return { commands: [] }; },
    command: async (body, authorize) => { authorize(); commands++; return { id: 'ok' }; }, maintenance: async (body, authorize) => { authorize(); return { updated: true }; } };
  const config = { publicUrl: 'http://ops.test/ops/', host: '127.0.0.1', port: 0, hosts: [{ id: 'linux', token: 'a'.repeat(48) }] };
  const server = new OpsServer({ config, engine, auth, bodyTimeoutMs: 250 }); const address = await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}/ops`;
  const session = auth.create({ role: 'admin', email: 'admin@example.test' });
  const headers = { cookie: `ops_session=${session.id}`, 'x-csrf-token': session.csrf, 'Content-Type': 'application/json', Origin: 'http://ops.test' };
  return { base, auth, session, headers, server, engine, get commands() { return commands; }, get reports() { return reports; } };
}
test('anonymous visitors cannot read operational state or execute commands; agents cannot become admins', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/snapshot')).status, 401);
  assert.equal((await fetch(f.base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(f.base + '/api/snapshot', { headers: { Authorization: 'Bearer ' + 'a'.repeat(48) } })).status, 401);
  const result = await fetch(f.base + '/api/snapshot', { headers: f.headers }); assert.equal(result.status, 200); assert.equal((await result.json()).hosts[0].name, 'private-host');
  assert.equal(f.commands, 0);
});

test('legacy pages redirect to the console while embeddable assets remain same-origin and non-frameable', async t => {
  const f = await fixture(t);
  for (const route of ['', '/', '/index.html']) {
    const response = await fetch(f.base + route, { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/quota/#ops-overview');
  }
  const panel = await fetch(f.base + '/panel.html');
  assert.equal(panel.status, 200); assert.equal(panel.headers.get('x-frame-options'), 'DENY');
  assert.match(await panel.text(), /id="host-list"/);
  assert.equal((await fetch(f.base + '/api/snapshot')).status, 401);
});

test('existing-login token is verified by the upstream admin API and cannot select an upstream URL', async () => {
  const calls = [];
  const token = `header.${Buffer.from(JSON.stringify({ email: 'admin@example.test', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.signature`;
  const auth = new AdminAuth({ baseUrl: 'http://identity.invalid', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options }); return Response.json({ code: 0, data: {} });
  } });
  const result = await auth.login({ token, url: 'http://evil.invalid' }, 'test');
  assert.equal(result.user.role, 'admin'); assert.equal(result.user.email, 'admin@example.test');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://identity.invalid/api/v1/admin/accounts?page=1&page_size=1');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  for (const invalid of ['', 123, 'x'.repeat(8193)]) await assert.rejects(auth.login({ token: invalid }, 'invalid-' + typeof invalid));
  auth.fetch = async () => Response.json({ code: 1 }, { status: 403 });
  await assert.rejects(auth.login({ token }, 'forbidden'));
});
test('wrong CSRF and foreign origins are rejected', async t => {
  const f = await fixture(t);
  for (const override of [{ 'x-csrf-token': 'wrong' }, { Origin: 'http://evil.test' }]) {
    assert.equal((await fetch(f.base + '/api/maintenance', { method: 'POST', headers: { ...f.headers, ...override }, body: '{}' })).status, 403);
  }
});
test('logout during a slow request body prevents its command from executing', async t => {
  const f = await fixture(t);
  const result = new Promise((resolve, reject) => {
    const request = http.request(f.base + '/api/commands', { method: 'POST', headers: f.headers }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.write('{');
    setTimeout(() => { f.auth.logout(f.session); request.end('"requestId":"' + randomUUID() + '"}'); }, 25);
  });
  assert.equal(await result, 401); assert.equal(f.commands, 0);
});
test('collector endpoint only accepts matching server-configured token', async t => {
  const f = await fixture(t), body = JSON.stringify({ hostId: 'linux' });
  assert.equal((await fetch(f.base + '/api/agent/report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body })).status, 401);
  assert.equal((await fetch(f.base + '/api/agent/report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'a'.repeat(48) }, body })).status, 200);
  assert.equal(f.reports, 1);
});
test('health is degraded after storage failure and errors never expose raw exception details', async t => {
  const f = await fixture(t); f.engine.store.failed = true;
  assert.equal((await fetch(f.base + '/health')).status, 503);
  f.engine.snapshot = () => { throw new Error('secret-token-value'); };
  const result = await fetch(f.base + '/api/snapshot', { headers: f.headers }); assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('secret-token'));
});
test('logout invalidates cookies immediately', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/logout', { method: 'POST', headers: f.headers, body: '{}' })).status, 200);
  assert.equal((await fetch(f.base + '/api/snapshot', { headers: f.headers })).status, 401);
});

test('explicit guest management permits snapshot, restart and maintenance with anonymous CSRF sessions', async t => {
  const f = await fixture(t); f.server.config.publicManagement = true;
  assert.equal((await fetch(f.base + '/api/snapshot')).status, 200);
  const response = await fetch(f.base + '/api/session'), session = await response.json();
  assert.equal(session.authenticated, false); assert.equal(session.canManage, true); assert.equal(session.publicManagement, true); assert.equal(session.user, null);
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrf, 'Content-Type': 'application/json', Origin: 'http://ops.test' };
  for (const route of ['commands', 'maintenance']) {
    assert.equal((await fetch(f.base + '/api/' + route, { method: 'POST', headers, body: '{}' })).status, route === 'commands' ? 202 : 200);
    for (const override of [{ cookie: '' }, { 'x-csrf-token': 'wrong' }, { Origin: 'https://foreign.invalid' }]) {
      const bad = await fetch(f.base + '/api/' + route, { method: 'POST', headers: { ...headers, ...override }, body: '{}' });
      assert.ok([401, 403].includes(bad.status));
    }
  }
  assert.equal(f.commands, 1);
  f.auth.logout(f.auth.get(headers.cookie));
  assert.equal((await fetch(f.base + '/api/commands', { method: 'POST', headers, body: '{}' })).status, 401);
  assert.equal(f.commands, 1);
  assert.equal((await fetch(f.base + '/api/agent/report', { method: 'POST', headers, body: '{}' })).status, 401);
});
