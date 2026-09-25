// Local real HTTP servers and fake upstream identity; no production mutations or messages.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const load = name => import(pathToFileURL(path.join(root, name)));
(async () => {
  const { QuotaServer } = await load('quota-dashboard/src/server.js');
  const { AdminAuth: QuotaAuth } = await load('quota-dashboard/src/auth.js');
  const { OpsServer } = await load('ops-center/src/server.js');
  const { AdminAuth: OpsAuth } = await load('ops-center/src/auth.js');
  const now = new Date().toISOString();
  let mutations = 0, identityLogins = 0;
  const identity = async url => {
    const login = new URL(url).pathname.endsWith('/login'); if (login) identityLogins++;
    return Response.json({ code: 0, data: login ? { access_token: `test.${Buffer.from(JSON.stringify({ email: 'admin@example.test', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.test` } : { items: [] } });
  };
  const qa = new QuotaAuth({ baseUrl: 'http://identity.invalid', fetchImpl: identity });
  const oa = new OpsAuth({ baseUrl: 'http://identity.invalid', fetchImpl: identity });
  const accounts = [1, 2, 3].map(id => ({ id: String(id), name: `演示账号 ${id}`, platform: 'openai', type: 'oauth', planLabel: 'Pro 5x', status: 'active', observedAt: now, freshness: 'fresh', metrics: [{ label: '5 小时额度', kind: 'percent', usedPercent: id * 20, observedAt: now, freshness: 'fresh' }] }));
  const config = { enabled: true, available: true, times: ['09:00'], timeZone: 'Asia/Shanghai', history: [] };
  const quota = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://identity.invalid', auth: qa, publicAccess: true,
    dashboard: { snapshot: () => ({ accounts, updatedAt: now }), refresh: async () => {} },
    scheduler: { snapshot: () => config, preview: async () => ({ text: '本地预览' }), configure: async () => { mutations++; return config; } },
  });
  const snapshot = () => ({ updatedAt: now, hosts: [1, 2].map(id => ({ id: `host-${id}`, name: id === 1 ? '应用服务器' : '音乐服务器', state: 'up', observedAt: now, lastSeenAt: now,
    metrics: { cpuPercent: 23, memoryPercent: 46, diskPercent: 31, load1: .42, uptimeSeconds: 86400 }, history: [], services: [],
    bots: [{ id: `bot-${id}`, name: id === 1 ? '思维2' : '音乐机器人', state: 'online', kind: 'KOOK', playing: false }],
  })), monitors: [{ id: 'site', name: 'API 服务', url: 'https://example.test', state: 'up', checkedAt: now, latencyMs: 80, httpStatus: 200, tlsDays: 60 }], incidents: [], commands: [], notification: {}, queryBot: {} });
  const ops = new OpsServer({ config: { port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1/ops/', sub2apiUrl: 'http://identity.invalid', hosts: [] }, auth: oa,
    engine: { store: {}, snapshot, command: () => { mutations++; }, maintenance: () => { mutations++; } },
  });
  const qAddress = await quota.start(), oAddress = await ops.start();
  const proxy = http.createServer((req, res) => {
    const port = req.url.startsWith('/ops') ? oAddress.port : qAddress.port;
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`; ops.origin = new URL(base + '/ops/');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const output = path.join(root, 'output/console-preview'); fs.mkdirSync(output, { recursive: true });
  const errors = [], check = (value, message) => { assert.ok(value, message); console.log('PASS', message); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/ops/');
    await page.locator('#ops-panel button', { hasText: '管理员登录' }).waitFor();
    check(page.url().endsWith('/quota/#ops-overview'), 'legacy URL redirects to unified console');
    check((await page.request.get(base + '/ops/api/snapshot')).status() === 401, 'public quota access cannot read operations');
    await page.locator('#ops-panel button', { hasText: '管理员登录' }).click();
    await page.locator('#login-form input[name=email]').fill('admin@example.test');
    await page.locator('#login-form input[name=password]').fill('fixture-only-password');
    await page.locator('body > #login-view #login-form button').click();
    await page.locator('#ops-panel #overview-stats .stat').first().waitFor();
    check(identityLogins === 2, 'one form authenticates both independently verified services');
    check(await page.locator('#login-form input[name=password]').inputValue() === '', 'password input cleared');
    check(await page.locator('body > #app-view > aside').count() === 1, 'one navigation shell');
    await page.screenshot({ path: path.join(output, 'console-operations-desktop.png'), fullPage: true });
    for (const view of ['ops-hosts', 'ops-web', 'ops-bots', 'ops-events', 'overview', 'health', 'reports', 'key-usage', 'trends', 'ops-overview']) {
      await page.locator(`body > #app-view > .sidebar [data-view="${view}"]`).click();
      check(page.url().endsWith(`#${view}`), `navigation ${view}`);
    }
    await page.locator('body > #app-view > .sidebar [data-view=reports]').click();
    check(await page.locator('#report-form').isVisible(), 'same login enables report administration');
    await page.locator('body > #app-view > .sidebar [data-view=ops-hosts]').click();
    await page.reload(); await page.locator('#ops-panel #host-list .host-card').first().waitFor();
    check(await page.locator('#breadcrumb-title').innerText() === '服务器', 'deep link survives reload with both cookies');
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `operations fits ${width}px`);
      await page.screenshot({ path: path.join(output, `console-operations-${width}.png`), fullPage: true });
      await page.locator('body > #app-view > .sidebar [data-view=overview]').click();
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `quota fits ${width}px`);
      await page.locator('body > #app-view > .sidebar [data-view=ops-hosts]').click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('body > #app-view > .sidebar [data-view=overview]').click(); await page.screenshot({ path: path.join(output, 'console-quota-desktop.png'), fullPage: true });
    await page.goBack();
    check(page.url().endsWith('#ops-hosts') && await page.locator('#ops-view').isVisible(), 'browser back restores the operations view');
    oa.sessions.clear();
    await page.locator('#ops-panel #refresh').click();
    await page.locator('#ops-panel button', { hasText: '管理员登录' }).waitFor();
    await page.locator('body > #app-view > .sidebar [data-view=reports]').click();
    check(await page.locator('#report-form').isVisible(), 'expired operations session does not revoke valid quota session');
    await page.locator('#console-login').click();
    await page.evaluate(() => localStorage.setItem('auth_token', 'fixture-existing-token'));
    await page.locator('#existing-login').click();
    await page.locator('#report-form').waitFor();
    await page.locator('body > #app-view > .sidebar [data-view=ops-hosts]').click();
    await page.locator('#ops-panel #host-list .host-card').first().waitFor();
    check(identityLogins === 2, 'existing-login token authenticates both services without password login');
    await page.route('**/ops/api/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary fixture outage"}' }), { times: 1 });
    await page.locator('.sidebar-bottom #logout').click(); await page.locator('#logout-retry').waitFor();
    check([...oa.sessions.values()].some(session => session.user), 'partial logout is not falsely reported as completed');
    await page.locator('#logout-retry').click(); await page.waitForURL(base + '/quota/');
    check([...qa.sessions.values(), ...oa.sessions.values()].every(session => !session.user), 'logout invalidates both server sessions');
    await page.route('**/ops/panel.html', route => route.abort());
    await page.locator('body > #app-view > .sidebar [data-view=ops-overview]').click(); await page.locator('#ops-retry').waitFor();
    await page.locator('body > #app-view > .sidebar [data-view=overview]').click();
    check(await page.locator('#overview-view').isVisible(), 'operations outage leaves quota usable');
    await page.unroute('**/ops/panel.html');
    await page.locator('body > #app-view > .sidebar [data-view=ops-overview]').click();
    await page.locator('#ops-panel button', { hasText: '管理员登录' }).waitFor();
    check(await page.locator('#ops-feedback').isHidden(), 'failed module load can recover');
    check(mutations === 0, 'navigation and login do not send messages or change services/schedules');
    check(errors.length === 0, `no browser exceptions: ${errors.join('; ')}`);
    console.log('Screenshots:', output);
  } finally { await browser.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await quota.close(); await ops.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
