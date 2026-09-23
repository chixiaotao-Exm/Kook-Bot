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
  const config = { participants, channelId: CHANNEL, dataDir, betweenTurnsMs: 0, now: () => NOW,
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
  for (const bad of [{ topic: '' }, { topic: 'x'.repeat(2001) }, { rounds: 7 }, { rounds: 0 }, { userId: 'bad' }, { receiptId: '--bad--' }])
    assert.equal((await f.session.start(request(bad))).reason, 'INVALID_INPUT');
  await f.session.start(request()); await until(() => Boolean(signal)); await f.session.close();
  assert.equal(signal.aborted, true); assert.equal(f.session.snapshot().enabled, false); assert.equal(f.session.snapshot().status, 'interrupted');
  pending.resolve({ text: 'late' }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.replies.length, 0);
});
