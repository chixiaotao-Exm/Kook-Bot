// Isolated UI verification. All credentials, quota responses and KOOK data are fixtures.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'screenshots');
fs.mkdirSync(output, { recursive: true });
const observedAt = new Date().toISOString();
const oldAt = new Date(Date.now() - 86400000).toISOString();
const resetAt = new Date(Date.now() + 7200000).toISOString();
const quota = (key, label, usedPercent, freshness = 'fresh') => ({ key, label, kind: 'percent', scope: 'upstream', unit: '%', usedPercent, remainingPercent: 100 - usedPercent, observedAt: freshness === 'fresh' ? observedAt : oldAt, resetAt, freshness });
const accounts = [
  { id: '4200', name: 'OpenAI 主力账号', platform: 'openai', type: 'oauth', plan: 'plus', status: 'active', source: 'sub2api-cache', observedAt, freshness: 'fresh', metrics: [quota('primary', '5 小时额度窗口', 37), quota('secondary', '7 天额度窗口', 12)] },
  { id: '6271', name: 'Claude 日常开发', platform: 'anthropic', type: 'oauth', status: 'active', source: 'sub2api-cache', observedAt: oldAt, freshness: 'stale', metrics: [quota('session', '5 小时额度窗口', 83, 'stale')] },
  { id: '6268', name: 'DeepSeek 官方账户', platform: 'deepseek', type: 'apikey', status: 'active', source: 'sub2api-cache', observedAt, freshness: 'fresh', metrics: [{ key: 'balance', label: 'CNY 余额', kind: 'balance', scope: 'upstream', unit: 'CNY', value: 42.5834, observedAt, freshness: 'fresh' }] },
  { id: '5790', name: 'Grok 研究账户', platform: 'grok', type: 'oauth', status: 'error', source: 'sub2api-cache', observedAt: oldAt, freshness: 'stale', metrics: [{ ...quota('grok-product-0', 'Grok 4 用量占比', 14, 'stale'), remainingPercent: undefined, note: '占整个账单额度的比例，不代表该产品拥有独立额度。' }], error: '上游返回账号异常，当前保留历史记录。' },
  { id: '4201', name: 'OpenAI 兼容供应商', platform: 'openai', type: 'apikey', status: 'active', source: 'sub2api-cache', observedAt: null, freshness: 'unknown', metrics: [], notes: ['上游未提供可用额度查询。'] },
  { id: '6273', name: '备用 API Key', platform: 'openai', type: 'apikey', status: 'active', source: 'sub2api-cache', observedAt: null, freshness: 'unknown', metrics: [{ key: 'quota', label: '本站设置的总消费限额', kind: 'count', scope: 'local', unit: 'USD', limit: 100, used: 17, remaining: 83, usedPercent: 17, remainingPercent: 83, observedAt: null, freshness: 'unknown', note: '本站消费限额不代表上游余额。' }] }
];
accounts[0].schedulable = true;
accounts[1].schedulable = false;
accounts[3].schedulable = true;
accounts[0].windowStats = [
  { key: '5h', label: '5 小时本站用量', source: 'sub2api-local-usage', scope: 'local', periodStart: new Date(Date.now() - 18000000).toISOString(), periodEnd: observedAt, periodKind: 'quota', metricKey: 'primary', requests: 128, tokens: 1586789, accountCost: 8.1256, userCost: 10.55, standardCost: 6.12, currency: 'USD', estimatedTotalCost: 21.9611, observedAt, complete: true, note: 'A 为账号侧费用，U 为用户费用，预计值不是余额。' },
  { key: '7d', label: '7 天本站用量', source: 'sub2api-local-usage', scope: 'local', periodStart: new Date(Date.now() - 604800000).toISOString(), periodEnd: observedAt, periodKind: 'quota', metricKey: 'secondary', requests: 2890, tokens: 45123456, accountCost: 128.12, userCost: 173.55, standardCost: 88.12, currency: 'USD', estimatedTotalCost: null, observedAt, complete: true }
];
accounts[0].resetCredits = { availableCount: 0, cachedCount: 0, status: 'no_credit', checkedAt: observedAt, expiresAt: [], freshness: 'fresh', note: '重置卡次数不是 Token 或金额额度。' };
accounts[4].windowStats = [{ key: 'rolling-5h', label: '最近 5 小时本站用量', periodStart: new Date(Date.now() - 18000000).toISOString(), periodEnd: observedAt, periodKind: 'rolling', metricKey: null, requests: null, tokens: null, accountCost: null, userCost: null, estimatedTotalCost: null, currency: 'USD', observedAt, complete: false, error: '本时段统计暂不可读取。' }];
accounts[4].windowStats.push({ key: 'tiny-7d', label: '最近 7 天本站用量', periodKind: 'rolling', requests: 1, tokens: 100, accountCost: 0.003, userCost: 0, currency: 'USD', observedAt: oldAt, freshness: 'stale', complete: true });
let authenticated = false;
let statusFailure = false;
let config = { enabled: false, times: ['09:00'], timeZone: 'Asia/Shanghai', configured: true, channelId: '123456789', channelName: '111', botName: 'bug' };
const writes = [];
const csrf = 'fixture-csrf';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/quota/api/')) {
    const endpoint = url.pathname.slice('/quota/api/'.length);
    let body = '';
    for await (const chunk of req) body += chunk;
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (endpoint === 'session') return json(200, { authenticated, csrf, user: authenticated ? { email: 'admin@example.test', role: 'admin' } : undefined });
    if (req.method === 'POST' && req.headers['x-csrf-token'] !== csrf) return json(403, { error: 'CSRF missing' });
    if (endpoint === 'login') {
      writes.push({ endpoint, data });
      if (data.email === 'admin@example.test' && data.password === 'fixture-password' || data.token === 'fixture-jwt') { authenticated = true; return json(200, { authenticated, csrf, user: { email: 'admin@example.test', role: 'admin' } }); }
      return json(401, { error: '管理员登录失败' });
    }
    if (!authenticated) return json(401, { error: '请先登录' });
    if (endpoint === 'logout') { authenticated = false; return json(200, { ok: true }); }
    if (endpoint === 'status' || endpoint === 'refresh') {
      if (endpoint === 'refresh') writes.push({ endpoint, data });
      if (statusFailure) return json(503, { error: '上游暂时不可用' });
      return json(200, { accounts, updatedAt: observedAt, refreshing: false, lastError: null });
    }
    if (endpoint === 'report-config') { if (req.method === 'POST') { writes.push({ endpoint, data }); config = { ...config, ...data }; } return json(200, config); }
    if (endpoint === 'reports') return json(200, { records: [{ status: 'sent', sentAt: observedAt, message: '每日额度汇总已发送到 #111' }, { status: 'failed', sentAt: oldAt, error: 'KOOK 暂时无法连接，未重复发送。' }] });
    if (endpoint === 'report-preview') return json(200, { text: 'Sub2API 每日额度汇总\n\n6 个账号 · 4 个有额度数据\nOpenAI · 主力账号\n5 小时额度：已用 37%\nDeepSeek · 余额 42.5834 CNY\n\nClaude / Grok：包含旧缓存\nOpenAI API Key：上游额度未知\n\n以各账号采样时间为准。' });
    return json(404, { error: 'Unknown fixture endpoint' });
  }
  const files = { '/quota/': 'index.html', '/quota/index.html': 'index.html', '/quota/app.js': 'app.js', '/quota/style.css': 'style.css' };
  if (!files[url.pathname]) { res.writeHead(404); return res.end(); }
  const file = files[url.pathname];
  res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(file)]);
  res.end(fs.readFileSync(path.join(root, 'public', file)));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/quota/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(output, 'quota-login-desktop.png'), fullPage: true });
    await page.locator('#existing-login').click();
    await page.locator('#login-error').waitFor({ state: 'visible' });
    check((await page.locator('#login-error').innerText()).includes('没有找到'), 'No-token message is actionable');
    await page.locator('[name=email]').fill('admin@example.test');
    await page.locator('[name=password]').fill('fixture-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('.account-card').first().waitFor();
    check(await page.locator('.account-card').count() === 6, 'Every account visible');
    check(await page.locator('[data-account-id="6268"] .balance-value').innerText() === '42.58CNY', 'Balance shows compact source amount with its currency');
    check(await page.locator('[data-account-id="4201"] [role=meter]').count() === 0, 'Unknown quota is never displayed as 0%');
    check(await page.locator('[data-account-id="6273"] .unknown-block').count() === 1, 'Local limit does not masquerade as upstream balance');
    check(!(await page.locator('[data-account-id="5790"]').innerText()).includes('86%'), 'Product bill component does not invent remaining quota');
    check((await page.locator('#summary .summary-card').nth(1).innerText()).includes('4'), 'Summary only counts upstream values');
    check(await page.locator('[data-account-id="6271"].stale').count() === 1, 'Old account marked stale');
    check(await page.locator('[data-account-id="4200"] .quota-window .window-stats').count() === 2, 'Window usage is attached to its matching 5h and 7d quota');
    check((await page.locator('[data-window-key="5h"]').innerText()).includes('1.59M'), 'Token count uses readable compact units');
    check((await page.locator('[data-window-key="5h"]').innerText()).includes('$8.13') && (await page.locator('[data-window-key="5h"]').innerText()).includes('$10.55'), 'A and U costs remain separate');
    check((await page.locator('[data-window-key="5h"] .cost-estimate').innerText()).includes('估算'), 'Projected total is labeled estimate');
    check(/0\s*次/.test(await page.locator('[data-account-id="4200"] [data-reset-credits]').innerText()) && (await page.locator('[data-account-id="4200"] [data-reset-credits]').innerText()).includes('缓存记录'), 'Reset-credit cached zero is explicit and separate');
    check(!(await page.locator('[data-window-key="rolling-5h"]').innerText()).includes('$0'), 'Unknown window stats never become zero spending');
    check((await page.locator('[data-window-key="tiny-7d"]').innerText()).includes('$<0.01'), 'Tiny nonzero spending never rounds to zero');
    check((await page.locator('[data-window-key="tiny-7d"] .window-stat').nth(3).innerText()).includes('$0'), 'Actual zero spending remains zero');
    check((await page.locator('[data-window-key="tiny-7d"] .window-freshness').innerText()).includes('旧缓存'), 'Window-level stale usage stays visible outside details');
    check(await page.locator('.account-details[open]').count() === 0, 'Account explanations start collapsed');
    check((await page.locator('[data-window-key="5h"] .window-stat').nth(1).locator('dd').getAttribute('title')).includes('1,586,789'), 'Exact Token count remains available in title');
    check(await page.locator('[data-window-key="7d"] .cost-estimate').count() === 0, 'Unknown estimates are omitted instead of repeated');
    await page.locator('[data-account-id="4200"] summary').click();
    check((await page.locator('[data-account-id="4200"] .account-details-body').innerText()).includes('1,586,789') && (await page.locator('[data-account-id="4200"] .account-details-body').innerText()).includes('8.1256'), 'Expanded details retain full raw counts and cost precision');
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    check(await page.locator('[data-account-id="4200"] details').getAttribute('open') !== null, 'Refresh preserves expanded account details');
    await page.locator('[data-platform=deepseek]').click();
    check(await page.locator('.account-details[open]').count() === 0, 'Filtering never transfers expansion to a different account');
    await page.locator('[data-platform=all]').click();
    check(await page.locator('[data-account-id="4200"] details').getAttribute('open') !== null, 'Returning to an account retains its expansion');
    await page.locator('[data-account-id="4200"] summary').click();
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    check(await page.locator('.account-details[open]').count() === 0, 'Closing details survives refresh');
    await page.screenshot({ path: path.join(output, 'quota-desktop.png'), fullPage: true });
    await page.locator('[data-platform=deepseek]').click();
    check(await page.locator('.account-card').count() === 1, 'Platform filter works');
    await page.locator('[data-platform=all]').click();
    await page.locator('#search').fill('4201');
    check(await page.locator('.account-card').count() === 1, 'ID search works');
    await page.locator('#search').fill('not-present');
    check(await page.locator('#empty-state').isVisible(), 'Empty search result is clear');
    await page.locator('#reset-filters').click();
    await page.locator('#status-filter').selectOption('unknown');
    check(await page.locator('.account-card').count() === 2, 'Unknown filter excludes local-only quota');
    await page.locator('#status-filter').selectOption('all');
    statusFailure = true;
    await page.locator('#refresh').click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    check(await page.locator('.account-card').count() === 6, 'Failed refresh retains every previous account');
    statusFailure = false;
    await page.locator('[data-view=reports]').click();
    await page.locator('#report-destination strong').waitFor();
    check((await page.locator('#report-preview').innerText()).includes('6 个账号'), 'Preview from backend displayed');
    await page.locator('#report-form [name=times]').fill('25:00');
    await page.locator('#save-report').click();
    check((await page.locator('#report-feedback').innerText()).includes('有效时间'), 'Invalid schedule blocked');
    await page.locator('#report-form [name=times]').fill('09:00, 18:00, 09:00');
    await page.locator('#report-form [name=enabled]').check();
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(JSON.stringify(config.times) === JSON.stringify(['09:00', '18:00']), 'Schedule times canonicalized');
    check(config.enabled === true && config.timeZone === 'Asia/Shanghai', 'Schedule enabled and timezone preserved');
    const writesBeforePreset = writes.length;
    await page.locator('#report-form [name=cadence]').selectOption('quarter-hour');
    check(await page.locator('#report-custom-times').isHidden(), 'Quarter-hour preset hides 96 individual times');
    check((await page.locator('#report-schedule-summary').innerText()).includes('每15分钟（整点、15、30、45分）'), 'Quarter-hour schedule has compact and accurate summary');
    check(writes.length === writesBeforePreset, 'Selecting preset does not save or send');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => !document.querySelector('#report-feedback').hidden && document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(config.times.length === 96 && config.times.every((time, index) => time === `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`), 'Preset saves all 96 sorted quarter-hour slots including midnight and 23:45');
    await page.reload();
    await page.locator('[data-view=reports]').click();
    await page.waitForFunction(() => document.querySelector('[name=cadence]').value === 'quarter-hour');
    check(await page.locator('#report-custom-times').isHidden(), 'Saved quarter-hour schedule is recognized after reload');
    check(!writes.some(write => /send/.test(write.endpoint)), 'No immediate message endpoint called');
    await page.screenshot({ path: path.join(output, 'quota-reports-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'quota-reports-mobile.png'), fullPage: true });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile reports do not overflow');
    await page.setViewportSize({ width: 360, height: 800 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Quarter-hour settings fit narrow mobile screens');
    await page.locator('#report-form [name=cadence]').selectOption('custom');
    await page.locator('#report-form [name=times]').fill('08:30, 20:30');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => !document.querySelector('#report-feedback').hidden && document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(JSON.stringify(config.times) === JSON.stringify(['08:30', '20:30']), 'Custom daily schedule remains editable after preset');
    await page.locator('[data-view=overview]').click();
    await page.screenshot({ path: path.join(output, 'quota-mobile.png'), fullPage: true });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overview does not overflow');
    await page.setViewportSize({ width: 360, height: 800 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow mobile overview does not overflow');
    await page.locator('#mobile-logout').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    check(await page.locator('#login-view').isVisible(), 'Mobile users can log out');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem('auth_token', 'fixture-jwt'));
    await page.locator('#existing-login').click();
    await page.locator('.account-card').first().waitFor();
    check(writes.some(write => write.endpoint === 'login' && write.data.token === 'fixture-jwt'), 'Explicit existing-session login uses original auth_token');
    check(await page.evaluate(() => !localStorage.getItem('quota_admin_key') && !localStorage.getItem('quota_token')), 'No new browser credentials persisted');
    check(errors.length === 0, `No uncaught browser errors: ${errors.join(', ')}`);
    console.log(`UI checks passed: ${passed}. Screenshots: ${output}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
