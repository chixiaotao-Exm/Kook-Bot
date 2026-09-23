import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Player } from '../src/player.js';
import { SocialRooms } from '../src/social-rooms.js';
import { readConfig } from '../src/config.js';
import { UserError } from '../src/util.js';

const track = (id) => ({ id: String(id), source: 'netease', name: `Song ${id}`, artists: 'Singer', durationMs: 180000 });
const context = { guildId: '100', voiceChannelId: '200', textChannelId: '300' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kook-social-test-'));
  const config = readConfig({ KOOK_TOKEN: 'secret-live-token', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, MAX_QUEUE_SIZE: '500', STAY_CONNECTED: 'true' });
  let now = Date.parse('2026-09-18T11:59:00Z'); const calls = [], handles = [];
  const api = { async post(endpoint, params) { calls.push({ endpoint, params }); return {}; }, async request(endpoint) {
    calls.push({ endpoint }); return [{ id: '400', username: '听众', bot: false }, { id: '1', username: '音乐机器人', bot: true }]; } };
  const audio = { connected: false, async connect() { this.connected = true; }, async disconnect() { this.connected = false; },
    start(media, voice, volume, offset, onEnd) { const handle = { seconds: offset, onEnd, paused: false, async stop() {}, async setVolume() {} }; handles.push(handle); return handle; } };
  const music = { async stream(item) { return item.id; }, async parseInput(input, { source = 'netease', kind }) { return { source, kind: kind || 'song', id: input }; },
    async resolve(id) { return track(id); }, async playlist(id, limit) { return Array.from({ length: Math.min(limit, 12) }, (_, i) => track(i + 1)); } };
  const actors = new Map([['a', { id: 'a', name: '小桃', siteAdmin: false }], ['b', { id: 'b', name: '小叶', siteAdmin: false }],
    ['dj', { id: 'dj', name: 'DJ', siteAdmin: false }], ['owner', { id: 'owner', name: '房主', siteAdmin: false }], ['admin', { id: 'admin', name: '站长', siteAdmin: true }]]);
  const roles = new Map([['a', 'member'], ['b', 'member'], ['dj', 'dj'], ['owner', 'owner'], ['admin', 'owner']]);
  const access = { actor: (id) => actors.get(id) || null, role: (id) => roles.get(id) || 'guest', require(id, room, role) {
    if (!actors.has(id) || ['guest', 'member', 'dj', 'owner'].indexOf(this.role(id, room)) < ['guest', 'member', 'dj', 'owner'].indexOf(role)) throw new UserError('无操作权限。'); return actors.get(id);
  } };
  const player = new Player(config, api, music, audio, async () => {});
  const runtime = { id: 'default', status: 'ready', config, api, player, gateway: { ready: true }, features: { rules: { enabled: false, perUserLimit: 5 } } };
  const listeners = new Set();
  const manager = { closed: false, runtimes: new Map([['default', runtime]]),
    publicText: (value) => String(value || '').split(config.token).join('***'),
    get(id) { const value = this.runtimes.get(id); if (!value) throw new UserError('找不到机器人。'); return value; },
    describe: (item) => ({ id: item.id, name: '美团外卖', status: item.status, online: item.status === 'ready' }),
    list() { return [...this.runtimes.values()].map(this.describe); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
  };
  const rooms = new SocialRooms({ config, manager, music, access, now: () => now }); await rooms.init(); rooms.start(); await player.join(context);
  t.after(async () => { await rooms.close(); await player.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, api, music, audio, player, runtime, manager, access, actors, roles, rooms, handles, calls, now: () => now, advance: (ms) => { now += ms; } };
}

test('public room reads do not create presence, and duplicate tab heartbeats expire as one web visitor', async (t) => {
  const f = await fixture(t); let state = await f.rooms.room('default', 'a');
  await f.rooms.voice.get('default')?.pending; state = await f.rooms.room('default', 'a');
  assert.equal(state.members.webCount, 0); assert.equal(state.members.voiceCount, 1); assert.equal(state.members.voice.length, 2);
  await f.rooms.heartbeat('default', 'a'); await f.rooms.heartbeat('default', 'a'); state = await f.rooms.room('default', 'a');
  assert.equal(state.members.webCount, 1); assert.equal(state.members.web[0].verified, false); assert.equal(state.members.web[0].isSelf, true);
  assert.equal(state.events.filter((event) => event.kind === 'web_join').length, 1);
  f.advance(60001); state = await f.rooms.room('default', 'a'); assert.equal(state.members.webCount, 0);
  assert.equal(state.events.filter((event) => event.kind === 'web_leave').length, 1);
});

test('voice list reads merge concurrent calls, cache thirty seconds and expose failures as unknown with stale data', async (t) => {
  const f = await fixture(t), pending = deferred(); let reads = 0;
  f.api.request = async () => { reads++; return pending.promise; };
  const first = f.rooms.room('default', 'a'), second = f.rooms.room('default', 'b');
  assert.ok((await Promise.all([first, second])).every((state) => state.members.voiceCount === null && state.members.voiceLoading));
  pending.resolve([{ id: '400', username: '真人', bot: false }, { id: '1', username: 'Bot', bot: true }]); await f.rooms.voice.get('default')?.pending;
  await f.rooms.room('default', 'a'); assert.equal(reads, 1);
  f.advance(30001); f.api.request = async () => { reads++; throw new Error('secret-live-token upstream'); };
  await f.rooms.room('default', 'a'); await f.rooms.voice.get('default')?.pending;
  const state = await f.rooms.room('default', 'a'); assert.equal(reads, 2); assert.equal(state.members.voiceCount, null);
  assert.equal(state.members.voiceStale, true); assert.equal(state.members.voice.length, 2); assert.ok(!JSON.stringify(state).includes('secret-live-token'));
});

test('voice member changes create verified voice activity separately from browser heartbeat activity', async (t) => {
  const f = await fixture(t); await f.rooms.room('default', 'a'); await f.rooms.voice.get('default')?.pending; f.advance(30001);
  f.api.request = async () => [{ id: '401', username: '新听众', bot: false }, { id: '1', username: 'Bot', bot: true }];
  await f.rooms.room('default', 'a'); await f.rooms.voice.get('default')?.pending;
  const state = await f.rooms.room('default', 'a'); assert.equal(state.members.webCount, 0); assert.equal(state.members.voiceCount, 1);
  assert.deepEqual(state.events.filter((event) => event.kind.startsWith('voice_')).map((event) => [event.kind, event.actorName]), [['voice_join', '新听众'], ['voice_leave', '听众']]);
});

test('slow voice fetches never block room/lobby queue, identity or permission refresh', async (t) => {
  const f = await fixture(t), pending = deferred(); let calls = 0;
  f.api.request = async () => { calls++; return pending.promise; };
  const initial = await f.rooms.room('default', 'a'); assert.equal(initial.members.voiceCount, null); assert.equal(initial.members.voiceLoading, true);
  await f.rooms.request('default', 'a', { input: '1' }); f.roles.set('a', 'guest'); f.actors.get('a').name = '新昵称';
  const state = await f.rooms.room('default', 'a'), [card] = await f.rooms.lobby('a');
  assert.equal(state.actor.name, '新昵称'); assert.equal(state.role, 'guest'); assert.equal(state.permissions.request, false);
  assert.equal(state.player.current.id, '1'); assert.equal(card.player.current.id, '1'); assert.equal(card.members.voiceLoading, true); assert.equal(calls, 1);
  pending.resolve([{ id: '401', username: '真人', bot: false }]); await f.rooms.voice.get('default')?.pending;
  assert.equal((await f.rooms.room('default', 'a')).members.voiceCount, 1);
});

test('member requests use server identity and five-song quota; DJ and owner are not member-limited', async (t) => {
  const f = await fixture(t);
  const result = await f.rooms.request('default', 'a', { input: '123', kind: 'playlist', requestedBy: 'room:admin', requestedByName: '伪造站长' });
  assert.equal(result.added, 5); assert.equal(f.player.current.requestedBy, 'room:a'); assert.equal(f.player.current.requestedByName, '小桃');
  assert.equal(new Set([f.player.current, ...f.player.queue].map((item) => item.entryId)).size, 5);
  f.advance(2100); await assert.rejects(f.rooms.request('default', 'a', { input: '90' }), /上限/);
  assert.equal((await f.rooms.request('default', 'dj', { input: '123', kind: 'playlist' })).added, 12);
  assert.equal((await f.rooms.request('default', 'owner', { input: '123', kind: 'playlist' })).added, 12);
  const state = await f.rooms.room('default', 'a'); assert.equal(state.mine.length, 4); assert.equal(state.player.current.mine, true);
  assert.deepEqual(state.queue[0].requester, { id: 'a', name: '小桃', kind: 'web', verified: false });
});

test('in-flight point requests reject duplicates and revoked roles cannot add after provider returns', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.music.resolve = async () => { entered.resolve(); return pending.promise; };
  const request = f.rooms.request('default', 'a', { input: '1' }); await entered.promise;
  await assert.rejects(f.rooms.request('default', 'a', { input: '2' }), /正在处理/);
  f.roles.set('a', 'guest'); pending.resolve(track(1)); await assert.rejects(request, /权限/);
  assert.equal(f.player.current, null); assert.equal(f.player.queue.length, 0);
});

test('stop or changed channel invalidates a slow member request without recreating the room queue', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.music.resolve = async () => { entered.resolve(); return pending.promise; };
  const request = f.rooms.request('default', 'a', { input: '1' }); await entered.promise;
  await f.player.control('stop'); pending.resolve(track(1)); await assert.rejects(request, /状态已变化|频道已变化/);
  assert.equal(f.player.context, null); assert.equal(f.player.current, null);
});

test('personal limit is rechecked inside player lock after another admission changes the queue', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.music.playlist = async () => { entered.resolve(); return pending.promise; };
  const request = f.rooms.request('default', 'a', { input: '1', kind: 'playlist' }); await entered.promise;
  await f.player.add(context, [track(91), track(92), track(93), track(94)].map((item) => ({ ...item, requestedBy: 'room:a', requestedByName: '小桃' })));
  pending.resolve([track(1), track(2), track(3), track(4), track(5)]);
  assert.equal((await request).added, 1); assert.equal([f.player.current, ...f.player.queue].filter((item) => item.requestedBy === 'room:a').length, 5);
});

test('withdraw removes only the callers pending entry after reordering, never current or another member', async (t) => {
  const f = await fixture(t); await f.rooms.request('default', 'a', { input: '1', kind: 'playlist' });
  await f.rooms.request('default', 'b', { input: '99' }); const target = f.player.queue[1].entryId, current = f.player.current.entryId, others = f.player.queue.at(-1).entryId;
  await f.player.control('shuffle'); await f.rooms.withdraw('default', 'a', target);
  assert.ok(!f.player.queue.some((item) => item.entryId === target)); assert.ok(f.player.queue.some((item) => item.entryId === others));
  await assert.rejects(f.rooms.withdraw('default', 'a', current), /开始播放/);
  await assert.rejects(f.rooms.withdraw('default', 'a', others), /自己的/);
  await assert.rejects(f.rooms.withdraw('default', 'a', '1'), /标识/);
  f.roles.set('a', 'guest'); await assert.rejects(f.rooms.withdraw('default', 'a', f.player.queue.find((item) => item.requestedBy === 'room:a').entryId), /权限/);
});

test('queue wait is approximate, and paused, loop-one and missing duration are explicitly unknown', async (t) => {
  const f = await fixture(t); await f.rooms.request('default', 'a', { input: '1', kind: 'playlist' }); f.player.stream.seconds = 30;
  let state = await f.rooms.room('default', 'a'); assert.equal(state.queue[0].ahead, 1); assert.equal(state.queue[0].waitSeconds, 150); assert.equal(state.queue[1].waitSeconds, 330);
  await f.player.control('pause'); state = await f.rooms.room('default', 'a'); assert.equal(state.queue[0].waitSeconds, null); assert.match(state.queue[0].waitNotice, /暂停/);
  await f.player.control('resume'); await f.player.control('loop', 'one'); state = await f.rooms.room('default', 'a'); assert.equal(state.queue[0].waitSeconds, null);
  await f.player.control('loop', 'off'); f.player.queue[0].durationMs = 0; state = await f.rooms.room('default', 'a'); assert.equal(state.queue[0].waitSeconds, null); assert.equal(state.queue[1].waitSeconds, null);
});

test('lobby omits full queues, mine and events and room snapshot has only one queue copy', async (t) => {
  const f = await fixture(t); await f.rooms.request('default', 'a', { input: '1', kind: 'playlist' });
  const [card] = await f.rooms.lobby('a'), room = await f.rooms.room('default', 'a');
  assert.equal(card.queueCount, 4); assert.equal(card.player.queueCount, 4); assert.equal(room.player.queueCount, 4);
  for (const name of ['queue', 'mine', 'events']) assert.equal(name in card, false);
  assert.equal('queue' in card.player, false); assert.equal('queue' in room.player, false); assert.equal(room.queue.length, 4);
  assert.equal('voice' in card.members, false); assert.equal('web' in card.members, false);
});

test('channel joins check authorization after waiting for the player lock', async (t) => {
  const f = await fixture(t), held = deferred(); const lock = f.player.exclusive(() => held.promise);
  let authorized = true; const before = f.calls.length;
  const joining = f.player.join(context, { authorize: () => { if (!authorized) throw new UserError('已撤权。'); } });
  authorized = false; held.resolve(); await lock; await assert.rejects(joining, /已撤权/); assert.equal(f.calls.length, before);
});

test('owner profiles persist and public room events redact secrets and retain at most 100 entries', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.rooms.updateProfile('default', 'a', { title: '房间', description: '', theme: 'bamboo' }), /权限/);
  await f.rooms.updateProfile('default', 'owner', { title: '夜间电台', description: '一起听歌', theme: 'night' });
  for (let i = 0; i < 105; i++) f.rooms.record('default', { kind: 'role', actorName: 'owner', message: `event ${i} secret-live-token MUSIC_U=privatecookie` });
  await f.rooms.tail;
  const stored = await readFile(f.rooms.file, 'utf8'); assert.ok(!stored.includes('secret-live-token')); assert.ok(!stored.includes('privatecookie'));
  assert.equal(JSON.parse(stored).events.default.length, 100);
  const restored = new SocialRooms({ config: f.config, manager: f.manager, music: f.music, access: f.access, now: f.now }); await restored.init(); t.after(() => restored.close());
  assert.equal((await restored.room('default', 'a')).profile.title, '夜间电台');
  assert.equal((await restored.lobby('a')).length, 1);
});

test('legacy queues receive persisted stable IDs and loop/previous never duplicate active entries', async (t) => {
  const f = await fixture(t); await f.player.shutdown();
  const old = { version: 2, context, current: track(1), queue: [track(2)], history: [], intent: 'paused', positionSeconds: 42, hasStarted: true };
  await writeFile(f.player.file, JSON.stringify(old));
  const player = new Player(f.config, f.api, f.music, f.audio, async () => {}); t.after(() => player.shutdown()); await player.restore();
  const saved = JSON.parse(await readFile(player.file, 'utf8')); assert.equal(saved.current.entryId, player.current.entryId); assert.equal(saved.queue[0].entryId, player.queue[0].entryId);
  await player.control('resume'); await player.control('loop', 'all'); const first = player.current.entryId, second = player.queue[0].entryId;
  f.handles.at(-1).onEnd(null); await player.tail;
  assert.equal(player.current.entryId, second); assert.equal(player.queue[0].entryId, first);
  await player.control('previous'); assert.equal(player.queue.find((item) => item.id === '1').entryId, first);
  const active = [player.current, ...player.queue].map((item) => item.entryId); assert.equal(new Set(active).size, active.length);
});

test('closing or removing a bot cancels pending member/voice reads and late results cannot write state', async (t) => {
  const f = await fixture(t), song = deferred(), voice = deferred(), entered = deferred();
  f.music.resolve = async () => { entered.resolve(); return song.promise; }; f.api.request = async () => voice.promise;
  const request = f.rooms.request('default', 'a', { input: '1' }); const memberPage = await f.rooms.room('default', 'a'); await entered.promise;
  assert.equal(memberPage.members.voiceLoading, true);
  const rejectedRequest = assert.rejects(request, /关闭/);
  await f.rooms.close(); await rejectedRequest;
  song.resolve(track(1)); voice.resolve([{ id: '400', username: 'late' }]);
  assert.equal(f.player.current, null); assert.equal(f.rooms.reads.size, 0);
});

test('bot removal cancels queued social requests and detaches late player events', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.music.resolve = async () => { entered.resolve(); return pending.promise; };
  const request = f.rooms.request('default', 'a', { input: '1' }); await entered.promise;
  const rejecting = assert.rejects(request, /关闭/), eventCount = f.rooms.events.default.length;
  f.runtime.status = 'stopping'; f.manager.emit({ kind: 'stopping', runtime: f.runtime }); f.manager.runtimes.delete('default');
  await rejecting; f.player.emit({ kind: 'control', action: 'pause', actorName: 'late' }); pending.resolve(track(1));
  assert.equal(f.rooms.events.default.length, eventCount); assert.equal(f.player.current, null); assert.equal(f.rooms.bindings.has('default'), false);
});

test('player subscriptions record requests and controls once and do not change existing notification calls', async (t) => {
  const f = await fixture(t); await f.rooms.request('default', 'a', { input: '1' });
  await f.player.control('pause', undefined, { actorName: '小桃' });
  const events = (await f.rooms.room('default', 'a')).events;
  assert.equal(events.filter((event) => event.kind === 'request').length, 1); assert.equal(events.filter((event) => event.kind === 'playing').length, 1);
  assert.equal(events.filter((event) => event.kind === 'control').length, 1); assert.equal(events.find((event) => event.kind === 'control').actorName, '小桃');
});

test('members receive room playback permission without DJ, owner or site management permissions', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'dj', 'owner', 'admin']) assert.equal(f.rooms.identity(id, 'default').permissions.playbackControl, true);
  const member = f.rooms.identity('a', 'default');
  assert.equal(member.role, 'member');
  for (const permission of ['control', 'manageRoom', 'manageRoles', 'manageSite']) assert.equal(member.permissions[permission], false);
  assert.equal(f.rooms.identity(null, 'default').permissions.playbackControl, false);
  f.roles.set('a', 'guest'); assert.equal(f.rooms.identity('a', 'default').permissions.playbackControl, false);
  await assert.rejects(f.rooms.control('default', 'a', { action: 'volume', value: 50, expectedVoiceChannelId: '200' }), /权限/);
  await assert.rejects(f.rooms.control('default', 'missing', { action: 'resume', expectedVoiceChannelId: '200' }), /权限/);
});

test('member controls preserve the RTP connection, pause progress and radio hooks and emit one named activity per operation', async (t) => {
  const f = await fixture(t), featureCalls = [];
  await f.rooms.request('default', 'a', { input: '1', kind: 'playlist' });
  f.player.features = { onControl(action) { featureCalls.push(action); } };
  const control = (action, value) => f.rooms.control('default', 'a', { action, value, expectedVoiceChannelId: '200', actorName: '伪造站长' });
  const originalStream = f.player.stream, calls = f.calls.length; originalStream.seconds = 52;
  assert.match((await control('volume', 28)).message, /28%/);
  assert.equal(f.player.stream, originalStream); assert.equal(f.player.volume, 28); assert.equal(f.calls.length, calls);
  await control('pause'); assert.equal(f.player.snapshot().status, 'paused'); assert.equal(f.player.snapshot().seconds, 52);
  assert.equal(f.player.voiceJoined, true); assert.equal(f.player.context.voiceChannelId, '200');
  await control('resume'); assert.equal(f.player.snapshot().status, 'playing'); assert.equal(f.player.snapshot().seconds, 52);
  assert.deepEqual(featureCalls, ['pause', 'resume']);
  await control('seek', 99.5); assert.equal(f.player.snapshot().seconds, 99.5);
  await control('skip'); assert.equal(f.player.current.id, '2');
  await control('previous'); assert.equal(f.player.current.id, '1');
  await control('loop', 'all'); assert.equal(f.player.mode, 'all');
  const queued = f.player.queue.map((item) => item.entryId).sort(); await control('shuffle');
  assert.deepEqual(f.player.queue.map((item) => item.entryId).sort(), queued);
  await control('loop', 'off'); assert.equal(f.player.mode, 'off');
  await control('skip'); const current = f.player.current, history = [...f.player.history], stream = f.player.stream;
  await control('clear'); assert.equal(f.player.queue.length, 0); assert.equal(f.player.current, current);
  assert.deepEqual(f.player.history, history); assert.equal(f.player.stream, stream); assert.equal(f.player.voiceJoined, true);
  assert.deepEqual(featureCalls, ['pause', 'resume']); assert.equal(f.access.role('a', 'default'), 'member');
  const events = f.rooms.events.default.filter((event) => event.kind === 'control');
  assert.equal(events.length, 11); assert.ok(events.every((event) => event.actorName === '小桃'));
});

test('public room controls reject privileged actions, malformed values and absent or stale channel targets before player mutation', async (t) => {
  const f = await fixture(t); await f.rooms.request('default', 'a', { input: '1' });
  const initialEpoch = f.player.operationEpoch, initialVolume = f.player.volume;
  for (const action of ['stop', 'stay', 'remove', 'move', 'configure', 'roles', '__proto__', '', 1, {}]) {
    await assert.rejects(f.rooms.control('default', 'owner', { action, expectedVoiceChannelId: '200' }), /不支持/);
  }
  for (const value of [-1, 101, 50.5, '50', null, Infinity, NaN, {}]) {
    await assert.rejects(f.rooms.control('default', 'a', { action: 'volume', value, expectedVoiceChannelId: '200' }), /音量/);
  }
  for (const value of ['shuffle', 1, null, {}]) await assert.rejects(f.rooms.control('default', 'a', { action: 'loop', value, expectedVoiceChannelId: '200' }), /循环/);
  for (const value of [-1, Infinity, NaN, '12', null, {}]) await assert.rejects(f.rooms.control('default', 'a', { action: 'seek', value, expectedVoiceChannelId: '200' }), /位置/);
  for (const expectedVoiceChannelId of [undefined, '', 200, '999']) await assert.rejects(f.rooms.control('default', 'a', { action: 'pause', expectedVoiceChannelId }), /频道/);
  await assert.rejects(f.rooms.control('default', 'a', { action: 'clear', value: { stop: true }, expectedVoiceChannelId: '200' }), /额外参数/);
  assert.equal(f.player.operationEpoch, initialEpoch); assert.equal(f.player.volume, initialVolume); assert.equal(f.player.current.id, '1');
  await assert.rejects(f.rooms.control('default', 'a', { action: 'seek', value: 180, expectedVoiceChannelId: '200' }), /位置/);
  assert.equal(f.player.snapshot().seconds, 0);
  await f.rooms.control('default', 'a', { action: 'volume', value: 0, expectedVoiceChannelId: '200' });
  await f.rooms.control('default', 'a', { action: 'volume', value: 100, expectedVoiceChannelId: '200' });
  assert.equal(f.player.volume, 100);
});

test('room controls recheck revoked or expired membership after waiting for the player lock', async (t) => {
  for (const change of ['guest', 'expired']) await t.test(change, async (t) => {
    const f = await fixture(t), held = deferred(); await f.rooms.request('default', 'a', { input: '1' });
    const lock = f.player.exclusive(() => held.promise), volume = f.player.volume;
    const controlling = f.rooms.control('default', 'a', { action: 'volume', value: 90, expectedVoiceChannelId: '200' });
    const rejected = assert.rejects(controlling, /权限/);
    if (change === 'guest') f.roles.set('a', 'guest'); else f.actors.delete('a');
    held.resolve(); await lock; await rejected;
    assert.equal(f.player.volume, volume); assert.equal(f.rooms.controlPending.size, 0);
    assert.equal(f.rooms.events.default.filter((event) => event.kind === 'control').length, 0);
  });
});

test('queued public resume cannot revive playback after a later administrator stop or move to another channel', async (t) => {
  for (const move of [false, true]) await t.test(move ? 'channel move' : 'stop', async (t) => {
    const f = await fixture(t), held = deferred(); await f.rooms.request('default', 'a', { input: '1' });
    await f.player.control('pause'); const started = f.handles.length;
    const lock = f.player.exclusive(() => held.promise);
    const controlling = f.rooms.control('default', 'a', { action: 'resume', expectedVoiceChannelId: '200' });
    const rejected = assert.rejects(controlling, /状态已变化/);
    const stop = f.player.control('stop');
    const joining = move ? f.player.join({ ...context, voiceChannelId: '201' }) : null;
    held.resolve(); await lock; await rejected; await stop; await joining;
    assert.equal(f.player.current, null); assert.equal(f.player.queue.length, 0); assert.equal(f.player.stream, null);
    assert.equal(f.player.context?.voiceChannelId ?? null, move ? '201' : null); assert.equal(f.handles.length, started);
    assert.equal(f.rooms.controlPending.size, 0);
  });
});

test('room controls reject replaced bot instances, room shutdown and channel drift while waiting', async (t) => {
  for (const change of ['runtime', 'player', 'channel', 'guild', 'shutdown']) await t.test(change, async (t) => {
    const f = await fixture(t), held = deferred(); await f.rooms.request('default', 'a', { input: '1' });
    const lock = f.player.exclusive(() => held.promise), volume = f.player.volume;
    const controlling = f.rooms.control('default', 'a', { action: 'volume', value: 90, expectedVoiceChannelId: '200' });
    const rejected = assert.rejects(controlling, /状态已变化/);
    if (change === 'runtime') f.manager.runtimes.set('default', { ...f.runtime });
    if (change === 'player') f.runtime.player = { ...f.player };
    if (change === 'channel') f.player.context = { ...context, voiceChannelId: '201' };
    if (change === 'guild') f.player.context = { ...context, guildId: '101' };
    if (change === 'shutdown') await f.rooms.close();
    held.resolve(); await lock; await rejected;
    assert.equal(f.player.volume, volume); assert.equal(f.rooms.controlPending.size, 0);
  });
});

test('only one public control per room can wait, while another bot remains independent and failure releases the slot', async (t) => {
  const f = await fixture(t), held = deferred(); await f.rooms.request('default', 'a', { input: '1' });
  const other = new Player({ ...f.config, dataDir: path.join(f.dir, 'other') }, f.api, f.music, { ...f.audio }, async () => {});
  const second = { ...f.runtime, id: 'second', player: other }; f.manager.runtimes.set('second', second);
  try {
    await other.join({ ...context, voiceChannelId: '201' }); await other.add(other.context, [track(91), track(92)]);
    const firstCurrent = f.player.current, secondCurrent = other.current, secondQueue = [...other.queue];
    const lock = f.player.exclusive(() => held.promise);
    const pending = f.rooms.control('default', 'a', { action: 'volume', value: 30, expectedVoiceChannelId: '200' });
    await assert.rejects(f.rooms.control('default', 'b', { action: 'clear', expectedVoiceChannelId: '200' }), (error) => error.statusCode === 409 && /上一项/.test(error.message));
    await f.rooms.control('second', 'b', { action: 'volume', value: 70, expectedVoiceChannelId: '201' });
    assert.equal(other.volume, 70); assert.equal(other.current, secondCurrent); assert.deepEqual(other.queue, secondQueue);
    held.resolve(); await lock; await pending;
    assert.equal(f.player.volume, 30); assert.equal(f.player.current, firstCurrent); assert.equal(f.rooms.controlPending.size, 0);
    await assert.rejects(f.rooms.control('default', 'a', { action: 'seek', value: 300, expectedVoiceChannelId: '200' }), /位置/);
    await f.rooms.control('default', 'b', { action: 'volume', value: 31, expectedVoiceChannelId: '200' });
    assert.equal(f.player.volume, 31); assert.equal(other.volume, 70); assert.equal(f.rooms.controlPending.size, 0);
  } finally { held.resolve(); await other.shutdown(); }
});
