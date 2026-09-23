import test from 'node:test';
import assert from 'node:assert/strict';
import { BotManager } from '../src/bot-manager.js';
import { Bot, parseCommand } from '../src/bot.js';
import { readConfig } from '../src/config.js';

const context = (room) => ({ guildId: '100', voiceChannelId: room, textChannelId: '300' });
const event = (id, user = '400', content = '/帮助') => ({ msg_id: id, author_id: user, target_id: '300', type: 1, channel_type: 'GROUP', content, extra: { guild_id: '100' } });

function fixture(rooms = ['201', '202']) {
  const config = readConfig({ KOOK_TOKEN: 'main', ALLOWED_GUILD_IDS: '100', ADMIN_USER_IDS: '499' });
  const music = { search: async () => [{ id: '1', name: 'Song', artists: 'Artist', durationMs: 180000 }] };
  const manager = new BotManager(config, music), members = new Map([['400', '201'], ['401', '202']]), replies = [], calls = [];
  const runtimes = ['default', 'other'].map((id, i) => {
    const runtime = manager.runtime({ id, token: id, name: id, guildIds: ['100'] }, id !== 'default');
    runtime.status = 'ready'; runtime.gateway = { ready: true };
    runtime.api = {
      async request(route, params) { calls.push({ id, route, params }); return { items: members.has(params.user_id) ? [{ type: 2, id: members.get(params.user_id) }] : [] }; },
      async reply(channel, text) { replies.push({ id, channel, text }); },
    };
    runtime.player = { context: rooms[i] ? context(rooms[i]) : null, current: null, queue: [], volume: 60, stream: null,
      capacity: () => 500,
      snapshot() { return { current: this.current, queue: this.queue, volume: this.volume, status: this.current ? 'playing' : 'idle', seconds: 0 }; },
      async add(next, tracks) { this.context = next; this.current = tracks[0]; return tracks.length; },
      async control(action) { calls.push({ id, action }); return 'done'; },
    };
    runtime.bot = new Bot(runtime.config, runtime.api, music, runtime.player, (evt, command) => manager.owns(id, evt, command));
    return runtime;
  });
  const dispatch = async (evt) => Promise.all(runtimes.map((runtime) => runtime.bot.handle(evt, parseCommand(evt.content))));
  return { manager, runtimes, members, replies, calls, dispatch };
}

test('help, search, queue and controls are handled only by the bot in the caller room', async () => {
  const f = fixture();
  for (const [index, content] of ['/帮助', '/搜索 Music', '/队列', '/音量 25'].entries()) {
    await f.dispatch(event(`m${index}`, '401', content));
  }
  assert.equal(f.replies.length, 4); assert.ok(f.replies.every((reply) => reply.id === 'other'));
  assert.deepEqual(f.calls.filter((call) => call.action), [{ id: 'other', action: 'volume' }]);
  assert.equal(f.calls.filter((call) => call.route).length, 5); // one owner lookup per event + control permission lookup
});

test('different gateways share the cached owner even after the first command changes assignment', async () => {
  const f = fixture([null, null]);
  const evt = event('same-message', '400');
  assert.equal(await f.manager.owns('default', evt), true);
  f.runtimes[0].player.context = context('202');
  f.runtimes[1].player.context = context('201');
  assert.equal(await f.manager.owns('other', evt), false);
  assert.equal(f.calls.length, 1);
});

test('simultaneous commands from different rooms claim different idle bots before playback starts', async () => {
  const f = fixture([null, null]), first = event('a', '400', '/搜索 Song'), second = event('b', '401', '/搜索 Test');
  const owners = await Promise.all([
    f.manager.owns('default', first), f.manager.owns('other', first),
    f.manager.owns('default', second), f.manager.owns('other', second),
  ]);
  assert.deepEqual(owners, [true, false, false, true]);
  assert.equal(f.runtimes[0].player.context, null); assert.equal(f.runtimes[1].player.context, null);
  await f.dispatch(event('c', '401', '/搜索 Test'));
  await f.dispatch(event('d', '401', '/选歌 1'));
  assert.ok(f.replies.every((reply) => reply.id === 'other'));
  assert.equal(f.runtimes[1].player.context.voiceChannelId, '202');
  assert.equal(f.runtimes[0].player.current, null);
});

test('help in an unassigned room never reserves an idle bot and cannot refresh an existing reservation', async () => {
  const f = fixture([null, null]);
  await f.dispatch(event('help-a', '400', '/帮助')); assert.equal(f.manager.claims.size, 0);
  await f.dispatch(event('help-b', '401', '/帮助')); assert.equal(f.manager.claims.size, 0);
  await f.dispatch(event('search-a', '400', '/搜索 Song')); assert.equal(f.manager.claims.get('default').voiceChannelId, '201');
  f.manager.claims.get('default').time -= 10000; const time = f.manager.claims.get('default').time;
  await f.dispatch(event('help-c', '400', '/帮助')); assert.equal(f.manager.claims.get('default').time, time);
  await f.dispatch(event('search-b', '401', '/搜索 Test')); assert.equal(f.manager.claims.get('other').voiceChannelId, '202');
  assert.deepEqual(f.replies.slice(-2).map((reply) => reply.id), ['default', 'other']);
});

test('an unassigned room never controls a bot already assigned elsewhere', async () => {
  const f = fixture(); f.members.set('402', '203');
  await f.dispatch(event('a', '402', '/暂停'));
  assert.equal(f.replies.length, 0); assert.equal(f.calls.filter((call) => call.action).length, 0);
});

test('non-voice help still replies once and voice mutation preserves the original requirement', async () => {
  const f = fixture([null, null]);
  await f.dispatch(event('a', '405', '/帮助'));
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0].id, 'default');
  const evt = event('b', '405', '/点歌 1');
  const results = await Promise.allSettled(f.runtimes.map((runtime) => runtime.bot.handle(evt, parseCommand(evt.content))));
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1); assert.match(rejected[0].reason.message, /先进入一个语音频道/);
});

test('lookup failure selects a single responder instead of broadcasting command errors', async () => {
  const f = fixture();
  for (const runtime of f.runtimes) runtime.api.request = async () => { throw new Error('Unavailable'); };
  await f.dispatch(event('a', '400', '/帮助'));
  assert.equal(f.replies.length, 1);
});

test('existing guild and text channel restrictions apply before choosing an owner', async () => {
  const f = fixture([null, null]);
  f.runtimes[0].config.textChannels = new Set(['399']);
  await f.dispatch(event('a', '400', '/帮助'));
  assert.deepEqual(f.replies.map((reply) => reply.id), ['other']);
  f.runtimes[1].config.guilds = new Set(['999']);
  await f.dispatch(event('b', '400', '/帮助'));
  assert.equal(f.replies.length, 1);
});

test('single-bot admin bypass and independent voice restrictions retain existing behavior', async () => {
  const f = fixture(); f.manager.runtimes.delete('other');
  await f.runtimes[0].bot.handle(event('a', '499', '/暂停'), { action: 'pause', value: '' });
  assert.deepEqual(f.calls, [{ id: 'default', action: 'pause' }]);
  await assert.rejects(f.runtimes[0].bot.handle(event('b', '401', '/暂停'), { action: 'pause', value: '' }), /机器人所在/);
});

test('routing ignores stopping bots and stops admitting commands on shutdown', async () => {
  const f = fixture([null, null]); f.runtimes[0].status = 'stopping';
  await f.dispatch(event('a'));
  assert.deepEqual(f.replies.map((reply) => reply.id), ['other']);
  f.manager.closed = true;
  await f.dispatch(event('b')); assert.equal(f.replies.length, 1);
});
