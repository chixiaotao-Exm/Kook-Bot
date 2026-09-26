import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createWaiterService, loadCatalog } from '../src/waiter-service.js';
import { createMenuSearch } from '../src/menu-search.js';
import { createWaiter } from '../src/waiter.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const items = await loadCatalog(assets);
const flavors = items.filter(item => item.group === '冰淇淋');
const source = JSON.parse(await readFile(new URL('../assets/catalog-icecream.json', import.meta.url), 'utf8'));

test('photo adds six confirmed flavors and one explicitly unresolved label without inferred prices', () => {
  assert.equal(items.length, 279); assert.equal(flavors.length, 7);
  assert.equal(flavors.filter(item => item.uncertain).length, 1);
  assert.ok(flavors.every(item => item.priceCents === null));
  assert.deepEqual(flavors.filter(item => !item.uncertain).map(item => item.originalLabel),
    ['Oreo', 'Mantecado', 'Choco Oreo', 'Toddy', 'Parchita', 'Torta Suiza']);
  assert.equal(flavors.find(item => item.uncertain).originalLabel, null);
  assert.doesNotMatch(JSON.stringify(source), /Brownie|Pralin|Pastelado/i);
});

test('confirmed Chinese flavors translate to usable Spanish without AI and preserve generic HELADO', async () => {
  let calls = 0;
  const service = createWaiterService({ items, client: { generate: async () => { calls++; throw Error('unexpected'); } } });
  assert.equal(await service.reply('奥利奥 百香果 巧克力奥利奥'), 'HELADO DE OREO\nHELADO DE PARCHITA\nHELADO DE CHOCO OREO');
  assert.equal(await service.reply('冰淇淋'), 'HELADO');
  assert.equal(await service.reply('瑞士蛋糕'), 'HELADO DE TORTA SUIZA');
  assert.match(await service.reply('右上角冰淇淋'), /原文不确定|请确认/);
  assert.equal(calls, 0);
});

test('flavor quotes never inherit generic ice cream price and unknown label stays excluded', () => {
  const waiter = createWaiter(items);
  const result = waiter.quote('奥利奥冰淇淋2份，蛋糕1份');
  assert.equal(result.totalCents, 300); assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.type === 'unpriced' && issue.key === 'ice:1'));
  for (const item of flavors) {
    const quote = waiter.quote(item.key);
    assert.equal(quote.complete, false); assert.equal(quote.totalCents, 0);
    assert.match(quote.text, /未标价|待确认/);
  }
});

test('ice-cream search exposes all original item and flavor rows without inventing the unreadable label', () => {
  const search = createMenuSearch(items), result = search('搜索冰淇淋');
  assert.equal(result.total, 8);
  assert.ok(flavors.every(item => result.items.some(row => row.key === item.key)));
  assert.match(result.text, /口味待确认/);
  assert.doesNotMatch(result.text, /Brownie|Pastelado|Pralin/i);
});

test('ice-cream image text includes six source labels and clear missing-price and uncertainty notes', async () => {
  const layout = JSON.parse(await readFile(new URL('../assets/icecream-layout.json', import.meta.url), 'utf8'));
  assert.equal(layout.entryCount, 7);
  const text = await readFile(new URL('../assets/catalog-icecream.json', import.meta.url), 'utf8');
  assert.equal(layout.catalogSha256, createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'));
  const written = layout.entries.flatMap(row => row.text.map(text => text.text)).join('\n');
  for (const item of flavors.filter(item => !item.uncertain)) assert.ok(written.includes(item.originalLabel), item.originalLabel);
  assert.match(written, /口味待确认/); assert.doesNotMatch(written, /Brownie|Pastelado|Pralin/i);
  for (const run of [...layout.pageText, ...layout.entries.flatMap(row => row.text)]) {
    const [x1,y1,x2,y2] = run.bbox;
    assert.ok(x1 >= 0 && y1 >= 0 && x2 <= layout.size[0] && y2 <= layout.size[1], run.text);
  }
});
