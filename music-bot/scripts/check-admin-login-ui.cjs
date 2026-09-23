// Exercise real preview APIs with three isolated browser identities and fixture credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), port = Number(process.env.ADMIN_PREVIEW_PORT || 8796), base = `http://127.0.0.1:${port}`;
const username = 'preview-admin', password = 'Preview-admin-2026!', changedPassword = 'Preview-changed-2026!';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safe = (value) => [password, changedPassword].reduce((result, secret) => result.split(secret).join('[PRIVATE]'), String(value));
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kook-admin-ui-'));
  const preview = spawn(process.execPath, [path.join(root, 'src/preview.js')], { cwd: dir, env: { ...process.env, PREVIEW_PORT: String(port), PREVIEW_SOCIAL: 'true', PREVIEW_REQUIRE_PASSWORD: 'false', PREVIEW_ADMIN_USERNAME: username, PREVIEW_ADMIN_PASSWORD: password }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', exited = false, browser;
  preview.stdout.on('data', (x) => { log += x; }); preview.stderr.on('data', (x) => { log += x; }); preview.on('exit', () => { exited = true; });
  const pass = (name) => console.log(`PASS ${name}`), errors = [];
  async function until(task, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await task()) return; await wait(120); } throw Error('Timed out waiting for admin UI state'); }
  async function read(page, route) { const response = await page.request.get(base + '/api' + route); assert.equal(response.status(), 200, route); return response.json(); }
  async function post(page, route, data, expected = 200) { const session = await read(page, '/session'); const response = await page.request.post(base + '/api' + route, { data, headers: { 'X-CSRF-Token': session.csrf, Origin: base } }); assert.equal(response.status(), expected, route); return response.json(); }
  async function enter(page) { await page.goto(base + '/room/default'); await page.locator('#room:not([hidden])').waitFor(); }
  async function name(page, value) { await page.locator('#identity-button').click(); await page.locator('#nickname').fill(value); await page.locator('#identity-form button[type=submit]').click(); await page.locator('#identity-dialog').waitFor({ state: 'hidden' }); }
  async function login(page, value = password, returnTo = '/admin/console') {
    await page.goto(base + '/admin?' + new URLSearchParams({ returnTo })); await page.locator('#admin-login-form').waitFor();
    await page.locator('#admin-username').fill(username); await page.locator('#admin-password').fill(value);
    await page.locator('#admin-login-form button[type=submit]').click();
  }
  try {
    await until(() => { if (exited) throw Error('Admin preview startup failed: ' + safe(log)); return log.includes(`Preview: ${base}`); });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })));
    const [admin, other, guest] = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of [admin, other, guest]) { page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push(error.message)); }
    await guest.goto(base + '/'); await guest.locator('.room-card').first().waitFor();
    assert.equal(await guest.locator('#console-link').isVisible(), false);
    await guest.goto(base + '/admin/console?botId=default'); await guest.waitForURL(base + '/admin?' + new URLSearchParams({ returnTo: '/admin/console?botId=default' })); await guest.locator('#admin-login-form').waitFor();
    await guest.goto(base + '/rooms'); await guest.locator('.room-card').first().waitFor();
    assert.equal(await guest.locator('#admin-link').textContent(), '管理员登录');
    const guestSession = await read(guest, '/session'); assert.equal(guestSession.adminLoginEnabled, true); assert.equal(guestSession.passwordRequired, false);
    await enter(guest); await name(guest, '访客小月'); await guest.locator('#room-query').fill('1000011'); await guest.locator('#room-query').press('Enter'); await guest.locator('[data-request="preview"]').click();
    await until(async () => (await read(guest, '/room?botId=default')).mine.length === 1);
    await post(guest, '/control', { botId: 'default', action: 'volume', value: 1 }, 403);
    pass('public rooms remain password-free; named guests can request songs and cannot manage playback');

    await enter(admin); await name(admin, '准备登录的小桃'); const before = await read(admin, '/session');
    await admin.locator('#room-query').fill('1000010'); await admin.locator('#room-query').press('Enter'); await admin.locator('[data-request="preview"]').click();
    await until(async () => (await read(admin, '/room?botId=default')).mine.length === 1);
    let loginRequests = 0; admin.on('request', (request) => { if (new URL(request.url()).pathname === '/api/admin/login') loginRequests++; });
    await login(admin, 'fixture-wrong-password'); await admin.locator('#admin-message.error').waitFor();
    assert.equal(loginRequests, 1); assert.equal(await admin.locator('#admin-password').inputValue(), ''); assert.ok(!(await read(admin, '/session')).actor.siteAdmin);
    pass('incorrect password has a visible error and one request without silently retrying credentials');

    await login(admin, password, '/room/default'); await admin.waitForURL(base + '/room/default'); await admin.locator('#edit-room').waitFor({ state: 'visible' });
    const after = await read(admin, '/session'); assert.equal(after.actor.siteAdmin, true); assert.equal(after.actor.id, before.actor.id); assert.equal(after.actor.name, before.actor.name); assert.notEqual(after.csrf, before.csrf);
    assert.equal((await read(admin, '/room?botId=default')).mine.length, 1); assert.equal(await admin.locator('#admin-link').textContent(), '账号设置');
    const storage = await admin.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); assert.ok(!storage.includes(password)); assert.ok(!new URL(admin.url()).search.includes(password));
    pass('login rotates CSRF and preserves nickname and my requests; credentials stay out of URL and browser storage');

    await login(other, password, '//example.com/'); await other.waitForURL(base + '/admin/console'); assert.equal((await read(other, '/session')).actor.siteAdmin, true);
    await other.goto(base + '/'); await other.locator('.room-card').first().waitFor(); assert.equal(await other.locator('#app').count(), 0); assert.equal(await other.locator('#console-link').getAttribute('href'), '/admin/console?botId=default');
    await other.locator('#console-link').click(); await other.waitForURL(base + '/admin/console?botId=default'); await other.locator('#app').waitFor({ state: 'visible' });
    pass('root stays the public lobby after admin login; management entry opens the dedicated console');
    for (const [returnTo, expected] of [[null, '/admin/console'], ['/admin/console?botId=preview-two&view=room', '/admin/console?botId=preview-two&view=room'], ['/?botId=default&view=room', '/admin/console?botId=default&view=room'], ['/index.html?botId=preview-two', '/admin/console?botId=preview-two'], ['//example.com/', '/admin/console'], ['/admin/login', '/admin/console'], ['/room/default', '/room/default']]) {
      await admin.goto(base + '/admin' + (returnTo === null ? '' : '?' + new URLSearchParams({ returnTo }))); await admin.locator('#admin-account').waitFor(); assert.equal(await admin.locator('#admin-console').getAttribute('href'), expected);
    }
    pass('login return destinations retain room/view context, map old console paths and reject external/admin-loop destinations');
    await admin.goto(base + '/admin'); await admin.locator('#admin-account').waitFor(); assert.equal(await admin.locator('#admin-account-username').textContent(), username);
    await admin.locator('.admin-password-details summary').click(); await admin.locator('#current-password').fill(password); await admin.locator('#new-password').fill(changedPassword); await admin.locator('#confirm-password').fill('Mismatched-2026!'); await admin.locator('#admin-password-form button[type=submit]').click();
    await admin.locator('#admin-message').filter({ hasText: '不一致' }).waitFor();
    await admin.locator('#confirm-password').fill(changedPassword); await admin.locator('#admin-password-form button[type=submit]').click(); await admin.locator('#admin-message').filter({ hasText: '密码已更新' }).waitFor();
    for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(await admin.locator('#' + id).inputValue(), '');
    assert.equal((await read(admin, '/session')).actor.siteAdmin, true); assert.ok(!(await read(other, '/session')).actor.siteAdmin); assert.equal((await read(guest, '/session')).actor.id, guestSession.actor.id);
    assert.equal((await read(guest, '/room?botId=default')).mine.length, 1);
    await post(other, '/control', { botId: 'default', action: 'volume', value: 2 }, 403);
    pass('password confirmation catches typos; saved password clears inputs and invalidates only other admin logins');

    await admin.locator('#admin-logout').click(); await admin.locator('#admin-login-form').waitFor(); const loggedOut = await read(admin, '/session');
    assert.ok(!loggedOut.actor.siteAdmin); assert.equal(loggedOut.actor.id, before.actor.id); assert.equal(loggedOut.actor.name, before.actor.name); assert.equal((await read(admin, '/room?botId=default')).mine.length, 1);
    await login(other, password); await other.locator('#admin-message.error').waitFor(); await login(other, changedPassword); await other.waitForURL(base + '/admin/console');
    await other.locator('#logout').click(); await other.waitForURL(base + '/'); assert.ok(!(await read(other, '/session')).actor.siteAdmin);
    pass('account-page and console logout remove only admin privileges; old password fails and new password works');

    await other.goto(base + '/admin'); await other.locator('#admin-login-form').waitFor();
    await post(other, '/admin/login', { username, password: changedPassword }); await post(other, '/admin/logout', {});
    let stalePagePosts = 0; const countStalePosts = (request) => { if (new URL(request.url()).pathname === '/api/admin/login') stalePagePosts++; }; other.on('request', countStalePosts);
    await other.locator('#admin-username').fill(username); await other.locator('#admin-password').fill(changedPassword); await other.locator('#admin-login-form button[type=submit]').click();
    await other.locator('#admin-message.error').waitFor(); await other.locator('#admin-login-form button[type=submit]:not([disabled])').waitFor();
    assert.equal(stalePagePosts, 1); assert.equal(await other.locator('#admin-username').inputValue(), username); assert.equal(await other.locator('#admin-password').inputValue(), '');
    await other.locator('#admin-password').fill(changedPassword); await other.locator('#admin-login-form button[type=submit]').click(); await other.waitForURL(base + '/admin/console'); assert.equal(stalePagePosts, 2);
    other.off('request', countStalePosts); await post(other, '/admin/logout', {});
    pass('an already-open login form refreshes stale CSRF without replaying credentials; the next manual submission succeeds');

    const screenshots = path.join(root, 'data/screenshots'); await fs.mkdir(screenshots, { recursive: true });
    for (const [width, height] of [[1440, 1000], [360, 820]]) {
      await admin.setViewportSize({ width, height }); await admin.goto(base + '/admin'); await admin.locator('#admin-login-form').waitFor();
      assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await admin.screenshot({ path: path.join(screenshots, `admin-login-${width}.png`), fullPage: true });
      await guest.setViewportSize({ width, height }); await guest.goto(base + '/rooms'); await guest.locator('.room-card').first().waitFor(); assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await login(admin, changedPassword); await admin.waitForURL(base + '/admin/console'); await admin.goto(base + '/admin'); await admin.locator('#admin-account').waitFor(); await admin.locator('.admin-password-details summary').click();
    assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await admin.screenshot({ path: path.join(screenshots, 'admin-account-360.png'), fullPage: true });
    assert.deepEqual(errors, []); pass('desktop/mobile login, account settings and room headers fit with no page errors');
  } finally {
    if (browser) await browser.close(); if (!exited) { preview.kill('SIGTERM'); await Promise.race([new Promise((resolve) => preview.once('exit', resolve)), wait(5000)]); } if (!exited) preview.kill('SIGKILL');
    console.log('Isolated administrator preview stopped; no real account credentials used.');
  }
})().catch((error) => { console.error(safe(error.stack || error.message)); process.exitCode = 1; });
