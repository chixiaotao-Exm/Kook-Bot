// Structured KOOK preview checks against local fixtures only; never sends a message.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'screenshots');
const now = new Date();
const observedAt = now.toISOString();
const names = ['OpenAI_5X', 'Team Pro 主力', 'Team Pro 备用', 'Team 研发', 'Plus 日常', 'Pro 第二账号', 'Team 工作区', 'OpenAI API'];
const accounts = names.map((name, index) => ({
  id: String(6269 + index), name, platform: 'openai', type: 'oauth', status: 'active',
  planLabel: index === 0 ? 'Pro 5x' : index === 4 ? 'Plus' : index === 7 ? 'API 计费' : 'Team Pro',
  schedulable: index !== 6, freshness: 'fresh', observedAt,
  metrics: ['5h', '7d'].map((key, position) => ({
    key, label: key === '5h' ? '5 小时额度窗口' : '7 天额度窗口', scope: 'upstream', kind: 'percent',
    usedPercent: [[0, 38], [50, 80], [100, 99.999], [70, 69.5], [50, 49.5], [69.996, 49.996]][index]?.[position] ?? (index * 11 + position * 17) % 100, unit: '%', freshness: 'fresh', observedAt,
    resetAt: new Date(now.getTime() + (position ? 120 : 3) * 3600000).toISOString()
  })),
  windowStats: ['5h', '7d'].map((key, position) => ({
    key, periodKind: 'quota', metricKey: key, scope: 'local', requests: position ? 2468 + index : 157 + index,
    tokens: position ? 15843000 + index : 1436000 + index, accountCost: position ? 152.18 : 5.14,
    userCost: position ? 162.99 : 5.57, estimatedTotalCost: position ? 716.12 : null,
    currency: 'USD', complete: true, observedAt, freshness: 'fresh'
  }))
}));
const snapshot = { accounts, updatedAt: observedAt, refreshing: false, refreshIntervalMs: 600000 };
let preview;
const writes = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.method !== 'GET') writes.push(url.pathname);
  const endpoint = url.pathname.slice('/quota/api/'.length);
  if (url.pathname.startsWith('/quota/api/')) {
    if (endpoint === 'session') return json({ authenticated: false, publicAccess: true, canManage: false, csrf: 'fixture' });
    if (endpoint === 'status') return json(snapshot);
    if (endpoint === 'reports') return json({ records: [] });
    if (endpoint === 'report-preview') return json(preview);
    if (endpoint === 'report-config') return json({ enabled: true, configured: true, botName: 'bug', channelName: '111', channelId: '1234', timeZone: 'Asia/Shanghai', times: Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`) });
    res.writeHead(404); return res.end();
  }
  const file = ({ '/quota/': 'index.html', '/quota/index.html': 'index.html', '/quota/app.js': 'app.js', '/quota/style.css': 'style.css' })[url.pathname];
  if (!file) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(file)]);
  res.end(fs.readFileSync(path.join(root, 'public', file)));
});

(async () => {
  const { buildBroadcastCards } = await import(pathToFileURL(path.join(root, 'src/broadcast-cards.js')));
  preview = { cards: buildBroadcastCards(snapshot, { dashboardUrl: 'https://example.test/quota/', timeZone: 'Asia/Shanghai' }), text: '文本兼容预览' };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);
    await page.locator('[data-view=reports]').click();
    await page.locator('.report-card').first().waitFor();
    check(await page.locator('.report-card-account').count() === 8, 'All eight account titles remain visible');
    check(await page.locator('.report-card-fields').count() === 8, 'Every account has its own quota fields');
    check(await page.locator('.report-card-bar').count() === 16, 'All sixteen quota bars remain visible');
    check(await page.locator('.report-battery').count() === 16, 'All quota bars are rendered as batteries');
    check(await page.locator('.report-battery').evaluateAll(nodes => nodes.every(node => node.children.length === 10 && node.getAttribute('role') === 'img' && node.getAttribute('aria-label').includes('剩余'))), 'Every battery has ten segments and an accessible remaining label');
    const charge = await page.locator('.report-battery').evaluateAll(nodes => nodes.slice(0, 6).map(node => ({ filled: node.querySelectorAll('.filled').length, tone: node.className.split(' ').at(-1), label: node.getAttribute('aria-label'), terminal: getComputedStyle(node, ':after').width })));
    check(charge.map(item => item.filled).join(',') === '10,6,5,2,0,1', 'Battery fill represents remaining charge: 100%, 62%, 50%, 20%, 0%, and tiny positive');
    check(charge.map(item => item.tone).join(',') === 'high,high,medium,low,low,low', 'Remaining 50% is yellow and 20% is red');
    check(charge[4].label.includes('剩余 0%') && charge[5].label.includes('剩余 <0.01%'), 'Empty and tiny remaining percentages are distinguished');
    check(charge.every(item => item.terminal === '5px'), 'All batteries have visible end terminals');
    const boundaryCharge = await page.locator('.report-battery').evaluateAll(nodes => nodes.slice(6, 10).map(node => ({ tone: node.className.split(' ').at(-1), label: node.getAttribute('aria-label'), panel: node.parentElement.className, background: getComputedStyle(node.parentElement).backgroundColor, border: getComputedStyle(node.parentElement).borderColor })));
    check(boundaryCharge.map(item => item.tone).join(',') === 'low,medium,medium,high', 'Remaining 30%, 30.5%, 50%, and 50.5% respect exact red/yellow/green boundaries');
    check(boundaryCharge.every(item => item.panel.includes(`charge-${item.tone}`)), 'Each quota panel matches its battery severity');
    check(await page.locator('.report-battery').nth(10).evaluate(node => node.classList.contains('medium') && node.getAttribute('aria-label').includes('剩余 30%')) && await page.locator('.report-battery').nth(11).evaluate(node => node.classList.contains('high') && node.getAttribute('aria-label').includes('剩余 50%')), 'Native color preserves exact remaining 30.004% and 50.004% despite rounded labels');
    check(new Set(boundaryCharge.map(item => item.background)).size === 3 && new Set(boundaryCharge.map(item => item.border)).size === 3, 'Low, medium, and high quotas have distinct tinted backgrounds and borders');
    check(await page.locator('.report-card-badge.purple').count() === 8 && await page.locator('.report-card-badge.success').count() === 7 && await page.locator('.report-card-badge.secondary').count() === 1, 'Plan and enabled/disabled labels are separate colored badges');
    check(await page.locator('.report-card-field .report-font-success').count() > 0 && await page.locator('.report-card-field .report-font-warning').count() > 0 && await page.locator('.report-card-field .report-font-danger').count() > 0, 'Native font tokens use all three quota colors');
    check(!(await page.locator('#report-preview').innerText()).includes('(font)'), 'Recognized native font syntax is decoded for preview');
    check(await page.locator('.report-card-title').evaluate(node => getComputedStyle(node).color) !== await page.locator('.report-card-account').first().evaluate(node => getComputedStyle(node).color), 'Report and account headings use distinct purple/blue accents');
    check((await page.locator('#report-preview').innerText()).includes('Pro 5x'), 'Account version stays visible');
    check((await page.locator('#readonly-cadence').innerText()).includes('30'), 'Existing thirty-minute reporting is unchanged');
    check(await page.locator('#report-form').isHidden(), 'Public preview remains read-only');
    const firstFields = page.locator('.report-card-fields').first();
    const desktopBoxes = await firstFields.locator('.report-card-field').evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, width: node.getBoundingClientRect().width })));
    check(desktopBoxes.length === 2 && desktopBoxes[0].top === desktopBoxes[1].top && Math.abs(desktopBoxes[0].width - desktopBoxes[1].width) < 1, 'Desktop shows equal 5h and 7d columns');
    const target = await page.locator('.report-card-actions a').first();
    check(await target.getAttribute('href') === 'https://example.test/quota/' && (await target.getAttribute('rel')).includes('noopener'), 'Allowed dashboard link has safe external navigation');
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px page has no horizontal overflow`);
      check(await page.locator('.report-card, .report-card-field').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), `${width}px card content has no clipping`);
      check(await page.locator('.report-battery').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none' && node.getBoundingClientRect().right + 5 <= node.parentElement.getBoundingClientRect().right)), `${width}px batteries and terminals fit without animation`);
      if (width < 600) {
        const boxes = await firstFields.locator('.report-card-field').evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })));
        check(boxes[1].top > boxes[0].bottom, `${width}px quota windows stack with spacing`);
      }
      await page.screenshot({ path: path.join(output, `quota-card-preview-${width}.png`), fullPage: true });
      await page.locator('.preview-panel').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `quota-card-preview-${width}-detail.png`) });
      await firstFields.screenshot({ path: path.join(output, `quota-battery-high-${width}.png`) });
      await page.locator('.report-card-fields').nth(1).screenshot({ path: path.join(output, `quota-battery-low-${width}.png`) });
      await page.locator('.report-card-fields').nth(2).screenshot({ path: path.join(output, `quota-battery-empty-${width}.png`) });
      await page.locator('.report-card-fields').nth(3).screenshot({ path: path.join(output, `quota-battery-boundary-${width}.png`) });
    }
    preview = { cards: [{ type: 'card', modules: [{ type: 'section', text: { type: 'paragraph', cols: 2, fields: [
      { type: 'plain-text', content: '5h 未知\n🔋 [□□□□□□□□□□]▏' },
      { type: 'plain-text', content: '7d 剩余 62%\n■■■■□□□□□□' }
    ] } }] }] };
    await page.locator('#preview-refresh').click();
    await page.waitForFunction(() => document.querySelector('#report-preview').textContent.includes('5h 未知'));
    check(await page.locator('.report-battery').count() === 0, 'Unknown remaining values never become artificial empty batteries');
    check(await page.locator('.report-card-bar').count() === 1 && (await page.locator('#report-preview').innerText()).includes('■■■■□□□□□□'), 'Legacy progress-bar card payloads remain supported');
    const injection = '<img src=x onerror="window.previewInjected=true">';
    preview = { text: 'Fallback must not win', cards: [{ type: 'card', modules: [
      { type: 'header', text: { type: 'plain-text', content: injection } },
      { type: 'context', elements: [{ type: 'plain-text', content: '<script>window.previewInjected=true</script>' }] },
      { type: 'context', elements: [{ type: 'kmarkdown', content: `(font)${injection}(font)[danger] · (font)<svg onload="window.previewInjected=true">(font)[url(unsafe)]` }] },
      { type: 'section', text: { type: 'paragraph', cols: 2, fields: [{ type: 'plain-text', content: 'A'.repeat(500) }, { type: 'plain-text', content: injection }] } },
      { type: 'image-group', elements: [{ type: 'image', src: 'https://untrusted.invalid/a.png' }] },
      { type: 'action-group', elements: ['javascript:window.previewInjected=true', 'https://user:password@example.test/', 'data:text/html,unsafe', 'https://example.test/safe'].map(value => ({ type: 'button', click: 'link', value, text: { type: 'plain-text', content: injection } })) }
    ] }] };
    await page.locator('#preview-refresh').click();
    await page.waitForFunction(() => document.querySelector('#report-preview').textContent.includes('<img'));
    check(await page.locator('#report-preview img, #report-preview script').count() === 0 && !(await page.evaluate(() => window.previewInjected)), 'Upstream markup is rendered literally and never executed');
    check(await page.locator('#report-preview svg, #report-preview [style]').count() === 0 && (await page.locator('#report-preview .report-font-danger').innerText()).includes('<img'), 'Whitelisted font colors render safe text and unsupported color tokens never become attributes');
    check((await page.locator('#report-preview').innerText()).includes('[url(unsafe)]'), 'Unknown font color tokens remain literal text');
    check(await page.locator('#report-preview a').count() === 1 && await page.locator('#report-preview a').getAttribute('href') === 'https://example.test/safe', 'Unsafe schemes and embedded credentials are rejected');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Long untrusted text wraps on the narrowest mobile width');
    preview = { text: `旧版纯文本\n${injection}` };
    await page.locator('#preview-refresh').click();
    await page.waitForFunction(() => document.querySelector('#report-preview').textContent.startsWith('旧版纯文本'));
    check(await page.locator('.report-card').count() === 0 && await page.locator('#report-preview img').count() === 0, 'Legacy text fallback is preserved and safe');
    check(await page.locator('#report-preview').evaluate(node => getComputedStyle(node).whiteSpace) === 'pre-wrap', 'Legacy multiline text keeps its line breaks');
    preview = { cards: [{ type: 'unsupported', modules: [] }], text: '无有效卡片时的文本' };
    await page.locator('#preview-refresh').click();
    await page.waitForFunction(() => document.querySelector('#report-preview').textContent === '无有效卡片时的文本');
    check(await page.locator('.report-card').count() === 0, 'Unsupported empty card payload falls back to text');
    check(errors.length === 0, `No browser runtime errors: ${errors.join(', ')}`);
    check(writes.length === 0, 'Preview verification makes no writes or outgoing messages');
    console.log(`Structured report preview UI checks passed: ${passed}. Screenshots: ${output}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
