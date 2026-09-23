import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RoomAccess } from '../src/room-access.js';
import { SocialRooms } from '../src/social-rooms.js';
import { RoomFeatures } from '../src/room-features.js';
import { Player } from '../src/player.js';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const cookieText = (jar) => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
function absorb(jar, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Request did not enter operation'); await new Promise(setImmediate); }
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-room-permission-review-'));
  const config = readConfig({ KOOK_TOKEN: 'fixture-token', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false' }); config.webPort = 0;
  const calls = { discover: 0, voiceJoin: 0 }; let catalogGate;
  const music = { account: async () => ({ loggedIn: true, name: 'Private account' }), discover: async () => { calls.discover++; return [{ id: '1', name: 'Private playlist' }]; } };
  const api = { async request(route, params) {
    if (route === 'guild/view') { if (catalogGate) await catalogGate.promise; return { id: '100', name: 'Guild' }; }
    if (route === 'channel/list') return { items: [{ id: params.type === 2 ? '200' : '300', name: 'Channel', type: params.type }], meta: { page_total: 1 } };
    if (route === 'channel/user-list') return [];
    return {};
  }, async post(route) { if (route === 'voice/join') calls.voiceJoin++; return {}; } };
  const runtimes = new Map();
  for (const id of ['default', 'second']) {
    const cfg = { ...config, dataDir: path.join(dir, id) }, player = new Player(cfg, api, music, {}, async () => {});
    player.context = { guildId: '100', voiceChannelId: id === 'default' ? '200' : '201', textChannelId: '300' };
    const features = await new RoomFeatures({ config: cfg, player, api, music, selfId: '10', intervalMs: 999999 }).init();
    runtimes.set(id, { id, config: cfg, name: id, player, features, api, status: 'ready', gateway: { ready: true } });
  }
  const manager = { runtimes, get: (id) => runtimes.get(id), describe: (runtime) => ({ id: runtime.id, name: runtime.name, online: true, status: 'ready', guildIds: ['100'] }),
    list() { return [...runtimes.values()].map(this.describe); }, withBot(id, fn) { return fn(this.get(id)); } };
  const access = await new RoomAccess({ dataDir: dir }).init(), managementLink = await access.rotateAdminLink();
  const rooms = await new SocialRooms({ config, manager, music, access }).init(); rooms.start();
  const web = new WebConsole({ config, manager, music, access, rooms }); const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  const raw = (route, { cookie = '', csrf, data } = {}) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  async function client(name, siteAdmin = false) {
    const jar = new Map(); let csrf;
    const response = await raw('/api/session'); absorb(jar, response); const session = await response.json(); csrf = session.csrf;
    const request = async (route, data) => { const result = await raw(route, { cookie: cookieText(jar), csrf, data }); absorb(jar, result); return result; };
    if (name) await request('/api/identity/profile', { name });
    if (siteAdmin) await request('/api/access/redeem', { token: managementLink });
    return { id: session.actor.id, jar, csrf, initialCookies: response.headers.getSetCookie(), request };
  }
  t.after(async () => {
    catalogGate?.resolve(); await web.close(); await rooms.close();
    for (const runtime of runtimes.values()) { await runtime.features.close(); await runtime.player.shutdown(); }
    assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true });
  });
  return { access, web, raw, client, calls, runtimes, gateCatalog: (gate) => { catalogGate = gate; } };
}

test('duplicate GET parameters cannot select private data after authorization checks a different value', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true), owner = await f.client('Owner');
  await f.access.redeem(owner.id, (await f.access.issueInvite(admin.id, 'default', 'owner')).token);
  for (const route of ['/api/discover?category=mine&category=hot', '/api/discover?category=hot&category=mine',
    '/api/features?botId=second&botId=default', '/api/features?botId=default&botId=second']) {
    const response = await owner.request(route); assert.equal(response.status, 400, route);
    assert.ok(!(await response.text()).includes('Private playlist'));
  }
  assert.equal(f.calls.discover, 0);
  assert.equal((await owner.request('/api/features?botId=default')).status, 200);
  assert.equal((await owner.request('/api/features?botId=second')).status, 403);
});

test('logout invalidates copied identity and CSRF cookies even after a fresh session request', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true);
  assert.equal(admin.initialCookies.length, 2);
  assert.ok(admin.initialCookies.every((cookie) => cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict')));
  const old = cookieText(admin.jar), oldCsrf = admin.csrf, identity = admin.jar.get('kook_identity');
  const logout = await admin.request('/api/logout', {}); assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().every((cookie) => cookie.includes('Max-Age=0')));
  assert.equal(f.access.get(identity), null);
  assert.equal((await f.raw('/api/account', { cookie: old })).status, 401);
  assert.equal((await f.raw('/api/account/logout', { cookie: old, csrf: oldCsrf, data: {} })).status, 401);
  const renewed = await f.raw('/api/session', { cookie: old }); const state = await renewed.json(), replayJar = new Map(admin.jar);
  absorb(replayJar, renewed);
  assert.notEqual(state.actor.id, admin.id); assert.equal(state.actor.siteAdmin, false); assert.notEqual(state.csrf, oldCsrf);
  assert.equal((await f.raw('/api/account/logout', { cookie: cookieText(replayJar), csrf: state.csrf, data: {} })).status, 403);
  assert.equal((await f.raw('/api/account/logout', { cookie: cookieText(replayJar), csrf: oldCsrf, data: {} })).status, 403);
});

test('identity cookie substitution cannot reuse another identity session or its CSRF after renewal', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true), member = await f.client('Member');
  const substituted = new Map(admin.jar); substituted.set('kook_identity', member.jar.get('kook_identity'));
  const headers = { cookie: cookieText(substituted), csrf: admin.csrf, data: { botId: 'default', action: 'volume', value: 20 } };
  assert.equal((await f.raw('/api/control', headers)).status, 401);
  const renewal = await f.raw('/api/session', { cookie: cookieText(substituted) }), state = await renewal.json();
  assert.equal(state.actor.id, member.id); assert.equal(state.actor.siteAdmin, false);
  assert.notEqual(state.csrf, admin.csrf, 'Switching identities rotates the CSRF session');
  absorb(substituted, renewal);
  assert.equal((await f.raw('/api/control', { ...headers, cookie: cookieText(substituted) })).status, 403);
  assert.equal((await f.raw('/api/account', { cookie: cookieText(admin.jar) })).status, 401, 'The previous session must remain invalid');
});

test('owner revocation during queued settings, room configuration and slow catalog lookup prevents late mutations', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true), owner = await f.client('Owner');
  const runtime = f.runtimes.get('default');
  for (const kind of ['stay', 'features', 'channel']) {
    await f.access.redeem(owner.id, (await f.access.issueInvite(admin.id, 'default', 'owner')).token);
    const gate = deferred(), entered = deferred(); let blocking;
    if (kind === 'stay') blocking = runtime.player.exclusive(async () => { entered.resolve(); await gate.promise; });
    else if (kind === 'features') blocking = runtime.features.serialize(async () => { entered.resolve(); await gate.promise; });
    else { f.gateCatalog(gate); entered.resolve(); }
    await entered.promise;
    const route = kind === 'stay' ? '/api/settings' : kind === 'features' ? '/api/features' : '/api/channel';
    const data = kind === 'stay' ? { botId: 'default', stayConnected: true } : kind === 'features'
      ? { botId: 'default', section: 'radio', value: { enabled: true } }
      : { botId: 'default', guildId: '100', voiceChannelId: '200', textChannelId: '300' };
    const request = owner.request(route, data);
    try {
      await until(() => f.web.mutations.has('bot:default'));
      await f.access.revoke(admin.id, 'default', owner.id);
    } finally { gate.resolve(); }
    await blocking; assert.equal((await request).status, 403, kind);
    assert.equal(runtime.player.stayConnected, false); assert.equal(runtime.features.radio.enabled, false); assert.equal(f.calls.voiceJoin, 0);
  }
});
