import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Player } from '../src/player.js';
import { Bot } from '../src/bot.js';
import { RoomFeatures } from '../src/room-features.js';

const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
const song = (id) => ({ id, name: `Song ${id}`, artists: 'Artist', durationMs: 180000 });
const commandEvent = (id, content) => ({ msg_id: id, author_id: id, target_id: 't1', content,
  type: 1, channel_type: 'GROUP', extra: { guild_id: 'g1', author: { id, bot: false } } });

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-channel-binding-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1,g2', DATA_DIR: dir, STAY_CONNECTED: 'true' });
  const calls = []; const handles = []; const messages = [];
  const api = { async post(endpoint, params) { calls.push({ endpoint, params }); return { ip: '127.0.0.1', port: '5004' }; } };
  const music = { async stream(track) { calls.push({ endpoint: 'stream', id: track.id }); return `https://music.126.net/${track.id}.mp3`; } };
  const audio = { start(url, voice, volume, offset, onEnd) { const handle = { seconds: offset, startOffset: offset, paused: false, onEnd,
    async stop() { this.stopped = true; }, async setVolume(value) { this.volume = value; } }; handles.push(handle); return handle; } };
  const player = new Player(config, api, music, audio, async (_, message) => messages.push(message));
  t.after(async () => { await player.shutdown(); assert.ok(path.basename(dir).startsWith('kook-channel-binding-')); await rm(dir, { recursive: true, force: true }); });
  return { player, calls, handles, messages, config, api, music };
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

test('late KOOK song and playlist queries cannot undo web stop, clear or pause', async (t) => {
  for (const action of ['play', 'playlist', 'heart', 'hot']) {
    for (const control of ['stop', 'clear', 'pause']) await t.test(`${action} after ${control}`, async (t) => {
      const { player, calls, handles, config, api, music } = await fixture(t);
      await player.add(context, [song('1'), song('2')]);
      api.request = async () => ({ items: [{ type: 2, id: context.voiceChannelId }] });
      api.reply = async () => {};
      let release, entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      const method = action === 'play' ? 'resolve' : action;
      music[method] = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
      const bot = new Bot(config, api, music, player);
      const rejected = assert.rejects(bot.handle({ msg_id: 'fixture', author_id: 'member', target_id: 't1', extra: { guild_id: 'g1' } },
        { action, value: action === 'play' ? 'Song' : '123' }), /播放状态已变化/);
      await waiting;
      await player.control(control);
      const expected = structuredClone(player.snapshot());
      const joins = calls.filter(call => call.endpoint === 'voice/join').length;
      release(action === 'play' ? song('3') : action === 'playlist' ? [song('3')] : { tracks: [song('3')] });
      await rejected;
      assert.deepEqual(player.snapshot(), expected);
      assert.equal(handles.length, 1);
      assert.equal(calls.filter(call => call.endpoint === 'voice/join').length, joins);
    });
  }
});

test('KOOK request generation is captured before asynchronous multi-bot routing', async (t) => {
  const { player, config, api, music } = await fixture(t);
  await player.add(context, [song('1')]);
  api.request = async () => ({ items: [{ type: 2, id: context.voiceChannelId }] });
  api.reply = async () => {};
  music.resolve = async () => song('2');
  let route;
  const bot = new Bot(config, api, music, player, () => new Promise(resolve => { route = resolve; }));
  const rejected = assert.rejects(bot.handle({ msg_id: 'fixture', author_id: 'member', target_id: 't1', extra: { guild_id: 'g1' } },
    { action: 'play', value: 'Song' }), /播放状态已变化/);
  await player.control('stop');
  route(true); await rejected;
  assert.equal(player.current, null); assert.equal(player.context, null); assert.deepEqual(player.queue, []);
});

test('a stop during missing-author verification also invalidates the admitted song request', async (t) => {
  const { player, config, api, music, calls } = await fixture(t);
  await player.add(context, [song('1')]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  api.request = async endpoint => {
    if (endpoint === 'user/view') { entered(); return new Promise(resolve => { release = resolve; }); }
    return { items: [{ type: 2, id: 'v1' }] };
  };
  const replies = []; api.reply = async (_, content) => replies.push(content);
  music.resolve = async () => song('2');
  const bot = new Bot(config, api, music, player);
  assert.equal(bot.accept({ type: 1, channel_type: 'GROUP', msg_id: 'identity-stop', author_id: '42',
    target_id: 't1', content: '/点歌 Song', extra: { guild_id: 'g1' } }), true);
  await waiting;
  await player.control('stop');
  release({ id: '42', bot: false }); await bot.draining;
  assert.equal(player.current, null); assert.equal(player.context, null); assert.deepEqual(player.queue, []);
  assert.equal(calls.filter(call => call.endpoint === 'voice/join').length, 1);
  assert.match(replies.at(-1), /播放状态已变化/);
});

test('all song commands accepted before a web stop expire, while a command accepted afterwards can play', async (t) => {
  const { player, config, api, music } = await fixture(t);
  await player.add(context, [song('1')]);
  api.request = async () => ({ items: [{ type: 2, id: 'v1' }] });
  api.reply = async () => {};
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  music.resolve = async id => {
    if (id === '2') { entered(); return new Promise(resolve => { release = () => resolve(song(id)); }); }
    return song(id);
  };
  const bot = new Bot(config, api, music, player);
  bot.accept(commandEvent('41', '/点歌 2')); await waiting;
  bot.accept(commandEvent('42', '/点歌 3'));
  assert.equal(bot.inbox.length, 1);
  await player.control('stop'); player.lastLeave = 0;
  bot.accept(commandEvent('43', '/点歌 4'));
  release(); await bot.draining;
  assert.equal(player.current?.id, '4'); assert.deepEqual(player.queue, []);
});

test('two song commands received while idle keep their order when the first establishes voice context', async (t) => {
  const { player, config, api, music } = await fixture(t);
  api.request = async () => ({ items: [{ type: 2, id: 'v1' }] }); api.reply = async () => {};
  music.resolve = async id => song(id);
  const bot = new Bot(config, api, music, player);
  bot.accept(commandEvent('41', '/点歌 1')); bot.accept(commandEvent('42', '/点歌 2'));
  await bot.draining;
  assert.equal(player.current?.id, '1'); assert.deepEqual(player.queue.map(track => track.id), ['2']);
});

test('an old pause cannot affect a new song after leaving and rejoining the same voice channel', async (t) => {
  const { player, config, api, music } = await fixture(t);
  await player.add(context, [song('1')]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  api.request = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const replies = []; api.reply = async (_, content) => replies.push(content);
  const bot = new Bot(config, api, music, player);
  bot.accept(commandEvent('41', '/暂停')); await waiting;
  await player.control('stop'); player.lastLeave = 0;
  await player.add(context, [song('2')]);
  const expected = structuredClone(player.snapshot());
  release({ items: [{ type: 2, id: 'v1' }] }); await bot.draining;
  assert.deepEqual(player.snapshot(), expected);
  assert.match(replies.at(-1), /播放状态已变化/);
});

test('old KOOK vote commands never start voting after the original voice lookup outlives its song', async (t) => {
  for (const command of ['/投票切歌', '/下一首']) {
    for (const transition of ['stop-and-rejoin', 'natural-end']) await t.test(`${command} ${transition}`, async (t) => {
      const { player, config, api, music } = await fixture(t);
      const features = new RoomFeatures({ config, player, api, music, selfId: '1', intervalMs: 9999999 });
      await features.init(); t.after(() => features.close());
      await features.configure('rules', { enabled: true });
      await player.add(context, [song('1'), song('2')]);
      let release, entered, votesStarted = 0;
      const waiting = new Promise(resolve => { entered = resolve; });
      api.request = async endpoint => {
        if (endpoint === 'channel-user/get-joined-channel') { entered(); return new Promise(resolve => { release = resolve; }); }
        return [{ id: '42', bot: false }, { id: '43', bot: false }];
      };
      api.reply = async () => {};
      const vote = features.vote.bind(features);
      features.vote = (...args) => { votesStarted++; return vote(...args); };
      const bot = new Bot(config, api, music, player);
      bot.accept(commandEvent('42', command)); await waiting;
      if (transition === 'stop-and-rejoin') {
        await player.control('stop'); player.lastLeave = 0;
        await player.add(context, [song('2')]);
      } else {
        player.stream.onEnd(null); await player.tail;
      }
      release({ items: [{ type: 2, id: 'v1' }] }); await bot.draining;
      assert.equal(votesStarted, 0); assert.equal(features.snapshot().votes.count, 0);
      assert.equal(player.current.id, '2'); assert.equal(player.snapshot().status, 'playing');
    });
  }
});

test('queued KOOK pause/resume and stop/new-song sequences preserve intentional FIFO controls', async (t) => {
  for (const controls of [['/暂停', '/继续'], ['/停止', '/点歌 3']]) await t.test(controls.join(' then '), async (t) => {
    const { player, config, api, music } = await fixture(t);
    await player.add(context, [song('1')]);
    api.request = async () => ({ items: [{ type: 2, id: 'v1' }] });
    const replies = []; api.reply = async (_, content) => replies.push(content);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    music.resolve = async id => {
      if (id === '2') { entered(); return new Promise(resolve => { release = () => resolve(song(id)); }); }
      return song(id);
    };
    const bot = new Bot(config, api, music, player);
    bot.accept(commandEvent('41', '/点歌 2')); await waiting;
    bot.accept(commandEvent('42', controls[0])); bot.accept(commandEvent('43', controls[1]));
    release(); await bot.draining;
    assert.equal(player.snapshot().status, 'playing');
    assert.equal(player.current.id, controls[0] === '/停止' ? '3' : '1');
    assert.deepEqual(player.queue.map(track => track.id), controls[0] === '/停止' ? [] : ['2']);
    assert.equal(replies.some(reply => /播放状态已变化/.test(reply)), false);
  });
});

test('volume changes do not cancel song commands already accepted into the KOOK inbox', async (t) => {
  const { player, config, api, music } = await fixture(t);
  await player.add(context, [song('1')]);
  api.request = async () => ({ items: [{ type: 2, id: 'v1' }] }); api.reply = async () => {};
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  music.resolve = async id => {
    if (id === '2') { entered(); return new Promise(resolve => { release = () => resolve(song(id)); }); }
    return song(id);
  };
  const bot = new Bot(config, api, music, player);
  bot.accept(commandEvent('41', '/点歌 2')); await waiting;
  bot.accept(commandEvent('42', '/点歌 3'));
  await player.control('volume', 23); release(); await bot.draining;
  assert.equal(player.volume, 23); assert.deepEqual(player.queue.map(track => track.id), ['2', '3']);
});

test('an external clear while a KOOK pause finishes never refreshes old queued request epochs', async (t) => {
  const { player, config, api, music, handles } = await fixture(t);
  await player.add(context, [song('1')]);
  api.request = async () => ({ items: [{ type: 2, id: 'v1' }] }); api.reply = async () => {};
  music.resolve = async id => song(id);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  handles[0].stop = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const bot = new Bot(config, api, music, player);
  bot.accept(commandEvent('41', '/暂停')); await waiting;
  bot.accept(commandEvent('42', '/点歌 2'));
  const clearing = player.control('clear');
  release(); await clearing; await bot.draining;
  assert.equal(player.snapshot().status, 'paused'); assert.equal(player.current.id, '1');
  assert.deepEqual(player.queue, []);
});

test('KOOK control verified for an old voice channel cannot act on its replacement', async (t) => {
  const { player, config, api, music } = await fixture(t);
  await player.add(context, [song('1')]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  api.request = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  api.reply = async () => {};
  const bot = new Bot(config, api, music, player);
  const rejected = assert.rejects(bot.handle({ msg_id: 'fixture', author_id: '42', target_id: 't1', extra: { guild_id: 'g1' } },
    { action: 'pause', value: '' }), /频道已变化|播放状态已变化/);
  await waiting;
  await player.control('stop'); player.lastLeave = 0;
  await player.add({ ...context, voiceChannelId: 'v2' }, [song('2')]);
  const expected = structuredClone(player.snapshot());
  release({ items: [{ type: 2, id: 'v1' }] });
  await rejected;
  assert.deepEqual(player.snapshot(), expected);
});

test('queued KOOK controls recheck manager permission before mutating the player', async (t) => {
  for (const action of ['pause', 'volume', 'skip']) await t.test(action, async (t) => {
    const { player, config, api, music } = await fixture(t);
    const features = new RoomFeatures({ config, player, api, music, selfId: '1', intervalMs: 9999999 });
    await features.init(); t.after(() => features.close());
    await features.configure('rules', { enabled: true, managerIds: ['42'] });
    await player.add(context, [song('1'), song('2')]);
    api.reply = async () => {};
    let release;
    const blocked = player.exclusive(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const bot = new Bot(config, api, music, player);
    const rejected = assert.rejects(bot.handle({ msg_id: 'fixture', author_id: '42', target_id: 't1', extra: { guild_id: 'g1' } },
      { action, value: action === 'volume' ? '33' : '' }), /管理员|投票/);
    await new Promise(resolve => setImmediate(resolve));
    await features.configure('rules', { managerIds: [] });
    const expected = structuredClone(player.snapshot());
    release(); await blocked; await rejected;
    assert.deepEqual(player.snapshot(), expected);
  });
});

test('KOOK imports apply current per-user rules after a slow provider result', async (t) => {
  for (const manager of [false, true]) await t.test(manager ? 'manager revoked' : 'limit lowered', async (t) => {
    const { player, config, api, music } = await fixture(t);
    const features = new RoomFeatures({ config, player, api, music, selfId: '1', intervalMs: 9999999 });
    await features.init(); t.after(() => features.close());
    await features.configure('rules', { enabled: true, perUserLimit: 5, preventDuplicates: false, managerIds: manager ? ['42'] : [] });
    await player.add(context, [song('1')]);
    api.request = async () => ({ items: [{ type: 2, id: 'v1' }] });
    api.reply = async () => {};
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    music.playlist = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const bot = new Bot(config, api, music, player);
    const importing = bot.handle({ msg_id: 'fixture', author_id: '42', target_id: 't1', extra: { guild_id: 'g1' } },
      { action: 'playlist', value: '123' });
    await waiting;
    await features.configure('rules', { perUserLimit: 1, preventDuplicates: true, managerIds: [] });
    release([song('2'), song('2'), song('3')]); await importing;
    assert.deepEqual(player.queue.map(track => track.id), ['2']);
    assert.equal(player.queue[0].requestedBy, '42');
  });
});
