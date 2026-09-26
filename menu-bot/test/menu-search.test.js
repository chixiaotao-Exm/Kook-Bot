import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMenuSearch } from '../src/menu-search.js';

const catalogs = await Promise.all(['basic', 'extended'].map(async group => JSON.parse(await readFile(new URL(`../assets/catalog-${group}.json`, import.meta.url), 'utf8'))));
const items = catalogs.flatMap(catalog => catalog.items);
const search = createMenuSearch(items);
const allPages = query => {
  const first = search(`搜索${query}`);
  return Array.from({ length: first.pageCount }, (_, index) => search(`搜索${query} 第${index + 1}页`));
};

test('explicit Chinese ingredient searches and natural fish questions find source entries', () => {
  const expected = search('搜索鱼');
  assert.ok(expected.total > 8);
  for (const request of ['搜索 鱼', '搜一下鱼', '查找鱼', '有哪些鱼', '鱼有哪些', '有什么鱼', '鱼类菜品', '请帮我搜索鱼', '查一下鱼']) {
    const result = search(request);
    assert.equal(result.total, expected.total, request);
    assert.deepEqual(result.items, expected.items, request);
  }
  assert.ok(search('搜索 鸡肉').items.every(item => [item.name, ...item.aliases].some(name => name.includes('鸡肉'))));
  assert.match(expected.text, /按名称匹配/);
  assert.doesNotMatch(expected.text, /合计|小计|下单/);
});

test('all real fish matches survive pagination exactly once including squid-name matches', () => {
  const pages = allPages('鱼');
  const expected = items.filter(item => [item.name, ...item.aliases].some(name => name.includes('鱼')));
  expected.sort((left, right) => Number(left.name.includes('鱿鱼')) - Number(right.name.includes('鱿鱼')));
  const keys = pages.flatMap(page => page.items.map(item => item.key));
  assert.deepEqual(keys, expected.map(item => item.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(expected.some(item => item.name.includes('鱿鱼')));
  for (const [index, page] of pages.entries()) {
    assert.equal(page.page, index + 1);
    assert.equal(page.total, expected.length);
    assert.ok(page.items.length <= 8);
    assert.ok(page.text.length < 1900);
    for (const item of page.items) {
      assert.ok(page.text.includes(item.name));
      assert.ok(page.text.includes(item.spanish));
      assert.ok(page.text.includes(item.key));
    }
  }
});

test('Spanish matching ignores case and accents while aliases are searchable', () => {
  assert.deepEqual(search('搜索pescado').items, search('搜索 PÉSCADO').items);
  assert.ok(search('搜索PESCADO').total > 0);
  assert.ok(search('搜索COCTEL').items.some(item => /c[oó]ctel/iu.test(item.spanish)));
  assert.ok(search('搜索炸春卷').items.some(item => item.key === 'm1:1'));
});

test('duplicate dish names remain separate, with source IDs and original prices', () => {
  const result = search('搜索蚝油牛肉');
  const expected = items.filter(item => [item.name, ...item.aliases].some(name => name.includes('蚝油牛肉')));
  assert.ok(expected.length > 1);
  assert.deepEqual(result.items.map(item => item.key), expected.map(item => item.key));
  for (const item of expected) assert.ok(result.text.includes(`$${(item.priceCents / 100).toFixed(2)} USD`));
});

test('missing prices and source uncertainty are preserved instead of becoming zero or a quote', () => {
  const unpriced = items.find(item => item.priceCents === null);
  const unclear = items.find(item => item.uncertain);
  assert.ok(unpriced); assert.ok(unclear);
  const replies = [search(`搜索${unpriced.name}`).text, search(`搜索${unclear.name}`).text];
  assert.match(replies[0], /未标价/);
  assert.match(replies[1], /原文不确定，待核对/);
  for (const text of replies) assert.doesNotMatch(text, /\$0\.00|合计|小计/);
});

test('empty, missing, invalid and out-of-range searches get bounded deterministic help', () => {
  for (const input of ['搜索', '搜一下', '查找', '搜索 第2页']) assert.match(search(input).text, /发送「搜索鱼」/);
  assert.equal(search('搜索\u0301').total, 0);
  assert.match(search('搜索火星料理').text, /没有找到/);
  for (const page of ['0', '-1', '2.5', '两', '2001', '999999999999']) assert.match(search(`搜索鱼 第${page}页`).text, /页码需为/);
  const tooFar = search('搜索鱼 第2000页');
  assert.equal(tooFar.items.length, 0);
  assert.ok(tooFar.total > 0);
  assert.match(tooFar.text, /只有/);
  assert.match(search(`搜索${'鱼'.repeat(81)}`).text, /80/);
  assert.match(search('搜索鱼\n肉').text, /不要换行/);
});

test('search routing leaves exact orders, calculator, menu commands and ordinary chat unchanged', () => {
  for (const input of ['春卷2份', '我要两份鱼', '菜单', '菜单 2', '计算 12+2', '春卷多少钱', '两个人想吃鸡肉，推荐一下', '你好', '有什么事', '今天你有哪些安排', '第2页', '', null]) {
    assert.equal(search(input), null, String(input));
  }
});

test('long entries produce stable smaller pages without clipping any names or Spanish text', () => {
  const longItems = Array.from({ length: 20 }, (_, index) => ({
    key: `m1:${index + 1}`, group: '菜单一', code: `${index + 1}`, name: `鱼${'鲜'.repeat(115)}${index}`,
    spanish: `PESCADO ${'A'.repeat(385)}${index}`, aliases: [], priceCents: 100, uncertain: false,
  }));
  const customSearch = createMenuSearch(longItems);
  const first = customSearch('搜索鱼');
  assert.ok(first.items.length < 8);
  const seen = [];
  for (let page = 1; page <= first.pageCount; page++) {
    const result = customSearch(`搜索鱼 第${page}页`);
    assert.ok(result.text.length < 1900);
    for (const item of result.items) {
      assert.ok(result.text.includes(item.name));
      assert.ok(result.text.includes(item.spanish));
      seen.push(item.key);
    }
  }
  assert.deepEqual(seen, longItems.map(item => item.key));
});
