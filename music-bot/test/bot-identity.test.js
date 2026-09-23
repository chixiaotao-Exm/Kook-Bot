import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { readConfig } from '../src/config.js';

function fixture(identity = { id: '400', bot: false }) {
  const config = readConfig({ KOOK_TOKEN: 'fixture', ALLOWED_GUILD_IDS: '100' });
  const requests = [], replies = [], mutations = [];
  const api = {
    async request(endpoint, params) {
      requests.push({ endpoint, params });
      if (endpoint === 'user/view') {
        if (identity instanceof Error) throw identity;
        return identity;
      }
      return { items: [{ id: '200', type: 2 }] };
    },
    async reply(channel, text) { replies.push({ channel, text }); },
  };
  const player = { context: { guildId: '100', voiceChannelId: '200', textChannelId: '300' },
    async control(action) { mutations.push(action); return 'done'; } };
  const bot = new Bot(config, api, {}, player); bot.selfId = '999';
  const event = (author, type = 1, content = '/暂停') => ({ type, channel_type: 'GROUP', target_id: '300',
    author_id: '400', msg_id: 'identity-test', content, extra: { guild_id: '100', ...(author === undefined ? {} : { author }) } });
  return { bot, event, requests, replies, mutations };
}

test('missing bot metadata is verified before either command execution or a help reply', async (t) => {
  for (const type of [1, 9]) for (const command of ['/暂停', '/帮助']) await t.test(`${type} ${command}`, async () => {
    const f = fixture({ id: '400', bot: true });
    assert.equal(f.bot.accept(f.event({ id: '400' }, type, command)), true);
    await f.bot.draining;
    assert.deepEqual(f.requests, [{ endpoint: 'user/view', params: { user_id: '400', guild_id: '100' } }]);
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.replies, []);
  });
});

test('legacy human events with missing metadata still work after authoritative identity verification', async () => {
  const f = fixture();
  assert.equal(f.bot.accept(f.event()), true);
  await f.bot.draining;
  assert.deepEqual(f.mutations, ['pause']); assert.equal(f.replies.length, 1);
  assert.deepEqual(f.requests.map(request => request.endpoint), ['user/view', 'channel-user/get-joined-channel']);
});

test('explicit human metadata needs no extra lookup and malformed or mismatched author metadata is ignored', async () => {
  const human = fixture();
  assert.equal(human.bot.accept(human.event({ id: '400', bot: false })), true);
  await human.bot.draining;
  assert.deepEqual(human.mutations, ['pause']);
  assert.deepEqual(human.requests.map(request => request.endpoint), ['channel-user/get-joined-channel']);
  for (const author of [{ id: '401', bot: false }, { id: '401' }, { id: null, bot: false },
    { id: '400', bot: true }, { id: '400', bot: null }, { id: '400', bot: 0 }, { id: '400', bot: 'false' }]) {
    const f = fixture();
    assert.equal(f.bot.accept(f.event(author)), true);
    await f.bot.draining;
    assert.deepEqual(f.requests, []); assert.deepEqual(f.mutations, []); assert.deepEqual(f.replies, []);
  }
});

test('failed or mismatched identity lookups never answer unknown authors', async () => {
  for (const identity of [new Error('private upstream details'), null, {}, { id: '400' },
    { id: '401', bot: false }, { id: '400', bot: 0 }]) {
    const f = fixture(identity);
    assert.equal(f.bot.accept(f.event()), true);
    await f.bot.draining;
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.replies, []);
  }
});

test('shutdown during identity verification prevents late execution without changing synchronous gateway admission', async () => {
  const f = fixture(); let release;
  f.bot.api.request = () => new Promise(resolve => { release = resolve; });
  const accepted = f.bot.accept(f.event());
  assert.equal(accepted, true); assert.equal(typeof accepted, 'boolean');
  const stopped = f.bot.stop();
  release({ id: '400', bot: false }); await stopped;
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.replies, []);
});
