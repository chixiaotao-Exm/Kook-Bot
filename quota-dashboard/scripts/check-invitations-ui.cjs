// Offline browser fixture. Every invite response is local; no upstream or email is contacted.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'data/screenshots');
const now = new Date().toISOString();
const capabilities = { enabled: true, publicInvites: true, canInvite: true };
const invitation = (count, extra = {}) => ({ supported: true, availableCount: count, shouldShow: true,
  programId: 'codex_referral_consumer', programLabel: '个人邀请', requiresConfirmation: true,
  title: '邀请朋友体验 Codex', description: '发送推荐邀请，对方通过邮箱查看活动说明。',
  rules: ['请确认接收邮箱填写正确。', '邀请内容以接收邮件中的活动说明为准。'], checkedAt: now, freshness: 'fresh', ...extra });
const accounts = [
  { id: '1', name: 'OpenAI_5X', planLabel: 'Pro 5x', invitation: invitation(2) },
  { id: '2', name: 'Team Pro', planLabel: 'Team Pro', invitation: invitation(0, { programId: 'codex_referral_workspace', programLabel: '工作区邀请', requiresConfirmation: false }) },
  { id: '3', name: '未取得名额', planLabel: 'Team', invitation: invitation(null, { shouldShow: false, freshness: 'unknown' }) },
  { id: '4', name: 'Claude', platform: 'claude', planLabel: 'API 计费', invitation: null },
  { id: '5', name: '尚未开放', planLabel: 'Team', invitation: invitation(null, { supported: false, shouldShow: false }) },
].map(account => ({ platform: 'openai', type: 'oauth', planSource: 'upstream', schedulable: true, status: 'active',
  observedAt: now, freshness: 'fresh', metrics: [{ key: '5h', label: '5小时额度窗口', scope: 'upstream', kind: 'percent', remainingPercent: 77, usedPercent: 23, observedAt: now }], ...account }));
const writes = [], errors = []; let inviteMode = 'hold', refreshError = false, holdRefresh = false, pendingInvite, pendingRefresh;
accounts[0].invitation.rules.push('<img src=x onerror="window.inviteInjected=1">');
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), route = url.pathname;
  if (route === '/quota/api/session') return json(res, { authenticated: false, publicAccess: true, canManage: false, csrfToken: 'fixture-csrf', invitations: capabilities });
  if (route === '/quota/api/status') return json(res, { accounts, updatedAt: now, refreshIntervalMs: 600000 });
  const match = /^\/quota\/api\/invitations\/(\d+)\/(refresh|invite)$/.exec(route);
  if (match && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); writes.push({ id: match[1], kind: match[2], body, csrf: req.headers['x-csrf-token'] });
    const account = accounts.find(item => item.id === match[1]);
    if (match[2] === 'refresh') {
      if (refreshError) return json(res, { error: { code: 'UNAVAILABLE', message: '暂时无法确认名额' } }, 503);
      if (holdRefresh && match[1] === '1') { pendingRefresh = res; return; }
      return json(res, { invitation: account.invitation, cachePersisted: true });
    }
    if (inviteMode === 'hold') { pendingInvite = res; return; }
    if (inviteMode === 'unknown') return json(res, { error: { code: 'SEND_UNKNOWN', message: '结果未知' } }, 502);
    return json(res, { sent: true, invitation: account.invitation, cachePersisted: true, refreshFailed: false });
  }
  const file = { '/quota/': 'index.html', '/quota/app.js': 'app.js', '/quota/style.css': 'style.css' }[route];
  if (!file) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(root, 'public', file)));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { const original = window.setTimeout; window.inviteTimeouts = [];
      window.setTimeout = (fn, delay, ...args) => { if (delay >= 110000 && delay <= 150000) window.inviteTimeouts.push(delay); return original(fn, delay, ...args); }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);
    await page.locator('[data-account-id="1"]').waitFor();
    const card = id => page.locator(`[data-account-id="${id}"]`);
    const inviteButton = id => card(id).locator('[data-invite-account]');
    const ready = async () => { await page.locator('#invitation-email:not([disabled])').waitFor(); };
    const open = async id => { await inviteButton(id).click(); await page.locator('#invitation-dialog').waitFor({ state: 'visible' }); };
    const close = () => page.locator('#invitation-close').click();
    const submitted = () => writes.filter(item => item.kind === 'invite');
    assert.match(await card('1').locator('[data-account-invitations]').innerText(), /可邀请 2 人/);
    assert.match(await card('2').locator('[data-account-invitations]').innerText(), /可邀请 0 人/);
    assert.match(await card('3').locator('[data-account-invitations]').innerText(), /未知/);
    assert.equal(await card('4').locator('[data-account-invitations]').count(), 0);
    assert.equal(await inviteButton('5').isDisabled(), true); assert.equal(writes.length, 0);
    await open('1'); await ready();
    assert.equal(writes.at(-1).kind, 'refresh'); assert.deepEqual(writes.at(-1).body, {});
    assert.equal(writes.at(-1).csrf, 'fixture-csrf');
    assert.equal(await page.locator('#invitation-confirm').isChecked(), false);
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true);
    assert.equal(await page.locator('#invitation-rules img').count(), 0);
    accounts[0].invitation.rules.pop(); await page.locator('#invitation-refresh').click(); await ready();
    await page.locator('#invitation-email').fill('invalid'); await page.locator('#invitation-confirm').check();
    await page.locator('#invitation-submit').click(); assert.equal(submitted().length, 0);
    await page.locator('#invitation-email').fill('friend@example.test');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'invitations-dialog-desktop.png') });
    const sent = page.waitForRequest(req => req.url().endsWith('/1/invite'));
    await page.locator('#invitation-submit').click(); await sent;
    await page.locator('#invitation-form').dispatchEvent('submit'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#invitation-dialog').isVisible(), true);
    assert.equal(await page.locator('#invitation-close').isDisabled(), true);
    assert.equal(submitted().length, 1);
    assert.deepEqual(Object.keys(submitted()[0].body).sort(), ['confirmed', 'email', 'programId', 'requestId']);
    assert.equal(submitted()[0].body.confirmed, true); assert.equal(submitted()[0].body.programId, 'codex_referral_consumer');
    assert.match(submitted()[0].body.requestId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    accounts[0].invitation = invitation(1); json(pendingInvite, { sent: true, invitation: accounts[0].invitation, cachePersisted: true }); pendingInvite = null;
    await page.locator('#invitation-feedback').filter({ hasText: '邀请已发送' }).waitFor();
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true); assert.equal(await page.locator('#invitation-email').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => window.inviteTimeouts), [120000]); await close();
    await open('2'); await page.locator('#invitation-feedback').filter({ hasText: '没有可用' }).waitFor();
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true); assert.equal(await page.locator('#invitation-confirm-row').isVisible(), false); await close();
    await open('3'); await page.locator('#invitation-feedback').filter({ hasText: '暂不可邀请' }).waitFor();
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true); await close();
    capabilities.publicInvites = false; capabilities.canInvite = false;
    const beforeLogin = writes.length; await open('1'); await page.locator('#invitation-login').waitFor({ state: 'visible' });
    assert.equal(writes.length, beforeLogin); assert.equal(await page.locator('#invitation-submit').isDisabled(), true);
    assert.match(await page.locator('#invitation-login').getAttribute('href'), /manage=1&invite=1/);
    capabilities.publicInvites = true; capabilities.canInvite = true; refreshError = true;
    await page.locator('#invitation-refresh').click(); await page.locator('#invitation-feedback').filter({ hasText: '无法确认名额' }).waitFor();
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true);
    refreshError = false; await page.locator('#invitation-refresh').click(); await ready(); inviteMode = 'unknown';
    await page.locator('#invitation-email').fill('other@example.test'); await page.locator('#invitation-confirm').check(); await page.locator('#invitation-submit').click();
    await page.locator('#invitation-feedback').filter({ hasText: '发送结果未确认' }).waitFor();
    assert.equal(submitted().length, 2); assert.equal(await page.locator('#invitation-submit').isDisabled(), true);
    await page.locator('#invitation-form').dispatchEvent('submit'); assert.equal(submitted().length, 2);
    await page.locator('#invitation-refresh').click(); await ready(); assert.equal(await page.locator('#invitation-confirm').isChecked(), false);
    await page.route('**/quota/api/invitations/1/invite', route => route.abort('timedout'));
    await page.locator('#invitation-confirm').check(); await page.locator('#invitation-submit').click();
    await page.locator('#invitation-feedback').filter({ hasText: '发送结果未确认' }).waitFor();
    assert.equal(await page.locator('#invitation-submit').isDisabled(), true); await close();
    holdRefresh = true; await open('1'); await page.locator('#invitation-refresh:disabled').waitFor();
    const refreshDeadline = Date.now() + 10000;
    while (!pendingRefresh) { assert.ok(Date.now() < refreshDeadline, 'The held preflight did not reach the fixture'); await new Promise(resolve => setTimeout(resolve, 10)); }
    await close(); await open('2'); await page.locator('#invitation-feedback').filter({ hasText: '没有可用' }).waitFor();
    json(pendingRefresh, { invitation: invitation(9), cachePersisted: true }); pendingRefresh = null; holdRefresh = false;
    assert.equal(await page.locator('#invitation-account-name').textContent(), 'Team Pro');
    assert.equal(await page.locator('#invitation-count').textContent(), '可邀请 0 人'); await close();
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok(await page.locator('.account-invitations').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
      const rows = await page.locator('.account-card').evaluateAll(nodes => nodes.map(node => ({ top: node.offsetTop, height: node.getBoundingClientRect().height })));
      const sizes = new Map(); for (const row of rows) { if (sizes.has(row.top)) assert.ok(Math.abs(sizes.get(row.top) - row.height) < 1); else sizes.set(row.top, row.height); }
      await page.screenshot({ path: path.join(output, `invitations-overview-${width}.png`), fullPage: true });
      await open('1'); await ready();
      assert.ok(await page.locator('#invitation-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await page.screenshot({ path: path.join(output, `invitations-dialog-${width}.png`) }); await close();
    }
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => window.inviteInjected), undefined);
    console.log(JSON.stringify({ publicInvites: true, preflightRequired: true, consentRequired: true, singleSubmission: true,
      unknownDoesNotRetry: true, lateRefreshIsolated: true, requestTimeoutMs: 120000, widths: [1440, 390, 360], realInvites: 0, scriptErrors: 0 }));
  } finally { pendingInvite?.destroy(); pendingRefresh?.destroy(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); server.closeAllConnections(); server.close(); process.exitCode = 1; });
