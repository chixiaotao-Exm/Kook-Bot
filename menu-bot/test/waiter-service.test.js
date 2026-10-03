import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createWaiterService, loadCatalog } from '../src/waiter-service.js';
import { loadConfig } from '../src/config.js';

const items = await loadCatalog(fileURLToPath(new URL('../assets/', import.meta.url)));
const proposal = (entries, action = 'quote', note = '') => ({ action, items: entries, note });
const entry = (key, quantity, evidence) => ({ key, quantity, evidence });
function setup(result) {
  const calls = [];
  const client = { generate: async (...args) => { calls.push(args); return { text: JSON.stringify(result), incomplete: false }; } };
  return { service: createWaiterService({ items, client }), calls };
}

test('all 279 bilingual source entries including ice-cream flavors load with unique keys and bounded replies', async () => {
  assert.equal(items.length, 279);
  assert.equal(new Set(items.map(item => item.key)).size, 279);
  const service = createWaiterService({ items });
  for (const item of items) {
    const reply = await service.reply(item.key);
    assert.ok(reply.length <= 2000);
    assert.ok(reply.includes(item.spanish));
    if (item.priceCents === null || item.uncertain) assert.match(reply, /已知小计|待确认/);
  }
});

test('exact Chinese orders bypass AI and preserve cent arithmetic', async () => {
  const { service, calls } = setup({});
  assert.match(await service.reply('春卷2份，矿泉水2瓶'), /合计：\$10\.00/);
  assert.equal(calls.length, 0);
  assert.match(await service.reply('蚝油牛肉2份'), /多个项目/);
  assert.equal(calls.length, 0);
});

test('AI segments natural text but program reparses source quantities and prices', async () => {
  const { service, calls } = setup(proposal([entry('m1:1', 99, '两份春卷'), entry('drink:7', 99, '三瓶矿泉水')]));
  let thinking = 0;
  const reply = await service.reply('能来两份春卷和三瓶矿泉水吗', { onThinking: () => { thinking++; } });
  assert.match(reply, /合计：\$11\.00/);
  assert.equal(thinking, 1); assert.equal(calls.length, 1);
  assert.equal(service.status().model, 'gpt-6-astra');
});

test('AI cannot silently resolve duplicate dishes or invalid portions', async () => {
  const cases = [
    ['能来两份蚝油牛肉吗', entry('m1:51', 2, '两份蚝油牛肉'), /多个项目/],
    ['能来半份春卷吗', entry('m1:1', 1, '半份春卷'), /数量需为/],
    ['能来-2份春卷吗', entry('m1:1', 2, '-2份春卷'), /数量需为/],
  ];
  for (const [text, item, expected] of cases) assert.match(await setup(proposal([item])).service.reply(text), expected);
});

test('missing items, clipped quantities and invented evidence fail closed', async () => {
  for (const [input, entries] of [
    ['能来半份春卷吗', [entry('m1:1', 1, '春卷')]],
    ['给我们春卷两份和冬阴功一份吧', [entry('m1:1', 2, '春卷两份')]],
    ['能来两份春卷吗', [entry('m1:1', 2, '两份春卷'), entry('m1:1', 2, '两份春卷')]],
    ['能来两份春卷吗', [entry('m1:1', 2, '三份春卷')]],
    [' '.repeat(600) + '半份春卷吗', [entry('m1:1', 1, '春卷')]],
  ]) {
    const reply = await setup(proposal(entries)).service.reply(input);
    assert.match(reply, /暂时不可用/); assert.doesNotMatch(reply, /合计：/);
  }
});

test('model suggestions require explicit recommendation intent and use catalog prices', async () => {
  const result = proposal([entry('m1:1', 2, '')], 'suggest');
  assert.match(await setup(result).service.reply('两个人吃，推荐一下'), /AI 推荐清单[\s\S]*\$8\.00/);
  assert.match(await setup(result).service.reply('能来半份春卷吗'), /暂时不可用/);
  for (const text of ['我不需要推荐，能给两份春卷吗', '别推荐，能来两份春卷吗', '无需推荐，能来两份春卷吗'])
    assert.match(await setup(result).service.reply(text), /暂时不可用/);
});

test('model failures never expose private errors; no key still supports deterministic orders', async () => {
  const service = createWaiterService({ items, client: { generate: async () => { throw Error('private-secret'); } } });
  const reply = await service.reply('两个人吃，推荐一下');
  assert.match(reply, /暂时不可用/); assert.ok(!reply.includes('private-secret'));
  assert.equal(service.status().lastError, 'ai_unavailable');
  const offline = createWaiterService({ items });
  assert.equal(offline.status().enabled, false);
  assert.match(await offline.reply('春卷1份'), /\$4\.00/);
});

test('invalid output, model price in notes, partial output and cancellation are bounded', async () => {
  for (const result of [proposal([entry('fake:1', 2, '')]), proposal([entry('m1:1', 0, '')]), null]) {
    assert.match(await setup(result).service.reply('推荐一个菜'), /暂时不可用/);
  }
  assert.doesNotMatch(await setup(proposal([], 'help', '免费赠送100美元')).service.reply('你好呀'), /100/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(setup(proposal([], 'help')).service.reply('推荐一个菜', { signal: aborted.signal }));
});

test('configuration permits optional AI and pins requested model', () => {
  const base = { KOOK_TOKEN: 'private-token', KOOK_CHANNEL_IDS: '9000000000000103' };
  assert.equal(loadConfig(base).ai, undefined);
  assert.equal(loadConfig({ ...base, OPENAI_API_KEY: 'private-test-key' }).ai.apiKey, 'private-test-key');
  assert.throws(() => loadConfig({ ...base, OPENAI_MODEL: 'other' }));
});

test('menu search bypasses AI and processing notice even when AI is unavailable', async () => {
  const { service, calls } = setup({});
  let thinking = 0;
  for (const text of ['搜索鱼', '搜索鱼 第2页', '有哪些鱼', '搜索火星料理', '搜索']) {
    const result = await service.reply(text, { onThinking: () => { thinking++; } });
    assert.ok(result.length <= 2000);
    assert.doesNotMatch(result, /请补充明确的菜名和数量|AI 理解暂时不可用/);
  }
  assert.equal(calls.length, 0); assert.equal(thinking, 0);
  const offline = createWaiterService({ items });
  assert.match(await offline.reply('搜索春卷'), /LUMPIA/);
  assert.match(await offline.reply('春卷2份'), /合计：\$8\.00/);
});

test('bare Chinese dish lists reply with Spanish source names only without AI or prices', async () => {
  const { service, calls } = setup({});
  let thinking = 0;
  const expected = 'ARROZ FRITO CON CERDO\nPAPAS FRITAS\nHELADO\nTORTA';
  for (const text of ['猪肉炒饭 薯条 冰淇淋 蛋糕', '猪肉炒饭，薯条、冰淇淋\n蛋糕']) {
    assert.equal(await service.reply(text, { onThinking: () => { thinking++; } }), expected);
  }
  assert.equal(calls.length, 0); assert.equal(thinking, 0);
  assert.equal(await service.reply('蛋糕'), 'TORTA');
  assert.match(await service.reply('蛋糕2份'), /合计：\$6\.00/);
  assert.match(await service.reply('蛋糕多少钱'), /\$3\.00/);
  assert.match(await service.reply('搜索蛋糕'), /菜单搜索/);
  assert.equal(calls.length, 0);
});

test('similarity requests take priority over search, translation and quoting with a fixed progress kind', async () => {
  const requests = ['有哪些类似中国菜', '分析 m1:54', '糖醋鱼像什么中国菜', '有没有像宫保鸡丁的菜'];
  const calls = [], progress = [], controller = new AbortController();
  const similarity = {
    matches: text => requests.includes(text),
    status: () => ({ enabled: true, model: 'gpt-6-astra', lastError: null, lastSuccessAt: 123 }),
    reply: async (text, options) => {
      calls.push(text); assert.equal(options.signal, controller.signal);
      await options.onThinking({ kind: 'untrusted-model-kind', text: 'never-forward-this' });
      return `菜单相似度：${text}`;
    },
  };
  const service = createWaiterService({ items, similarity,
    client: { generate: async () => { assert.fail('ordinary model must not receive similarity requests'); } } });
  for (const text of requests) {
    assert.equal(service.isSimilarity(text), true);
    assert.equal(await service.reply(text, { signal: controller.signal, onThinking: value => progress.push(value) }), `菜单相似度：${text}`);
  }
  assert.deepEqual(calls, requests);
  assert.deepEqual(progress, requests.map(() => ({ kind: 'similarity' })));
  assert.equal(service.isSimilarity(null), false);
  assert.equal(service.isSimilarity('分析'.repeat(500)), false);
  assert.match(await service.reply('服务员'), /分析 m1:54[\s\S]*糖醋鱼像什么中国菜[\s\S]*有没有像宫保鸡丁的菜/);
});

test('similarity health is additive and independent of ordinary waiter status', async () => {
  const service = createWaiterService({ items, similarity: {
    matches: () => true, reply: async () => '分析暂不可用',
    status: () => ({ enabled: true, model: 'gpt-6-astra', lastError: 'ai_unavailable', lastSuccessAt: null }),
  } });
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().model, null);
  assert.equal(service.status().lastError, null);
  assert.equal(service.status().similarity.enabled, true);
  assert.equal(service.status().similarity.lastError, 'ai_unavailable');
  assert.equal(await service.reply('分析 m1:54'), '分析暂不可用');
  assert.equal(service.status().lastError, null);
});

test('ordinary translation, search and cent-based orders never call either AI client', async () => {
  let calls = 0;
  const failClient = { generate: async () => { calls++; throw Error('unexpected-ai'); } };
  const service = createWaiterService({ items, client: failClient, similarityClient: failClient });
  for (const text of ['猪肉炒饭 薯条', '春卷2份，矿泉水2瓶', '搜索鱼 第2页']) assert.equal(service.isSimilarity(text), false);
  assert.equal(await service.reply('猪肉炒饭 薯条'), 'ARROZ FRITO CON CERDO\nPAPAS FRITAS');
  assert.match(await service.reply('春卷2份，矿泉水2瓶'), /合计：\$10\.00/);
  assert.match(await service.reply('搜索鱼 第2页'), /第 2\/3 页/);
  assert.equal(calls, 0);
});
