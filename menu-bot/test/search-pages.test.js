import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuSearch } from '../src/menu-search.js';
import { createSearchPages } from '../src/search-pages.js';

const items = Array.from({ length: 20 }, (_, index) => ({
  key: `m1:${index + 1}`, group: '菜单一', name: `鱼${index + 1}`, spanish: `PESCADO ${index + 1}`,
  aliases: [], priceCents: index === 0 ? null : 100 + index, uncertain: index === 1,
}));
const search = createMenuSearch(items);
const channel = { channelId: 'channel-1', guildId: 'guild-1' };
const context = { channelId: 'channel-1', messageId: 'message-1' };

function createBound(options = {}, request = '搜索鱼') {
  const pager = createSearchPages({ search, ...options });
  const first = pager.create(request, channel);
  assert.equal(pager.bind(first.sessionId, context.messageId), true);
  return { pager, first };
}

test('search cards replace typed navigation with buttons and preserve names, prices and caveats', () => {
  const { pager, first } = createBound();
  assert.equal(first.title, '中文菜单 · 菜品搜索');
  assert.match(first.text, /第 1\/3 页/);
  assert.match(first.text, /未标价，需向餐厅确认/);
  assert.match(first.text, /原文不确定，待核对/);
  assert.match(first.text, /以上为菜单美元单价，仅供选菜/);
  assert.doesNotMatch(first.text, /查看下一页/);
  assert.deepEqual(first.buttons.map(button => button.label), ['下一页']);
  assert.ok(first.buttons[0].value.length < 256);
  assert.doesNotMatch(first.buttons[0].value, /鱼|PESCADO|channel|guild/);
  const second = pager.resolve(first.buttons[0].value, context);
  assert.match(second.text, /第 2\/3 页/);
  assert.match(second.text, /鱼9 \[m1:9\]/);
  assert.deepEqual(second.buttons.map(button => button.label), ['上一页', '下一页']);
  const last = pager.resolve(second.buttons[1].value, context);
  assert.match(last.text, /第 3\/3 页/);
  assert.deepEqual(last.buttons.map(button => button.label), ['上一页']);
  assert.deepEqual(pager.resolve(second.buttons[0].value, context), first);
  // Replaying an old button has a fixed destination, not a next-page side effect.
  assert.deepEqual(pager.resolve(first.buttons[0].value, context), second);
  for (const reply of [first, second, last]) assert.ok(reply.text.length < 2000);
});

test('session belongs to one bound card and channel but can be shared by humans in that channel', () => {
  const pager = createSearchPages({ search });
  const first = pager.create('搜索鱼', channel);
  const value = first.buttons[0].value;
  assert.deepEqual(pager.resolve(value, context), { error: 'invalid' });
  assert.equal(pager.context(value, context), null);
  assert.equal(pager.bind(first.sessionId, ''), false);
  assert.equal(pager.bind(first.sessionId, context.messageId), true);
  assert.equal(pager.bind(first.sessionId, context.messageId), true);
  assert.equal(pager.bind(first.sessionId, 'other-message'), false);
  assert.deepEqual(pager.context(value, context), { guildId: channel.guildId });
  for (const incorrect of [{ ...context, channelId: 'other' }, { ...context, messageId: 'other' }, {}]) {
    assert.deepEqual(pager.resolve(value, incorrect), { error: 'invalid' });
    assert.equal(pager.context(value, incorrect), null);
  }
  assert.match(pager.resolve(value, { ...context, userId: 'another-human' }).text, /第 2\/3 页/);
});

test('expired, evicted and pre-restart cards fail without issuing a new menu search', () => {
  let time = 0, calls = 0;
  const wrappedSearch = input => { calls++; return search(input); };
  const { pager, first } = createBound({ now: () => time, ttlMs: 1000, maxSessions: 2, search: wrappedSearch });
  time = 999;
  assert.match(pager.resolve(first.buttons[0].value, context).text, /第 2\/3 页/);
  time = 1000;
  const before = calls;
  assert.deepEqual(pager.resolve(first.buttons[0].value, context), { error: 'expired' });
  assert.equal(calls, before);
  assert.equal(pager.context(first.buttons[0].value, context), null);
  assert.equal(pager.bind(first.sessionId, context.messageId), false);
  const old = pager.create('搜索鱼', channel);
  pager.bind(old.sessionId, context.messageId);
  pager.create('搜索鱼', channel);
  pager.create('搜索鱼', channel);
  assert.equal(pager.status().sessions, 2);
  assert.deepEqual(pager.resolve(old.buttons[0].value, context), { error: 'expired' });
  assert.deepEqual(createSearchPages({ search }).resolve(old.buttons[0].value, context), { error: 'expired' });
});

test('forged and out-of-range callback values never run the search function', () => {
  let calls = 0;
  const { pager, first } = createBound({ search: input => { calls++; return search(input); } });
  const before = calls;
  for (const value of [`menu-page:${first.sessionId}:0`, `menu-page:${first.sessionId}:4`,
    `menu-page:${first.sessionId}:2.5`, `menu-page:${first.sessionId}:99999`,
    'menu-page:__proto__:1', 'menu-page:', `${first.buttons[0].value}\n`, `${first.buttons[0].value}:extra`]) {
    assert.deepEqual(pager.resolve(value, context), { error: 'invalid' }, value);
  }
  for (const value of [null, undefined, {}, 2, 'other:page:1']) assert.equal(pager.resolve(value, context), null);
  assert.equal(calls, before);
});

test('single-page searches, missing results and ordinary input do not retain state', () => {
  const pager = createSearchPages({ search });
  for (const input of ['搜索鱼20', '搜索不存在', '搜索', '搜索鱼 第99页']) {
    const reply = pager.create(input, channel);
    assert.deepEqual(reply.buttons, []);
    assert.equal(reply.sessionId, undefined);
  }
  assert.equal(pager.create('菜单', channel), null);
  assert.equal(pager.create('鱼2份', channel), null);
  assert.equal(pager.status().sessions, 0);
});

test('typed pages can start new button sessions and different searches remain isolated', () => {
  const { pager, first } = createBound({}, '搜索鱼 第2页');
  assert.deepEqual(first.buttons.map(button => button.label), ['上一页', '下一页']);
  const other = pager.create('搜索PESCADO', { channelId: 'channel-2', guildId: 'guild-2' });
  pager.bind(other.sessionId, 'message-2');
  assert.notEqual(first.sessionId, other.sessionId);
  assert.match(pager.resolve(first.buttons[0].value, context).text, /菜单搜索：鱼/);
  assert.match(pager.resolve(other.buttons[0].value, { channelId: 'channel-2', messageId: 'message-2' }).text, /菜单搜索：PESCADO/);
});

test('catalog changes invalidate old snapshots instead of silently dropping entries', () => {
  let changed = false;
  const { pager, first } = createBound({ search: input => changed ? { ...search(input), pageCount: 4 } : search(input) });
  changed = true;
  assert.deepEqual(pager.resolve(first.buttons[0].value, context), { error: 'expired' });
  assert.equal(pager.status().sessions, 0);
});

test('known human search events may omit guild and leave channel lookup to the caller', () => {
  const pager = createSearchPages({ search });
  const first = pager.create('搜索鱼', { channelId: channel.channelId });
  assert.equal(pager.bind(first.sessionId, context.messageId), true);
  assert.deepEqual(pager.context(first.buttons[0].value, context), { guildId: null });
  assert.match(pager.resolve(first.buttons[0].value, context).text, /第 2\/3 页/);
});

test('state factory enforces bounded capacity and lifetime', () => {
  assert.throws(() => createSearchPages(), /search/);
  for (const maxSessions of [0, 501, NaN, Infinity, 1.5]) assert.throws(() => createSearchPages({ search, maxSessions }), /capacity/);
  for (const ttlMs of [0, -1, 86_400_001, NaN, Infinity, 1.5]) assert.throws(() => createSearchPages({ search, ttlMs }), /TTL/);
  assert.throws(() => createSearchPages({ search }).create('搜索鱼'), /channelId/);
  assert.throws(() => createSearchPages({ search }).create('搜索鱼', { channelId: channel.channelId, guildId: '' }), /guildId/);
});
