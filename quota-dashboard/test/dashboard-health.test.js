import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Dashboard } from '../src/dashboard.js';
import { normalizeAccounts } from '../src/sub2api.js';

const NOW = Date.parse('2026-09-23T20:00:00Z');
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-health-'));
  let now = NOW, failed = false;
  const raw = { id: 1, name: 'Account', platform: 'openai', type: 'oauth', status: 'active', schedulable: true,
    rate_limit_reset_at: new Date(NOW + 60000).toISOString(), last_used_at: new Date(NOW - 1000).toISOString() };
  const dashboard = await new Dashboard({ dataDir: directory, now: () => now, client: { async refresh() {
    if (failed) throw new Error('private upstream failure');
    return { accounts: normalizeAccounts([raw], { now }), checkedAt: new Date(now).toISOString() };
  } } }).init();
  t.after(async () => { dashboard.close(); await dashboard.writeTail; assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('quota-health-')); await rm(directory, { recursive: true, force: true }); });
  return { dashboard, directory, raw, advance(ms) { now += ms; }, fail() { failed = true; } };
}

test('health expiry waits for a new list observation to confirm recovery and preserves the original observation time', async t => {
  const f = await fixture(t); await f.dashboard.refresh();
  assert.equal(f.dashboard.snapshot().accounts[0].health.state, 'limited');
  f.advance(60000);
  const ended = f.dashboard.snapshot();
  assert.equal(ended.accounts[0].health.state, 'unknown'); assert.equal(ended.accounts[0].health.recoverAt, null);
  assert.equal(ended.accounts[0].health.observedAt, new Date(NOW).toISOString());
  await f.dashboard.refresh({ force: true });
  assert.equal(f.dashboard.snapshot().accounts[0].health.state, 'healthy');
  assert.equal(f.dashboard.snapshot().accounts[0].health.observedAt, new Date(NOW + 60000).toISOString());
});

test('failed refresh marks health old without replacing the last safe state or leaking raw errors', async t => {
  const f = await fixture(t); delete f.raw.rate_limit_reset_at;
  await f.dashboard.refresh(); f.advance(20000); f.fail(); await f.dashboard.refresh({ force: true });
  const result = f.dashboard.snapshot();
  assert.equal(result.accounts[0].health.state, 'healthy'); assert.equal(result.accounts[0].health.freshness, 'stale');
  assert.equal(result.accounts[0].health.observedAt, new Date(NOW).toISOString());
  assert.doesNotMatch(JSON.stringify(result.accounts[0].health), /private/);
});

test('stored health is whitelisted on startup and old snapshots never invent a healthy observation', async t => {
  const f = await fixture(t); await f.dashboard.refresh();
  const saved = JSON.parse(await readFile(f.dashboard.file, 'utf8'));
  saved.accounts[0].health.credentials_status = { token: 'private-credentials' };
  saved.accounts[0].health.issues[0].label = 'private-error-message';
  await writeFile(f.dashboard.file, JSON.stringify(saved)); await f.dashboard.init();
  assert.doesNotMatch(JSON.stringify(f.dashboard.snapshot()), /private-credentials|private-error-message/);
  f.advance(1800001);
  assert.equal(f.dashboard.snapshot().accounts[0].health.freshness, 'stale');
  delete saved.accounts[0].health;
  await writeFile(f.dashboard.file, JSON.stringify(saved)); await f.dashboard.init();
  const result = f.dashboard.snapshot().accounts[0].health;
  assert.equal(result.state, 'unknown'); assert.equal(result.observedAt, null);
});
