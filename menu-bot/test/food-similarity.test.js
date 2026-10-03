import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createFoodSimilarity, parseSimilarityRequest } from '../src/food-similarity.js';
import { loadCatalog } from '../src/waiter-service.js';

const items = await loadCatalog(fileURLToPath(new URL('../assets/', import.meta.url)));
const keyItem = key => items.find(item => item.key === key);
const comparison = (key = 'm1:54', patch = {}) => ({
  key, chineseDish: '糖醋鱼', similarity: 'high', similarities: ['菜名呈现酸甜口味方向'],
  differences: ['鱼种、裹粉和炸制做法尚不能确定'],
  evidence: [{ field: 'spanish', quote: keyItem(key)?.spanish ?? 'unknown' }], ...patch,
});
const response = (comparisons = [comparison()], alternatives = []) => ({ comparisons, alternatives, clarification: '' });
function setup(result = response(), extra = {}) {
  const calls = [];
  const client = { generate: async (...args) => { calls.push(args); return { text: JSON.stringify(result), incomplete: false }; } };
  return { service: createFoodSimilarity({ items, client, now: () => 12345, ...extra }), calls };
}

test('only explicit analysis cues route; bare translation, order, search and calculator remain unchanged', () => {
  const service = setup().service;
  for (const input of ['分析 m1:54', '帮我分析糖醋鱼', '相似度 糖醋鱼', '中国食物相似度分析：m1:3',
    '糖醋鱼像什么中国菜', '春卷像哪种中国菜', '有没有像宫保鸡丁的菜', '有哪些类似中国菜']) assert.equal(service.matches(input), true, input);
  for (const input of ['糖醋鱼', '糖醋鱼2份', 'm1:54', '搜索鱼', '搜索鱼 第2页', '有哪些鱼', '菜单', '1+2', '推荐两道菜', '', null]) assert.equal(service.matches(input), false, input);
  assert.deepEqual(parseSimilarityRequest('有没有像宫保鸡丁的菜？'), { kind: 'reference', query: '宫保鸡丁' });
  assert.deepEqual(parseSimilarityRequest('分析 ｍ１：５４'), { kind: 'menu', query: 'm1:54' });
});

test('analysis uses exact local facts and prices; model cannot become the menu source', async () => {
  const { service, calls } = setup();
  const thinking = [];
  const text = await service.reply('分析 m1:54', { onThinking: event => thinking.push(event) });
  assert.match(text, /m1:54 · 糖醋鱼\nDULCE Y AGRIO DE PESCADO\n原菜单未标价/);
  assert.match(text, /可能像：糖醋鱼｜相似度：高（AI 推测）/);
  assert.match(text, /相近点（推测）/);
  assert.match(text, /可能差异（推测）/);
  assert.match(text, /食材、过敏原及是否供应，需向餐厅确认/);
  assert.deepEqual(thinking, [{ kind: 'similarity' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][0][0].content), { kind: 'menu', query: 'm1:54', selectedKeys: ['m1:54'] });
  assert.deepEqual(service.status(), { enabled: true, model: 'gpt-6-astra', lastError: null, lastSuccessAt: 12345 });
  const priced = setup(response([comparison('m1:3', { chineseDish: '叉烧', similarities: ['同属猪肉类烤制菜名'], differences: ['腌料与上色方式不明'] })])).service;
  assert.match(await priced.reply('烤猪肉像什么中国菜'), /原菜单单价：\$12\.00 USD/);
});

test('same-name ambiguity and bad IDs are resolved locally, without generation or thinking notices', async () => {
  const { service, calls } = setup();
  let thinking = 0;
  const options = { onThinking: () => thinking++ };
  const duplicate = await service.reply('分析 广式虾仁', options);
  assert.match(duplicate, /有多个菜单项目/);
  assert.match(duplicate, /m1:65/); assert.match(duplicate, /m2:60/);
  for (const input of ['分析 m1:999', '分析 m1:0', '分析 m1:abc', '分析 ice:', '分析 m1:54 m1:999']) {
    assert.match(await service.reply(input, options), /未找到这个菜单编号/, input);
  }
  assert.match(await service.reply('分析 火星料理', options), /未找到/);
  assert.match(await service.reply('分析', options), /相似度分析：发送/);
  assert.match(await service.reply('有哪些类似中国菜', options), /相似度分析：发送/);
  assert.match(await service.reply('分析 ' + '菜'.repeat(800), options), /800 字以内/);
  assert.equal(calls.length, 0); assert.equal(thinking, 0);
});

test('uncertain menu sources remain unknown and never gain speculative food facts', async () => {
  const { service, calls } = setup();
  const text = await service.reply('分析 m1:7');
  assert.match(text, /原菜单信息待确认/);
  assert.match(text, /相似度：未知/);
  assert.doesNotMatch(text, /可能像|相近点/);
  assert.equal(calls.length, 0);
});

test('source IDs retain uppercase suffixes and mixed unresolved dish names are not dropped', async () => {
  const { service, calls } = setup(response([comparison('m2:1A', { chineseDish: '猪肠粉' })]));
  assert.match(await service.reply('分析 m2:1a'), /m2:1A/);
  assert.equal(JSON.parse(calls[0][0][0].content).selectedKeys[0], 'm2:1A');
  assert.match(await service.reply('分析 m1:54 和广式虾仁'), /避免遗漏菜品/);
  assert.equal(calls.length, 1);
});

test('external Chinese dish searches can suggest only existing menu items with source evidence', async () => {
  const alternate = { key: 'm1:3', reason: '烤制菜名可作另一种肉类选择', evidence: [{ field: 'spanish', quote: 'CERDO ASADO' }] };
  const { service, calls } = setup(response([comparison('m1:54', { chineseDish: '糖醋鲤鱼' })], [alternate]));
  const text = await service.reply('有没有像糖醋鲤鱼的菜');
  assert.match(text, /想找：糖醋鲤鱼/);
  assert.match(text, /m1:54 · 糖醋鱼/);
  assert.match(text, /菜单内相近选择（AI 推测）/);
  assert.match(text, /m1:3 · 烤猪肉｜CERDO ASADO/);
  assert.equal(JSON.parse(calls[0][0][0].content).kind, 'reference');
  for (const bad of ['fake:1', 'm1:999']) {
    assert.match(await setup(response([comparison(bad, { evidence: [] })])).service.reply('有没有像宫保鸡丁的菜'), /暂时不可用/);
  }
});

test('model cannot replace requested IDs, omit an item, duplicate a result, or invent alternatives', async () => {
  for (const result of [
    response([comparison('m1:3')]), response([]), response([comparison(), comparison()]),
    response([comparison()], [{ key: 'fake:1', reason: '相似', evidence: [] }]),
  ]) assert.match(await setup(result).service.reply('分析 m1:54'), /暂时不可用/);
  assert.match(await setup(response([comparison()])).service.reply('分析 m1:54 和 m1:3'), /暂时不可用/);
  const result = response([comparison(), comparison('m1:3', { chineseDish: '叉烧' })]);
  const { service, calls } = setup(result);
  assert.match(await service.reply('分析 m1:54 和 m1:3'), /m1:3 · 烤猪肉/);
  assert.match(await service.reply('分析 m1:54 m1:3 m1:1'), /每次最多分析 2 道菜/);
  assert.equal(calls.length, 1);
});

test('a model recommendation repeating an already compared dish is omitted without discarding the valid analysis', async () => {
  const result=response([comparison('m1:54',{chineseDish:'糖醋鲤鱼'})],[{key:'m1:54',reason:'重复推荐',evidence:[{field:'name',quote:'糖醋鱼'}]}]);
  const {service}=setup(result);
  const text=await service.reply('有没有像糖醋鲤鱼的菜');
  assert.match(text,/相似度：高/);assert.equal((text.match(/m1:54/g)||[]).length,1);
  assert.doesNotMatch(text,/暂时不可用|重复推荐/);assert.equal(service.status().lastError,null);
});

test('each evidence quote must be an exact substring from its own catalog item field', async () => {
  for (const evidence of [
    [{ field: 'spanish', quote: 'CERDO ASADO' }],
    [{ field: 'name', quote: '糖醋鲤鱼' }],
    [{ field: 'priceCents', quote: '1200' }],
    [{ field: 'note', quote: '厨师说一定不含花生' }],
    [{ field: 'name', quote: '' }],
    '糖醋鱼',
  ]) assert.match(await setup(response([comparison('m1:54', { evidence })])).service.reply('分析 m1:54'), /暂时不可用/);
});

test('absent evidence and explicit unknown suppress unsupported inferences and alternative rankings', async () => {
  for (const patch of [{ evidence: [] }, { similarity: 'unknown' }, { chineseDish: '' }]) {
    const result = response([comparison('m1:54', patch)], [{ key: 'm1:3', reason: '凭空推荐', evidence: [{ field: 'name', quote: '烤猪肉' }] }]);
    const text = await setup(result).service.reply('分析 m1:54');
    assert.match(text, /相似度：未知/);
    assert.doesNotMatch(text, /可能像|相近点|凭空推荐|m1:3/);
  }
});

test('unverified alternatives without evidence or from uncertain sources are suppressed', async () => {
  const text = await setup(response([comparison()], [
    { key: 'm1:3', reason: '未经依据推荐', evidence: [] },
    { key: 'm1:7', reason: '不明菜名', evidence: [{ field: 'name', quote: keyItem('m1:7').name }] },
  ])).service.reply('分析 m1:54');
  assert.doesNotMatch(text, /菜单内相近选择|未经依据推荐|m1:7/);
});

test('AI prices, percentages, allergy guarantees and untrusted links never reach the result', async () => {
  for (const unsafe of ['$1.00', '售价仅为十美元', '五块钱', '相似度95%', '不含花生', '没有任何过敏原', '绝对安全',
    '放心吃', '适合花生过敏者', '另选 m1:999 宫保鸡丁', '本店使用蜂蜜', 'https://untrusted.example', '(met)all(met)']) {
    const result = response([comparison('m1:54', { similarities: [unsafe] })]);
    const text = await setup(result).service.reply('分析 m1:54');
    assert.match(text, /暂时不可用/, unsafe); assert.ok(!text.includes(unsafe), unsafe);
  }
  const result = response([comparison()], [{ key: 'm1:3', reason: '只要9美元', evidence: [{ field: 'name', quote: '烤猪肉' }] }]);
  assert.match(await setup(result).service.reply('分析 m1:54'), /暂时不可用/);
});

test('malformed, partial, excessive and empty model output fails without displaying free-form text', async () => {
  for (const raw of [null, [], {}, { comparisons: [], alternatives: null }, response([comparison('m1:54', { similarity: '100%' })]),
    response([comparison('m1:54', { differences: ['长'.repeat(81)] })]), response([comparison(), comparison(), comparison()])]) {
    assert.match(await setup(raw).service.reply('分析 m1:54'), /暂时不可用/);
  }
  for (const result of [{ text: 'not-json-private', incomplete: false }, { text: '{}', incomplete: true }, { text: 'x'.repeat(12001) }]) {
    const service = setup(null, { client: { generate: async () => result } }).service;
    const text = await service.reply('分析 m1:54');
    assert.match(text, /暂时不可用/); assert.doesNotMatch(text, /not-json-private/);
  }
  const empty = await setup(response([])).service.reply('有没有像宫保鸡丁的菜');
  assert.match(empty, /暂无足够菜单依据/);
});

test('AI failures sanitize errors; recovery updates health and no key preserves deterministic responses', async () => {
  let fail = true;
  const service = createFoodSimilarity({ items, now: () => 234, client: { generate: async () => {
    if (fail) throw Error('private-secret');
    return { text: JSON.stringify(response()) };
  } } });
  const failed = await service.reply('分析 m1:54');
  assert.match(failed, /暂时不可用/); assert.doesNotMatch(failed, /private-secret/);
  assert.equal(service.status().lastError, 'ai_unavailable');
  fail = false;
  await service.reply('分析 m1:54');
  assert.equal(service.status().lastError, null); assert.equal(service.status().lastSuccessAt, 234);
  const offline = createFoodSimilarity({ items });
  assert.equal(offline.status().enabled, false);
  assert.match(await offline.reply('分析 m1:54'), /暂未启用/);
  assert.match(await offline.reply('分析 广式虾仁'), /多个菜单项目/);
  assert.equal(await offline.reply('糖醋鱼'), null);
});

test('cancelled requests never return a model answer or expose an abort reason', async () => {
  const controller = new AbortController(); controller.abort(Error('private-abort'));
  const { service, calls } = setup();
  await assert.rejects(service.reply('分析 m1:54', { signal: controller.signal }), error => error.name === 'AbortError' && !error.message.includes('private'));
  assert.equal(calls.length, 0);
  const during = new AbortController();
  const active = setup(null, { client: { generate: async (_messages, options) => {
    assert.equal(options.signal, during.signal); during.abort(Error('secret'));
    return { text: JSON.stringify(response()) };
  } } }).service;
  await assert.rejects(active.reply('分析 m1:54', { signal: during.signal }), /已取消/);
  assert.equal(active.status().lastSuccessAt, null);
});

test('bounded output preserves full qualifications and suppresses message markup', async () => {
  const result = response([comparison('m1:54', { chineseDish: '*糖醋鱼*', similarities: ['甲'.repeat(80), '乙'.repeat(80)], differences: ['丙'.repeat(80), '丁'.repeat(80)] }),
    comparison('m1:3', { similarities: ['甲'.repeat(80), '乙'.repeat(80)], differences: ['丙'.repeat(80), '丁'.repeat(80)] })], [
    { key: 'm1:1', reason: '甲'.repeat(80), evidence: [{ field: 'name', quote: '春卷' }] },
    { key: 'm1:2', reason: '乙'.repeat(80), evidence: [{ field: 'name', quote: '烤排骨' }] },
  ]);
  const text = await setup(result).service.reply('分析 m1:54 m1:3');
  assert.ok(text.length <= 1900); assert.match(text, /需向餐厅确认/); assert.doesNotMatch(text, /\*糖醋鱼\*/);
});

test('real client uses isolated bounded prompt with public catalog, pinned model and no stored history', async () => {
  let sent;
  const ai = { baseUrl: 'https://ai.example', apiKey: 'private-test-key', model: 'unwanted-model',
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: 'completed', model: 'gpt-6-astra', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(response()) }] },
      ] }), { headers: { 'content-type': 'application/json' } });
    } };
  const service = createFoodSimilarity({ items: items.map(item => ({ ...item, privateToken: 'never-include-this' })), ai });
  assert.match(await service.reply('分析 m1:54'), /糖醋鱼/);
  assert.equal(sent.model, 'gpt-6-astra'); assert.equal(sent.store, false);
  assert.equal(sent.max_output_tokens, 4096); assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.equal(sent.input.length, 1); assert.ok(sent.instructions.length < 64000);
  assert.doesNotMatch(sent.instructions, /private-test-key|never-include-this|priceCents/);
  assert.match(sent.instructions, /DULCE Y AGRIO DE PESCADO/);
});
