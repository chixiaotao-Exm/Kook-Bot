import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotManager } from '../src/bot-manager.js';
import { readConfig } from '../src/config.js';
import { UserError } from '../src/util.js';

const context = (room) => ({ guildId: '100', voiceChannelId: room, textChannelId: '300' });
const song = (id) => ({ id: String(id), name: `Song ${id}`, artists: 'Artist', durationMs: 180000, source: 'netease' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kook-multi-'));
  const config = readConfig({ KOOK_TOKEN: 'main-secret', ALLOWED_GUILD_IDS: '100', DATA_DIR: dir, MAX_QUEUE_SIZE: '500', STAY_CONNECTED: 'true' });
  const calls = [], failures = new Map(), identities = new Map([['main-secret', '1'], ['second-secret', '2'], ['third-secret', '3'], ['same-account-secret', '1']]);
  const guildPages = new Map();
  const music = { stream: async (track) => `https://music.126.net/${track.id}.mp3` };
  const dependencies = {
    sleep: async () => {},
    createApi(token) {
      return {
        async request(endpoint, params) {
          calls.push({ token, endpoint, params });
          if (failures.has(token)) throw new Error(`Sensitive upstream ${token}: ${failures.get(token)}`);
          if (endpoint === 'user/me') return { id: identities.get(token), username: `Bot ${identities.get(token)}` };
          if (endpoint === 'guild/list') {
            const pages = guildPages.get(token);
            if (pages instanceof Error) throw pages;
            return pages ? pages[params.page - 1] : { items: [{ id: '100', open_id: '172157' }], meta: { page: 1, page_total: 1, page_size: 50 } };
          }
          return { items: [] };
        },
        async post(endpoint, params) { calls.push({ token, endpoint, params }); return { ip: '127.0.0.1', port: 5004 }; },
        async reply() {},
      };
    },
    createGateway(api, accept) { return { ready: false, start() { this.ready = true; }, stop() { this.ready = false; }, accept }; },
    createAudio() {
      return { connected: false, async connect() { this.connected = true; }, async disconnect() { this.connected = false; },
        start(media, voice, volume, offset, onEnd) {
          return { seconds: offset, volume, paused: false, onEnd, async stop() { this.stopped = true; }, async setVolume(value) { this.volume = value; } };
        },
      };
    },
  };
  const managers = [];
  const create = () => { const manager = new BotManager(config, music, dependencies); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) await manager.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, calls, failures, identities, music, dependencies, guildPages, create };
}

test('default keeps original queue and new bot independently restores queue, progress, volume and room', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, 'queue.json'), JSON.stringify({ version: 2, context: context('201'), current: song(11), queue: [song(12)],
    positionSeconds: 52, intent: 'paused', hasStarted: true, volume: 24, stayConnected: true }));
  const first = f.create(); await first.init();
  const descriptor = await first.add({ token: 'second-secret', name: '第二频道' });
  const primary = first.get().player, secondary = first.get(descriptor.id).player;
  assert.equal(primary.file, path.join(f.dir, 'queue.json'));
  assert.equal(primary.current.id, '11'); assert.equal(primary.capturePosition(), 52); assert.equal(primary.volume, 24);
  assert.equal(secondary.file, path.join(f.dir, 'bots', descriptor.id, 'queue.json'));
  assert.equal(primary.music, secondary.music); assert.notEqual(primary.audio, secondary.audio);
  await secondary.add(context('202'), [song(21), song(22)]); secondary.stream.seconds = 71;
  await secondary.control('volume', 83); await primary.control('resume');
  primary.stream.seconds = 58; await primary.control('pause');
  assert.equal(secondary.snapshot().status, 'playing'); assert.equal(secondary.volume, 83);
  await first.shutdown();
  const second = f.create(); await second.init();
  assert.equal(second.get().player.snapshot().status, 'paused'); assert.equal(second.get().player.capturePosition(), 58);
  const restored = second.get(descriptor.id).player;
  assert.equal(restored.snapshot().status, 'playing'); assert.equal(restored.capturePosition(), 71);
  assert.deepEqual(restored.context, context('202')); assert.equal(restored.volume, 83); assert.equal(restored.queue[0].id, '22');
  assert.equal(second.get().player.queue[0].id, '12');
  const publicJson = JSON.stringify(second.list());
  assert.ok(!publicJson.includes('main-secret') && !publicJson.includes('second-secret'));
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.dir, 'bots.json'))).mode & 0o777, 0o600);
});

test('each bot measures its current runtime across playback and reconnects and resets on restart', async (t) => {
  const f = await fixture(t);
  let wall = Date.parse('2026-09-28T08:00:00Z'), monotonic = 0;
  f.dependencies.now = () => wall; f.dependencies.monotonicNow = () => monotonic;
  const manager = f.create(); await manager.init();
  assert.equal(manager.describe(manager.get()).uptimeSeconds, 0);
  monotonic += 61000; wall += 61000;
  const extra = await manager.add({ token: 'second-secret' });
  assert.equal(manager.describe(manager.get()).uptimeSeconds, 61);
  assert.equal(extra.uptimeSeconds, 0);
  const runtime = manager.get(extra.id), startedAt = extra.startedAt;
  await runtime.player.add(context('202'), [song(21)]); await runtime.player.control('pause');
  monotonic += 9000; wall -= 3600000; runtime.gateway.ready = false;
  const reconnecting = manager.describe(runtime);
  assert.equal(reconnecting.online, false); assert.equal(reconnecting.uptimeSeconds, 9);
  assert.equal(reconnecting.startedAt, startedAt);
  await manager.retry(extra.id);
  assert.equal(manager.describe(runtime).uptimeSeconds, 0);
  assert.notEqual(manager.describe(runtime).startedAt, startedAt);
  assert.equal(manager.describe(manager.get()).uptimeSeconds, 70);
  monotonic += 1000; f.failures.set('second-secret', 'offline'); await manager.retry(extra.id);
  assert.equal(manager.describe(runtime).status, 'error');
  assert.equal(manager.describe(runtime).startedAt, null); assert.equal(manager.describe(runtime).uptimeSeconds, null);
  f.failures.delete('second-secret'); await manager.retry(extra.id);
  assert.equal(manager.describe(runtime).uptimeSeconds, 0);
  await manager.shutdown();
  assert.equal(manager.describe(manager.get()).uptimeSeconds, null);
  const restarted = f.create(); await restarted.init();
  assert.ok(restarted.list().every(bot => bot.uptimeSeconds === 0));
});

test('invalid tokens and duplicate token/account are rejected before voice cleanup or persistence', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  f.failures.set('bad-secret', 'denied');
  await assert.rejects(manager.add({ token: 'bad-secret' }), (error) => error instanceof UserError && !error.message.includes('bad-secret'));
  await assert.rejects(manager.add({ token: 'main-secret' }), /重复/);
  await assert.rejects(manager.add({ token: 'same-account-secret' }), /重复/);
  assert.deepEqual(manager.list().map((item) => item.id), ['default']);
  assert.equal(f.calls.filter((call) => ['bad-secret', 'same-account-secret'].includes(call.token) && call.endpoint !== 'user/me').length, 0);
  await assert.rejects(readFile(path.join(f.dir, 'bots.json')), { code: 'ENOENT' });
  assert.equal(manager.get().status, 'ready');
});

test('failed bot startup is isolated and a later retry recovers without affecting default', async (t) => {
  const f = await fixture(t), first = f.create(); await first.init();
  const failed = await first.add({ token: 'second-secret' }), healthy = await first.add({ token: 'third-secret' });
  await first.shutdown(); f.failures.set('second-secret', 'second-secret');
  const second = f.create(); await second.init();
  assert.equal(second.get().status, 'ready'); assert.equal(second.get(healthy.id).status, 'ready');
  assert.equal(second.get(failed.id).status, 'error'); assert.equal(second.get(failed.id).player, null);
  assert.ok(!JSON.stringify(second.list()).includes('second-secret'));
  f.failures.delete('second-secret');
  await second.retry(failed.id); assert.equal(second.get(failed.id).status, 'ready');
  assert.equal(second.get().status, 'ready');
});

test('failed default startup still starts additional bots', async (t) => {
  const f = await fixture(t), first = f.create(); await first.init();
  const extra = await first.add({ token: 'second-secret' }); await first.shutdown();
  f.failures.set('main-secret', 'offline'); const second = f.create(); await second.init();
  assert.equal(second.get().status, 'error'); assert.equal(second.get(extra.id).status, 'ready');
});

test('a failed saved identity still prevents duplicate cleanup through another token', async (t) => {
  const f = await fixture(t), first = f.create(); await first.init();
  const extra = await first.add({ token: 'second-secret' }); await first.shutdown();
  f.failures.set('second-secret', 'offline'); f.identities.set('alias-second', '2');
  const second = f.create(); await second.init();
  assert.equal(second.get(extra.id).status, 'error');
  await assert.rejects(second.add({ token: 'alias-second' }), /重复/);
  assert.deepEqual(f.calls.filter((call) => call.token === 'alias-second').map((call) => call.endpoint), ['user/me']);
});

test('corrupt default queue is retained byte for byte when restore fails', async (t) => {
  const f = await fixture(t), saved = '{malformed important recovery data';
  await writeFile(path.join(f.dir, 'queue.json'), saved);
  const manager = f.create(); await manager.init();
  assert.equal(manager.get().status, 'error'); assert.equal(manager.get().player, null);
  await manager.shutdown(); assert.equal(await readFile(path.join(f.dir, 'queue.json'), 'utf8'), saved);
});

test('remove waits for admitted web operations while another bot remains controllable', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const extra = await manager.add({ token: 'second-secret' }), player = manager.get(extra.id).player;
  let release; const blocked = new Promise((resolve) => { release = resolve; });
  const operation = manager.withBot(extra.id, async (runtime) => { await blocked; await runtime.player.add(context('202'), [song(21)]); });
  const removal = manager.remove(extra.id); await tick();
  assert.equal(manager.get(extra.id).status, 'stopping'); assert.equal(player.closed, false);
  await assert.rejects(manager.withBot(extra.id, () => {}), /关闭/);
  await manager.withBot('default', (runtime) => runtime.player.add(context('201'), [song(11)]));
  assert.equal(manager.get().player.current.id, '11');
  release(); await operation; await removal;
  assert.equal(player.closed, true); assert.throws(() => manager.get(extra.id), UserError);
  assert.equal(manager.get().player.snapshot().status, 'playing');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'bots.json'), 'utf8')).bots, []);
  assert.equal(JSON.parse(await readFile(player.file, 'utf8')).current.id, '21');
});

test('remove waits for the running KOOK command and discards queued commands', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const extra = await manager.add({ token: 'second-secret' }), runtime = manager.get(extra.id), player = runtime.player;
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  runtime.bot.handle = async () => { entered(); await blocked; await player.add(context('202'), [song(21)]); };
  runtime.bot.accept({ msg_id: '1', author_id: '41', target_id: '300', type: 1, channel_type: 'GROUP', content: '/点歌 21', extra: { guild_id: '100', author: { id: '41', bot: false } } });
  await started;
  runtime.bot.accept({ msg_id: '2', author_id: '42', target_id: '300', type: 1, channel_type: 'GROUP', content: '/点歌 22', extra: { guild_id: '100', author: { id: '42', bot: false } } });
  const removal = manager.remove(extra.id); await tick();
  assert.equal(player.closed, false); release(); await removal;
  const saved = JSON.parse(await readFile(player.file, 'utf8'));
  assert.equal(saved.current.id, '21'); assert.deepEqual(saved.queue, []);
});

test('unknown IDs never fall back and lifecycle closes admission during shutdown', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  assert.throws(() => manager.get('missing'), /找不到/);
  await assert.rejects(manager.withBot('missing', () => {}), /找不到/);
  await assert.rejects(manager.remove('default'), /默认机器人/);
  const closing = manager.shutdown();
  await assert.rejects(manager.withBot('default', () => {}), /关闭/);
  await assert.rejects(manager.add({ token: 'second-secret' }), /关闭/);
  await closing;
});

test('parallel adds cannot register the same identity twice and invalid guild IDs stay unpersisted', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  f.identities.set('second-alias', '2');
  const results = await Promise.allSettled([manager.add({ token: 'second-secret' }), manager.add({ token: 'second-alias' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(manager.list().length, 2);
  await assert.rejects(manager.add({ token: 'third-secret', guildIds: ['bad'] }), /数字 ID/);
  assert.equal(manager.list().length, 2);
});

test('shutdown during token validation prevents late gateway startup and config registration', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const createApi = manager.dependencies.createApi;
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  manager.dependencies.createApi = (token) => {
    const api = createApi(token), request = api.request;
    api.request = async (...args) => {
      if (token === 'second-secret' && args[0] === 'user/me') { entered(); await blocked; }
      return request(...args);
    };
    return api;
  };
  const adding = manager.add({ token: 'second-secret' });
  await started;
  const closing = manager.shutdown(); release();
  await assert.rejects(adding, UserError); await closing;
  assert.deepEqual(manager.list().map((item) => item.id), ['default']);
  assert.deepEqual(f.calls.filter((call) => call.token === 'second-secret').map((call) => call.endpoint), ['user/me']);
  await assert.rejects(readFile(path.join(f.dir, 'bots.json')), { code: 'ENOENT' });
});

test('a checkpoint failure during removal still stops audio and releases that bot voice allocation', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const extra = await manager.add({ token: 'second-secret' }), player = manager.get(extra.id).player;
  await player.add(context('202'), [song(21)]);
  const stream = player.stream;
  player.save = async () => { throw new Error('Disk full'); };
  await manager.remove(extra.id);
  assert.equal(stream.stopped, true); assert.equal(player.audio.connected, false); assert.equal(player.voiceJoined, false);
  assert.equal(f.calls.filter((call) => call.token === 'second-secret' && call.endpoint === 'voice/leave').length, 1);
  assert.equal(manager.get().status, 'ready');
});

test('a duplicate stored default token cannot prevent the original bot from starting', async (t) => {
  const f = await fixture(t);
  const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await writeFile(path.join(f.dir, 'bots.json'), JSON.stringify({ version: 1, bots: [{ id, token: 'main-secret', name: 'duplicate', guildIds: ['100'], botId: '1' }] }));
  const manager = f.create(); await manager.init();
  assert.equal(manager.get().status, 'ready'); assert.equal(manager.get(id).status, 'error');
  assert.equal(f.calls.filter((call) => call.endpoint === 'voice/list').length, 1);
});

test('public server IDs normalize to canonical IDs before registration and voice cleanup', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const extra = await manager.add({ token: 'second-secret', guildIds: ['172157', '100'] });
  assert.deepEqual(extra.guildIds, ['100']);
  assert.deepEqual([...manager.get(extra.id).config.guilds], ['100']);
  const saved = JSON.parse(await readFile(path.join(f.dir, 'bots.json'), 'utf8'));
  assert.deepEqual(saved.bots[0].guildIds, ['100']);
  const endpoints = f.calls.filter((call) => call.token === 'second-secret').map((call) => call.endpoint);
  assert.deepEqual(endpoints.slice(0, 3), ['user/me', 'guild/list', 'voice/list']);
  assert.equal(f.calls.filter((call) => call.token === 'main-secret' && call.endpoint === 'guild/list').length, 0);
});

test('server lookup traverses all official pages and preserves leading-zero public IDs', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  f.guildPages.set('second-secret', [
    { items: [{ id: '101', open_id: '111111' }], meta: { page: 1, page_total: 2, page_size: 1 } },
    { items: [{ id: '102', open_id: '012312413' }], meta: { page: 2, page_total: 2, page_size: 1 } },
  ]);
  const extra = await manager.add({ token: 'second-secret', guildIds: ['012312413'] });
  assert.deepEqual(extra.guildIds, ['102']);
  assert.deepEqual(f.calls.filter((call) => call.endpoint === 'guild/list').map((call) => call.params.page), [1, 2]);
});

test('unjoined, ambiguous, incomplete and failed server lists never persist or clean voice allocations', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  await assert.rejects(manager.add({ token: 'second-secret', guildIds: ['555'] }), /先邀请机器人/);
  f.guildPages.set('second-secret', [{ items: [{ id: '101', open_id: '555' }, { id: '102', open_id: '555' }], meta: { page: 1, page_total: 1 } }]);
  await assert.rejects(manager.add({ token: 'second-secret', guildIds: ['555'] }), /匹配到多个/);
  f.guildPages.set('second-secret', [{ items: [{ id: '101', open_id: '555' }], meta: { page: 1, page_total: 2 } }]);
  await assert.rejects(manager.add({ token: 'second-secret', guildIds: ['555'] }), /无法读取/);
  f.guildPages.set('second-secret', new Error('upstream secret second-secret'));
  await assert.rejects(manager.add({ token: 'second-secret' }), (error) => /无法读取/.test(error.message) && !error.message.includes('second-secret'));
  await assert.rejects(readFile(path.join(f.dir, 'bots.json')), { code: 'ENOENT' });
  assert.equal(f.calls.filter((call) => call.token === 'second-secret' && call.endpoint.startsWith('voice/')).length, 0);
  assert.equal(manager.get().status, 'ready');
});

test('canonical ID wins over another server public ID and duplicate page entries remain unambiguous', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  f.guildPages.set('second-secret', [{ items: [
    { id: '100', open_id: '172157' }, { id: '101', open_id: '100' }, { id: '100', open_id: '172157' },
  ], meta: { page: 1, page_total: 1 } }]);
  const extra = await manager.add({ token: 'second-secret', guildIds: ['100', '172157'] });
  assert.deepEqual(extra.guildIds, ['100']);
});

test('legacy saved public IDs normalize on startup before queue restore and persist canonical values', async (t) => {
  const f = await fixture(t), id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await writeFile(path.join(f.dir, 'bots.json'), JSON.stringify({ version: 1, bots: [{ id, token: 'second-secret', name: 'legacy', guildIds: ['172157'], botId: '2' }] }));
  const manager = f.create(); await manager.init();
  assert.deepEqual([...manager.get(id).config.guilds], ['100']);
  assert.equal(manager.get(id).player.config.guilds.has('100'), true);
  assert.equal(manager.get(id).bot.config.guilds.has('100'), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'bots.json'), 'utf8')).bots[0].guildIds, ['100']);
  assert.equal(manager.get().status, 'ready');
});

test('idle ready retry normalizes a legacy public ID without replacing any player or gateway', async (t) => {
  const f = await fixture(t), manager = f.create(); await manager.init();
  const extra = await manager.add({ token: 'second-secret' }), runtime = manager.get(extra.id);
  const mainPlayer = manager.get().player, extraPlayer = runtime.player, extraGateway = runtime.gateway;
  runtime.definition.guildIds = ['172157']; runtime.config.guilds = new Set(['172157']);
  await manager.persist(); f.calls.length = 0;
  const result = await manager.retry(extra.id);
  assert.deepEqual(result.guildIds, ['100']); assert.equal(runtime.player, extraPlayer); assert.equal(runtime.gateway, extraGateway);
  assert.equal(manager.get().player, mainPlayer); assert.equal(extraGateway.ready, true);
  assert.deepEqual(f.calls.map((call) => call.endpoint), ['guild/list']);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'bots.json'), 'utf8')).bots[0].guildIds, ['100']);
});
