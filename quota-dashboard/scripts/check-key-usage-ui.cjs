// Browser verification with local fixture keys only. Never queries a production key.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'screenshots');
const manualKey = `sk-${'a'.repeat(64)}`;
const expiredKey = `sk-${'b'.repeat(64)}`;
const failedKey = `sk-${'c'.repeat(64)}`;
const slowKey = `sk-${'d'.repeat(64)}`;
const observedAt = new Date().toISOString();
const stats = (requests, tokens, cost) => ({ requests, tokens, cost, inputTokens: tokens === null ? null : Math.floor(tokens * .8), outputTokens: tokens === null ? null : Math.floor(tokens * .2), cacheReadTokens: 0, cacheCreationTokens: 0, standardCost: cost === null ? null : cost * 2 });
function result(label, variant = 'normal') {
  return {
    ...(label ? { label } : {}), keyHint: 'sk-…aaaa', status: variant === 'expired' ? 'expired' : 'active', mode: 'unrestricted',
    quota: { scope: 'account', used: null, limit: null, remaining: 38.256, unlimited: false, currency: 'USD' },
    totals: stats(417, 18800000, 57.1534), periods: [{ key: 'today', label: '今日', ...stats(0, 0, 0) }, { key: '7d', label: '近 7 天', ...stats(null, null, null) }],
    limits: [{ window: '5h', used: .003, limit: 10, remaining: 9.997, resetAt: observedAt }, { window: '7d', used: 8.64, limit: 100, remaining: 91.36, resetAt: observedAt }],
    queriedAt: observedAt, timeZone: 'Asia/Shanghai', expiresAt: variant === 'expired' ? observedAt : null, notice: '本站记录；账户余额为多个 Key 共享。'
  };
}
const requests = [];
let pendingDone = 0;
let presetsFail = true;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/quota/api/')) {
    const endpoint = url.pathname.slice('/quota/api/'.length);
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    requests.push({ endpoint, method: req.method, search: url.search, data });
    const json = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    if (endpoint === 'session') return json(200, { authenticated: true, publicAccess: true, canManage: true, csrf: 'fixture-csrf', user: { username: 'fixture-admin' } });
    if (endpoint === 'status') return json(200, { accounts: [{ id: '1', name: 'OpenAI 测试', platform: 'openai', status: 'active', schedulable: true, metrics: [] }], updatedAt: observedAt });
    if (endpoint === 'key-presets') {
      if (presetsFail) { presetsFail = false; return json(503, { error: 'Fixture presets unavailable' }); }
      return json(200, { presets: [{ id: 'yeluogpt', label: '叶落GPT', configured: true }, { id: 'exiaomenggpt', label: '恶小梦GPT', configured: true }, { id: 'missing', label: '备用', configured: false }] });
    }
    if (endpoint === 'key-usage') {
      assert.equal(req.method, 'POST');
      assert.equal(url.search, '');
      if (data.presetId === 'yeluogpt') {
        setTimeout(() => { pendingDone++; json(200, result('叶落GPT')); }, 450);
        return;
      }
      if (data.presetId === 'exiaomenggpt') return json(200, result('恶小梦GPT'));
      if (data.key === failedKey) return json(401, { error: { code: 'KEY_INVALID', message: 'API Key 无效或已停用。' } });
      if (data.key === expiredKey) return json(200, result(null, 'expired'));
      if (data.key === slowKey) { setTimeout(() => { pendingDone++; json(200, result('迟到的查询')); }, 450); return; }
      if (data.key === manualKey) return json(200, result());
      return json(429, { error: { code: 'KEY_RATE_LIMIT', message: '查询过于频繁，请稍后重试。' } });
    }
    if (endpoint === 'report-config') return json(200, { enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai', configured: true, channelName: '111' });
    if (endpoint === 'reports') return json(200, { records: [] });
    if (endpoint === 'report-preview') return json(200, { text: '本地预览' });
    return json(404, { error: 'Unknown fixture route' });
  }
  const files = { '/quota/': 'index.html', '/quota/app.js': 'app.js', '/quota/style.css': 'style.css' };
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
    fs.mkdirSync(output, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
      window.storageWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { window.storageWrites.push({ key, value }); return original.call(this, key, value); };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.account-card').waitFor();
    check(await page.locator('#login-view').isHidden(), 'Existing public overview stays public');
    check(requests.every(request => request.endpoint !== 'key-usage'), 'No automatic key query on page load');
    await page.locator('[data-view="key-usage"]').click();
    await page.locator('#key-presets-retry').waitFor();
    check(await page.locator('#key-query-form').isVisible(), 'Preset load failure does not block manual input');
    await page.locator('#key-presets-retry').click();
    await page.locator('[data-key-preset=yeluogpt]').waitFor();
    check(await page.locator('[data-key-preset=missing]').isDisabled(), 'Unconfigured preset has a disabled control');
    await page.locator('#key-query-submit').click();
    check((await page.locator('#key-query-feedback').innerText()).includes('请输入'), 'Empty input is explained without sending a request');
    check(!requests.some(request => request.endpoint === 'key-usage'), 'Empty submission has no request');
    await page.locator('#key-query-input').fill(manualKey);
    await page.locator('#key-query-submit').click();
    await page.locator('#key-query-result').waitFor();
    check(await page.locator('#key-query-input').getAttribute('type') === 'password', 'Manual key remains masked');
    check((await page.locator('#key-query-result').innerText()).includes('sk-…aaaa') && !(await page.locator('body').innerText()).includes(manualKey), 'Only masked hint appears in result text');
    check((await page.locator('[data-key-period=today]').innerText()).includes('$0'), 'True zero costs remain zero');
    check((await page.locator('[data-key-period="7d"]').innerText()).match(/未知/g).length === 3, 'Unavailable seven-day counters remain unknown');
    check((await page.locator('[data-key-period=total]').innerText()).includes('18.8M'), 'Cumulative tokens use compact formatting');
    check((await page.locator('.key-quota-panel').innerText()).includes('多个 Key 共享'), 'Account balance is clearly shared');
    check((await page.locator('.key-limit').first().innerText()).includes('$<0.01'), 'Small nonzero costs never become zero');
    check((await page.locator('.key-result-details').getAttribute('open')) === null, 'Long details start collapsed');
    await page.locator('.key-result-details summary').click();
    check((await page.locator('.key-result-details').innerText()).includes('自然日'), 'Time-window and cost details are available');
    await page.locator('.key-result-details summary').click();
    await page.screenshot({ path: path.join(output, 'quota-key-usage-desktop.png'), fullPage: true });
    const cardHeights = await page.locator('.key-usage-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
    check(Math.max(...cardHeights) - Math.min(...cardHeights) < 1, 'Desktop usage cards have aligned heights');
    await page.locator('[data-key-preset=exiaomenggpt]').click();
    await page.waitForFunction(() => document.querySelector('#key-query-result h2')?.textContent === '恶小梦GPT');
    check(await page.locator('#key-query-input').inputValue() === '', 'Preset query clears manual key and never fills preset secrets');
    const presetRequest = requests.filter(request => request.endpoint === 'key-usage').at(-1);
    check(JSON.stringify(presetRequest.data) === '{"presetId":"exiaomenggpt"}', 'Preset query transmits only its identifier');
    await page.locator('[data-key-preset=yeluogpt]').click();
    await page.waitForFunction(() => document.querySelector('#key-query-submit').disabled);
    await page.locator('[data-key-preset=exiaomenggpt]').click();
    await page.waitForFunction(() => document.querySelector('#key-query-result h2')?.textContent === '恶小梦GPT');
    await new Promise(resolve => { const timer = setInterval(() => { if (pendingDone >= 1) { clearInterval(timer); resolve(); } }, 20); });
    check(await page.locator('#key-query-result h2').innerText() === '恶小梦GPT', 'Late first shortcut response cannot replace latest result');
    await page.locator('#key-query-input').fill(slowKey);
    check(await page.locator('#key-query-result').isHidden(), 'Editing key clears previous result and preset selection');
    await page.locator('#key-query-submit').click();
    await page.waitForFunction(() => document.querySelector('#key-query-submit').disabled);
    await page.locator('#key-query-clear').click();
    await new Promise(resolve => { const timer = setInterval(() => { if (pendingDone >= 2) { clearInterval(timer); resolve(); } }, 20); });
    check(await page.locator('#key-query-input').inputValue() === '' && await page.locator('#key-query-result').isHidden() && await page.locator('#key-query-empty').isVisible(), 'Clear cancels pending query and cannot reveal late data');
    await page.locator('#key-query-input').fill(failedKey);
    await page.locator('#key-query-submit').click();
    await page.waitForFunction(() => document.querySelector('#key-query-feedback').textContent.includes('无效'));
    check(await page.locator('#login-view').isHidden() && await page.locator('#key-query-result').isHidden(), 'Invalid Key 401 stays on query page without stale result');
    await page.locator('#key-query-input').fill(expiredKey);
    await page.locator('#key-query-submit').click();
    await page.locator('#key-query-result').waitFor();
    check((await page.locator('.key-result-meta .pill').innerText()) === '已过期', 'Expired key returned with valid stats is marked expired');
    await page.locator('[data-view=overview]').click();
    check(await page.locator('#key-query-input').inputValue() === '' && await page.locator('#key-query-result').isHidden(), 'Leaving query page clears credentials and results');
    await page.locator('[data-view="key-usage"]').click();
    await page.locator('[data-key-preset=exiaomenggpt]').click();
    await page.locator('#key-query-result').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Key usage fits 390px mobile width');
    await page.screenshot({ path: path.join(output, 'quota-key-usage-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Key usage fits 360px mobile width');
    check(await page.evaluate(() => window.storageWrites.length === 0), 'No key or query result is persisted in browser storage');
    check(new URL(page.url()).search === '' && requests.filter(request => request.endpoint === 'key-usage').every(request => request.method === 'POST' && request.search === ''), 'Queries never expose a key through URLs or GET requests');
    check(!requests.some(request => /login|logout/.test(request.endpoint)), 'Key queries never modify administrator login');
    check(errors.length === 0, `No uncaught browser errors: ${errors.join(', ')}`);
    // Exercise the same UI against the real server/router, keeping all upstream
    // data and keys local fixtures. This catches body-schema and auth drift.
    const { QuotaServer } = await import(pathToFileURL(path.join(root, 'src/server.js')));
    const { KeyUsageError } = await import(pathToFileURL(path.join(root, 'src/key-usage.js')));
    const resolvedKeys = [];
    const integrated = new QuotaServer({
      port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://fixture.invalid/', publicAccess: true, preview: true,
      dashboard: { snapshot: () => ({ accounts: [], updatedAt: observedAt }), refresh: async () => {} },
      scheduler: { snapshot: () => ({ enabled: true, available: true, times: ['09:00'], timeZone: 'Asia/Shanghai', history: [] }), preview: async () => ({ text: 'Fixture only' }) },
      keyPresets: [{ id: 'yeluogpt', label: '叶落GPT', key: manualKey }, { id: 'exiaomenggpt', label: '恶小梦GPT', key: expiredKey }],
      keyUsage: { query: async key => { resolvedKeys.push(key); if (key === failedKey) throw new KeyUsageError('AUTH', 'API Key 无效。', 401); return result(null, key === expiredKey ? 'expired' : 'normal'); } }
    });
    try {
      const address = await integrated.start();
      const integratedPage = await context.newPage();
      await integratedPage.goto(`http://127.0.0.1:${address.port}/quota/`);
      await integratedPage.locator('[data-view="key-usage"]').click();
      await integratedPage.locator('[data-key-preset=yeluogpt]').click();
      await integratedPage.locator('#key-query-result').waitFor();
      check((await integratedPage.locator('#key-query-result h2').innerText()) === '叶落GPT' && resolvedKeys.at(-1) === manualKey, 'Real router resolves preset ID server-side and provides correct label');
      check(await integratedPage.locator('#key-query-input').inputValue() === '' && !(await integratedPage.content()).includes(manualKey), 'Real preset response does not expose fixture key in DOM');
      await integratedPage.locator('[data-key-preset=exiaomenggpt]').click();
      await integratedPage.waitForFunction(() => document.querySelector('#key-query-result h2')?.textContent === '恶小梦GPT');
      check(resolvedKeys.at(-1) === expiredKey && await integratedPage.locator('.key-result-meta .pill').innerText() === '已过期', 'Second real preset uses its independent key and status');
      await integratedPage.locator('#key-query-input').fill(manualKey);
      await integratedPage.locator('#key-query-submit').click();
      await integratedPage.locator('#key-query-result').waitFor();
      check(resolvedKeys.at(-1) === manualKey && await integratedPage.locator('#key-query-result h2').innerText() === 'API Key', 'Real router accepts frontend manual key body contract');
      await integratedPage.locator('#key-query-input').fill(failedKey);
      await integratedPage.locator('#key-query-submit').click();
      await integratedPage.waitForFunction(() => document.querySelector('#key-query-feedback').textContent.includes('无效'));
      check(await integratedPage.locator('#login-view').isHidden() && await integratedPage.locator('#key-query-result').isHidden(), 'Real invalid-key response is rendered without login or stale result');
      check(resolvedKeys.length === 4, 'One upstream query per explicit action and no extra queries');
      await integratedPage.close();
    } finally { await integrated.close(); }
    console.log(`Key usage UI checks passed: ${passed}. Screenshots: ${output}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
