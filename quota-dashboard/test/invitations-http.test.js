import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuth } from '../src/auth.js';
import { QuotaServer } from '../src/server.js';
import { InvitationError } from '../src/invitations.js';

const PRIVATE = 'admin-private_server_credential_never_return';
const requestId = 'ac027b1e-0d65-40b3-9fa6-22a0cb7fbb34';
const invitation = { status: 'available', remaining: 2 };
const payload = () => ({ email: 'recipient@example.test', programId: 'codex_referral_consumer', confirmed: true, requestId });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  let now = Date.now(); const calls = [], sent = [];
  const auth = new AdminAuth({ baseUrl: 'http://127.0.0.1:8080', preview: true, now: () => now,
    fetchImpl: async () => { throw Error('Tests must not contact a real upstream'); } });
  const invitations = options.enabled === false ? undefined : {
    async refresh(id, controls) {
      calls.push({ method: 'refresh', id }); controls.authorize();
      if (options.refresh) return options.refresh(id, controls);
      return { invitation, cachePersisted: true, adminApiKey: PRIVATE };
    },
    async invite(id, body, controls) {
      calls.push({ method: 'invite', id, body }); controls.authorize();
      if (options.beforeSend) await options.beforeSend();
      controls.authorize();
      if (options.invite) return options.invite(id, body, controls);
      sent.push({ id, body });
      return { sent: true, invitation, refreshFailed: false, cachePersisted: true, adminApiKey: PRIVATE };
    },
  };
  const web = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080',
    auth, preview: true, publicAccess: options.publicAccess ?? true,
    ...(Object.hasOwn(options, 'publicInvites') ? { publicInvites: options.publicInvites } : {}), invitations,
    dashboard: { snapshot: () => ({ accounts: [{ id: '1', invitation, credentials: { key: PRIVATE }, name: 'Account 1' },
      { id: '2', name: 'Other account', metrics: [] }] }) },
    scheduler: { snapshot: () => ({ available: false, enabled: false, history: [] }) },
  });
  const address = await web.start(), origin = `http://127.0.0.1:${address.port}`;
  t.after(() => web.close());
  let cookie = '', csrf = '';
  async function request(route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + '/quota/api' + route, { method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const updated = response.headers.getSetCookie().find(value => value.startsWith('quota_session='));
    if (updated) cookie = updated.split(';')[0];
    const text = await response.text(); assert.ok(!text.includes(PRIVATE), 'Do not expose the server credential');
    const result = JSON.parse(text); if (result.csrf) csrf = result.csrf;
    return { response, body: result };
  }
  async function login() {
    await request('/session');
    const result = await request('/login', { email: 'admin@example.test', password: 'preview-only-password' });
    assert.equal(result.response.status, 200); return result;
  }
  return { web, auth, calls, sent, request, login, origin, cookie: () => cookie, csrf: () => csrf, advance(ms) { now += ms; } };
}

test('invitation availability is a cached public read and sessions advertise only capabilities', async t => {
  const f = await fixture(t, { publicInvites: true });
  const list = await f.request('/invitations');
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.body, { enabled: true, publicInvites: true, canInvite: true, accounts: [{ id: '1', invitation }] });
  assert.equal(list.response.headers.get('cache-control'), 'no-store'); assert.equal(f.calls.length, 0);
  const session = await f.request('/session');
  assert.deepEqual(session.body.invitations, { enabled: true, publicInvites: true, canInvite: true });
  assert.equal(session.body.canManage, false); assert.equal(session.body.authenticated, false);
  assert.equal(Object.hasOwn(session.body.invitations, 'accounts'), false);
  assert.equal(f.web.server.requestTimeout, 30000);
  assert.equal(f.web.server.timeout, 0, 'Receiving-body timeout must not cut off a long invitation response');
});

test('public invitation permission allows a CSRF-protected guest without granting administrator controls', async t => {
  const f = await fixture(t, { publicInvites: true }); await f.request('/session');
  const refreshed = await f.request('/invitations/1/refresh', {});
  assert.deepEqual(refreshed.body, { invitation, cachePersisted: true });
  const invited = await f.request('/invitations/1/invite', payload());
  assert.equal(invited.response.status, 200);
  assert.deepEqual(invited.body, { sent: true, refreshFailed: false, invitation, cachePersisted: true });
  assert.deepEqual(f.calls, [{ method: 'refresh', id: '1' }, { method: 'invite', id: '1', body: payload() }]);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.request('/report-config', { enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' })).response.status, 401);
});

test('invitation POSTs reject missing sessions, invalid CSRF and foreign origins before using the client', async t => {
  const f = await fixture(t, { publicInvites: true });
  for (const action of ['refresh', 'invite']) {
    assert.equal((await f.request(`/invitations/1/${action}`, action === 'refresh' ? {} : payload())).response.status, 401);
  }
  await f.request('/session');
  for (const headers of [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }, { Origin: 'https://other.invalid' },
    { Origin: f.origin.replace('http:', 'https:') }, { Origin: f.origin + '/path' }]) {
    assert.equal((await f.request('/invitations/1/invite', payload(), headers)).response.status, 403);
  }
  assert.equal((await f.request('/invitations/1/refresh', {}, { Origin: 'null' })).response.status, 403);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('invitations default to administrators and login rotation/logout invalidate old authority', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/invitations')).body.canInvite, false);
  const guest = await f.request('/session'), oldCookie = f.cookie(), oldCsrf = f.csrf();
  assert.deepEqual(guest.body.invitations, { enabled: true, publicInvites: false, canInvite: false });
  assert.equal((await f.request('/invitations/1/invite', payload())).response.status, 401);
  assert.equal((await f.request('/invitations/1/refresh', {})).response.status, 401);
  const admin = await f.login();
  assert.deepEqual(admin.body.invitations, { enabled: true, publicInvites: false, canInvite: true });
  assert.equal((await f.request('/invitations/1/invite', payload(), { Cookie: oldCookie, 'X-CSRF-Token': oldCsrf })).response.status, 401);
  assert.equal((await f.request('/invitations/1/invite', payload())).response.status, 200);
  assert.equal((await f.request('/logout', {})).response.status, 200);
  assert.equal((await f.request('/invitations/1/invite', payload())).response.status, 401);
  assert.equal((await f.request('/invitations')).body.canInvite, false); assert.equal(f.sent.length, 1);
});

test('private dashboards continue protecting invitation reads even when public sending is configured', async t => {
  const f = await fixture(t, { publicAccess: false, publicInvites: true });
  assert.equal((await f.request('/invitations')).response.status, 401);
  await f.request('/session'); assert.equal((await f.request('/invitations')).response.status, 401);
  await f.login(); assert.equal((await f.request('/invitations')).response.status, 200);
  assert.equal(f.calls.length, 0);
});

test('unknown fields, malformed request IDs, query parameters and unsupported methods cannot dispatch invitations', async t => {
  const f = await fixture(t, { publicInvites: true }); await f.request('/session');
  for (const body of [{}, { ...payload(), confirmed: 'true' }, { ...payload(), requestId: 'invalid' },
    { ...payload(), requestId: 1 }, { ...payload(), requestId: requestId.replace('-40b3-', '-10b3-') },
    { ...payload(), url: 'https://other.invalid' }, { ...payload(), admin: true }]) {
    assert.equal((await f.request('/invitations/1/invite', body)).response.status, 400);
  }
  assert.equal((await f.request('/invitations/1/refresh', { email: 'other@example.test' })).response.status, 400);
  assert.equal((await f.request('/invitations/1/invite?email=hidden', payload())).response.status, 400);
  assert.equal((await f.request('/invitations?force=true')).response.status, 400);
  assert.equal((await f.request('/invitations', {})).response.status, 405);
  assert.equal((await f.request('/invitations/1/invite')).response.status, 405);
  assert.equal((await f.request('/invitations/1/refresh')).response.status, 405);
  for (const id of ['0', '-1', '01', '1.5', 'abc', '12345678901234567']) {
    assert.equal((await f.request(`/invitations/${id}/invite`, payload())).response.status, 404);
  }
  assert.equal((await f.request('/invitations/1/invite', payload(), { 'Content-Type': 'text/plain' })).response.status, 400);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('logout and session expiry during client preflight prevent the final invitation dispatch', async t => {
  for (const publicInvites of [false, true]) for (const revoke of ['logout', 'expire']) await t.test(`${publicInvites} ${revoke}`, async t => {
    const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
    const f = await fixture(t, { publicInvites, beforeSend: async () => { entered.resolve(); await gate.promise; } });
    await f.login();
    const pending = f.request('/invitations/1/invite', payload()); await entered.promise;
    if (revoke === 'logout') await f.request('/logout', {}); else f.advance(3600001);
    gate.resolve();
    assert.equal((await pending).response.status, 401); assert.equal(f.sent.length, 0);
  });
});

test('authority is checked again after a delayed request body before client work starts', async t => {
  const f = await fixture(t, { publicInvites: true }); await f.login();
  const entered = deferred(), gate = deferred(), readBody = f.web.body.bind(f.web);
  t.after(() => gate.resolve());
  f.web.body = async req => { const value = await readBody(req); entered.resolve(); await gate.promise; return value; };
  const pending = f.request('/invitations/1/invite', payload()); await entered.promise;
  f.auth.logout(f.auth.get(f.cookie())); gate.resolve();
  assert.equal((await pending).response.status, 401); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('disabled clients and upstream failures return safe errors without reflecting private bodies', async t => {
  const absent = await fixture(t, { publicInvites: true, enabled: false });
  assert.equal((await absent.request('/invitations')).body.enabled, false);
  await absent.request('/session'); assert.equal((await absent.request('/invitations/1/refresh', {})).response.status, 503);
  let failure = new Error(PRIVATE);
  const f = await fixture(t, { publicInvites: true, invite: () => { throw failure; } }); await f.request('/session');
  let result = await f.request('/invitations/1/invite', payload());
  assert.equal(result.response.status, 500); assert.equal(typeof result.body.error, 'string');
  failure = new InvitationError('NO_SEATS', '当前没有可邀请名额。', 409);
  result = await f.request('/invitations/1/invite', payload());
  assert.equal(result.response.status, 409); assert.deepEqual(result.body.error, { code: 'NO_SEATS', message: '当前没有可邀请名额。' });
  failure = new InvitationError('BUSY', '邀请较频繁，请稍后重试。', 429); failure.retryAfterSeconds = 3;
  result = await f.request('/invitations/1/invite', payload());
  assert.equal(result.response.status, 429); assert.equal(result.response.headers.get('retry-after'), '3');
});
