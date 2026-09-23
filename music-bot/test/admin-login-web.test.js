import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RoomAccess } from '../src/room-access.js';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';
import { UserError } from '../src/util.js';

// All credentials, identities, rooms and HTTP listeners in this file are local fixtures.
const username = 'fixture-admin';
const password = 'test-only-password-01';
const replacement = 'test-only-password-02';

async function fixture(t, { enableLogin = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-admin-http-'));
  const config = readConfig({ KOOK_TOKEN: 'fixture-token', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false' });
  config.webHost = '127.0.0.1'; config.webPort = 0;
  const access = await new RoomAccess({ dataDir: dir }).init();
  if (enableLogin) await access.setAdminLogin(username, password);
  const runtimes = new Map(['default', 'second'].map((id) => [id, {
    id, config, status: 'ready', name: id,
    player: { volume: 50, snapshot() { return { volume: this.volume, queue: [], current: null }; },
      async control(action, data) { if (action === 'volume') this.volume = data.value; } },
  }]));
  const manager = {
    get(id) { const value = runtimes.get(id); if (!value) throw new UserError('Unknown fixture room'); return value; },
    list() { return [...runtimes.values()].map(({ id, name }) => ({ id, name, status: 'ready', online: true })); },
    withBot(id, fn) { return fn(this.get(id)); },
  };
  const rooms = { record() {}, async lobby(actorId) { return [{ id: 'default', role: access.role(actorId, 'default') }]; } };
  const music = { account: async () => ({ loggedIn: true, name: 'Fixture music account' }) };
  const web = new WebConsole({ config, access, rooms, manager, music });
  const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  async function raw(route, data, headers = {}) {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function client(name = '') {
    const jar = new Map(); let csrf;
    const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const call = async (route, data, overrides = {}) => {
      const headers = { Cookie: cookie(), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...overrides };
      for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
      const result = await raw(route, data, headers);
      for (const entry of result.headers.getSetCookie()) {
        const pair = entry.split(';')[0], split = pair.indexOf('='); jar.set(pair.slice(0, split), pair.slice(split + 1));
      }
      if (result.body.csrf) csrf = result.body.csrf;
      return result;
    };
    const session = await call('/api/session'); assert.equal(session.status, 200);
    if (name) assert.equal((await call('/api/identity/profile', { name })).status, 200);
    return { call, jar, id: session.body.actor.id, csrf: () => csrf, cookie,
      login: () => call('/api/admin/login', { username, password }),
      session: () => call('/api/session') };
  }
  t.after(async () => {
    await web.close();
    assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-admin-http-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { access, web, raw, client, dir, runtimes };
}

test('administrator login requires a room session, same-origin requests and CSRF; bad credentials do not disclose details', async (t) => {
  const f = await fixture(t), guest = await f.client();
  const session = (await guest.session()).body;
  assert.equal(session.passwordRequired, false); assert.equal(session.accessControlled, true);
  assert.equal(session.adminLoginEnabled, true); assert.equal(session.actor.siteAdmin, false);
  assert.equal((await guest.call('/api/admin/status')).status, 403);
  assert.equal((await f.raw('/api/admin/login', { username, password })).status, 401);
  assert.equal((await guest.call('/api/admin/login', { username, password }, { 'X-CSRF-Token': null })).status, 403);
  assert.equal((await guest.call('/api/admin/login', { username, password }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await guest.call('/api/admin/login', { username, password }, { Origin: 'https://foreign.example' })).status, 403);
  const wrongName = await guest.call('/api/admin/login', { username: 'absent-admin', password });
  const wrongPassword = await guest.call('/api/admin/login', { username, password: 'incorrect-password' });
  assert.equal(wrongName.status, 401); assert.equal(wrongPassword.status, 401);
  assert.deepEqual(wrongName.body, wrongPassword.body);
  assert.deepEqual(Object.keys(wrongPassword.body), ['error']);
  assert.equal(JSON.stringify(wrongPassword.body).includes(username), false);
  assert.equal(JSON.stringify(wrongName.body).includes(password), false);
  const query = `/api/admin/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  assert.equal((await guest.call(query)).status, 400);
  assert.equal((await guest.call(query, {})).status, 401);
  assert.equal((await guest.session()).body.actor.siteAdmin, false);
  assert.equal((await guest.call('/api/admin/password', { newPassword: replacement, currentPassword: password, siteAdmin: true })).status, 403);
});

test('successful login rotates CSRF and identity cookies and rejects pre-login cookie replay', async (t) => {
  const f = await fixture(t), member = await f.client('Listener');
  const oldCookie = member.cookie(), oldIdentity = member.jar.get('kook_identity'), oldCsrf = member.csrf();
  const result = await member.login();
  assert.equal(result.status, 200); assert.equal(result.body.actor.id, member.id);
  assert.equal(result.body.actor.name, 'Listener'); assert.equal(result.body.actor.siteAdmin, true);
  assert.notEqual(member.csrf(), oldCsrf); assert.notEqual(member.jar.get('kook_identity'), oldIdentity);
  assert.equal(result.headers.getSetCookie().length, 2);
  for (const cookie of result.headers.getSetCookie()) {
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
  }
  assert.deepEqual((await member.call('/api/admin/status')).body, { enabled: true, username });
  assert.equal((await member.call('/api/account')).status, 200);
  assert.equal((await f.raw('/api/admin/status', undefined, { Cookie: oldCookie })).status, 401);
  assert.equal((await member.call('/api/admin/logout', {}, { 'X-CSRF-Token': oldCsrf })).status, 403);
  const mixedCookie = `kook_session=${member.jar.get('kook_session')}; kook_identity=${oldIdentity}`;
  assert.equal((await f.raw('/api/admin/status', undefined, { Cookie: mixedCookie })).status, 401);
  const replayed = await f.raw('/api/session', undefined, { Cookie: oldCookie });
  assert.equal(replayed.status, 200); assert.equal(replayed.body.actor.siteAdmin, false);
  assert.notEqual(replayed.body.actor.id, member.id);
  assert.equal((await member.call('/api/admin/status')).status, 200);
  const state = await readFile(path.join(f.dir, 'room-access.json'), 'utf8');
  assert.equal(state.includes(password), false); assert.equal(state.includes(member.jar.get('kook_identity')), false);
  assert.equal(JSON.stringify(result.body).includes('hash'), false);
});

test('administrator logout preserves nickname and an explicit DJ role while invalidating the old management session', async (t) => {
  const f = await fixture(t), admin = await f.client('Host'), dj = await f.client('Room DJ'), ordinary = await f.client('Listener');
  assert.equal((await admin.login()).status, 200);
  const invite = await admin.call('/api/room/invite', { botId: 'default', role: 'dj' }); assert.equal(invite.status, 200);
  assert.equal((await dj.call('/api/access/redeem', { token: invite.body.token })).status, 200);
  assert.equal((await dj.login()).status, 200);
  const oldCookie = dj.cookie(), oldCsrf = dj.csrf();
  const result = await dj.call('/api/admin/logout', {});
  assert.equal(result.status, 200); assert.equal(result.body.actor.id, dj.id);
  assert.equal(result.body.actor.name, 'Room DJ'); assert.equal(result.body.actor.siteAdmin, false);
  assert.notEqual(dj.csrf(), oldCsrf);
  assert.equal((await f.raw('/api/admin/status', undefined, { Cookie: oldCookie })).status, 401);
  assert.equal((await dj.call('/api/admin/status')).status, 403);
  assert.equal((await dj.call('/api/account')).status, 403);
  const session = (await dj.session()).body;
  assert.equal(session.roles.default, 'dj'); assert.equal(session.roles.second, 'member');
  assert.equal((await dj.call('/api/control', { botId: 'default', action: 'volume', value: 25 })).status, 200);
  assert.equal((await dj.call('/api/control', { botId: 'second', action: 'volume', value: 25 })).status, 403);
  assert.equal((await ordinary.call('/api/control', { botId: 'default', action: 'volume', value: 70 })).status, 403);
  assert.equal((await ordinary.session()).body.actor.name, 'Listener');
  assert.equal((await ordinary.call('/api/rooms')).status, 200);
});

test('changing the administrator password requires current credentials and revokes other management sessions without deleting room roles', async (t) => {
  const f = await fixture(t), a = await f.client('First admin'), b = await f.client('Second admin'), owner = await f.client('Room owner');
  assert.equal((await a.login()).status, 200); assert.equal((await b.login()).status, 200);
  const invite = await a.call('/api/room/invite', { botId: 'default', role: 'owner' });
  assert.equal((await owner.call('/api/access/redeem', { token: invite.body.token })).status, 200);
  assert.equal((await owner.call('/api/admin/password', { currentPassword: password, newPassword: replacement })).status, 403);
  assert.equal((await a.call('/api/admin/password', { currentPassword: 'wrong-password', newPassword: replacement })).status, 401);
  assert.equal((await b.call('/api/admin/status')).status, 200);
  const oldCookie = a.cookie(), oldIdentity = a.jar.get('kook_identity'), oldCsrf = a.csrf();
  const updated = await a.call('/api/admin/password', { currentPassword: password, newPassword: replacement });
  assert.equal(updated.status, 200); assert.equal(updated.body.actor.id, a.id); assert.equal(updated.body.actor.siteAdmin, true);
  assert.notEqual(a.jar.get('kook_identity'), oldIdentity); assert.notEqual(a.csrf(), oldCsrf);
  assert.equal((await f.raw('/api/admin/status', undefined, { Cookie: oldCookie })).status, 401);
  assert.equal((await a.call('/api/admin/status')).status, 200);
  assert.equal((await b.call('/api/admin/status')).status, 403);
  const lostAdmin = (await b.session()).body;
  assert.equal(lostAdmin.actor.id, b.id); assert.equal(lostAdmin.actor.name, 'Second admin'); assert.equal(lostAdmin.actor.siteAdmin, false);
  const preservedOwner = (await owner.session()).body;
  assert.equal(preservedOwner.roles.default, 'owner'); assert.equal(preservedOwner.actor.siteAdmin, false);
  assert.equal((await b.login()).status, 401);
  assert.equal((await b.call('/api/admin/login', { username, password: replacement })).status, 200);
  const saved = await readFile(path.join(f.dir, 'room-access.json'), 'utf8');
  assert.equal(saved.includes(password), false); assert.equal(saved.includes(replacement), false);
});

test('migration disables the old administrator link while keeping room invitations, members and existing room managers usable', async (t) => {
  const f = await fixture(t, { enableLogin: false }), legacy = await f.client('Original host'), invited = await f.client('DJ invite'), member = await f.client('Listener');
  const token = await f.access.rotateAdminLink();
  assert.equal((await legacy.call('/api/access/redeem', { token })).status, 200);
  const invite = await legacy.call('/api/room/invite', { botId: 'default', role: 'dj' }); assert.equal(invite.status, 200);
  const before = (await member.session()).body;
  await f.access.setAdminLogin(username, password);
  assert.equal((await member.call('/api/access/redeem', { token })).status, 400);
  assert.equal((await invited.call('/api/access/redeem', { token: invite.body.token })).status, 200);
  assert.equal((await invited.session()).body.roles.default, 'dj');
  const after = (await member.session()).body;
  assert.equal(after.actor.id, before.actor.id); assert.equal(after.actor.name, before.actor.name);
  assert.equal(after.actor.siteAdmin, false); assert.equal(after.roles.default, 'member');
  assert.equal(after.adminLoginEnabled, true);
  assert.equal((await legacy.call('/api/admin/status')).status, 200);
  assert.equal((await invited.call('/api/control', { botId: 'default', action: 'volume', value: 40 })).status, 200);
});
