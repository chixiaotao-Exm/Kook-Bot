import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DuetSession } from '../src/duet-session.js';
import { atomicJson } from '../src/storage.js';

const CHANNEL = '300000001', USER = '200000001', NOW = Date.parse('2026-09-22T12:00:00Z');
const receipt = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const request = (overrides = {}) => ({ topic: '未来的城市应该是什么样子？', userId: USER, receiptId: receipt(1), replyMessageId: receipt(1), ...overrides });
const contribution = (n, text = `用户补充 ${n}`) => ({ text, userId: USER, receiptId: receipt(1000 + n), replyMessageId: receipt(1000 + n) });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  for (let n = 0; n < 500; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('duet operation did not settle');
}
async function fixture(t, options = {}, overrides = []) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-duet-'));
  const calls = [], replies = [], logs = [];
  const participants = ['A', 'B'].map((label, speaker) => ({ label,
    generate: async (messages, config) => { calls.push({ speaker, messages, signal: config.signal }); return { text: `${label} 的第 ${calls.length} 条观点。` }; },
    reply: async content => { replies.push({ speaker, ...content }); return { messageId: receipt(100 + replies.length) }; },
    ...overrides[speaker] }));
  const config = { participants, channelId: CHANNEL, dataDir, rounds: 6, deadlineMs: 600_000, betweenTurnsMs: 0, now: () => NOW,
    logger: item => logs.push(item), ...options };
  const session = await new DuetSession(config).init();
  t.after(async () => { await session.close(); assert.ok(path.basename(dataDir).startsWith('kook-duet-')); await rm(dataDir, { recursive: true, force: true }); });
  return { session, config, dataDir, participants, calls, replies, logs,
    async done(status = 'completed') { await until(() => !session.snapshot().active && session.snapshot().status === status); },
    async saved(status) { await session.close(); const value = JSON.parse(await readFile(path.join(dataDir, 'duet-state.json'), 'utf8'));
      assert.equal(value.lastRun.status, status); return value; } };
}

test('six rounds make exactly twelve alternating model calls and one fixed completion notice', async t => {
  const f = await fixture(t);
  const result = await f.session.start(request()); assert.equal(result.accepted, true); assert.equal(result.totalTurns, 12);
  await f.done();
  assert.equal(f.calls.length, 12); assert.equal(f.replies.length, 13);
  assert.deepEqual(f.calls.map(call => call.speaker), Array.from({ length: 12 }, (_, n) => n % 2));
  assert.deepEqual(f.replies.slice(0, 12).map(item => item.speaker), f.calls.map(item => item.speaker));
  assert.match(f.replies[11].content, /第 6\/6 轮 · B/); assert.match(f.replies[12].content, /共 12 条/);
  assert.ok(f.replies.every(item => item.textOnly === true && item.targetId === CHANNEL && item.replyMessageId === receipt(1)));
  assert.equal(f.session.snapshot().completedTurns, 12);
  const saved = await f.saved('completed'); assert.equal(saved.lastRun.completedTurns, 12);
});

test('each identity sees its own posts as assistant and only exact published text as history', async t => {
  const f = await fixture(t, { rounds: 2 });
  await f.session.start(request()); await f.done();
  const secondA = f.calls[2].messages;
  assert.deepEqual(secondA.slice(1, 3), [{ role: 'assistant', content: f.replies[0].content }, { role: 'user', content: f.replies[1].content }]);
  const secondB = f.calls[3].messages;
  assert.equal(secondB[1].role, 'user'); assert.equal(secondB[2].role, 'assistant'); assert.equal(secondB[3].role, 'user');
  assert.ok(f.calls.every(call => call.messages.at(-1).role === 'user'));
  assert.match(secondA.at(-1).content, /回应B最新的发言/);
});

test('admission is asynchronous, allows a smaller explicit round count, and rejects overlapping runs', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, {}, [{ generate: async (_, { signal }) => { calls.push(signal); return pending.promise; } }]);
  const first = await f.session.start(request({ rounds: 1 }));
  assert.equal(first.accepted, true); assert.equal(first.totalTurns, 2);
  assert.equal((await f.session.start(request({ receiptId: receipt(2) }))).reason, 'BUSY');
  assert.equal((await f.session.start(request())).reason, 'DUPLICATE');
  pending.resolve({ text: 'A answer' }); await f.done(); assert.equal(calls.length, 1); assert.equal(f.calls.length, 1);
});

test('first model call waits for durable receipt and run metadata', async t => {
  const entered = defer(), persisted = defer(); let writes = 0;
  const f = await fixture(t, { rounds: 1, writeState: async (file, value) => {
    if (++writes === 1) { entered.resolve(); await persisted.promise; }
    await atomicJson(file, value);
  } });
  const starting = f.session.start(request()); await entered.promise;
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
  persisted.resolve(); assert.equal((await starting).accepted, true); await f.done();
});

test('next model call waits for confirmed previous message delivery', async t => {
  const delivery = defer(), entered = defer();
  const f = await fixture(t, { rounds: 1 }, [{ reply: async item => { entered.resolve(); await delivery.promise; return { messageId: receipt(99) }; } }]);
  await f.session.start(request()); await entered.promise;
  assert.equal(f.calls.length, 1); delivery.resolve(); await f.done(); assert.equal(f.calls.length, 2);
});

test('between-turn delay is explicit and abortable, without concurrent generation', async t => {
  const timers = new Map(); let count = 0;
  const f = await fixture(t, { rounds: 1, betweenTurnsMs: 2000,
    setTimeoutImpl: (callback, ms) => { const id = ++count; timers.set(id, { callback, ms }); return id; },
    clearTimeoutImpl: id => timers.delete(id) });
  await f.session.start(request()); await until(() => [...timers.values()].some(timer => timer.ms === 2000));
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
  const [id, timer] = [...timers].find(([, entry]) => entry.ms === 2000); timers.delete(id); timer.callback();
  await f.done(); assert.equal(f.calls.length, 2);
});

test('stop aborts a model ignoring cancellation and late output cannot enter a later run', async t => {
  const pending = defer(); let firstSignal, firstCalls = 0;
  const f = await fixture(t, { rounds: 1 }, [{ generate: async (_, { signal }) => {
    if (++firstCalls === 1) { firstSignal = signal; return pending.promise; } return { text: 'new run answer' };
  } }]);
  await f.session.start(request()); await until(() => Boolean(firstSignal));
  assert.deepEqual(await f.session.stop(), { stopped: true }); assert.equal(firstSignal.aborted, true);
  await f.done('stopped');
  assert.equal((await f.session.start(request({ receiptId: receipt(2), replyMessageId: receipt(2) }))).accepted, true);
  pending.resolve({ text: 'never send this stale answer' }); await f.done();
  assert.ok(!f.replies.some(item => item.content.includes('stale'))); assert.equal(f.replies.length, 3);
});

test('stop during unconfirmed delivery never starts the other participant', async t => {
  const pending = defer(); let signal;
  const f = await fixture(t, { rounds: 1 }, [{ reply: async item => { signal = item.signal; return pending.promise; } }]);
  await f.session.start(request()); await until(() => Boolean(signal)); await f.session.stop();
  assert.equal(signal.aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.session.snapshot().completedTurns, 0);
  pending.resolve({ messageId: receipt(99) }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1); assert.equal(f.session.snapshot().status, 'stopped');
});

test('hard deadline terminates a hung model and posts a single fixed reason without retry', async t => {
  const pending = defer(); let signal, calls = 0;
  const f = await fixture(t, { rounds: 1, deadlineMs: 25 }, [{ generate: async (_, request) => { calls++; signal = request.signal; return pending.promise; } }]);
  await f.session.start(request()); await f.done('timeout'); await until(() => f.replies.length === 1);
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.match(f.replies[0].content, /时间上限/);
  pending.resolve({ text: 'late' }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.replies.length, 1); assert.equal(f.session.snapshot().lastErrorCode, 'TIMEOUT');
});

test('restart marks an active saved session interrupted and never replays its receipt', async t => {
  const pending = defer(); let calls = 0;
  const f = await fixture(t, {}, [{ generate: async () => { calls++; return pending.promise; } }]);
  await f.session.start(request()); await until(() => calls === 1);
  const restarted = await new DuetSession(f.config).init();
  assert.equal(restarted.snapshot().status, 'interrupted'); assert.equal(restarted.snapshot().active, false);
  assert.equal((await restarted.start(request())).reason, 'DUPLICATE'); assert.equal(calls, 1);
  await restarted.close(); await f.session.close(); pending.resolve({ text: 'late' });
});

test('completed sessions stay complete after restart and duplicate starts cost nothing', async t => {
  const f = await fixture(t, { rounds: 1 }); await f.session.start(request()); await f.done(); await f.saved('completed');
  const restarted = await new DuetSession(f.config).init();
  assert.equal(restarted.snapshot().status, 'completed'); assert.equal((await restarted.start(request())).reason, 'DUPLICATE');
  assert.equal(f.calls.length, 2); await restarted.close();
});

test('failed initial persistence or corrupt state prevents any generation', async t => {
  const f = await fixture(t, { writeState: async () => { throw new Error('private disk location'); } });
  assert.equal((await f.session.start(request())).accepted, false); assert.equal(f.calls.length, 0);
  assert.equal(f.session.snapshot().enabled, false); assert.equal(f.session.snapshot().lastErrorCode, 'STORAGE');
  await writeFile(path.join(f.dataDir, 'duet-state.json'), '{invalid');
  const restarted = await new DuetSession(f.config).init(); assert.equal(restarted.snapshot().enabled, false);
  assert.equal((await restarted.start(request())).accepted, false); await restarted.close();
});

test('persistence failure after confirmed turn stops all following model calls', async t => {
  let writes = 0;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (++writes === 2) throw new Error('private ledger failure'); await atomicJson(file, value);
  } });
  await f.session.start(request()); await f.done('failed');
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1); assert.equal(f.session.snapshot().enabled, false);
  assert.equal(f.session.snapshot().lastErrorCode, 'STORAGE');
});

test('public text and history are bounded, and diagnostics never retain topics or transcripts', async t => {
  const secretTopic = 'TOPIC_PRIVATE_FIXTURE', body = '😀'.repeat(20_000), calls = [];
  const f = await fixture(t, {}, [0, 1].map(speaker => ({ generate: async messages => {
    calls.push({ speaker, messages }); return { text: body, historyText: 'HIDDEN_UNSENT_CONTENT' };
  } })));
  await f.session.start(request({ topic: secretTopic })); await f.done();
  const turns = f.replies.slice(0, 12);
  assert.ok(turns.every(item => item.content.length <= 1200 && item.content.isWellFormed() && /已截短/.test(item.content)));
  assert.ok(calls.every(call => call.messages.length <= 12 && call.messages.reduce((n, item) => n + item.content.length, 0) <= 20_000));
  assert.ok(!JSON.stringify(calls).includes('HIDDEN_UNSENT_CONTENT'));
  const saved = JSON.stringify(await f.saved('completed'));
  assert.ok(!saved.includes(secretTopic)); assert.ok(!saved.includes('😀')); assert.ok(!saved.includes(USER));
  assert.ok(!JSON.stringify(f.logs).includes(secretTopic)); assert.ok(!JSON.stringify(f.session.snapshot()).includes(secretTopic));
});

test('model failures expose only known codes and ambiguous delivery is not retried', async t => {
  for (const kind of ['model', 'delivery']) {
    let operations = 0;
    const override = kind === 'model' ? { generate: async () => { operations++; throw Object.assign(new Error('private provider detail'), { code: 'sk-private-injected-code' }); } }
      : { reply: async () => { operations++; throw Object.assign(new Error('private reply detail'), { code: 'KOOK_TIMEOUT' }); } };
    const f = await fixture(t, {}, [override]); await f.session.start(request()); await f.done('failed');
    assert.equal(operations, 1); assert.equal(f.replies.length, 0);
    assert.equal(f.session.snapshot().lastErrorCode, kind === 'model' ? 'UNKNOWN' : 'KOOK_TIMEOUT');
    assert.ok(!JSON.stringify(f.logs).includes('private')); assert.ok(!JSON.stringify(f.session.snapshot()).includes('private'));
  }
});

test('a reply without a valid confirmation ID stops before another model request', async t => {
  const f = await fixture(t, {}, [{ reply: async () => ({ messageId: 'unconfirmed' }) }]);
  await f.session.start(request()); await f.done('failed');
  assert.equal(f.calls.length, 1); assert.equal(f.session.snapshot().completedTurns, 0);
  assert.equal(f.session.snapshot().lastErrorCode, 'KOOK_INVALID_RESPONSE');
});

test('failed final ledger persistence exposes failed status and stops accepting new runs', async t => {
  let writes = 0;
  const f = await fixture(t, { rounds: 1, writeState: async (file, value) => {
    if (++writes === 4) throw new Error('fixture final persistence failure'); await atomicJson(file, value);
  } });
  await f.session.start(request()); await f.done('failed');
  assert.equal(f.calls.length, 2); assert.equal(f.session.snapshot().enabled, false);
  assert.equal(f.session.snapshot().lastErrorCode, 'STORAGE');
  assert.equal((await f.session.start(request({ receiptId: receipt(2) }))).reason, 'NOT_READY');
});

test('one optional session progress card finishes once, without per-turn phase changes', async t => {
  const steps = [];
  const f = await fixture(t, { rounds: 1 }, [{ progress: { start: async () => { steps.push('start'); return {
    setPhase: async () => assert.fail('session phase should not move per turn'), finish: async () => steps.push('finish'),
    fail: async code => steps.push(code), cancel: async () => steps.push('cancel'),
  }; } } }, { progress: { start: async () => assert.fail('second participant must not create progress cards') } }]);
  await f.session.start(request()); await f.done(); await until(() => steps.includes('finish'));
  assert.deepEqual(steps, ['start', 'finish']);
});

test('progress failure does not trigger extra AI calls and late startup is cancelled after stop', async t => {
  const failed = await fixture(t, { rounds: 1 }, [{ progress: { start: async () => { throw new Error('private progress detail'); } } }]);
  await failed.session.start(request()); await failed.done(); assert.equal(failed.calls.length, 2);
  const pending = defer(), entered = defer(), terminals = [];
  const delayed = await fixture(t, { rounds: 1 }, [{ progress: { start: async () => { entered.resolve(); return pending.promise; } } }]);
  await delayed.session.start(request()); await entered.promise; await delayed.session.stop();
  pending.resolve({ cancel: async () => terminals.push('cancel') }); await until(() => terminals.length === 1);
  assert.equal(delayed.calls.length, 0); assert.deepEqual(terminals, ['cancel']);
});

test('bad input cannot start sessions and close cancels without a completion or timeout notice', async t => {
  const pending = defer(); let signal;
  const f = await fixture(t, {}, [{ generate: async (_, options) => { signal = options.signal; return pending.promise; } }]);
  for (const bad of [{ topic: '' }, { topic: 'x'.repeat(2001) }, { rounds: 7 }, { rounds: -1 }, { userId: 'bad' }, { receiptId: '--bad--' }])
    assert.equal((await f.session.start(request(bad))).reason, 'INVALID_INPUT');
  await f.session.start(request()); await until(() => Boolean(signal)); await f.session.close();
  assert.equal(signal.aborted, true); assert.equal(f.session.snapshot().enabled, false); assert.equal(f.session.snapshot().status, 'interrupted');
  pending.resolve({ text: 'late' }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.replies.length, 0);
});

test('constructor defaults keep talking past twelve turns and ten minutes until manual stop', async t => {
  const pending = defer(), calls = [], timers = []; let now = NOW;
  const f = await fixture(t, { rounds: undefined, deadlineMs: undefined, now: () => now,
    setTimeoutImpl: (callback, ms) => { timers.push(ms); return setTimeout(callback, ms); } },
  [0, 1].map(speaker => ({ generate: async (messages, options) => {
    now += 60_000;
    calls.push({ speaker, messages, signal: options.signal, historyMessages: f.session.snapshot().historyMessages });
    return calls.length === 31 ? pending.promise : { text: 'x'.repeat(2400) };
  } })));
  const idle = f.session.snapshot();
  assert.equal(idle.defaultRounds, 0); assert.equal(idle.deadlineMs, 0);
  const admitted = await f.session.start(request());
  assert.equal(admitted.unlimited, true); assert.equal(admitted.rounds, 0); assert.equal(admitted.totalTurns, null);
  await until(() => calls.length === 31);
  const running = f.session.snapshot();
  assert.equal(running.active, true); assert.equal(running.completedTurns, 30); assert.equal(running.currentRound, 16);
  assert.equal(running.deadlineAt, null); assert.ok(now > NOW + 600_000); assert.deepEqual(timers, []);
  assert.ok(calls.every(call => call.historyMessages <= 10 && call.messages.length <= 12));
  assert.ok(calls.every(call => call.messages.reduce((size, message) => size + message.content.length, 0) <= 20_000));
  assert.equal(running.historyMessages, 10); assert.equal(f.replies.length, 30);
  assert.match(f.replies[24].content, /第 13 轮/); assert.ok(!f.replies.some(item => item.content.includes('/0')));
  await f.session.stop(); assert.equal(calls[30].signal.aborted, true);
  pending.resolve({ text: 'late output after explicit stop' }); await f.done('stopped');
  const saved = await f.saved('stopped');
  assert.equal(saved.lastRun.rounds, 0); assert.equal(saved.lastRun.completedTurns, 30);
  assert.equal(f.replies.length, 30); assert.ok(!f.replies.some(item => /互聊已完成|时间上限|late output/.test(item.content)));
});

test('unlimited round-zero ledger accepts large safe turn counts and never resumes after restart', async t => {
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 });
  await writeFile(path.join(f.dataDir, 'duet-state.json'), JSON.stringify({ version: 1, runs: 1,
    seen: [{ id: receipt(1), at: NOW }], lastRun: { runId: receipt(9), receiptId: receipt(1),
      startedAt: NOW, updatedAt: NOW, rounds: 0, completedTurns: 10_000, status: 'running', errorCode: null } }));
  const restarted = await new DuetSession(f.config).init();
  assert.equal(restarted.snapshot().enabled, true); assert.equal(restarted.snapshot().active, false);
  assert.equal(restarted.snapshot().status, 'interrupted'); assert.equal(restarted.snapshot().completedTurns, 10_000);
  assert.equal(restarted.snapshot().unlimited, true); assert.equal(restarted.snapshot().totalTurns, null);
  assert.equal((await restarted.start(request())).reason, 'DUPLICATE'); assert.equal(f.calls.length, 0);
  await restarted.close();
});

test('explicit positive rounds remain finite under the new unlimited defaults', async t => {
  const f = await fixture(t, { rounds: undefined, deadlineMs: undefined });
  const result = await f.session.start(request({ rounds: 2 }));
  assert.equal(result.unlimited, false); assert.equal(result.totalTurns, 4);
  await f.done(); assert.equal(f.calls.length, 4); assert.equal(f.replies.length, 5);
  assert.match(f.replies[3].content, /第 2\/2 轮/);
});

test('human input interrupts generation and regenerates the same speaker with both actors retaining it', async t => {
  const old = defer(), nextB = defer(), laterA = defer(), aCalls = [], bCalls = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [
    { generate: async (messages, options) => { aCalls.push({ messages, signal: options.signal });
      return aCalls.length === 1 ? old.promise : aCalls.length === 2 ? { text: 'A 回应用户的新观点' } : laterA.promise; } },
    { generate: async (messages, options) => { bCalls.push({ messages, signal: options.signal }); return nextB.promise; } },
  ]);
  await f.session.start(request()); await until(() => aCalls.length === 1);
  const added = await f.session.contribute(contribution(1, '请考虑无障碍出行。'));
  assert.equal(added.accepted, true); assert.equal(aCalls[0].signal.aborted, true);
  await until(() => bCalls.length === 1);
  assert.equal(aCalls.length, 2); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].speaker, 0);
  assert.equal(f.replies[0].replyMessageId, receipt(1)); assert.equal(f.session.snapshot().completedTurns, 1);
  assert.equal(f.session.snapshot().pendingInputs, 1);
  for (const call of [aCalls[1], bCalls[0]]) {
    assert.ok(call.messages.some(message => message.role === 'user' && message.content === '【用户补充】\n请考虑无障碍出行。'));
    assert.match(call.messages[0].content, /未来的城市/); assert.match(call.messages.at(-1).content, /优先回应.*用户/);
    assert.match(call.messages.at(-1).content, /按用户最新的长度和格式要求.*未指定时/);
  }
  assert.ok(bCalls[0].messages.some(message => message.content === f.replies[0].content));
  assert.equal((await f.session.contribute(contribution(1))).reason, 'DUPLICATE');
  nextB.resolve({ text: 'B 结合用户观点继续讨论' }); await until(() => aCalls.length === 3);
  assert.equal(f.session.snapshot().pendingInputs, 0); assert.equal(f.session.snapshot().contributions, 1);
  assert.ok(aCalls[2].messages.some(message => message.content.includes('请考虑无障碍出行')));
  old.resolve({ text: '丢弃的过期答案' }); await f.session.stop();
  assert.equal(f.replies.length, 2); assert.ok(!f.replies.some(item => item.content.includes('过期答案')));
  laterA.resolve({ text: '迟到输出' });
});

test('input during delivery preserves that confirmed post and changes the next actor while keeping the original quote', async t => {
  const delivery = defer(), secondResponse = defer(), aLater = defer(), delivered = [], bCalls = []; let aCalls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [
    { generate: async () => ++aCalls === 1 ? { text: '已经开始发送的A回复' } : aLater.promise,
      reply: async item => { delivered.push(item); return delivery.promise; } },
    { generate: async messages => { bCalls.push(messages); return secondResponse.promise; } },
  ]);
  await f.session.start(request()); await until(() => delivered.length === 1);
  assert.equal((await f.session.contribute(contribution(1, '补充一个新角度'))).accepted, true);
  assert.equal(delivered[0].signal.aborted, false); assert.equal(delivered[0].replyMessageId, receipt(1));
  assert.equal(aCalls, 1); delivery.resolve({ messageId: receipt(500) });
  await until(() => bCalls.length === 1);
  assert.ok(bCalls[0].some(message => message.content.includes('补充一个新角度')));
  assert.ok(bCalls[0].some(message => message.content === delivered[0].content));
  secondResponse.resolve({ text: 'B 回应新角度' }); await until(() => f.replies.length === 1);
  assert.equal(f.replies[0].replyMessageId, receipt(1)); assert.equal(f.replies[0].speaker, 1);
  await f.session.stop(); aLater.resolve({ text: 'late' });
});

test('human input between turns is included in the next generation without restarting the topic', async t => {
  const timers = new Map(), pending = defer(), calls = []; let serial = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0, betweenTurnsMs: 2000,
    setTimeoutImpl: (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeoutImpl: id => timers.delete(id) }, [undefined,
    { generate: async messages => { calls.push(messages); return pending.promise; } }]);
  await f.session.start(request()); await until(() => [...timers.values()].some(timer => timer.ms === 2000));
  await f.session.contribute(contribution(1, '用户要求继续原话题并关注成本'));
  const [id, timer] = [...timers].find(([, entry]) => entry.ms === 2000); timers.delete(id); timer.callback();
  await until(() => calls.length === 1);
  assert.match(calls[0][0].content, /未来的城市/);
  assert.ok(calls[0].some(message => message.content === f.replies[0].content));
  assert.ok(calls[0].some(message => message.content.includes('关注成本')));
  await f.session.stop(); pending.resolve({ text: 'late' });
});

test('contribution must reach disk before interrupting, and an old answer cannot pass its delivery barrier', async t => {
  const old = defer(), blockedWrite = defer(), writing = defer(), bPending = defer(), aCalls = []; let writes = 0, durable = false;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0, writeState: async (file, value) => {
    const current = ++writes;
    if (current === 2) { writing.resolve(); await blockedWrite.promise; }
    await atomicJson(file, value); if (current === 2) durable = true;
  } }, [
    { generate: async (messages, options) => { aCalls.push({ messages, signal: options.signal });
      if (aCalls.length === 1) return old.promise; assert.equal(durable, true); return { text: '包含补充的新答案' }; } },
    { generate: async () => bPending.promise },
  ]);
  await f.session.start(request()); await until(() => aCalls.length === 1);
  const adding = f.session.contribute(contribution(1, '落盘前不能开始按此内容生成'));
  await writing.promise; assert.equal(aCalls[0].signal.aborted, false);
  old.resolve({ text: '不得发送的旧答案' }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.replies.length, 0); blockedWrite.resolve(); assert.equal((await adding).accepted, true);
  await until(() => f.replies.length === 1);
  assert.match(f.replies[0].content, /包含补充/); assert.equal(f.replies[0].replyMessageId, receipt(1));
  await f.session.stop(); bPending.resolve({ text: 'late' });
});

test('contribution persistence failure stops safely without generating from uncommitted text', async t => {
  const pending = defer(); let calls = 0, signal, writes = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0, writeState: async (file, value) => {
    if (++writes === 2) throw new Error('private contribution storage error'); await atomicJson(file, value);
  } }, [{ generate: async (_, options) => { calls++; signal = options.signal; return pending.promise; } }]);
  await f.session.start(request()); await until(() => calls === 1);
  assert.equal((await f.session.contribute(contribution(1))).reason, 'NOT_READY');
  await f.done('failed'); assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(f.replies.length, 0);
  assert.equal(f.session.snapshot().lastErrorCode, 'STORAGE'); assert.ok(!JSON.stringify(f.logs).includes('private'));
  pending.resolve({ text: 'late' });
});

test('stop during contribution persistence rolls back the receipt and permits a fresh start with it', async t => {
  const pending = defer(), writing = defer(), release = defer(); let writes = 0, calls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0, writeState: async (file, value) => {
    if (++writes === 2) { writing.resolve(); await release.promise; } await atomicJson(file, value);
  } }, [{ generate: async () => { calls++; return pending.promise; } }]);
  await f.session.start(request()); await until(() => calls === 1);
  const adding = f.session.contribute(contribution(1)); await writing.promise;
  const stopping = f.session.stop(); release.resolve();
  assert.equal((await adding).reason, 'NO_ACTIVE'); await stopping;
  const restarted = await f.session.start(request({ receiptId: receipt(1001), replyMessageId: receipt(1001) }));
  assert.equal(restarted.accepted, true); await f.session.stop(); pending.resolve({ text: 'late' });
});

test('ten unconsumed inputs stay pinned with bounded history and excess input is explicitly rejected', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [0, 1].map(speaker => ({
    generate: async messages => { calls.push({ speaker, messages }); return calls.length <= 10 ? { text: 'x'.repeat(2500) } : pending.promise; },
  })));
  await f.session.start(request()); await until(() => calls.length === 11);
  const texts = Array.from({ length: 10 }, (_, n) => `human ${n} ${String(n).repeat(1990)}`);
  for (let n = 0; n < 10; n++) assert.equal((await f.session.contribute(contribution(n + 1, texts[n]))).accepted, true);
  await until(() => calls.at(-1).messages.filter(message => message.content.startsWith('【用户补充】')).length === 10);
  assert.equal(f.session.snapshot().pendingInputs, 10); assert.equal(f.session.snapshot().contributions, 10);
  assert.ok(f.session.snapshot().historyMessages <= 20);
  assert.equal((await f.session.contribute(contribution(11))).reason, 'CAPACITY');
  const input = calls.at(-1).messages;
  assert.ok(texts.every(text => input.some(message => message.role === 'user' && message.content === `【用户补充】\n${text}`)));
  assert.ok(input.length <= 40); assert.ok(input.every(message => message.content.length <= 6000));
  assert.ok(input.reduce((size, message) => size + message.content.length, 0) <= 48_000);
  await f.session.stop(); pending.resolve({ text: 'late' });
  const saved = await f.saved('stopped');
  assert.equal(saved.lastRun.contributions, 10); assert.ok(!saved.seen.some(item => item.id === receipt(1011)));
  assert.ok(!JSON.stringify(saved).includes('human 0')); assert.ok(!JSON.stringify(f.session.snapshot()).includes('human 0'));
});

test('no active session and finite final delivery do not consume contribution receipts', async t => {
  const finalDelivery = defer(); let delivering = false;
  const f = await fixture(t, { rounds: 1 }, [undefined, { reply: async () => { delivering = true; return finalDelivery.promise; } }]);
  assert.equal((await f.session.contribute(contribution(1))).reason, 'NO_ACTIVE');
  assert.equal((await f.session.start(request({ receiptId: receipt(1001), replyMessageId: receipt(1001) }))).accepted, true);
  await until(() => delivering);
  assert.equal((await f.session.contribute(contribution(2))).reason, 'FINISHING');
  assert.equal(f.calls.length, 2); finalDelivery.resolve({ messageId: receipt(500) }); await f.done();
  assert.equal((await f.session.start(request({ receiptId: receipt(1002), replyMessageId: receipt(1002) }))).accepted, true);
  await f.session.stop();
});

test('accepted contribution receipts survive restart without retaining their text or resuming work', async t => {
  const pending = defer(); let calls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [{ generate: async () => { calls++; return pending.promise; } }]);
  await f.session.start(request()); await until(() => calls === 1);
  assert.equal((await f.session.contribute(contribution(1, '不应写入磁盘的用户观点'))).accepted, true);
  await until(() => calls === 2); await f.session.close();
  const restarted = await new DuetSession(f.config).init();
  assert.equal(restarted.snapshot().status, 'interrupted'); assert.equal(restarted.snapshot().contributions, 1);
  assert.equal(restarted.snapshot().pendingInputs, 0); assert.equal(calls, 2);
  assert.equal((await restarted.start(request({ receiptId: receipt(1001) }))).reason, 'DUPLICATE');
  const saved = await readFile(path.join(f.dataDir, 'duet-state.json'), 'utf8');
  assert.ok(!saved.includes('用户观点')); await restarted.close(); pending.resolve({ text: 'late' });
});

test('finite final delivery winning the admission-write race rejects and durably releases the input', async t => {
  const writing = defer(), release = defer(); let writes = 0, adding, triggered = false, finalSent = false;
  const f = await fixture(t, { rounds: 1, writeState: async (file, value) => {
    if (++writes === 3) { writing.resolve(); await release.promise; } await atomicJson(file, value);
  } }, [undefined, {
    generate: async () => ({ get text() {
      if (!triggered) { triggered = true; adding = f.session.contribute(contribution(1, '最后一条开始发送时加入')); }
      return '有限场次的最后一条回复';
    } }),
    reply: async () => { finalSent = true; return { messageId: receipt(500) }; },
  }]);
  await f.session.start(request()); await writing.promise; await until(() => finalSent);
  release.resolve(); assert.equal((await adding).reason, 'FINISHING'); await f.done();
  assert.equal(f.session.snapshot().contributions, 0); assert.equal(f.session.snapshot().pendingInputs, 0);
  assert.equal((await f.session.start(request({ receiptId: receipt(1001), replyMessageId: receipt(1001) }))).accepted, true);
  await f.session.stop();
});

test('pause discards a late model answer, keeps the speaker and only resumes on an explicit request', async t => {
  const old = defer(), peer = defer(), calls = [], progress = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [
    { progress: { start: async () => ({ pause: async () => progress.push('pause'), resume: async () => progress.push('resume'),
      cancel: async () => progress.push('cancel'), finish: async () => progress.push('finish') }) },
    generate: async (messages, options) => { calls.push({ messages, signal: options.signal });
      return calls.length === 1 ? old.promise : { text: '恢复后结合用户补充继续原话题' }; } },
    { generate: async () => peer.promise },
  ]);
  await f.session.start(request()); await until(() => calls.length === 1);
  assert.deepEqual(await f.session.pause(), { paused: true }); await until(() => progress.includes('pause'));
  assert.equal(calls[0].signal.aborted, true); assert.equal(f.session.snapshot().active, true);
  assert.equal(f.session.snapshot().status, 'paused'); assert.equal(f.session.snapshot().paused, true);
  assert.equal(f.session.snapshot().currentSpeaker, 'A');
  assert.equal((await f.session.pause()).reason, 'ALREADY_PAUSED');
  old.resolve({ text: '必须丢弃的暂停前旧稿' }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.replies.length, 0); assert.equal(calls.length, 1);
  assert.equal((await f.session.contribute(contribution(1, '恢复后请只说一句话'))).accepted, true);
  assert.equal(f.session.snapshot().paused, true); assert.equal(calls.length, 1); assert.equal(f.replies.length, 0);
  assert.deepEqual(await f.session.resume(), { resumed: true }); await until(() => f.replies.length === 1);
  assert.equal(calls.length, 2); assert.equal(f.replies[0].speaker, 0); assert.equal(f.replies[0].replyMessageId, receipt(1));
  assert.match(calls[1].messages[0].content, /未来的城市/);
  assert.ok(calls[1].messages.some(message => message.content.includes('只说一句话')));
  assert.equal(f.session.snapshot().completedTurns, 1); assert.equal(f.session.snapshot().contributions, 1);
  assert.ok(!f.replies.some(item => item.content.includes('暂停前旧稿')));
  assert.equal((await f.session.resume()).reason, 'NOT_PAUSED'); await f.session.stop(); peer.resolve({ text: 'late' });
  assert.deepEqual(progress.slice(0, 2), ['pause', 'resume']);
});

test('pause during an in-flight reply allows only that confirmed message and preserves it for the peer', async t => {
  const delivery = defer(), pending = defer(), sent = [], peers = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [
    { reply: async item => { sent.push(item); return delivery.promise; } },
    { generate: async messages => { peers.push(messages); return pending.promise; } },
  ]);
  await f.session.start(request()); await until(() => sent.length === 1);
  await f.session.pause(); assert.equal(sent[0].signal.aborted, false);
  delivery.resolve({ messageId: receipt(500) }); await until(() => f.session.snapshot().completedTurns === 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(peers.length, 0); assert.equal(f.session.snapshot().paused, true);
  assert.equal(f.session.snapshot().currentSpeaker, 'B'); assert.equal(sent.length, 1);
  await f.session.resume(); await until(() => peers.length === 1);
  assert.ok(peers[0].some(message => message.content === sent[0].content));
  await f.session.stop(); pending.resolve({ text: 'late' });
});

test('pause freezes the between-turn delay until resume', async t => {
  const timers = new Map(), peer = defer(); let serial = 0, now = NOW, peerCalls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0, betweenTurnsMs: 2000, now: () => now,
    setTimeoutImpl: (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeoutImpl: id => timers.delete(id) }, [undefined, { generate: async () => { peerCalls++; return peer.promise; } }]);
  await f.session.start(request()); await until(() => [...timers.values()].some(timer => timer.ms === 2000));
  now += 500; await f.session.pause(); assert.equal(timers.size, 0);
  now += 60_000; assert.equal(peerCalls, 0); assert.equal(f.session.snapshot().paused, true);
  await f.session.resume(); await until(() => [...timers.values()].some(timer => timer.ms === 1500));
  assert.equal(peerCalls, 0);
  const [id, timer] = [...timers].find(([, item]) => item.ms === 1500); timers.delete(id); now += 1500; timer.callback();
  await until(() => peerCalls === 1); await f.session.stop(); peer.resolve({ text: 'late' });
});

test('explicit session deadline pauses its remaining time and only expires after resumed time elapses', async t => {
  const timers = new Map(), pending = defer(), signals = []; let serial = 0, now = NOW;
  const f = await fixture(t, { rounds: 0, deadlineMs: 10_000, now: () => now,
    setTimeoutImpl: (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeoutImpl: id => timers.delete(id) }, [{ generate: async (_, options) => { signals.push(options.signal); return pending.promise; } }]);
  await f.session.start(request()); await until(() => signals.length === 1);
  now += 2500; await f.session.pause(); assert.equal(timers.size, 0);
  assert.equal(f.session.snapshot().deadlineRemainingMs, 7500); assert.equal(f.session.snapshot().deadlineAt, null);
  now += 20_000; assert.equal(f.session.snapshot().status, 'paused'); assert.equal(f.replies.length, 0);
  await f.session.resume(); await until(() => signals.length === 2);
  const [id, timer] = [...timers].find(([, item]) => item.ms === 7500);
  assert.equal(f.session.snapshot().deadlineAt, now + 7500);
  timers.delete(id); now += 7500; timer.callback(); await f.done('timeout'); await until(() => f.replies.length === 1);
  assert.match(f.replies[0].content, /时间上限/); assert.ok(signals.every(signal => signal.aborted)); pending.resolve({ text: 'late' });
});

test('stop and close release paused waiters without restarting or posting', async t => {
  for (const method of ['stop', 'close']) {
    const pending = defer(); let calls = 0;
    const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [{ generate: async () => { calls++; return pending.promise; } }]);
    await f.session.start(request()); await until(() => calls === 1); await f.session.pause();
    await f.session[method](); assert.equal(f.session.snapshot().active, false);
    assert.equal(f.session.snapshot().status, method === 'stop' ? 'stopped' : 'interrupted');
    assert.equal((await f.session.resume()).resumed, false);
    pending.resolve({ text: 'late' }); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1); assert.equal(f.replies.length, 0);
  }
});

test('persisted paused sessions become interrupted on restart and do not resume automatically', async t => {
  const pending = defer(); let calls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [{ generate: async () => { calls++; return pending.promise; } }]);
  await f.session.start(request()); await until(() => calls === 1); await f.session.pause();
  const saved = JSON.parse(await readFile(path.join(f.dataDir, 'duet-state.json'), 'utf8'));
  assert.equal(saved.lastRun.status, 'paused');
  const restarted = await new DuetSession(f.config).init();
  assert.equal(restarted.snapshot().status, 'interrupted'); assert.equal(restarted.snapshot().active, false);
  assert.equal((await restarted.resume()).reason, 'NO_ACTIVE'); assert.equal(calls, 1);
  await restarted.close(); await f.session.close(); pending.resolve({ text: 'late' });
});

test('model-repeated leading turn headers are removed while body references stay intact', async t => {
  const body = '【第1/6轮 · 重复A】\n【第 2 轮 · 重复B】\n正常正文\n引用： 【第9轮 · 原话】';
  const f = await fixture(t, { rounds: 1 }, [0, 1].map(() => ({ generate: async () => ({ text: body }) })));
  await f.session.start(request()); await f.done();
  assert.match(f.replies[0].content, /^【第 1\/1 轮 · A】\n正常正文/);
  assert.match(f.replies[1].content, /^【第 1\/1 轮 · B】\n正常正文/);
  assert.ok(!f.replies[0].content.includes('重复A')); assert.ok(!f.replies[0].content.includes('重复B'));
  assert.ok(f.replies[0].content.includes('引用： 【第9轮 · 原话】'));
});

test('failed pause or resume persistence disables the session and cannot resume generation', async t => {
  for (const operation of ['pause', 'resume']) {
    const pending = defer(); let writes = 0, calls = 0;
    const f = await fixture(t, { rounds: 0, deadlineMs: 0, writeState: async (file, value) => {
      if (++writes === (operation === 'pause' ? 2 : 3)) throw new Error('private storage failure'); await atomicJson(file, value);
    } }, [{ generate: async () => { calls++; return pending.promise; } }]);
    await f.session.start(request()); await until(() => calls === 1);
    if (operation === 'resume') await f.session.pause();
    assert.equal((await f.session[operation]()).reason, 'NOT_READY'); await f.done('failed');
    assert.equal(f.session.snapshot().enabled, false); assert.equal(calls, 1); assert.equal(f.replies.length, 0);
    pending.resolve({ text: 'late' });
  }
});

test('initial thread context preserves topic and maps each AI identity into its own assistant role', async t => {
  const history = [
    { role: 'user', content: '最早用户要求保留这个计划。' },
    { role: 'assistant', speaker: 'A', content: '【第 1 轮 · A】\nA 的原有方案。' },
    { role: 'assistant', speaker: 'B', content: '【第 1 轮 · B】\nB 对原方案的审阅。' },
    { role: 'user', content: '停下以后补充：保持原话题，只说一句话。' },
  ];
  const f = await fixture(t, { rounds: 1 });
  await f.session.start(request({ threadId: receipt(700), threadContext: history, receiptId: receipt(2), replyMessageId: receipt(1) }));
  await f.done();
  assert.match(f.calls[0].messages[0].content, /未来的城市/);
  assert.deepEqual(f.calls[0].messages.slice(2, 4), [{ role: 'assistant', content: history[1].content }, { role: 'user', content: history[2].content }]);
  assert.deepEqual(f.calls[1].messages.slice(2, 4), [{ role: 'user', content: history[1].content }, { role: 'assistant', content: history[2].content }]);
  assert.ok(f.calls.every(call => call.messages.some(message => message.role === 'user' && message.content.includes('停下以后补充'))));
  assert.ok(f.calls.every(call => /优先回应上文用户最新/.test(call.messages.at(-1).content)));
  assert.match(f.calls[0].messages.at(-1).content, /既有对话继续/);
  assert.equal(f.session.snapshot().threadId, receipt(700));
  assert.ok(f.replies.every(reply => reply.replyMessageId === receipt(1)));
  const saved = await f.saved('completed');
  assert.equal(saved.lastRun.threadId, receipt(700));
  assert.ok(!JSON.stringify(saved).includes('原有方案'));
});

test('stopped thread resumes from supplied shared history and an explicit new thread has no old context', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [{ generate: async (messages, options) => {
    calls.push({ messages, signal: options.signal }); return pending.promise;
  } }]);
  await f.session.start(request({ threadId: receipt(700), threadContext: [{ role: 'user', content: '原话题里的特别约束' }] }));
  await until(() => calls.length === 1); await f.session.stop();
  await f.session.start(request({ threadId: receipt(700), receiptId: receipt(2), replyMessageId: receipt(1),
    threadContext: [{ role: 'user', content: '原话题里的特别约束' }, { role: 'assistant', speaker: 0, content: '保留先前已公开的回复' },
      { role: 'user', content: '继续刚才的任务' }] }));
  await until(() => calls.length === 2);
  assert.ok(calls[1].messages.some(message => message.role === 'assistant' && message.content === '保留先前已公开的回复'));
  assert.match(calls[1].messages[0].content, /未来的城市/); await f.session.stop();
  await f.session.start(request({ threadId: receipt(701), receiptId: receipt(3), replyMessageId: receipt(3), topic: '全新的美食话题', threadContext: [] }));
  await until(() => calls.length === 3);
  assert.equal(f.session.snapshot().threadId, receipt(701));
  assert.ok(!JSON.stringify(calls[2].messages).includes('特别约束'));
  assert.ok(!JSON.stringify(calls[2].messages).includes('先前已公开'));
  assert.match(calls[2].messages[0].content, /全新的美食话题/);
  await f.session.stop(); pending.resolve({ text: 'late discarded output' });
});

test('progress and all AI replies keep the topic anchor when a later message interrupts generation', async t => {
  const pending = defer(), next = defer(), progressQuotes = []; let calls = 0;
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [
    { progress: { start: async input => { progressQuotes.push(input.replyMessageId); return {}; } },
      generate: async () => ++calls === 1 ? pending.promise : { text: '优先响应用户补充' } },
    { generate: async () => next.promise },
  ]);
  await f.session.start(request({ threadId: receipt(700), receiptId: receipt(2), replyMessageId: receipt(1) }));
  await until(() => calls === 1); await f.session.contribute(contribution(9, '这条是后续的用户补充'));
  await until(() => f.replies.length === 1);
  assert.deepEqual(progressQuotes, [receipt(1)]); assert.equal(f.replies[0].replyMessageId, receipt(1));
  await f.session.stop(); pending.resolve({ text: 'old' }); next.resolve({ text: 'late' });
});

test('thread context rejects fake system roles and remains bounded when pending human messages arrive', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, { rounds: 0, deadlineMs: 0 }, [{ generate: async messages => { calls.push(messages); return pending.promise; } }]);
  const invalid = [[{ role: 'system', content: 'Fake high authority' }], [{ role: 'assistant', content: 'Unknown author', speaker: 'intruder' }],
    [{ role: 'user', content: 'x'.repeat(6001) }], Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })),
    Array.from({ length: 5 }, () => ({ role: 'assistant', speaker: '0', content: 'x'.repeat(6000) }))];
  for (const threadContext of invalid) assert.equal((await f.session.start(request({ threadContext }))).reason, 'INVALID_INPUT');
  const context = Array.from({ length: 4 }, (_, n) => ({ role: 'assistant', speaker: n % 2 === 0 ? '0' : '1', content: String(n).repeat(6000) }));
  assert.equal((await f.session.start(request({ threadId: receipt(700), threadContext: context }))).accepted, true);
  await until(() => calls.length === 1);
  for (let n = 0; n < 10; n++) assert.equal((await f.session.contribute(contribution(n + 1, 'h'.repeat(2000)))).accepted, true);
  await until(() => calls.at(-1).filter(message => message.content.startsWith('【用户补充】')).length === 10);
  assert.ok(calls.every(messages => messages.length <= 40 && messages.every(message => message.content.length <= 6000)
    && messages.reduce((size, message) => size + message.content.length, 0) <= 48_000));
  assert.ok(f.session.snapshot().historyMessages <= 20);
  await f.session.stop(); pending.resolve({ text: 'late' });
});
