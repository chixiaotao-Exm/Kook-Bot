import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async name => JSON.parse(await readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8'));
const catalog = [...(await json('catalog-basic.json')).items, ...(await json('catalog-extended.json')).items];
const layout = await json('bilingual-layout.json');
const manifest = await json('menu.json');
const normal = text => text.normalize('NFC').replace(/\s+/gu, '');

test('eight rendered bilingual pages cover every source entry once with unchanged names and dollar prices', () => {
  assert.deepEqual(manifest.languages, ['zh-CN', 'es']);
  assert.equal(layout.pages.length, 8);
  const rows = layout.pages.flatMap(page => page.entries);
  assert.equal(rows.length, 272); assert.equal(new Set(rows.map(row => row.key)).size, 272);
  assert.equal(rows.filter(row => row.priceCents !== null).length, 184);
  assert.equal(rows.filter(row => row.priceCents === null).length, 88);
  assert.equal(rows.filter(row => row.uncertain).length, 8);
  const byKey = new Map(rows.map(row => [row.key, row]));
  for (const item of catalog) {
    const row = byKey.get(item.key); assert.ok(row, item.key);
    assert.equal(row.chinese, item.name); assert.equal(row.spanish, item.spanish);
    assert.equal(row.priceCents, item.priceCents);
    const written = normal(row.text.map(run => run.text).join(''));
    assert.ok(written.includes(normal(item.name)), `Chinese text not rendered: ${item.key}`);
    assert.ok(written.includes(normal(item.spanish)), `Spanish text not rendered: ${item.key}`);
    const price = item.priceCents === null ? 'Sinprecio' : '$' + (item.priceCents / 100).toFixed(2).replace(/\.?0+$/, '');
    assert.ok(written.includes(price), `Price not rendered: ${item.key}`);
  }
});

test('recorded text boxes stay on page and inside non-overlapping item boxes', () => {
  for (const [index, page] of layout.pages.entries()) {
    const [width, height] = page.size;
    assert.deepEqual(page.size, [manifest.pages[index].width, manifest.pages[index].height]);
    for (const run of [...page.pageText, ...page.entries.flatMap(row => row.text)]) {
      const [x1, y1, x2, y2] = run.bbox;
      assert.ok(x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height, `${page.file}: ${run.text}`);
    }
    for (const column of [0, 1]) {
      const entries = page.entries.filter(row => row.column === column).sort((a, b) => a.rect[1] - b.rect[1]);
      for (const [offset, row] of entries.entries()) {
        if (offset) assert.ok(entries[offset - 1].rect[3] <= row.rect[1] + 2, `${page.file}: ${row.key} overlaps`);
        for (const run of row.text) {
          const [x1, y1, x2, y2] = run.bbox;
          assert.ok(x1 >= row.rect[0] && y1 >= row.rect[1] && x2 <= row.rect[2] + 1 && y2 <= row.rect[3], `${page.file}: ${row.key}`);
        }
      }
    }
  }
});

test('every combo component is rendered in Chinese and original Spanish', async () => {
  const details = (await json('menu-combo-details.json')).items;
  assert.equal(details.length, 10);
  for (const item of details) {
    const row = layout.pages[0].entries.find(row => row.key === item.key);
    const written = normal(row.text.map(run => run.text).join(''));
    assert.equal(item.chinese.length, item.spanish.length);
    for (const text of [...item.chinese, ...item.spanish]) assert.ok(written.includes(normal(text)), `${item.key}: ${text}`);
  }
});
