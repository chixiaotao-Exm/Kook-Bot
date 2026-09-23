import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBroadcastCards, validateBroadcastCards } from '../src/broadcast-cards.js';
import { quotaBattery } from '../src/quota-battery.js';

const checkedAt = '2026-09-21T01:20:00Z';
const metric = (overrides = {}) => ({ key: 'codex-primary', label: '5 小时额度窗口', windowMinutes: 300, kind: 'percent', scope: 'upstream', usedPercent: 38, resetAt: '2026-09-21T02:00:00Z', freshness: 'fresh', ...overrides });
const account = (overrides = {}) => ({
  id: '1', name: 'OpenAI_5X', platform: 'openai', planLabel: 'Pro 5x', schedulable: true, status: 'active',
  metrics: [metric(), metric({ key: 'codex-secondary', label: '7 天额度窗口', windowMinutes: 10080, usedPercent: 13, resetAt: '2026-09-27T02:00:00Z' })],
  windowStats: ['5h', '7d'].map(key => ({ key, periodKind: 'quota', complete: true, requests: 417, tokens: 18800000, userCost: 57.15, accountCost: 999.99, estimatedTotalCost: 696.28, currency: 'USD', freshness: 'fresh' })),
  ...overrides,
});
const snapshot = accounts => ({ checkedAt, accounts });
const options = { dashboardUrl: 'https://quota.example/quota/?admin=private#secret' };
const displayText = text => text.replace(/\(font\)([^()]*)\(font\)\[(success|warning|danger|info|purple|secondary|tips)\]/g, '$1');
const content = cards => displayText(cards.flatMap(card => card.modules).flatMap(module => module.text?.content || module.text?.fields?.map(field => field.content) || module.elements?.map(element => element.content || element.text?.content) || []).filter(Boolean).join('\n'));

test('battery warning thresholds follow remaining charge, not rounded cells', () => {
  for (const [remaining, filled, level, icon] of [[100, 10, 'normal', '🔋'], [62, 6, 'normal', '🔋'],
    [50.1, 5, 'normal', '🔋'], [50, 5, 'warning', '🔋'], [30.5, 3, 'warning', '🔋'], [30, 3, 'low', '🪫'], [20, 2, 'low', '🪫'],
    [0, 0, 'low', '🪫'], [.0001, 1, 'low', '🪫']]) {
    const battery = quotaBattery({ remainingPercent: remaining });
    assert.equal(battery.filled, filled); assert.equal(battery.level, level);
    assert.ok(battery.text.startsWith(icon));
    const text = content(buildBroadcastCards(snapshot([account({ metrics: [metric({ usedPercent: undefined, remainingPercent: remaining })], windowStats: [] })])));
    assert.equal(text.includes('电量低'), level === 'low');
    assert.ok(text.includes(battery.text));
  }
});

test('native card gives every account a title, metadata, independent quota columns and compact local statistics', () => {
  const cards = buildBroadcastCards(snapshot([account()]), options);
  assert.equal(validateBroadcastCards(cards), true);
  const modules = cards[0].modules;
  assert.equal(modules[0].text.content, 'OpenAI 额度播报');
  assert.equal(modules.find(module => module.type === 'header' && module.text.content === 'OpenAI_5X').text.type, 'plain-text');
  const fields = modules.find(module => module.type === 'section').text;
  assert.equal(fields.cols, 2);
  assert.equal(displayText(fields.fields[0].content), '5h 剩余 62%\n🔋 [■■■■■■□□□□]▏\n重置 09/21 10:00');
  assert.equal(displayText(fields.fields[1].content), '7d 剩余 87%\n🔋 [■■■■■■■■■□]▏\n重置 09/27 10:00');
  const text = content(cards);
  assert.match(text, /本站 5h：417 次 · 18\.8M Token · 扣费 \$57\.15\n本站 7d：417 次 · 18\.8M Token · 扣费 \$57\.15/);
  assert.match(text, /更新 09\/21 09:20（北京时间）/);
  assert.doesNotMatch(text, /999\.99|696\.28/);
  assert.equal(modules.at(-1).elements[0].value, 'https://quota.example/quota/');
  assert.equal((text.match(/电池显示剩余额度/g) || []).length, 1);
});

test('eight accounts fit as complete separated groups and remain within official payload limits', () => {
  const cards = buildBroadcastCards(snapshot(Array.from({ length: 8 }, (_, index) => account({ name: `账号 ${index}` }))), options);
  assert.equal(cards.flatMap(card => card.modules).filter(module => module.type === 'header').length, 9);
  assert.equal(cards.flatMap(card => card.modules).length, 45);
  assert.ok(JSON.stringify(cards).length <= 8000);
  assert.ok(Buffer.byteLength(JSON.stringify(cards)) <= 18000);
  assert.doesNotMatch(content(cards), /另有/);
});

test('KOOK uses native font colors for charge thresholds, metadata and summary', () => {
  for (const [remaining, theme] of [[0, 'danger'], [30, 'danger'], [30.5, 'warning'], [50, 'warning'], [50.5, 'success'], [100, 'success']]) {
    const cards = buildBroadcastCards(snapshot([account({ metrics: [metric({ usedPercent: undefined, remainingPercent: remaining })] })]), options);
    assert.equal(validateBroadcastCards(cards), true);
    const field = cards[0].modules.find(module => module.type === 'section').text.fields[0];
    assert.equal(field.type, 'kmarkdown');
    assert.equal((field.content.match(new RegExp(`\\(font\\)\\[${theme}\\]`, 'g')) || []).length, 2, 'quota label and battery share the exact charge color');
    assert.match(field.content, /\(font\)重置 .*\(font\)\[tips\]/);
    assert.ok(JSON.stringify(cards).includes('(font)Pro 5x(font)[purple]'));
    assert.ok(JSON.stringify(cards).includes('(font)开启(font)[success]'));
  }
});

test('large snapshots truncate complete account groups with a visible count and keep the footer', () => {
  const accounts = Array.from({ length: 200 }, (_, index) => account({ name: `长账户 ${index} ${'文本'.repeat(30)}` }));
  const cards = buildBroadcastCards(snapshot(accounts), options);
  const shown = cards.flatMap(card => card.modules).filter(module => module.type === 'header').length - 1;
  assert.ok(shown > 0 && shown < accounts.length);
  assert.match(content(cards), new RegExp(`另有 ${accounts.length - shown} 个账号`));
  assert.match(content(cards), /更新 .*北京时间/);
  assert.ok(cards.flatMap(card => card.modules).length <= 50);
  assert.ok(JSON.stringify(cards).length <= 8000);
  assert.equal(validateBroadcastCards(cards), true);
});

test('zero, full, tiny and over-limit percentages preserve honest bars and unknown never means zero', () => {
  const cases = [
    [0, '100', '■■■■■■■■■■'], [100, '0', '□□□□□□□□□□'], [120, '0', '□□□□□□□□□□'],
    [0.0001, '>99.99', '■■■■■■■■■□'], [99.9999, '<0.01', '■□□□□□□□□□'],
  ];
  for (const [usedPercent, remaining, bar] of cases) {
    const text = content(buildBroadcastCards(snapshot([account({ metrics: [metric({ usedPercent })], windowStats: [] })])));
    assert.ok(text.includes(`剩余 ${remaining}%`), text);
    assert.ok(text.includes(bar), text);
    if (usedPercent > 100) assert.match(text, /已用 120%/);
  }
  for (const invalid of [null, undefined, NaN, Infinity, -1, '38']) {
    const text = content(buildBroadcastCards(snapshot([account({ metrics: [metric({ usedPercent: invalid, remainingPercent: invalid })], windowStats: [] })])));
    assert.match(text, /5h 未知/);
    assert.doesNotMatch(text, /[■□]{10}|剩余 100%/);
  }
  const fallback = content(buildBroadcastCards(snapshot([account({ metrics: [metric({ usedPercent: null, remainingPercent: 62 })] })])));
  assert.match(fallback, /剩余 62%/);
});

test('balances, local spending limits and missing quota remain separate from percentage bars', () => {
  const cards = buildBroadcastCards(snapshot([account({ metrics: [
    { key: 'balance', label: '账户共享余额', kind: 'balance', value: 57.15, unit: 'USD' },
    { key: 'local-money', label: '消费限额', kind: 'count', scope: 'local', remaining: 80, used: 20, limit: 100, unit: 'USD', usedPercent: 20 },
    { key: 'grok-product-x', kind: 'percent', usedPercent: 80 },
  ], windowStats: [] })]));
  const text = content(cards);
  assert.match(text, /账户共享余额\n\$57\.15/);
  assert.match(text, /本站消费限额\n剩余 \$80\.00/);
  assert.doesNotMatch(text, /[■□]{10}|grok-product/);
  assert.match(content(buildBroadcastCards(snapshot([account({ metrics: [], windowStats: [] })]))), /额度未知/);
});

test('freshness and failures remain visible without exposing raw error text or credentials', () => {
  const cards = buildBroadcastCards({ checkedAt, stale: true, accounts: [account({
    name: 'Bot sk-0123456789abcdefghijklmnop @everyone https://private.example/path',
    planLabel: 'Authorization: Bearer PRIVATE_PLAN',
    error: 'PRIVATE_ERROR access_token=SECRET', notes: ['PRIVATE_NOTE'], credentials: { token: 'PRIVATE_TOKEN' },
    metrics: [metric({ freshness: 'stale', observedAt: '2026-09-20T01:20:00Z' }), metric({ freshness: 'unknown', usedPercent: undefined, resetAt: 'invalid' })],
  })] }, options);
  const serialized = JSON.stringify(cards);
  assert.match(content(cards), /更新未完成/);
  assert.match(content(cards), /查询异常/);
  assert.match(content(cards), /旧采样 09\/20 09:20/);
  assert.match(content(cards), /剩余 62%（旧）/);
  assert.match(content(cards), /未知（时间未知）/);
  assert.doesNotMatch(serialized, /PRIVATE_|SECRET|0123456789|@everyone|private\.example|admin=|#secret|credentials/);
});

test('untrusted dashboard links are omitted, legitimate links lose credentials in query and fragment', () => {
  for (const dashboardUrl of ['javascript:alert(1)', 'data:text/html,bad', 'https://user:pass@example.com/', 'not a url', 'https://example.com/' + 'x'.repeat(301)]) {
    const cards = buildBroadcastCards(snapshot([]), { dashboardUrl });
    assert.ok(!cards.flatMap(card => card.modules).some(module => module.type === 'action-group'));
  }
  assert.throws(() => buildBroadcastCards(snapshot([]), { timeZone: 'not-a-zone' }), /时区/);
  assert.match(content(buildBroadcastCards(snapshot([]))), /暂无账号数据/);
});

test('sender validation rejects unsupported markup, injected properties, unsafe URLs and protocol limits', () => {
  const make = () => buildBroadcastCards(snapshot([account()]), options);
  const invalid = modify => { const cards = make(); modify(cards); assert.throws(() => validateBroadcastCards(cards), /KOOK 卡片格式不符合安全限制/); };
  invalid(cards => { cards[0].modules[0].text.type = 'kmarkdown'; });
  invalid(cards => { cards[0].modules[1].elements[0] = { type: 'kmarkdown', content: '(font)test(font)[red]' }; });
  invalid(cards => { cards[0].modules[1].elements[0] = { type: 'kmarkdown', content: '(font)test(font)[danger] **unexpected**' }; });
  invalid(cards => { cards[0].modules[1].elements[0] = { type: 'kmarkdown', content: '(font)(met)all(met)(font)[danger]' }; });
  invalid(cards => { cards[0].modules[0].text.content = 'x'.repeat(101); });
  invalid(cards => { cards[0].modules[1].elements[0].content = 'x'.repeat(2001); });
  invalid(cards => { cards[0].modules[0].text.content = 'sk-0123456789abcdefghijklmnop'; });
  invalid(cards => { cards[0].modules[0].text.content = '(met)all(met)'; });
  invalid(cards => { cards[0].modules[0].text.content = 'hello\u202e'; });
  invalid(cards => { cards[0].modules.find(module => module.type === 'section').text.cols = 4; });
  invalid(cards => { cards[0].modules[0].extra = 'PRIVATE'; });
  invalid(cards => { cards[0].modules.at(-1).elements[0].value = 'https://example.com/?token=secret'; });
  invalid(cards => { cards[0].modules.at(-1).elements[0].value = 'javascript:alert(1)'; });
  invalid(cards => { cards[0].modules.at(-1).elements[0].click = 'return-val'; });
  invalid(cards => { cards[0].modules = Array.from({ length: 51 }, () => ({ type: 'divider' })); });
  invalid(cards => { cards.push(...Array.from({ length: 5 }, () => structuredClone(cards[0]))); });
  invalid(cards => { cards[0].modules = Array.from({ length: 5 }, () => ({ type: 'context', elements: [{ type: 'plain-text', content: 'x'.repeat(1700) }] })); });
  assert.throws(() => validateBroadcastCards([]), /KOOK/);
  assert.throws(() => validateBroadcastCards(null), /KOOK/);
});
