import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActiveQuotaClient, applyActiveQuota, sanitizeActiveQuotaRecord } from '../src/active-quota.js';
import { ActiveQuotaSchedule } from '../src/active-quota-schedule.js';
import { normalizeAccounts } from '../src/sub2api.js';
import { Dashboard } from '../src/dashboard.js';
import { NewApiAccountSource } from '../src/newapi.js';

const NOW = Date.parse('2026-09-24T00:00:00Z');
const credits = balance => ({ balance, has_credits: true, unlimited: false });
const raw = (value = credits('100'), sampledAt = NOW - 60000) => ({ id: 1, name: 'Points fixture', platform: 'openai', type: 'oauth', status: 'active',
  extra: { auto_reset_credit_enabled: false, codex_credits_snapshot: { credits: value, fetched_at: sampledAt / 1000 } } });
const record = points => ({ accountId: '1', queriedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW).toISOString(), cachePersisted: false,
  usage: { primary: null, secondary: null, resetCredits: null, points }, planType: 'pro' });
const normalized = account => normalizeAccounts([account], { now: NOW })[0];
const response = data => Response.json({ code: 0, data });
async function directory(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quota-points-'));
  t.after(() => rm(dataDir, { recursive: true, force: true })); return dataDir;
}

test('new active samples preserve the independent point balance when Sub2API cache persistence fails', async () => {
  const calls = [], account = raw();
  const client = new ActiveQuotaClient({ adminApiKey: 'fixture-only', now: () => NOW, fetchImpl: async (url, init) => {
    calls.push([new URL(url).pathname, init.method]);
    return response(init.method === 'POST' ? { fetched_at: NOW / 1000, cache_persisted: false, credits_cache_persisted: false,
      credits: { ...credits('250.5'), email: 'hidden@example.test', secret: 'must-not-leak' }, rate_limit: {} } : account);
  } });
  const observed = await client.refreshAccount('1');
  assert.deepEqual(observed.usage.points, { balance: 250.5, hasCredits: true, unlimited: false });
  assert.doesNotMatch(JSON.stringify(observed), /hidden|secret|must-not/);
  assert.equal(calls.filter(row => row[1] === 'POST').length, 1);
  assert.ok(calls[1][0].endsWith('/quota/refresh'));
  const updated = normalized(applyActiveQuota(account, observed));
  assert.equal(updated.points.balance, 250.5); assert.equal(updated.points.source, 'sub2api-active-quota');
  assert.equal(updated.points.observedAt, new Date(NOW).toISOString());
  assert.equal(account.extra.codex_credits_snapshot.credits.balance, '100');
});

test('new missing credits clear old balances but upgrading old records does not erase data never collected', async () => {
  const account = raw();
  const oldRecord = record(null); delete oldRecord.usage.points;
  assert.equal(Object.hasOwn(sanitizeActiveQuotaRecord(oldRecord).usage, 'points'), false);
  assert.equal(normalized(applyActiveQuota(account, oldRecord)).points.balance, 100);
  const current = normalized(applyActiveQuota(account, record(null)));
  assert.equal(current.points.balance, null); assert.equal(current.points.hasCredits, null);
  assert.equal(current.points.observedAt, new Date(NOW).toISOString());
});

test('an older active result cannot replace a newer cached point sample or its availability', () => {
  const account = raw(credits('450'), NOW + 30000);
  const updated = normalized(applyActiveQuota(account, record({ balance: 0, hasCredits: false, unlimited: false })));
  assert.equal(updated.points.balance, 450); assert.equal(updated.points.hasCredits, true);
  assert.equal(updated.points.source, 'sub2api-cache');
});

test('point balance survives NewAPI enrichment and a safe dashboard restart, aging by its own sample', async t => {
  const dataDir = await directory(t); let now = NOW;
  const active = normalized(applyActiveQuota(raw(), record({ balance: 1000, hasCredits: true, unlimited: false })));
  const source = new NewApiAccountSource({ baseUrl: 'https://api.ark717.com', queryKey: 'fixture-only', accountId: '99',
    fetchImpl: () => { throw new Error('Unmatched provider must not query'); } });
  const dashboard = await new Dashboard({ dataDir, now: () => now, providers: [source], client: { refresh: async () => ({ accounts: [active], checkedAt: new Date(NOW).toISOString() }) } }).init();
  await dashboard.refresh(); assert.equal(dashboard.snapshot().accounts[0].points.balance, 1000); dashboard.close();
  const restored = await new Dashboard({ dataDir, now: () => now, client: {} }).init();
  now += 16 * 60000;
  assert.equal(restored.snapshot().accounts[0].points.freshness, 'fresh');
  now += 20 * 60000;
  assert.equal(restored.snapshot().accounts[0].points.freshness, 'stale');
  restored.close();
});

test('saved point snapshots rehydrate only whitelisted fields', async t => {
  const dataDir = await directory(t), account = normalized(raw());
  account.points.accessToken = 'private-point-token'; account.points.email = 'private@example.test';
  await writeFile(path.join(dataDir, 'snapshot.json'), JSON.stringify({ version: 1, updatedAt: new Date(NOW).toISOString(), accounts: [account] }));
  const dashboard = await new Dashboard({ dataDir, now: () => NOW, client: {} }).init();
  assert.doesNotMatch(JSON.stringify(dashboard.snapshot()), /private-point|private@|accessToken/);
  assert.equal(dashboard.snapshot().accounts[0].points.balance, 100); dashboard.close();
});

test('a failed half-hour query marks retained active points stale before their normal expiration', async t => {
  const dataDir = await directory(t); let now = NOW, fail = false;
  const scheduler = await new ActiveQuotaSchedule({ dataDir, now: () => now, enabled: true,
    listAccounts: async () => [raw()], queryAccount: async () => {
      if (fail) throw new Error('temporary');
      return record({ balance: 1500, hasCredits: true, unlimited: false });
    } }).init();
  await scheduler.run();
  assert.equal(normalizeAccounts(scheduler.apply([raw()]), { now })[0].points.freshness, 'fresh');
  now += 30 * 60000; fail = true; await scheduler.run();
  const result = normalizeAccounts(scheduler.apply([raw()]), { now })[0].points;
  assert.equal(result.balance, 1500); assert.equal(result.freshness, 'stale');
  const dashboard = await new Dashboard({ dataDir, now: () => now, client: { refresh: async () => ({
    accounts: normalizeAccounts(scheduler.apply([raw()]), { now }), checkedAt: new Date(now).toISOString(),
  }) } }).init();
  await dashboard.refresh(); assert.equal(dashboard.snapshot().accounts[0].points.freshness, 'stale'); dashboard.close();
  await scheduler.close();
});
