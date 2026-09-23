import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Diagnostics } from '../src/diagnostics.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-health-')); let clock = 100000;
  const p = { current: null, status: 'idle', context: { voiceChannelId: 'v1' }, connected: true, stayConnected: true, volume: 60, queue: [], recoveryError: '' };
  const settings = { radio: { enabled: false, lastError: '' }, schedules: [] };
  const runtime = { config: { token: 'extra-private-secret' }, player: { snapshot: () => p, audio: { connected: true } }, features: { snapshot: () => settings, setReporter(fn) { this.report = fn; } } };
  const descriptor = { id: 'a', name: 'Bot', online: true, status: 'ready' };
  const manager = { list: () => [descriptor], get: () => runtime };
  const music = { account: async () => ({ loggedIn: true }) };
  const config = { dataDir: dir, token: 'main-private-secret', cookie: 'entire-private-cookie' };
  const health = new Diagnostics(config, manager, music, { now: () => clock }); await health.init();
  t.after(async () => { await health.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-health-')); await rm(dir, { recursive: true, force: true }); });
  return { health, p, settings, runtime, descriptor, manager, music, config, dir, advance: (n) => { clock += n; } };
}
test('health reports idle silence normally and records transitions, recovery and automation failures', async (t) => {
  const f = await fixture(t), h = f.health;
  assert.equal(h.snapshot().summary.issues, 0);
  f.descriptor.online = false; h.snapshot(); f.advance(16000);
  assert.equal(h.snapshot().summary.issues, 1); assert.equal(h.events[0].kind, 'gateway_offline');
  h.snapshot(); assert.equal(h.events.length, 1);
  f.descriptor.online = true; h.snapshot(); assert.equal(h.events[0].kind, 'recovered');
  f.settings.radio = { enabled: true, suspended: false, lastError: 'No songs' };
  assert.equal(h.snapshot().summary.issues, 1); assert.match(h.snapshot().bots[0].issue, /自动电台/);
  f.settings.radio.enabled = false;
  f.settings.schedules = [{ enabled: true, name: 'Evening', lastError: 'No permission' }];
  assert.match(h.snapshot().bots[0].issue, /Evening/);
  f.settings.schedules[0].enabled = false; assert.equal(h.snapshot().summary.issues, 0);
});
test('health distinguishes stopped audio input from idle residency and does not claim audibility', async (t) => {
  const f = await fixture(t);
  f.runtime.player.audio.source = { lastProgress: 1 };
  assert.equal(f.health.snapshot().summary.issues, 0);
  f.p.status = 'playing'; f.p.current = { source: 'qq', name: 'Song' };
  assert.match(f.health.snapshot().bots[0].issue, /12 秒/);
  f.runtime.player.audio.connected = false;
  assert.equal(f.health.snapshot().bots[0].transport, 'disconnected');
  assert.match(f.health.snapshot().limitations, /客户端/);
});
test('diagnostics bound and redact private messages before persistence and reload', async (t) => {
  const f = await fixture(t);
  f.health.record({ botId: 'a', level: 'error', kind: 'source_failed', message: 'main-private-secret extra-private-secret entire-private-cookie https://cdn.invalid/private?k=1 {"cookie":"never-show-me","token":"hidden-token"}' });
  await f.health.writeTail;
  const saved = await readFile(f.health.file, 'utf8');
  for (const secret of ['main-private-secret', 'extra-private-secret', 'entire-private-cookie', 'never-show-me', 'hidden-token', 'cdn.invalid']) assert.equal(saved.includes(secret), false);
  const reloaded = new Diagnostics(f.config, f.manager, f.music); await reloaded.init();
  assert.equal(reloaded.events.length, 1); await reloaded.close();
  for (let i = 0; i < 302; i++) f.health.record({ kind: 'sample', message: String(i) });
  await f.health.writeTail; assert.equal(f.health.events.length, 300);
});
test('account checks coalesce and stale pre-logout responses cannot restore a logged-in state', async (t) => {
  const f = await fixture(t); let release, entered, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.music.account = async (source) => { calls++; if (source === 'qq' && calls <= 2) { entered(); await gate; return { loggedIn: true }; } return { loggedIn: false }; };
  const first = f.health.refreshAccounts(), second = f.health.refreshAccounts(); await started;
  f.health.invalidateAccount('qq', false);
  assert.equal(f.health.snapshot().accounts.qq.status, 'logged_out');
  release(); await Promise.all([first, second]); await f.health.accountPending;
  assert.equal(f.health.snapshot().accounts.qq.status, 'logged_out'); assert.equal(calls, 4);
});
test('malformed health history is preserved while current monitoring remains available', async (t) => {
  const f = await fixture(t); await f.health.close();
  await writeFile(f.health.file, 'not valid json');
  const h = new Diagnostics(f.config, f.manager, f.music); await h.init();
  h.record({ kind: 'new_notice', message: 'Still usable' });
  assert.match(h.snapshot().storageError, /原文件已保留/); await h.close();
  assert.equal(await readFile(f.health.file, 'utf8'), 'not valid json');
});
