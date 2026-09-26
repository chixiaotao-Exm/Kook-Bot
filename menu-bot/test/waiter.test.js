import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWaiter } from '../src/waiter.js';

const catalog = [
  { key: 'm1:1', group: '菜单一', code: '1', name: '春卷', spanish: 'LUMPIA', priceCents: 400, aliases: ['炸春卷'] },
  { key: 'm1:2', group: '菜单一', code: '2', name: '糖醋鸡', spanish: 'POLLO AGRIDULCE', priceCents: 1250, aliases: [] },
  { key: 'm1:3', group: '菜单一', code: '3', name: '炒饭', spanish: 'ARROZ FRITO', priceCents: 800, aliases: [] },
  { key: 'm2:3', group: '菜单二', code: '3', name: '炒饭', spanish: 'ARROZ FRITO', priceCents: 1300, aliases: [] },
  { key: 'm2:14A', group: '菜单二', code: '14A', name: '蒙古汤(小份)', spanish: 'SOPA MANGOLESA A', priceCents: null, aliases: ['小份蒙古汤'] },
  { key: 'm2:17', group: '菜单二', code: '17', name: '豆腐汤(原文不完整)', spanish: 'SOPA DE CUAJADA DE SOYA CONI', priceCents: 1000, aliases: ['豆腐汤'], uncertain: true },
  { key: 'drink:1', group: '饮品', code: '1', name: '矿泉水', spanish: 'AGUA MINERAL', priceCents: 100, aliases: ['水'] },
  { key: 'drink:2', group: '饮品', code: '2', name: '汽水1.5L', spanish: 'REFRESCO 1.5 L', priceCents: 300, aliases: [] },
  { key: 'drink:3', group: '饮品', code: '3', name: '汽水2L', spanish: 'REFRESCO 2 L', priceCents: null, aliases: [] },
  { key: 'combo:1', group: '套餐', code: '1', name: 'Gran Furama 1号套餐', spanish: 'COMBO 1', priceCents: 1200, aliases: ['1号套餐'] },
];
const waiter = createWaiter(catalog);

test('known Chinese dishes produce a bilingual USD quote from catalog prices', () => {
  const quote = waiter.quote('春卷2份，糖醋鸡1份');
  assert.equal(quote.complete, true);
  assert.equal(quote.totalCents, 2050);
  assert.equal(quote.currency, 'USD');
  assert.match(quote.text, /LUMPIA/);
  assert.match(quote.text, /POLLO AGRIDULCE/);
  assert.match(quote.text, /\$4\.00 × 2 = \$8\.00/);
  assert.match(quote.text, /合计：\$20\.50/);
});

test('Chinese and Arabic counts work before or after names, including measures', () => {
  for (const [input, expected] of [
    ['我要两份春卷', 2], ['二份春卷', 2], ['春卷两份', 2], ['来三份春卷', 3],
    ['请给我十二份春卷，谢谢', 12], ['春卷九十九份', 99], ['春卷十份', 10],
    ['春卷２份', 2], ['2春卷', 2], ['春卷×2', 2], ['春卷 x 2', 2],
    ['矿泉水2瓶', 2], ['矿泉水2杯', 2], ['春卷', 1], ['炸春卷', 1],
  ]) {
    const result = waiter.quote(input);
    assert.equal(result?.complete, true, input);
    assert.equal(result.items[0].quantity, expected, input);
  }
});

test('dish numbers and beverage sizes are not quantities', () => {
  for (const [input, key, count] of [
    ['汽水1.5L', 'drink:2', 1], ['汽水1.5L2瓶', 'drink:2', 2],
    ['2瓶汽水1.5L', 'drink:2', 2], ['1号套餐', 'combo:1', 1],
    ['1号套餐2套', 'combo:1', 2], ['m1:1', 'm1:1', 1],
    ['m1:1 2份', 'm1:1', 2], ['菜单一1号2份', 'm1:1', 2],
    ['菜单一春卷', 'm1:1', 1], ['套餐1', 'combo:1', 1],
  ]) {
    const result = waiter.quote(input);
    assert.equal(result?.complete, true, input);
    assert.equal(result.items[0].key, key, input);
    assert.equal(result.items[0].quantity, count, input);
  }
});

test('multiple separators and fullwidth punctuation are accepted', () => {
  for (const separator of [',', '，', '、', ';', '；', '\n', '+', '＋', '和', '以及', '还有']) {
    const result = waiter.quote(`春卷2份${separator}矿泉水2瓶`);
    assert.equal(result.complete, true, separator);
    assert.equal(result.totalCents, 1000, separator);
  }
});

test('conjunctions and punctuation preserve known and unknown order lines', () => {
  const result = waiter.quote('春卷2份和矿泉水2瓶，蛋糕1份');
  assert.equal(result.complete, false);
  assert.equal(result.totalCents, 1000);
  assert.deepEqual(result.items.map(item => [item.key, item.quantity]), [['m1:1', 2], ['drink:1', 2]]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /蛋糕1份/);
});

test('ordinary price questions are priced locally with no AI interpretation', () => {
  for (const text of ['春卷多少钱', '春卷价格', '春卷怎么卖', '春卷什么价格', '请问春卷多少钱？', '春卷价钱是多少', '春卷多少钱一份']) {
    const result = waiter.quote(text);
    assert.equal(result?.complete, true, text);
    assert.equal(result.totalCents, 400, text);
  }
  assert.equal(waiter.quote('春卷2份多少钱').totalCents, 800);
  assert.equal(waiter.quote('炒饭价格').issues[0].type, 'ambiguous');
  assert.equal(waiter.quote('推荐一下春卷多少钱'), null);
});

test('overlapping names across menus always require explicit choice', () => {
  const quote = waiter.quote('炒饭2份，矿泉水2瓶');
  assert.equal(quote.complete, false);
  assert.equal(quote.totalCents, 200);
  assert.equal(quote.items.length, 1);
  assert.equal(quote.issues[0].type, 'ambiguous');
  assert.deepEqual(quote.issues[0].candidates.map(item => item.key), ['m1:3', 'm2:3']);
  assert.match(quote.text, /m1:3/);
  assert.match(quote.text, /m2:3/);
  assert.match(quote.text, /已知小计：\$2\.00/);
});

test('menu-qualified names and codes resolve duplicate dishes', () => {
  for (const name of ['菜单二炒饭2份', '菜单二3号2份', 'm2:3 2份']) {
    const quote = waiter.quote(name);
    assert.equal(quote.complete, true);
    assert.equal(quote.totalCents, 2600);
  }
});

test('unpriced and uncertain original entries are excluded instead of treated as free', () => {
  const quote = waiter.quote('m2:14A，豆腐汤，春卷2份');
  assert.equal(quote.complete, false);
  assert.equal(quote.totalCents, 800);
  assert.equal(quote.items[0].lineCents, null);
  assert.equal(quote.items[1].lineCents, null);
  assert.deepEqual(quote.issues.map(issue => issue.type), ['unpriced', 'uncertain']);
  assert.match(quote.text, /未标价/);
  assert.match(quote.text, /信息待确认/);
  assert.match(quote.text, /已知小计：\$8\.00/);
});

test('unknown dishes alongside known ones cannot disappear from the receipt', () => {
  const quote = waiter.quote('春卷2份，佛跳墙1份');
  assert.equal(quote.complete, false);
  assert.equal(quote.totalCents, 800);
  assert.equal(quote.issues[0].type, 'unknown');
  assert.match(quote.text, /佛跳墙/);
  assert.match(quote.text, /待确认项目未计入/);
  assert.equal(waiter.quote('我要佛跳墙').issues[0].type, 'unknown');
});

test('non-order conversation is left for the AI instead of inventing matches', () => {
  for (const input of ['', undefined, null, '你好', '今天吃什么', '菜单', '春卷好吃吗', '炒饭和春卷怎么选', '两个人想吃鸡肉炒饭，推荐一下', '我要点菜，推荐一下', '春卷，糖醋鸡哪个好']) {
    assert.equal(waiter.quote(input), null, String(input));
  }
});

test('invalid menu keys produce an explicit unknown result', () => {
  assert.equal(waiter.quote('m1:999').issues[0].type, 'unknown');
  assert.equal(waiter.quote('菜单二999号').issues[0].type, 'unknown');
});

test('fractions, decimals, zero, negative and excessive quantities do not turn into positive orders', () => {
  for (const input of ['春卷0份', '春卷-2份', '-2份春卷', '春卷1.5份', '1.5份春卷', '春卷1/2份', '春卷半份', '半份春卷', '春卷100份', '春卷一百份', '春卷999999999999份']) {
    const result = waiter.quote(input);
    assert.equal(result?.complete, false, input);
    assert.equal(result.totalCents, 0, input);
    assert.equal(result.items.length, 0, input);
    assert.equal(result.issues[0].type, 'quantity', input);
  }
});

test('safe bounds prevent oversized requests and oversized receipts', () => {
  assert.equal(waiter.quote('春卷'.repeat(1000)).issues[0].type, 'limit');
  assert.equal(waiter.quote(Array(13).fill('春卷').join('，')).issues[0].type, 'limit');
  const long = createWaiter([{ ...catalog[0], spanish: 'L'.repeat(400) }]);
  const quote = long.quote(Array(6).fill('春卷').join('，'));
  assert.equal(quote.issues[0].type, 'limit');
  assert.ok(quote.text.length <= 1900);
  assert.equal(quote.totalCents, 0);
});

test('AI proposals are independently validated and model money is ignored', () => {
  const quote = waiter.quoteItems([{ key: 'm1:1', quantity: 2, priceCents: 1, total: 2 }]);
  assert.equal(quote.complete, true);
  assert.equal(quote.totalCents, 800);
  assert.equal(quote.items[0].priceCents, 400);
  assert.equal(waiter.quoteItems([{ key: 'fake:key', quantity: 1 }]).issues[0].type, 'unknown');
});

test('AI proposals reject string quantities and non-finite or non-integer numbers', () => {
  for (const number of ['2', '两', null, undefined, NaN, Infinity, -1, 0, 0.5, 100]) {
    const result = waiter.quoteItems([{ key: 'm1:1', quantity: number }]);
    assert.equal(result.complete, false, String(number));
    assert.equal(result.totalCents, 0, String(number));
    assert.equal(result.issues[0].type, 'quantity', String(number));
  }
  for (const input of [undefined, null, {}, [], Array(13).fill({ key: 'm1:1', quantity: 1 })]) {
    assert.equal(waiter.quoteItems(input).issues[0].type, 'limit');
  }
});

test('invalid AI records fail closed and do not throw', () => {
  for (const input of [[null], [undefined], ['m1:1'], [{}]]) {
    const quote = waiter.quoteItems(input);
    assert.equal(quote.complete, false);
    assert.equal(quote.totalCents, 0);
    assert.equal(quote.issues[0].type, 'unknown');
  }
});

test('all calculations use integer cents without decimal rounding drift', () => {
  const decimal = createWaiter([{ ...catalog[0], priceCents: 10 }, { ...catalog[1], priceCents: 20 }]);
  const result = decimal.quote('春卷3份，糖醋鸡3份');
  assert.equal(result.totalCents, 90);
  assert.match(result.text, /合计：\$0\.90/);
});

test('quote state never carries between users or later messages', () => {
  assert.equal(waiter.quote('春卷2份').totalCents, 800);
  assert.equal(waiter.quote('矿泉水1瓶').totalCents, 100);
});

test('catalog and AI summary copies cannot mutate engine prices or aliases', () => {
  const original = structuredClone(catalog);
  const local = createWaiter(original);
  original[0].priceCents = 1;
  original[0].aliases.push('随便');
  const summary = local.summaryForAI();
  summary[0].priceCents = 2;
  summary[0].aliases.push('其他');
  assert.equal(local.quote('春卷').totalCents, 400);
  assert.equal(local.quote('随便'), null);
  assert.equal(local.quote('其他'), null);
  const receipt = local.quote('春卷');
  receipt.items[0].aliases.push('又一个');
  assert.equal(local.quote('又一个'), null);
});

test('invalid catalog entries stop startup instead of silently issuing wrong totals', () => {
  for (const override of [
    { key: '' }, { key: 'evil:1' }, { group: '菜单三' }, { code: '' },
    { name: '' }, { spanish: '' }, { priceCents: undefined }, { priceCents: -1 },
    { priceCents: 1.5 }, { priceCents: Number.MAX_VALUE }, { aliases: [2] },
  ]) assert.throws(() => createWaiter([{ ...catalog[0], ...override }]), /Invalid waiter catalog/);
  assert.throws(() => createWaiter([catalog[0], catalog[0]]), /Invalid waiter catalog/);
});

test('all 272 production catalog entries construct and resolve by exact key', () => {
  const basic = JSON.parse(readFileSync(new URL('../assets/catalog-basic.json', import.meta.url), 'utf8'));
  const extended = JSON.parse(readFileSync(new URL('../assets/catalog-extended.json', import.meta.url), 'utf8'));
  const all = [...basic.items, ...extended.items];
  assert.equal(all.length, 272);
  const production = createWaiter(all);
  for (const item of all) {
    const quote = production.quote(item.key);
    assert.ok(quote, item.key);
    assert.equal(quote.items.length, 1, item.key);
    assert.equal(quote.items[0].key, item.key);
    assert.equal(quote.items[0].spanish, item.spanish, item.key);
    assert.equal(quote.totalCents, item.priceCents !== null && !item.uncertain ? item.priceCents : 0, item.key);
  }
  for (const item of all.filter(entry => ['RICE', 'KIDS'].includes(entry.code))) {
    assert.equal(production.quote(`${item.group}${item.code}`).items[0].key, item.key);
  }
});

test('punctuation inside all 13 real menu names stays part of the dish and preserves correct pricing', () => {
  const all = ['basic', 'extended'].flatMap(name => JSON.parse(readFileSync(new URL(`../assets/catalog-${name}.json`, import.meta.url), 'utf8')).items);
  const production = createWaiter(all);
  const punctuated = all.filter(item => /[、，,;；+＋]|以及/.test(item.name));
  assert.equal(punctuated.length, 13);
  for (const item of punctuated) {
    const quote = production.quote(`${item.name}2份`);
    assert.ok(quote, item.key);
    assert.equal(quote.items.length, 1, item.key);
    assert.equal(quote.items[0].key, item.key);
    assert.equal(quote.items[0].quantity, 2, item.key);
    assert.equal(quote.totalCents, item.priceCents !== null && !item.uncertain ? item.priceCents * 2 : 0, item.key);
    assert.ok(quote.issues.every(issue => ['unpriced', 'uncertain'].includes(issue.type)), item.key);
  }
  const friedRice = production.quote('牛肉、鸡肉、猪肉炒饭2份');
  assert.equal(friedRice.complete, true);
  assert.equal(friedRice.totalCents, 2600);
  assert.equal(friedRice.items[0].key, 'm2:41');
  const mixed = production.quote('牛肉、鸡肉、猪肉炒饭2份以及春卷2份和矿泉水2瓶，蛋糕1份');
  assert.equal(mixed.complete, true);
  assert.equal(mixed.totalCents, 3900);
  assert.deepEqual(mixed.items.map(item => item.key), ['m2:41', 'm1:1', 'drink:1', 'm1:88']);
  const unresolved = production.quote('牛肉、鸡肉、猪肉炒饭2份和佛跳墙1份');
  assert.equal(unresolved.complete, false);
  assert.equal(unresolved.totalCents, 2600);
  assert.equal(unresolved.issues.length, 1);
  assert.equal(unresolved.issues[0].type, 'unknown');
});
