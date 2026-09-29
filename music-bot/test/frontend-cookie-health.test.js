import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieHealth, cookieTimingHtml, createHealth } from '../frontend/health.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const sample = (patch = {}) => ({ status: 'logged_in', loggedIn: true, cookieStatus: 'valid', checkedAt: NOW,
  lastSuccessAt: NOW, nextCheckAt: NOW + 300000, checkIntervalMs: 300000, stale: false, error: '', ...patch });

test('an expired sample or network error cannot keep a green cookie or become a missing login', () => {
  for (const account of [sample({ status: 'error' }), sample({ error: 'upstream timeout' }), sample({ stale: true }),
    sample({ checkedAt: NOW - 335001 }), sample({ checkedAt: NOW + 60001 }), sample({ checkedAt: null }), sample({ checkedAt: 'invalid' })]) {
    const state = cookieHealth(account, { now: NOW });
    assert.equal(state.status, 'unknown'); assert.equal(state.label, '暂无法确认'); assert.notEqual(state.tone, 'mint');
  }
  assert.equal(cookieHealth(sample(), { now: NOW, fetchFailed: true }).status, 'unknown');
  assert.equal(cookieHealth(sample({ checkedAt: NOW - 335000 }), { now: NOW }).status, 'valid');
  assert.equal(cookieHealth({ loggedIn: true }, { now: NOW }).status, 'unknown');
});

test('cookie states remain distinct and timing never invents a success or invalid date', () => {
  for (const [cookieStatus, label] of Object.entries({ valid: 'Cookie 有效', expired: 'Cookie 已失效', missing: '未登录',
    unknown: '暂无法确认', unavailable: '未配置', checking: '检测中' })) {
    assert.equal(cookieHealth(sample({ cookieStatus }), { now: NOW }).label, label);
  }
  assert.equal(cookieHealth(sample({ cookieStatus: 'valid' }), { now: NOW, checking: true }).status, 'checking');
  const html = cookieTimingHtml(sample({ lastSuccessAt: null, checkedAt: '<script>bad()</script>', nextCheckAt: NOW - 1 }), { now: NOW });
  assert.match(html, /尚未检查/); assert.match(html, /尚无成功记录/); assert.match(html, /等待后台检测/);
  assert.doesNotMatch(html, /Invalid Date|<script>/);
});

test('health view reads cached samples until an explicit check and drops stale success on fetch failure', async t => {
  const nodes = new Map();
  const root = { innerHTML: '', addEventListener() {}, querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, disabled: false });
    return nodes.get(selector);
  } };
  const calls = []; let fail = false, hold = null;
  const view = createHealth({ root, drawIcons() {}, onAccount() {}, api: async route => {
    calls.push(route); if (hold) await hold;
    if (fail) throw new Error('network unavailable');
    return { generatedAt: Date.now(), accounts: { netease: sample({ checkedAt: Date.now(), lastSuccessAt: Date.now(), nextCheckAt: Date.now() + 300000 }),
      qq: sample({ cookieStatus: 'expired', status: 'expired', loggedIn: false, checkedAt: Date.now() }) }, bots: [], events: [] };
  } });
  t.after(() => view.setActive(false));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  view.setActive(true); await settle();
  assert.deepEqual(calls, ['/health']);
  assert.match(nodes.get('#health-accounts').innerHTML, /Cookie 有效/);
  assert.match(nodes.get('#health-accounts').innerHTML, /Cookie 已失效/);
  let release; hold = new Promise(resolve => { release = resolve; });
  nodes.get('#health-refresh').onclick(); await settle();
  assert.deepEqual(calls, ['/health', '/health?refresh=1']);
  assert.match(nodes.get('#health-accounts').innerHTML, /检测中/);
  assert.doesNotMatch(nodes.get('#health-accounts').innerHTML, /Cookie 有效/);
  fail = true; release(); await settle();
  assert.match(nodes.get('#health-accounts').innerHTML, /暂无法确认/);
  assert.doesNotMatch(nodes.get('#health-accounts').innerHTML, /Cookie 有效|未登录/);
  assert.match(nodes.get('#health-accounts').innerHTML, /最近成功/);
  assert.equal(nodes.get('#health-refresh').disabled, false);
  hold = null; fail = false; view.setActive(false); view.setActive(true); await settle();
  assert.equal(calls.at(-1), '/health'); assert.match(nodes.get('#health-accounts').innerHTML, /Cookie 有效/);
});
