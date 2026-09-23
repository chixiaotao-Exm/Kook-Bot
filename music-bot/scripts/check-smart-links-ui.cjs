const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:8788/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only local preview may be changed');
const out = path.resolve('data/screenshots'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(18000);
  const errors = [], posts = [], checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => { if (new URL(req.url()).origin === base.origin && req.method() === 'POST') posts.push({ route: new URL(req.url()).pathname, ...req.postDataJSON() }); });
  const read = async (route) => (await (await page.request.get(new URL('/api' + route, base).href)).json());
  const state = (botId = 'default') => read('/state?botId=' + botId);
  const write = async (route, data) => {
    const session = await read('/session');
    const response = await page.request.post(new URL('/api' + route, base).href, { data, headers: { 'X-CSRF-Token': session.csrf } });
    assert.equal(response.status(), 200, route); return response.json();
  };
  const preview = page.locator('#smart-link-preview');
  const mutations = () => posts.filter((p) => ['/api/play', '/api/playlist'].includes(p.route));
  const ready = async (source, kind, bot = 'default') => {
    await page.waitForFunction(({ source, kind, bot }) => {
      const el = document.getElementById('smart-link-preview');
      return el && !el.hidden && el.dataset.smartSource === source && el.dataset.smartKind === kind && el.dataset.smartBot === bot && el.getAttribute('aria-busy') === 'false' && Boolean(el.querySelector('#smart-link-add, #smart-link-channel'));
    }, { source, kind, bot });
  };
  const paste = async (value, source, kind, bot = 'default', enter = false) => {
    await page.locator('#search-input').fill(value); if (enter) await page.locator('#search-input').press('Enter');
    await ready(source, kind, bot);
  };
  const done = async () => { await page.locator('#smart-link-continue').waitFor(); await page.waitForFunction(() => !document.body.classList.contains('working')); };
  const pass = (name) => { checks.push(name); console.log('PASS ' + name); };
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' }); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal((await state()).preview, true);
    const initial = await state(), initialSecond = await state('preview-two');
    await paste('https://y.qq.com/n/ryqq_v2/toplist/26', 'qq', 'playlist');
    assert.match(await preview.innerText(), /123/); assert.equal(mutations().length, 0);
    await page.locator('[data-music-source="qq"]').click();
    await paste('分享歌曲：https://music.163.com/#/song?id=66285。', 'netease', 'song');
    assert.match(await preview.innerText(), /葡萄成熟时/);
    assert.equal((await state()).player.queue.length, initial.player.queue.length);
    assert.equal((await state('preview-two')).player.queue.length, initialSecond.player.queue.length);
    await page.locator('#smart-link-add').click(); await done();
    assert.equal((await state()).player.queue.at(-1).source, 'netease');
    assert.equal(mutations().at(-1).source, 'netease'); assert.equal(mutations().at(-1).botId, 'default');
    pass('complete links and share text auto-detect platform/type; previews never add music and explicit song add uses the detected source');

    await page.locator('#smart-link-continue').click();
    await page.locator('#search-input').fill('晴天'); await page.locator('#search-input').press('Enter');
    await page.locator('#search-results [data-item-source="qq"]').first().waitFor();
    await page.locator('[data-view="player"]').click();
    await paste('66285', 'qq', 'song', 'default', true);
    const beforeLogin = mutations().length;
    await page.locator('#smart-link-add').click();
    await page.locator('#qr-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#bot-select').isDisabled(), true);
    await page.locator('#qr-dialog').waitFor({ state: 'hidden', timeout: 20000 });
    await ready('qq', 'song'); assert.equal(mutations().length, beforeLogin);
    assert.equal(await page.locator('#search-input').inputValue(), '66285');
    await page.locator('#smart-link-add').click(); await done();
    assert.equal((await state()).player.queue.at(-1).source, 'qq');
    assert.equal(mutations().length, beforeLogin + 1);
    pass('keywords and numeric IDs honor manual source; QQ login preserves preview and never automatically adds afterward');

    await page.locator('#import-button').click();
    await page.locator('#playlist-input').fill('https://music.163.com/playlist?id=1');
    await page.locator('#import-form button[type="submit"]').click();
    await ready('netease', 'playlist'); assert.match(await preview.innerText(), /123/);
    assert.equal(mutations().length, beforeLogin + 1);
    pass('the existing import dialog also auto-selects link source and opens a read-only playlist preview');

    let release, started, delivered, held = false;
    const pending = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    const finished = new Promise((resolve) => { delivered = resolve; });
    const delayed = async (route) => {
      if (held) return route.continue();
      held = true; const response = await route.fetch(), body = await response.json();
      body.playlist.name = 'OLD TARGET RESPONSE'; started(); await pending;
      await route.fulfill({ response, json: body }); delivered();
    };
    await page.route('**/api/resolve?*', delayed);
    await page.locator('#search-input').fill('https://y.qq.com/n/ryqq/playlist/2'); await entered;
    await page.locator('#bot-select').selectOption('preview-two');
    await ready('qq', 'playlist', 'preview-two');
    release(); await finished; await page.unroute('**/api/resolve?*', delayed);
    assert.equal((await preview.innerText()).includes('OLD TARGET RESPONSE'), false);
    assert.match(await preview.innerText(), /深夜音乐机器人/);
    const beforeOther = (await state()).player.queue;
    let releaseAdd, startedAdd;
    const heldAdd = new Promise((resolve) => { releaseAdd = resolve; });
    const enteredAdd = new Promise((resolve) => { startedAdd = resolve; });
    const delayedAdd = async (route) => { if (route.request().method() !== 'POST') return route.continue(); startedAdd(); await heldAdd; return route.continue(); };
    await page.route('**/api/playlist', delayedAdd);
    const countBefore = mutations().length;
    await page.locator('#smart-link-add').click(); await enteredAdd;
    assert.equal(await page.locator('#smart-link-add').isDisabled(), true);
    assert.equal(await page.locator('#bot-select').isDisabled(), true);
    assert.equal(await page.locator('#search-input').isDisabled(), true);
    assert.equal(await page.locator('[data-music-source="netease"]').isDisabled(), true);
    await page.locator('#smart-link-add').dispatchEvent('click');
    releaseAdd(); await done(); await page.unroute('**/api/playlist', delayedAdd);
    assert.equal(mutations().length, countBefore + 1); assert.equal(mutations().at(-1).botId, 'preview-two');
    assert.equal(mutations().at(-1).maxItems, 123);
    assert.deepEqual((await state()).player.queue, beforeOther);
    pass('changing bots invalidates old previews; submission locks its original target and repeated clicks add only once');

    let second = await state('preview-two');
    while (second.player.capacity > 5) {
      await write('/playlist', { botId: 'preview-two', source: 'netease', id: '1', maxItems: Math.min(123, second.player.capacity - 5) });
      second = await state('preview-two');
    }
    await paste('https://music.163.com/#/playlist?id=1', 'netease', 'playlist', 'preview-two');
    await page.locator('#smart-link-add').filter({ hasText: '加入 5 首' }).waitFor();
    await page.locator('#smart-link-add').click(); await done();
    assert.equal(mutations().at(-1).maxItems, 5); assert.equal((await state('preview-two')).player.capacity, 0);
    assert.match(await page.locator('#smart-link-feedback').innerText(), /5 首/);
    await paste('https://y.qq.com/n/ryqq/toplist/26', 'qq', 'playlist', 'preview-two');
    assert.equal(await page.locator('#smart-link-add').isDisabled(), true);
    assert.match(await page.locator('#smart-link-capacity').innerText(), /队列已满/);
    pass('partial imports are capped to the reviewed count and a full queue still permits preview while disabling add');

    await write('/control', { botId: 'preview-two', action: 'stop' });
    await paste('https://music.163.com/song?id=66285', 'netease', 'song', 'preview-two');
    await page.locator('#smart-link-channel').waitFor();
    await page.locator('#smart-link-channel').click();
    await page.locator('#voice-select').selectOption('20003');
    await page.locator('#text-select').selectOption('20002');
    await page.locator('#channel-form button[type="submit"]').click();
    await page.locator('#channel-dialog').waitFor({ state: 'hidden' });
    await ready('netease', 'song', 'preview-two');
    assert.equal(await page.locator('#smart-link-add').isEnabled(), true);
    pass('missing channel prompts a channel choice and returns to the same preview without automatic playback');

    await page.locator('#search-input').fill('https://163cn.tv/abc');
    await page.locator('#smart-link-feedback').filter({ hasText: '短链接' }).waitFor();
    const failResolve = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '网易云请求失败，请重新扫码登录。' }) });
    await page.route('**/api/resolve?*', failResolve);
    await page.locator('#search-input').fill('https://music.163.com/song?id=66285');
    await page.locator('#smart-link-feedback').filter({ hasText: '网易云请求失败' }).waitFor();
    assert.equal(await page.locator('#smart-link-login').count(), 0);
    await page.unroute('**/api/resolve?*', failResolve);
    await page.locator('#smart-link-retry').click(); await ready('netease', 'song', 'preview-two');
    pass('short links have an explicit unsupported message; metadata errors preserve input and offer the correct retry path');

    let releaseAccount, startedAccount, accountDelivered;
    const accountPending = new Promise((resolve) => { releaseAccount = resolve; });
    const accountEntered = new Promise((resolve) => { startedAccount = resolve; });
    const accountFinished = new Promise((resolve) => { accountDelivered = resolve; });
    let accountHeld = false;
    const delayedAccount = async (route) => {
      if (new URL(route.request().url()).searchParams.get('source') !== 'qq' || accountHeld) return route.continue();
      accountHeld = true; const response = await route.fetch(); startedAccount(); await accountPending; await route.fulfill({ response }); accountDelivered();
    };
    await paste('https://y.qq.com/n/ryqq/songDetail/66285', 'qq', 'song', 'preview-two');
    await page.route('**/api/account?*', delayedAccount);
    await page.locator('#smart-link-add').click(); await accountEntered;
    assert.equal(await page.locator('#channel-button').isDisabled(), true);
    await write('/control', { botId: 'preview-two', action: 'stop' });
    releaseAccount(); await accountFinished; await page.unroute('**/api/account?*', delayedAccount);
    await page.waitForFunction(() => !document.getElementById('search-input').disabled);
    assert.equal((await state('preview-two')).player.context, null);
    assert.equal((await state('preview-two')).player.current, null);
    pass('a channel changed by another client during login checks cannot silently rejoin or receive the pending add');

    await write('/channel', { botId: 'preview-two', guildId: '10001', voiceChannelId: '20003', textChannelId: '20002' });
    await paste('https://music.163.com/playlist?id=1', 'netease', 'playlist', 'preview-two');
    for (const width of [1440, 801, 390, 360]) {
      await page.setViewportSize({ width, height: width > 800 ? 1000 : 844 });
      await preview.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `smart-links-live-ui-preview-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    }
    pass('song and playlist previews fit desktop and narrow mobile layouts');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, mutations: mutations().map(({ route, botId, source, maxItems }) => ({ route, botId, source, maxItems })), screenshots: out }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
