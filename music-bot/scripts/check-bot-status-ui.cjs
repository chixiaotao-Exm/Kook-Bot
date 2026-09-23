const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = false;
const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:8788/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const out = path.resolve('data/screenshots'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [], writes = [], reads = [], checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(url.pathname); return route.abort(); }
    reads.push(url.pathname + url.search); return route.continue();
  });
  const pass = (message) => { checks.push(message); console.log(`PASS ${message}`); };
  const read = async (route) => {
    const response = await page.request.get(new URL(`/api${route}`, base).href);
    assert.equal(response.status(), 200); return response.json();
  };
  try {
    await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('bot-select').options.length > 0 && !document.getElementById('bot-select').disabled);
    const initial = await read('/bots');
    if (!live) assert.equal((await read('/state')).preview, true);
    await page.locator('.nav-item[data-view="status"]').click();
    await page.locator('#view-status').waitFor({ state: 'visible' });
    for (const bot of initial.bots) {
      const card = page.locator(`[data-status-bot="${bot.id}"]`);
      await card.waitFor(); await card.filter({ hasText: bot.name }).waitFor();
      await card.locator(`[data-control-bot="${bot.id}"]`).waitFor();
      await card.locator('[data-status-action="previous"]').waitFor();
      await card.locator('[data-status-action="skip"]').waitFor();
      await card.locator('[data-status-toggle]').waitFor();
      assert.equal(await card.locator('[data-status-volume]').getAttribute('max'), '100');
      assert.equal(await card.locator('[data-status-hot="qq"]').count(), 1);
      assert.equal(await card.locator('[data-status-hot="netease"]').count(), 1);
      if (live && bot.status === 'ready' && bot.context) {
        const catalog = await read(`/catalog?botId=${encodeURIComponent(bot.id)}`);
        const guild = catalog.guilds.find((item) => item.id === bot.context.guildId);
        const channel = guild?.channels.find((item) => item.id === bot.context.voiceChannelId);
        assert.ok(channel, 'The connected voice channel is present in the catalog');
        await page.waitForFunction(({ id, name }) => document.querySelector(`[data-status-bot="${id}"] .status-room strong`)?.textContent.trim() === name, { id: bot.id, name: channel.name });
      }
    }
    assert.equal(await page.locator('#search-form').isVisible(), false);
    assert.equal(await page.locator('#source-picker').isVisible(), false);
    assert.equal(await page.locator('#bot-select').isVisible(), false);
    await page.waitForFunction((count) => document.getElementById('status-total').textContent.trim() === String(count), initial.bots.length);
    pass('sidebar opens the global status page and lists every bot without playback writes');

    if (!live) {
      const first = page.locator('[data-status-bot="default"]'), second = page.locator('[data-status-bot="preview-two"]');
      await first.filter({ hasText: '一起听音乐' }).waitFor();
      await second.filter({ hasText: '深夜电台' }).waitFor();
      assert.match(await first.innerText(), /正在播放/);
      assert.match(await second.innerText(), /暂停/);
      assert.match(await second.innerText(), /35\s*%/);
      assert.match(await second.innerText(), /富士山下/);
      assert.equal((await page.locator('#status-online').textContent()).trim(), '2');
      assert.equal((await page.locator('#status-connected').textContent()).trim(), '2');
      assert.equal((await page.locator('#status-playing').textContent()).trim(), '1');
      pass('cards distinguish independent channels, paused/playing state, volume and summary counts');
    }
    for (const width of [1440, 801, 390, 360]) {
      await page.setViewportSize({ width, height: width > 800 ? 1000 : 844 });
      await page.screenshot({ path: path.join(out, `bot-status-${live ? 'live' : 'preview'}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `status page overflow at ${width}`);
      assert.equal(await page.locator('.nav-item[data-view="status"]').isVisible(), true);
    }
    pass('desktop and mobile status layouts fit the viewport and keep navigation accessible');

    await page.setViewportSize({ width: 1440, height: 1000 });
    const target = initial.bots.find((bot) => bot.id !== 'default' && bot.status === 'ready') || initial.bots[0];
    await page.locator(`[data-control-bot="${target.id}"]`).click();
    await page.locator('#view-player').waitFor({ state: 'visible' });
    await page.waitForFunction((id) => document.getElementById('bot-select').value === id, target.id);
    assert.equal(await page.locator('#bot-select').isVisible(), true);
    pass('control entry selects the requested bot and opens its player without changing playback');

    if (!live) {
      const countLists = () => reads.filter((url) => url === '/api/bots').length;
      await page.waitForTimeout(500); const stoppedAt = countLists();
      await page.waitForTimeout(5600);
      assert.equal(countLists(), stoppedAt, 'Status page polling must stop after leaving the view');
      await page.locator('.nav-item[data-view="status"]').click();
      await page.locator('[data-status-bot="preview-two"]').filter({ hasText: '深夜电台' }).waitFor();
      const beforeAuto = countLists();
      await page.waitForFunction(() => !document.getElementById('refresh-bot-status').disabled);
      await page.waitForTimeout(5600);
      assert.ok(countLists() > beforeAuto, 'Visible status page refreshes automatically');
      pass('status refreshes while open and stops polling when another view is shown');

      let releaseCatalog, catalogStarted, catalogCalls = 0;
      const heldCatalog = new Promise((resolve) => { releaseCatalog = resolve; });
      const startedCatalog = new Promise((resolve) => { catalogStarted = resolve; });
      const slowCatalog = async (route) => {
        if (new URL(route.request().url()).searchParams.get('botId') !== 'preview-two') return route.fallback();
        catalogCalls++; const response = await route.fetch(); catalogStarted(); await heldCatalog;
        return route.fulfill({ response });
      };
      await page.evaluate(() => localStorage.setItem('selected-bot', 'default'));
      await page.route('**/api/catalog?*', slowCatalog);
      await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
      await page.locator('.nav-item[data-view="status"]').click(); await startedCatalog;
      await page.waitForFunction(() => !document.getElementById('refresh-bot-status').disabled);
      const duringCatalog = countLists(); await page.waitForTimeout(5600);
      assert.ok(countLists() > duringCatalog, 'A slow name lookup must not block state polling');
      await page.locator('.nav-item[data-view="player"]').click();
      await page.locator('.nav-item[data-view="status"]').click();
      await page.waitForFunction(() => !document.getElementById('refresh-bot-status').disabled);
      assert.equal(catalogCalls, 1, 'In-flight catalogs must be reused after re-entering the view');
      releaseCatalog();
      await page.locator('[data-status-bot="preview-two"]').filter({ hasText: '深夜电台' }).waitFor();
      await page.unroute('**/api/catalog?*', slowCatalog);
      pass('slow channel names do not block live status, and re-entering reuses the pending lookup');

      const stateFailure = async (route) => {
        if (new URL(route.request().url()).searchParams.get('botId') !== 'preview-two') return route.fallback();
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：状态连接暂时不可用' }) });
      };
      await page.route('**/api/state?*', stateFailure);
      await page.locator('#refresh-bot-status').click();
      await page.locator('[data-status-bot="preview-two"] .status-card-note.error').filter({ hasText: '显示上次状态' }).waitFor();
      assert.equal(await page.locator('[data-status-bot="default"].is-stale').count(), 0);
      assert.equal(await page.locator('[data-status-bot="preview-two"] .status-pill.online').count(), 1);
      await page.unroute('**/api/state?*', stateFailure);
      await page.locator('#refresh-bot-status').click();
      await page.waitForFunction(() => !document.querySelector('[data-status-bot="preview-two"]').classList.contains('is-stale'));
      const listFailure = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：列表读取失败' }) });
      await page.route('**/api/bots', listFailure);
      await page.locator('#refresh-bot-status').click();
      await page.locator('#status-page-error').filter({ hasText: '列表读取失败' }).waitFor();
      assert.equal(await page.locator('[data-status-bot]').count(), 2);
      await page.unroute('**/api/bots', listFailure);
      await page.locator('#refresh-bot-status').click();
      await page.locator('#status-page-error').waitFor({ state: 'hidden' });
      pass('individual and list failures retain clearly marked prior data and recover without false offline claims');
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ live, checks, errors, writes, screenshots: out }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
