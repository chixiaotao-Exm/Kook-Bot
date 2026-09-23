import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyActiveQuota } from '../src/active-quota.js';
import { normalizeAccounts } from '../src/sub2api.js';
import { Dashboard } from '../src/dashboard.js';
import { BroadcastScheduler } from '../src/broadcast.js';

const now = Date.parse('2026-09-22T01:00:00Z');
const raw = { id: 1, name: 'OpenAI source', platform: 'openai', type: 'oauth', status: 'active', extra: {
  auto_reset_credit_enabled: false, codex_primary_used_percent: 100, codex_primary_window_minutes: 300,
  codex_usage_updated_at: new Date(now - 3600000).toISOString(),
  codex_auto_reset_credit_state: { status: 'no_credit', checked_at: new Date(now - 86400000).toISOString() },
} };
const record = { accountId: '1', observedAt: new Date(now).toISOString(), queriedAt: new Date(now).toISOString(), cachePersisted: true, planType: 'prolite',
  usage: { primary: { usedPercent: 40, windowMinutes: 300, resetAt: new Date(now + 3600000).toISOString(), resetAfterSeconds: 3600 }, secondary: null,
    resetCredits: { availableCount: 1, expiresAt: [new Date(now + 86400000).toISOString()] } } };

test('active windows and reset cards replace stale cache with reliable observations and a thirty-minute freshness budget', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'active-quota-integrated-'));
  let time = now;
  const merged = applyActiveQuota(raw, record);
  const accounts = normalizeAccounts([merged], { now });
  assert.equal(accounts[0].metrics[0].usedPercent, 40);
  assert.equal(accounts[0].metrics[0].source, 'sub2api-active-quota');
  assert.equal(accounts[0].resetCredits.availableCount, 1);
  assert.equal(accounts[0].resetCredits.status, 'available');
  assert.equal(accounts[0].resetCredits.source, 'sub2api-active-quota');
  assert.equal(accounts[0].resetCredits.checkedAt, record.queriedAt);
  const dashboard = await new Dashboard({ dataDir: dir, client: { refresh: async () => ({ accounts, checkedAt: new Date(time).toISOString() }) }, now: () => time }).init();
  t.after(async () => { dashboard.close(); await rm(dir, { recursive: true, force: true }); });
  await dashboard.refresh(); time += 20 * 60000; await dashboard.refresh();
  assert.equal(dashboard.snapshot().accounts[0].metrics[0].freshness, 'fresh');
  assert.equal(dashboard.snapshot().accounts[0].resetCredits.freshness, 'fresh');
  time += 16 * 60000; await dashboard.refresh();
  assert.equal(dashboard.snapshot().accounts[0].metrics[0].freshness, 'stale');
  assert.equal(dashboard.snapshot().accounts[0].resetCredits.freshness, 'stale');
  const failed = normalizeAccounts([{ ...merged, extra: { ...merged.extra, codex_active_quota_stale: true, dashboard_active_quota: { status: 'failed', queriedAt: record.queriedAt } } }], { now });
  assert.equal(failed[0].metrics[0].freshness, 'stale'); assert.equal(failed[0].resetCredits.freshness, 'stale'); assert.match(failed[0].quotaQuery.message, /失败/);
  const exceeded = normalizeAccounts([applyActiveQuota(raw, { ...record, usage: { ...record.usage, primary: { ...record.usage.primary, usedPercent: 120 } } })], { now });
  assert.equal(exceeded[0].metrics[0].usedPercent, 120); assert.equal(exceeded[0].metrics[0].remainingPercent, 0);
});

test('dashboard aging never revives consumed zero credits from older expiration metadata', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'active-quota-zero-'));
  const accounts = normalizeAccounts([raw], { now });
  accounts[0].resetCredits = { cachedCount: 2, availableCount: 0, status: 'no_credit', checkedAt: new Date(now).toISOString(), expiresAt: [new Date(now + 86400000).toISOString()], freshness: 'fresh' };
  const dashboard = await new Dashboard({ dataDir: dir, client: { refresh: async () => ({ accounts, checkedAt: new Date(now).toISOString() }) }, now: () => now }).init();
  t.after(async () => { dashboard.close(); await rm(dir, { recursive: true, force: true }); }); await dashboard.refresh();
  assert.equal(dashboard.snapshot().accounts[0].resetCredits.availableCount, 0);
});

test('only an actual broadcast waits for active queries; it then sends updated values once', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'active-quota-broadcast-'));
  let time = now - 60000, used = 100, refreshes = 0, sends = [];
  const scheduler = new BroadcastScheduler({ dataDir: dir, now: () => time,
    getSnapshot: () => ({ accounts: [{ id: '1', name: 'OpenAI test', platform: 'openai', metrics: [{ key: '5h', label: '5h', kind: 'percent', usedPercent: used, remainingPercent: 100 - used }] }] }),
    beforeBroadcast: async ({ signal }) => { assert.equal(signal.aborted, false); refreshes++; used = 25; },
    send: async text => { sends.push(text); return { messageId: 'after-query' }; },
  }); await scheduler.init();
  t.after(async () => { await scheduler.close(); await rm(dir, { recursive: true, force: true }); });
  await scheduler.preview(); assert.equal(refreshes, 0);
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  time = now + 1; await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(refreshes, 1); assert.equal(sends.length, 1); assert.match(sends[0], /剩余75%/);
});
