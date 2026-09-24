import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/storage.js';
import { ReportScheduler, REPORT_INTERVAL_MS } from '../src/report-scheduler.js';

const BASE = Date.parse('2026-09-24T02:00:00Z');
const id = '12345678-1234-1234-1234-123456789abc';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ startAt = BASE + 5 * 60000, send, store } = {}) {
  let now = startAt, sequence = 0; const timers = new Map(), sent = [];
  store ||= new StateStore({ dataDir: 'unused', writeState: async () => {} });
  const options = { store, now: () => now, getSnapshot: () => ({ hosts: [], monitors: [] }),
    send: send || (async message => { sent.push(message); return { messageId: id }; }), deliveryTimeoutMs: 25,
    setTimeoutImpl: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeoutImpl: key => timers.delete(key) };
  const scheduler = new ReportScheduler(options);
  return { store, scheduler, options, sent, timers, setNow: value => { now = value; } };
}

test('first installation waits for the next half hour and sends both categories once at the boundary', async () => {
  const f = fixture(); await f.scheduler.start();
  assert.equal(f.sent.length, 0); assert.equal(f.scheduler.snapshot().nextRunAt, '2026-09-24T02:30:00.000Z');
  assert.equal(f.timers.size, 1);
  f.setNow(BASE + REPORT_INTERVAL_MS - 1); await f.scheduler.run(); assert.equal(f.sent.length, 0);
  f.setNow(BASE + REPORT_INTERVAL_MS); await Promise.all([f.scheduler.run(), f.scheduler.run(), f.scheduler.run()]);
  assert.deepEqual(f.sent.map(item => item.category).sort(), ['infra', 'web']);
  assert.ok(Object.values(f.scheduler.snapshot().channels).every(item => item.status === 'sent'));
  await f.scheduler.run(); assert.equal(f.sent.length, 2);
  f.setNow(BASE + 2 * REPORT_INTERVAL_MS); await f.scheduler.run(); assert.equal(f.sent.length, 4);
  await f.scheduler.close(); assert.equal(f.timers.size, 0);
});

test('timer callback actually dispatches at the next slot and re-arms one timer', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS);
  const timer = [...f.timers.values()][0]; f.timers.clear(); timer.callback();
  for (let index = 0; index < 10 && f.sent.length < 2; index++) await turn();
  await f.scheduler.inFlight; await turn(); assert.equal(f.sent.length, 2); assert.equal(f.timers.size, 1);
  await f.scheduler.close();
});

test('a hung infrastructure delivery does not block website delivery and neither is retried within the slot', async () => {
  const attempts = []; const f = fixture({ send: message => { attempts.push(message.category); return message.category === 'infra' ? new Promise(() => {}) : Promise.resolve({ messageId: id }); } });
  await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS); await f.scheduler.run();
  assert.deepEqual(attempts.sort(), ['infra', 'web']);
  assert.equal(f.scheduler.snapshot().channels.infra.status, 'uncertain'); assert.equal(f.scheduler.snapshot().channels.web.status, 'sent');
  assert.match(f.scheduler.snapshot().lastError, /未确认/);
  await f.scheduler.run(); assert.equal(attempts.length, 2); await f.scheduler.close();
});

test('persisted delivery records suppress duplicates after restart, including a send interrupted by a crash', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ops-reports-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = await new StateStore({ dataDir }).init(); const f = fixture({ store });
  await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS); await f.scheduler.run(); await f.scheduler.close();
  await store.transaction(draft => { draft.reports.channels.infra.status = 'sending'; });
  const reopened = await new StateStore({ dataDir }).init();
  const resumed = fixture({ store: reopened, startAt: BASE + REPORT_INTERVAL_MS + 1000 }); await resumed.scheduler.start();
  assert.equal(resumed.sent.length, 0); assert.equal(resumed.scheduler.snapshot().channels.infra.status, 'uncertain');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'ops-state.json'), 'utf8')).reports.channels.infra.status, 'uncertain');
  resumed.setNow(BASE + 2 * REPORT_INTERVAL_MS); await resumed.scheduler.run(); assert.equal(resumed.sent.length, 2); await resumed.scheduler.close();
});

test('restart resumes only unattempted pending categories in the current two-minute window', async () => {
  const f = fixture(); await f.scheduler.start(); await f.scheduler.close();
  await f.store.transaction(draft => {
    draft.reports.lastRunAt = new Date(BASE + REPORT_INTERVAL_MS).toISOString(); draft.reports.nextRunAt = new Date(BASE + 2 * REPORT_INTERVAL_MS).toISOString();
    draft.reports.channels = { infra: { slotAt: draft.reports.lastRunAt, status: 'sent' }, web: { slotAt: draft.reports.lastRunAt, status: 'pending' } };
  });
  const resumed = fixture({ store: f.store, startAt: BASE + REPORT_INTERVAL_MS + 60000 }); await resumed.scheduler.start();
  assert.deepEqual(resumed.sent.map(value => value.category), ['web']); await resumed.scheduler.close();
});

test('missed periods do not create backlog and only the timely current period may send', async () => {
  const f = fixture(); await f.scheduler.start();
  f.setNow(BASE + 2 * REPORT_INTERVAL_MS + 60000); await f.scheduler.run(); assert.equal(f.sent.length, 2);
  assert.equal(f.scheduler.snapshot().lastRunAt, '2026-09-24T03:00:00.000Z');
  f.setNow(BASE + 4 * REPORT_INTERVAL_MS + 10 * 60000); await f.scheduler.run(); assert.equal(f.sent.length, 2);
  assert.equal(f.scheduler.snapshot().nextRunAt, '2026-09-24T04:30:00.000Z');
  f.setNow(BASE + 5 * REPORT_INTERVAL_MS); await f.scheduler.run(); assert.equal(f.sent.length, 4); await f.scheduler.close();
});

test('a backwards clock cannot replay an already attempted half-hour', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS); await f.scheduler.run();
  f.setNow(BASE); await f.scheduler.run(); f.setNow(BASE + REPORT_INTERVAL_MS + 1000); await f.scheduler.run();
  assert.equal(f.sent.length, 2); await f.scheduler.close();
});

test('send only begins after durable claim; a claim queued past its window is skipped', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS);
  let release, claims = 0;
  f.store.writeState = draft => {
    if (draft.reports.channels.infra?.status === 'sending' && claims++ === 0) return new Promise(resolve => { release = resolve; });
    return Promise.resolve();
  };
  const pending = f.scheduler.run();
  for (let index = 0; index < 10 && !release; index++) await turn();
  assert.ok(release); assert.equal(f.sent.length, 0);
  f.setNow(BASE + REPORT_INTERVAL_MS + 120001); release(); await pending;
  assert.equal(f.sent.length, 0); assert.ok(Object.values(f.scheduler.snapshot().channels).every(entry => entry.status === 'skipped'));
  await f.scheduler.close();
});

test('close during a claim or during a hanging send prevents new POSTs and removes timers', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS);
  let release;
  f.store.writeState = draft => !release && draft.reports.channels.infra?.status === 'sending' ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const pending = f.scheduler.run(); for (let index = 0; index < 10 && !release; index++) await turn();
  const closed = f.scheduler.close(); release(); await Promise.all([pending, closed]); assert.equal(f.sent.length, 0); assert.equal(f.timers.size, 0);
  const started = []; const g = fixture({ send: (message, { signal }) => { started.push({ category: message.category, signal }); return new Promise(() => {}); } });
  await g.scheduler.start(); g.setNow(BASE + REPORT_INTERVAL_MS); const sending = g.scheduler.run();
  for (let index = 0; index < 10 && started.length < 2; index++) await turn();
  await g.scheduler.close(); await sending; assert.ok(started.every(value => value.signal.aborted));
  const count = started.length; await g.scheduler.run(); assert.equal(started.length, count);
});

test('failed persistence cannot send, and malformed old schedule does not reset its delivery history', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS);
  f.store.writeState = async () => { throw new Error('disk'); }; await f.scheduler.run(); assert.equal(f.sent.length, 0); assert.equal(f.store.failed, true); await f.scheduler.close();
  const g = fixture(); g.store.data.reports = { nextRunAt: 'bad', channels: {} }; await g.scheduler.start();
  assert.equal(g.scheduler.running, false); assert.equal(g.store.data.reports.nextRunAt, 'bad'); assert.match(g.scheduler.snapshot().lastError, /无法恢复/); assert.equal(g.timers.size, 0); await g.scheduler.close();
});

test('storage failure disarms the scheduler instead of creating a one-millisecond loop', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS); f.store.failed = true;
  await f.scheduler.run(); f.scheduler.arm();
  assert.equal(f.timers.size, 0); assert.equal(f.scheduler.running, false); assert.equal(f.scheduler.snapshot().enabled, false); assert.match(f.scheduler.snapshot().lastError, /已暂停/);
  await f.scheduler.close();
});

test('transient queue contention backs off and a later successful cycle clears the transient error', async () => {
  const f = fixture(); await f.scheduler.start(); f.setNow(BASE + REPORT_INTERVAL_MS); f.store.pending = 32;
  await f.scheduler.run(); f.scheduler.arm();
  assert.equal([...f.timers.values()][0].delay, 60000); assert.ok(f.scheduler.snapshot().lastError);
  f.store.pending = 0; await f.scheduler.run(); assert.equal(f.sent.length, 2); assert.equal(f.scheduler.snapshot().lastError, null); await f.scheduler.close();
});

test('inconsistent schedule watermarks are rejected without resetting or sending', async () => {
  for (const mutate of [value => { value.intervalMinutes = 15; }, value => { value.nextRunAt = value.lastRunAt; },
    value => { value.channels.web.slotAt = '2026-09-24T01:30:00.000Z'; }, value => { value.nextRunAt = '2026-09-24 03:00'; }]) {
    const f = fixture(); f.store.data.reports = { intervalMinutes: 30, nextRunAt: '2026-09-24T03:00:00.000Z', lastRunAt: '2026-09-24T02:30:00.000Z',
      channels: { infra: { slotAt: '2026-09-24T02:30:00.000Z', status: 'sent' }, web: { slotAt: '2026-09-24T02:30:00.000Z', status: 'pending' } } };
    mutate(f.store.data.reports); const before = structuredClone(f.store.data.reports); await f.scheduler.start();
    assert.equal(f.scheduler.running, false); assert.deepEqual(f.store.data.reports, before); assert.equal(f.sent.length, 0); await f.scheduler.close();
  }
});

test('no configured sender creates neither automatic jobs nor timers', async () => {
  const f = fixture(); const scheduler = new ReportScheduler({ ...f.options, send: null });
  await scheduler.start(); assert.equal(scheduler.snapshot().enabled, false); assert.equal(f.store.data.reports, undefined); assert.equal(f.timers.size, 0); await scheduler.close();
});
