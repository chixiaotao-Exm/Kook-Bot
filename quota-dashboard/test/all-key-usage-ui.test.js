import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-26T08:00:00Z');
const slice = (start, end) => {
  const from = source.indexOf(start), until = source.indexOf(end, from);
  assert.ok(from >= 0 && until > from, `Find shipped source: ${start}`);
  return source.slice(from, until);
};
const fixture = (overrides = {}) => ({ enabled: true, loading: false, complete: true, stale: false,
  day: '2026-09-26', updatedAt: new Date(NOW).toISOString(), refreshIntervalMs: 600000,
  totals: { keys: 12, todayCost: 15.25, last30DaysCost: 224.5, todayRequests: 720, todayTokens: 2000000 },
  rows: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: `Key ${i + 1}`, keyHint: 'sk-…cafe', status: 'active',
    today: { cost: i, requests: i * 10, tokens: i * 1000 }, last30DaysCost: i * 12,
    quota: { used: i * 5, limit: 100, remaining: 100 - i * 5, unlimited: false } })), ...overrides });

function ui(data = fixture()) {
  let now = NOW, serial = 0;
  const timers = new Map(), nodes = new Map();
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    return nodes.get(selector);
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Date: Clock, Intl, state: { publicAccess: true, view: 'overview', snapshot: { allKeyUsage: data } },
    allKeyView: { timer: null },
    document: { hidden: false }, $: get, canRead: () => context.state.publicAccess, formatTime: value => value,
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(`${slice('  const escapeHtml =', '  const platformKey =')}
${slice('  function beijingDay(', '  const trendKey =')}
${slice('  const compact =', '  function resetKeyQuery(')}
globalThis.render = renderAllKeyUsage; globalThis.project = allKeyUsageProjection;
globalThis.format = allKeyNumber; globalThis.pause = pauseAllKeyUsage;`, context);
  return { context, get, timers, render: () => context.render(), advance(value) { now = value; } };
}

test('the overview places all-key usage first, before account summaries', () => {
  const heading = html.indexOf('<h1>额度总览'), keys = html.indexOf('id="all-key-usage"'), accounts = html.indexOf('id="summary"');
  assert.ok(heading >= 0 && keys > heading && accounts > keys);
});

test('renders only aggregate usage without individual key details or controls', () => {
  const screen = ui(); screen.render();
  const summary = screen.get('#all-key-summary').innerHTML;
  assert.equal((summary.match(/class="all-key-stat"/g) || []).length, 4);
  assert.match(summary, /今日扣费<\/span><strong>\$15\.25/);
  assert.match(summary, /今日请求<\/span><strong>720/);
  assert.match(summary, /密钥数<\/span><strong>12/);
  assert.match(summary, /近 30 天扣费<\/span><strong>\$224\.5/);
  assert.doesNotMatch(summary, /Key 1|sk-…cafe|<tr>/);
  assert.doesNotMatch(html, /id="all-key-(?:rows|search|expand|visible-count|count)"|搜索 API Key 名称或 ID/);
  assert.equal(screen.get('#all-key-state').textContent, '已同步');
  assert.match(screen.get('#all-key-updated').textContent, /每 10 分钟自动更新/);
});

test('unknown costs stay unknown while genuine zeros remain zero', () => {
  const screen = ui(fixture({ totals: { keys: 0, todayCost: null, last30DaysCost: 0, todayRequests: null }, rows: [] }));
  screen.render();
  assert.equal(screen.context.format(null, true), '—');
  assert.equal(screen.context.format(undefined), '—');
  assert.equal(screen.context.format('0', true), '—');
  assert.equal(screen.context.format(0, true), '$0');
  assert.match(screen.get('#all-key-summary').innerHTML, /今日扣费<\/span><strong>—/);
  assert.match(screen.get('#all-key-summary').innerHTML, /近 30 天扣费<\/span><strong>\$0/);
});

test('old date values disappear at Beijing midnight even with no new server response', () => {
  const beforeMidnight = Date.parse('2026-09-26T15:59:59Z');
  const screen = ui(fixture({ updatedAt: new Date(beforeMidnight).toISOString() }));
  screen.advance(beforeMidnight); screen.render();
  assert.match(screen.get('#all-key-summary').innerHTML, /今日扣费<\/span><strong>\$15\.25/);
  assert.equal([...screen.timers.values()][0].delay, 1001);
  screen.advance(beforeMidnight + 1001); [...screen.timers.values()][0].callback();
  assert.match(screen.get('#all-key-summary').innerHTML, /今日扣费<\/span><strong>—/);
  assert.match(screen.get('#all-key-summary').innerHTML, /今日请求<\/span><strong>—/);
  assert.match(screen.get('#all-key-summary').innerHTML, /近 30 天扣费<\/span><strong>\$224\.5/);
  assert.match(screen.get('#all-key-feedback').textContent, /旧日期/);
  assert.match(screen.get('#all-key-summary').innerHTML, /密钥数<\/span><strong>12/);
  screen.context.state.snapshot.allKeyUsage = fixture({ day: '2026-09-27', updatedAt: new Date(beforeMidnight + 1001).toISOString() });
  screen.render();
  assert.match(screen.get('#all-key-summary').innerHTML, /今日扣费<\/span><strong>\$15\.25/);
});

test('failed refresh keeps previous values but marks stale, without exposing upstream errors', () => {
  const screen = ui(fixture({ error: 'upstream secret diagnostic', stale: true, rows: [] })); screen.render();
  assert.equal(screen.get('#all-key-state').textContent, '旧数据');
  assert.match(screen.get('#all-key-feedback').textContent, /保留上次结果/);
  assert.match(screen.get('#all-key-summary').innerHTML, /\$15\.25/);
  assert.doesNotMatch(screen.get('#all-key-feedback').textContent, /secret/);
  screen.context.state.snapshot.allKeyUsage = fixture({ complete: false }); screen.render();
  assert.equal(screen.get('#all-key-state').textContent, '部分数据');
  screen.context.state.snapshot.allKeyUsage = fixture({ updatedAt: null, error: 'upstream secret diagnostic', totals: {} }); screen.render();
  assert.match(screen.get('#all-key-feedback').textContent, /正在等待下次同步/);
  assert.doesNotMatch(screen.get('#all-key-feedback').textContent, /保留上次结果|secret/);
});

test('loading, missing configuration and empty snapshots are safe', () => {
  const screen = ui(undefined); screen.context.state.snapshot = null; screen.render();
  assert.equal(screen.get('#all-key-state').textContent, '正在同步');
  screen.context.state.snapshot = { allKeyUsage: { enabled: false } }; screen.render();
  assert.equal(screen.get('#all-key-state').textContent, '未配置');
  screen.context.state.snapshot = { allKeyUsage: { enabled: true, loading: true, rows: [], totals: {} } }; screen.render();
  assert.equal(screen.get('#all-key-state').textContent, '正在同步');
  assert.equal((screen.get('#all-key-summary').innerHTML.match(/<strong>—<\/strong>/g) || []).length, 4);
});

test('render timer stays singular, stops outside overview, and ages stale records locally', () => {
  const screen = ui(); screen.render(); screen.render(); assert.equal(screen.timers.size, 1);
  screen.advance(NOW + 660001); screen.render(); assert.equal(screen.get('#all-key-state').textContent, '旧数据');
  screen.context.state.view = 'health'; screen.render(); assert.equal(screen.timers.size, 0);
  screen.context.state.view = 'overview'; screen.context.document.hidden = true; screen.render(); assert.equal(screen.timers.size, 0);
  screen.context.document.hidden = false; screen.render(); assert.equal(screen.timers.size, 1);
  screen.context.pause(); assert.equal(screen.timers.size, 0);
});

test('status polling only accelerates while all-key usage is loading on visible overview', () => {
  const jobs = new Map(); let serial = 0;
  const context = vm.createContext({ pollTimer: null, state: { refreshing: false, view: 'overview', snapshot: { allKeyUsage: { loading: true } } },
    document: { hidden: false }, $: () => ({ hidden: false }), canRead: () => true, refreshIntervalMs: () => 600000,
    setTimeout: (callback, delay) => { const id = ++serial; jobs.set(id, { callback, delay }); return id; }, clearTimeout: id => jobs.delete(id) });
  vm.runInContext(`${slice('  function schedulePoll(', '  function beijingDay(')}\nglobalThis.schedule = schedulePoll;`, context);
  const delay = () => [...jobs.values()][0]?.delay;
  context.schedule(); assert.equal(delay(), 5000); context.schedule(); assert.equal(jobs.size, 1);
  context.state.view = 'health'; context.schedule(); assert.equal(delay(), 600000);
  context.state.view = 'overview'; context.state.snapshot.allKeyUsage.loading = false; context.schedule(); assert.equal(delay(), 600000);
  context.state.refreshing = true; context.schedule(); assert.equal(delay(), 2500);
  context.document.hidden = true; context.schedule(); assert.equal(jobs.size, 0);
});
