import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuetCommands, parseDuetCommand } from '../src/duet-commands.js';
import { atomicJson } from '../src/storage.js';

const SELF = '100000001', OTHER_BOT = '100000002', USER = '200000001', CHANNEL = '300000001';
const NOW = Date.parse('2026-09-23T10:00:00Z');
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const event = (number, content = '/互聊 旅行', overrides = {}) => ({ type: 9, channel_type: 'GROUP', target_id: CHANNEL,
  author_id: USER, msg_id: id(number), msg_timestamp: NOW, content,
  extra: { author: { id: USER, bot: false }, guild_id: '400000001' }, ...overrides });
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-commands-'));
  let now = NOW, active = false, paused = false, rounds = 0;
  const starts = [], contributions = [], newTopics = [], pauses = [], resumes = [], stops = [], replies = [], logs = [];
  const session = { async start(input) {
    starts.push(input); if (active) return { accepted: false, reason: 'BUSY' };
    active = true; paused = false; rounds = input.rounds;
    return { accepted: true, rounds, unlimited: rounds === 0, totalTurns: rounds === 0 ? null : rounds * 2 };
  }, async contribute(input) {
    if (!active) return { accepted: false, reason: 'NO_ACTIVE' };
    contributions.push(input); return { accepted: true, contributions: contributions.length, pendingInputs: contributions.length };
  }, async newTopic(input) {
    newTopics.push(input); active = Boolean(input.topic); paused = false;
    return { accepted: true };
  }, async pause() {
    pauses.push(true);
    if (!active) return { paused: false, reason: 'NO_ACTIVE' };
    if (paused) return { paused: false, reason: 'ALREADY_PAUSED' };
    paused = true; return { paused: true };
  }, async resume() {
    resumes.push(true);
    if (!active) return { resumed: false, reason: 'NO_ACTIVE' };
    if (!paused) return { resumed: false, reason: 'NOT_PAUSED' };
    paused = false; return { resumed: true };
  }, async stop() { stops.push(true); active = false; paused = false; }, snapshot() {
    return { active, paused, status: active ? paused ? 'paused' : 'running' : 'idle', rounds, unlimited: rounds === 0,
      completedTurns: 0, totalTurns: rounds === 0 ? null : rounds * 2, currentRound: active ? 1 : null, currentSpeaker: active ? '机器人 A' : null };
  } };
  const config = { session, reply: async payload => { replies.push(payload); return { messageId: id(999) }; },
    getSelfId: () => SELF, getParticipantIds: () => [SELF, OTHER_BOT], channelId: CHANNEL, dataDir,
    now: () => now, logger: row => logs.push(row), ...options };
  const bot = await new DuetCommands(config).init();
  t.after(async () => { await bot.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { bot, config, dataDir, starts, contributions, newTopics, pauses, resumes, stops, replies, logs, advance(ms) { now += ms; },
    send(number, content, overrides = {}) { return bot.handle(event(number, content, { msg_timestamp: now, ...overrides })); } };
}

test('ordinary questions start continuous discussion while legacy commands remain compatible', () => {
  assert.deepEqual(parseDuetCommand('人工智能会怎样改变生活？'), { kind: 'start', topic: '人工智能会怎样改变生活？', rounds: 0 });
  assert.deepEqual(parseDuetCommand('2026 年有什么科技趋势？'), { kind: 'start', topic: '2026 年有什么科技趋势？', rounds: 0 });
  assert.deepEqual(parseDuetCommand(`(met)${SELF}(met) 两个人如何高效合作？`, SELF), { kind: 'start', topic: '两个人如何高效合作？', rounds: 0 });
  assert.deepEqual(parseDuetCommand('/互聊 太空探索'), { kind: 'start', topic: '太空探索', rounds: 0 });
  assert.deepEqual(parseDuetCommand('/互聊 不限 太空探索'), { kind: 'start', topic: '太空探索', rounds: 0 });
  assert.deepEqual(parseDuetCommand('/互聊 0 太空探索'), { kind: 'start', topic: '太空探索', rounds: 0 });
  assert.deepEqual(parseDuetCommand(`(met)${SELF}(met) /互聊 2 太空探索`, SELF), { kind: 'start', topic: '太空探索', rounds: 2 });
  for (const value of ['帮助', '/互聊', '/互聊 2', '/互聊 不限', '/互聊 0', '/互聊帮助', '/帮助']) assert.equal(parseDuetCommand(value).kind, 'help');
  for (const value of ['停止', '停止互聊', '/停止', '/停止互聊']) assert.equal(parseDuetCommand(value).kind, 'stop');
  assert.equal(parseDuetCommand('互聊状态').kind, 'status');
  assert.equal(parseDuetCommand('/互聊状态').kind, 'status');
  for (const value of ['/互聊 7 x', '/互聊 -1 x', '/互聊 1.5 x']) assert.equal(parseDuetCommand(value).kind, 'invalid');
  assert.equal(parseDuetCommand(`/互聊 ${'话'.repeat(2001)}`).kind, 'too_long');
  assert.equal(parseDuetCommand('/互聊 sk-fixtureprivate123456789').kind, 'credential');
  for (const value of ['停止工作后如何休息？', '为什么汽车会突然停止？', '停止讨论会有什么影响？']) {
    assert.deepEqual(parseDuetCommand(value), { kind: 'start', topic: value, rounds: 0 });
  }
  for (const value of ['/互聊状态 other', '/停止 please', '/admin', '   ']) assert.equal(parseDuetCommand(value, SELF), null);
});

test('only exact natural pause and resume aliases with optional terminal punctuation are controls', () => {
  for (const text of ['暂停', '先暂停', '暂停一下', '先暂停一下']) {
    for (const punctuation of ['', '。', '!', '！']) assert.deepEqual(parseDuetCommand(`${text}${punctuation}`), { kind: 'pause' });
  }
  for (const text of ['继续', '恢复', '继续讨论', '开始']) {
    for (const punctuation of ['', '。', '!', '！']) assert.deepEqual(parseDuetCommand(`${text}${punctuation}`), { kind: 'resume' });
  }
  assert.deepEqual(parseDuetCommand(`(met)${SELF}(met) 先暂停一下！`, SELF), { kind: 'pause' });
  for (const text of ['先暂停有什么含义？', '继续学习有什么好处？', '开始讨论人工智能', '暂停？', '恢复工作需要什么条件？']) {
    assert.deepEqual(parseDuetCommand(text), { kind: 'start', topic: text, rounds: 0 });
  }
});

test('only explicit new-topic syntax requests a context reset', () => {
  assert.deepEqual(parseDuetCommand('新话题'), { kind: 'new_topic' });
  assert.deepEqual(parseDuetCommand('新话题：'), { kind: 'new_topic' });
  for (const value of ['新话题：春天去哪里旅行？', '新话题: 春天去哪里旅行？', '新话题 春天去哪里旅行？']) {
    assert.deepEqual(parseDuetCommand(value), { kind: 'new_topic', topic: '春天去哪里旅行？' });
  }
  assert.deepEqual(parseDuetCommand(`(met)${SELF}(met) 新话题：春游`, SELF), { kind: 'new_topic', topic: '春游' });
  for (const value of ['新话题是什么意思？', '我有一个新话题', '普通问题', '停止']) assert.notEqual(parseDuetCommand(value).kind, 'new_topic');
  assert.equal(parseDuetCommand('新话题：sk-privatefixture123456789').kind, 'credential');
  assert.equal(parseDuetCommand(`新话题 ${'长'.repeat(2001)}`).kind, 'too_long');
});

test('new-topic reset bypasses cooldown, remains durable and never runs for ordinary questions', async t => {
  const entered = defer(), persisted = defer(); let hold = false;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (hold) { entered.resolve(); await persisted.promise; }
    await atomicJson(file, value);
  } });
  await f.send(1, '保留这个问题'); hold = true;
  const reset = f.send(2, '新话题'); await entered.promise;
  assert.equal(f.newTopics.length, 0); persisted.resolve(); await reset; await flush(); hold = false;
  assert.deepEqual(f.newTopics[0], { userId: USER, receiptId: id(2), replyMessageId: id(2) });
  assert.match(f.replies.at(-1).content, /已清空话题，直接发问题开始/);
  await f.send(3, '新话题：春天去哪里旅行？'); await flush();
  assert.equal(f.newTopics[1].topic, '春天去哪里旅行？'); assert.match(f.replies.at(-1).content, /已新建话题/);
  assert.equal(f.bot.snapshot().newTopics, 2);
  await f.send(3, '新话题：春天去哪里旅行？'); assert.equal(f.newTopics.length, 2);
  await f.send(4, '我还有一个补充'); assert.equal(f.contributions.length, 1); assert.equal(f.newTopics.length, 2);
  await f.send(5, '停止'); assert.equal(f.newTopics.length, 2);
  const saved = await readFile(path.join(f.dataDir, 'duet-seen.json'), 'utf8');
  assert.doesNotMatch(saved, /春天|保留这个问题/);
});

test('new-topic authorization or storage failures never claim the topic was cleared', async t => {
  const f = await fixture(t, { session: { async start() {}, async stop() {}, snapshot() { return { active: true }; },
    async newTopic() { return { accepted: false, reason: 'NOT_AUTHORIZED' }; } } });
  await f.send(1, '新话题'); await flush();
  assert.match(f.replies.at(-1).content, /只有已授权/); assert.doesNotMatch(f.replies.at(-1).content, /已清空|已新建/);
  assert.equal(f.bot.snapshot().newTopics, 0);
  const failed = await fixture(t, { writeState: async () => { throw new Error('private'); } });
  await failed.send(1, '新话题：新的问题'); assert.equal(failed.newTopics.length, 0); assert.equal(failed.replies.length, 0);
});

test('stop and status explain that existing topic remains until an explicit reset', async t => {
  const f = await fixture(t, { session: { async start() {}, async stop() { return { stopped: true }; },
    snapshot() { return { active: false, threadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'stopped', rounds: 0 }; } } });
  await f.send(1, '停止'); await flush();
  assert.match(f.replies.at(-1).content, /已停止，保留当前话题/); assert.match(f.replies.at(-1).content, /新话题.*才清空/);
  f.advance(3000); await f.send(2, '互聊状态'); await flush();
  assert.match(f.replies.at(-1).content, /当前话题已保留/);
  f.advance(3000); await f.send(3, '帮助'); await flush();
  assert.match(f.replies.at(-1).content, /只有“新话题”会清空上下文/);
});

test('pause and resume bypass command cooldown and confirm only completed state changes', async t => {
  const f = await fixture(t); await f.send(1, '开始一个新话题'); await flush();
  await f.send(2, '先暂停一下！'); await flush();
  assert.equal(f.pauses.length, 1); assert.equal(f.config.session.snapshot().paused, true);
  assert.equal(f.bot.snapshot().pauses, 1); assert.match(f.replies.at(-1).content, /^已暂停讨论/);
  await f.send(3, '暂停'); await flush();
  assert.equal(f.bot.snapshot().pauses, 1); assert.match(f.replies.at(-1).content, /讨论已经暂停/);
  await f.send(4, '继续'); await flush();
  assert.equal(f.resumes.length, 1); assert.equal(f.config.session.snapshot().paused, false);
  assert.equal(f.bot.snapshot().resumes, 1); assert.match(f.replies.at(-1).content, /^已恢复讨论/);
  await f.send(5, '恢复'); await flush();
  assert.equal(f.bot.snapshot().resumes, 1); assert.match(f.replies.at(-1).content, /当前讨论没有暂停/);
  await f.send(4, '继续'); assert.equal(f.resumes.length, 2);
});

test('pause and resume always persist their receipts before calling session controls', async t => {
  let gate;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (gate) { gate.entered.resolve(); await gate.persisted.promise; }
    await atomicJson(file, value);
  } });
  await f.send(1, '讨论一个问题');
  gate = { entered: defer(), persisted: defer() };
  const pause = f.send(2, '先暂停'); await gate.entered.promise;
  assert.equal(f.pauses.length, 0); gate.persisted.resolve(); await pause;
  gate = { entered: defer(), persisted: defer() };
  const resume = f.send(3, '继续'); await gate.entered.promise;
  assert.equal(f.resumes.length, 0); gate.persisted.resolve(); await resume;
  assert.equal(f.pauses.length, 1); assert.equal(f.resumes.length, 1);
});

test('resume words without a paused conversation give guidance and never start a model session', async t => {
  const f = await fixture(t);
  for (const [n, text] of ['开始', '继续', '恢复', '继续讨论'].entries()) {
    await f.send(n + 1, text); await flush();
    assert.match(f.replies.at(-1).content, /当前没有可恢复的讨论/);
  }
  assert.equal(f.starts.length, 0); assert.equal(f.contributions.length, 0); assert.equal(f.bot.snapshot().resumes, 0);
  await f.send(10, '暂停'); await flush();
  assert.match(f.replies.at(-1).content, /当前没有可暂停的讨论/); assert.equal(f.bot.snapshot().pauses, 0);
});

test('paused human input records a contribution without resuming and status describes the pause', async t => {
  const f = await fixture(t); await f.send(1, '讨论一个问题'); await f.send(2, '先暂停');
  f.advance(3000); await f.send(3, '暂停期间我补充一个观点'); await flush();
  assert.equal(f.contributions.length, 1); assert.equal(f.resumes.length, 0);
  assert.equal(f.config.session.snapshot().paused, true);
  assert.match(f.replies.at(-1).content, /已记录补充，发送“继续”恢复讨论/);
  f.advance(3000); await f.send(4, '互聊状态'); await flush();
  assert.match(f.replies.at(-1).content, /互聊状态：已暂停/); assert.match(f.replies.at(-1).content, /发送“继续”恢复讨论/);
  f.advance(3000); await f.send(5, '帮助'); await flush();
  assert.match(f.replies.at(-1).content, /先暂停/); assert.match(f.replies.at(-1).content, /“继续”：恢复/);
  await f.send(6, '停止'); assert.equal(f.stops.length, 1); assert.equal(f.config.session.snapshot().active, false);
});

test('pause and resume failures do not pretend the requested operation succeeded', async t => {
  const f = await fixture(t, { session: {
    async start() { assert.fail('must not start'); }, async stop() {}, snapshot() { return { active: true }; },
    async pause() { return { paused: false, reason: 'NOT_READY' }; },
    async resume() { return { resumed: false, reason: 'NOT_READY' }; },
  } });
  await f.send(1, '暂停'); await flush();
  assert.match(f.replies.at(-1).content, /暂时无法暂停/); assert.doesNotMatch(f.replies.at(-1).content, /已暂停/);
  await f.send(2, '继续'); await flush();
  assert.match(f.replies.at(-1).content, /暂时无法恢复/); assert.doesNotMatch(f.replies.at(-1).content, /已恢复/);
  assert.equal(f.bot.snapshot().pauses, 0); assert.equal(f.bot.snapshot().resumes, 0);
});

test('persists a private receipt before starting continuous sessions and quotes command', async t => {
  let config;
  const f = await fixture(t, { writeState: async (file, value) => {
    assert.equal(config.starts.length, 0); await atomicJson(file, value);
  } }); config = f;
  await f.send(1, '一个私密测试话题'); await flush();
  assert.deepEqual(f.starts, [{ topic: '一个私密测试话题', rounds: 0, userId: USER, receiptId: id(1), replyMessageId: id(1) }]);
  assert.equal(f.replies[0].targetId, CHANNEL); assert.equal(f.replies[0].replyMessageId, id(1));
  assert.match(f.replies[0].content, /已开始持续讨论/);
  assert.match(f.replies[0].content, /发送“停止”/); assert.doesNotMatch(f.replies[0].content, /\/互聊|\/停止/);
  assert.doesNotMatch(f.replies[0].content, /0 轮|0 次|6 轮|12 次/);
  const raw = await readFile(path.join(f.dataDir, 'duet-seen.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, seen: [{ id: id(1), at: NOW }] });
  assert.doesNotMatch(raw, /私密测试话题|200000001/);
  assert.doesNotMatch(JSON.stringify(f.logs), /私密测试话题|200000001/);
  await f.send(1, '一个私密测试话题'); assert.equal(f.starts.length, 1);
});

test('restart receipt deduplication prevents replay from restarting a paid session', async t => {
  const f = await fixture(t); await f.send(1); await f.bot.close();
  const restarted = await new DuetCommands(f.config).init();
  t.after(() => restarted.close());
  await restarted.handle(event(1)); assert.equal(f.starts.length, 1);
});

test('configured default rounds drive parsing, session admission and help while explicit rounds override it', async t => {
  assert.deepEqual(parseDuetCommand('/互聊 太空探索', SELF, 2), { kind: 'start', topic: '太空探索', rounds: 2 });
  assert.deepEqual(parseDuetCommand('/互聊 4 太空探索', SELF, 2), { kind: 'start', topic: '太空探索', rounds: 4 });
  const f = await fixture(t, { defaultRounds: 2 });
  await f.send(1, '/互聊 太空探索'); await flush();
  assert.equal(f.starts[0].rounds, 2); assert.match(f.replies[0].content, /2 轮，共 4 次发言/);
  f.advance(3000); await f.send(2, '/互聊帮助'); await flush();
  assert.match(f.replies.at(-1).content, /默认 2 轮，共 4 次发言/);
  for (const defaultRounds of [-1, 7, 1.5, '2']) {
    assert.throws(() => new DuetCommands({ ...f.config, defaultRounds }), /Invalid duet command configuration/);
  }
});

test('continuous help and status report ongoing rounds and speaker without a fixed total, then allow manual stop', async t => {
  let active = true, stopped = 0;
  const f = await fixture(t, { session: {
    async start() { return { accepted: true, rounds: 0, unlimited: true, totalTurns: null }; },
    async stop() { active = false; stopped++; }, snapshot() {
      return { active, status: active ? 'running' : 'stopped', rounds: 0, unlimited: true,
        completedTurns: 27, totalTurns: null, currentRound: 14, currentSpeaker: '机器人 B' };
    },
  } });
  await f.send(1, '帮助'); await flush();
  assert.match(f.replies.at(-1).content, /直接发送问题/);
  assert.match(f.replies.at(-1).content, /发送“停止”即可结束/);
  assert.doesNotMatch(f.replies.at(-1).content, /\/互聊|\/停止/);
  assert.doesNotMatch(f.replies.at(-1).content, /默认 6|0 轮/);
  f.advance(3000); await f.send(2, '互聊状态'); await flush();
  assert.match(f.replies.at(-1).content, /第 14 轮 · 已发 27 条/);
  assert.match(f.replies.at(-1).content, /当前发言方：机器人 B/);
  assert.doesNotMatch(f.replies.at(-1).content, /\/ 0|\/ 12|null/);
  await f.send(3, '停止'); assert.equal(stopped, 1);
  f.advance(3000); await f.send(4, '互聊状态'); await flush();
  assert.match(f.replies.at(-1).content, /已停止\n已发 27 条/);
});

test('start notice reports the rounds accepted by the session', async t => {
  const f = await fixture(t, { defaultRounds: 2, session: {
    async start() { return { accepted: true, rounds: 1, totalTurns: 2 }; },
    async stop() {}, snapshot() { return { active: false }; },
  } });
  await f.send(1, '/互聊 太空探索'); await flush();
  assert.match(f.replies[0].content, /1 轮，共 2 次发言/);
});

test('does not start or stop a session until the corresponding receipt reaches disk', async t => {
  const ready = defer(), persisted = defer();
  const f = await fixture(t, { writeState: async (file, value) => {
    ready.resolve(); await persisted.promise; await atomicJson(file, value);
  } });
  const handling = f.send(1, '/停止互聊'); await ready.promise;
  assert.equal(f.stops.length, 0); persisted.resolve(); await handling; assert.equal(f.stops.length, 1);
});

test('storage failure prevents all session actions and disables admission without leaking errors', async t => {
  const f = await fixture(t, { writeState: async () => { throw new Error('secret fixture key'); } });
  await f.send(1); await f.send(2, '/停止');
  assert.equal(f.starts.length, 0); assert.equal(f.stops.length, 0);
  assert.equal(f.bot.snapshot().enabled, false); assert.equal(f.bot.snapshot().lastError, 'STORAGE');
  assert.doesNotMatch(JSON.stringify(f.logs), /secret fixture/);
});

test('rejects robots including both participants, invalid events, stale messages and foreign channels', async t => {
  const f = await fixture(t); let n = 1;
  for (const overrides of [{ channel_type: 'PERSON' }, { type: 10 }, { target_id: '777777777' },
    { author_id: SELF, extra: { author: { id: SELF, bot: false } } },
    { author_id: OTHER_BOT, extra: { author: { id: OTHER_BOT, bot: false } } },
    { extra: { author: { id: USER, bot: true } } }, { extra: { author: { id: USER, bot: 'false' } } },
    { extra: { author: { id: '999999999', bot: false } } }, { msg_id: 'invalid' },
    { msg_timestamp: NOW - 300001 }, { msg_timestamp: NOW + 60001 }, { extra: null }]) {
    await f.send(n++, '/互聊 x', overrides);
  }
  await f.send(n, '/unknown');
  assert.equal(f.starts.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.bot.snapshot().seenCount, 0);
});

test('missing bot flags require confirmed matching human identity; confirmed flags skip lookups', async t => {
  const queries = [];
  const f = await fixture(t, { resolveAuthor: async input => { queries.push(input); return { id: input.userId, bot: false }; } });
  await f.send(1, '/互聊帮助', { extra: { author: { id: USER }, guild_id: '400000001' } });
  assert.deepEqual(queries, [{ userId: USER, guildId: '400000001' }]);
  f.advance(3000); await f.send(2, '/互聊帮助'); assert.equal(queries.length, 1);
  const unknown = await fixture(t, { resolveAuthor: async () => ({ id: USER, bot: true }) });
  await unknown.send(1, '/互聊 x', { extra: { author: { id: USER }, guild_id: '400000001' } });
  assert.equal(unknown.starts.length, 0);
});

test('closing while identity verification waits prevents new receipt or session effects', async t => {
  const identity = defer();
  const f = await fixture(t, { resolveAuthor: () => identity.promise });
  const handling = f.send(1, '/互聊 x', { extra: { author: { id: USER }, guild_id: '400000001' } });
  await flush(); const closing = f.bot.close(); identity.resolve({ id: USER, bot: false });
  await Promise.all([handling, closing]); assert.equal(f.starts.length, 0); assert.equal(f.bot.snapshot().seenCount, 0);
});

test('stop is always admitted during sender cooldown and while notices are in flight', async t => {
  const waiting = defer(); let replySignal;
  const f = await fixture(t, { reply: (_payload) => { replySignal = _payload.signal; return waiting.promise; } });
  await f.send(1, '/互聊 2 城市设计');
  assert.equal(f.starts.length, 1); assert.equal(f.bot.snapshot().pendingNotices, 1);
  await f.send(2, '停止'); assert.equal(f.stops.length, 1);
  assert.equal(f.bot.snapshot().pendingNotices, 1);
  const closing = f.bot.close(); assert.equal(replySignal.aborted, true);
  waiting.resolve({ messageId: id(900) }); await closing;
});

test('new questions join the active discussion and duplicate session receipts receive no notice', async t => {
  const f = await fixture(t); await f.send(1);
  f.advance(3000); await f.send(2, '不同话题'); await flush();
  assert.equal(f.bot.snapshot().starts, 1); assert.equal(f.contributions.length, 1);
  assert.match(f.replies.at(-1).content, /已加入讨论，下一位机器人会先回应你的补充/);
  assert.doesNotMatch(f.replies.at(-1).content, /先发送“停止”/);
  assert.doesNotMatch(f.replies.at(-1).content, /\/停止|\/互聊/);
  const duplicate = await fixture(t, { session: { async start() { return { accepted: false, reason: 'DUPLICATE' }; },
    async stop() {}, snapshot() { return { active: false }; } } });
  await duplicate.send(1); await flush(); assert.equal(duplicate.replies.length, 0);
});

test('numeric-leading questions keep their complete topic and only exact stop messages end an active discussion', async t => {
  const f = await fixture(t);
  await f.send(1, '2026 年有哪些值得讨论的科技趋势？');
  assert.equal(f.starts[0].topic, '2026 年有哪些值得讨论的科技趋势？'); assert.equal(f.starts[0].rounds, 0);
  f.advance(3000); await f.send(2, '为什么有些机器会突然停止运行？'); await flush();
  assert.equal(f.stops.length, 0); assert.equal(f.bot.snapshot().starts, 1);
  assert.equal(f.contributions[0].text, '为什么有些机器会突然停止运行？');
  assert.match(f.replies.at(-1).content, /已加入讨论/);
  f.advance(3000); await f.send(3, '停止'); await flush();
  assert.equal(f.stops.length, 1); assert.match(f.replies.at(-1).content, /已停止，保留当前话题/);
  assert.doesNotMatch(f.replies.at(-1).content, /\/互聊|\/停止/);
});

test('rapid interjections are all durably admitted despite user cooldown; only acknowledgements are throttled', async t => {
  const f = await fixture(t); await f.send(1, '开始讨论');
  for (let n = 2; n <= 35; n++) await f.send(n, `补充观点 ${n}`);
  await flush();
  assert.equal(f.starts.length, 1); assert.equal(f.contributions.length, 34);
  assert.equal(f.bot.snapshot().contributions, 34);
  assert.deepEqual(f.contributions[0], { text: '补充观点 2', userId: USER, receiptId: id(2), replyMessageId: id(2) });
  assert.ok(f.replies.length <= 1);
  await f.send(2, '补充观点 2'); assert.equal(f.contributions.length, 34);
  const ledger = await readFile(path.join(f.dataDir, 'duet-seen.json'), 'utf8');
  assert.equal(JSON.parse(ledger).seen.length, 35); assert.doesNotMatch(ledger, /补充观点/);
});

test('active contributions bypass the global command admission budget without starting a second session', async t => {
  const f = await fixture(t); await f.send(1, '开始讨论');
  for (let n = 2; n <= 30; n++) {
    const user = String(200000100 + n);
    await f.send(n, '互聊状态', { author_id: user, extra: { author: { id: user, bot: false } } }); await flush();
  }
  await f.send(31, '仍然需要回应的补充');
  assert.equal(f.contributions.length, 1); assert.equal(f.starts.length, 1);
  await f.send(32, '停止'); assert.equal(f.stops.length, 1);
});

test('contributions cannot enter a session before command receipt persistence', async t => {
  const ready = defer(), persisted = defer(); let paused = false;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (paused) { ready.resolve(); await persisted.promise; }
    await atomicJson(file, value);
  } });
  await f.send(1, '开始讨论'); paused = true;
  const handling = f.send(2, '补充'); await ready.promise;
  assert.equal(f.contributions.length, 0); persisted.resolve(); await handling;
  assert.equal(f.contributions.length, 1);
});

test('snapshot/admission races use one alternate route with the same receipt', async t => {
  for (const active of [false, true]) {
    const calls = [];
    const f = await fixture(t, { session: {
      async start(input) { calls.push({ kind: 'start', input }); return active
        ? { accepted: true, rounds: 0, unlimited: true, totalTurns: null } : { accepted: false, reason: 'BUSY' }; },
      async contribute(input) { calls.push({ kind: 'contribute', input }); return active
        ? { accepted: false, reason: 'NO_ACTIVE' } : { accepted: true, pendingInputs: 1 }; },
      async stop() {}, snapshot() { return { active }; },
    } });
    await f.send(1, '竞态中的问题'); await flush();
    assert.deepEqual(calls.map(call => call.kind), active ? ['contribute', 'start'] : ['start', 'contribute']);
    assert.ok(calls.every(call => call.input.receiptId === id(1) && call.input.replyMessageId === id(1)));
    assert.equal(f.bot.snapshot()[active ? 'starts' : 'contributions'], 1);
  }
});

test('repeated state changes and FINISHING do not cause retry loops or start a replacement run', async t => {
  for (const reason of ['NO_ACTIVE', 'FINISHING']) {
    const calls = [];
    const f = await fixture(t, { session: {
      async start() { calls.push('start'); return { accepted: false, reason: 'BUSY' }; },
      async contribute() { calls.push('contribute'); return { accepted: false, reason }; },
      async stop() {}, snapshot() { return { active: true }; },
    } });
    await f.send(1, '未被接纳的问题'); await flush();
    assert.deepEqual(calls, reason === 'NO_ACTIVE' ? ['contribute', 'start'] : ['contribute']);
    assert.match(f.replies[0].content, /暂未加入/);
    if (reason === 'FINISHING') assert.match(f.replies[0].content, /这轮讨论正在结束/);
    assert.equal(f.bot.snapshot().starts, 0); assert.equal(f.bot.snapshot().contributions, 0);
  }
});

test('full pending-input queue produces an explicit rejection even during acknowledgement cooldown', async t => {
  let contributions = 0;
  const f = await fixture(t, { session: {
    async start() { assert.fail('active discussion must not start twice'); },
    async contribute() { contributions++; return { accepted: false, reason: 'CAPACITY' }; },
    async stop() {}, snapshot() { return { active: true }; },
  } });
  await f.send(1, '帮助'); await flush();
  await f.send(2, '不应回显的补充'); await flush();
  assert.equal(contributions, 1); assert.equal(f.replies.length, 2);
  assert.match(f.replies.at(-1).content, /补充暂未加入/); assert.match(f.replies.at(-1).content, /请稍后重新发送/);
  assert.doesNotMatch(f.replies.at(-1).content, /不应回显的补充/);
  await f.send(2, '不应回显的补充'); assert.equal(contributions, 1);
});

test('active secret, oversized, robot and foreign-channel messages never reach contribute', async t => {
  const f = await fixture(t); await f.send(1, '开始讨论');
  await f.send(2, 'sk-privatefixture123456789'); await f.send(3, '长'.repeat(2001));
  await f.send(4, 'bot supplement', { extra: { author: { id: USER, bot: true } } });
  await f.send(5, 'foreign supplement', { target_id: '900000001' });
  assert.equal(f.contributions.length, 0); assert.equal(f.starts.length, 1);
});

test('closing before a delayed NO_ACTIVE response prevents a late fallback start', async t => {
  const pending = defer(); let starts = 0;
  const f = await fixture(t, { session: {
    async start() { starts++; return { accepted: true }; }, contribute() { return pending.promise; },
    async stop() {}, snapshot() { return { active: true }; },
  } });
  const handling = f.send(1, '迟到的问题');
  // Wait for durable admission before closing; the session promise itself remains pending.
  for (let n = 0; n < 100 && !f.bot.snapshot().commands; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.bot.snapshot().commands, 1);
  const closing = f.bot.close(); pending.resolve({ accepted: false, reason: 'NO_ACTIVE' });
  await Promise.all([handling, closing]); assert.equal(starts, 0); assert.equal(f.replies.length, 0);
});

test('stopping a discussion prevents replayed late input from starting it again', async t => {
  const f = await fixture(t); await f.send(1, '开始讨论'); await f.send(2, '我的补充');
  await f.send(3, '停止'); assert.equal(f.stops.length, 1);
  f.advance(3000); await f.send(2, '我的补充'); await f.send(1, '开始讨论');
  assert.equal(f.starts.length, 1); assert.equal(f.contributions.length, 1);
  assert.equal(f.config.session.snapshot().active, false);
});

test('secret and invalid topics produce fixed safe guidance without starting or echoing input', async t => {
  const f = await fixture(t);
  for (const [i, content] of ['sk-supersecretfixture123456789', '/互聊 999 私密话题', '私'.repeat(2001), '帮助'].entries()) {
    f.advance(3000); await f.send(i + 1, content); await flush();
  }
  assert.equal(f.starts.length, 0); assert.equal(f.replies.length, 4);
  assert.doesNotMatch(JSON.stringify(f.replies), /supersecret|私密话题|私私/);
});

test('status reports bounded progress without exposing arbitrary session fields', async t => {
  const f = await fixture(t, { session: { async start() {}, async stop() {}, snapshot() {
    return { active: true, status: 'running', completedTurns: 3, totalTurns: 12, topic: 'private-topic', lastErrorCode: 'private-key' };
  } } });
  await f.send(1, '/互聊状态'); await flush();
  assert.match(f.replies[0].content, /进行中/); assert.match(f.replies[0].content, /3 \/ 12/);
  assert.doesNotMatch(f.replies[0].content, /private/);
});

test('global notice and admission limits do not prevent a human stopping an active session', async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 31; n++) {
    const user = String(200000100 + n);
    await f.send(n, '/互聊状态', { author_id: user, extra: { author: { id: user, bot: false } } }); await flush();
  }
  assert.equal(f.replies.length, 30);
  await f.send(32, '/停止'); assert.equal(f.stops.length, 1); assert.equal(f.replies.length, 30);
});

test('corrupt or over-capacity receipt ledgers fail closed and expired records are pruned', async t => {
  const f = await fixture(t); await f.bot.close();
  const file = path.join(f.dataDir, 'duet-seen.json');
  await writeFile(file, 'private invalid JSON');
  const corrupt = await new DuetCommands(f.config).init(); t.after(() => corrupt.close());
  await corrupt.handle(event(1)); assert.equal(corrupt.snapshot().enabled, false); assert.equal(f.starts.length, 0);
  await writeFile(file, JSON.stringify({ version: 1, seen: Array.from({ length: 2048 }, (_, n) => ({ id: id(n + 1), at: NOW })) }));
  const full = await new DuetCommands(f.config).init(); t.after(() => full.close());
  await full.handle(event(9999)); assert.equal(full.snapshot().lastError, 'CAPACITY'); assert.equal(f.starts.length, 0);
  f.advance(600001); await full.handle(event(9999, '/互聊 x', { msg_timestamp: NOW + 600001 }));
  assert.equal(f.starts.length, 1); assert.equal(full.snapshot().seenCount, 1);
});

test('session and delivery failures stay sanitized and do not replay accepted commands', async t => {
  const f = await fixture(t, { session: { async start() { throw new Error('sk-private-source'); }, async stop() {},
    snapshot() { return { active: false }; } }, reply: async () => { throw new Error('private-token-network'); } });
  await f.send(1); await flush();
  assert.equal(f.bot.snapshot().lastError, 'DELIVERY');
  assert.doesNotMatch(JSON.stringify(f.logs), /sk-private|private-token/);
  await f.send(1); assert.equal(f.bot.snapshot().commands, 1);
});
