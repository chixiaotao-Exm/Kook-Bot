import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../src/broadcast.js';

const checkedAt = '2026-09-21T01:20:00Z';

function summarize(metrics, accountOverrides = {}) {
  return buildSummary({
    checkedAt,
    accounts: [{
      id: 'progress-account', name: '进度测试账号', platform: 'openai',
      schedulable: true, status: 'active', planLabel: 'Pro 5x',
      metrics, ...accountOverrides,
    }],
  });
}

function percentage(overrides = {}) {
  return { key: 'seven-day', label: '7d', kind: 'percent', scope: 'upstream', freshness: 'fresh', ...overrides };
}

function bars(text) {
  return [...text.matchAll(/^[ \t]+(?:🔋|🪫) \[([■□]+)\]▏/gm)].map(match => match[1]);
}

test('quota battery shows remaining charge alongside exact used and remaining percentages', () => {
  const text = summarize([percentage({ usedPercent: 38, remainingPercent: 62 })]);
  assert.match(text, /电池显示剩余额度/);
  assert.match(text, /7d 已用38% · 剩余62%\n\s+🔋 \[■■■■■■□□□□\]▏/);
  assert.deepEqual(bars(text), ['■■■■■■□□□□']);
  assert.deepEqual(bars('电池显示剩余额度'), []);
  assert.deepEqual(bars('  🔋 [■■■■□□□□□]▏'), ['■■■■□□□□□']);
});

test('zero, full, and over-limit usage have honest endpoint bars', () => {
  for (const [usedPercent, label, expected] of [
    [0, '已用0% · 剩余100%', '■■■■■■■■■■'],
    [100, '已用100% · 剩余0%', '□□□□□□□□□□'],
    [120, '已用120% · 剩余0%', '□□□□□□□□□□'],
  ]) {
    const text = summarize([percentage({ usedPercent })]);
    assert.ok(text.includes(label), text);
    assert.deepEqual(bars(text), [expected]);
    assert.doesNotMatch(text, /剩余−|剩余-/);
  }
});

test('small nonzero usage and nearly full usage remain distinguishable from endpoints', () => {
  const small = summarize([percentage({ usedPercent: 0.1 })]);
  const nearlyFull = summarize([percentage({ usedPercent: 99.9 })]);
  assert.match(small, /已用0\.1% · 剩余99\.9%/);
  assert.deepEqual(bars(small), ['■■■■■■■■■□']);
  assert.match(nearlyFull, /已用99\.9% · 剩余0\.1%/);
  assert.deepEqual(bars(nearlyFull), ['■□□□□□□□□□']);
  const tiny = summarize([percentage({ usedPercent: 0.0001 })]);
  assert.match(tiny, /已用<0\.01% · 剩余>99\.99%/);
  assert.deepEqual(bars(tiny), ['■■■■■■■■■□']);
  const barelyRemaining = summarize([percentage({ usedPercent: 99.9999 })]);
  assert.match(barelyRemaining, /已用>99\.99% · 剩余<0\.01%/);
  assert.deepEqual(bars(barelyRemaining), ['■□□□□□□□□□']);
});

test('remaining-only percentages infer usage and trusted usage takes precedence', () => {
  for (const [remainingPercent, expectedUsed, expectedBar] of [
    [100, 0, '■■■■■■■■■■'],
    [62, 38, '■■■■■■□□□□'],
    [0, 100, '□□□□□□□□□□'],
  ]) {
    const text = summarize([percentage({ remainingPercent })]);
    assert.ok(text.includes(`已用${expectedUsed}% · 剩余${remainingPercent}%`), text);
    assert.deepEqual(bars(text), [expectedBar]);
  }
  const contradictory = summarize([percentage({ usedPercent: 38, remainingPercent: 91 })]);
  assert.match(contradictory, /已用38% · 剩余62%/);
  assert.doesNotMatch(contradictory, /剩余91%/);
  for (const invalidUsed of [null, NaN, -1]) {
    const fallback = summarize([percentage({ usedPercent: invalidUsed, remainingPercent: 62 })]);
    assert.match(fallback, /已用38% · 剩余62%/);
    assert.deepEqual(bars(fallback), ['■■■■■■□□□□']);
  }
});

test('unavailable, non-finite and negative percentages stay unknown instead of empty bars', () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, '38']) {
    const text = summarize([percentage({ usedPercent: invalid, remainingPercent: invalid })]);
    assert.match(text, /7d 未知/);
    assert.deepEqual(bars(text), []);
    assert.doesNotMatch(text, /已用0%|剩余100%|NaN|Infinity/);
  }
  const invalidRemaining = summarize([percentage({ remainingPercent: 120 })]);
  assert.match(invalidRemaining, /7d 未知/);
  assert.deepEqual(bars(invalidRemaining), []);
});

test('progress retains old-sample and reset annotations rather than presenting stale use as current', () => {
  const text = summarize([percentage({
    usedPercent: 38, freshness: 'stale', observedAt: '2026-09-20T02:00:00Z',
    resetAt: '2026-09-22T01:30:00Z',
  })]);
  assert.match(text, /7d 已用38% · 剩余62%（旧）/);
  assert.match(text, /■■■■■■□□□□\]▏ · 重置09\/22 09:30/);
  assert.match(text, /旧采样 09\/20 10:00/);
  const unknownTime = summarize([percentage({ usedPercent: 38, freshness: 'unknown', resetAt: 'invalid' })]);
  assert.match(unknownTime, /7d 已用38% · 剩余62%（时间未知）/);
  assert.doesNotMatch(unknownTime, /重置/);
});

test('wallet balances, local money caps, hidden product shares and unknown API accounts do not invent quota bars', () => {
  const money = summarize([
    { key: 'balance', label: '余额', kind: 'balance', unit: 'USD', value: 57.15 },
    { key: 'local-limit', label: '消费限额', kind: 'count', scope: 'local', unit: 'USD', used: 20, remaining: 80, limit: 100, usedPercent: 20, remainingPercent: 80 },
    { key: 'grok-product-test', label: '产品占比', kind: 'percent', usedPercent: 60 },
  ]);
  assert.match(money, /余额 \$57\.15/);
  assert.match(money, /本站消费限额 剩余\$80\.00（已用\$20\.00\/\$100\.00）/);
  assert.match(money, /另1项见看板/);
  assert.deepEqual(bars(money), []);
  const unknown = summarize([], { type: 'apikey', planLabel: 'API 计费' });
  assert.match(unknown, /额度未知/);
  assert.deepEqual(bars(unknown), []);
});

test('many accounts with expanded progress bars stay within the default 4800-character broadcast limit', () => {
  const accounts = Array.from({ length: 100 }, (_, index) => ({
    id: String(index), name: `进度账户 ${index}`, platform: 'openai', schedulable: true,
    planLabel: 'Pro 5x',
    metrics: [
      percentage({ key: 'five-hour', label: '5h', usedPercent: 38, resetAt: '2026-09-21T02:00:00Z' }),
      percentage({ usedPercent: 99.9, resetAt: '2026-09-27T02:00:00Z' }),
    ],
  }));
  const text = buildSummary({ checkedAt, accounts }, { dashboardUrl: 'https://quota.example.com/' });
  assert.ok(text.length <= 4800, `message length ${text.length}`);
  assert.match(text, /100 个账号/);
  assert.match(text, /篇幅限制，另有 \d+ 个账号请在看板查看/);
  assert.match(text, /详情：https:\/\/quota\.example\.com\//);
  assert.ok(bars(text).length > 0);
  assert.ok(bars(text).every(bar => bar.length === 10), 'truncation must preserve whole progress bars');
});
