import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsEngine } from '../src/engine.js';
import { StateStore } from '../src/storage.js';
import { validateConfig } from '../src/config.js';
import { buildScheduledSummary } from '../src/report-summary.js';

function fixture() {
  let now = Date.parse('2026-09-25T00:00:00Z');
  const config = validateConfig({ hosts: [{ id: 'music', name: '音乐服务器', token: 'fixture'.repeat(8), services: [
    { id: 'music', name: '音乐服务', unit: 'music.service', expected: 'running', restartAllowed: true },
  ] }], monitors: [] }, {});
  const store = new StateStore({ dataDir: 'unused', writeState: async () => {} });
  const engine = new OpsEngine({ config, store, now: () => now });
  return { engine, store, now: () => now, async report(bot, service = {}) {
    now += 30000;
    await engine.ingest(config.hosts[0], { hostId: 'music', observedAt: new Date(now).toISOString(), metrics: { cpuPercent: 5, memoryPercent: 20, diskPercent: 30 },
      services: [{ id: 'music', activeState: 'active', subState: 'running', pid: 100, ok: true, ...service }], bots: [bot], commandResults: [] });
  } };
}
const music = patch => ({ id: 'music:default', name: '音乐机器人', kind: 'music', state: 'online', playing: true, health: 'healthy', transport: 'connected', lastError: '', ...patch });

test('voice failure is separate from gateway connectivity and opens an incident instead of reporting playback success', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.report(music({ health: 'degraded', transport: 'disconnected', lastError: '语音发送连接已中断' }));
  let snapshot = f.engine.snapshot(), bot = snapshot.hosts[0].bots[0];
  assert.equal(bot.state, 'online'); assert.equal(bot.health, 'degraded'); assert.equal(bot.playing, false); assert.equal(bot.transport, 'disconnected');
  assert.equal(snapshot.hosts[0].state, 'down'); assert.equal(snapshot.incidents.length, 1);
  const card = buildScheduledSummary(snapshot, 'infra', f.now());
  assert.equal(card.theme, 'danger'); assert.match(card.lines.join('\n'), /异常|语音发送/); assert.doesNotMatch(card.lines.join('\n'), /播放中/);
  await f.report(music()); await f.report(music()); snapshot = f.engine.snapshot();
  assert.equal(snapshot.hosts[0].state, 'up'); assert.equal(snapshot.incidents[0].state, 'resolved');
  assert.match(buildScheduledSummary(snapshot, 'infra', f.now()).lines.join('\n'), /播放中/);
});

test('old music agents with an issue also degrade during a rolling update; unknown business state cannot claim playback', async () => {
  const f = fixture(); const old = music({ lastError: '音源无进度' }); delete old.health; delete old.transport;
  await f.report(old); assert.equal(f.engine.snapshot().hosts[0].bots[0].health, 'degraded');
  await f.report(music({ health: 'unknown', transport: null })); const snapshot = f.engine.snapshot();
  assert.equal(snapshot.hosts[0].bots[0].playing, false);
  assert.doesNotMatch(buildScheduledSummary(snapshot, 'infra', f.now()).lines.join('\n'), /播放中/);
});

test('active but exited services and missing PIDs cannot be upgraded from a failed collector report', async () => {
  for (const service of [{ subState: 'exited', pid: 0, ok: false }, { subState: 'running', pid: 0 }, { subState: 'unknown', pid: 100 }]) {
    const f = fixture(); for (let i = 0; i < 3; i++) await f.report(music(), service);
    const snapshot = f.engine.snapshot(); assert.equal(snapshot.hosts[0].services[0].ok, false); assert.equal(snapshot.hosts[0].state, 'down'); assert.equal(snapshot.incidents.length, 1);
  }
});

test('an intentionally stopped music bot does not alert from its historical disconnected diagnostic', async () => {
  const f = fixture(); for (let i = 0; i < 3; i++) await f.report(music({ state: 'stopped', health: 'degraded', transport: 'disconnected', lastError: '消息连接暂时中断' }));
  const host = f.engine.snapshot().hosts[0]; assert.equal(host.bots[0].health, 'healthy'); assert.equal(host.bots[0].playing, false);
  assert.equal(host.state, 'up'); assert.equal(f.engine.snapshot().incidents.length, 0);
});
