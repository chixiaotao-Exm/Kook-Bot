import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RoomFeatures } from '../src/room-features.js';
import { Player } from '../src/player.js';
import { Bot } from '../src/bot.js';
import { BotManager } from '../src/bot-manager.js';
import { readConfig } from '../src/config.js';

const track = (id, source = 'netease', requestedBy = '42') => ({ id: String(id), source, name: `Song ${id}`, artists: 'Singer', durationMs: 180000, requestedBy });
const context = { guildId: '100', voiceChannelId: '200', textChannelId: '300' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const schedule = (overrides = {}) => ({ id: 'evening', name: '夜间', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '20:00',
  timeZone: 'Asia/Shanghai', action: 'volume', volume: 30, source: 'netease', playlistId: '', ...overrides });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kook-room-features-'));
  const config = readConfig({ KOOK_TOKEN: 'fixture', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, MAX_QUEUE_SIZE: '500', STAY_CONNECTED: 'true', ADMIN_USER_IDS: '99' });
  let now = Date.parse('2026-09-18T11:59:00Z'); const calls = [], messages = [], events = [];
  const api = { async post(endpoint, args) { calls.push({ endpoint, args }); return {}; },
    async request(endpoint) { return endpoint === 'channel/user-list' ? [{ id: '42', bot: false }, { id: '43', bot: false }, { id: '44', bot: false }, { id: '1', bot: true }] : { items: [{ id: '200', type: 2 }] }; },
    async reply(channel, message) { messages.push(message); } };
  const music = { async stream(item) { return item.id; }, async hot(limit, source = 'netease') { calls.push({ hot: source }); return { tracks: Array.from({ length: Math.min(100, limit) }, (_, i) => track(i + 1, source)) }; },
    async playlist(id, limit, source = 'netease') { return Array.from({ length: Math.min(30, limit) }, (_, i) => track(i + 1, source)); },
    async discover(category, source) { return [{ id: '12', source }]; }, async resolve(input) { return track(Number(input)); } };
  const audio = { connected: false, async connect() { this.connected = true; }, async disconnect() { this.connected = false; },
    start(media, voice, volume, offset, onEnd) { return { seconds: offset, paused: false, onEnd, async stop() {}, async setVolume() {} }; } };
  const player = new Player(config, api, music, audio, async () => {});
  const features = new RoomFeatures({ config, player, api, music, selfId: '1', now: () => now, report: (event) => events.push(event), intervalMs: 9999999 });
  await features.init();
  t.after(async () => { await features.close(); await player.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, api, music, player, features, calls, messages, events, now: () => now, setTime: (value) => { now = typeof value === 'number' ? value : Date.parse(value); } };
}

test('room features default disabled and enabling auto radio preserves independent provider keys', async (t) => {
  const f = await fixture(t); await f.player.join(context); await f.features.tick();
  assert.equal(f.player.current, null); assert.equal(f.features.snapshot().radio.enabled, false);
  await f.player.add(context, [track(1)]); f.player.history = [track(2)];
  await f.features.configure('radio', { enabled: true, source: 'mixed', batchSize: 4 }); await f.features.tick();
  assert.deepEqual(f.player.queue.map((item) => `${item.source}:${item.id}`), ['qq:1', 'qq:2', 'netease:3', 'qq:3']);
  assert.equal(f.features.snapshot().radio.lastError, '');
});

test('Qishui supports radio and schedules while mixed radio uses only enabled providers', async (t) => {
  const f = await fixture(t); await f.player.join(context);
  await f.features.configure('radio', { enabled: true, source: 'qishui', batchSize: 2 }); await f.features.tick();
  assert.equal(f.player.current.source, 'qishui'); assert.equal(f.player.queue[0].source, 'qishui');
  await f.features.configure('schedules', [schedule({ action: 'hot', source: 'qishui' })]);
  assert.equal(f.features.schedules[0].source, 'qishui');
  f.music.sources = () => [{ id: 'netease', enabled: true }, { id: 'qq', enabled: false }, { id: 'qishui', enabled: true }];
  f.calls.length = 0;
  const found = await f.features.candidates({ source: 'mixed', strategy: 'hot' }, 2);
  assert.deepEqual(found.map((item) => item.source), ['netease', 'qishui', 'netease', 'qishui']);
  assert.deepEqual(f.calls, [{ hot: 'netease' }, { hot: 'qishui' }]);
});

test('manual pause suspends radio durably and explicit resume reenables future fill', async (t) => {
  const f = await fixture(t); await f.player.add(context, [track(90)]);
  await f.features.configure('radio', { enabled: true }); await f.player.control('pause'); await f.features.tail;
  await f.features.tick(); assert.equal(f.player.queue.length, 0);
  const stored = JSON.parse(await readFile(f.features.file, 'utf8')); assert.equal(stored.radioState.suspended, true);
  await f.features.close();
  const restored = new RoomFeatures({ config: f.config, player: f.player, api: f.api, music: f.music, selfId: '1', now: f.now });
  await restored.init(); t.after(() => restored.close());
  assert.equal(restored.snapshot().radio.suspended, true);
  await f.player.control('resume'); await restored.tick(); assert.equal(f.player.queue.length, 10);
});

test('a slow radio provider cannot rejoin after manual stop', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  await f.player.join(context); await f.features.configure('radio', { enabled: true });
  f.music.hot = async () => { entered.resolve(); return pending.promise; };
  const filling = f.features.tick(); await entered.promise; await f.player.control('stop'); pending.resolve({ tracks: [track(1)] }); await filling;
  assert.equal(f.player.context, null); assert.equal(f.player.current, null); assert.equal(f.player.queue.length, 0);
  assert.equal(f.calls.filter((call) => call.endpoint === 'voice/join').length, 1);
});

test('radio respects queue limit and bounds empty candidate retries', async (t) => {
  const f = await fixture(t); await f.player.join(context);
  f.player.config.maxQueue = 3; await f.features.configure('radio', { enabled: true, batchSize: 10 }); await f.features.tick();
  assert.equal(f.player.capacity(), 0); assert.equal(f.player.queue.length, 2);
  await f.player.control('stop'); await f.player.join(context); await f.features.configure('radio', { enabled: true });
  f.music.hot = async () => { f.calls.push({ empty: true }); return { tracks: [] }; };
  await f.features.tick(); await f.features.tick(); assert.equal(f.calls.filter((item) => item.empty).length, 1);
  f.setTime(f.now() + 61000); await f.features.tick(); assert.equal(f.calls.filter((item) => item.empty).length, 2);
});

test('radio disables cancel provider work without changing current queue', async (t) => {
  const f = await fixture(t), entered = deferred(), pending = deferred(); await f.player.join(context);
  await f.features.configure('radio', { enabled: true }); f.music.hot = async () => { entered.resolve(); return pending.promise; };
  const job = f.features.tick(); await entered.promise; await f.features.configure('radio', { enabled: false }); pending.resolve({ tracks: [track(1)] }); await job;
  assert.equal(f.player.current, null);
});

test('a settings change cancels radio additions already waiting for the player lock', async (t) => {
  const f = await fixture(t); await f.player.join(context); await f.features.configure('radio', { enabled: true });
  const lock = deferred(), waiting = deferred();
  const held = f.player.exclusive(() => lock.promise);
  const originalAdd = f.player.add.bind(f.player);
  f.player.add = (...args) => { const result = originalAdd(...args); waiting.resolve(); return result; };
  const job = f.features.tick(); await waiting.promise;
  await f.features.configure('radio', { enabled: false }); lock.resolve(); await held; await job;
  assert.equal(f.player.current, null); assert.equal(f.player.queue.length, 0);
});

test('closing room features returns before a blocked provider and cancels its mutation', async (t) => {
  const f = await fixture(t), entered = deferred(), pending = deferred(); await f.player.join(context);
  await f.features.configure('radio', { enabled: true }); f.music.hot = async () => { entered.resolve(); return pending.promise; };
  const job = f.features.tick(); await entered.promise; let closed = false;
  const closing = f.features.close().then(() => { closed = true; }); await tick(); assert.equal(closed, true);
  await closing; await job; assert.equal(f.player.current, null); assert.equal(f.features.pendingReads.size, 0);
  pending.resolve({ tracks: [track(1)] }); await tick(); assert.equal(f.player.current, null);
});

test('a completed player addition returning after close cannot rewrite room feature state', async (t) => {
  const f = await fixture(t), entered = deferred(), pending = deferred(); await f.player.join(context);
  await f.features.configure('radio', { enabled: true });
  const originalAdd = f.player.add.bind(f.player);
  f.player.add = async (...args) => { const added = await originalAdd(...args); entered.resolve(); await pending.promise; return added; };
  const job = f.features.tick(); await entered.promise; await f.features.close();
  const before = await readFile(f.features.file, 'utf8'); pending.resolve(); await job;
  assert.equal(await readFile(f.features.file, 'utf8'), before); assert.equal(f.features.radioState.lastRunAt, null);
});

test('radio and scheduled playlists resolve short links and honor the detected platform', async (t) => {
  const f = await fixture(t); await f.player.join(context);
  const parses = [], imports = [];
  f.music.parseInput = async (input, options) => { parses.push({ input, options }); return { kind: 'playlist', source: 'qq', id: '998' }; };
  f.music.playlist = async (id, limit, platform) => { imports.push({ id, limit, platform }); return [track(imports.length, platform)]; };
  await f.features.configure('radio', { enabled: true, strategy: 'playlist', playlistId: 'https://c.y.qq.com/base/fcgi-bin/u?__=one', source: 'netease' });
  await f.features.tick(); assert.equal(f.player.current.source, 'qq'); assert.equal(imports[0].id, '998'); assert.equal(imports[0].platform, 'qq');
  await f.features.configure('radio', { enabled: false });
  await f.features.configure('schedules', [schedule({ action: 'playlist', playlistId: 'https://c.y.qq.com/base/fcgi-bin/u?__=two' })]);
  f.setTime('2026-09-18T12:00:00Z'); await f.features.tick();
  assert.equal(imports[1].id, '998'); assert.equal(imports[1].platform, 'qq'); assert.equal(f.player.queue[0].source, 'qq');
  assert.ok(parses.every((call) => call.options.kind === 'playlist'));
});

test('room playlist lookup rejects song links without calling the playlist provider', async (t) => {
  const f = await fixture(t); let imported = false;
  f.music.parseInput = async () => ({ kind: 'song', source: 'qq', id: '111' });
  f.music.playlist = async () => { imported = true; return []; };
  await assert.rejects(f.features.playlist('https://c.y.qq.com/base/fcgi-bin/u?__=song', 10, 'netease'), /歌单链接/);
  assert.equal(imported, false);
});

test('timezone schedules run once and persist dispatch before side effects', async (t) => {
  const f = await fixture(t); await f.player.join(context); await f.features.configure('schedules', [schedule()]);
  const control = f.player.control.bind(f.player); let observedLedger;
  f.player.control = async (...args) => { observedLedger = JSON.parse(await readFile(f.features.file, 'utf8')).ledger; return control(...args); };
  f.setTime('2026-09-18T12:00:00Z'); await f.features.tick(); assert.equal(f.player.volume, 30);
  assert.equal(observedLedger.evening.date, '2026-09-18');
  f.player.volume = 70; await f.features.tick(); assert.equal(f.player.volume, 70);
  await f.features.close();
  const restored = new RoomFeatures({ config: f.config, player: f.player, api: f.api, music: f.music, selfId: '1', now: f.now });
  await restored.init(); t.after(() => restored.close()); await restored.tick(); assert.equal(f.player.volume, 70);
});

test('a failed dispatch save does not mark an unexecuted schedule as already run', async (t) => {
  const f = await fixture(t); await f.player.join(context);
  await f.features.configure('schedules', [schedule()]);
  const save = f.features.save.bind(f.features); let failures = 1;
  f.features.save = async () => { if (failures-- > 0) throw new Error('temporary write failure'); return save(); };
  const volumeBefore = f.player.volume;
  f.setTime('2026-09-18T12:00:00Z'); await f.features.tick();
  assert.equal(f.player.volume, volumeBefore);
  assert.equal(f.features.snapshot().schedules[0].lastRunAt, null);
  assert.equal(JSON.parse(await readFile(f.features.file, 'utf8')).ledger.evening, undefined);
  await f.features.tick();
  assert.equal(f.player.volume, 30);
  assert.equal(JSON.parse(await readFile(f.features.file, 'utf8')).ledger.evening.date, '2026-09-18');
  f.player.volume = 40; await f.features.tick(); assert.equal(f.player.volume, 40);
});

test('slow radio requests never mask scheduled volume or pause and cannot append after the pause', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred(); let radioRequests = 0;
  await f.player.add(context, [track(90)]); f.setTime('2026-09-18T11:59:50Z');
  await f.features.configure('radio', { enabled: true });
  await f.features.configure('schedules', [schedule({ id: 'lower', volume: 25 }), schedule({ id: 'quiet', time: '20:01', action: 'pause' })]);
  f.music.hot = async () => { radioRequests++; entered.resolve(); return pending.promise; };
  const first = f.features.tick(); await entered.promise; await f.features.scheduleWorking;
  f.setTime('2026-09-18T12:00:00Z'); const second = f.features.tick(); await Promise.allSettled(await f.features.scheduleWorking);
  assert.equal(f.player.volume, 25); assert.equal(f.player.intent, 'playing'); assert.equal(radioRequests, 1);
  f.setTime('2026-09-18T12:01:00Z'); const third = f.features.tick(); await Promise.allSettled(await f.features.scheduleWorking);
  assert.equal(f.player.intent, 'paused'); assert.equal(f.features.radioState.suspended, true); assert.equal(radioRequests, 1);
  const stored = JSON.parse(await readFile(f.features.file, 'utf8'));
  assert.equal(stored.ledger.lower.date, '2026-09-18'); assert.equal(stored.ledger.quiet.date, '2026-09-18');
  pending.resolve({ tracks: [track(1)] }); await Promise.all([first, second, third]);
  assert.equal(f.player.queue.length, 0); assert.equal(f.player.current.id, '90'); assert.equal(f.player.intent, 'paused');
});

test('a blocked scheduled playlist cannot hide next-minute pause and each dispatch is saved exactly once', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred(); let imports = 0;
  await f.player.add(context, [track(90)]);
  await f.features.configure('schedules', [schedule({ id: 'songs', action: 'playlist', playlistId: '123' }),
    schedule({ id: 'pause', time: '20:01', action: 'pause' })]);
  f.music.playlist = async () => {
    imports++; const ledger = JSON.parse(await readFile(f.features.file, 'utf8')).ledger;
    assert.equal(ledger.songs.date, '2026-09-18'); entered.resolve(); return pending.promise;
  };
  f.setTime('2026-09-18T12:00:00Z'); const earlier = f.features.tick(); await entered.promise; await f.features.scheduleWorking;
  await f.features.tick(); assert.equal(imports, 1);
  f.setTime('2026-09-18T12:01:00Z'); await f.features.tick();
  assert.equal(f.player.intent, 'paused'); assert.equal(f.features.scheduleJobs.has('songs'), true);
  assert.equal(JSON.parse(await readFile(f.features.file, 'utf8')).ledger.pause.date, '2026-09-18');
  pending.resolve([track(1)]); await earlier; assert.equal(f.player.queue.length, 0); assert.equal(imports, 1);
  assert.equal(f.features.scheduleJobs.size, 0);
});

test('same-minute schedules dispatch in saved order with serialized controls while a playlist is pending', async (t) => {
  const f = await fixture(t), pending = deferred(), entered = deferred(); const volumes = [];
  await f.player.add(context, [track(90)]);
  await f.features.configure('schedules', [schedule({ id: 'first', volume: 25 }),
    schedule({ id: 'slow', action: 'playlist', playlistId: '123' }), schedule({ id: 'last', volume: 65 })]);
  const control = f.player.control.bind(f.player);
  f.player.control = (...args) => { if (args[0] === 'volume') volumes.push(args[1]); return control(...args); };
  f.music.playlist = async () => { entered.resolve(); return pending.promise; };
  f.setTime('2026-09-18T12:00:00Z'); const work = f.features.tick(); await entered.promise;
  await f.features.scheduleWorking; await f.player.tail;
  assert.deepEqual(volumes, [25, 65]); assert.equal(f.player.volume, 65);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.features.file, 'utf8')).ledger), ['first', 'slow', 'last']);
  pending.resolve([track(1)]); await work; assert.equal(f.player.queue.length, 1);
});

test('same-minute pause and volume both execute in order without cancelling each other', async (t) => {
  const f = await fixture(t); await f.player.add(context, [track(90)]);
  await f.features.configure('schedules', [schedule({ id: 'pause', action: 'pause' }), schedule({ id: 'volume', volume: 12 })]);
  f.setTime('2026-09-18T12:00:00Z'); await f.features.tick();
  assert.equal(f.player.intent, 'paused'); assert.equal(f.player.volume, 12);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.features.file, 'utf8')).ledger), ['pause', 'volume']);
});

test('new schedules never execute in configuration minute or replay a missed time', async (t) => {
  const f = await fixture(t); await f.player.join(context); f.setTime('2026-09-18T12:00:00Z');
  await f.features.configure('schedules', [schedule()]); await f.features.tick(); assert.notEqual(f.player.volume, 30);
  f.setTime('2026-09-19T12:01:00Z'); await f.features.tick(); assert.notEqual(f.player.volume, 30);
  f.setTime('2026-09-20T12:00:00Z'); await f.features.tick(); assert.equal(f.player.volume, 30);
});

test('DST repeated local hour runs at most once and nonexistent hour is skipped', async (t) => {
  const f = await fixture(t); await f.player.join(context); f.setTime('2026-11-01T04:00:00Z');
  await f.features.configure('schedules', [schedule({ timeZone: 'America/New_York', time: '01:30' })]);
  f.setTime('2026-11-01T05:30:00Z'); await f.features.tick(); assert.equal(f.player.volume, 30);
  f.player.volume = 65; f.setTime('2026-11-01T06:30:00Z'); await f.features.tick(); assert.equal(f.player.volume, 65);
  f.setTime('2027-03-14T05:00:00Z'); await f.features.configure('schedules', [schedule({ timeZone: 'America/New_York', time: '02:30' })]);
  f.setTime('2027-03-14T07:30:00Z'); await f.features.tick(); assert.equal(f.player.volume, 65);
});

test('scheduled playlist appends then resumes preserved progress, and stop invalidates in-flight import', async (t) => {
  const f = await fixture(t); await f.player.add(context, [track(90), track(91)]); f.player.stream.seconds = 52; await f.player.control('pause');
  await f.features.configure('schedules', [schedule({ action: 'playlist', playlistId: '123' })]);
  f.setTime('2026-09-18T12:00:00Z'); await f.features.tick(); assert.equal(f.player.current.id, '90'); assert.equal(f.player.capturePosition(), 52);
  assert.equal(f.player.intent, 'playing'); assert.equal(f.player.queue[0].id, '91');
  const pending = deferred(), entered = deferred(); f.music.playlist = async () => { entered.resolve(); return pending.promise; };
  f.setTime('2026-09-19T11:59:00Z'); await f.features.configure('schedules', [schedule({ action: 'playlist', playlistId: '124' })]);
  f.setTime('2026-09-19T12:00:00Z'); const job = f.features.tick(); await entered.promise;
  await f.player.control('stop'); pending.resolve([track(1)]); await job; assert.equal(f.player.context, null);
});

test('schedule and radio configuration reject invalid rules without overwriting stored settings', async (t) => {
  const f = await fixture(t);
  for (const entry of [schedule({ timeZone: 'Mars/City' }), schedule({ time: '24:00' }), schedule({ days: [7] }), schedule({ volume: 101 }), schedule({ id: '__proto__' })]) {
    await assert.rejects(f.features.configure('schedules', [entry])); assert.deepEqual(f.features.schedules, []);
  }
  await assert.rejects(f.features.configure('radio', { enabled: true, source: 'mixed', strategy: 'playlist', playlistId: '12' }), /指定歌单/);
  assert.equal(f.features.radio.enabled, false);
});

test('feature configuration rechecks authorization after waiting for its persistence lock', async (t) => {
  const f = await fixture(t), held = deferred(); const lock = f.features.serialize(() => held.promise);
  let authorized = true;
  const saving = f.features.configure('radio', { enabled: true }, { authorize: () => { if (!authorized) throw new Error('已撤权'); } });
  authorized = false; held.resolve(); await lock; await assert.rejects(saving, /已撤权/); assert.equal(f.features.radio.enabled, false);
});

test('per-user quota and same-source duplicates are checked atomically for concurrent additions', async (t) => {
  const f = await fixture(t); await f.features.configure('rules', { enabled: true, perUserLimit: 2 });
  const policy = f.features.policy('42');
  const results = await Promise.allSettled([f.player.add(context, [track(1), track(1), track(2)], { policy }), f.player.add(context, [track(3)], { policy })]);
  assert.equal(results[0].value, 2); assert.equal(results[1].status, 'rejected'); assert.equal(f.player.queue.length, 1);
  await f.player.add(context, [track(1, 'qq', '43')], { policy: f.features.policy('43') }); assert.equal(f.player.queue.at(-1).source, 'qq');
  await f.features.configure('rules', { managerIds: ['99'] }); assert.equal(f.features.policy('99'), undefined);
});

test('room controls are manager-only while ordinary skip votes require verified humans and unique votes', async (t) => {
  const f = await fixture(t); await f.features.configure('rules', { enabled: true }); await f.player.add(context, [track(1), track(2), track(3)]);
  assert.throws(() => f.features.authorize('volume', '42'), /管理员/);
  await f.features.configure('rules', { managerIds: ['99'] }); assert.doesNotThrow(() => f.features.authorize('volume', '99'));
  await assert.rejects(f.features.vote('1'), /语音频道/); await assert.rejects(f.features.vote('999'), /语音频道/);
  assert.match(await f.features.vote('42'), /1\/2/); assert.match(await f.features.vote('42'), /已投过票/);
  assert.match(await f.features.vote('43'), /投票通过/); assert.equal(f.player.current.id, '2'); assert.equal(f.features.snapshot().votes.count, 0);
});

test('votes ignore departed members and reset after track changes during membership verification', async (t) => {
  const f = await fixture(t); await f.features.configure('rules', { enabled: true }); await f.player.add(context, [track(1), track(2), track(3)]);
  await f.features.vote('42'); f.api.request = async () => [{ id: '43', bot: false }];
  assert.match(await f.features.vote('43'), /投票通过/); assert.equal(f.player.current.id, '2');
  const pending = deferred(), entered = deferred(); f.api.request = async () => { entered.resolve(); return pending.promise; };
  const voting = f.features.vote('43'); await entered.promise; await f.player.control('skip'); pending.resolve([{ id: '43', bot: false }]);
  await assert.rejects(voting, /歌曲已变化/); assert.equal(f.player.current.id, '3');
});

test('a vote queued behind a successful skip stays bound to the song present when submitted', async (t) => {
  const f = await fixture(t); await f.features.configure('rules', { enabled: true, voteThreshold: 1 });
  await f.player.add(context, [track(1), track(2), track(3)]);
  const pending = deferred(), entered = deferred(); let lookups = 0;
  f.api.request = async () => {
    if (++lookups === 1) { entered.resolve(); return pending.promise; }
    return [{ id: '42', bot: false }, { id: '43', bot: false }];
  };
  const first = f.features.vote('42'); await entered.promise;
  const second = assert.rejects(f.features.vote('43'), /歌曲已变化/);
  pending.resolve([{ id: '42', bot: false }, { id: '43', bot: false }]);
  assert.match(await first, /投票通过/); await second;
  assert.equal(f.player.current.id, '2'); assert.equal(lookups, 1);
  assert.equal(f.features.snapshot().votes.count, 0);
});

test('caller vote context is rechecked before any vote is applied to a replacement track', async (t) => {
  const f = await fixture(t); await f.features.configure('rules', { enabled: true });
  await f.player.add(context, [track(1), track(2)]);
  const received = { expectedEpoch: f.player.operationEpoch, expectedTrackEpoch: f.player.trackEpoch,
    expectedVoiceChannelId: context.voiceChannelId, expectedGuildId: context.guildId };
  await f.player.control('skip'); let lookups = 0;
  f.api.request = async () => { lookups++; return [{ id: '42', bot: false }, { id: '43', bot: false }]; };
  await assert.rejects(f.features.vote('42', received), /歌曲已变化/);
  assert.equal(lookups, 0); assert.equal(f.features.snapshot().votes.count, 0);
  assert.equal(f.player.current.id, '2');
  assert.match(await f.features.vote('42'), /1\/2/);
});

test('enabling residency reconnects a restored disconnected paused context and current command shows saved progress', async (t) => {
  const f = await fixture(t); f.player.context = { ...context }; f.player.current = track(1); f.player.intent = 'paused'; f.player.position = 52;
  f.player.stayConnected = false; await f.player.control('stay', true); assert.equal(f.player.voiceJoined, true); assert.ok(f.player.keepalive);
  const bot = new Bot(f.config, f.api, f.music, f.player);
  await bot.handle({ author_id: '42', msg_id: 'paused', target_id: '300', extra: { guild_id: '100' } }, { action: 'now', value: '' });
  assert.match(f.messages.at(-1), /已暂停/); assert.match(f.messages.at(-1), /0:52/);
});

test('help chooses a single responder without reserving an idle bot for five minutes', async (t) => {
  const f = await fixture(t); const manager = new BotManager(f.config, f.music);
  for (const id of ['default', 'second']) manager.runtimes.set(id, { id, status: 'ready', config: f.config, api: f.api, player: { context: null } });
  const event = { author_id: '42', target_id: '300', content: '/帮助', extra: { guild_id: '100' } };
  assert.equal(await manager.chooseOwner(event, { action: 'help' }), 'default'); assert.equal(manager.claims.size, 0);
  event.content = '/搜索 晴天'; await manager.chooseOwner(event, { action: 'search' }); assert.equal(manager.claims.size, 1);
});

test('KOOK music links honor detected QQ source and playlist kind', async (t) => {
  const f = await fixture(t); const bot = new Bot(f.config, f.api, f.music, f.player);
  f.music.parseInput = async () => ({ kind: 'playlist', source: 'qq', id: '998' });
  const event = { author_id: '42', msg_id: 'link', target_id: '300', extra: { guild_id: '100' } };
  await bot.handle(event, { action: 'play', value: 'https://c.y.qq.com/share/short' });
  assert.equal(f.player.current.source, 'qq'); assert.equal(f.player.queue.length, 29);
});
