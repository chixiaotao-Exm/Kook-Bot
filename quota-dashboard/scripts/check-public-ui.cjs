// Uses the actual HTTP/auth server with entirely local quota, identity and KOOK fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'screenshots');

(async () => {
  const { QuotaServer } = await import(pathToFileURL(path.join(root, 'src/server.js')));
  const { AdminAuth } = await import(pathToFileURL(path.join(root, 'src/auth.js')));
  const observedAt = new Date().toISOString();
  const accounts = ['openai', 'anthropic', 'deepseek', 'grok', 'openai', 'openai'].map((platform, index) => ({
    id: String(6200 + index), name: `${platform} 公开测试账号 ${index + 1}`, platform, type: index < 4 ? 'oauth' : 'apikey',
    status: 'active', schedulable: index % 3 === 0 ? true : index % 3 === 1 ? false : null,
    source: 'sub2api-cache', observedAt, freshness: 'fresh',
    metrics: [{ key: 'quota', label: '5 小时额度窗口', kind: 'percent', scope: 'upstream', usedPercent: 13 + index, observedAt, freshness: 'fresh' }]
  }));
  let refreshes = 0, configured = 0, upstreamLogins = 0;
  let reportConfig = { enabled: true, available: true, times: Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`), timeZone: 'Asia/Shanghai', history: [{ status: 'sent', sentAt: observedAt, message: '额度汇总已发送到 #111' }] };
  const dashboard = { snapshot: () => ({ accounts, updatedAt: observedAt, refreshing: false }), refresh: async () => { refreshes++; } };
  const scheduler = { snapshot: () => reportConfig, preview: async () => ({ text: 'Sub2API 额度汇总\n6 个账号 · 4 个平台\n本地测试预览，不发送消息。' }), configure: async value => { configured++; reportConfig = { ...reportConfig, ...value }; } };
  const auth = new AdminAuth({ baseUrl: 'http://fixture.invalid/', preview: true, fetchImpl: async () => { upstreamLogins++; return new Response(JSON.stringify({ code: 0, data: {} }), { headers: { 'Content-Type': 'application/json' } }); } });
  const server = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://fixture.invalid/', publicAccess: true, preview: true, dashboard, scheduler, auth, reporter: { botName: 'bug', channelName: '111', channelId: '1234567890123456' } });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}/quota/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  try {
    fs.mkdirSync(output, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.authReads = 0;
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) { if (key === 'auth_token') window.authReads++; return get.call(this, key); };
    });
    const page = await context.newPage();
    // This suite tests quota in isolation; operations has its own real-server integration suite.
    await page.route('**/ops/api/**', route => {
      const endpoint = new URL(route.request().url()).pathname.split('/').pop();
      return route.fulfill({ status: endpoint === 'login' ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(endpoint === 'session' ? { authenticated: false, csrf: 'fixture-ops' } : endpoint === 'logout' ? { ok: true } : { error: '运维离线测试' }) });
    });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method() }); });
    await page.route('**/quota/api/session', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '服务正在重启，请稍后重试。' }) }), { times: 1 });
    await page.goto(base);
    await page.locator('#boot-retry').waitFor({ state: 'visible' });
    check(await page.locator('#login-view').isHidden() && (await page.locator('#boot-message').innerText()).includes('重启'), 'Boot failure shows connection retry instead of a login requirement');
    await page.locator('#boot-retry').click();
    await page.locator('.account-card').first().waitFor();
    check(await page.locator('.account-card').count() === 6, 'Anonymous actual server displays all six accounts');
    check((await page.locator('#refresh-interval').innerText()).includes('每10分钟自动刷新'), 'Missing interval metadata defaults to ten-minute refresh label');
    check(await page.locator('#login-view').isHidden() && await page.locator('#public-label').isVisible(), 'Direct visit is a public dashboard without login');
    check(await page.locator('#admin-label').isHidden() && await page.locator('#logout').isHidden() && await page.locator('#mobile-logout').isHidden(), 'Anonymous page has no admin identity or logout');
    check(await page.evaluate(() => window.authReads) === 0 && upstreamLogins === 0, 'Public entry never reads or checks Sub2API token');
    check(await page.locator('[data-account-scheduling="enabled"]').count() === 2 && await page.locator('[data-account-scheduling="disabled"]').count() === 2 && await page.locator('[data-account-scheduling="unknown"]').count() === 2, 'Account schedule states remain read-only and accurate');
    check(await page.locator('.account-card input, .account-card button').count() === 0, 'Account state does not expose mutation controls');
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    check(refreshes === 1, 'Anonymous refresh queries actual backend');
    await page.locator('[data-view=reports]').click();
    await page.waitForFunction(() => document.querySelector('#report-preview').textContent.includes('6 个账号'));
    check(await page.locator('#report-form').isHidden() && await page.locator('#report-readonly').isVisible(), 'Public report schedule is read-only');
    check(await page.locator('#report-enabled-badge').innerText() === '已开启' && (await page.locator('#readonly-cadence').innerText()).includes('30'), 'Public view shows enabled and half-hour cadence');
    check((await page.locator('#readonly-times').innerText()) === '每小时 00、30 分', 'Public half-hour schedule states exact execution minutes');
    check((await page.locator('#readonly-timezone').innerText()).includes('Asia/Shanghai') && (await page.locator('#report-destination').innerText()).includes('1234567890123456'), 'Timezone and destination remain visible');
    check(await page.locator('#reports-view input:visible, #reports-view select:visible, #save-report:visible').count() === 0, 'No schedule switch, selector or save for public visitors');
    check((await page.locator('#report-history').innerText()).includes('已发送'), 'Public report history displays backend records');
    check(configured === 0 && !requests.some(request => /send|login/.test(request.url)), 'Read flow never configures a schedule, logs in or sends a message');
    await page.screenshot({ path: path.join(output, 'quota-public-reports-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Public reports fit mobile width');
    await page.screenshot({ path: path.join(output, 'quota-public-reports-mobile.png'), fullPage: true });
    await page.locator('[data-view=overview]').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Public overview fits mobile width');
    await page.screenshot({ path: path.join(output, 'quota-public-mobile.png'), fullPage: true });

    // Expired cookies do not make the public reader log in again.
    auth.sessions.clear();
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    check(refreshes >= 1 && await page.locator('#login-view').isHidden(), 'Expired session still permits public refresh');
    await page.reload();
    await page.locator('.account-card').first().waitFor();
    check(await page.locator('.account-card').count() === 6, 'Expired session reload stays public');
    await page.route('**/quota/api/status', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法读取额度。' }) }), { times: 1 });
    await page.reload();
    await page.locator('#connection-error').waitFor({ state: 'visible' });
    check(await page.locator('#login-view').isHidden() && await page.locator('#app-view').isVisible(), 'A failed public read reports data error without redirecting to login');
    await page.reload();
    await page.locator('.account-card').first().waitFor();

    await page.locator('[data-view=reports]').click();
    await page.locator('#manage-reports').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    check(await page.locator('#login-public-return').isVisible(), 'Management login is explicit and offers return to public view');
    check(await page.evaluate(() => window.authReads) === 0, 'Management entry does not automatically use existing token');
    await page.locator('[name=email]').fill('admin@example.test');
    await page.locator('[name=password]').fill('preview-only-password');
    await page.locator('#login-form button').click();
    await page.locator('#report-form').waitFor({ state: 'visible' });
    check(await page.locator('#admin-label').isVisible(), 'Explicit administrator login retains schedule editor');
    await page.locator('#report-form [name=cadence]').selectOption('custom');
    await page.locator('#report-form [name=times]').fill('09:00, 18:00');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(configured === 1 && reportConfig.times.join(',') === '09:00,18:00', 'Authenticated editor still uses backend CSRF authorization');
    await page.goto(base);
    await page.locator('.account-card').first().waitFor();
    await page.locator('[data-view=reports]').click();
    check(await page.locator('#report-form').isVisible() && await page.locator('#admin-label').isVisible(), 'Unified console retains explicit administrator login across views');
    await page.locator('#report-form').waitFor({ state: 'visible' });
    await page.locator('#mobile-logout').click();
    await page.locator('.account-card').first().waitFor();
    check(new URL(page.url()).search === '' && await page.locator('#login-view').isHidden(), 'Administrator logout returns to public dashboard');
    await page.goto(base + '?manage=1');
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.evaluate(() => localStorage.setItem('auth_token', 'fixture-user-token'));
    await page.locator('#existing-login').click();
    await page.locator('#report-form').waitFor({ state: 'visible' });
    check(await page.evaluate(() => window.authReads) === 1 && upstreamLogins === 1, 'Existing-token login is still available only after explicit click');
    auth.sessions.clear();
    await page.locator('#save-report').click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    check(await page.locator('#report-form').isHidden() && await page.locator('#login-view').isHidden(), 'Expired management session falls back to public read-only view');
    check(configured === 1, 'Expired management session cannot change schedule');
    check(!requests.some(request => /send/.test(request.url)), 'No browser action sends immediate KOOK messages');
    check(errors.length === 0, `No uncaught browser errors: ${errors.join(', ')}`);
    console.log(`Public actual-server UI checks passed: ${passed}. Screenshots: ${output}`);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
