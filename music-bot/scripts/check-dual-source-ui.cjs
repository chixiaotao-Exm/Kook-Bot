const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:8788');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only a loopback preview may be changed');
const out = path.resolve('data/screenshots'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [], calls = [], checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === base.origin && url.pathname.startsWith('/api/')) calls.push({ route: url.pathname, method: request.method(), source: url.searchParams.get('source'), data: request.postDataJSON() });
  });
  const state = async () => (await (await page.request.get(new URL('/api/state', base).href)).json());
  const queueSize = (s) => s.player.queue.length + (s.player.current ? 1 : 0);
  const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
  const choose = async (source) => { await page.locator(`[data-music-source=${source}]`).click(); };
  const search = async (q) => { await page.locator('#search-input').fill(q); await page.locator('#search-input').press('Enter'); await page.locator('#search-results [data-add]').first().waitFor(); };
  const waitDone = async () => page.waitForFunction(() => !document.body.classList.contains('working'));
  const waitRows = async (number) => page.waitForFunction((count) => document.querySelectorAll('#playlist-tracks .track-row').length === count, number);
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' }); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal((await state()).preview, true);
    await page.locator('[data-view=account]').click();
    await page.locator('#account-status').filter({ hasText: '已登录' }).waitFor();
    if (await page.locator('#qq-logout').isVisible()) { await page.locator('#qq-logout').click(); await page.locator('#confirm-yes').click(); await waitDone(); }
    await page.locator('#qq-account-status').filter({ hasText: '未登录' }).waitFor();
    const baseline = await state();
    await page.locator('[data-view=player]').click(); await choose('qq'); await search('周杰伦');
    assert.ok((await page.locator('#search-results .source-badge').allTextContents()).every((source) => source === 'QQ音乐'));
    await choose('netease'); await page.locator('#search-results [data-item-source=netease]').first().waitFor();
    assert.equal(await page.locator('#search-input').inputValue(), '周杰伦');
    await choose('qq'); await page.locator('#search-results [data-item-source=qq]').first().waitFor();
    const unchanged = await state();
    assert.equal(unchanged.player.current.id, baseline.player.current.id);
    assert.ok(unchanged.player.seconds >= baseline.player.seconds);
    assert.equal(queueSize(unchanged), queueSize(baseline));
    assert.equal(await page.locator('#dock-source').textContent(), '网易云');
    pass('source switching preserves query, current music, progress, and queue');

    let releaseSearch, searchStarted;
    const pendingSearch = new Promise((resolve) => { releaseSearch = resolve; });
    const searchReady = new Promise((resolve) => { searchStarted = resolve; });
    let heldSearch = false;
    const delaySearch = async (route) => {
      if (!heldSearch && new URL(route.request().url()).searchParams.get('source') === 'qq') {
        heldSearch = true; const response = await route.fetch(); searchStarted(); await pendingSearch; return route.fulfill({ response });
      }
      return route.continue();
    };
    await page.route('**/api/search?*', delaySearch);
    await page.locator('#search-input').fill('江南'); await page.locator('#search-input').press('Enter'); await searchReady;
    await choose('netease'); await page.locator('#search-results [data-item-source=netease]').first().waitFor();
    releaseSearch(); await page.waitForTimeout(150); assert.equal(await page.locator('#search-results [data-item-source=qq]').count(), 0);
    await page.unroute('**/api/search?*', delaySearch); pass('late search response cannot replace the selected source');

    await choose('qq'); await page.locator('#search-results [data-item-source=qq]').first().waitFor();
    const beforeLoginAdd = await state();
    await page.locator('#search-results [data-add]').first().click();
    await page.locator('#qr-title').filter({ hasText: '登录QQ音乐' }).waitFor();
    await page.locator('#qr-content img').waitFor();
    await page.locator('[data-qr-type=wx]').click(); await page.locator('#qr-content img').waitFor();
    await page.screenshot({ path: path.join(out, 'dual-source-qq-login-desktop.png') });
    await page.locator('#qr-dialog').waitFor({ state: 'hidden' });
    await waitDone();
    const afterLoginAdd = await state();
    assert.equal(queueSize(afterLoginAdd) - queueSize(beforeLoginAdd), 1);
    assert.equal(afterLoginAdd.player.queue.at(-1).source, 'qq');
    assert.equal(await page.locator('#account-status').textContent(), '已登录');
    pass('QQ login and WeChat QR selection resume exactly one pending add');

    await page.locator('[data-view=discover]').click(); await page.locator('.playlist-open[data-item-source=qq]').first().waitFor();
    await page.locator('[data-category=charts]').click(); await page.locator('.playlist-open[data-open-playlist="top:26"]').waitFor();
    await page.locator('.playlist-open[data-open-playlist="top:26"]').click(); await waitRows(50);
    assert.match(await page.locator('#playlist-detail-source').textContent(), /QQ音乐/);
    await page.locator('#playlist-more').click(); await waitRows(100); await page.locator('#playlist-more').click(); await waitRows(123);
    assert.equal(await page.locator('#playlist-more').isVisible(), false);
    await choose('netease'); await page.locator('#view-discover').waitFor({ state: 'visible' });
    await page.locator('.playlist-open[data-item-source=netease]').first().click(); await waitRows(50);
    assert.equal(await page.locator('#playlist-detail-source').textContent(), '网易云');
    pass('both provider galleries/details support source tags, chart IDs, and pagination');

    const beforeCollision = await state();
    await page.locator('#playlist-tracks [data-add="66285"]').click(); await waitDone();
    await choose('qq'); await page.locator('[data-view=player]').click(); await search('晴天');
    await page.locator('#search-results [data-add="66285"]').click(); await waitDone();
    const collided = await state();
    assert.equal(queueSize(collided) - queueSize(beforeCollision), 2);
    assert.deepEqual(collided.player.queue.slice(-2).map((song) => [song.id, song.source, song.name]), [['66285', 'netease', '葡萄成熟时'], ['66285', 'qq', '晴天']]);
    pass('identical provider IDs add distinct correctly labelled songs');

    await page.locator('[data-view=player]').click();
    const heartCalls = calls.filter((call) => call.route === '/api/heart').length;
    await page.locator('#heart-button').click(); await page.locator('#view-discover').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-category=mine]').getAttribute('aria-selected'), 'true');
    assert.equal(calls.filter((call) => call.route === '/api/heart').length, heartCalls);
    pass('QQ favorites browses own playlists without calling NetEase heart mode');

    await page.locator('[data-view=account]').click(); await page.locator('#qq-logout').waitFor({ state: 'visible' });
    const beforeLogout = await state();
    await page.locator('#qq-logout').click(); await page.locator('#confirm-yes').click(); await waitDone();
    await page.locator('#qq-account-status').filter({ hasText: '未登录' }).waitFor();
    const afterLogout = await state();
    assert.equal(await page.locator('#account-status').textContent(), '已登录');
    assert.deepEqual(afterLogout.player.queue, beforeLogout.player.queue);
    assert.equal(afterLogout.player.current.id, beforeLogout.player.current.id);
    const failedAccount = async (route) => new URL(route.request().url()).searchParams.get('source') === 'qq' ? route.fulfill({ status: 502, json: { error: 'Preview account outage' } }) : route.continue();
    await page.route('**/api/account?*', failedAccount); await page.locator('#refresh-account').click(); await waitDone();
    await page.locator('#qq-account-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#account-status').textContent(), '已登录');
    await page.unroute('**/api/account?*', failedAccount);
    pass('QQ logout/failure preserves NetEase account, queue, and current playback');

    const expiredAccount = async (route) => new URL(route.request().url()).searchParams.get('source') === 'qq' ? route.fulfill({ json: { loggedIn: false, status: 'expired' } }) : route.continue();
    await page.route('**/api/account?*', expiredAccount); await page.locator('#refresh-account').click(); await waitDone();
    assert.equal(await page.locator('#qq-account-status').textContent(), '登录失效');
    assert.match(await page.locator('#qq-qr-button').textContent(), /重新登录/);
    assert.equal(await page.locator('#account-status').textContent(), '已登录');
    await page.unroute('**/api/account?*', expiredAccount);
    let releaseQr, qrStarted;
    const pendingQr = new Promise((resolve) => { releaseQr = resolve; });
    const qrReady = new Promise((resolve) => { qrStarted = resolve; });
    const delayedQr = async (route) => {
      if (route.request().method() === 'POST' && route.request().postDataJSON()?.source === 'qq') {
        const response = await route.fetch(); qrStarted(); await pendingQr; return route.fulfill({ response });
      }
      return route.continue();
    };
    await page.route('**/api/account/qr', delayedQr);
    await page.locator('#qq-qr-button').click(); await qrReady;
    await page.locator('#qr-dialog [data-close]').click(); await page.locator('#qr-button').click();
    await page.locator('#qr-content img').waitFor(); releaseQr(); await page.waitForTimeout(150);
    assert.equal(await page.locator('#qr-title').textContent(), '登录网易云音乐');
    assert.match(await page.locator('#qr-content img').getAttribute('alt'), /网易云/);
    assert.equal(await page.locator('#qr-type-tabs').isVisible(), false);
    await page.locator('#qr-dialog [data-close]').click(); await page.unroute('**/api/account/qr', delayedQr);
    pass('expired QQ login is independent; late QR cannot overwrite another account modal');

    for (const [width, height] of [[1440, 1000], [801, 1000], [390, 844], [360, 800]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(out, `dual-source-account-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${width}`);
      await page.locator('[data-view=player]').click();
      await page.screenshot({ path: path.join(out, `dual-source-player-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${width}`);
      await page.locator('[data-view=account]').click();
    }
    await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-music-source=qq]').getAttribute('aria-pressed'), 'true');
    pass('source preference survives reload; desktop/mobile have no horizontal overflow');
    await page.locator('[data-view=discover]').click(); await page.locator('.playlist-open[data-item-source=qq]').first().waitFor();
    await page.evaluate(() => scrollTo(0, 180));
    const qqScroll = await page.evaluate(() => scrollY);
    await page.locator('[data-music-source=netease]').evaluate((button) => button.click());
    await page.locator('.playlist-open[data-item-source=netease]').first().waitFor();
    await page.evaluate(() => scrollTo(0, 80));
    await page.locator('[data-music-source=qq]').evaluate((button) => button.click());
    await page.locator('.playlist-open[data-item-source=qq]').first().waitFor();
    assert.equal(await page.evaluate(() => scrollY), qqScroll);
    pass('source gallery scroll positions remain independent');
    const fallbackPage = await browser.newPage();
    try {
      await fallbackPage.addInitScript(() => localStorage.setItem('music-source', 'qq'));
      let releaseSources;
      const sourceGate = new Promise((resolve) => { releaseSources = resolve; });
      await fallbackPage.route('**/api/sources', async (route) => {
        await sourceGate;
        await route.fulfill({ json: { sources: [{ id: 'netease', name: '网易云音乐', enabled: true }, { id: 'qq', name: 'QQ音乐', enabled: false }] } });
      });
      await fallbackPage.goto(base.href, { waitUntil: 'domcontentloaded' }); await fallbackPage.locator('#app').waitFor({ state: 'visible' });
      await fallbackPage.locator('#search-input').fill('晴天'); await fallbackPage.locator('#search-input').press('Enter');
      await fallbackPage.locator('#search-results [data-item-source=qq]').first().waitFor();
      releaseSources();
      await fallbackPage.locator('#search-results [data-item-source=netease]').first().waitFor();
      assert.equal(await fallbackPage.locator('[data-music-source=netease]').getAttribute('aria-pressed'), 'true');
      assert.equal(await fallbackPage.locator('#search-input').inputValue(), '晴天');
      assert.equal(await fallbackPage.locator('#search-results [data-item-source=qq]').count(), 0);
    } finally { await fallbackPage.close(); }
    pass('late disabled-source discovery reloads results under the fallback provider');
    const sourcedGets = new Set(['/api/search', '/api/discover', '/api/playlist', '/api/account', '/api/account/qr']);
    const sourcedPosts = new Set(['/api/play', '/api/playlist', '/api/heart', '/api/hot', '/api/account/qr', '/api/account/logout']);
    assert.ok(calls.filter((call) => call.method === 'GET' && sourcedGets.has(call.route)).every((call) => ['netease', 'qq'].includes(call.source)));
    assert.ok(calls.filter((call) => call.method === 'POST' && sourcedPosts.has(call.route)).every((call) => ['netease', 'qq'].includes(call.data.source)));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, sourceRequests: calls.filter((call) => sourcedGets.has(call.route) || sourcedPosts.has(call.route)), screenshots: out }, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
