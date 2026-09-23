import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../src/broadcast.js';

const checkedAt = '2026-09-21T00:00:00Z';

function account(overrides = {}) {
  return {
    id: 'account-1',
    name: 'OpenAI_5X',
    platform: 'openai',
    type: 'oauth',
    status: 'active',
    schedulable: false,
    planLabel: 'Pro 5x',
    planSource: 'upstream',
    freshness: 'fresh',
    observedAt: checkedAt,
    metrics: [{
      key: 'five-hour', label: '5 小时额度', kind: 'percent', scope: 'upstream',
      remainingPercent: 62, resetAt: '2026-09-21T05:00:00Z', freshness: 'fresh',
    }],
    ...overrides,
  };
}

function snapshot(accounts) {
  return { checkedAt, updatedAt: checkedAt, accounts };
}

test('美化播报保留标题、状态摘要、平台分组、套餐标签和更新时间', () => {
  const text = buildSummary(snapshot([
    account(),
    account({ id: 'account-2', name: 'Claude Team', platform: 'anthropic', planLabel: 'Team Pro', schedulable: true, metrics: [] }),
    account({ id: 'account-3', name: 'DeepSeek 余额', platform: 'deepseek', type: 'apikey', planLabel: 'API 计费', schedulable: undefined, metrics: [] }),
  ]));

  assert.match(text, /✨ Sub2API 额度播报/);
  assert.match(text, /📊 账号额度 · 3 个账号/);
  assert.match(text, /✅ 开启 1 · ⚪ 关闭 1 · ⚠ 异常 0/);
  assert.match(text, /【Claude · 1 个】/);
  assert.match(text, /【DeepSeek · 1 个】/);
  assert.match(text, /【OpenAI · 1 个】/);
  assert.match(text, /▸ OpenAI_5X · Pro 5x · 关闭/);
  assert.match(text, /▸ Claude Team · Team Pro · 开启/);
  assert.match(text, /▸ DeepSeek 余额 · API 计费 · 调度未知/);
  assert.match(text, /5h额度 已用38% · 剩余62%\n  🔋 \[■■■■■■□□□□\]▏ · 重置09\/21 13:00/);
  assert.match(text, /━━━━━━━━/);
  assert.match(text, /🕒 更新 09\/21 08:00（北京时间）/);
  assert.match(text, /未知≠0，旧值仅参考/);
});

test('播报格式只使用清理后的公开字段，不泄露凭据、URL 或内部元数据', () => {
  const input = snapshot([account({
    name: 'OpenAI_5X admin-1234567890abcdef1234567890abcdef @everyone',
    planLabel: 'Authorization: Bearer PRIVATE_PLAN',
    credentials: { access_token: 'PRIVATE_ACCESS_TOKEN' },
    error: 'access_token=PRIVATE_ERROR https://private.example/internal',
    notes: ['PRIVATE_NOTE'],
  })]);
  const text = buildSummary(input, { dashboardUrl: 'https://quota.example/?admin=secret#token' });

  assert.match(text, /查询异常/);
  assert.doesNotMatch(text, /1234567890abcdef|PRIVATE_|@everyone|private\.example|admin=secret|#token/);
  assert.doesNotMatch(text, /credentials|planSource|access_token/);
  assert.match(text, /详情：https:\/\/quota\.example\//);
});

test('账号数量较多时播报保持在 KOOK 安全长度并提示未展示账号数', () => {
  const accounts = Array.from({ length: 120 }, (_, id) => account({
    id: `account-${id}`,
    name: `账号-${id}-${'长名称'.repeat(8)}`,
  }));
  const text = buildSummary(snapshot(accounts));

  assert.ok(text.length <= 4800, `播报长度 ${text.length} 超出 KOOK 文本预算`);
  assert.match(text, /📊 账号额度 · 120 个账号/);
  assert.match(text, /篇幅限制，另有 \d+ 个账号请在看板查看/);
  assert.match(text, /🕒 更新 .*北京时间/);
});

test('短文本预算仍保留标题、更新时间和截断说明', () => {
  const accounts = Array.from({ length: 30 }, (_, id) => account({ id, name: `账号-${id}` }));
  const text = buildSummary(snapshot(accounts), { maxLength: 900, dashboardUrl: 'https://quota.example/' });

  assert.ok(text.length <= 900);
  assert.match(text, /✨ Sub2API 额度播报/);
  assert.match(text, /篇幅限制，另有 \d+ 个账号请在看板查看/);
  assert.match(text, /🕒 更新 .*北京时间/);
});
