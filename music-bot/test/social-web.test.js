import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RoomAccess } from '../src/room-access.js';
import { SocialRooms } from '../src/social-rooms.js';
import { Player } from '../src/player.js';
import { RoomFeatures } from '../src/room-features.js';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';
import { parseMusicInput } from '../src/music-input.js';
import { UserError } from '../src/util.js';

const song = (id) => ({ id: String(id), name: `Song ${id}`, artists: 'Artist', source: 'netease', durationMs: 180000 });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-social-web-'));
  const config = readConfig({ KOOK_TOKEN: 'never-show-token', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, MAX_QUEUE_SIZE: '500', WEB_REQUIRE_PASSWORD: 'false' }); config.webPort = 0;
  let clock = Date.now();
  const music = { parseInput: async (input, options) => parseMusicInput(input, options), resolve: async (id) => song(id), stream: async () => 'fixture',
    account: async () => ({ loggedIn: true, name: 'Private account' }), playlist: async (_, limit) => Array.from({ length: Math.min(limit, 20) }, (_, i) => song(100 + i)) };
  const api = { request: async (route) => route === 'channel/user-list' ? [{ id: '11', username: 'Voice human', bot: false }, { id: '12', username: 'Bot', bot: true }] : {}, post: async () => ({}) };
  const audio = { start: (_, voice, volume, offset) => ({ seconds: offset, paused: false, stop: async () => {}, setVolume: async () => {} }) };
  const runtimes = new Map();
  for (const id of ['default', 'second']) {
    const cfg = { ...config, dataDir: path.join(dir, id) }, player = new Player(cfg, api, music, audio, async () => {});
    await player.add({ guildId: '100', voiceChannelId: id === 'default' ? '200' : '201', textChannelId: '300' }, [song(1)]);
    const features = new RoomFeatures({ config: cfg, player, api, music, selfId: '12', intervalMs: 999999 }); await features.init();
    runtimes.set(id, { id, config: cfg, name: id, player, features, api, gateway: { ready: true }, status: 'ready', self: { username: id } });
  }
  const manager = { list() { return [...runtimes.values()].map((r) => this.describe(r)); },
    describe(r) { return { id: r.id, name: r.name, status: r.status, online: true, context: r.player.context, guildIds: ['100'] }; },
    get(id) { const value = runtimes.get(id); if (!value) throw new UserError('未知机器人'); return value; },
    withBot(id, fn) { return fn(this.get(id)); } };
  const access = await new RoomAccess({ dataDir: dir }).init(), adminToken = await access.rotateAdminLink();
  const rooms = await new SocialRooms({ config, manager, music, access, now: () => clock }).init(); rooms.start();
  const web = new WebConsole({ config, manager, music, access, rooms }); const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  async function client(name, admin = false) {
    const jar = new Map(); let csrf;
    const request = async (route, data, overrides = {}) => {
      const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
        headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...overrides },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], split = pair.indexOf('='); jar.set(pair.slice(0, split), pair.slice(split + 1)); }
      return response;
    };
    const response = await request('/api/session'), state = await response.json(); csrf = state.csrf;
    assert.equal(response.headers.getSetCookie().length, 2); assert.equal(state.accessControlled, true); assert.equal(state.passwordRequired, false);
    if (name) assert.equal((await request('/api/identity/profile', { name })).status, 200);
    if (admin) assert.equal((await request('/api/access/redeem', { token: adminToken })).status, 200);
    return { request, id: state.actor.id, jar, session: () => request('/api/session').then((r) => r.json()) };
  }
  t.after(async () => { await web.close(); await rooms.close(); for (const r of runtimes.values()) { await r.features.close(); await r.player.shutdown(); }
    assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-social-web-')); await rm(dir, { recursive: true, force: true }); });
  return { web, rooms, access, music, runtimes, dir, adminToken, client, tick: () => { clock += 3000; } };
}

test('public room identity cannot use old admin routes or leak credentials through reads and shares', async (t) => {
  const f = await fixture(t), guest = await f.client(), member = await f.client('Alice');
  for (const [route, data] of [
    ['/api/control', { botId: 'default', action: 'volume', value: 0 }], ['/api/play', { input: '2' }],
    ['/api/playlist', { id: '100' }], ['/api/hot', {}], ['/api/heart', {}], ['/api/bots/add', { token: 'forged' }],
    ['/api/account/logout', {}], ['/api/channel', {}], ['/api/settings', { stayConnected: false }], ['/api/features', { section: 'radio', value: { enabled: true } }],
  ]) assert.equal((await member.request(route, data)).status, 403, route);
  for (const route of ['/api/account', '/api/account/qr', '/api/discover?category=mine', '/api/features', '/api/room/roles']) {
    assert.equal((await member.request(route)).status, 403, route);
  }
  const session = await guest.session(); assert.equal(session.actor.siteAdmin, false);
  const before = f.runtimes.get('default').player.queue.length;
  assert.equal((await guest.request('/api/room/request', { botId: 'default', input: '2', actorId: member.id, role: 'owner' })).status, 403);
  assert.equal(f.runtimes.get('default').player.queue.length, before);
  await member.request('/api/room?botId=default');
  // Voice membership is refreshed in the background so it cannot stall controls.
  await new Promise((resolve) => setImmediate(resolve));
  const room = await (await member.request('/api/room?botId=default')).json(); assert.equal(room.permissions.manageRoom, false);
  assert.equal(room.members.voiceCount, 1); assert.equal(room.members.webCount, 0);
  const share = await (await member.request('/api/room/share?botId=default')).json(); assert.ok(share.qr.startsWith('data:image/png'));
  assert.equal(new URL(share.url).hash, ''); assert.equal(new URL(share.url).pathname, '/room/default');
  assert.equal(JSON.stringify({ room, share, session }).includes(f.adminToken), false);
  assert.equal((await member.request('/api/room/heartbeat', { botId: 'default' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await member.request('/api/room/heartbeat', { botId: 'default' }, { Origin: 'https://foreign.example' })).status, 403);
});

test('room controls cancel earlier administrator music lookups before they can refill the queue', async (t) => {
  const cases = [
    { route: '/api/play', data: { input: '2' }, method: 'resolve', action: 'clear', result: song(2) },
    { route: '/api/playlist', data: { id: '99' }, method: 'playlist', action: 'pause', result: [song(2)] },
    { route: '/api/hot', data: {}, method: 'hot', action: 'skip', result: { name: 'Hot', tracks: [song(2)] } },
    { route: '/api/heart', data: {}, method: 'heart', action: 'stop', result: { name: 'Heart', tracks: [song(2)] } },
    { label: 'link expansion', route: '/api/play', data: { input: '2' }, method: 'parseInput', action: 'clear',
      result: { kind: 'song', id: '2', input: '2', source: 'netease' } },
  ];
  for (const scenario of cases) await t.test(scenario.label || scenario.route, async (t) => {
    const f = await fixture(t), admin = await f.client('Admin', true), member = await f.client('Listener');
    const pending = deferred(), entered = deferred(), p = f.runtimes.get('default').player;
    t.after(() => pending.resolve(scenario.result));
    f.music[scenario.method] = async () => { entered.resolve(); return pending.promise; };
    const request = admin.request(scenario.route, { botId: 'default', ...scenario.data });
    await entered.promise;
    if (scenario.action === 'stop') await p.control('stop');
    else assert.equal((await member.request('/api/room/control', {
      botId: 'default', action: scenario.action, expectedVoiceChannelId: '200',
    })).status, 200);
    const afterControl = p.snapshot(), intentAfterControl = p.intent;
    pending.resolve(scenario.result);
    const response = await request;
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /状态已变化|频道已变化/);
    assert.equal(p.queue.length, 0);
    assert.equal(p.current?.id, afterControl.current?.id);
    assert.equal(p.intent, intentAfterControl);
    assert.deepEqual(p.context, afterControl.context);
    assert.equal(f.runtimes.get('second').player.current.id, '1');
  });
});

test('a room volume change preserves an in-flight administrator song request', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true), member = await f.client('Listener');
  const pending = deferred(), entered = deferred(), p = f.runtimes.get('default').player;
  t.after(() => pending.resolve(song(2)));
  f.music.resolve = async () => { entered.resolve(); return pending.promise; };
  const request = admin.request('/api/play', { botId: 'default', input: '2' }); await entered.promise;
  assert.equal((await member.request('/api/room/control', {
    botId: 'default', action: 'volume', value: 25, expectedVoiceChannelId: '200',
  })).status, 200);
  pending.resolve(song(2)); assert.equal((await request).status, 200);
  assert.equal(p.volume, 25); assert.equal(p.current.id, '1');
  assert.deepEqual(p.queue.map((track) => track.id), ['2']);
});

test('my requests retain server ownership and only their stable waiting entry can be withdrawn', async (t) => {
  const f = await fixture(t), a = await f.client('Alice'), b = await f.client('Bob');
  await a.request('/api/room/heartbeat', { botId: 'default' }); await a.request('/api/room/heartbeat', { botId: 'default' }); await b.request('/api/room/heartbeat', { botId: 'default' });
  assert.equal((await a.request('/api/room/request', { botId: 'default', input: '2', requestedBy: `room:${b.id}` })).status, 200);
  assert.equal((await b.request('/api/room/request', { botId: 'default', input: '3' })).status, 200);
  const room = await (await a.request('/api/room?botId=default')).json(); assert.equal(room.mine.length, 1); assert.equal(room.members.webCount, 2);
  const entryId = room.mine[0].entryId; assert.equal(room.mine[0].requester.id, a.id); assert.equal(room.mine[0].requester.name, 'Alice');
  assert.equal((await b.request('/api/room/withdraw', { botId: 'default', entryId })).status, 400);
  assert.equal((await a.request('/api/room/withdraw', { botId: 'second', entryId })).status, 400);
  await f.runtimes.get('default').player.control('move', { from: 1, to: 2 });
  assert.equal((await a.request('/api/room/withdraw', { botId: 'default', entryId })).status, 200);
  assert.deepEqual(f.runtimes.get('default').player.queue.map((track) => track.id), ['3']);
  assert.equal((await a.request('/api/room/withdraw', { botId: 'default', entryId })).status, 400);
  f.tick(); assert.equal((await a.request('/api/room/request', { botId: 'default', input: 'https://music.163.com/playlist?id=99' })).status, 200);
  assert.equal((await (await a.request('/api/room?botId=default')).json()).mine.length, 5);
  f.tick(); assert.equal((await a.request('/api/room/request', { botId: 'default', input: '600' })).status, 400);
});

test('room owner and DJ invitations enforce scoped backend permissions and immediate revocation', async (t) => {
  const f = await fixture(t), admin = await f.client('Admin', true), owner = await f.client('Owner'), dj = await f.client('DJ');
  assert.equal((await admin.request('/api/account')).status, 200);
  const invite = await (await admin.request('/api/room/invite', { botId: 'default', role: 'owner' })).json();
  assert.equal((await owner.request('/api/access/redeem', { token: invite.token })).status, 200);
  assert.equal((await owner.request('/api/room/profile', { botId: 'default', title: 'Our room', description: 'Music', theme: 'bamboo' })).status, 200);
  assert.equal((await owner.request('/api/room/profile', { botId: 'second', title: 'Other', description: '', theme: 'bamboo' })).status, 403);
  assert.equal((await owner.request('/api/account/logout', {})).status, 403);
  assert.equal((await owner.request('/api/room/invite', { botId: 'default', role: 'owner' })).status, 403);
  const djInvite = await (await owner.request('/api/room/invite', { botId: 'default', role: 'dj' })).json();
  assert.equal((await dj.request('/api/access/redeem', { token: djInvite.token })).status, 200);
  assert.equal((await dj.request('/api/control', { botId: 'default', action: 'volume', value: 25 })).status, 200);
  assert.equal((await dj.request('/api/control', { botId: 'second', action: 'volume', value: 25 })).status, 403);
  assert.equal((await dj.request('/api/control', { botId: 'default', action: 'stop' })).status, 403);
  assert.equal((await dj.request('/api/room/invite', { botId: 'default', role: 'dj' })).status, 403);
  assert.equal((await owner.request('/api/room/revoke', { botId: 'default', targetId: dj.id })).status, 200);
  assert.equal((await dj.request('/api/control', { botId: 'default', action: 'volume', value: 70 })).status, 403);
  assert.equal(f.runtimes.get('default').player.volume, 25);
  const safe = await (await owner.request('/api/room/roles?botId=default')).json();
  assert.equal(JSON.stringify(safe).includes('hash'), false); assert.equal(JSON.stringify(safe).includes(djInvite.token), false);
  const saved = await readFile(path.join(f.dir, 'room-access.json'), 'utf8'); assert.equal(saved.includes(f.adminToken), false);
});

test('members share room playback controls while administrator access and other bot state remain restricted', async (t) => {
  const f = await fixture(t), guest = await f.client(), member = await f.client('Listener');
  const p = f.runtimes.get('default').player, other = f.runtimes.get('second').player;
  const action = (action, value, client = member, channel = '200') => client.request('/api/room/control', { botId: 'default', action, value, expectedVoiceChannelId: channel });
  assert.equal((await action('volume', 35, guest)).status, 403);
  assert.equal((await action('volume', 35, member, '201')).status, 400);
  const stream = p.stream;
  assert.equal((await action('volume', 35)).status, 200); assert.equal(p.volume, 35); assert.equal(p.stream, stream); assert.equal(other.volume, 60);
  const state = await (await member.request('/api/state?botId=default')).json();
  assert.equal(state.permissions.playbackControl, true); assert.equal(state.permissions.control, false); assert.equal(state.permissions.manageRoom, false);
  const room = await (await member.request('/api/room?botId=default')).json(); assert.equal(room.permissions.playbackControl, true);
  p.stream.seconds = 34;
  assert.equal((await action('pause')).status, 200); assert.equal(p.intent, 'paused'); assert.equal(p.snapshot().seconds, 34);
  assert.equal((await action('resume')).status, 200); assert.equal(p.snapshot().status, 'playing'); assert.equal(p.snapshot().seconds, 34);
  assert.equal((await action('seek', 50)).status, 200); assert.equal(p.snapshot().seconds, 50);
  assert.equal((await action('loop', 'all')).status, 200); assert.equal(p.mode, 'all');
  await p.add(p.context, [song(2), song(3)]);
  assert.equal((await action('shuffle')).status, 200);
  assert.equal((await action('skip')).status, 200); assert.equal(p.history.length, 1);
  assert.equal((await action('previous')).status, 200); assert.equal(p.current.id, '1');
  const current = p.current.entryId;
  assert.equal((await action('clear')).status, 200); assert.equal(p.queue.length, 0); assert.equal(p.current.entryId, current); assert.equal(p.snapshot().status, 'playing');
  assert.equal(other.current.id, '1'); assert.equal(other.queue.length, 0); assert.equal(other.volume, 60);
  for (const forbidden of ['stop', 'stay', 'features', 'remove']) assert.equal((await action(forbidden)).ok, false);
  assert.equal((await action('volume', 101)).ok, false); assert.equal((await action('loop', 'invalid')).ok, false);
  assert.equal((await member.request('/api/control', { botId: 'default', action: 'volume', value: 99 })).status, 403);
  assert.equal(p.volume, 35);
  assert.equal((await member.request('/api/room/invite', { botId: 'default', role: 'dj' })).status, 403);
  assert.equal((await member.request('/api/account')).status, 403);
});
