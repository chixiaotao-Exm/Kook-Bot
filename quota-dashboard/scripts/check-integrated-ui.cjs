// Exercises the shipped HTTP/auth/dashboard/scheduler modules with isolated data and fake upstreams.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const [{ Dashboard }, { BroadcastScheduler }, { QuotaServer }, { Sub2apiClient }, { NewApiAccountSource }] = await Promise.all([import('../src/dashboard.js'), import('../src/broadcast.js'), import('../src/server.js'), import('../src/sub2api.js'), import('../src/newapi.js')]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-ui-integration-'));
  let failUpstream = false, sent = 0;
  const now = Date.now();
  const rawAccounts = [
    { id: 1, name: '集成测试 OpenAI', platform: 'openai', type: 'oauth', status: 'active', extra: { codex_plan_type: 'plus', codex_usage_updated_at: new Date(now).toISOString(), codex_primary_window_minutes: 300, codex_primary_used_percent: 28, codex_primary_reset_at: new Date(now + 3600000).toISOString(), codex_reset_credit_snapshot: { available_count: 0, credits: [] }, codex_auto_reset_credit_state: { status: 'no_credit', checked_at: new Date(now).toISOString() } } },
    { id: 2, name: '<img src=x onerror=alert(1)>', platform: 'deepseek', type: 'apikey', status: 'active', extra: { deepseek_balance: 56.78, deepseek_balance_currency: 'CNY', deepseek_balance_updated_at: new Date(now).toISOString() } },
    { id: 3, name: '上游未知，本站有消费限额', platform: 'openai', type: 'apikey', status: 'active', extra: { quota_limit: 100, quota_used: 25 } },
    { id: 4, name: '小鸡毛只读查询', platform: 'openai', type: 'apikey', status: 'active', schedulable: false, extra: {} }
  ];
  const source = new Sub2apiClient({ baseUrl: 'http://fixture.test', adminApiKey: 'fixture-only-key', now: () => now, fetchImpl: async input => {
    const url = new URL(input);
    const accountId = Number(url.searchParams.get('account_id'));
    const items = url.pathname.endsWith('/accounts') ? rawAccounts : [{ id: 101 + accountId, account_id: accountId, created_at: new Date(now - 60000).toISOString(), input_tokens: 1000, output_tokens: 200, cache_creation_tokens: 30, cache_read_tokens: 40, total_cost: 1.2, actual_cost: 2.4, account_rate_multiplier: 1.5 }];
    return new Response(JSON.stringify({ code: 0, data: { items, total: items.length, pages: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const newapi = new NewApiAccountSource({ accountId: '4', queryKey: 'fixture-query-only', fetchImpl: async (input) => {
    const route = new URL(input).pathname;
    const data = route === '/api/status' ? { quota_per_unit: 500000, quota_display_type: 'USD', price: 5 } : route === '/api/user/self' ? { quota: 5000035198613, used_quota: 842903443, request_count: 18950 } : route === '/api/subscription/self' ? { subscriptions: [] } : route === '/api/user/quota_grants' ? { items: [] } : { enabled: true, exempt: true };
    return Response.json({ success: true, data });
  } });
  const dashboard = await new Dashboard({ dataDir, providers: [newapi], client: { async refresh() { if (failUpstream) throw new Error('fixture'); return source.refresh(); } } }).init();
  await dashboard.refresh();
  const scheduler = new BroadcastScheduler({ dataDir, getSnapshot: () => dashboard.snapshot(), send: async () => { sent++; return { messageId: 'never' }; }, dashboardUrl: 'http://localhost/quota/' });
  await scheduler.init();
  const server = new QuotaServer({ host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:1', dashboard, scheduler, preview: true, reporter: { channelId: 'fixture-channel', channelName: '测试频道', botName: '测试机器人' } });
  const address = await server.start();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.quotaTimers = new Map();
    const originalSetTimeout = window.setTimeout.bind(window), originalClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      const id = originalSetTimeout(() => { window.quotaTimers.delete(id); callback(...args); }, delay);
      window.quotaTimers.set(id, { callback: () => callback(...args), delay });
      return id;
    };
    window.clearTimeout = id => { window.quotaTimers.delete(id); originalClearTimeout(id); };
  });
  let statusReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/api/status')) statusReads++; });
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${address.port}/quota/`);
    await page.locator('[name=email]').fill('admin@example.test');
    await page.locator('[name=password]').fill('preview-only-password');
    await page.locator('#login-form button').click();
    await page.locator('.account-card').first().waitFor();
    await page.waitForFunction(() => [...window.quotaTimers.values()].some(timer => timer.delay === 600000));
    check((await page.locator('#refresh-interval').innerText()).includes('每10分钟自动刷新'), 'Page displays actual ten-minute auto-refresh cadence');
    const initialStatusReads = statusReads;
    await page.evaluate(async () => {
      const [id, timer] = [...window.quotaTimers].find(([, value]) => value.delay === 600000);
      window.clearTimeout(id);
      await timer.callback();
    });
    check(statusReads === initialStatusReads + 1, 'Ten-minute timer actually requests status without waiting ten minutes');
    check(await page.evaluate(() => [...window.quotaTimers.values()].some(timer => timer.delay === 600000) && ![...window.quotaTimers.values()].some(timer => timer.delay === 15000)), 'Completed auto-refresh schedules the next ten-minute poll');
    check(await page.locator('.account-card').count() === 4, 'Real server delivers all normalized accounts');
    check((await page.locator('[data-account-id="4"] .balance-value').innerText()).includes('10,000,070.4'), 'New API wallet uses quota-per-unit instead of recharge price');
    check(!(await page.locator('[data-account-id="4"]').innerText()).includes('18,950'), 'New API cumulative requests are removed from default overview');
    check((await page.locator('[data-account-id="4"] .balance-value').getAttribute('title')).includes('10,000,070.397226'), 'Exact large wallet precision remains accessible');
    check((await page.locator('[data-account-id="4"]').innerText()).includes('计价额度') && (await page.locator('[data-account-id="4"]').innerText()).includes('非现金'), 'Wallet retains currency-credit semantics by default');
    await page.locator('[data-account-id="4"] summary').click();
    check((await page.locator('[data-account-id="4"] .account-details-body').innerText()).includes('18,950'), 'New API cumulative upstream requests remain in details');
    await page.locator('[data-account-id="4"] summary').click();
    check((await page.locator('[data-account-id="4"] [data-account-scheduling]').innerText()).includes('关闭'), 'Read-only upstream enrichment preserves disabled sub2api scheduling');
    check(await page.locator('[data-account-id="4"] .unknown-block').count() === 0, 'Known upstream wallet replaces prior unknown balance');
    await page.setViewportSize({ width: 360, height: 820 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Large upstream amount fits narrow mobile screen');
    await fs.mkdir(path.join(__dirname, '../data/screenshots'), { recursive: true });
    await page.locator('[data-account-id="4"]').screenshot({ path: path.join(__dirname, '../data/screenshots/newapi-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    check((await page.locator('[data-account-id="1"] .overview-remaining').innerText()).includes('72'), 'Real source remaining quota rendered');
    check((await page.locator('[data-account-id="2"] .balance-value').innerText()).includes('56.78'), 'Real source balance rendered');
    check(await page.locator('[data-account-id="2"] img').count() === 0, 'Untrusted source name stays text');
    check(await page.locator('[data-account-id="3"] .unknown-block').count() === 1, 'Real local cap remains separate from unknown upstream');
    check((await page.locator('[data-account-id="1"] [data-window-key="5h"]').innerText()).includes('1.27K'), 'Actual source local-usage Token aggregation renders');
    check((await page.locator('[data-account-id="1"] [data-window-key="5h"]').innerText()).includes('$1.8') && (await page.locator('[data-account-id="1"] [data-window-key="5h"]').innerText()).includes('$2.4'), 'Actual source A and U cost semantics render separately');
    check(/0\s*次/.test(await page.locator('[data-account-id="1"] [data-reset-credits]').innerText()), 'Actual cached reset-credit count renders');
    check((await page.locator('[data-account-id="3"] [data-window-key="5h"]').innerText()).includes('滚动'), 'Unknown quota account local stats labeled rolling');
    const cookies = await page.context().cookies();
    check(cookies.some(cookie => cookie.name === 'quota_session' && cookie.httpOnly), 'HttpOnly session established');
    failUpstream = true;
    dashboard.lastAttempt = null;
    await page.locator('#refresh').click();
    await page.locator('#connection-error').waitFor({ state: 'visible' });
    check(await page.locator('.account-card').count() === 4 && await page.locator('.account-card.stale').count() === 4, 'Failed source refresh preserves data and marks it stale');
    await page.locator('[data-view=reports]').click();
    await page.locator('#report-destination strong').waitFor();
    check((await page.locator('#report-destination').innerText()).includes('测试机器人'), 'Real reporter metadata rendered');
    await page.locator('#report-form [name=times]').fill('09:00');
    await page.locator('#report-form [name=enabled]').check();
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(scheduler.snapshot().enabled === true && scheduler.snapshot().times[0] === '09:00', 'Real scheduler settings saved');
    await page.locator('#report-form [name=cadence]').selectOption('quarter-hour');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => !document.querySelector('#report-feedback').hidden && document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(scheduler.snapshot().times.length === 96 && scheduler.snapshot().times[0] === '00:00' && scheduler.snapshot().times.at(-1) === '23:45', 'Real API accepts and persists full quarter-hour preset');
    await page.reload();
    await page.locator('[data-view=reports]').click();
    await page.waitForFunction(() => document.querySelector('[name=cadence]').value === 'quarter-hour');
    check(await page.locator('#report-custom-times').isHidden() && (await page.locator('#report-schedule-summary').innerText()).includes('每15分钟'), 'Actual persisted settings render compact interval summary');
    await page.locator('#report-form [name=cadence]').selectOption('half-hour');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/report-config') && response.request().method() === 'POST'), page.locator('#save-report').click()]);
    await page.waitForFunction(() => !document.querySelector('#report-feedback').hidden && document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    const halfHourConfig = scheduler.snapshot();
    check(halfHourConfig.times.length === 48 && halfHourConfig.times[0] === '00:00' && halfHourConfig.times.at(-1) === '23:30' && halfHourConfig.times.every(time => /:(00|30)$/.test(time)) && !halfHourConfig.times.includes('00:15'), 'Real API persists exactly 48 half-hour slots without quarter-hour slots');
    await page.reload();
    await page.locator('[data-view=reports]').click();
    await page.waitForFunction(() => document.querySelector('[name=cadence]').value === 'half-hour');
    check(await page.locator('#report-custom-times').isHidden() && (await page.locator('#report-schedule-summary').innerText()).includes('每30分钟'), 'Persisted half-hour settings restore the correct compact editor');
    check((await page.locator('#report-preview').innerText()).includes('集成测试 OpenAI'), 'Real broadcast summary rendered');
    check(sent === 0, 'Preview and configuration never send');
    await page.locator('#logout').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.locator('[name=email]').fill('admin@example.test');
    await page.locator('[name=password]').fill('preview-only-password');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    check((await page.context().cookies()).some(cookie => cookie.name === 'quota_session' && cookie.value !== cookies.find(value => value.name === 'quota_session').value), 'Logout and second login renew actual cookie/CSRF');
    check(errors.length === 0, `No browser errors: ${errors.join('; ')}`);
    console.log(`Integrated UI checks passed: ${checks}. No upstream network or messages sent.`);
  } finally {
    await browser.close(); dashboard.close(); await scheduler.close(); await server.close();
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('quota-ui-integration-')) throw new Error('Unexpected temporary data path');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
