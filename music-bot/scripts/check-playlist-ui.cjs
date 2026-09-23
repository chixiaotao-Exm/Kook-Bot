const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:8787');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'This check may mutate only a loopback preview');
const output = path.resolve('data/screenshots');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(12000);
  const checks = [], errors = [], mutations = [], details = [];
  let releaseStale;
  const state = async () => (await (await page.request.get(new URL('/api/state', base).href)).json());
  const queueSize = (value) => value.player.queue.length + (value.player.current ? 1 : 0);
  const fingerprint = (value) => JSON.stringify([value.player.current?.id, value.player.queue.map((track) => track.id)]);
  const record = (name) => { checks.push(name); console.log(`PASS ${name}`); };
  const assertRows = async (count) => page.waitForFunction((expected) => document.querySelectorAll('#playlist-tracks .track-row').length === expected, count);
  const discover = async () => {
    await page.locator('[data-view=discover]').click();
    await page.locator('.playlist-item').first().waitFor();
  };
  const visual = async (width, height, name) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, name) });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('#view-playlist h2, #playlist-detail-meta, #playlist-add')]
        .filter((element) => element.getBoundingClientRect().width && element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.id),
    }));
    assert.equal(layout.overflow, false, `${width}px horizontal overflow`);
    assert.deepEqual(layout.clipped, [], `${width}px clipped metadata/headings`);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const bottom = await page.evaluate(() => ({
      rowBottom: document.querySelector('#playlist-tracks .track-row:last-child').getBoundingClientRect().bottom,
      moreBottom: document.querySelector('#playlist-more').hidden ? 0 : document.querySelector('#playlist-more').getBoundingClientRect().bottom,
      dockTop: document.querySelector('.player-dock').getBoundingClientRect().top,
    }));
    assert.ok(Math.max(bottom.rowBottom, bottom.moreBottom) <= bottom.dockTop, `${width}px final row/control covered by dock: ${JSON.stringify(bottom)}`);
    await page.screenshot({ path: path.join(output, name.replace('.png', '-bottom.png')) });
    record(`${width}px detail layout and footer reachability`);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== base.origin) return;
    if (request.method() === 'POST') mutations.push(url.pathname);
    if (request.method() === 'GET' && url.pathname === '/api/playlist') details.push(url.search);
  });
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' });
    await page.locator('#app').waitFor({ state: 'visible' });
    const initial = await state();
    assert.equal(initial.preview, true, 'Refusing mutations outside preview mode');
    assert.equal(initial.player.maxQueue, 500);
    assert.ok(initial.player.capacity >= 247, 'Restart the local preview before this check: 247 free queue slots required');
    await discover();

    const beforeCover = await state();
    await page.locator('.playlist-open').first().focus();
    await page.keyboard.press('Enter');
    await assertRows(50);
    assert.equal(await page.locator('#view-playlist').isVisible(), true);
    assert.equal(await page.locator('#search-form').isVisible(), false);
    assert.equal(await page.locator('#playlist-detail-name').textContent(), '今日热歌精选');
    assert.match(await page.locator('#playlist-detail-meta').textContent(), /桃音音乐社区.*123/);
    assert.equal(await page.locator('#playlist-description').textContent(), '华语与粤语精选。');
    assert.equal(await page.locator('#playlist-track-count').textContent(), '50 / 123 首');
    assert.equal(fingerprint(await state()), fingerprint(beforeCover));
    assert.equal(mutations.length, 0);
    record('keyboard cover opens metadata/detail without queue mutation');
    await visual(1440, 1000, 'playlist-detail-desktop.png');
    await visual(390, 844, 'playlist-detail-mobile.png');

    await page.locator('#playlist-more').click();
    await assertRows(100);
    assert.equal(await page.locator('#playlist-track-count').textContent(), '100 / 123 首');
    await page.locator('#playlist-more').click();
    await assertRows(123);
    assert.equal(await page.locator('#playlist-track-count').textContent(), '123 / 123 首');
    assert.equal(await page.locator('#playlist-more').isVisible(), false);
    assert.equal(new Set(await page.locator('#playlist-tracks [data-add]').evaluateAll((buttons) => buttons.map((button) => button.dataset.add))).size, 123);
    assert.deepEqual(details.slice(0, 3).map((query) => new URLSearchParams(query).get('offset')), ['0', '50', '100']);
    record('pagination 50 -> 100 -> 123 without duplicate tracks');

    await page.locator('#playlist-back').click();
    await page.locator('[data-category=acg]').click();
    await page.locator('.playlist-item').last().waitFor();
    await page.locator('.playlist-name').last().scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const savedScroll = await page.evaluate(() => scrollY);
    assert.ok(savedScroll > 0, 'Expected a nonzero discover scroll position');
    await page.locator('.playlist-name').last().click();
    await assertRows(50);
    assert.equal(await page.locator('#playlist-detail-name').textContent(), '日落之前的温柔');
    await page.locator('#playlist-back').click();
    assert.equal(await page.locator('[data-category=acg]').getAttribute('aria-selected'), 'true');
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - savedScroll) <= 1, 'Back did not restore discover scroll');
    assert.equal(mutations.length, 0);
    record('playlist name opens detail; back restores category and scroll');

    let failFirst = true;
    const errorRoute = async (route) => {
      if (failFirst) { failFirst = false; return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Preview playlist retry test' }) }); }
      return route.continue();
    };
    await page.route('**/api/playlist?*', errorRoute);
    await page.locator('.playlist-open').first().click();
    await page.locator('#playlist-detail-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#playlist-tracks .track-row').count(), 0);
    assert.match(await page.locator('#playlist-more').textContent(), /重新加载/);
    await page.screenshot({ path: path.join(output, 'playlist-detail-retry-mobile.png') });
    await page.locator('#playlist-more').click();
    await assertRows(50);
    assert.equal(await page.locator('#playlist-detail-error').isVisible(), false);
    await page.unroute('**/api/playlist?*', errorRoute);
    record('initial detail error exposes retry and recovers');

    await page.locator('#playlist-back').click();
    let staleStarted;
    const started = new Promise((resolve) => { staleStarted = resolve; });
    const pending = new Promise((resolve) => { releaseStale = resolve; });
    let held = false;
    const staleRoute = async (route) => {
      if (!held) {
        held = true;
        const response = await route.fetch();
        staleStarted();
        await pending;
        return route.fulfill({ response });
      }
      return route.continue();
    };
    await page.route('**/api/playlist?*', staleRoute);
    await page.locator('.playlist-open').first().click();
    await started;
    await page.locator('#playlist-back').click();
    await page.locator('.playlist-open').nth(1).click();
    await assertRows(50);
    const currentName = await page.locator('#playlist-detail-name').textContent();
    assert.equal(currentName, '温柔粤语 · 细听岁月');
    releaseStale();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#playlist-detail-name').textContent(), currentName);
    assert.equal(await page.locator('#playlist-tracks .track-row').count(), 50);
    await page.unroute('**/api/playlist?*', staleRoute);
    assert.equal(mutations.length, 0);
    record('late response cannot replace the newly opened playlist');

    const beforeOne = await state();
    const oneResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/play' && response.request().method() === 'POST');
    await page.locator('#playlist-tracks [data-add]').first().click();
    assert.equal((await oneResponse).status(), 200);
    await page.waitForFunction(() => !document.body.classList.contains('working'));
    assert.equal(queueSize(await state()) - queueSize(beforeOne), 1);
    assert.equal(await page.locator('#view-playlist').isVisible(), true);
    record('per-song add queues exactly one and stays in detail');

    const beforeImport = await state();
    const importResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/playlist' && response.request().method() === 'POST');
    await page.locator('#playlist-add').click();
    const imported = await (await importResponse).json();
    await page.waitForFunction(() => !document.body.classList.contains('working'));
    assert.equal(imported.added, 123);
    assert.equal(queueSize(await state()) - queueSize(beforeImport), imported.added);
    assert.equal(await page.locator('#view-playlist').isVisible(), true);
    assert.equal(await page.locator('#toast').textContent(), `已加入 ${imported.added} 首歌曲`);
    record('full detail import reports actual 123-song count and stays in detail');

    await page.locator('#playlist-back').click();
    const beforeQuick = await state(), detailCount = details.length;
    const quickResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/playlist' && response.request().method() === 'POST');
    await page.locator('.playlist-play').first().click();
    const quick = await (await quickResponse).json();
    await page.waitForFunction(() => !document.body.classList.contains('working'));
    assert.equal(queueSize(await state()) - queueSize(beforeQuick), quick.added);
    assert.equal(quick.added, 123);
    assert.equal(await page.locator('#view-player').isVisible(), true);
    assert.equal(details.length, detailCount);
    assert.deepEqual(mutations, ['/api/play', '/api/playlist', '/api/playlist']);
    record('existing quick-play button imports without opening detail');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, screenshots: output, mutations }, null, 2));
  } finally {
    releaseStale?.();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
