import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActiveQuotaSchedule } from '../src/active-quota-schedule.js';

const START = Date.parse('2026-09-22T00:05:00Z');
const HALF_HOUR = 1800000;
const account = (id, overrides = {}) => ({ id, platform: 'openai', type: 'oauth', status: 'active', schedulable: true,
  extra: { auto_reset_credit_enabled: false }, ...overrides });
const record = (id, time = START, overrides = {}) => ({ accountId: String(id), queriedAt: new Date(time).toISOString(), observedAt: new Date(time).toISOString(),
  cachePersisted: true, usage: { primary: { usedPercent: 25, windowMinutes: 300, resetAt: '2026-09-22T05:00:00Z', resetAfterSeconds: 17700 },
    secondary: null, resetCredits: { availableCount: 1, expiresAt: ['2026-10-01T00:00:00Z'] } }, planType: 'pro', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'quota-active-schedule-'));
  let timestamp = START;
  const queried = [];
  const factory = overrides => new ActiveQuotaSchedule({ dataDir, now: () => timestamp, listAccounts: async () => [account(1)],
    queryAccount: async id => { queried.push(id); return record(id, timestamp); }, ...options, ...overrides });
  const schedule = await factory().init();
  const schedules = [schedule];
  t.after(async () => { await Promise.all(schedules.map(item => item.close())); await rm(dataDir, { recursive: true, force: true }); });
  return { schedule, queried, dataDir, at: value => { timestamp = typeof value === 'number' ? value : Date.parse(value); },
    restart: async overrides => { await schedule.close(); const next = await factory(overrides).init(); schedules.push(next); return next; } };
}

test('claims current half-hour before querying and refreshes only at the next 00/30 slot', async t => {
  let file;
  const { schedule, dataDir, at, queried } = await fixture(t, { queryAccount: async id => {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.lastCycle.status, 'running');
    queried.push(id); return record(id);
  } });
  file = join(dataDir, 'active-quota.json');
  const first = await schedule.ensureCurrent();
  assert.equal(first.running, false);
  assert.equal(first.successCount, 1);
  assert.equal(first.nextRunAt, '2026-09-22T00:30:00.000Z');
  await schedule.run();
  at('2026-09-22T00:29:59Z'); await schedule.ensureCurrent();
  assert.equal(queried.length, 1);
  at('2026-09-22T00:30:00Z'); await schedule.ensureCurrent();
  assert.equal(queried.length, 2);
});

test('restart never repeats a completed or interrupted slot and does not replay missed slots', async t => {
  const { schedule, queried, at, restart, dataDir } = await fixture(t);
  await schedule.run();
  const saved = JSON.parse(await readFile(join(dataDir, 'active-quota.json'), 'utf8'));
  saved.lastCycle.status = 'running'; saved.lastCycle.finishedAt = null;
  saved.lastCycle.accounts[0].status = 'pending';
  await writeFile(join(dataDir, 'active-quota.json'), JSON.stringify(saved));
  const next = await restart();
  await next.run();
  assert.equal(queried.length, 1);
  assert.match(next.snapshot().lastError, /被中断/);
  at('2026-09-22T03:42:00Z');
  await next.ensureCurrent();
  assert.equal(queried.length, 2);
  assert.equal(next.snapshot().nextRunAt, '2026-09-22T04:00:00.000Z');
  at('2026-09-22T03:15:00Z'); await next.ensureCurrent();
  assert.equal(queried.length, 2);
});

test('concurrent broadcast and timer work share one cycle with no more than two active requests', async t => {
  const gate = deferred(); let active = 0, peak = 0, listCalls = 0;
  const { schedule, queried } = await fixture(t, {
    listAccounts: async () => { listCalls++; return [1, 2, 3, 4, 5].map(id => account(id)); },
    queryAccount: async id => { active++; peak = Math.max(peak, active); queried.push(id); await gate.promise; active--; return record(id); },
  });
  const tasks = [schedule.run(), schedule.ensureCurrent(), schedule.run()];
  while (queried.length < 2) await turn();
  assert.equal(schedule.snapshot().running, true);
  assert.equal(queried.length, 2);
  gate.resolve();
  await Promise.all(tasks);
  assert.equal(listCalls, 1); assert.equal(peak, 2); assert.equal(queried.length, 5);
  assert.equal(schedule.snapshot().successCount, 5);
});

test('only active root OpenAI OAuth accounts with automatic use explicitly false or absent are queried', async t => {
  const { schedule, queried } = await fixture(t, { listAccounts: async () => [
    account(1), account(2, { schedulable: false, extra: {} }), account(3, { platform: 'anthropic' }), account(4, { type: 'apikey' }),
    account(5, { status: 'disabled' }), account(6, { parent_account_id: 1 }), account(7, { quota_dimension: 'codex' }),
    account(8, { is_shadow: true }), account(9, { deleted_at: '2026-09-01T00:00:00Z' }),
    account(10, { extra: { auto_reset_credit_enabled: true } }), account(11, { extra: { auto_reset_credit_enabled: 'false' } }),
    account(12, { extra: { auto_reset_credit_enabled: 0 } }), account(13, { extra: { auto_reset_credit_enabled: null } }),
    account(14, { extra: 'PRIVATE_BAD_EXTRA' }), account(15, { extra: null }), account(15), account('bad-id'), null,
  ] });
  await schedule.run();
  assert.deepEqual(queried, ['1', '2', '15']);
  assert.equal(schedule.snapshot().successCount, 3);
  assert.equal(schedule.snapshot().skippedCount, 12);
  assert.doesNotMatch(JSON.stringify(schedule.snapshot()), /PRIVATE_BAD_EXTRA/);
});

test('source fresh guards become skips, failed requests preserve old observations without exposing raw errors', async t => {
  let phase = 0;
  const { schedule, at } = await fixture(t, { listAccounts: async () => [1, 2, 3].map(id => account(id)), queryAccount: async id => {
    if (phase === 0) return record(id);
    if (id === '1') throw Object.assign(new Error('Bearer PRIVATE_RAW_SECRET'), { code: 'AUTO_RESET' });
    if (id === '2') throw new Error('https://private.test/?token=PRIVATE_TOKEN');
    return record(id, START + HALF_HOUR);
  } });
  await schedule.run(); phase++;
  at(START + HALF_HOUR); await schedule.run();
  const status = schedule.snapshot();
  assert.equal(status.skippedCount, 1); assert.equal(status.failedCount, 1); assert.equal(status.successCount, 1);
  assert.equal(schedule.record(2).observedAt, new Date(START).toISOString());
  assert.equal(schedule.record(3).observedAt, new Date(START + HALF_HOUR).toISOString());
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|Bearer|https:/);
  const [raw] = schedule.apply([account(2)]);
  assert.equal(raw.extra.dashboard_active_quota.status, 'failed');
  assert.match(raw.extra.dashboard_active_quota.error, /保留上次数据/);
  assert.equal(raw.extra.codex_active_quota_stale, true);
});

test('cache and public metadata keep only whitelisted fields and callers cannot mutate saved records', async t => {
  const { schedule, dataDir, restart } = await fixture(t, { listAccounts: async () => [account(1, { name: 'PRIVATE_ACCOUNT', credentials: { token: 'PRIVATE_ACCOUNT_TOKEN' } })],
    queryAccount: async id => ({ ...record(id), credentials: { token: 'PRIVATE_QUERY_TOKEN' }, raw: 'PRIVATE_RAW',
      usage: { ...record(id).usage, token: 'PRIVATE_USAGE_TOKEN' } }) });
  await schedule.run();
  const disk = await readFile(join(dataDir, 'active-quota.json'), 'utf8');
  assert.doesNotMatch(disk + JSON.stringify(schedule.snapshot()), /PRIVATE_|credentials/);
  const copy = schedule.record(1); copy.usage.primary.usedPercent = 99;
  const records = schedule.records; records['1'].usage.primary.usedPercent = 88;
  assert.equal(schedule.record(1).usage.primary.usedPercent, 25);
  const saved = JSON.parse(disk);
  saved.recordsById['1'].credentials = { token: 'PRIVATE_CACHE_TOKEN' };
  saved.recordsById['2'] = { ...record(3), unknown: 'PRIVATE_MISMATCH' };
  saved.lastCycle.accounts[0].error = 'PRIVATE_PERSISTED_ERROR';
  await writeFile(join(dataDir, 'active-quota.json'), JSON.stringify(saved));
  const next = await restart();
  assert.equal(next.record(2), null);
  assert.doesNotMatch(JSON.stringify(next.records) + JSON.stringify(next.snapshot()), /PRIVATE_|credentials/);
});

test('overlay uses newer observations, leaves input unchanged, and metadata remains fixed', async t => {
  const { schedule } = await fixture(t);
  await schedule.run();
  const raw = account(1, { extra: { codex_primary_used_percent: 5, codex_usage_updated_at: '2026-09-22T00:15:00Z', credentials: 'private-existing' } });
  const [applied] = schedule.apply([raw]);
  assert.equal(applied.extra.codex_primary_used_percent, 5);
  assert.equal(raw.extra.dashboard_active_quota, undefined);
  assert.equal(applied.extra.codex_active_quota_stale, undefined);
  assert.deepEqual(Object.keys(applied.extra.dashboard_active_quota), ['status', 'queriedAt', 'error']);
});

test('deleted accounts are pruned after a successful list, while list failures preserve all old data', async t => {
  let phase = 0;
  const { schedule, at } = await fixture(t, { listAccounts: async () => {
    if (phase === 1) throw new Error('PRIVATE_LIST_ERROR');
    return phase === 2 ? [account(2)] : [account(1), account(2)];
  } });
  await schedule.run(); phase = 1; at(START + HALF_HOUR); await schedule.run();
  assert.ok(schedule.record(1)); assert.ok(schedule.record(2));
  assert.match(schedule.snapshot().lastError, /无法读取账号列表/);
  assert.equal(schedule.apply([account(1)])[0].extra.codex_active_quota_stale, true);
  phase = 2; at(START + HALF_HOUR * 2); await schedule.run();
  assert.equal(schedule.record(1), null); assert.ok(schedule.record(2));
});

test('invalid result or mismatched id is rejected without replacing cache', async t => {
  const { schedule } = await fixture(t, { listAccounts: async () => [1, 2].map(id => account(id)),
    queryAccount: async id => id === '1' ? { token: 'PRIVATE_BAD_RESULT' } : record(3) });
  await schedule.run();
  assert.equal(schedule.snapshot().failedCount, 2);
  assert.deepEqual(schedule.records, {});
  assert.doesNotMatch(JSON.stringify(schedule.snapshot()), /PRIVATE_BAD_RESULT/);
});

test('failed durable slot claim sends no upstream request', async t => {
  const { schedule, queried, dataDir } = await fixture(t);
  await mkdir(join(dataDir, 'active-quota.json'));
  await schedule.run();
  assert.equal(queried.length, 0);
  assert.match(schedule.snapshot().lastError, /无法保存/);
});

test('corrupted saved schedule skips current slot and safely resumes in the next slot', async t => {
  const { queried, dataDir, at, restart } = await fixture(t);
  await writeFile(join(dataDir, 'active-quota.json'), '{broken');
  const next = await restart();
  await next.run(); assert.equal(queried.length, 0);
  at(START + HALF_HOUR); await next.run(); assert.equal(queried.length, 1);
});

test('closing aborts in-flight work; a late client resolution never updates cache', async t => {
  const gate = deferred(), started = deferred(); let suppliedSignal;
  const { schedule, dataDir } = await fixture(t, { queryAccount: async (id, { signal }) => {
    suppliedSignal = signal; started.resolve(); await gate.promise; return record(id);
  } });
  const task = schedule.run(); await started.promise;
  await schedule.close(); await task;
  assert.equal(suppliedSignal.aborted, true);
  assert.equal(schedule.snapshot().running, false);
  assert.equal(schedule.snapshot().failedCount, 1);
  gate.resolve(); await turn();
  assert.equal(schedule.record(1), null);
  const disk = JSON.parse(await readFile(join(dataDir, 'active-quota.json'), 'utf8'));
  assert.equal(disk.lastCycle.status, 'cancelled');
});

test('cycle timeout bounds an uncooperative list without a late query', async t => {
  const gate = deferred();
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const { schedule, queried } = await fixture(t, { timeoutMs: 20, listAccounts: async () => { await gate.promise; return [account(1)]; } });
  await schedule.run();
  assert.match(schedule.snapshot().lastError, /超时/);
  gate.resolve(); await turn();
  assert.equal(queried.length, 0);
});

test('per-account timeout still permits other accounts to finish the cycle', async t => {
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const { schedule } = await fixture(t, { queryTimeoutMs: 20, listAccounts: async () => [account(1), account(2)],
    queryAccount: async id => id === '1' ? new Promise(() => {}) : record(id) });
  await schedule.run();
  assert.equal(schedule.snapshot().successCount, 1); assert.equal(schedule.snapshot().failedCount, 1);
  assert.match(schedule.snapshot().accounts.find(row => row.id === '1').error, /超时/);
});

test('aborted waiting broadcast does not cancel a cycle that was already running independently', async t => {
  const gate = deferred(), started = deferred();
  const { schedule } = await fixture(t, { queryAccount: async id => { started.resolve(); await gate.promise; return record(id); } });
  const task = schedule.run(); await started.promise;
  const controller = new AbortController();
  const waiter = schedule.ensureCurrent({ signal: controller.signal }); controller.abort();
  await assert.rejects(waiter, { code: 'CANCELLED' });
  gate.resolve(); await task;
  assert.equal(schedule.snapshot().successCount, 1);
});

test('onUpdated runs after a saved cycle and disabled schedules do not query', async t => {
  let updates = 0, scheduleRef;
  const { schedule, dataDir } = await fixture(t, { onUpdated: async () => {
    updates++;
    assert.equal(scheduleRef.snapshot().successCount, 1);
    const saved = JSON.parse(await readFile(join(dataDir, 'active-quota.json'), 'utf8'));
    assert.equal(saved.lastCycle.status, 'success');
  } });
  scheduleRef = schedule;
  await schedule.run(); await schedule.run(); assert.equal(updates, 1);
  const disabled = await fixture(t, { enabled: false });
  disabled.schedule.start(); await disabled.schedule.run();
  assert.equal(disabled.queried.length, 0); assert.equal(disabled.schedule.snapshot().nextRunAt, null);
});
