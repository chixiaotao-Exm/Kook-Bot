import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotificationQueue, QueueError } from '../src/queue.js';

const messageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const notification = (number = 1) => ({ key: number.toString(16).padStart(64, '0'), kind: 'push', title: 'A bounded GitHub update',
  lines: ['One safe public summary.'], theme: 'info', url: 'https://github.com/chixiaotao-Exm/Kook-Bot' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fails = expected => caught => caught instanceof QueueError && caught.code === expected;
const rateLimit = retryAfterMs => Object.assign(new Error('private remote body'), { code: 'RATE_LIMITED', delivery: 'rejected', retryAfterMs });
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-bridge-queue-'));
  let now = 1000000, nextId = 0;
  const timers = new Map(), sends = [];
  const dependencies = { dataDir, now: () => now, intervalMs: 10, retryFloorMs: 50,
    send: async value => { sends.push(value); return { messageId }; },
    setTimeoutImpl: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay, delay }); return id; },
    clearTimeoutImpl: id => timers.delete(id), ...options };
  const queue = new NotificationQueue(dependencies);
  await queue.init();
  t.after(async () => { await queue.close(); assert.equal(path.dirname(dataDir), tmpdir()); await rm(dataDir, { recursive: true, force: true }); });
  const advance = async ms => {
    now += ms;
    const due = [...timers].filter(([, timer]) => timer.at <= now);
    return Promise.all(due.map(([id, timer]) => { timers.delete(id); return timer.callback(); }));
  };
  return { queue, dataDir, dependencies, sends, timers, advance, setNow(value) { now = value; },
    file: path.join(dataDir, 'bridge-queue.json'), read: async () => JSON.parse(await readFile(path.join(dataDir, 'bridge-queue.json'), 'utf8')) };
}

test('enqueue acknowledges only a durable private journal and copies only normalized notifications', async t => {
  const entered = deferred(), release = deferred(); let writes = 0;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (++writes === 2) { entered.resolve(); await release.promise; }
    await save(file, value);
  } });
  const item = notification(); let acknowledged = false;
  const admission = f.queue.enqueue(item).then(value => { acknowledged = true; return value; });
  await entered.promise;
  assert.equal(acknowledged, false); assert.equal(f.queue.snapshot().queued, 0);
  item.title = 'caller changed this'; item.lines.push('late mutation');
  release.resolve(); assert.deepEqual(await admission, { accepted: true, duplicate: false });
  const record = (await f.read()).records[0];
  assert.equal(record.state, 'queued'); assert.equal(record.notification.title, notification().title);
  assert.deepEqual(record.notification.lines, notification().lines); assert.equal(f.sends.length, 0);
});

test('real journal replacements stay mode 0600 and terminal records retain no notification content', async t => {
  const f = await fixture(t); await f.queue.enqueue(notification());
  if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  f.queue.start(); await f.advance(0);
  const record = (await f.read()).records[0];
  assert.equal(record.state, 'sent'); assert.equal(record.messageId, messageId);
  assert.equal(record.notification, undefined); assert.equal(record.title, undefined);
  if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(f.queue.snapshot(), { queued: 0, sending: 0, sent: 1, rejected: 0, uncertain: 0, ready: true, pending: 0, lastError: null });
  assert.doesNotMatch(JSON.stringify(f.queue.snapshot()), /GitHub|summary|key|messageId/);
});

test('concurrent identical deliveries reserve one record, and duplicate statuses never resend', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.queue.enqueue(notification())));
  assert.equal(results.filter(result => result.accepted).length, 1);
  assert.equal(results.filter(result => result.duplicate).length, 9);
  f.queue.start(); await f.advance(0);
  assert.deepEqual(await f.queue.enqueue(notification()), { accepted: false, duplicate: true });
  await f.advance(1000); assert.equal(f.sends.length, 1);
});

test('worker persists sending before delivery and sends serially at the configured interval', async t => {
  const entered = deferred(), release = deferred(); let active = 0, maximum = 0, delivered = 0, f;
  f = await fixture(t, { send: async value => {
    active++; maximum = Math.max(maximum, active); delivered++;
    const record = (await f.read()).records.find(record => record.key === value.key);
    assert.equal(record.state, 'sending'); assert.equal(record.attempts, 1);
    if (delivered === 1) { entered.resolve(); await release.promise; }
    active--; return { messageId };
  } });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2));
  f.queue.start(); f.queue.start(); const first = f.advance(0); await entered.promise;
  assert.equal(f.queue.snapshot().sending, 1);
  assert.deepEqual(await f.queue.enqueue(notification(1)), { accepted: false, duplicate: true });
  assert.equal(delivered, 1); release.resolve(); await first;
  await f.advance(9); assert.equal(delivered, 1);
  await f.advance(1); assert.equal(delivered, 2); assert.equal(maximum, 1);
  assert.equal(f.queue.snapshot().sent, 2); assert.equal(f.timers.size, 1);
});

test('a crash-restored sending record becomes durably uncertain and is never replayed', async t => {
  const f = await fixture(t); await f.queue.enqueue(notification()); await f.queue.close();
  const state = await f.read(); Object.assign(state.records[0], { state: 'sending', attempts: 1, nextAttemptAt: null });
  await save(f.file, state);
  const recovered = new NotificationQueue(f.dependencies); t.after(() => recovered.close());
  await recovered.init(); assert.equal(recovered.snapshot().uncertain, 1);
  assert.equal((await f.read()).records[0].state, 'uncertain');
  assert.equal((await f.read()).records[0].notification, undefined);
  recovered.start(); await f.advance(0);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await recovered.enqueue(notification()), { accepted: false, duplicate: true });
});

test('only explicit rejected rate limits retry, respect deadlines and stop after three attempts', async t => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => { attempts++; throw rateLimit(70); } });
  await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0);
  assert.equal(attempts, 1); assert.equal(f.queue.snapshot().queued, 1);
  assert.equal((await f.read()).records[0].nextAttemptAt, 1000070);
  assert.ok([...f.timers.values()].every(timer => timer.delay <= 10), 'The retry deadline belongs in the journal, not a long timer');
  await f.advance(69); assert.equal(attempts, 1);
  await f.advance(10); assert.equal(attempts, 2);
  await f.advance(70); assert.equal(attempts, 3);
  assert.equal(f.queue.snapshot().rejected, 1); assert.equal(f.queue.snapshot().lastError, 'RATE_LIMITED');
  const record = (await f.read()).records[0]; assert.equal(record.attempts, 3); assert.equal(record.notification, undefined);
  await f.advance(10000); assert.equal(attempts, 3);
  assert.deepEqual(await f.queue.enqueue(notification()), { accepted: false, duplicate: true });
});

test('a rate limit pauses the sending identity, including other already queued notifications', async t => {
  const sent = [], f = await fixture(t, { send: async value => {
    sent.push(value.key); if (value.key === notification(1).key && sent.length === 1) throw rateLimit(0); return { messageId };
  } });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2)); f.queue.start(); await f.advance(0);
  assert.equal((await f.read()).records[0].nextAttemptAt, 1000050);
  assert.equal((await f.read()).nextSendAt, 1000050);
  await f.advance(10); assert.deepEqual(sent, [notification(1).key]);
  await f.advance(40); assert.deepEqual(sent, [notification(1).key, notification(1).key]);
  await f.advance(10); assert.deepEqual(sent, [notification(1).key, notification(1).key, notification(2).key]);
  assert.equal(f.queue.snapshot().sent, 2); assert.equal(f.queue.snapshot().lastError, null);
});

test('the production retry floor is at least fifteen seconds and untrusted delays are bounded', async t => {
  for (const [retryAfterMs, expected] of [[1, 15000], [999999999, 300000]]) {
    const f = await fixture(t, { retryFloorMs: undefined, send: async () => { throw rateLimit(retryAfterMs); } });
    await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0);
    assert.equal((await f.read()).records[0].nextAttemptAt, 1000000 + expected);
  }
});

test('a numeric 429 code with an explicit rejected delivery follows the same bounded retry contract', async t => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => {
    if (++attempts === 1) throw Object.assign(new Error('limited'), { code: 429, delivery: 'rejected', retryAfterMs: 20 });
    return { messageId };
  } });
  await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0);
  await f.advance(49); assert.equal(attempts, 1);
  await f.advance(10); assert.equal(attempts, 2); assert.equal(f.queue.snapshot().sent, 1);
});

test('an exhausted rate limit preserves its global cooldown across restart before the next notification', async t => {
  const sent = [];
  const f = await fixture(t, { send: async value => {
    sent.push(value.key); if (value.key === notification(1).key) throw rateLimit(50); return { messageId };
  } });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2)); f.queue.start();
  await f.advance(0); await f.advance(50); await f.advance(50);
  assert.equal(f.queue.snapshot().rejected, 1); assert.equal((await f.read()).nextSendAt, 1000150);
  await f.queue.close(); const recovered = new NotificationQueue(f.dependencies); t.after(() => recovered.close());
  await recovered.init(); recovered.start(); await f.advance(0); await f.advance(49);
  assert.deepEqual(sent, Array(3).fill(notification(1).key));
  await f.advance(10); assert.deepEqual(sent, [...Array(3).fill(notification(1).key), notification(2).key]);
  assert.equal(recovered.snapshot().sent, 1);
});

test('permanent rejections, uncertain errors and invalid confirmations never retry', async t => {
  const outcomes = [
    { thrown: { code: 'AUTH', delivery: 'rejected' }, state: 'rejected' },
    { thrown: { code: 'RATE_LIMITED', delivery: 'rejected' }, state: 'rejected' },
    { thrown: { code: 'RATE_LIMITED', delivery: 'rejected', retryAfterMs: NaN }, state: 'rejected' },
    { thrown: { code: 'RATE_LIMITED', delivery: 'uncertain', retryAfterMs: 100 }, state: 'uncertain' },
    { thrown: { code: 'NETWORK', delivery: 'uncertain' }, state: 'uncertain' },
    { thrown: { code: 503, delivery: 'uncertain' }, state: 'uncertain' },
    { thrown: new Error('private token body'), state: 'uncertain' },
    { result: {}, state: 'uncertain' }, { result: { messageId: 'not-confirmed' }, state: 'uncertain' },
    { result: { messageId: 'https://example.invalid/private' }, state: 'uncertain' },
  ];
  for (const outcome of outcomes) {
    let attempts = 0;
    const f = await fixture(t, { send: async () => { attempts++; if (outcome.thrown) throw outcome.thrown; return outcome.result; } });
    await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0); await f.advance(1000000);
    assert.equal(attempts, 1); assert.equal(f.queue.snapshot()[outcome.state], 1);
    assert.deepEqual(await f.queue.enqueue(notification()), { accepted: false, duplicate: true });
    assert.doesNotMatch(JSON.stringify(f.queue.snapshot()) + await readFile(f.file, 'utf8'), /private|example\.invalid/);
  }
});

test('rate-limit retry records survive restart with their original deadline and attempt count', async t => {
  const f = await fixture(t, { send: async () => { throw rateLimit(80); } });
  await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0); await f.queue.close();
  let attempts = 0;
  const recovered = new NotificationQueue({ ...f.dependencies, send: async () => { attempts++; return { messageId }; } }); t.after(() => recovered.close());
  await recovered.init(); recovered.start(); await f.advance(0); assert.equal(attempts, 0);
  await f.advance(80); assert.equal(attempts, 1); assert.equal(recovered.snapshot().sent, 1);
  assert.equal((await f.read()).records[0].attempts, 2);
});

test('journal write failure before admission or sending fails closed without a send', async t => {
  for (const failedWrite of [2, 3]) {
    let writes = 0, sends = 0;
    const f = await fixture(t, { writeState: async (file, value) => { if (++writes === failedWrite) throw new Error('private disk path'); await save(file, value); },
      send: async () => { sends++; return { messageId }; } });
    if (failedWrite === 2) await assert.rejects(f.queue.enqueue(notification()), fails('STORAGE'));
    else { await f.queue.enqueue(notification()); f.queue.start(); await f.advance(0); }
    assert.equal(sends, 0); assert.equal(f.queue.snapshot().lastError, 'STORAGE'); assert.equal(f.timers.size, 0);
    await assert.rejects(f.queue.enqueue(notification(2)), fails('STORAGE'));
    assert.throws(() => f.queue.start(), fails('STORAGE'));
  }
});

test('failure to save a confirmed send leaves a sending journal and cannot deliver another record', async t => {
  let writes = 0, sends = 0;
  const f = await fixture(t, { writeState: async (file, value) => { if (++writes === 5) throw new Error('disk full'); await save(file, value); },
    send: async () => { sends++; return { messageId }; } });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2)); f.queue.start(); await f.advance(0);
  assert.equal(sends, 1); assert.equal(f.queue.snapshot().uncertain, 1); assert.equal(f.queue.snapshot().queued, 1);
  assert.equal(f.queue.snapshot().lastError, 'STORAGE'); assert.equal((await f.read()).records[0].state, 'sending');
  assert.equal(f.timers.size, 0); await assert.rejects(f.queue.enqueue(notification(1)), fails('STORAGE'));
  await f.queue.close();
  const recovered = new NotificationQueue({ ...f.dependencies, writeState: save }); t.after(() => recovered.close());
  await recovered.init(); assert.equal(recovered.snapshot().uncertain, 1);
  recovered.start(); await f.advance(0); assert.equal(sends, 2); assert.equal(recovered.snapshot().sent, 1);
});

test('an admission write failure while a send is active prevents later completion from reopening the queue', async t => {
  const entered = deferred(), release = deferred(); let writes = 0, sends = 0;
  const f = await fixture(t, { writeState: async (file, value) => { if (++writes === 4) throw new Error('disk failed'); await save(file, value); },
    send: async () => { sends++; entered.resolve(); return release.promise; } });
  await f.queue.enqueue(notification(1)); f.queue.start(); const work = f.advance(0); await entered.promise;
  await assert.rejects(f.queue.enqueue(notification(2)), fails('STORAGE'));
  release.resolve({ messageId }); await work;
  assert.equal(sends, 1); assert.equal(f.queue.snapshot().uncertain, 1); assert.equal(f.queue.snapshot().lastError, 'STORAGE');
  assert.equal(f.timers.size, 0); assert.equal((await f.read()).records[0].state, 'sending');
  assert.equal((await f.read()).records.length, 1); await assert.rejects(f.queue.enqueue(notification(1)), fails('STORAGE'));
});

test('corrupt or malformed journals remain untouched and cannot silently start as an empty queue', async t => {
  const f = await fixture(t); await f.queue.enqueue(notification()); await f.queue.close();
  const valid = await f.read(), record = valid.records[0];
  const invalid = ['{broken', JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [record, record] }),
    JSON.stringify({ version: 1, records: [{ ...record, state: 'sent', nextAttemptAt: null, attempts: 1 }] }),
    JSON.stringify({ version: 1, records: [{ ...record, notification: { ...record.notification, rawWebhook: {} } }] })];
  for (const contents of invalid) {
    await writeFile(f.file, contents); const broken = new NotificationQueue(f.dependencies);
    await assert.rejects(broken.init(), fails('STORAGE')); await assert.rejects(broken.enqueue(notification(2)), fails('STORAGE'));
    assert.throws(() => broken.start(), fails('STORAGE')); assert.equal(await readFile(f.file, 'utf8'), contents);
    await broken.close();
  }
  assert.equal(f.sends.length, 0);
});

test('failed startup repair of an interrupted send keeps the original journal and refuses work', async t => {
  const f = await fixture(t); await f.queue.enqueue(notification()); await f.queue.close();
  const state = await f.read(); Object.assign(state.records[0], { state: 'sending', attempts: 1, nextAttemptAt: null });
  await save(f.file, state); const original = await readFile(f.file, 'utf8');
  const broken = new NotificationQueue({ ...f.dependencies, writeState: async () => { throw new Error('disk'); } });
  await assert.rejects(broken.init(), fails('STORAGE')); assert.equal(await readFile(f.file, 'utf8'), original);
  assert.throws(() => broken.start(), fails('STORAGE')); await broken.close();
});

test('capacity never evicts pending or retained terminal deliveries, and expired terminals free space', async t => {
  const f = await fixture(t, { maxRecords: 2, retentionMs: 100 });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2));
  await assert.rejects(f.queue.enqueue(notification(3)), caught => caught.code === 'CAPACITY' && caught.statusCode === 503);
  assert.equal((await f.read()).records.length, 2);
  f.queue.start(); await f.advance(0); await f.advance(10);
  await assert.rejects(f.queue.enqueue(notification(3)), fails('CAPACITY'));
  f.setNow(1000105); assert.deepEqual(await f.queue.enqueue(notification(3)), { accepted: true, duplicate: false });
  const records = (await f.read()).records;
  assert.deepEqual(records.map(record => record.key), [notification(2).key, notification(3).key]);
  assert.deepEqual(await f.queue.enqueue(notification(2)), { accepted: false, duplicate: true });
  f.setNow(1000100000); await f.queue.enqueue(notification(4));
  assert.equal((await f.read()).records.some(record => record.key === notification(3).key && record.state === 'queued'), true);
});

test('invalid notifications and failed external validation are rejected before journal writes', async t => {
  let writes = 0;
  const f = await fixture(t, { validate: value => value.kind === 'push', writeState: async (file, value) => { writes++; await save(file, value); } });
  for (const value of [null, { ...notification(), key: 'wrong' }, { ...notification(), rawWebhook: {} },
    { ...notification(), kind: 'pr' }, { ...notification(), title: 'x'.repeat(101) }, { ...notification(), lines: ['x'.repeat(501)] },
    { ...notification(), lines: Array(9).fill('x') }, { ...notification(), url: 'https://elsewhere.invalid/' },
    { ...notification(), url: notification().url + '?private=value' }, { ...notification(), title: '\ud800' }]) {
    await assert.rejects(f.queue.enqueue(value), fails('INVALID_NOTIFICATION'));
  }
  assert.equal(writes, 1); assert.equal(f.queue.snapshot().queued, 0);
});

test('close stops admission, drains only the active bounded send, and does not start queued work', async t => {
  const entered = deferred(), release = deferred(); let sends = 0;
  const f = await fixture(t, { send: async () => { sends++; entered.resolve(); return release.promise; } });
  await f.queue.enqueue(notification(1)); await f.queue.enqueue(notification(2)); f.queue.start();
  const working = f.advance(0); await entered.promise; let closed = false;
  const closing = f.queue.close().then(() => { closed = true; });
  await assert.rejects(f.queue.enqueue(notification(3)), fails('CLOSED')); assert.equal(closed, false);
  release.resolve({ messageId }); await working; await closing;
  assert.equal(sends, 1); assert.equal(f.queue.snapshot().sent, 1); assert.equal(f.queue.snapshot().queued, 1);
  assert.equal(f.timers.size, 0); await f.advance(10000); assert.equal(sends, 1);
});

test('send deadline bounds shutdown even when sender ignores abort and late success cannot change uncertainty', async t => {
  const entered = deferred(), late = deferred(); let signal;
  const f = await fixture(t, { sendTimeoutMs: 100, send: async (_notification, options) => { signal = options.signal; entered.resolve(); return late.promise; } });
  await f.queue.enqueue(notification()); f.queue.start(); const working = f.advance(0); await entered.promise;
  const closing = f.queue.close(); await f.advance(100); await working; await closing;
  assert.equal(signal.aborted, true); assert.equal(f.queue.snapshot().uncertain, 1); assert.equal(f.queue.snapshot().lastError, 'SEND_TIMEOUT');
  assert.equal(f.timers.size, 0); late.resolve({ messageId }); await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.read()).records[0].state, 'uncertain');
});

test('closing during the pre-send write returns the unsent record to queued without spending an attempt', async t => {
  const entered = deferred(), release = deferred(); let writes = 0;
  const f = await fixture(t, { writeState: async (file, value) => {
    if (++writes === 3) { entered.resolve(); await release.promise; }
    await save(file, value);
  } });
  await f.queue.enqueue(notification()); f.queue.start(); const working = f.advance(0); await entered.promise;
  const closing = f.queue.close(); release.resolve(); await working; await closing;
  const record = (await f.read()).records[0];
  assert.equal(f.sends.length, 0); assert.equal(record.state, 'queued'); assert.equal(record.attempts, 0); assert.equal(f.timers.size, 0);
});

test('pending admissions are bounded and a hung write times out, releases close, and fails closed after late completion', async t => {
  const entered = deferred(), late = deferred(), lateDone = deferred(); let writes = 0, signal;
  const f = await fixture(t, { maxPending: 2, writeTimeoutMs: 80, writeState: async (file, value, options) => {
    writes++; if (writes === 2) { signal = options.signal; entered.resolve(); await late.promise; }
    await save(file, value); if (writes === 2) lateDone.resolve();
  } });
  const first = assert.rejects(f.queue.enqueue(notification(1)), fails('STORAGE'));
  await entered.promise;
  const second = assert.rejects(f.queue.enqueue(notification(2)), fails('CLOSED'));
  await assert.rejects(f.queue.enqueue(notification(3)), fails('CAPACITY'));
  assert.equal(f.queue.snapshot().pending, 2); const closing = f.queue.close();
  await f.advance(80); await Promise.all([first, second, closing]);
  assert.equal(signal.aborted, true); assert.equal(f.queue.snapshot().pending, 0);
  assert.equal(f.queue.snapshot().ready, false); assert.equal(f.queue.snapshot().lastError, 'STORAGE');
  late.resolve(); await lateDone.promise;
  assert.equal(f.queue.snapshot().queued, 0); assert.equal(f.sends.length, 0);
  await assert.rejects(f.queue.enqueue(notification(4)), fails('CLOSED'));
});

test('write timeout during send claim starts no send, and a late write never restores queue readiness', async t => {
  const entered = deferred(), late = deferred(), lateDone = deferred(); let writes = 0;
  const f = await fixture(t, { writeTimeoutMs: 60, writeState: async (file, value) => {
    if (++writes === 3) { entered.resolve(); await late.promise; }
    await save(file, value); if (writes === 3) lateDone.resolve();
  } });
  await f.queue.enqueue(notification()); f.queue.start(); const working = f.advance(0); await entered.promise;
  await f.advance(60); await working;
  assert.equal(f.queue.snapshot().ready, false); assert.equal(f.queue.snapshot().lastError, 'STORAGE'); assert.equal(f.sends.length, 0);
  late.resolve(); await lateDone.promise;
  await assert.rejects(f.queue.enqueue(notification(2)), fails('STORAGE'));
  assert.throws(() => f.queue.start(), fails('STORAGE')); assert.equal(f.sends.length, 0);
});
