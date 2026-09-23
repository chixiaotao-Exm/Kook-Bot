import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccounts, Sub2apiClient } from '../src/sub2api.js';

const now = Date.parse('2026-09-19T12:00:00Z');
const recent = '2026-09-19T11:59:00Z';
const future = '2026-09-20T12:00:00Z';
const base = (id, platform, type, extra = {}) => ({ id, name: `${platform} ${id}`, platform, type, status: 'active', schedulable: true, extra });
const normalize = value => normalizeAccounts(value, { now });
const response = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
const client = fetchImpl => new Sub2apiClient({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-test-secret', fetchImpl, now: () => now, includeWindowStats: false });

test('OpenAI only real nonzero-length windows; reset is anchored to sample, no invented Token amount', () => {
  const [a] = normalize([base(4200, 'openai', 'oauth', {
    codex_primary_used_percent: 8, codex_primary_window_minutes: 10080, codex_primary_reset_after_seconds: 579417,
    codex_secondary_used_percent: 0, codex_secondary_window_minutes: 0, codex_secondary_reset_after_seconds: 0,
    codex_usage_updated_at: recent,
  })]);
  assert.equal(a.metrics.length, 1);
  const metric = a.metrics[0];
  assert.equal(metric.label, '7 天额度窗口');
  assert.equal(metric.usedPercent, 8);
  assert.equal(metric.remainingPercent, 92);
  assert.equal(metric.resetAt, new Date(Date.parse(recent) + 579417000).toISOString());
  assert.equal(metric.remaining, undefined);
  assert.equal(metric.freshness, 'fresh');
});

test('missing percent is unknown, but observed zero percent remains zero', () => {
  const rows = normalize([
    base(1, 'openai', 'oauth', { codex_primary_window_minutes: 300 }),
    base(2, 'openai', 'oauth', { codex_primary_window_minutes: 300, codex_primary_used_percent: 0, codex_usage_updated_at: recent }),
    base(3, 'anthropic', 'oauth', { passive_usage_7d_utilization: null }),
  ]);
  assert.equal(rows[0].metrics.length, 0);
  assert.equal(rows[0].freshness, 'unknown');
  assert.equal(rows[1].metrics[0].usedPercent, 0);
  assert.equal(rows[2].metrics.length, 0);
});

test('Claude passive utilization is fractional and window end comes from account DTO', () => {
  const raw = base(6271, 'anthropic', 'oauth', {
    session_window_utilization: 0.01, passive_usage_7d_utilization: 0.01,
    passive_usage_7d_reset: Date.parse(future) / 1000, passive_usage_sampled_at: recent,
  });
  raw.session_window_end = future;
  const [a] = normalize([raw]);
  assert.deepEqual(a.metrics.map(m => m.usedPercent), [1, 1]);
  assert.deepEqual(a.metrics.map(m => m.remainingPercent), [99, 99]);
  assert.equal(a.metrics[0].resetAt, new Date(future).toISOString());
  assert.equal(a.freshness, 'fresh');
});

test('expired Grok billing and header windows remain stale values, products have no independent remainder', () => {
  const [a] = normalize([base(5790, 'grok', 'oauth', {
    grok_billing_snapshot: {
      usage_percent: 14, period_type: 'weekly', period_end: '2026-09-12T12:00:00Z', updated_at: '2026-09-10T12:00:00Z',
      product_usage: [{ product: 'Grok Code', usage_percent: 7 }],
    },
    grok_usage_snapshot: { requests: { limit: 21, remaining: 21 }, tokens: { limit: 1000000, remaining: 1000000 }, updated_at: recent },
  })]);
  assert.equal(a.metrics[0].remainingPercent, 86);
  assert.equal(a.metrics[0].freshness, 'stale');
  assert.equal(a.metrics[1].usedPercent, 7);
  assert.equal(a.metrics[1].remainingPercent, undefined);
  assert.equal(a.metrics[2].remaining, 21);
  assert.equal(a.metrics[2].freshness, 'stale');
  assert.equal(a.metrics[3].freshness, 'stale');
  assert.equal(a.freshness, 'stale');
});

test('Grok currency values honor cents conversion and distinguish monthly scope from rate-limit headers', () => {
  const [a] = normalize([base(1, 'grok', 'oauth', {
    grok_billing_snapshot: { monthly_limit_cents: 15000, used_cents: 1000, prepaid_balance: 0, updated_at: recent, billing_period_end: future },
  })]);
  const monthly = a.metrics.find(m => m.key === 'grok-monthly');
  assert.equal(monthly.limit, 150);
  assert.equal(monthly.used, 10);
  assert.equal(monthly.remaining, 140);
  assert.equal(monthly.unit, 'USD');
  assert.equal(a.metrics.find(m => m.key === 'grok-prepaid').value, 0);
});

test('DeepSeek balances keep zero USD and CNY separate, missing balance is not zero', () => {
  const [a, b] = normalize([
    base(6268, 'deepseek', 'apikey', { deepseek_balance: 94.99, deepseek_balance_currency: 'CNY', deepseek_balances: [{ currency: 'USD', balance: 0 }, { currency: 'CNY', balance: 94.99 }], deepseek_balance_updated_at: Date.parse(recent) / 1000 }),
    base(6267, 'deepseek', 'apikey', { deepseek_balance_currency: 'CNY' }),
  ]);
  assert.deepEqual(a.metrics.map(m => [m.unit, m.value]), [['USD', 0], ['CNY', 94.99]]);
  assert.equal(a.freshness, 'fresh');
  assert.equal(b.metrics.length, 0);
});

test('API-key local spending caps are explicitly local; billing rate probe does not create quota', () => {
  const [a, b] = normalize([
    base(4201, 'openai', 'apikey', { quota_limit: 100, quota_used: 4, upstream_billing_probe: { status: 'ok', data: { resolved_rate_multiplier: 0.3 } } }),
    base(6273, 'openai', 'apikey', { upstream_billing_probe: { status: 'unsupported', last_error: 'secret upstream URL/key' } }),
  ]);
  assert.equal(a.metrics.length, 1);
  assert.equal(a.metrics[0].scope, 'local');
  assert.equal(a.metrics[0].remaining, 96);
  assert.equal(a.freshness, 'unknown');
  assert.equal(b.metrics.length, 0);
  assert.match(b.notes.join(' '), /不提供账户余额/);
  assert.equal(JSON.stringify(b).includes('secret upstream'), false);
});

test('unsupported accounts still appear; secrets and invalid account data never leak or suppress other cards', () => {
  const valid = base(1, 'gemini', 'oauth');
  valid.credentials = { api_key: 'never-show-this', access_token: 'never-show-this-either' };
  valid.extra = { unknown: 'never-show-extra' };
  valid.error_message = 'Bearer never-show-error';
  const [a, b, c] = normalize([valid, null, base(3, 'openai', 'oauth')]);
  assert.equal(a.platform, 'gemini');
  assert.equal(a.metrics.length, 0);
  assert.equal(b.error, '账号缓存格式不正确。');
  assert.equal(c.id, '3');
  assert.doesNotMatch(JSON.stringify(a), /never-show/);
});

test('OpenAI plan type alone is whitelisted from credential metadata', () => {
  const raw = base(1, 'openai', 'oauth');
  raw.credentials = { plan_type: 'plus', access_token: 'hidden-access-token', refresh_token: 'hidden-refresh-token' };
  const [a] = normalize([raw]);
  assert.equal(a.plan, 'plus');
  assert.doesNotMatch(JSON.stringify(a), /hidden-|credentials/);
});

test('missing/future sampling dates are unknown; past resets never silently reset usage', () => {
  const [a, b] = normalize([
    base(1, 'anthropic', 'oauth', { passive_usage_7d_utilization: 0.8, passive_usage_7d_reset: now / 1000 - 1 }),
    base(2, 'deepseek', 'apikey', { deepseek_balance: 8, deepseek_balance_currency: 'CNY', deepseek_balance_updated_at: future }),
  ]);
  assert.equal(a.metrics[0].remainingPercent, 20);
  assert.equal(a.metrics[0].freshness, 'stale');
  assert.equal(b.metrics[0].freshness, 'unknown');
});

test('client paginates account-list GET only and refresh never returns raw credentials', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get('page'));
    return response({ items: [{ ...base(page, 'openai', 'oauth'), credentials: { token: 'hidden-secret' } }], total: 2, page, page_size: 1 });
  });
  const result = await c.refresh();
  assert.equal(result.accounts.length, 2);
  assert.equal(result.checkedAt, new Date(now).toISOString());
  assert.doesNotMatch(JSON.stringify(result), /hidden-secret/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).pathname, '/api/v1/admin/accounts');
    assert.equal(new URL(call.url).origin, 'http://127.0.0.1:8080');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.headers['x-api-key'], 'admin-test-secret');
  }
});

test('client refuses redirects, sanitizes auth/network/JSON errors, and never reads response error payload', async () => {
  for (const [reply, code] of [
    [() => new Response('admin-secret', { status: 401 }), 'AUTH'],
    [() => new Response('admin-secret', { status: 302, headers: { location: 'https://attacker.invalid/' } }), 'REDIRECT'],
    [() => new Response('admin-secret', { status: 500 }), 'UPSTREAM'],
    [() => new Response('admin-secret'), 'FORMAT'],
    [() => { throw new Error('http://host/ admin-secret'); }, 'NETWORK'],
  ]) {
    let calls = 0;
    const c = client(async () => { calls++; return reply(); });
    await assert.rejects(c.refresh(), e => e.code === code && !/admin-secret|attacker|http:\/\/host/.test(e.message));
    assert.equal(calls, 1);
  }
});

test('concurrent refresh is single-flight; duplicate/incomplete pagination fails without partial success', async () => {
  let release;
  const pending = new Promise(resolve => release = resolve);
  let calls = 0;
  const c = client(async () => { calls++; await pending; return response({ items: [base(1, 'openai', 'oauth')], total: 1 }); });
  const p = c.refresh(), q = c.refresh();
  release();
  const [a, b] = await Promise.all([p, q]);
  assert.equal(calls, 1);
  assert.strictEqual(a, b);
  for (const empty of [false, true]) {
    let pages = 0;
    const bad = client(async () => response({ items: ++pages === 2 && empty ? [] : [base(1, 'openai', 'oauth')], total: 2 }));
    await assert.rejects(bad.refresh(), e => e.code === 'PAGINATION');
  }
});

const usageRow = (id, accountId, createdAt, overrides = {}) => ({ id, account_id: accountId, created_at: createdAt,
  input_tokens: 10, output_tokens: 20, cache_creation_tokens: 30, cache_read_tokens: 40,
  total_cost: 0.1, actual_cost: 0.3, account_rate_multiplier: 2, ...overrides });
const statsClient = (fetchImpl, overrides = {}) => new Sub2apiClient({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-test-secret', fetchImpl, now: () => now, ...overrides });

test('real quota windows and fallback rolling windows remain explicitly separate; expired windows never aligned', () => {
  const resetAt = new Date(now + 86400000).toISOString();
  const [a, b] = normalize([
    base(1, 'openai', 'oauth', { codex_primary_window_minutes: 10080, codex_primary_used_percent: 13, codex_primary_reset_at: resetAt, codex_usage_updated_at: recent, codex_secondary_window_minutes: 0, codex_secondary_used_percent: 0 }),
    base(2, 'grok', 'oauth', { grok_billing_snapshot: { usage_percent: 14, period_type: 'weekly', period_end: '2026-09-12T12:00:00Z', updated_at: recent } }),
  ]);
  assert.equal(a.windowStats[0].periodKind, 'rolling');
  assert.equal(a.windowStats[0].metricKey, null);
  assert.equal(a.windowStats[1].periodKind, 'quota');
  assert.equal(a.windowStats[1].metricKey, 'codex-primary');
  assert.equal(a.windowStats[1].periodStart, new Date(now - 6 * 86400000).toISOString());
  assert.equal(b.windowStats[1].periodKind, 'rolling');
});

test('window stats filter exact timestamps, include cache tokens and honor account pricing snapshot', async () => {
  const raw = base(1, 'openai', 'oauth', { codex_primary_window_minutes: 10080, codex_primary_used_percent: 13, codex_primary_reset_at: future, codex_usage_updated_at: recent });
  const logs = [
    usageRow(1, 1, new Date(now - 7 * 86400000).toISOString()), // outside true seven-day quota window
    usageRow(2, 1, new Date(now - 6 * 86400000).toISOString(), { account_stats_cost: 0.4 }), // exact start inclusive
    usageRow(3, 1, new Date(now - 3600000).toISOString()),
    usageRow(4, 1, new Date(now).toISOString()), // exclusive end
  ];
  const calls = [];
  const c = statsClient(async (url, options) => {
    calls.push({ url, options });
    if (new URL(url).pathname.endsWith('/accounts')) return response({ items: [raw], total: 1 });
    return response({ items: logs, total: logs.length });
  });
  const { accounts: [a] } = await c.refresh();
  const [five, seven] = a.windowStats;
  assert.equal(five.requests, 1);
  assert.equal(five.tokens, 100);
  assert.equal(five.accountCost, 0.2);
  assert.equal(five.userCost, 0.3);
  assert.equal(five.estimatedTotalCost, null);
  assert.equal(seven.requests, 2);
  assert.equal(seven.tokens, 200);
  assert.equal(seven.accountCost, 1);
  assert.equal(seven.standardCost, 0.2);
  assert.equal(seven.userCost, 0.6);
  assert.equal(seven.estimatedTotalCost, 1 / 0.13);
  assert.equal(seven.complete, true);
  assert.equal(seven.observedAt, new Date(now).toISOString());
  for (const call of calls) {
    assert.ok(['/api/v1/admin/accounts', '/api/v1/admin/usage'].includes(new URL(call.url).pathname));
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
  }
  const usageUrl = new URL(calls[1].url);
  assert.equal(usageUrl.searchParams.get('account_id'), '1');
  assert.equal(usageUrl.searchParams.get('timezone'), 'UTC');
  assert.equal(usageUrl.searchParams.get('sort_order'), 'asc');
});

test('zero or stale quota percent never generates a full-cost estimate', async () => {
  const accounts = [0, 13].map((used, index) => base(index + 1, 'openai', 'oauth', {
    codex_primary_window_minutes: 10080, codex_primary_used_percent: used, codex_primary_reset_at: future,
    codex_usage_updated_at: index === 0 ? recent : '2026-09-10T12:00:00Z',
  }));
  const c = statsClient(async url => {
    const u = new URL(url);
    return u.pathname.endsWith('/accounts') ? response({ items: accounts, total: 2 })
      : response({ items: [usageRow(1, Number(u.searchParams.get('account_id')), recent)], total: 1 });
  });
  const result = await c.refresh();
  assert.ok(result.accounts.every(a => a.windowStats.every(w => w.estimatedTotalCost === null)));
});

test('local stats cache lasts 300 seconds and never stores or returns usage identity metadata', async () => {
  let clock = now, usageCalls = 0;
  const c = statsClient(async url => {
    if (new URL(url).pathname.endsWith('/accounts')) return response({ items: [base(1, 'openai', 'oauth')], total: 1 });
    usageCalls++;
    return response({ items: [usageRow(1, 1, recent, { user: { email: 'private@example.test' }, api_key: { key: 'sk-secret-from-logs' }, ip_address: 'private-ip' })], total: 1 });
  }, { now: () => clock });
  const first = await c.refresh();
  clock += 120000;
  const second = await c.refresh();
  assert.equal(usageCalls, 1);
  assert.notEqual(first.checkedAt, second.checkedAt);
  assert.equal(first.accounts[0].windowStats[0].observedAt, second.accounts[0].windowStats[0].observedAt);
  assert.doesNotMatch(JSON.stringify(second), /private@|private-ip|sk-secret|api_key/);
  clock += 180001;
  await c.refresh();
  assert.equal(usageCalls, 2);
});

test('usage pagination truncation is unknown, not a partial total; account failure does not hide other stats', async () => {
  let pages = 0;
  const c = statsClient(async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/accounts')) return response({ items: [base(1, 'deepseek', 'apikey'), base(2, 'openai', 'oauth'), base(3, 'grok', 'oauth')], total: 3 });
    const accountId = Number(u.searchParams.get('account_id'));
    if (accountId === 2) return new Response('private error info', { status: 500 });
    if (accountId === 3) return response({ items: [], total: 0 });
    pages++;
    return response({ items: [usageRow(pages, 1, recent)], total: 21, page_size: 1 });
  });
  const { accounts } = await c.refresh();
  assert.equal(pages, 20);
  assert.equal(accounts[0].windowStats[0].complete, false);
  assert.equal(accounts[0].windowStats[0].requests, null);
  assert.match(accounts[0].windowStats[0].error, /上限/);
  assert.equal(accounts[1].windowStats[0].complete, false);
  assert.equal(accounts[1].windowStats[0].accountCost, null);
  assert.equal(accounts[2].windowStats[0].complete, true);
  assert.equal(accounts[2].windowStats[0].requests, 0);
  assert.doesNotMatch(JSON.stringify(accounts), /private error/);
});

test('reset-card zero is supported by dated no-credit state; absent/expired cards never become balance', () => {
  const [a, b, c] = normalize([
    base(1, 'openai', 'oauth', { codex_auto_reset_credit_state: { status: 'no_credit', checked_at: recent } }),
    base(2, 'openai', 'oauth', { codex_auto_reset_credit_state: { status: 'no_credit' } }),
    base(3, 'openai', 'oauth', { codex_reset_credit_snapshot: { available_count: 2, credits: [{ expires_at: '2026-09-01T00:00:00Z', token: 'secret-credit' }] } }),
  ]);
  assert.equal(a.resetCredits.availableCount, 0);
  assert.equal(a.resetCredits.freshness, 'fresh');
  assert.match(a.resetCredits.note, /不表示账号没有可用额度/);
  assert.equal(b.resetCredits.availableCount, null);
  assert.equal(c.resetCredits.availableCount, null);
  assert.equal(c.resetCredits.cachedCount, 2);
  assert.equal(c.resetCredits.freshness, 'stale');
  assert.doesNotMatch(JSON.stringify(c), /secret-credit/);
});

test('local usage readers never exceed two concurrent accounts', async () => {
  let active = 0, peak = 0;
  const c = statsClient(async url => {
    if (new URL(url).pathname.endsWith('/accounts')) return response({ items: [1, 2, 3, 4, 5, 6].map(id => base(id, 'openai', 'oauth')), total: 6 });
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return response({ items: [], total: 0 });
  });
  const result = await c.refresh();
  assert.equal(peak, 2);
  assert.equal(result.accounts.length, 6);
  assert.ok(result.accounts.every(a => a.windowStats.every(w => w.complete)));
});
