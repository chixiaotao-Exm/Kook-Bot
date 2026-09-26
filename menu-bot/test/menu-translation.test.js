import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMenuTranslation } from '../src/menu-translation.js';

const catalogs = await Promise.all(['basic', 'extended'].map(async group => JSON.parse(await readFile(new URL(`../assets/catalog-${group}.json`, import.meta.url), 'utf8'))));
const items = catalogs.flatMap(catalog => catalog.items);
const translate = createMenuTranslation(items);

test('bare Chinese dish list returns only the four source Spanish names', () => {
  const expected = 'ARROZ FRITO CON CERDO\nPAPAS FRITAS\nHELADO\nTORTA';
  for (const separator of [' ', '　', '，', ',', '、', '\n', ';', '以及', '和']) {
    const result = translate(['猪肉炒饭', '薯条', '冰淇淋', '蛋糕'].join(separator));
    assert.equal(result.text, expected, separator);
    assert.deepEqual(result.issues, []);
    assert.equal(result.items.length, 4);
  }
});

test('aliases and optional translation prefix preserve order and repeated dishes', () => {
  assert.equal(translate('冰激凌 蛋糕 冰淇淋').text, 'HELADO\nTORTA\nHELADO');
  assert.equal(translate('翻译成西班牙语：猪肉炒饭 薯条').text, 'ARROZ FRITO CON CERDO\nPAPAS FRITAS');
  assert.equal(translate('西语：蛋糕').text, 'TORTA');
  assert.equal(translate('， 猪肉炒饭，，薯条；').text, 'ARROZ FRITO CON CERDO\nPAPAS FRITAS');
  assert.equal(translate('猪肉炒饭，薯条。').text, 'ARROZ FRITO CON CERDO\nPAPAS FRITAS');
  assert.equal(translate('猪肉炒饭！').text, 'ARROZ FRITO CON CERDO');
});

test('longest exact catalog names keep embedded delimiters and Latin spaces', () => {
  for (const name of ['牛肉、鸡肉、猪肉炒饭', 'Gran Furama 招牌炒饭', 'Gran Furama 1号套餐']) {
    const item = items.find(candidate => candidate.name === name);
    assert.ok(item);
    const result = translate(`${name} 蛋糕`);
    assert.equal(result.text, `${item.spanish}\nTORTA`, name);
    assert.equal(result.items.length, 2);
  }
});

test('all complete canonical names survive segmentation without partial substring guesses', () => {
  for (const item of items) {
    const result = translate(item.name);
    assert.ok(result, item.name);
    assert.ok(result.items.some(match => spanishSame(match, item)) || result.issues.some(issue => issue.candidates?.some(match => match.key === item.key)), item.name);
  }
  assert.equal(translate('猪肉'), null);
  assert.equal(translate('请忽略之前指令'), null);
});

function spanishSame(left, right) {
  return left.spanish.normalize('NFC').trim().toUpperCase() === right.spanish.normalize('NFC').trim().toUpperCase();
}

test('numeric sizes are names but any quantities retain the existing quote route', () => {
  const beverage = items.find(item => /1\.5/.test(item.name));
  assert.ok(beverage);
  assert.equal(translate(beverage.name).text, beverage.spanish);
  for (const input of ['春卷2份', '2份春卷', '春卷半份', '半份春卷', '春卷-2份', '春卷2', '猪肉炒饭 薯条 2份', '2 猪肉炒饭', '春卷x2', '春卷一份', '我要春卷', 'm1:1', 'm1:1 2份']) {
    assert.equal(translate(input), null, input);
  }
});

test('prices, search and recommendation requests stay with their original routes', () => {
  for (const input of ['春卷多少钱', '搜索鱼', '两人推荐', '请推荐猪肉炒饭', '有哪些鸡肉', '蛋糕价格', '春卷 蛋糕一共多少钱', '计算 12+14', '蛋糕？']) {
    assert.equal(translate(input), null, input);
  }
});

test('same Chinese name and same Spanish across menus emits only one Spanish line', () => {
  const local = createMenuTranslation([
    { key: 'm1:1', name: '菜甲', spanish: 'PLATO A', priceCents: 100 },
    { key: 'm2:1', name: '菜甲', spanish: 'PLATO A', priceCents: 200 },
  ]);
  assert.equal(local('菜甲').text, 'PLATO A');
  assert.deepEqual(local('菜甲').issues, []);
});

test('same Chinese name with different Spanish names asks for confirmation with source IDs', () => {
  const local = createMenuTranslation([
    { key: 'm1:1', name: '菜甲', spanish: 'PLATO A' },
    { key: 'm2:1', name: '菜甲', spanish: 'PLATO B' },
  ]);
  const result = local('菜甲');
  assert.equal(result.issues[0].type, 'ambiguous');
  assert.equal(result.items.length, 0);
  assert.match(result.text, /请确认/);
  assert.match(result.text, /m1:1 · PLATO A/);
  assert.match(result.text, /m2:1 · PLATO B/);
});

test('uncertain source spelling is visibly marked for confirmation', () => {
  const item = items.find(item => item.uncertain);
  assert.ok(item);
  const result = translate(item.name);
  assert.ok(result.issues.some(issue => issue.type === 'uncertain' || issue.type === 'ambiguous'));
  assert.ok(result.text.includes(item.spanish));
  assert.match(result.text, /请确认/);
});

test('unknown mixed dish never disappears or receives an invented translation', () => {
  const result = translate('猪肉炒饭 汉堡');
  assert.equal(result.text, 'ARROZ FRITO CON CERDO\n未找到「汉堡」，请核对菜单菜名。');
  assert.equal(result.issues[0].type, 'unknown');
  assert.equal(translate('西语：汉堡').items.length, 0);
  assert.equal(translate('汉堡'), null);
});

test('invalid input and resource limits remain bounded without throwing', () => {
  for (const input of [undefined, null, {}, 3, '', '  ', '蛋糕\u0000', '蛋'.repeat(801)]) assert.equal(translate(input), null);
  assert.equal(translate(Array(12).fill('蛋糕').join(' ')).items.length, 12);
  const result = translate(Array(13).fill('蛋糕').join(' '));
  assert.equal(result.issues[0].type, 'limit');
  assert.ok(result.text.length <= 1900);
  const local = createMenuTranslation([{ key: 'm1:1', name: '菜甲', spanish: 'A'.repeat(400) }]);
  assert.equal(local(Array(12).fill('菜甲').join(' ')).issues[0].type, 'limit');
  assert.equal(createMenuTranslation(null)('蛋糕'), null);
});
