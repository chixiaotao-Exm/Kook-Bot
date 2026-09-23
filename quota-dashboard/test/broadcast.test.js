import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSummary, BroadcastScheduler, createKookSender } from '../src/broadcast.js';
import { buildBroadcastCards } from '../src/broadcast-cards.js';

const sample = {
  checkedAt: '2026-09-19T00:59:00Z',
  accounts: [
    { id: '6269', name: '常用 OpenAI', platform: 'openai', type: 'oauth', status: 'active', schedulable: false, freshness: 'fresh', observedAt: '2026-09-19T00:58:00Z', metrics: [
      { key: 'five-hour', label: '5 小时额度', kind: 'percent', scope: 'upstream', usedPercent: 25, remainingPercent: 75, freshness: 'fresh', resetAt: '2026-09-19T05:00:00Z' },
    ] },
    { id: '6271', name: 'Claude 账号', platform: 'anthropic', type: 'oauth', status: 'active', freshness: 'unknown', observedAt: null, metrics: [] },
    { id: '6268', name: 'DeepSeek 余额', platform: 'deepseek', type: 'apikey', status: 'active', schedulable: true, freshness: 'stale', observedAt: '2026-09-18T00:00:00Z', metrics: [
      { key: 'balance', label: '人民币余额', kind: 'balance', scope: 'upstream', unit: 'CNY', value: 12.34, freshness: 'stale', observedAt: '2026-09-18T00:00:00Z' },
    ] },
    { id: '6270', name: '本站消费限额', platform: 'openai', type: 'apikey', status: 'active', freshness: 'unknown', observedAt: null, metrics: [
      { key: 'quota', label: '消费限额', kind: 'count', scope: 'local', unit: 'USD', used: 2, limit: 10, remaining: 8, usedPercent: 20, remainingPercent: 80, freshness: 'unknown' },
    ] },
  ],
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'quota-broadcast-test-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  let timestamp = Date.parse(options.at || '2026-09-19T00:59:00Z');
  const sent = [];
  const scheduler = new BroadcastScheduler({
    dataDir, now: () => timestamp, getSnapshot: () => sample,
    send: async (text, metadata) => { sent.push({ text, metadata }); return { messageId: `msg-${sent.length}` }; },
    ...options,
  });
  await scheduler.init();
  t.after(() => scheduler.close());
  return { scheduler, dataDir, sent, at: value => { timestamp = Date.parse(value); } };
}

test('summary groups every account and distinguishes percentages, money, local caps and unknown cache', () => {
  const text = buildSummary(sample, { dashboardUrl: 'https://quota.example.com/?admin=secret#token' });
  assert.match(text, /4 个账号/);
  assert.match(text, /✨ Sub2API 额度播报/);
  assert.match(text, /✅ 开启 1 · ⚪ 关闭 1 · ⚠ 异常 0/);
  assert.match(text, /【OpenAI · 2 个】/);
  assert.match(text, /【Claude · 1 个】/);
  assert.match(text, /5h额度 已用25% · 剩余75%\n  🔋 \[■■■■■■■■□□\]▏/);
  assert.match(text, /重置09\/19 13:00/);
  assert.match(text, /12\.34 CNY（旧）/);
  assert.match(text, /本站消费限额 剩余\$8\.00（已用\$2\.00\/\$10\.00）/);
  assert.match(text, /额度未知/);
  assert.match(text, /旧采样 09\/18 08:00/);
  assert.match(text, /常用 OpenAI · 关闭/);
  assert.match(text, /DeepSeek 余额 · 开启/);
  assert.match(text, /Claude 账号 · 调度未知/);
  assert.match(text, /详情：https:\/\/quota\.example\.com\//);
  assert.doesNotMatch(text, /admin=secret|#token/);
});

test('summary uses account plan labels and a readable KOOK hierarchy without exposing metadata', () => {
  const input = structuredClone(sample);
  input.accounts[0].planLabel = 'Pro 5x'; input.accounts[0].planSource = 'upstream';
  input.accounts[1].planLabel = '版本未知'; input.accounts[1].credentials = { plan_type: 'PRIVATE_PLAN' };
  const text = buildSummary(input);
  assert.match(text, /常用 OpenAI · Pro 5x · 关闭/);
  assert.match(text, /Claude 账号 · 版本未知 · 调度未知/);
  assert.match(text, /━━━━━━━━/); assert.match(text, /🕒 更新 .*北京时间/);
  assert.doesNotMatch(text, /PRIVATE_PLAN|planSource|credentials/);
});

test('summary never serializes credentials, raw errors, notes, URLs or mentions', () => {
  const input = structuredClone(sample);
  input.accounts[0].name = 'admin-1234567890abcdef1234567890abcdef @everyone (met)123(met)';
  input.accounts[0].credentials = { token: 'PRIVATE_RAW_TOKEN' };
  input.accounts[0].error = 'access_token=ERROR_PRIVATE https://secret.test/private';
  input.accounts[0].notes = ['PRIVATE_NOTE'];
  input.accounts[0].metrics[0].note = 'PRIVATE_METRIC_NOTE';
  input.accounts[0].metrics[0].label = 'Authorization: Bearer PRIVATE_HEADER';
  const text = buildSummary(input);
  assert.doesNotMatch(text, /1234567890abcdef|PRIVATE_|@everyone|\(met\)|secret\.test/);
  assert.match(text, /查询异常/);
});

test('summary marks a failed refresh as previous snapshot and product share is not an independent quota', () => {
  const input = structuredClone(sample);
  input.lastError = 'private source error';
  input.accounts.push({ id: '1', name: 'Grok', platform: 'grok', freshness: 'stale', metrics: [
    { key: 'grok-product-0', label: '产品用量占比', kind: 'percent', usedPercent: 12, remainingPercent: 88, freshness: 'stale' },
    { key: 'requests', label: '请求窗口', kind: 'count', remaining: 45, used: 5, limit: 50, unit: 'requests', usedPercent: 10, remainingPercent: 90, freshness: 'stale' },
  ] });
  const text = buildSummary(input);
  assert.match(text, /以下为上次快照/);
  assert.match(text, /另1项见看板/);
  assert.doesNotMatch(text, /剩余 88%|private source error/);
  assert.doesNotMatch(text, /产品用量占比|剩余88%/);
  assert.match(text, /请求窗口 剩余45次（旧）/);
  assert.match(buildSummary({ accounts: [], lastError: 'private' }), /账号列表读取失败，暂无可用快照/);
});

test('long summaries stay within the KOOK text budget and disclose omitted accounts', () => {
  const input = { ...sample, accounts: Array.from({ length: 100 }, (_, id) => ({ ...sample.accounts[0], id, name: `账号-${id}` })) };
  const text = buildSummary(input, { maxLength: 900, dashboardUrl: 'https://quota.example.com/' });
  assert.ok(text.length <= 900);
  assert.match(text, /100 个账号/);
  assert.match(text, /篇幅限制，另有 \d+ 个账号请在看板查看/);
  assert.match(text, /更新 .*北京时间/);
  assert.match(text, /https:\/\/quota\.example\.com/);
});

test('summary includes 5h/7d local requests, tokens, A/U and clearly labelled full-quota estimates', () => {
  const input = structuredClone(sample);
  input.accounts[0].windowStats = [
    { key: '5h', periodKind: 'quota', requests: 23, tokens: 145600, accountCost: 0.123456, userCost: 0.0789, currency: 'USD', estimatedTotalCost: 0.493824, observedAt: '2026-09-19T00:59:00Z', complete: true, rawToken: 'PRIVATE_STATS_TOKEN' },
    { key: '7d', periodKind: 'rolling', requests: 400, tokens: 1250000, accountCost: 8.25, userCost: 4.1, currency: 'USD', estimatedTotalCost: null, observedAt: '2026-09-19T00:59:00Z', complete: true, estimateNote: 'PRIVATE_NOTE' },
  ];
  input.accounts[0].resetCredits = { availableCount: 0, cachedCount: 0, status: 'no_credit', checkedAt: '2026-09-19T00:58:00Z', freshness: 'fresh', raw: 'PRIVATE_RESET' };
  const text = buildSummary(input);
  assert.match(text, /5h 23次 · 145\.6K Token · A\$0\.12 U\$0\.08 · 估\$0\.49/);
  assert.match(text, /近7d 400次 · 1\.3M Token · A\$8\.25 U\$4\.10/);
  assert.doesNotMatch(text, /估未知|预计满额费用|本站统计时间/);
  assert.match(text, /重置卡0次/);
  assert.match(text, /A账号费\/U用户费，估为估算/);
  assert.doesNotMatch(text, /PRIVATE_/);
});

test('incomplete local statistics and unverified reset count stay unknown while complete empty windows show zero', () => {
  const input = structuredClone(sample);
  input.accounts[0].windowStats = [
    { key: '5h', periodKind: 'quota', requests: null, tokens: null, accountCost: null, userCost: null, estimatedTotalCost: null, observedAt: null, complete: false, error: 'PRIVATE_FETCH_FAILURE' },
    { key: '7d', periodKind: 'rolling', requests: 0, tokens: 0, accountCost: 0, userCost: 0, estimatedTotalCost: null, observedAt: '2026-09-19T00:59:00Z', complete: true },
  ];
  input.accounts[0].resetCredits = { availableCount: null, cachedCount: 2, status: 'no_credit', checkedAt: null, freshness: 'stale' };
  const text = buildSummary(input);
  assert.match(text, /5h（未完成） 用量未知/);
  assert.match(text, /近7d 无用量/);
  assert.match(text, /重置卡未知（历史2次）（旧）/);
  assert.match(text, /旧采样 未知/);
  assert.doesNotMatch(text, /PRIVATE_FETCH_FAILURE|重置卡0次/);
});

test('tiny nonzero costs are not rounded down to zero and expanded summaries retain truncation notices', () => {
  const account = structuredClone(sample.accounts[0]);
  account.windowStats = [{ key: '5h', periodKind: 'quota', requests: 1, tokens: 4, accountCost: 1e-8, userCost: 2e-8, estimatedTotalCost: 1e-7, complete: true }];
  const single = buildSummary({ ...sample, accounts: [account] });
  assert.match(single, /A\$<0\.000001 U\$<0\.000001/);
  const text = buildSummary({ ...sample, accounts: Array.from({ length: 50 }, (_, id) => ({ ...account, id })) }, { maxLength: 1500, dashboardUrl: 'https://quota.example.com' });
  assert.ok(text.length <= 1500);
  assert.match(text, /50 个账号/);
  assert.match(text, /另有 \d+ 个账号请在看板查看/);
  assert.match(text, /详情：https:\/\/quota\.example\.com/);
});

test('window freshness explicitly labels old statistics and unknown sampling times', () => {
  const input = structuredClone(sample);
  input.accounts[0].windowStats = [
    { key: '5h', periodKind: 'quota', requests: 23, tokens: 145600, accountCost: 0.12, userCost: 0.08, estimatedTotalCost: null, complete: true, freshness: 'stale' },
    { key: '7d', periodKind: 'rolling', requests: 400, tokens: 1250000, accountCost: 8.25, userCost: 4.1, estimatedTotalCost: null, complete: true, freshness: 'unknown' },
  ];
  const text = buildSummary(input);
  assert.match(text, /5h（旧） 23次/);
  assert.match(text, /近7d（时间未知） 400次/);
  assert.match(text, /旧采样 未知/);
  assert.doesNotMatch(text, /估未知/);
});

test('summary keeps currencies separate and labels upstream wallet as pricing credit', () => {
  const input = structuredClone(sample);
  input.accounts[2].metrics.push({ key: 'usd-balance', label: 'USD余额', kind: 'balance', unit: 'USD', value: 0 });
  input.accounts.push({ id: '7', name: '小鸡毛', platform: 'openai', schedulable: false, metrics: [
    { key: 'newapi-wallet', label: '小鸡毛·钱包可用计价额度', kind: 'balance', unit: 'USD', value: 10000070.397226 },
    { key: 'newapi-used', label: '小鸡毛·上游累计使用', kind: 'count', unit: 'USD', used: 1685.806886 },
    { key: 'newapi-requests', label: '小鸡毛·上游累计请求', kind: 'count', unit: 'requests', used: 18950 },
  ] });
  const text = buildSummary(input);
  assert.match(text, /人民币余额 12\.34 CNY/);
  assert.match(text, /USD余额 \$0\.00/);
  assert.match(text, /小鸡毛 · 关闭\n  计价额 \$10,000,070\.40/);
  assert.match(text, /另2项见看板/);
  assert.doesNotMatch(text, /累计使用|累计请求|钱包余额/);
});

test('partial usage fields stay unknown and sub-cent costs retain useful precision', () => {
  const account = structuredClone(sample.accounts[0]);
  account.windowStats = [{ key: '7d', periodKind: 'rolling', requests: 0, tokens: null, accountCost: 0.0071622, userCost: null, complete: true }];
  const text = buildSummary({ accounts: [account] });
  assert.match(text, /近7d 0次 · 未知 Token · A\$0\.00716 U未知/);
  assert.doesNotMatch(text, /无用量|A\$0\.00\b/);
});

test('fixed-time broadcast persists its slot before sending and executes once per local day', async t => {
  const fixtureState = await fixture(t);
  const { scheduler, dataDir, sent, at } = fixtureState;
  const ordinarySend = scheduler.send;
  scheduler.send = async (...args) => {
    const disk = JSON.parse(await readFile(join(dataDir, 'broadcast.json'), 'utf8'));
    assert.equal(disk.ledger.at(-1).status, 'dispatching');
    assert.equal(disk.history.at(-1).status, 'dispatching');
    return ordinarySend(...args);
  };
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T01:00:01Z');
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].metadata.cards, (await scheduler.preview()).cards);
  assert.equal(scheduler.snapshot().history[0].status, 'sent');
  assert.equal(scheduler.snapshot().history[0].messageId, 'msg-1');
  await scheduler.tick();
  assert.equal(sent.length, 1);
  at('2026-09-20T01:00:01Z');
  await scheduler.tick();
  assert.equal(sent.length, 2);
  const saved = await readFile(join(dataDir, 'broadcast.json'), 'utf8');
  assert.doesNotMatch(saved, /常用 OpenAI|账号额度|Bot |checkedAt/);
});

test('quarter-hour schedule sends at 00/15/30/45 without duplicates across midnight and restart', async t => {
  const { scheduler, dataDir, sent, at } = await fixture(t, { at: '2026-09-19T15:43:00Z' });
  const times = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`);
  await scheduler.configure({ enabled: true, times, timeZone: 'Asia/Shanghai' });
  await scheduler.tick(); assert.equal(sent.length, 0);
  for (const timestamp of ['2026-09-19T15:45:01Z', '2026-09-19T16:00:01Z', '2026-09-19T16:15:01Z', '2026-09-19T16:30:01Z']) {
    at(timestamp); await scheduler.tick(); await scheduler.tick();
  }
  assert.equal(sent.length, 4); await scheduler.close();
  const restarted = new BroadcastScheduler({ dataDir, getSnapshot: async () => sample, send: async () => { sent.push('unexpected'); return { messageId: 'unexpected' }; }, now: () => Date.parse('2026-09-19T16:30:20Z') });
  await restarted.init(); await restarted.tick(); assert.equal(sent.length, 4); assert.equal(restarted.snapshot().times.length, 96); await restarted.close();
});

test('startup and configuration minutes are skipped and missed schedules are not replayed', async t => {
  const { scheduler, sent, at } = await fixture(t, { at: '2026-09-19T01:00:10Z' });
  await scheduler.configure({ enabled: true, times: ['09:00', '09:02'], timeZone: 'Asia/Shanghai' });
  await scheduler.tick();
  assert.equal(sent.length, 0);
  at('2026-09-19T01:03:00Z');
  await scheduler.tick();
  assert.equal(sent.length, 0);
  await scheduler.configure({ enabled: true, times: ['09:03'], timeZone: 'Asia/Shanghai' });
  await scheduler.tick();
  assert.equal(sent.length, 0);
  at('2026-09-20T01:03:00Z');
  await scheduler.tick();
  assert.equal(sent.length, 1);
});

test('half-hour schedule drops quarter-hours and preserves duplicate ledger when reconfigured', async t => {
  const { scheduler, dataDir, sent, at } = await fixture(t, { at: '2026-09-19T15:43:00Z' });
  const quarterHours = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`);
  const halfHours = quarterHours.filter(time => time.endsWith(':00') || time.endsWith(':30'));
  await scheduler.configure({ enabled: true, times: quarterHours, timeZone: 'Asia/Shanghai' });
  at('2026-09-19T15:45:01Z'); await scheduler.tick(); assert.equal(sent.length, 1);
  const previous = scheduler.snapshot().history;
  await scheduler.configure({ enabled: true, times: halfHours, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(scheduler.snapshot().history, previous);
  assert.equal(scheduler.snapshot().times.length, 48);
  for (const [timestamp, expected] of [['2026-09-19T16:00:01Z', 2], ['2026-09-19T16:15:01Z', 2], ['2026-09-19T16:30:01Z', 3], ['2026-09-19T16:45:01Z', 3]]) {
    at(timestamp); await scheduler.tick(); await scheduler.tick(); assert.equal(sent.length, expected);
  }
  await scheduler.close();
  const restarted = new BroadcastScheduler({ dataDir, getSnapshot: async () => sample, send: async () => { sent.push('duplicate'); return { messageId: 'duplicate' }; }, now: () => Date.parse('2026-09-19T16:30:20Z') });
  await restarted.init(); await restarted.tick(); assert.equal(sent.length, 3); assert.equal(restarted.snapshot().times.length, 48); await restarted.close();
});

test('persisted dispatches survive restart and an unfinished send becomes uncertain', async t => {
  const { scheduler, dataDir, at } = await fixture(t);
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T01:00:00Z');
  await scheduler.tick();
  await scheduler.close();
  const state = JSON.parse(await readFile(join(dataDir, 'broadcast.json'), 'utf8'));
  state.ledger[0].status = 'dispatching';
  state.history[0].status = 'dispatching';
  await writeFile(join(dataDir, 'broadcast.json'), JSON.stringify(state));
  let now = Date.parse('2026-09-19T01:01:00Z');
  let sent = 0;
  const restarted = new BroadcastScheduler({ dataDir, now: () => now, getSnapshot: () => sample, send: async () => { sent += 1; return { messageId: 'new' }; } });
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.snapshot().history[0].status, 'uncertain');
  now = Date.parse('2026-09-19T01:00:00Z'); // Clock moved backwards, still the same reserved slot.
  await restarted.tick();
  assert.equal(sent, 0);
  now = Date.parse('2026-09-20T01:00:00Z');
  await restarted.tick();
  assert.equal(sent, 1);
});

test('DST repeated minute sends only once and a skipped spring minute is not replayed', async t => {
  const { scheduler, sent, at } = await fixture(t, { at: '2026-11-01T05:29:00Z' });
  await scheduler.configure({ enabled: true, times: ['01:30'], timeZone: 'America/New_York' });
  at('2026-11-01T05:30:00Z');
  await scheduler.tick();
  at('2026-11-01T06:30:00Z');
  await scheduler.tick();
  assert.equal(sent.length, 1);
  at('2027-03-14T06:59:00Z');
  await scheduler.configure({ enabled: true, times: ['02:30'], timeZone: 'America/New_York' });
  at('2027-03-14T07:00:00Z');
  await scheduler.tick();
  assert.equal(sent.length, 1);
});

test('midnight schedules use the correct local date', async t => {
  const { scheduler, sent, at } = await fixture(t, { at: '2026-09-19T15:59:00Z' });
  await scheduler.configure({ enabled: true, times: ['00:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T16:00:00Z');
  await scheduler.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].metadata.slot, 'Asia/Shanghai|2026-09-20|00:00');
});

test('without a configured sender broadcast cannot be enabled and preview never sends', async t => {
  const { scheduler } = await fixture(t, { send: null });
  assert.equal(scheduler.snapshot().enabled, false);
  assert.equal(scheduler.snapshot().available, false);
  await assert.rejects(scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' }), /KOOK/);
  const preview = await scheduler.preview();
  assert.equal(preview.accountCount, 4);
  assert.match(preview.text, /账号额度/);
  assert.equal(scheduler.snapshot().history.length, 0);
});

test('configuration validation and save failure leave the previous effective configuration intact', async t => {
  const { scheduler } = await fixture(t);
  for (const config of [
    { enabled: true, times: [] },
    { enabled: true, times: ['24:00'] },
    { enabled: true, times: ['09:00'], timeZone: 'unknown/zone' },
    { enabled: 'yes', times: ['09:00'] },
  ]) await assert.rejects(scheduler.configure(config));
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  scheduler.writeState = async () => { throw new Error('disk error with PRIVATE_TOKEN'); };
  await assert.rejects(scheduler.configure({ enabled: false, times: ['10:00'], timeZone: 'UTC' }), /保存失败/);
  assert.equal(scheduler.snapshot().enabled, true);
  assert.deepEqual(scheduler.snapshot().times, ['09:00']);
  assert.match(scheduler.snapshot().storageError, /保存失败/);
  assert.doesNotMatch(JSON.stringify(scheduler.snapshot()), /PRIVATE_TOKEN/);
});

test('ledger save failure prevents a network send', async t => {
  const { scheduler, sent, at } = await fixture(t);
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  scheduler.writeState = async () => { throw new Error('disk failure'); };
  at('2026-09-19T01:00:00Z');
  await assert.rejects(scheduler.tick(), /保存失败/);
  assert.equal(sent.length, 0);
  await scheduler.tick();
  assert.equal(sent.length, 0);
});

test('a send timeout is uncertain and never automatically retried in the same slot', async t => {
  let calls = 0;
  const { scheduler, at } = await fixture(t, { sendTimeoutMs: 15, send: async () => { calls += 1; return new Promise(() => {}); } });
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T01:00:00Z');
  await scheduler.tick();
  assert.equal(scheduler.snapshot().history[0].status, 'uncertain');
  assert.match(scheduler.snapshot().lastError, /发送超时/);
  await scheduler.tick();
  assert.equal(calls, 1);
});

test('disabling during snapshot retrieval cancels the pending send', async t => {
  let resolveSnapshot;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const { scheduler, sent, at } = await fixture(t, { getSnapshot: () => { started(); return new Promise(resolve => { resolveSnapshot = resolve; }); } });
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T01:00:00Z');
  const running = scheduler.tick();
  await requested;
  await scheduler.configure({ enabled: false, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  resolveSnapshot(sample);
  await running;
  assert.equal(sent.length, 0);
  assert.equal(scheduler.snapshot().history[0].status, 'cancelled');
});

test('close promptly cancels a hanging snapshot and no late send follows', async t => {
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const { scheduler, sent, at } = await fixture(t, { getSnapshot: () => { started(); return new Promise(() => {}); } });
  await scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  at('2026-09-19T01:00:00Z');
  const running = scheduler.tick();
  await requested;
  await scheduler.close();
  await running;
  assert.equal(sent.length, 0);
  assert.equal(scheduler.snapshot().history[0].status, 'cancelled');
  await scheduler.tick();
  assert.equal(sent.length, 0);
});

test('corrupt state is preserved and broadcast stays disabled', async t => {
  const { scheduler, dataDir } = await fixture(t);
  await scheduler.close();
  const original = '{broken private state';
  await writeFile(join(dataDir, 'broadcast.json'), original);
  const restarted = new BroadcastScheduler({ dataDir, getSnapshot: () => sample, send: async () => { throw new Error('must not send'); } });
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.snapshot().enabled, false);
  assert.match(restarted.snapshot().storageError, /无法读取/);
  await assert.rejects(restarted.configure({ enabled: true, times: ['09:00'] }));
  assert.equal(await readFile(join(dataDir, 'broadcast.json'), 'utf8'), original);
});

test('history is bounded to twenty dispatch records and contains metadata only', async t => {
  const { scheduler, at } = await fixture(t);
  await scheduler.configure({ enabled: true, times: ['09:00'] });
  for (let day = 1; day <= 25; day += 1) {
    at(`2026-10-${String(day).padStart(2, '0')}T01:00:00Z`);
    await scheduler.tick();
  }
  const state = scheduler.snapshot();
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0].messageId, 'msg-25');
  assert.deepEqual(Object.keys(state.history[0]).sort(), ['at', 'messageId', 'slot', 'status']);
});

test('KOOK sender uses a fixed official URL and plain-text card without redirects or mentions', async () => {
  let request;
  const send = createKookSender({ token: 'TEST_PRIVATE_TOKEN', channelId: '1234567890123456', fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ code: 0, data: { msg_id: 'valid-message-1' } }), { status: 200 });
  } });
  assert.deepEqual(await send(buildSummary(sample)), { messageId: 'valid-message-1' });
  assert.equal(request.url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, 'Bot TEST_PRIVATE_TOKEN');
  const body = JSON.parse(request.init.body);
  assert.equal(body.type, 10);
  assert.equal(body.target_id, '1234567890123456');
  assert.equal(body.mention_all, undefined);
  const cards = JSON.parse(body.content);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].modules.every(module => module.text.type === 'plain-text' && module.text.content.length <= 1400));
  assert.doesNotMatch(body.content, /TEST_PRIVATE_TOKEN/);
});

test('KOOK error messages never reflect remote bodies, and ambiguous success remains uncertain', async () => {
  for (const [response, expectedCode, delivery] of [
    [() => new Response(JSON.stringify({ code: 40000, message: 'PRIVATE_RESPONSE', data: {} })), 'KOOK_API', 'rejected'],
    [() => new Response(JSON.stringify({ code: 0, data: {} })), 'KOOK_RESPONSE', 'uncertain'],
    [() => new Response('PRIVATE_RESPONSE', { status: 401 }), 'KOOK_HTTP', 'rejected'],
    [() => new Response('PRIVATE_RESPONSE', { status: 503 }), 'KOOK_HTTP', 'uncertain'],
    [() => new Response('PRIVATE_RESPONSE'), 'KOOK_RESPONSE', 'uncertain'],
    [() => { throw new Error('PRIVATE_NETWORK'); }, 'KOOK_NETWORK', 'uncertain'],
  ]) {
    const send = createKookSender({ token: 'TEST', channelId: '123456', fetchImpl: async () => response() });
    await assert.rejects(send('安全测试'), error => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.delivery, delivery);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
  }
});

test('KOOK delivers the same structured account cards as the preview without flattening them', async () => {
  const requests = [];
  const send = createKookSender({ token: 'fixture-private', channelId: '123456789', fetchImpl: async (url, init) => {
    requests.push(JSON.parse(init.body)); return Response.json({ code: 0, data: { msg_id: 'card-layout-fixture' } });
  } });
  const cards = buildBroadcastCards(sample, { dashboardUrl: 'https://quota.example.com/' });
  await send(buildSummary(sample), { cards });
  assert.deepEqual(JSON.parse(requests[0].content), cards);
  assert.ok(cards.flatMap(card => card.modules).some(module => module.type === 'header'));
  assert.ok(cards.flatMap(card => card.modules).some(module => module.type === 'divider'));
  for (const invalid of [[], [{ type: 'card', modules: [{ type: 'section', text: { type: 'kmarkdown', content: '(met)all(met)' } }] }]]) {
    await assert.rejects(send('unused fallback', { cards: invalid }), error => error.code === 'INVALID_MESSAGE' && error.delivery === 'not_sent');
  }
  assert.equal(requests.length, 1, 'invalid card metadata must never be posted');
});

test('KOOK sender validates target, message size and bounded responses before accepting success', async () => {
  assert.throws(() => createKookSender({ token: 'bad\nheader', channelId: '123456' }));
  assert.throws(() => createKookSender({ token: 'test', channelId: 'https://other.test' }));
  let requests = 0;
  const send = createKookSender({ token: 'test', channelId: '123456', fetchImpl: async () => {
    requests += 1;
    return new Response('x'.repeat(70000));
  } });
  await assert.rejects(send('x'.repeat(12001)));
  assert.equal(requests, 0);
  await assert.rejects(send('安全测试'), error => error.code === 'KOOK_RESPONSE');
  assert.equal(requests, 1);
});
