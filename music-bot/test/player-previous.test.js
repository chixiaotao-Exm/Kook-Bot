import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Player } from '../src/player.js';
import { UnavailableError, UserError } from '../src/util.js';

const song = (id, source = 'netease') => ({ id: String(id), source, name: `Song ${id}`, artists: 'Artist', durationMs: 180000,
  ...(source === 'qq' ? { mid: `mid${id}` } : {}) });
const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
const ids = (tracks) => tracks.map((track) => track.id);

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-previous-test-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir, MAX_QUEUE_SIZE: '500' });
  const calls = [], handles = [], players = [];
  const api = { async post(endpoint, params) { calls.push({ endpoint, params }); return { ip: '127.0.0.1', port: 5004 }; } };
  const music = { async stream(track) { return `https://music.126.net/${track.id}.mp3`; } };
  const audio = {
    connected: false,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    start(url, voice, volume, offset, onEnd) {
      const handle = { url, voice, volume, offset, seconds: offset, onEnd, paused: false,
        async stop() { this.stopped = true; }, async setVolume(value) { this.volume = value; } };
      handles.push(handle); return handle;
    },
  };
  function createPlayer() {
    const player = new Player(config, api, music, audio, async () => {});
    players.push(player); return player;
  }
  const player = createPlayer();
  t.after(async () => {
    for (const item of players) await item.shutdown();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('kook-previous-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { player, createPlayer, config, music, audio, calls, handles, dir };
}

test('previous returns to a real played track from zero and next preserves source and pending order', async (t) => {
  const { player, handles, calls } = await fixture(t);
  const first = song(1, 'qq'), second = song(2), third = song(3, 'qq');
  await player.add(context, [first, second, third]);
  first.entryId = player.current.entryId; second.entryId = player.queue[0].entryId; third.entryId = player.queue[1].entryId;
  assert.equal(player.snapshot().canPrevious, false);
  await player.control('skip'); handles.at(-1).seconds = 61;
  assert.equal(player.snapshot().canPrevious, true);
  assert.equal(player.snapshot().historyCount, 1);
  await player.control('previous');
  assert.deepEqual(player.current, first);
  assert.equal(player.snapshot().seconds, 0);
  assert.deepEqual(player.queue, [second, third]);
  assert.equal(player.snapshot().historyCount, 0);
  assert.equal(player.snapshot().canPrevious, false);
  assert.equal('history' in player.snapshot(), false);
  await player.control('skip');
  assert.deepEqual(player.current, second);
  assert.deepEqual(player.queue, [third]);
  assert.deepEqual(player.history, [first]);
  assert.equal(calls.filter((call) => call.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'voice/leave').length, 0);
});

test('empty history rejects previous without restarting or moving the current song', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 45;
  await assert.rejects(player.control('previous'), /还没有/);
  assert.equal(player.snapshot().seconds, 45);
  assert.equal(player.stream, handles[0]);
  assert.equal(handles[0].stopped, undefined);
  assert.deepEqual(ids(player.queue), ['2']);
});

test('normal completion records each finished occurrence once and allows previous from idle', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1)]);
  handles[0].onEnd(null); await player.tail;
  assert.equal(player.current, null);
  assert.equal(player.snapshot().canPrevious, true);
  handles[0].onEnd(null); await player.tail;
  assert.equal(player.snapshot().historyCount, 1);
  await player.control('previous');
  assert.equal(player.current.id, '1');
  assert.equal(player.snapshot().status, 'playing');
  assert.equal(player.snapshot().seconds, 0);
});

test('unavailable tracks and unsuccessful starts never become previous tracks', async (t) => {
  const { player, music } = await fixture(t);
  music.stream = async (track) => {
    if (track.id === '1') throw new UnavailableError('No full audio');
    if (track.id === '3') throw new UserError('Temporarily offline');
    return `https://music.126.net/${track.id}.mp3`;
  };
  await player.add(context, [song(1), song(2), song(3), song(4)]);
  for (let attempt = 0; attempt < 100 && player.current?.id !== '2'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10)); await player.tail;
  }
  assert.equal(player.current.id, '2');
  assert.equal(player.snapshot().historyCount, 0);
  await player.control('skip');
  assert.equal(player.current.id, '3');
  assert.equal(player.snapshot().status, 'recovering');
  await player.control('skip');
  assert.equal(player.current.id, '4');
  assert.deepEqual(ids(player.history), ['2']);
  await player.control('previous');
  assert.equal(player.current.id, '2');
  assert.deepEqual(ids(player.queue), ['4']);
});

test('pause, seek and resume do not add history; previous from paused starts playback like skip', async (t) => {
  const { player, handles, calls } = await fixture(t);
  await player.add(context, [song(1), song(2)]);
  await player.control('pause'); await player.control('seek', 30); await player.control('resume');
  assert.equal(player.snapshot().historyCount, 0);
  await player.control('skip'); await player.control('pause'); await player.control('volume', 34);
  await player.control('previous');
  assert.equal(player.current.id, '1');
  assert.equal(player.snapshot().status, 'playing');
  assert.equal(handles.at(-1).offset, 0);
  assert.equal(handles.at(-1).volume, 34);
  assert.equal(calls.filter((call) => call.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'voice/leave').length, 0);
});

test('decoder retries and stale callbacks do not duplicate or advance history', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]);
  const first = handles[0]; first.seconds = 75;
  first.onEnd(new UserError('Network')); await player.tail;
  assert.equal(player.snapshot().historyCount, 0);
  await player.control('resume'); const retried = handles.at(-1);
  assert.equal(retried.offset, 75);
  first.onEnd(null); await player.tail;
  assert.equal(player.current.id, '1');
  await player.control('skip');
  retried.onEnd(null); await player.tail;
  assert.equal(player.current.id, '2');
  assert.deepEqual(ids(player.history), ['1']);
  await player.control('previous');
  retried.onEnd(null); await player.tail;
  assert.equal(player.current.id, '1');
  assert.equal(player.snapshot().historyCount, 0);
});

test('single and queue loops preserve intentional repeated playback in history', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]);
  await player.control('loop', 'one');
  handles.at(-1).onEnd(null); await player.tail;
  handles.at(-1).onEnd(null); await player.tail;
  assert.deepEqual(ids(player.history), ['1', '1']);
  assert.equal(player.current.id, '1');
  await player.control('skip');
  assert.equal(player.current.id, '2');
  await player.control('loop', 'all');
  handles.at(-1).onEnd(null); await player.tail;
  assert.equal(player.current.id, '2');
  assert.deepEqual(ids(player.history), ['1', '1', '1', '2']);
  await player.control('previous');
  assert.equal(player.current.id, '2');
  assert.deepEqual(ids(player.queue), ['2']);
  assert.deepEqual(ids(player.history), ['1', '1', '1']);
});

test('history survives restart with mixed source metadata and remains bounded at 50 entries', async (t) => {
  const { player, createPlayer, dir } = await fixture(t);
  await player.add(context, Array.from({ length: 53 }, (_, i) => song(i + 1, i % 2 ? 'qq' : 'netease')));
  for (let i = 0; i < 52; i++) await player.control('skip');
  await player.control('pause'); await player.shutdown();
  const saved = JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.history.length, 50);
  assert.equal(saved.history[0].id, '3');
  const restored = createPlayer(); await restored.restore();
  assert.equal(restored.snapshot().historyCount, 50);
  assert.equal(restored.snapshot().canPrevious, true);
  await restored.control('previous');
  assert.deepEqual(restored.current, { ...song(52, 'qq'), entryId: saved.history.at(-1).entryId });
  assert.deepEqual(ids(restored.queue), ['53']);
  assert.equal(restored.snapshot().historyCount, 49);
  assert.equal(restored.snapshot().status, 'playing');
});

test('old queue records without history still restore and invalid history is rejected', async (t) => {
  const { player, dir } = await fixture(t);
  const file = path.join(dir, 'queue.json');
  for (const version of [1, 2]) {
    await writeFile(file, JSON.stringify({ version, context, current: song(1), queue: [song(2)] }));
    await player.restore();
    assert.equal(player.current.id, '1');
    assert.equal(player.snapshot().historyCount, 0);
    assert.equal(player.snapshot().canPrevious, false);
  }
  await writeFile(file, JSON.stringify({ version: 2, context, current: song(1), queue: [], history: [{ id: 'bad' }] }));
  await assert.rejects(player.restore(), /格式无效/);
});

test('each bot owns independent playback history and persisted state', async (t) => {
  const first = await fixture(t), second = await fixture(t);
  await Promise.all([
    first.player.add(context, [song(1), song(2)]),
    second.player.add({ ...context, voiceChannelId: 'v2' }, [song(3), song(4)]),
  ]);
  await first.player.control('skip');
  assert.equal(first.player.snapshot().canPrevious, true);
  assert.equal(second.player.snapshot().canPrevious, false);
  await second.player.control('skip');
  await first.player.control('previous');
  assert.equal(first.player.current.id, '1');
  assert.equal(second.player.current.id, '4');
  assert.deepEqual(ids(second.player.history), ['3']);
  const saved = JSON.parse(await readFile(path.join(second.dir, 'queue.json'), 'utf8'));
  assert.deepEqual(ids(saved.history), ['3']);
});

test('a full 500-track queue rejects previous without discarding tracks and becomes available after removal', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, Array.from({ length: 500 }, (_, i) => song(i + 1)));
  await player.control('skip'); await player.add(context, [song(501)]);
  const before = structuredClone(player.queue), currentHandle = handles.at(-1);
  assert.equal(player.snapshot().capacity, 0);
  assert.equal(player.snapshot().canPrevious, false);
  assert.equal(player.snapshot().historyCount, 1);
  await assert.rejects(player.control('previous'), /先移除一首/);
  assert.deepEqual(player.queue, before);
  assert.equal(player.current.id, '2');
  assert.equal(player.stream, currentHandle);
  assert.equal(currentHandle.stopped, undefined);
  await player.control('remove', 499);
  assert.equal(player.snapshot().canPrevious, true);
  await player.control('previous');
  assert.equal(player.current.id, '1');
  assert.equal(player.queue.length, 499);
  assert.deepEqual(ids(player.queue), Array.from({ length: 499 }, (_, i) => String(i + 2)));
});

test('stop clears playback history while clear only removes pending tracks', async (t) => {
  const { player, dir } = await fixture(t);
  await player.add(context, [song(1), song(2), song(3)]);
  await player.control('skip'); await player.control('clear');
  assert.equal(player.snapshot().historyCount, 1);
  await player.control('stop');
  assert.equal(player.snapshot().historyCount, 0);
  assert.equal(player.snapshot().canPrevious, false);
  const saved = JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8'));
  assert.deepEqual(saved.history, []);
});
