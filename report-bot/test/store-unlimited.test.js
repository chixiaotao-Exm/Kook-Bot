import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_ID, draftContent } from '../src/domain.js';
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
    assert.throws(() => validateStore(value), /状态文件结构无效/);
  }
});

test('corrupt persisted state still prevents startup', async t => {
  const path = await temporaryStore(t);
  await writeFile(path, '{broken');
  await assert.rejects(openStore(path), /状态文件损坏或不可读/);
  const value = emptyState(); value.drafts[draftId(1)] = { ...draft(1), player: 'bad nickname' };
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(openStore(path), /状态文件结构无效/);
});

test('invalid writes leave previous snapshot intact and permanently fail closed', async t => {
  const path = await temporaryStore(t);
  const store = await openStore(path);
  store.data.drafts[draftId(1)] = draft(1);
  await store.save();
  const original = await readFile(path, 'utf8');
  store.data.drafts[draftId(1)].expires = 'invalid';
  await assert.rejects(store.save(), /状态保存失败/);
  store.data.drafts[draftId(1)].expires = null;
  await assert.rejects(store.save(), /状态保存失败/);
  assert.equal(await readFile(path, 'utf8'), original);
});
