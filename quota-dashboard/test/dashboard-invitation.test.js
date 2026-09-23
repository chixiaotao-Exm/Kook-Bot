import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Dashboard } from '../src/dashboard.js';
import { normalizeAccounts } from '../src/sub2api.js';
import { normalizeInvitation } from '../src/invitation-snapshot.js';
import { atomicJson } from '../src/storage.js';

const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const raw = (count = 3, at = NOW) => ({ id: 6255, platform: 'openai', type: 'oauth', status: 'active', name: 'Account', extra: {
  codex_primary_window_minutes: 300, codex_primary_used_percent: 25, codex_usage_updated_at: new Date(NOW).toISOString(),
  codex_primary_reset_at: new Date(NOW + 3600000).toISOString(),
  codex_referral_snapshot: { available_invites: count, should_show: true, program_id: 'codex_referral_consumer', fetched_at: at / 1000 },
} });
const invitation = (count, at = NOW) => normalizeInvitation(raw(count, at), { now: NOW });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-invitation-test-'));
  let now = NOW;
  const dashboard = new Dashboard({ dataDir: directory, now: () => now,
    client: { refresh: async () => ({ accounts: normalizeAccounts([raw(3, NOW - 300000)], { now }), checkedAt: new Date(now).toISOString() }) }, ...overrides });
  dashboard.data = { accounts: normalizeAccounts([raw(3, NOW - 300000)], { now }), updatedAt: new Date(NOW - 10000).toISOString() };
  t.after(async () => { dashboard.close(); await dashboard.writeTail; assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('quota-invitation-test-')); await rm(directory, { recursive: true, force: true }); });
  return { dashboard, directory, advance(ms) { now += ms; } };
}

test('invitation updates preserve quota timestamps, metrics and errors while persisting only sanitized invitation fields', async t => {
  const { dashboard } = await fixture(t);
  dashboard.lastError = 'quota unavailable';
  const before = structuredClone(dashboard.data);
  const result = await dashboard.updateInvitation('6255', { ...invitation(0), credentials: { secret: 'private-invitation-secret' },
    title: 'Email member@example.test https://private.example/invite' });
  assert.equal(result.accounts[0].invitation.availableCount, 0); assert.equal(result.accounts[0].invitation.freshness, 'fresh');
  assert.equal(result.accounts[0].freshness, 'stale'); assert.equal(result.lastError, 'quota unavailable');
  assert.equal(dashboard.data.updatedAt, before.updatedAt); assert.deepEqual(dashboard.data.accounts[0].metrics, before.accounts[0].metrics);
  assert.equal(dashboard.lastAttempt, null);
  const saved = JSON.parse(await readFile(dashboard.file, 'utf8'));
  assert.equal(saved.updatedAt, before.updatedAt); assert.equal(saved.accounts[0].invitation.availableCount, 0);
  assert.doesNotMatch(JSON.stringify(saved), /private-invitation-secret|member@example|https:\/\/private/);
  result.accounts[0].invitation.rules.push('caller mutation');
  assert.deepEqual(dashboard.snapshot().accounts[0].invitation.rules, []);
});

test('invitation freshness ages by checkedAt even when quota freshness follows a different clock', async t => {
  const f = await fixture(t); await f.dashboard.updateInvitation('6255', invitation(3));
  f.dashboard.data.updatedAt = null;
  assert.equal(f.dashboard.snapshot().accounts[0].invitation.freshness, 'fresh');
  f.advance(900001);
  assert.equal(f.dashboard.snapshot().accounts[0].invitation.freshness, 'stale');
  f.dashboard.data.accounts[0].invitation.checkedAt = null;
  assert.equal(f.dashboard.snapshot().accounts[0].invitation.freshness, 'unknown');
});

test('an older in-flight account list cannot overwrite a newer explicit invitation update', async t => {
  const listing = deferred();
  const { dashboard } = await fixture(t, { client: { refresh: () => listing.promise } });
  const refreshing = dashboard.refresh();
  const concurrentRefresh = dashboard.refresh();
  await dashboard.updateInvitation('6255', invitation(1));
  listing.resolve({ accounts: normalizeAccounts([raw(5, NOW - 60000)], { now: NOW }), checkedAt: new Date(NOW).toISOString() });
  const result = await refreshing;
  assert.deepEqual(await concurrentRefresh, result);
  assert.equal(result.accounts[0].invitation.availableCount, 1);
  assert.equal(result.accounts[0].invitation.checkedAt, new Date(NOW).toISOString());
  assert.equal(JSON.parse(await readFile(dashboard.file, 'utf8')).accounts[0].invitation.availableCount, 1);
});

test('snapshot writes serialize so a slow refresh save cannot overwrite a later invitation update', async t => {
  const entered = deferred(), release = deferred(); let writes = 0;
  const { dashboard } = await fixture(t, { writeState: async (file, state) => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    await atomicJson(file, state);
  } });
  const refreshing = dashboard.refresh(); await entered.promise;
  const updating = dashboard.updateInvitation('6255', invitation(2));
  assert.equal(dashboard.snapshot().accounts[0].invitation.availableCount, 2);
  assert.equal(writes, 1);
  release.resolve();
  const [refreshed, updated] = await Promise.all([refreshing, updating]);
  assert.equal(refreshed.accounts[0].invitation.availableCount, 2); assert.equal(updated.accounts[0].invitation.availableCount, 2);
  assert.equal(JSON.parse(await readFile(dashboard.file, 'utf8')).accounts[0].invitation.availableCount, 2);
});

test('equal-time list refreshes preserve explicit changes, later lists win, and delayed updates cannot regress them', async t => {
  let listing = raw(5);
  const f = await fixture(t, { client: { refresh: async () => ({ accounts: normalizeAccounts([listing], { now: NOW }), checkedAt: new Date(NOW).toISOString() }) } });
  await f.dashboard.updateInvitation(6255, invitation(1));
  await f.dashboard.refresh(); assert.equal(f.dashboard.snapshot().accounts[0].invitation.availableCount, 1);
  f.advance(16000); listing = raw(7, NOW + 10000);
  await f.dashboard.refresh({ force: true });
  assert.equal(f.dashboard.snapshot().accounts[0].invitation.availableCount, 7);
  await f.dashboard.updateInvitation('6255', invitation(0, NOW));
  assert.equal(f.dashboard.snapshot().accounts[0].invitation.availableCount, 7);
});

test('unsupported/deleted accounts and malformed updates cannot mutate invitation capability', async t => {
  const { dashboard } = await fixture(t);
  for (const [id, value] of [['6256', invitation(2)], ['../6255', invitation(2)], ['6255', null], ['6255', { supported: false }]]) {
    await assert.rejects(dashboard.updateInvitation(id, value));
  }
  dashboard.data.accounts[0].invitation = null;
  await assert.rejects(dashboard.updateInvitation('6255', invitation(2)));
  assert.equal(dashboard.snapshot().accounts[0].invitation, null);
  dashboard.close(); await dashboard.updateInvitation('6255', invitation(2));
  assert.equal(dashboard.snapshot().accounts[0].invitation, null);
});

test('saved invitation values are revalidated on load and legacy absent values wait for normalized account refresh', async t => {
  const { dashboard } = await fixture(t);
  const saved = { version: 1, ...dashboard.data };
  saved.accounts[0].invitation = { ...invitation(4), email: 'private@example.test', rules: ['Bearer private-credential'] };
  await writeFile(dashboard.file, JSON.stringify(saved)); await dashboard.init();
  assert.doesNotMatch(JSON.stringify(dashboard.snapshot()), /private@example|private-credential/);
  delete saved.accounts[0].invitation;
  await writeFile(dashboard.file, JSON.stringify(saved)); await dashboard.init();
  assert.equal(dashboard.snapshot().accounts[0].invitation, null);
  await dashboard.refresh(); assert.equal(dashboard.snapshot().accounts[0].invitation.supported, true);
});

test('failed persistence retains the new safe value and does not poison subsequent snapshot writes', async t => {
  let fail = true;
  const { dashboard } = await fixture(t, { writeState: async (file, state) => {
    if (fail) throw new Error('private storage details');
    return atomicJson(file, state);
  } });
  const failed = await dashboard.updateInvitation('6255', invitation(2));
  assert.equal(failed.accounts[0].invitation.availableCount, 2); assert.ok(failed.storageError);
  assert.doesNotMatch(failed.storageError, /private/);
  fail = false; const recovered = await dashboard.updateInvitation('6255', invitation(1));
  assert.equal(recovered.storageError, ''); assert.equal(JSON.parse(await readFile(dashboard.file, 'utf8')).accounts[0].invitation.availableCount, 1);
});
