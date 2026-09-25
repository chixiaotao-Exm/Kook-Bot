import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Player } from '../src/player.js';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';

const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-leave-'));
  const config = readConfig({ KOOK_TOKEN: 'fixture', ALLOWED_GUILD_IDS: 'g1', STAY_CONNECTED: 'true', DATA_DIR: dataDir });
  const members = new Set(['v1']), calls = [];
  let failing = true, disconnected = 0;
  const api = {
    async request(route) { assert.equal(route, 'voice/list'); return { items: [...members].map(id => ({ id })) }; },
    async post(route, params) {
      calls.push({ route, ...params });
      if (route === 'voice/leave') { if (failing) throw new Error('fixture network failure'); members.delete(params.channel_id); }
      if (route === 'voice/join') members.add(params.channel_id);
      return {};
    },
  };
  const audio = { async disconnect() { disconnected++; }, async connect() {} };
  const player = new Player(config, api, {}, audio, async () => {});
  player.context = { ...context }; player.voiceJoined = true;
  player.current = { id: '1', name: 'Song', artists: 'Artist', durationMs: 100000 };
  player.intent = 'playing'; player.stream = { seconds: 20, async stop() {} };
  t.after(async () => { failing = false; await player.shutdown(); await rm(dataDir, { recursive: true, force: true }); });
  return { player, config, api, audio, members, calls, setFailing: value => { failing = value; },
    disconnected: () => disconnected, saved: async () => JSON.parse(await readFile(player.file, 'utf8')) };
}

test('failed leave stops audio, retains a durable cleanup target and never claims confirmed departure', async t => {
  const f = await fixture(t);
  const message = await f.player.control('stop');
  assert.match(message, /退出语音频道尚未确认/);
  assert.equal(f.player.stream, null); assert.equal(f.player.current, null); assert.equal(f.player.context, null);
  assert.equal(f.player.intent, 'idle'); assert.equal(f.player.snapshot().leaving, true);
  assert.equal(f.members.has('v1'), true); assert.ok(f.disconnected() > 0);
  const saved = await f.saved();
  assert.equal(saved.intent, 'idle'); assert.equal(saved.current, null); assert.deepEqual(saved.queue, []);
  assert.deepEqual(saved.pendingLeave, { guildId: 'g1', channelId: 'v1', attempts: 1 });
  f.setFailing(false);
  await f.player.exclusive(() => f.player.maintainVoice());
  assert.equal(f.members.size, 0); assert.equal(f.player.pendingLeave, null); assert.equal(f.player.leaveTimer, null);
  assert.equal((await f.saved()).pendingLeave, null); assert.equal(f.player.stream, null);
});

test('automatic leave attempts are bounded, and repeated ticks neither rejoin nor replay audio', async t => {
  const f = await fixture(t); await f.player.control('stop');
  for (let i = 0; i < 10; i++) await f.player.exclusive(() => f.player.maintainVoice());
  assert.equal(f.calls.filter(call => call.route === 'voice/leave').length, 3);
  assert.equal(f.player.pendingLeave.attempts, 3); assert.equal(f.player.leaveTimer, null);
  assert.equal(f.calls.some(call => call.route === 'voice/join'), false); assert.equal(f.player.stream, null);
  f.setFailing(false); assert.match(await f.player.control('stop'), /已停止播放.*离开频道/);
  assert.equal(f.player.pendingLeave, null); assert.equal(f.members.size, 0);
});

test('the cleanup timer performs only its bounded attempts and shutdown removes it', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.player.control('stop');
  t.mock.timers.tick(9000); await f.player.tail;
  assert.equal(f.player.pendingLeave.attempts, 2);
  t.mock.timers.tick(27000); await f.player.tail;
  assert.equal(f.player.pendingLeave.attempts, 3); assert.equal(f.player.leaveTimer, null);
  t.mock.timers.tick(100000); await f.player.tail;
  assert.equal(f.calls.filter(call => call.route === 'voice/leave').length, 3);
  await f.player.shutdown(); assert.equal(f.player.leaveTimer, null);
});

test('restored pending leave can be verified absent without repeating an already successful remote leave', async t => {
  const f = await fixture(t); await f.player.control('stop');
  clearTimeout(f.player.leaveTimer); f.player.leaveTimer = null;
  f.members.clear();
  const restored = new Player(f.config, f.api, {}, f.audio, async () => {});
  t.after(() => restored.shutdown());
  await restored.restore(); assert.equal(restored.pendingLeave.channelId, 'v1');
  await restored.exclusive(() => restored.maintainVoice());
  assert.equal(restored.pendingLeave, null); assert.equal(restored.stream, null);
  assert.equal(f.calls.filter(call => call.route === 'voice/leave').length, 1);
});

test('a new join cannot bypass failed cleanup, and no old timer can leave the new channel', async t => {
  const f = await fixture(t); await f.player.control('stop');
  const next = { ...context, voiceChannelId: 'v2' };
  await assert.rejects(f.player.join(next), /退出语音频道尚未确认/);
  assert.equal(f.player.context, null);
  assert.equal(f.calls.some(call => call.route === 'voice/join'), false);
  f.setFailing(false);
  const joining = f.player.join(next);
  // Keep the production cooldown in this integration path.
  await joining;
  assert.deepEqual([...f.members], ['v2']); assert.equal(f.player.pendingLeave, null); assert.equal(f.player.leaveTimer, null);
  const leaves = f.calls.filter(call => call.route === 'voice/leave').length;
  await f.player.exclusive(() => f.player.maintainVoice());
  assert.equal(f.calls.filter(call => call.route === 'voice/leave').length, leaves);
  assert.equal(f.members.has('v2'), true);
});

test('failure to persist cleanup intent stops audio and cannot report a successful leave', async t => {
  const f = await fixture(t); const events = []; f.player.subscribe(event => events.push(event));
  const save = f.player.save; f.player.save = async () => { throw new Error('fixture disk unavailable'); };
  await assert.rejects(f.player.control('stop'), /disk unavailable/);
  assert.equal(f.player.stream, null); assert.equal(f.player.intent, 'idle'); assert.equal(f.player.current, null);
  assert.equal(f.calls.some(call => call.route === 'voice/leave'), false);
  assert.equal(events.some(event => event.kind === 'leave'), false);
  f.player.save = save;
});

test('the first Stop checkpoint restores only pending departure and cannot rejoin as a resident bot', async t => {
  const f = await fixture(t); f.setFailing(false);
  let release, entered;
  const reachingLeave = new Promise(resolve => { entered = resolve; });
  const originalPost = f.api.post;
  f.api.post = async (route, params) => {
    if (route === 'voice/leave') { entered(); await new Promise(resolve => { release = resolve; }); }
    return originalPost(route, params);
  };
  const stopping = f.player.control('stop'); await reachingLeave;
  const checkpoint = await f.saved();
  assert.equal(checkpoint.context, null); assert.equal(checkpoint.current, null); assert.equal(checkpoint.intent, 'idle');
  assert.deepEqual(checkpoint.pendingLeave, { guildId: 'g1', channelId: 'v1', attempts: 1 });
  release(); await stopping; f.api.post = originalPost;

  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-leave-restart-')), calls = [];
  const api = { async request() { return { items: [{ id: 'v1' }] }; }, async post(route) { calls.push(route); return {}; } };
  const restored = new Player({ ...f.config, dataDir }, api, {}, f.audio, async () => {});
  t.after(async () => { await restored.shutdown(); await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(restored.file, JSON.stringify(checkpoint)); await restored.restore();
  // Match BotManager's resident startup branch using the actual restored state.
  if (restored.stayConnected && restored.context && restored.intent !== 'playing') await restored.join(restored.context);
  await restored.resumeAfterRestart();
  await restored.exclusive(() => restored.maintainVoice());
  assert.deepEqual(calls, ['voice/leave']); assert.equal(restored.voiceJoined, false);
  assert.equal(restored.context, null); assert.equal(restored.stream, null); assert.equal(restored.pendingLeave, null);
});

test('shutdown still stops audio and leaves after checkpoint failure while reporting the original error', async t => {
  const f = await fixture(t); f.setFailing(false); let stopped = 0;
  f.player.stream.stop = async () => { stopped++; };
  const save = f.player.save, failure = new Error('fixture shutdown disk failure');
  f.player.save = async () => { throw failure; };
  await assert.rejects(f.player.shutdown(), error => error === failure);
  assert.equal(stopped, 1); assert.ok(f.disconnected() > 0); assert.equal(f.player.stream, null);
  assert.equal(f.player.voiceJoined, false); assert.equal(f.player.pendingLeave, null); assert.equal(f.members.size, 0);
  assert.equal(f.calls.filter(call => call.route === 'voice/leave').length, 1);
  f.player.save = save;
});

test('a slow console catalog join cannot override stop or increment the newer epoch', async t => {
  const f = await fixture(t); f.setFailing(false);
  const web = new WebConsole({ ...f, music: {} }); let release;
  web.context = () => new Promise(resolve => { release = () => resolve({ ...context }); });
  const runtime = { id: 'default', player: f.player, config: f.config, status: 'ready' };
  const joining = assert.rejects(web.post('/api/channel', {}, runtime), /播放状态已变化/);
  await turn(); await f.player.control('stop'); const epoch = f.player.operationEpoch;
  release(); await joining;
  assert.equal(f.player.operationEpoch, epoch); assert.equal(f.player.context, null);
  assert.equal(f.calls.some(call => call.route === 'voice/join'), false);
});

test('join rechecks the generation after asynchronous authorization inside the player lock', async t => {
  const f = await fixture(t); f.setFailing(false); let release;
  const joining = assert.rejects(f.player.join(context, { expectedEpoch: f.player.operationEpoch, authorize: () => new Promise(resolve => { release = resolve; }) }), /播放状态已变化/);
  await turn(); const stopping = f.player.control('stop'); release(); await Promise.all([joining, stopping]);
  assert.equal(f.player.context, null); assert.equal(f.calls.some(call => call.route === 'voice/join'), false);
});
