// Isolated browser fixture: no upstream calls, credentials or KOOK messages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'screenshots');
const observedAt = new Date().toISOString();
const metric = { key: 'primary', label: '5 小时额度窗口', usedPercent: 23, remainingPercent: 77, scope: 'upstream', kind: 'percent', unit: '%', observedAt, freshness: 'fresh' };
const account = (id, name, platform, type, planLabel, planSource) => ({ id, name, platform, type, planLabel, planSource, schedulable: true, status: 'active', freshness: 'fresh', observedAt, metrics: [{ ...metric }] });
const accounts = [
  account('1003', 'DeepSeek', 'deepseek', 'apikey', 'API 计费', 'type'),
  account('1010', 'Team 甲10', 'openai', 'oauth', 'Team', 'upstream'),
  account('1006', 'OpenAI Business', 'openai', 'oauth', 'Team Pro', 'upstream'),
  account('1004', 'Claude 未返回套餐', 'claude', 'oauth', '版本未知', 'unknown'),
  { ...account('1005', '旧缓存账号', 'openai', 'oauth'), plan: 'plus' },
  account('1008', 'Team 乙', 'openai', 'oauth', 'Team', 'upstream'),
  account('1009', 'OpenAI API', 'openai', 'apikey', 'API 计费', 'type'),
  account('1011', 'Team 甲2', 'openai', 'oauth', 'Team', 'upstream'),
  account('1002', 'Claude 主力', 'claude', 'oauth', 'Max 20x', 'upstream'),
  account('1001', 'OpenAI_5X', 'openai', 'oauth', 'Pro 5x', 'upstream'),
  account('1007', 'Team 甲2', 'openai', 'oauth', 'Team', 'upstream'),
];
const expectedIds = ['1001', '1007', '1011', '1010', '1008', '1006', '1009', '1005', '1004', '1002', '1003'];
let hostile = false;
const attack = '<img src=x onerror="window.planInjected=1">';
const writes = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (pathname === '/quota/api/session') return json({ authenticated: false, publicAccess: true, canManage: false });
  if (pathname === '/quota/api/status' || pathname === '/quota/api/refresh') {
    if (req.method === 'POST') writes.push(pathname);
    return json({ accounts: hostile ? [{ ...accounts.find(account => account.id === '1001'), planLabel: attack, planSource: attack }] : accounts, updatedAt: observedAt, refreshing: false });
  }
  const files = { '/quota/': 'index.html', '/quota/app.js': 'app.js', '/quota/style.css': 'style.css' };
  const filename = files[pathname];
  if (!filename) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(filename)]);
  res.end(fs.readFileSync(path.join(root, 'public', filename)));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);
    await page.locator('.account-card').first().waitFor();
    const visibleIds = () => page.locator('.account-card').evaluateAll(cards => cards.map(card => card.dataset.accountId));
    assert.deepEqual(await visibleIds(), expectedIds, 'Provider, plan, Chinese numeric name and ID tie-break sorting');
    assert.deepEqual(await page.locator('.account-plan').allTextContents(), ['Pro 5x', 'Team', 'Team', 'Team', 'Team', 'Team Pro', 'API 计费', '版本未知', '版本未知', 'Max 20x', 'API 计费']);
    assert.deepEqual(await page.locator('#platform-filters [data-platform]').evaluateAll(buttons => buttons.map(button => button.dataset.platform)), ['all', 'openai', 'claude', 'deepseek']);
    assert.deepEqual(await page.locator('#platform-filters [data-platform]').allTextContents(), ['全部11', 'OpenAI8', 'Claude2', 'DeepSeek1']);
    await page.locator('[data-platform="openai"]').click();
    assert.deepEqual(await visibleIds(), expectedIds.slice(0, 8), 'Platform filtering preserves the sorted OpenAI groups');
    await page.locator('#search').fill('Team 甲');
    assert.deepEqual(await visibleIds(), ['1007', '1011', '1010'], 'Search keeps numeric name order and stable equal-name ID order');
    await page.locator('#search').fill('');
    await page.locator('[data-platform="claude"]').click();
    assert.deepEqual(await visibleIds(), ['1004', '1002'], 'Other providers are grouped and ordered by account name');
    await page.locator('[data-platform="all"]').click();
    assert.deepEqual(await visibleIds(), expectedIds);
    assert.equal(await page.locator('#login-view').isVisible(), false);
    assert.equal(await page.locator('[data-account-details][open]').count(), 0);
    const checkLayout = async width => {
      await page.setViewportSize({ width, height: width > 760 ? 1024 : 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}px`);
      const sizes = await page.locator('.account-card').evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, height: card.getBoundingClientRect().height })));
      for (const card of sizes) assert.ok(sizes.filter(other => other.y === card.y).every(other => Math.abs(other.height - card.height) < 1), `Same-row account cards stay aligned at ${width}px`);
      assert.ok(await page.locator('.account-header').evaluateAll(headers => headers.every(header => {
        const bounds = header.getBoundingClientRect();
        return [...header.querySelectorAll('.provider-icon, .account-title, .account-plan, .account-scheduling')].every(item => {
          const rect = item.getBoundingClientRect();
          return rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5 && rect.width > 0 && rect.top >= bounds.top - .5 && rect.bottom <= bounds.bottom + .5;
        });
      })), `Account headers and long plan labels fit at ${width}px`);
    };
    await checkLayout(1440);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'account-plans-desktop.png'), fullPage: true });
    for (const [id, source] of [['1001', '上游返回'], ['1003', '按账号类型识别'], ['1004', '上游未提供版本']]) {
      const details = page.locator(`[data-account-id="${id}"] .account-details`);
      await details.locator('summary').click();
      assert.ok((await details.innerText()).includes(source));
      await details.locator('summary').click();
    }
    await checkLayout(390);
    await page.screenshot({ path: path.join(output, 'account-plans-mobile-390.png'), fullPage: true });
    await checkLayout(360);
    await page.screenshot({ path: path.join(output, 'account-plans-mobile.png'), fullPage: true });
    hostile = true;
    await page.reload();
    await page.locator('.account-plan').waitFor();
    assert.equal(await page.locator('.account-plan').innerText(), attack);
    assert.equal(await page.locator('.account-plan img').count(), 0);
    assert.equal(await page.evaluate(() => window.planInjected), undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(JSON.stringify({ labels: accounts.length, sortedIds: expectedIds, providers: ['OpenAI', 'Claude', 'DeepSeek'], filtersPreserveOrder: true, sources: 3, legacyFallback: true, desktopAligned: true, widths: [1440, 390, 360], longBusinessPlanFits: true, overflow: false, injectionEscaped: true, writes: 0, scriptErrors: 0 }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
