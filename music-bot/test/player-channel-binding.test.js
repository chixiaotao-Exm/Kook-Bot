import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Player } from '../src/player.js';

const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
const song = (id) => ({ id, name: `Song ${id}`, artists: 'Artist', durationMs: 180000 });

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-channel-binding-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1,g2', DATA_DIR: dir, STAY_CONNECTED: 'true' });
  const calls = []; const handles = []; const messages = [];
  const api = { async post(endpoint, params) { calls.push({ endpoint, params }); return { ip: '127.0.0.1', port: '5004' }; } };
  const music = { async stream(track) { calls.push({ endpoint: 'stream', id: track.id }); return `https://music.126.net/${track.id}.mp3`; } };
  const audio = { start(url, voice, volume, offset) { const handle = { seconds: offset, startOffset: offset, paused: false, async stop() { this.stopped = true; } }; handles.push(handle); return handle; } };
  const player = new Player(config, api, music, audio, async (_, message) => messages.push(message));
  t.after(async () => { await player.shutdown(); assert.ok(path.basename(dir).startsWith('kook-channel-binding-')); await rm(dir, { recursive: true, force: true }); });
  return { player, calls, handles, messages };
}

test('channel-bound additions succeed only in their current voice/guild and legacy additions still initialize a channel', async (t) => {
  const { player, calls } = await fixture(t);
  await assert.rejects(player.add(context, [song('1')], { expectedVoiceChannelId: 'v1' }), /频道已变化/);
  assert.equal(calls.length, 0); assert.equal(player.context, null); assert.equal(player.queue.length, 0);
  assert.equal(await player.add(context, [song('1')]), 1);
  assert.equal(await player.add(context, [song('2')], { expectedVoiceChannelId: 'v1' }), 1);
  assert.equal(player.current.id, '1'); assert.deepEqual(player.queue.map((track) => track.id), ['2']);
  const before = await readFile(player.file, 'utf8'); const count = calls.length;
  for (const [requested, expectedVoiceChannelId] of [
    [context, 'v2'], [{ ...context, voiceChannelId: 'v2' }, 'v1'], [{ ...context, guildId: 'g2' }, 'v1'],
  ]) await assert.rejects(player.add(requested, [song('3')], { expectedVoiceChannelId }), /频道已变化/);
  assert.equal(calls.length, count); assert.equal(await readFile(player.file, 'utf8'), before);
  assert.deepEqual(player.queue.map((track) => track.id), ['2']);
});

test('a queued leave before a bound addition is checked atomically and cannot rejoin the old channel', async (t) => {
  const { player, calls, handles, messages } = await fixture(t);
  await player.add(context, [song('1')]);
  const originalMessages = messages.length;
  let release;
  const blocked = player.exclusive(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const leaving = player.control('stop');
  const addRejected = assert.rejects(player.add(context, [song('2')], { expectedVoiceChannelId: 'v1' }), /频道已变化/);
  release(); await blocked; await leaving; await addRejected;
  assert.equal(player.context, null); assert.equal(player.current, null); assert.equal(player.queue.length, 0);
  assert.equal(player.voiceJoined, false); assert.equal(handles.length, 1); assert.equal(messages.length, originalMessages);
  assert.equal(calls.filter((call) => call.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'stream').length, 1);
  const saved = JSON.parse(await readFile(player.file, 'utf8'));
  assert.equal(saved.context, null); assert.equal(saved.current, null); assert.deepEqual(saved.queue, []);
});

test('a delayed bound addition cannot follow a previously queued change to another channel', async (t) => {
  const { player, calls } = await fixture(t);
  player.context = context; player.current = song('1');
  await player.save();
  let release;
  const blocked = player.exclusive(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const moved = player.exclusive(async () => { player.context = { ...context, voiceChannelId: 'v2' }; await player.save(); });
  const addRejected = assert.rejects(player.add(context, [song('2')], { expectedVoiceChannelId: 'v1' }), /频道已变化/);
  release(); await blocked; await moved; await addRejected;
  assert.equal(player.context.voiceChannelId, 'v2'); assert.equal(player.current.id, '1'); assert.deepEqual(player.queue, []);
  assert.equal(calls.length, 0);
  const saved = JSON.parse(await readFile(player.file, 'utf8'));
  assert.equal(saved.context.voiceChannelId, 'v2'); assert.deepEqual(saved.queue, []);
});
