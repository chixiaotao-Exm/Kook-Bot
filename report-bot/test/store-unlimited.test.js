import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_ID, draftContent, RESULT_MESSAGES } from '../src/domain.js';
import { openStore, validateStore } from '../src/store.js';

const author = '1000000000000001';
const at = 1_800_000_000_000;
const draftId = index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const emptyState = () => ({ version: 1, seen: {}, drafts: {}, reports: {}, attempts: [], previews: [],
  rate: { globalAt: null, users: {} } });
function draft(index, expires = null) {
  const player = `Player_${index}`;
  return { player, raw: player, author, channelId: CHANNEL_ID, guildId: null, expires,
    ...draftContent(player), editing: false };
}
function legacyDraft(index) {
  const player = `Player_${index}`;
  return { ...draft(index),
    subject: `请求核查玩家 ${player} 的游戏行为`,
    description: `PUBG 客服团队您好：\n\n我希望请求核查以下玩家是否存在违规行为。\n被举报玩家昵称：${player}\n游戏平台：Steam PC\n\n请根据可用的对局记录及反作弊检测信息核实，并依据核查结果处理。本次举报不预先断定对方存在作弊行为。\n\n本次仅提供玩家昵称，未提供具体对局时间或作弊证据。如需补充资料，请通过我的联系邮箱告知。\n\n谢谢。`
  };
}
async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'report-unlimited-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state.json');
}

test('state collections accept more than the former per-collection limits', () => {
  const value = emptyState();
  for (let index = 0; index < 2200; index++) {
    const userId = String(1_000_000_000_000_000 + index);
    value.seen[index.toString(16).padStart(32, '0')] = at;
    value.drafts[draftId(index)] = draft(index);
    value.reports[`player_${index}`] = { at, kind: 'unknown', author, player: `Player_${index}` };
    value.attempts.push({ at, author: userId });
    value.previews.push(at);
    value.rate.users[userId] = at;
  }
  const data = validateStore(value);
  for (const name of ['seen', 'drafts', 'reports']) assert.equal(Object.keys(data[name]).length, 2200);
  assert.equal(data.attempts.length, 2200);
  assert.equal(data.previews.length, 2200);
  assert.equal(Object.keys(data.rate.users).length, 2200);
});

test('valid state exceeding four MiB saves durably and reopens', async t => {
  const path = await temporaryStore(t);
  const store = await openStore(path);
  for (let index = 0; index < 8000; index++) store.data.drafts[draftId(index)] = draft(index);
  assert.ok(Buffer.byteLength(JSON.stringify(store.data)) > 4 * 1024 * 1024);
  await store.save();
  const disk = await readFile(path);
  assert.ok(disk.length > 4 * 1024 * 1024);
  const reopened = await openStore(path);
  assert.equal(Object.keys(reopened.data.drafts).length, 8000);
  assert.deepEqual(reopened.data.drafts[draftId(7999)], store.data.drafts[draftId(7999)]);
});

test('legacy expired and future draft timestamps migrate to no expiry', async t => {
  const path = await temporaryStore(t);
  const value = emptyState();
  for (const [index, expires] of [0, 1, at, Number.MAX_SAFE_INTEGER, null].entries()) {
    value.drafts[draftId(index)] = draft(index, expires);
  }
  await writeFile(path, JSON.stringify(value));
  const store = await openStore(path);
  for (const item of Object.values(store.data.drafts)) assert.equal(item.expires, null);
  await store.save();
  const reopened = await openStore(path);
  assert.equal(Object.keys(reopened.data.drafts).length, 5);
  for (const item of Object.values(reopened.data.drafts)) assert.equal(item.expires, null);
});

test('English content migration invalidates old previews and preserves submission history', async t => {
  const path = await temporaryStore(t);
  const value = emptyState();
  const cardId = 'a'.repeat(32), reporterSnapshot = 'b'.repeat(64);
  value.drafts[draftId(1)] = { ...legacyDraft(1), cardId, reporterSnapshot, reporterCount: 2 };
  value.drafts[draftId(2)] = { ...draft(2), cardId: 'c'.repeat(32), reporterSnapshot, reporterCount: 2 };
  value.seen[cardId] = at;
  value.reports.player_1 = { at, author, player: 'Player_1', kind: 'success' };
  value.reports.player_3 = { at, author, player: 'Player_3', kind: 'pending' };
  value.attempts.push({ at, author });
  value.previews.push(at);
  value.rate = { globalAt: at, users: { [author]: at } };
  await writeFile(path, JSON.stringify(value));

  const store = await openStore(path);
  assert.deepEqual(Object.keys(store.data.drafts), [draftId(2)]);
  assert.deepEqual(store.data.drafts[draftId(2)], value.drafts[draftId(2)]);
  assert.equal(store.data.seen[cardId], at);
  assert.equal(store.data.reports.player_1.kind, 'success');
  assert.equal(store.data.reports.player_1.message, RESULT_MESSAGES.success);
  assert.equal(store.data.reports.player_3.kind, 'unknown');
  assert.deepEqual(store.data.attempts, value.attempts);
  assert.deepEqual(store.data.previews, value.previews);
  assert.equal(store.data.rate.globalAt, at);
  assert.equal(store.data.rate.users[author], at);

  await store.save();
  const reopened = await openStore(path);
  assert.deepEqual(reopened.data, store.data);
});

test('legacy preview migration still rejects altered content and invalid metadata', () => {
  const mutations = [
    item => { item.subject += ' altered'; },
    item => { item.description += '\nAltered content'; },
    item => { item.subject = draftContent(item.player).subject; },
    item => { item.description = draftContent(item.player).description; },
    item => { item.author = 'invalid'; },
    item => { item.cardId = 'invalid'; },
    item => { item.expires = -1; },
    item => { item.raw += '\n'; },
    item => { item.editing = 'true'; },
    item => { item.reporterSnapshot = 'invalid'; },
    item => { item.reporterSnapshot = 'a'.repeat(64); },
    item => { item.reporterSnapshot = 'a'.repeat(64); item.reporterCount = 0; }
  ];
  for (const mutate of mutations) {
    const value = emptyState(), item = legacyDraft(1);
    mutate(item); value.drafts[draftId(1)] = item;
    assert.throws(() => validateStore(value), /Invalid state file structure/);
  }
});

test('removing capacity limits preserves per-entry and collection schema checks', () => {
  const invalidStates = [
    value => { value.seen = []; },
    value => { value.seen.invalid = at; },
    value => { value.drafts = []; },
    value => { value.drafts[draftId(1)] = { ...draft(1), expires: 'never' }; },
    value => { value.drafts[draftId(1)] = { ...draft(1), expires: -1 }; },
    value => { value.drafts[draftId(1)] = { ...draft(1), expires: undefined }; },
    value => { value.drafts[draftId(1)] = { ...draft(1), author: 'wrong' }; },
    value => { value.drafts[draftId(1)] = { ...draft(1), description: 'replacement body' }; },
    value => { value.reports = []; },
    value => { value.reports.player_1 = { at, kind: 'unsupported' }; },
    value => { value.attempts = {}; },
    value => { value.attempts.push({ at: -1, author }); },
    value => { value.attempts.push({ at, author: 'invalid' }); },
    value => { value.previews = {}; },
    value => { value.previews.push('invalid'); },
    value => { value.rate.users = []; },
    value => { value.rate.users[author] = 'invalid'; }
  ];
  for (const mutate of invalidStates) {
    const value = emptyState(); mutate(value);
    assert.throws(() => validateStore(value), /Invalid state file structure/);
  }
});

test('corrupt persisted state still prevents startup', async t => {
  const path = await temporaryStore(t);
  await writeFile(path, '{broken');
  await assert.rejects(openStore(path), /State file is corrupt or unreadable/);
  const value = emptyState(); value.drafts[draftId(1)] = { ...draft(1), player: 'bad nickname' };
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(openStore(path), /Invalid state file structure/);
});

test('invalid writes leave previous snapshot intact and permanently fail closed', async t => {
  const path = await temporaryStore(t);
  const store = await openStore(path);
  store.data.drafts[draftId(1)] = draft(1);
  await store.save();
  const original = await readFile(path, 'utf8');
  store.data.drafts[draftId(1)].expires = 'invalid';
  await assert.rejects(store.save(), /Failed to save state/);
  store.data.drafts[draftId(1)].expires = null;
  await assert.rejects(store.save(), /Failed to save state/);
  assert.equal(await readFile(path, 'utf8'), original);
});
