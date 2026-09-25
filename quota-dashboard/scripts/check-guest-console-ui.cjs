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
  let mutations = 0, identityLogins = 0, maintenance = false; const commands = [];
  const identity = async url => {
    const login = new URL(url).pathname.endsWith('/login'); if (login) identityLogins++;
    return Response.json({ code: 0, data: login ? { access_token: `test.${Buffer.from(JSON.stringify({ email: 'admin@example.test', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.test` } : { items: [] } });
  };
  const qa = new QuotaAuth({ baseUrl: 'http://identity.invalid', fetchImpl: identity });
  const oa = new OpsAuth({ baseUrl: 'http://identity.invalid', fetchImpl: identity });
  const accounts = [1, 2, 3].map(id => ({ id: String(id), name: `演示账号 ${id}`, platform: 'openai', type: 'oauth', planLabel: 'Pro 5x', status: 'active', observedAt: now, freshness: 'fresh', metrics: [{ label: '5 小时额度', kind: 'percent', usedPercent: id * 20, observedAt: now, freshness: 'fresh' }] }));
  const config = { enabled: true, available: true, times: ['09:00'], timeZone: 'Asia/Shanghai', history: [] };
  const quota = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://identity.invalid', auth: qa, publicAccess: true, publicManagement: true,
    dashboard: { snapshot: () => ({ accounts, updatedAt: now }), refresh: async () => {} },
    scheduler: { snapshot: () => config, preview: async () => ({ text: '本地预览' }), configure: async () => { mutations++; return config; } },
  });
  const snapshot = () => ({ updatedAt: now, hosts: [1, 2].map(id => ({ id: `host-${id}`, name: id === 1 ? '应用服务器' : '音乐服务器', state: 'up', observedAt: now, lastSeenAt: now,
    metrics: { cpuPercent: 23, memoryPercent: 46, diskPercent: 31, load1: .42, uptimeSeconds: 86400 }, history: [], maintenance, services: [{id:'music',name:'测试音乐服务',activeState:'active',expected:'running',restartAllowed:true,ok:true}],
    bots: [{ id: `bot-${id}`, name: id === 1 ? '思维2' : '音乐机器人', state: 'online', kind: 'KOOK', playing: false }],
  })), monitors: [{ id: 'site', name: 'API 服务', url: 'https://example.test', state: 'up', checkedAt: now, latencyMs: 80, httpStatus: 200, tlsDays: 60 }], incidents: [], commands, notification: {}, queryBot: {} });
  const ops = new OpsServer({ config: { port: 0, host: '127.0.0.1', publicManagement: true, publicUrl: 'http://127.0.0.1/ops/', sub2apiUrl: 'http://identity.invalid', hosts: [] }, auth: oa,
    engine: { store: {}, snapshot, command: (body, authorize) => { authorize(); mutations++; const command={...body,id:'command-1',status:'pending',createdAt:now}; commands.push(command); return command; }, maintenance: (body, authorize) => { authorize(); mutations++; maintenance=body.enabled; return {updated:true}; } },
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
    await page.goto(base + '/quota/?manage=1#reports');
    await page.locator('#report-form').waitFor();
    check(await page.locator('#console-login').isHidden() && await page.locator('#console-mobile-login').isHidden(), 'guest mode hides login entries');
    check(await page.locator('#mobile-logout').isHidden() && await page.locator('.sidebar-bottom #logout').isHidden(), 'guest mode hides logout entries');
    check((await page.locator('#public-label').innerText()).includes('访客模式'), 'guest is not labelled administrator');
    check(identityLogins === 0 && [...qa.sessions.values()].every(session => !session.user), 'no administrator identity is created');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(mutations === 1, 'anonymous visitor saves a fixture broadcast schedule');
    await page.locator('body > #app-view > .sidebar [data-view=ops-hosts]').click();
    await page.locator('#ops-panel #host-list .host-card').first().waitFor();
    check((await page.request.get(base + '/ops/api/snapshot')).status() === 200, 'operations snapshot is public');
    const restart = page.locator('#ops-panel [data-restart-host="host-1"]');
    check(await restart.isEnabled(), 'allowlisted restart available to visitor');
    await restart.click(); await page.locator('#ops-panel #restart-dialog').waitFor();
    check(mutations === 1, 'opening confirmation does not restart service');
    await page.locator('#ops-panel #restart-cancel').click(); check(mutations === 1, 'cancelling does not restart service');
    await restart.click(); await page.locator('#ops-panel #restart-confirm').click();
    await page.waitForURL(/#ops-events$/);
    check(mutations === 2 && commands.length === 1, 'confirmed visitor restart queues one fixture command');
    await page.locator('body > #app-view > .sidebar [data-view=ops-hosts]').click();
    await page.locator('#ops-panel [data-maintenance-kind="host"][data-target-id="host-1"]').click();
    await page.locator('#ops-panel [data-maintenance-kind="host"][data-target-id="host-1"]', { hasText: '结束维护' }).waitFor();
    check(mutations === 3 && maintenance, 'visitor can enable fixture maintenance');
    await page.screenshot({ path: path.join(output, 'guest-operations-desktop.png'), fullPage: true });
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `guest operations fits ${width}px`);
    }
    oa.sessions.clear(); await page.locator('#ops-panel #refresh').click();
    // Public reads remain available even when the cookie expires; mutations require a new CSRF session.
    await page.locator('#ops-panel [data-maintenance-kind="host"][data-target-id="host-1"]').click();
    await page.locator('#ops-panel button', { hasText: '重新连接' }).waitFor();
    check(mutations === 3, 'expired session does not repeat a mutation');
    await page.locator('#ops-panel button', { hasText: '重新连接' }).click();
    await page.locator('#ops-panel #host-list .host-card').first().waitFor();
    check(await page.locator('#console-mobile-login').isHidden(), 'reconnecting needs no login');
    await page.locator('body > #app-view > .sidebar [data-view=reports]').click();
    qa.sessions.clear(); await page.locator('#save-report').click();
    await page.waitForFunction(() => !document.querySelector('#save-report').disabled);
    check(mutations === 3 && await page.locator('#report-form').isVisible(), 'expired quota session renews without repeating the save');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.querySelector('#report-feedback').textContent.includes('计划已保存'));
    check(mutations === 4, 'visitor can explicitly retry save after session renewal');
    check(identityLogins === 0 && [...qa.sessions.values(), ...oa.sessions.values()].every(session => !session.user), 'all actions use anonymous sessions');
    check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
  } finally { await browser.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await quota.close(); await ops.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
