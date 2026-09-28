import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduledSummary } from '../src/report-summary.js';
import { createKookSender } from '../src/kook.js';

const NOW = Date.parse('2026-09-24T12:34:56Z');
const iso = offset => new Date(NOW + offset).toISOString();
const host = patch => ({ id: 'main', name: '主服务器', state: 'up', maintenance: false, observedAt: iso(0), lastSeenAt: iso(0),
  metrics: { cpuPercent: 12.3, memoryPercent: 40, diskPercent: 50 }, services: [], bots: [{ id: 'ai', name: '对话机器人', state: 'online' }], ...patch });
const monitor = patch => ({ id: 'quota', name: '额度网站', url: 'https://api.example.test/quota/', state: 'up', maintenance: false,
  checkedAt: iso(0), httpStatus: 200, latencyMs: 12, tlsDays: 80, ...patch });
const content = value => [value.title, ...value.lines].join('\n');

test('infra summary keeps every current host, all eight bots and the explicitly stopped discussion', () => {
  const bots = Array.from({ length: 8 }, (_, i) => ({ id: `music${i}`, name: `音乐机器人${i}`, state: 'online', playing: i % 2 === 0 }));
  const snapshot = { hosts: [host({ bots: [], services: [{ id: 'duet', name: '双机器人讨论', expected: 'stopped', activeState: 'inactive' }] }),
    host({ id: 'music', name: '音乐服务器', bots })] };
  const before = structuredClone(snapshot), result = buildScheduledSummary(snapshot, 'infra', NOW), text = content(result);
  assert.equal(result.theme, 'success'); assert.match(result.title, /09\/24 20:30 北京时间/);
  assert.match(text, /主服务器/); assert.match(text, /音乐服务器/); assert.match(text, /CPU 12\.3%.*内存 40%.*磁盘 50%/);
  for (const bot of bots) assert.ok(text.includes(`${bot.name}：在线`));
  assert.match(text, /双机器人讨论：计划停用/); assert.match(text, /播放中/);
  assert.equal(result.lines.length, 11);
  assert.match(result.lines[0], /^主服务器｜正常 · CPU/);
  assert.equal(result.lines[1], '↳ 双机器人讨论：计划停用');
  assert.match(result.lines[2], /^音乐服务器｜正常 · CPU/);
  for (let i = 0; i < bots.length; i++) {
    assert.equal(result.lines[i + 3], `↳ ${bots[i].name}：在线${i % 2 === 0 ? ' · 播放中' : ''}`);
  }
  assert.ok(!text.includes('其余记录')); assert.deepEqual(snapshot, before);
});

test('host timestamps are independently verified and old metrics and playback claims are hidden', () => {
  for (const time of [iso(-120001), iso(60001), null, 'invalid']) {
    for (const field of ['observedAt', 'lastSeenAt']) {
      const result = buildScheduledSummary({ updatedAt: iso(0), hosts: [host({ [field]: time,
        metrics: { cpuPercent: 77, memoryPercent: 88, diskPercent: 99 }, bots: [{ name: '音乐', state: 'online', playing: true },
          { id: 'planned:duet', name: '讨论', state: 'stopped' }] })] }, 'infra', NOW);
      assert.equal(result.theme, 'warning'); assert.match(content(result), /CPU 待确认.*内存 待确认.*磁盘 待确认/);
      assert.match(content(result), /音乐：待确认/); assert.match(content(result), /计划停用 · 待确认/);
      assert.doesNotMatch(content(result), /77%|88%|99%|播放中/);
    }
  }
  assert.equal(buildScheduledSummary({ hosts: [host({ observedAt: iso(-120000), lastSeenAt: iso(-120000) })] }, 'infra', NOW).theme, 'success');
});

test('offline, unknown and unplanned stopped bots do not become green while maintenance remains distinct', () => {
  assert.equal(buildScheduledSummary({ hosts: [host({ bots: [{ name: 'AI', state: 'offline' }] })] }, 'infra', NOW).theme, 'danger');
  for (const state of ['unknown', 'stopped', 'bad-state']) {
    assert.equal(buildScheduledSummary({ hosts: [host({ bots: [{ name: 'AI', state }] })] }, 'infra', NOW).theme, 'warning');
  }
  const maintained = buildScheduledSummary({ hosts: [host({ maintenance: true, state: 'maintenance' })] }, 'infra', NOW);
  assert.equal(maintained.theme, 'info'); assert.match(content(maintained), /维护中/);
  assert.equal(buildScheduledSummary({ hosts: [host({ metrics: { cpuPercent: null, memoryPercent: 40, diskPercent: 50 } })] }, 'infra', NOW).theme, 'warning');
});

test('fresh web summaries include each site/API status, latency and certificate facts', () => {
  const result = buildScheduledSummary({ monitors: [monitor(), monitor({ id: 'health', name: '健康接口', url: 'http://127.0.0.1:18998/health', tlsDays: null }),
    ...Array.from({ length: 5 }, (_, i) => monitor({ id: `api${i}`, name: `业务接口${i}` }))] }, 'web', NOW);
  assert.equal(result.theme, 'success'); assert.match(content(result), /额度网站：正常 · HTTP 200 · 12ms · 证书余 80 天/);
  assert.match(content(result), /健康接口：正常.*HTTP，无证书/);
  assert.equal(result.lines.length, 7);
  assert.match(result.lines[0], /^额度网站：正常/); assert.match(result.lines[1], /^健康接口：正常/);
  for (let i = 0; i < 5; i++) assert.match(result.lines[i + 2], new RegExp(`^业务接口${i}：正常`));
  assert.doesNotMatch(content(result), /127\.0\.0\.1|api\.example/);
  const nearExpiry = buildScheduledSummary({ monitors: [monitor({ tlsDays: 14 })] }, 'web', NOW);
  assert.equal(nearExpiry.theme, 'warning');
});

test('old web data stays pending rather than reusing cached success, latency or TLS days', () => {
  for (const checkedAt of [iso(-150001), iso(60001), null, 'invalid']) {
    const result = buildScheduledSummary({ updatedAt: iso(0), monitors: [monitor({ checkedAt, latencyMs: 987, tlsDays: 77 })] }, 'web', NOW);
    assert.equal(result.theme, 'warning'); assert.match(content(result), /额度网站：待确认.*延迟待确认.*证书待确认/);
    assert.doesNotMatch(content(result), /987ms|77 天|HTTP 200|：正常/);
  }
  assert.equal(buildScheduledSummary({ monitors: [monitor({ checkedAt: iso(-150000) })] }, 'web', NOW).theme, 'success');
  assert.equal(buildScheduledSummary({ monitors: [monitor({ state: 'down' })] }, 'web', NOW).theme, 'danger');
  assert.equal(buildScheduledSummary({ monitors: [monitor({ maintenance: true })] }, 'web', NOW).theme, 'info');
});

test('an empty or malformed snapshot gives a bounded warning instead of a successful empty report', () => {
  for (const value of [null, {}, { hosts: [null], monitors: [null] }]) for (const category of ['infra', 'web']) {
    const result = buildScheduledSummary(value, category, NOW);
    assert.equal(result.theme, 'warning'); assert.match(content(result), /尚无/);
  }
  for (const category of ['all', 'other', null]) assert.throws(() => buildScheduledSummary({}, category, NOW), /参数无效/);
  assert.throws(() => buildScheduledSummary({}, 'infra', NaN), /参数无效/);
});

test('packing preserves all ordinary monitors and marks unavoidable overflow without losing the worst overall state', async () => {
  const monitors = Array.from({ length: 40 }, (_, i) => monitor({ id: `m${i}`, name: `站点${i}`, state: i === 39 ? 'down' : 'up' }));
  const report = buildScheduledSummary({ monitors }, 'web', NOW);
  for (let i = 0; i < 40; i++) assert.ok(content(report).includes(`站点${i}：`));
  assert.ok(report.lines.length <= 12); assert.equal(report.theme, 'danger');
  const huge = buildScheduledSummary({ hosts: Array.from({ length: 20 }, (_, i) => host({ name: '😀"\\'.repeat(50), id: `h${i}`,
    bots: Array.from({ length: 40 }, (_, n) => ({ name: '😀"\\'.repeat(50), state: i === 19 && n === 39 ? 'offline' : 'online' })) })) }, 'infra', NOW);
  assert.equal(huge.theme, 'danger'); assert.match(content(huge), /其余记录/);
  assert.ok(huge.lines.length <= 12); assert.ok(huge.lines.every(line => line.length <= 500 && line.isWellFormed()));
  const sent = []; const send = createKookSender({ token: 'fixture-only', publicUrl: 'https://api.example.test/ops/', fetchImpl: async (_url, init) => {
    sent.push(init); return Response.json({ code: 0, data: { msg_id: 'a'.repeat(32) } });
  } });
  await send(report); await send(huge); assert.equal(sent.length, 2);
});

test('secret names and mention syntax are sanitized and arbitrary snapshot fields never enter scheduled messages', () => {
  const result = buildScheduledSummary({ hosts: [host({ name: '主机 @all sk-private-key123 password=hidden-value', token: 'ignored-token',
    bots: [{ name: '(met)123456(met) 邮箱 user@example.test', state: 'online', lastError: 'private-error', command: 'private-command' }] })] }, 'infra', NOW);
  assert.doesNotMatch(content(result), /@all|sk-private|hidden-value|ignored-token|\(met\)|user@example|private-error|private-command/);
  assert.ok(result.lines.every(line => line.isWellFormed()));
});

test('automatic repair summaries count actual recent recoveries and scope website repairs separately', () => {
  const autoRepair = { enabled: true, states: [
    { hostId: 'main', serviceId: 'ai', category: 'infra', phase: 'verifying' },
    { hostId: 'main', serviceId: 'quota', category: 'web', phase: 'unknown' },
    { hostId: 'main', serviceId: 'music', category: 'infra', phase: 'blocked' },
    { hostId: 'main', serviceId: 'menu', category: 'infra', phase: 'idle' },
    { hostId: 'main', serviceId: 'bridge', category: 'infra', phase: 'recovered' },
    { hostId: 'main', serviceId: 'duet', category: 'infra', phase: 'maintenance' },
  ], events: [
    { id: 'r1', phase: 'recovered', category: 'infra', at: iso(-1800000) },
    { id: 'r1', phase: 'recovered', category: 'infra', at: iso(-1800000) },
    { id: 'r2', phase: 'recovered', category: 'web', at: iso(-1) },
    { id: 'too-old', phase: 'recovered', category: 'web', at: iso(-1800001) },
    { id: 'future', phase: 'recovered', category: 'web', at: iso(1) },
    { id: 'invalid', phase: 'recovered', category: 'web', at: 'invalid' },
    { id: 'only-command-complete', phase: 'verifying', category: 'web', at: iso(0) },
  ] };
  const snapshot = { hosts: [host()], monitors: [monitor()], autoRepair }, before = structuredClone(snapshot);
  assert.equal(buildScheduledSummary(snapshot, 'infra', NOW).lines[0], '自动修复：已开启 · 最近30分钟恢复2次 / 待确认2 / 受限1');
  assert.equal(buildScheduledSummary(snapshot, 'web', NOW).lines[0], '自动修复：已开启 · 最近30分钟恢复1次 / 待确认1 / 受限0');
  assert.equal(buildScheduledSummary(snapshot, 'infra', NOW).theme, 'warning');
  assert.deepEqual(snapshot, before);
});

test('repair summary tolerates old snapshots and unknown phases without claiming recovery', () => {
  for (const value of [undefined, null, []]) {
    assert.doesNotMatch(content(buildScheduledSummary({ hosts: [host()], autoRepair: value }, 'infra', NOW)), /自动修复/);
  }
  const result = buildScheduledSummary({ hosts: [host()], autoRepair: { enabled: false,
    states: [null, { hostId: 'main', serviceId: 'ai', phase: 'new-state' }, { hostId: 'main', serviceId: 'menu', phase: 'failed' }],
    events: [{ phase: 'failed', at: iso(0), message: 'sk-not-for-reports' }] } }, 'infra', NOW);
  assert.match(content(result), /自动修复：未开启 · 最近30分钟恢复0次 \/ 待确认2 \/ 受限0/);
  assert.doesNotMatch(content(result), /sk-not-for-reports/);
});

test('repair summary reserves its section while packing complete host and bot inventory', () => {
  const bots = Array.from({ length: 10 }, (_, i) => ({ id: `bot${i}`, name: `机器人${i}`, state: 'online' }));
  const result = buildScheduledSummary({ hosts: [host({ bots }), host({ id: 'other', name: '备用服务器', bots: [] })],
    autoRepair: { enabled: true, events: [], states: [] } }, 'infra', NOW);
  assert.match(result.lines[0], /^自动修复：已开启/);
  for (const bot of bots) assert.ok(content(result).includes(`${bot.name}：在线`));
  assert.match(content(result), /主服务器｜正常/); assert.match(content(result), /备用服务器｜正常/);
  assert.doesNotMatch(content(result), /其余记录/); assert.ok(result.lines.length <= 12);
  const huge = buildScheduledSummary({ monitors: Array.from({ length: 300 }, (_, i) => monitor({ id: `m${i}`, name: `监控目标${i}` })),
    autoRepair: { enabled: true, states: [], events: [] } }, 'web', NOW);
  assert.match(huge.lines[0], /^自动修复：已开启/); assert.match(content(huge), /其余记录/); assert.ok(huge.lines.length <= 12);
});
