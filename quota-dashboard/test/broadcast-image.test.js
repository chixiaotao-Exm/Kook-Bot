import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BroadcastImageRenderer } from '../src/broadcast-image.js';

const png = svg => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), createHash('sha256').update(svg).digest()]);
const account = (i, remaining = 62) => ({ name: `账号 ${i}`, platform: 'openai', planLabel: 'Pro 5x', schedulable: true, status: 'active', metrics: [{ key: '7d', kind: 'percent', remainingPercent: remaining, freshness: 'fresh', resetAt: '2026-09-29T00:00:00.000Z' }] });
const snapshot = (count = 8) => ({ accounts: Array.from({ length: count }, (_, i) => account(i)), updatedAt: '2026-09-22T00:00:00.000Z' });
const capture = () => {
  const svgs = [];
  const renderer = new BroadcastImageRenderer({ renderPng: async (svg, dimensions) => { svgs.push({ text: svg.toString(), ...dimensions }); return png(svg); } });
  return { renderer, svgs };
};

test('glass report puts all eight accounts into one high-resolution two-column poster', async () => {
  const { renderer, svgs } = capture();
  const result = await renderer.render(snapshot());
  assert.equal(result.images.length, 1);
  assert.equal(result.accountCount, 8);
  assert.equal(result.truncatedCount, 0);
  for (const image of result.images) {
    assert.equal(image.width, 1800);
    assert.ok(image.height < 2400);
    assert.equal(image.mimeType, 'image/png');
    assert.match(image.id, /^[a-f\d]{64}$/);
    assert.equal(renderer.getImage(image.id), image);
    assert.match(image.alt, /完整总览/);
    assert.doesNotMatch(image.alt, /第 .* 页/);
  }
  assert.match(svgs[0].text, /账号 0/);
  assert.match(svgs[0].text, /账号 2/);
  assert.match(svgs[0].text, /账号 3/);
  assert.match(svgs[0].text, /账号 7/);
  assert.equal(svgs.length, 1);
  assert.equal((svgs[0].text.match(/data-account-card=/g) || []).length, 8);
  assert.match(svgs[0].text, /translate\(48 207\) scale\(/);
  assert.match(svgs[0].text, /translate\(914 207\) scale\(/);
});

test('battery keeps exact thresholds, remaining direction, over-limit and unknown semantics', async () => {
  const { renderer, svgs } = capture();
  const data = snapshot(3);
  data.accounts[0].metrics[0].remainingPercent = 30;
  data.accounts[1].metrics[0].remainingPercent = 50;
  data.accounts[2].metrics[0].remainingPercent = 50.01;
  await renderer.render(data);
  const image = svgs[0].text;
  assert.match(image, /fill="#ff8eaa"[^>]*>剩余 30%/);
  assert.match(image, /fill="#ffce76"[^>]*>剩余 50%/);
  assert.match(image, /fill="#76e8c1"[^>]*>剩余 50.01%/);
  const over = snapshot(2);
  over.accounts[0].metrics[0].usedPercent = 125;
  over.accounts[1].metrics = [{ kind: 'percent', key: '5h', usedPercent: null, remainingPercent: null }];
  await renderer.render(over);
  assert.match(svgs[1].text, />剩余 0%</);
  assert.match(svgs[1].text, />已用 125%</);
  assert.match(svgs[1].text, />额度未知</);
  assert.match(svgs[1].text, /未知 ≠ 0/);
});

test('retains stale dates, shared balance, local rolling usage and incomplete flags accurately', async () => {
  const { renderer, svgs } = capture();
  const data = snapshot(1);
  data.accounts[0].freshness = 'stale';
  data.accounts[0].observedAt = '2026-09-21T00:00:00.000Z';
  data.accounts[0].metrics = [{ kind: 'balance', label: '账户共享余额', value: 1234.5, unit: 'USD', freshness: 'unknown' }];
  data.accounts[0].windowStats = [{ key: '5h', periodKind: 'rolling', requests: 3, tokens: 1000000, userCost: 2.12, accountCost: 99, estimatedTotalCost: 500, complete: false, freshness: 'stale' }];
  data.stale = true;
  await renderer.render(data);
  const svg = svgs[0].text;
  assert.match(svg, /账户共享余额 · 时间未知/);
  assert.match(svg, /\$1,234.50/);
  assert.match(svg, /旧采样 09\/21 08:00/);
  assert.match(svg, /本站 近5h（未完成）（旧值）/);
  assert.match(svg, /3 次 · 1M Token · 扣费 \$2.12/);
  assert.doesNotMatch(svg, /\$99|\$500/);
  assert.match(svg, /更新未完成，以下为上次快照/);
});

test('mixed card heights align within rows and retain full dates and financial values inside the poster', async () => {
  const { renderer, svgs } = capture();
  const data = snapshot(8);
  data.accounts[0].name = '这是用于验证长账号名称自动换行而不覆盖下方套餐和额度内容的测试账号';
  data.accounts[0].freshness = 'stale';
  data.accounts[0].observedAt = '2026-09-21T00:00:00.000Z';
  data.accounts[0].metrics.push({ key: '5h', kind: 'percent', remainingPercent: 30, resetAt: '2026-09-22T00:35:48.000Z' });
  for (const item of data.accounts) item.windowStats = [
    { key: '5h', requests: 1, tokens: 76, userCost: .00088, complete: true },
    { key: '7d', requests: 963, tokens: 43_719_118, userCost: 151.4927, complete: true },
  ];
  data.accounts[7].metrics = [{ kind: 'balance', label: '账户共享余额', value: 10_000_070.4, unit: 'USD' }];
  const result = await renderer.render(data);
  const svg = svgs[0].text;
  const cards = [...svg.matchAll(/transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"><g data-account-card="(\d+)" data-card-height="([\d.]+)">([\s\S]*?)<\/g><\/g>/g)]
    .map(match => ({ x: +match[1], y: +match[2], scale: +match[3], height: +match[5], content: match[6] }));
  assert.equal(cards.length, 8);
  for (let i = 0; i < cards.length; i += 2) {
    assert.equal(cards[i].y, cards[i + 1].y);
    assert.equal(cards[i].height, cards[i + 1].height);
    assert.ok(cards[i].x + 916 * cards[i].scale < cards[i + 1].x);
    assert.ok(cards[i + 1].x + 916 * cards[i + 1].scale <= 1752);
    if (i + 2 < cards.length) assert.ok(cards[i].y + (cards[i].height + 8) * cards[i].scale < cards[i + 2].y);
  }
  for (const card of cards) {
    for (const match of card.content.matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)) {
      assert.ok(+match[1] >= 0 && +match[1] <= 916);
      assert.ok(+match[2] > 0 && +match[2] < card.height - 12);
    }
    assert.ok(card.y + card.height * card.scale < result.images[0].height - 130);
  }
  assert.match(svg, />重置 09\/22 08:35</);
  assert.match(svg, />重置 09\/29 08:00</);
  assert.match(svg, /扣费 \$0.00088</);
  assert.match(svg, /扣费 \$151.49</);
  assert.match(svg, />\$10,000,070.40</);
});

test('uses only whitelisted text and never emits credential, script, external image or remote font sources', async () => {
  const { renderer, svgs } = capture();
  const data = snapshot(1);
  data.accessToken = 'private-top-secret';
  data.accounts[0].credentials = { key: 'not-for-render' };
  data.accounts[0].notes = ['do-not-include-note'];
  data.accounts[0].name = '<script>alert(1)</script> & sk-0123456789abcdef0123456789abcdef';
  data.accounts[0].planLabel = 'https://evil.test/secret?token=abc';
  data.accounts[0].error = 'raw-private-error';
  await renderer.render(data, { dashboardUrl: 'https://api.example.com/quota/?key=private-query#secret' });
  const svg = svgs[0].text;
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /\[已隐藏\]/);
  assert.match(svg, /查询异常/);
  assert.match(svg, /api.example.com/);
  assert.doesNotMatch(svg, /private-top-secret|not-for-render|do-not-include-note|raw-private-error|private-query|0123456789|evil\.test/);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|@font-face|href=|onload=/);
  const urls = [...svg.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(urls.every(url => /^#[a-z\d]+$/i.test(url)));
});

test('caps oversized reports at 24 accounts in one image with an explicit remaining-account notice', async () => {
  const { renderer, svgs } = capture();
  const result = await renderer.render(snapshot(27));
  assert.equal(result.images.length, 1);
  assert.equal(result.accountCount, 27);
  assert.equal(result.truncatedCount, 3);
  assert.match(svgs[0].text, /账号 23/);
  assert.doesNotMatch(svgs[0].text, /账号 24/);
  assert.ok(result.images[0].width * result.images[0].height < 32_000_000);
  assert.ok(svgs.every(svg => /另 3 个账号见看板/.test(svg.text)));
});

test('empty and unavailable snapshots produce an honest readable image', async () => {
  const { renderer, svgs } = capture();
  await renderer.render(snapshot(0));
  await renderer.render({ accounts: [], lastError: 'must-not-display' });
  assert.match(svgs[0].text, /暂无账号数据/);
  assert.match(svgs[1].text, /账号读取失败，暂无可用快照/);
  assert.doesNotMatch(svgs[1].text, /must-not-display/);
});

test('same sanitized snapshot is singleflight and unused secret changes do not invalidate cache', async () => {
  let calls = 0;
  const renderer = new BroadcastImageRenderer({ renderPng: async svg => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return png(svg); } });
  const data = snapshot();
  const results = await Promise.all([renderer.render(data), renderer.render(data), renderer.render(data)]);
  assert.equal(calls, 1);
  assert.equal(results[0], results[1]);
  data.credential = 'different-secret';
  data.accounts[0].credentials = 'new-key';
  assert.equal(await renderer.render(data), results[0]);
  assert.equal(calls, 1);
});

test('cache expires after at most ten minutes and is limited to four groups', async () => {
  let time = 1_800_000_000_000;
  const renderer = new BroadcastImageRenderer({ renderPng: async svg => png(svg), now: () => time, ttlMs: 99_000_000, maxGroups: 100 });
  const results = [];
  for (let i = 0; i < 5; i++) {
    const data = snapshot(1); data.accounts[0].name = `cache-${i}`;
    results.push(await renderer.render(data));
  }
  assert.equal(renderer.getImage(results[0].images[0].id), null);
  assert.ok(renderer.getImage(results[4].images[0].id));
  assert.equal(renderer.getImage('../etc/passwd'), null);
  time += 600_000;
  assert.equal(renderer.getImage(results[4].images[0].id), null);
});

test('cache honors its byte limit and generated content is strongly hashed', async () => {
  const renderer = new BroadcastImageRenderer({ maxBytes: 1024, renderPng: async svg => Buffer.concat([png(svg), Buffer.alloc(700)]) });
  const one = await renderer.render(snapshot(1));
  const two = await renderer.render(snapshot(2));
  assert.equal(renderer.getImage(one.images[0].id), null);
  assert.ok(renderer.getImage(two.images[0].id));
  assert.equal(two.images[0].id, createHash('sha256').update(two.images[0].buffer).digest('hex'));
});

test('invalid PNG, oversized PNG and unsafe errors are rejected without poisoned pending cache', async () => {
  let mode = 'failure';
  const renderer = new BroadcastImageRenderer({ renderPng: async svg => {
    if (mode === 'failure') throw new Error('private-network-key');
    if (mode === 'invalid') return Buffer.from('<svg>bad</svg>');
    if (mode === 'large') return Buffer.concat([png(svg), Buffer.alloc(4 * 1024 * 1024)]);
    return png(svg);
  } });
  await assert.rejects(renderer.render(snapshot()), { message: '播报图片生成失败' });
  mode = 'invalid';
  await assert.rejects(renderer.render(snapshot()), /格式或大小/);
  mode = 'large';
  await assert.rejects(renderer.render(snapshot()), /格式或大小/);
  mode = 'ok';
  assert.equal((await renderer.render(snapshot())).images.length, 1);
});

test('validates timezone and observes cancellation without exposing raw error', async () => {
  const { renderer } = capture();
  await assert.rejects(renderer.render(snapshot(), { timeZone: '../../invalid' }), /时区/);
  const controller = new AbortController(); controller.abort('secret');
  await assert.rejects(renderer.render(snapshot(), { signal: controller.signal }), { message: '图片生成已取消' });
});
