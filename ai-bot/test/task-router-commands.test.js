import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuetCommands } from '../src/duet-commands.js';
import { TaskRouter } from '../src/task-router.js';

const OWNER = '237000001', OTHER = '238000001', SELF = '100000001', PARTNER = '100000002';
const CHANNEL = '400000001', REQUEST = 'https://github.com/chixiaotao-Exm/Kook-Bot 检查并修复代码';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

async function fixture(t, { rejectStart = null, throwStart = false, ready = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'router-commands-'));
  const calls = [], replies = [], logs = [];
  const discussionState = { active: false, paused: false, status: 'idle' };
  const codeState = { active: false, paused: false, status: 'idle' };
  const record = (name, options) => { calls.push({ name, options }); };
  const discussion = {
    snapshot: () => ({ ...discussionState, enabled: true, rounds: 0, unlimited: true, completedTurns: 0, totalTurns: null }),
    async start(options) { record('discussion.start', options); discussionState.active = true; discussionState.status = 'running';
      return { accepted: true, rounds: 0, unlimited: true, totalTurns: null }; },
    async contribute(options) { record('discussion.contribute', options); return { accepted: true }; },
    async pause(options) { record('discussion.pause', options); discussionState.paused = true; discussionState.status = 'paused'; return { paused: true }; },
    async resume(options) { record('discussion.resume', options); discussionState.paused = false; discussionState.status = 'running'; return { resumed: true }; },
    async stop(options) { record('discussion.stop', options); discussionState.active = false; discussionState.paused = false; discussionState.status = 'stopped'; return { stopped: true }; },
  };
  // Match CodeSession's independent authorization boundary. Router may dispatch
  // controls here, but no unauthorized dispatch changes state or performs work.
  const allowed = options => options?.userId === OWNER;
  const code = {
    snapshot: () => ({ ...codeState, enabled: true, steps: 0 }),
    async start(options) {
      record('code.start', options);
      if (!allowed(options)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
      if (throwStart) throw Object.assign(new Error('private-broker-key-and-path'), { code: 'BROKER_FAILED' });
      if (rejectStart) return { accepted: false, reason: rejectStart };
      codeState.active = true; codeState.status = 'coding'; return { accepted: true };
    },
    async contribute(options) {
      record('code.contribute', options);
      if (!allowed(options)) return { accepted: false, reason: 'NOT_AUTHORIZED' };
      return { accepted: true, paused: codeState.paused };
    },
    async pause(options) {
      record('code.pause', options);
      if (!allowed(options)) return { paused: false, reason: 'NOT_AUTHORIZED' };
      codeState.paused = true; codeState.status = 'paused'; return { paused: true };
    },
    async resume(options) {
      record('code.resume', options);
      if (!allowed(options)) return { resumed: false, reason: 'NOT_AUTHORIZED' };
      codeState.paused = false; codeState.status = 'coding'; return { resumed: true };
    },
    async stop(options) {
      record('code.stop', options);
      if (!allowed(options)) return { stopped: false, reason: 'NOT_AUTHORIZED' };
      codeState.active = false; codeState.paused = false; codeState.status = 'stopped'; return { stopped: true };
    },
  };
  const router = new TaskRouter({ discussion, code, operatorIds: new Set([OWNER]), isReady: () => ready });
  let now = Date.parse('2026-09-23T10:00:00Z'), sequence = 0;
  const commands = await new DuetCommands({ session: router, channelId: CHANNEL, dataDir,
    getSelfId: () => SELF, getParticipantIds: () => [SELF, PARTNER], now: () => now,
    reply: async payload => { replies.push(payload); return { messageId: id(9999) }; }, logger: value => logs.push(value) }).init();
  t.after(async () => { await commands.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, router, commands, discussionState, codeState, calls, replies, logs,
    async send(userId, content, overrides = {}) {
      now += 3001; sequence++;
      await commands.handle({ type: 9, channel_type: 'GROUP', target_id: CHANNEL, author_id: userId,
        msg_id: id(sequence), msg_timestamp: now, content, extra: { guild_id: '500000001', author: { id: userId, bot: false } }, ...overrides });
      await flush(); return replies.at(-1)?.content;
    } };
}

test('authorized repository request replaces discussion once, persists receipt and counts code task start', async t => {
  const f = await fixture(t);
  await f.send(OTHER, '未来城市会是什么样？');
  assert.equal(f.discussionState.active, true);
  const response = await f.send(OWNER, REQUEST);
  assert.deepEqual(f.calls.map(call => call.name), ['discussion.start', 'discussion.stop', 'code.start']);
  assert.equal(f.codeState.active, true); assert.equal(f.discussionState.active, false);
  assert.match(response, /已开始代码任务/); assert.doesNotMatch(response, /已加入讨论/);
  assert.equal(f.commands.snapshot().starts, 2); assert.equal(f.commands.snapshot().contributions, 0);
  const admission = f.calls.at(-1).options;
  assert.equal(admission.userId, OWNER); assert.equal(admission.topic, REQUEST);
  assert.equal(admission.receiptId, id(2)); assert.equal(admission.replyMessageId, id(2));
  const saved = await readFile(path.join(f.dataDir, 'duet-seen.json'), 'utf8');
  assert.ok(saved.includes(id(2))); assert.doesNotMatch(saved, /github|237000001|检查并修复/);
});

test('unauthorized repository requests cannot start code tasks or stop normal discussion', async t => {
  const f = await fixture(t);
  assert.match(await f.send(OTHER, REQUEST), /只有已授权的操作者/);
  assert.equal(f.calls.length, 0); assert.equal(f.commands.snapshot().starts, 0);
  await f.send(OTHER, '一个普通问题');
  assert.match(await f.send(OTHER, REQUEST), /只有已授权的操作者/);
  assert.equal(f.discussionState.active, true); assert.equal(f.codeState.active, false);
  assert.deepEqual(f.calls.map(call => call.name), ['discussion.start']);
  assert.match(await f.send(OTHER, '停止'), /已停止，保留当前话题/);
  assert.equal(f.discussionState.active, false);
  assert.equal(f.calls.at(-1).name, 'discussion.stop');
});

test('other users cannot contribute, pause, resume or stop active code tasks and get no success acknowledgement', async t => {
  const f = await fixture(t); await f.send(OWNER, REQUEST);
  const baseline = f.commands.snapshot();
  for (const text of ['请顺便修改配置', '先暂停', '继续', '停止']) {
    const response = await f.send(OTHER, text);
    assert.match(response, /只有已授权的操作者/);
    assert.doesNotMatch(response, /已停止|已暂停|已恢复|已记录|已开始/);
    assert.equal(f.codeState.active, true); assert.equal(f.codeState.paused, false);
  }
  const after = f.commands.snapshot();
  for (const count of ['starts', 'contributions', 'pauses', 'resumes', 'stops']) assert.equal(after[count], baseline[count]);
  assert.deepEqual(f.calls.slice(1).map(call => call.name), ['code.pause', 'code.resume', 'code.stop']);
  assert.ok(f.calls.slice(1).every(call => call.options.userId === OTHER));
  assert.ok(f.calls.every(call => !call.name.startsWith('discussion.')));
});

test('owner controls stay routed to code task, including supplements while paused', async t => {
  const f = await fixture(t); await f.send(OWNER, REQUEST);
  assert.match(await f.send(OWNER, '先暂停一下！'), /已暂停/);
  assert.equal(f.codeState.paused, true);
  assert.match(await f.send(OWNER, '还需要检查回归测试'), /已记录你的补充/);
  assert.equal(f.codeState.paused, true);
  assert.equal(f.commands.snapshot().contributions, 1);
  assert.match(await f.send(OWNER, '互聊状态'), /代码任务：已暂停/);
  assert.match(await f.send(OWNER, '继续'), /已恢复/);
  assert.equal(f.codeState.paused, false);
  assert.match(await f.send(OWNER, '停止'), /已停止/);
  assert.equal(f.codeState.active, false);
  assert.equal(f.commands.snapshot().pauses, 1); assert.equal(f.commands.snapshot().resumes, 1); assert.equal(f.commands.snapshot().stops, 1);
  assert.deepEqual(f.calls.map(call => call.name), ['code.start', 'code.pause', 'code.contribute', 'code.resume', 'code.stop']);
  assert.ok(f.calls.every(call => call.options.userId === OWNER));
});

test('normal discussion remains open to other authors after a completed code task', async t => {
  const f = await fixture(t); await f.send(OWNER, REQUEST); await f.send(OWNER, '停止');
  const codeCalls = f.calls.filter(call => call.name.startsWith('code.')).length;
  await f.send(OTHER, '生活中如何学习新技能？');
  assert.equal(f.router.mode(), 'discussion');
  await f.send(OTHER, '再加一个学习方法'); await f.send(OTHER, '先暂停');
  assert.equal(f.discussionState.paused, true);
  await f.send(OTHER, '继续'); await f.send(OTHER, '停止');
  assert.equal(f.discussionState.active, false);
  assert.equal(f.calls.filter(call => call.name.startsWith('code.')).length, codeCalls);
  assert.deepEqual(f.calls.slice(codeCalls).map(call => call.name),
    ['discussion.start', 'discussion.contribute', 'discussion.pause', 'discussion.resume', 'discussion.stop']);
});

test('unknown repository receives fixed denial and rejected code starts never count as successful starts', async t => {
  const f = await fixture(t, { rejectStart: 'NOT_READY' });
  const unknown = await f.send(OWNER, 'https://github.com/other/private-repo 检查');
  assert.match(unknown, /目前代码任务只支持 chixiaotao-Exm\/Kook-Bot/);
  assert.doesNotMatch(unknown, /other\/private-repo|已开始/); assert.equal(f.calls.length, 0);
  const rejected = await f.send(OWNER, REQUEST);
  assert.doesNotMatch(rejected, /已开始代码任务|已记录你的补充/);
  assert.equal(f.commands.snapshot().starts, 0); assert.equal(f.commands.snapshot().contributions, 0);
  assert.equal(f.calls.at(-1).name, 'code.start'); assert.equal(f.codeState.active, false);
});

test('broker errors and forged bot or foreign-channel controls produce no leaked detail or side effects', async t => {
  const f = await fixture(t, { throwStart: true });
  const response = await f.send(OWNER, REQUEST);
  assert.match(response, /暂时不可用/);
  assert.doesNotMatch(JSON.stringify({ response, logs: f.logs, snapshot: f.commands.snapshot() }), /private-broker-key-and-path/);
  assert.equal(f.commands.snapshot().starts, 0);
  const count = f.calls.length;
  await f.send(OWNER, REQUEST, { extra: { author: { id: OWNER, bot: true } } });
  await f.send(OWNER, REQUEST, { target_id: '400000009' });
  await f.send(SELF, '停止'); await f.send(PARTNER, '先暂停');
  assert.equal(f.calls.length, count);
});
