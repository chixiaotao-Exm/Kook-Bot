import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpsEngine } from '../src/engine.js';
import { StateStore } from '../src/storage.js';
import { validateConfig } from '../src/config.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
function fixture({ send, probe, writeState } = {}) {
  let now = NOW;
  const config = validateConfig({ hosts: [{ id: 'linux', name: 'Linux', token: 'a'.repeat(48), services: [
    { id: 'ai', name: 'AI', unit: 'kook-ai-bot.service', expected: 'running', restartAllowed: true },
    { id: 'duet', name: '讨论', unit: 'kook-ai-duet.service', expected: 'stopped', restartAllowed: false },
  ] }], monitors: [{ id: 'site', name: '网站', url: 'https://example.test/' }] }, {});
  const store = new StateStore({ dataDir: 'unused', writeState: writeState || (async () => {}), timeoutMs: 25 });
  const engine = new OpsEngine({ config, store, send, now: () => now, probe: probe || (async () => ({ ok: true, latencyMs: 20, httpStatus: 200, tlsDays: 90 })) });
  const report = (extra = {}) => ({ hostId: 'linux', observedAt: new Date(now).toISOString(), metrics: { cpuPercent: 1, memoryPercent: 20, diskPercent: 30, load1: 0.2, uptimeSeconds: 500 },
    services: [{ id: 'ai', activeState: 'active', subState: 'running', pid: 123, restarts: 0 }, { id: 'duet', activeState: 'inactive', pid: 0, restarts: 0 }], bots: [], commandResults: [], ...extra });
  return { config, store, engine, report, ingest: value => { const result = engine.ingest(config.hosts[0], value || report()); now++; return result; }, advance: ms => { now += ms; } };
}

test('fresh reports expire locally; stopped discussion service is expected and cannot restart', async () => {
  const f = fixture(); await f.ingest();
  assert.equal(f.engine.snapshot().hosts[0].state, 'up');
  assert.equal(f.engine.snapshot().hosts[0].services[1].ok, true);
  await assert.rejects(f.engine.command({ hostId: 'linux', serviceId: 'duet', action: 'restart', requestId: randomUUID() }), /不允许/);
  f.advance(120001); assert.equal(f.engine.snapshot().hosts[0].state, 'unknown');
  await assert.rejects(f.engine.command({ hostId: 'linux', serviceId: 'ai', action: 'restart', requestId: randomUUID() }), /离线/);
  assert.ok(!JSON.stringify(f.engine.snapshot()).includes('a'.repeat(48)));
});

test('commands are idempotent, allowlisted, persisted before dispatch and never blindly redelivered', async () => {
  const f = fixture(); await f.ingest();
  const input = { hostId: 'linux', serviceId: 'ai', action: 'restart', requestId: randomUUID() };
  const command = await f.engine.command(input); assert.equal(command.status, 'pending');
  assert.equal((await f.engine.command(input)).id, command.id);
  await assert.rejects(f.engine.command({ ...input, serviceId: 'shell' }), /不允许/);
  await assert.rejects(f.engine.command({ ...input, action: 'start' }), /无效/);
  const delivered = await f.ingest(); assert.equal(delivered.commands.length, 1); assert.equal(delivered.commands[0].id, command.id);
  assert.equal(f.store.data.commands[0].status, 'dispatched');
  assert.deepEqual((await f.ingest()).commands, []);
  f.advance(120001); await f.engine.tick(); assert.equal(f.store.data.commands[0].status, 'unknown');
  await f.ingest(f.report({ commandResults: [{ id: command.id, status: 'succeeded', message: 'password=secret' }] }));
  assert.equal(f.store.data.commands[0].status, 'succeeded'); assert.ok(!JSON.stringify(f.engine.snapshot()).includes('password'));
});

test('three failed observations open one incident; two successes send one recovery', async () => {
  const sent = [], f = fixture({ send: async message => { sent.push(message); } });
  const bad = () => f.report({ metrics: { ...f.report().metrics, diskPercent: 95 } });
  await f.ingest(bad()); await f.ingest(bad()); await f.engine.flushNotifications(); assert.equal(sent.length, 0);
  await f.ingest(bad()); await f.engine.sending; assert.equal(sent.length, 1); assert.equal(sent[0].category, 'infra');
  await f.ingest(bad()); await f.engine.sending; assert.equal(sent.length, 1);
  await f.ingest(); await f.engine.sending; assert.equal(sent.length, 1);
  await f.ingest(); await f.engine.sending; assert.equal(sent.length, 2); assert.equal(sent[1].theme, 'success');
  assert.equal(f.engine.snapshot().incidents[0].state, 'resolved');
});

test('maintenance suppresses alarms and resets streaks; it never changes the service execution policy', async () => {
  const sent = [], f = fixture({ send: async message => { sent.push(message); } });
  await f.engine.maintenance({ kind: 'host', id: 'linux', enabled: true });
  for (let i = 0; i < 4; i++) await f.ingest(f.report({ services: [] }));
  await f.engine.sending; assert.equal(sent.length, 0); assert.equal(f.engine.snapshot().hosts[0].state, 'maintenance');
  await f.engine.maintenance({ kind: 'host', id: 'linux', enabled: false });
  await f.ingest(f.report({ services: [] })); assert.equal(f.engine.snapshot().incidents.length, 0);
});

test('maintenance queued before a notification claim prevents its later send', async () => {
  const sent = [], f = fixture();
  for (let i = 0; i < 3; i++) await f.ingest(f.report({ services: [] }));
  f.engine.send = async message => sent.push(message);
  let release; const originalWrite = f.store.writeState;
  f.store.writeState = () => new Promise(resolve => { release = resolve; });
  const blocked = f.store.transaction(() => {}); await new Promise(resolve => setImmediate(resolve));
  const maintenance = f.engine.maintenance({ kind: 'host', id: 'linux', enabled: true });
  const sending = f.engine.flushNotifications();
  f.store.writeState = originalWrite; release(); await Promise.all([blocked, maintenance, sending]);
  assert.equal(sent.length, 0); assert.equal(f.store.data.incidents[0].notified, 'pending');
});

test('an incident that recovered before notification delivery does not send an obsolete failure/recovery pair', async () => {
  const f = fixture(); for (let i = 0; i < 3; i++) await f.ingest(f.report({ services: [] }));
  await f.ingest(); await f.ingest();
  const sent = []; f.engine.send = async value => sent.push(value); await f.engine.flushNotifications();
  assert.equal(sent.length, 0); assert.equal(f.store.data.incidents[0].notified, 'suppressed');
  f.store.data.incidents[0].notified = 'pending'; f.store.data.incidents[0].recoveryNotified = 'pending';
  await f.engine.flushNotifications(); assert.equal(sent.length, 0); assert.equal(f.store.data.incidents[0].notified, 'suppressed');
});

test('monitor failures use web category, TLS warnings do not claim the endpoint is down, stale results become unknown', async () => {
  const sent = [], f = fixture({ send: async message => sent.push(message), probe: async () => ({ ok: true, latencyMs: 10, httpStatus: 200, tlsDays: 7 }) });
  for (let i = 0; i < 3; i++) { await f.engine.tick(); f.advance(60000); }
  assert.equal(sent.length, 1); assert.equal(sent[0].category, 'web');
  assert.equal(f.engine.snapshot().monitors[0].state, 'up');
  f.advance(150001); assert.equal(f.engine.snapshot().monitors[0].state, 'unknown');
});

test('failed notification is marked uncertain and not repeatedly retried', async () => {
  let attempts = 0; const f = fixture({ send: async () => { attempts++; throw new Error('timeout'); } });
  for (let i = 0; i < 4; i++) await f.ingest(f.report({ services: [] }));
  await f.engine.sending; await f.engine.flushNotifications();
  assert.equal(attempts, 1); assert.equal(f.store.data.incidents[0].notified, 'uncertain'); assert.match(f.engine.snapshot().notification.lastError, /未确认/);
});

test('report cannot forge service policy, overwrite a newer observation or submit expired metrics', async () => {
  const f = fixture(); await f.ingest(); f.advance(1000); await f.ingest();
  const old = f.report({ observedAt: new Date(NOW).toISOString() }); await assert.rejects(f.ingest(old), /旧报告/);
  await assert.rejects(f.ingest(f.report({ observedAt: new Date(NOW - 900000).toISOString() })), /过期/);
  await f.ingest(f.report({ services: [{ id: 'duet', activeState: 'inactive', restartAllowed: true, expected: 'running' }] }));
  assert.equal(f.engine.snapshot().hosts[0].services[1].restartAllowed, false);
  assert.equal(f.engine.snapshot().hosts[0].services[1].expected, 'stopped');
});

test('replayed observations do not count as separate failures or recovery samples', async () => {
  const f = fixture(), bad = f.report({ services: [] });
  await f.ingest(bad); f.advance(1001); await f.ingest(bad); f.advance(1001); await f.ingest(bad);
  assert.equal(f.store.data.streaks['host:linux'].fail, 1); assert.equal(f.store.data.incidents.length, 0);
});

test('authorization is checked at queued mutation execution after a logout', async () => {
  let release; const f = fixture(); await f.ingest();
  f.store.writeState = () => new Promise(resolve => { release = resolve; });
  const blocked = f.store.transaction(() => {}); await new Promise(resolve => setImmediate(resolve));
  let authorized = true;
  const action = f.engine.command({ hostId: 'linux', serviceId: 'ai', action: 'restart', requestId: randomUUID() }, () => { if (!authorized) throw new Error('logged out'); });
  authorized = false; release(); await blocked; await assert.rejects(action, /logged out/); assert.equal(f.store.data.commands.length, 0);
});

test('storage deadline fails closed without publishing unpersisted state or starting more writes', async () => {
  let writes = 0; const store = new StateStore({ dataDir: 'unused', timeoutMs: 10, writeState: () => { writes++; return new Promise(() => {}); } });
  await assert.rejects(store.transaction(draft => { draft.audit.push({ action: 'test' }); }), /保存失败/);
  assert.equal(store.failed, true); assert.equal(store.data.audit.length, 0);
  await assert.rejects(store.transaction(() => {}), /不可用/); assert.equal(writes, 1);
});

test('configuration rejects shared secrets, disabled-service actions and credential-bearing monitor URLs', () => {
  const f = fixture(), raw = { hosts: f.config.hosts, monitors: f.config.monitors };
  assert.throws(() => validateConfig({ ...raw, hosts: [...raw.hosts, { ...raw.hosts[0], id: 'second' }] }, {}), /distinct/);
  assert.throws(() => validateConfig({ ...raw, monitors: [{ id: 'unsafe', name: 'unsafe', url: 'https://example.test/?token=private' }] }, {}), /credentials/);
  assert.throws(() => validateConfig({ ...raw, hosts: [{ ...raw.hosts[0], services: [{ ...raw.hosts[0].services[1], restartAllowed: true }] }] }, {}), /Stopped/);
});
