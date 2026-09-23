const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:8788');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only a loopback preview may be changed');
const out = path.resolve('data/screenshots'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let otherPage;
  page.setDefaultTimeout(15000);
  const errors = [], calls = [], checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === base.origin && request.method() === 'POST') calls.push({ route: url.pathname, botId: request.postDataJSON()?.botId });
  });
  const read = async (route) => (await (await page.request.get(new URL(`/api${route}`, base).href)).json());
  const state = (botId) => read(`/state?botId=${encodeURIComponent(botId)}`);
  const done = async () => page.waitForFunction(() => !document.body.classList.contains('working'));
  const selected = async (id) => {
    await page.locator('#bot-select').selectOption(id);
    await page.waitForFunction((value) => document.getElementById('bot-select').value === value && document.getElementById('bot-error').hidden, id);
  };
  const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' }); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal((await state('default')).preview, true);
    const initialBots = await read('/bots');
    assert.ok(initialBots.bots.some((bot) => bot.id === 'preview-two'));
    assert.ok(initialBots.bots.every((bot) => !('token' in bot)));
    const primary = await state('default');
    await selected('preview-two');
    const second = await state('preview-two');
    assert.notEqual(second.player.context.voiceChannelId, primary.player.context.voiceChannelId);
    assert.equal(Number(await page.locator('#volume').inputValue()), second.player.volume);
    assert.equal(await page.locator('#queue-count').textContent(), `${second.player.queue.length} 首待播`);
    await page.locator('#volume').evaluate((input) => { input.value = '27'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await done();
    assert.equal((await state('preview-two')).player.volume, 27);
    const untouched = await state('default');
    assert.equal(untouched.player.volume, primary.player.volume);
    assert.deepEqual(untouched.player.queue, primary.player.queue);
    assert.equal(untouched.player.current.id, primary.player.current.id);
    await page.locator('[data-view=account]').click();
    assert.match(await page.locator('#settings-bot-name').textContent(), new RegExp(second.bot.name));
    assert.equal(await page.locator('[data-remove-bot="default"]').count(), 0);
    pass('each bot shows its own room, queue, playback settings; controls leave the other bot unchanged');

    await selected('default');
    let releaseState, stateStarted;
    const pendingState = new Promise((resolve) => { releaseState = resolve; });
    const stateReady = new Promise((resolve) => { stateStarted = resolve; });
    let heldState = false;
    const delayState = async (route) => {
      if (!heldState && new URL(route.request().url()).searchParams.get('botId') === 'default') {
        heldState = true; const response = await route.fetch(); stateStarted(); await pendingState; return route.fulfill({ response });
      }
      return route.continue();
    };
    await page.route('**/api/state?*', delayState); await stateReady;
    await selected('preview-two'); releaseState(); await page.waitForTimeout(150);
    assert.equal(await page.locator('#bot-select').inputValue(), 'preview-two');
    assert.equal(Number(await page.locator('#volume').inputValue()), 27);
    await page.unroute('**/api/state?*', delayState);
    pass('late state responses cannot overwrite the newly selected bot');

    let releaseCatalog, catalogStarted;
    const pendingCatalog = new Promise((resolve) => { releaseCatalog = resolve; });
    const catalogReady = new Promise((resolve) => { catalogStarted = resolve; });
    const delayCatalog = async (route) => {
      if (new URL(route.request().url()).searchParams.get('botId') === 'default') {
        const response = await route.fetch(); catalogStarted(); await pendingCatalog; return route.fulfill({ response });
      }
      return route.continue();
    };
    await page.route('**/api/catalog?*', delayCatalog);
    await selected('default'); await catalogReady; await selected('preview-two');
    await page.waitForFunction((channel) => document.getElementById('voice-select').value === channel, second.player.context.voiceChannelId);
    releaseCatalog(); await page.waitForTimeout(150);
    assert.equal(await page.locator('#voice-select').inputValue(), second.player.context.voiceChannelId);
    await page.unroute('**/api/catalog?*', delayCatalog);
    pass('late channel catalogs cannot replace another bot’s room selection');

    otherPage = await page.context().newPage(); otherPage.setDefaultTimeout(15000);
    otherPage.on('pageerror', (error) => errors.push(error.message));
    await otherPage.goto(base.href, { waitUntil: 'networkidle' });
    await otherPage.locator('#bot-select').selectOption('default');
    await otherPage.waitForFunction(() => document.getElementById('bot-select').value === 'default' && document.getElementById('bot-error').hidden);
    assert.equal(await page.locator('#bot-select').inputValue(), 'preview-two');
    await Promise.all([
      page.locator('#volume').evaluate((input) => { input.value = '29'; input.dispatchEvent(new Event('change', { bubbles: true })); }),
      otherPage.locator('#volume').evaluate((input) => { input.value = '41'; input.dispatchEvent(new Event('change', { bubbles: true })); }),
    ]);
    await Promise.all([done(), otherPage.waitForFunction(() => !document.body.classList.contains('working'))]);
    assert.equal((await state('default')).player.volume, 41);
    assert.equal((await state('preview-two')).player.volume, 29);
    assert.equal(await page.locator('#bot-select').inputValue(), 'preview-two');
    assert.equal(await otherPage.locator('#bot-select').inputValue(), 'default');
    await Promise.all([
      page.locator('#volume').evaluate((input) => { input.value = '27'; input.dispatchEvent(new Event('change', { bubbles: true })); }),
      otherPage.locator('#volume').evaluate((input, volume) => { input.value = String(volume); input.dispatchEvent(new Event('change', { bubbles: true })); }, primary.player.volume),
    ]);
    await Promise.all([done(), otherPage.waitForFunction(() => !document.body.classList.contains('working'))]);
    pass('two browser tabs keep independent selections and simultaneous controls affect only their selected bots');

    await page.locator('[data-view=player]').click(); await page.locator('[data-music-source=qq]').click();
    await page.locator('#search-input').fill('晴天'); await page.locator('#search-input').press('Enter');
    await page.locator('#search-results [data-item-source=qq]').first().waitFor();
    let releaseAccount, accountStarted;
    const pendingAccount = new Promise((resolve) => { releaseAccount = resolve; });
    const accountReady = new Promise((resolve) => { accountStarted = resolve; });
    const delayedAccount = async (route) => {
      if (new URL(route.request().url()).searchParams.get('source') !== 'qq') return route.continue();
      accountStarted(); await pendingAccount; return route.fulfill({ json: { loggedIn: true, name: '预览账号' } });
    };
    await page.route('**/api/account?*', delayedAccount);
    await page.locator('#search-results [data-add]').first().click(); await accountReady;
    assert.equal(await page.locator('#bot-select').isDisabled(), true);
    await page.locator('#bot-select').evaluate((select) => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.locator('#bot-select').inputValue(), 'preview-two');
    const playSent = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/play' && request.method() === 'POST');
    releaseAccount();
    const playRequest = await playSent; assert.equal(playRequest.postDataJSON().botId, 'preview-two');
    await done(); await page.unroute('**/api/account?*', delayedAccount);
    await page.locator('[data-view=account]').click();
    pass('an account-check delay locks bot selection and keeps the pending song bound to its original bot');

    await page.locator('#add-bot-button').click();
    assert.equal(await page.locator('#bot-select').isDisabled(), true);
    await page.locator('#new-bot-name').fill('测试独立音乐房');
    await page.locator('#new-bot-token').fill('preview-ui-independent-token');
    assert.equal(await page.locator('#new-bot-token').getAttribute('type'), 'password');
    await page.locator('#add-bot-submit').click(); await done();
    await page.locator('#add-bot-dialog').waitFor({ state: 'hidden' });
    const added = (await read('/bots')).bots.find((bot) => bot.name === '测试独立音乐房');
    assert.ok(added); assert.equal(await page.locator('#bot-select').inputValue(), added.id);
    assert.equal(await page.locator('#new-bot-token').inputValue(), '');
    assert.equal((await page.locator('body').innerText()).includes('preview-ui-independent-token'), false);
    assert.equal(JSON.stringify(await read('/bots')).includes('preview-ui-independent-token'), false);
    await otherPage.locator('[data-view=account]').click();
    await otherPage.locator(`[data-remove-bot="${added.id}"]`).click();
    await otherPage.locator('#confirm-dialog').waitFor({ state: 'visible' });
    assert.match(await otherPage.locator('#confirm-message').textContent(), /停止播放并离开频道/);
    await otherPage.locator('#confirm-yes').click();
    await otherPage.waitForFunction(() => !document.body.classList.contains('working'));
    assert.equal((await read('/bots')).bots.some((bot) => bot.id === added.id), false);
    await page.waitForFunction(() => document.getElementById('bot-select').value === 'default' && document.getElementById('bot-error').hidden);
    assert.equal(await page.locator('#bot-select').inputValue(), 'default');
    await otherPage.close(); otherPage = null;
    pass('add/select/remove workflow keeps tokens private; removal in another tab safely selects the default bot');

    const failedBot = async (route) => {
      const response = await route.fetch(), body = await response.json();
      if (new URL(route.request().url()).searchParams.get('botId') === 'preview-two') {
        body.bot = { ...body.bot, online: false, status: 'error', error: '预览：语音权限不足' };
        body.bots = body.bots.map((bot) => bot.id === 'preview-two' ? { ...bot, ...body.bot, id: bot.id } : bot);
      }
      return route.fulfill({ response, json: body });
    };
    await page.route('**/api/state?*', failedBot);
    await page.locator('#bot-select').selectOption('preview-two');
    await page.locator('#bot-error').filter({ hasText: '语音权限不足' }).waitFor();
    assert.equal(await page.locator('#play-pause').isDisabled(), true);
    assert.equal(await page.locator('#channel-button').isDisabled(), true);
    await page.locator('[data-retry-bot="preview-two"]').waitFor();
    await page.unroute('**/api/state?*', failedBot);
    await page.locator('[data-retry-bot="preview-two"]').click(); await done();
    await page.waitForFunction(() => document.getElementById('bot-error').hidden);
    pass('failed bots show an actionable error and disable playback until retried');

    for (const [width, height] of [[1440, 1000], [801, 1000], [390, 844], [360, 800]]) {
      await page.setViewportSize({ width, height });
      await page.locator('[data-view=account]').click(); await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(out, `multi-bot-account-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `account overflow ${width}`);
      await page.locator('[data-view=player]').click();
      await page.screenshot({ path: path.join(out, `multi-bot-player-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `player overflow ${width}`);
    }
    await page.reload(); await page.waitForFunction(() => document.getElementById('bot-select').value === 'preview-two' && document.getElementById('bot-error').hidden);
    assert.equal(Number(await page.locator('#volume').inputValue()), 27);
    pass('selected bot survives reload; desktop and mobile layouts have no horizontal overflow');
    const scoped = new Set(['/api/channel', '/api/control', '/api/settings', '/api/play', '/api/playlist', '/api/heart', '/api/hot']);
    assert.ok(calls.filter((call) => scoped.has(call.route)).every((call) => typeof call.botId === 'string' && call.botId));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, screenshots: out }, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
