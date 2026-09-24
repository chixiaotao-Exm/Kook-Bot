import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const STALE_MS = 30 * 60000;
const labels = { healthy: '正常', limited: '限流中', temporary: '暂不可用', expired: '已到期',
  error: '异常', disabled: '已关闭', paused: '暂停调度', unknown: '待确认' };
const iso = offset => new Date(NOW + offset).toISOString();
const account = (health = {}) => ({ id: '1', name: 'Health fixture', health: {
  state: 'healthy', label: '正常', reason: '账号已启用且可调度，未发现已知阻断。',
  issues: [], observedAt: iso(0), freshness: 'fresh', recoverAt: null, expiresAt: null, lastUsedAt: null, ...health,
} });
const plain = value => JSON.parse(JSON.stringify(value));
const shownLabel = value => value.fresh ? value.label : '待确认';

function logic(now = NOW) {
  // Evaluate the shipped frontend function itself. Only its environment is a
  // fixture; the state transitions under test are never copied into this test.
  const start = SOURCE.indexOf('  function accountHealth(');
  const end = SOURCE.indexOf('  function accountHealthHtml(', start);
  assert.ok(start >= 0 && end > start, 'Expected the actual accountHealth function block');
  const context = vm.createContext({ healthLabels: labels, HEALTH_STALE_MS: STALE_MS, HEALTH_FUTURE_MS: 60000,
    healthNow: () => now });
  vm.runInContext(`${SOURCE.slice(start, end)}\nglobalThis.projectHealth = accountHealth;`, context);
  return value => plain(context.projectHealth(value, now));
}

test('the actual frontend ages a normal observation after thirty minutes without a server refresh', () => {
  const original = account();
  assert.equal(shownLabel(logic(NOW)(original)), '正常');
  assert.equal(logic(NOW + STALE_MS)(original).fresh, true);
  const old = logic(NOW + STALE_MS + 1)(original);
  assert.equal(old.fresh, false); assert.equal(old.freshness, 'stale');
  assert.equal(old.category, 'unknown'); assert.equal(shownLabel(old), '待确认');
});

test('successive block deadlines keep remaining blocks and never imply recovery when the last one ends', () => {
  const original = account({ state: 'limited', label: '限流中', reason: '原服务记录的限流时间尚未结束。', recoverAt: iso(120000),
    issues: [{ code: 'rate_limit', label: '请求限流', until: iso(60000) },
      { code: 'temporary', label: '临时暂停调度', until: iso(90000) }, { code: 'overload', label: '服务过载', until: iso(120000) }] });
  const before = structuredClone(original);
  const limited = logic(NOW + 59999)(original);
  assert.equal(limited.state, 'limited'); assert.equal(limited.recoverAt, iso(120000));
  const partlyEnded = logic(NOW + 60000)(original);
  assert.equal(partlyEnded.state, 'temporary'); assert.equal(partlyEnded.recoverAt, iso(120000));
  assert.ok(partlyEnded.issues.some(issue => issue.code === 'rate_limit_ended'));
  const lastRemaining = logic(NOW + 90000)(original);
  assert.equal(lastRemaining.state, 'temporary'); assert.equal(lastRemaining.recoverAt, iso(120000));
  assert.ok(lastRemaining.issues.some(issue => issue.code === 'temporary_ended'));
  const ended = logic(NOW + 120000)(original);
  assert.equal(ended.state, 'unknown'); assert.equal(ended.recoverAt, null); assert.equal(ended.category, 'unknown');
  assert.ok(ended.issues.every(issue => issue.code.endsWith('_ended'))); assert.match(ended.reason, /等待|刷新/);
  assert.equal(logic(NOW + 130000)({ ...original, health: ended }).state, 'unknown');
  assert.deepEqual(original, before, 'Re-aging the UI must not mutate server data');
});

test('preexisting stale or unknown observations cannot become fresh merely by repainting', () => {
  for (const freshness of ['stale', 'unknown']) {
    const original = account({ freshness });
    const result = logic(NOW + 1000)(original);
    assert.equal(result.fresh, false); assert.equal(result.category, 'unknown'); assert.equal(shownLabel(result), '待确认');
  }
  const expiredBlock = account({ state: 'limited', label: '限流中', freshness: 'stale',
    issues: [{ code: 'rate_limit', label: '请求限流', until: iso(1000) }], recoverAt: iso(1000) });
  const result = logic(NOW + 2000)(expiredBlock);
  assert.equal(result.state, 'unknown'); assert.equal(result.freshness, 'stale'); assert.equal(result.fresh, false);
  assert.equal(result.recoverAt, null);
});

test('configured expiry can worsen a saved healthy state at its exact deadline', () => {
  const original = account({ expiresAt: iso(60000) });
  assert.equal(logic(NOW + 59999)(original).state, 'healthy');
  const expired = logic(NOW + 60000)(original);
  assert.equal(expired.state, 'expired'); assert.equal(expired.category, 'attention');
  assert.equal(shownLabel(expired), '已到期'); assert.ok(expired.issues.some(issue => issue.code === 'expired'));
  assert.equal(expired.recoverAt, null); assert.match(expired.reason, /到期/);
  const old = logic(NOW + STALE_MS + 1)(original);
  assert.equal(old.fresh, false); assert.equal(shownLabel(old), '待确认');
});

test('invalid or implausibly future observation times never display a confirmed healthy state', () => {
  for (const observedAt of [null, undefined, '', 'invalid', iso(61000)]) {
    const result = logic(NOW)(account({ observedAt }));
    assert.equal(result.fresh, false, String(observedAt)); assert.equal(result.freshness, 'unknown');
    assert.equal(result.category, 'unknown'); assert.equal(shownLabel(result), '待确认');
  }
  const missing = logic(NOW)({ id: '2' });
  assert.equal(missing.fresh, false); assert.equal(shownLabel(missing), '待确认');
});

test('only a new valid server observation can restore the healthy display after the old sample ages', () => {
  const later = NOW + STALE_MS + 1, original = account();
  assert.equal(logic(later)(original).fresh, false);
  const updated = account({ observedAt: new Date(later).toISOString(), freshness: 'fresh', state: 'healthy' });
  const fresh = logic(later)(updated);
  assert.equal(fresh.fresh, true); assert.equal(shownLabel(fresh), '正常'); assert.equal(fresh.category, 'healthy');
  const ended = account({ state: 'unknown', label: '待确认', reason: '原阻断时间已结束，等待刷新确认是否恢复。',
    issues: [{ code: 'rate_limit_ended', label: '原限流时间已结束', until: iso(1000) }] });
  assert.equal(logic(NOW + 2000)(ended).state, 'unknown');
  assert.equal(logic(NOW + 2000)(account({ observedAt: iso(2000) })).state, 'healthy');
});

test('actual account-card notices use the derived expired or remaining-block state and reason', () => {
  const healthStart = SOURCE.indexOf('  function accountHealth('), healthEnd = SOURCE.indexOf('  function accountHealthHtml(', healthStart);
  const issueStart = SOURCE.indexOf('  const accountIssue ='), issueEnd = SOURCE.indexOf('  const knownMetric =', issueStart);
  const cardStart = SOURCE.indexOf('  function accountHtml('), cardEnd = SOURCE.indexOf('  function renderAccounts(', cardStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart && issueStart >= 0 && issueEnd > issueStart && cardStart >= 0 && cardEnd > cardStart);
  const context = vm.createContext({ healthLabels: labels, HEALTH_STALE_MS: STALE_MS, HEALTH_FUTURE_MS: 60000,
    healthNow: () => NOW + 60000,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    platformInfo: () => ({ name: 'OpenAI', icon: 'O' }), platformKey: () => 'openai', providers: { openai: {} },
    accountStale: () => false, accountKnown: () => true, accountPlan: () => ({ label: 'Pro', source: '上游返回' }),
    accountHealthHtml: () => '', accountLoadHtml: () => '', creditPanelsHtml: () => '', invitationHtml: () => '', accountDetailsHtml: () => '',
  });
  vm.runInContext(`${SOURCE.slice(healthStart, healthEnd)}\n${SOURCE.slice(issueStart, issueEnd)}\n${SOURCE.slice(cardStart, cardEnd)}\nglobalThis.card = accountHtml;`, context);
  const expired = context.card(account({ expiresAt: iso(60000) }));
  const expiryNotice = /<div class="account-notices">([\s\S]*?)<\/div>/.exec(expired)?.[1];
  assert.ok(expiryNotice); assert.match(expiryNotice, /已到期/); assert.match(expiryNotice, /超过账号配置到期时间/);
  assert.doesNotMatch(expiryNotice, /正常|未发现已知阻断/);
  const blocked = context.card(account({ state: 'limited', label: '限流中', reason: '原服务记录的限流时间尚未结束。',
    issues: [{ code: 'rate_limit', label: '请求限流', until: iso(60000) }, { code: 'overload', label: '服务过载', until: iso(120000) }] }));
  const blockNotice = /<div class="account-notices">([\s\S]*?)<\/div>/.exec(blocked)?.[1];
  assert.ok(blockNotice); assert.match(blockNotice, /暂不可用/); assert.match(blockNotice, /尚未结束的临时阻断/);
  assert.doesNotMatch(blockNotice, /限流中|限流时间尚未结束/);
});

function timedLogic(accounts = [account()]) {
  const start = SOURCE.indexOf('  function healthNow(');
  const end = SOURCE.indexOf('  function accountHealthHtml(', start);
  assert.ok(start >= 0 && end > start, 'Expected actual health clock, projection and timer functions');
  let wall = NOW, tick = 0, serial = 0;
  const timers = new Map(), rendered = { summary: 0, accounts: 0, health: 0 }, appView = { hidden: false };
  const state = { publicAccess: true, authenticated: false, accounts: structuredClone(accounts) };
  class ClockDate extends Date { static now() { return wall; } }
  const context = vm.createContext({ Date: ClockDate, performance: { now: () => tick },
    healthLabels: labels, HEALTH_STALE_MS: STALE_MS, HEALTH_FUTURE_MS: 60000,
    healthClock: { wall, tick }, healthTimer: null, healthFingerprint: '', state, document: { hidden: false },
    canRead: () => state.publicAccess || state.authenticated,
    $: selector => { assert.equal(selector, '#app-view'); return appView; },
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: tick + delay, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    renderSummary: () => { rendered.summary++; }, renderAccounts: () => { rendered.accounts++; }, renderHealth: () => { rendered.health++; },
    fetch: () => { assert.fail('Health aging must not initiate HTTP requests'); },
    renderInvitation: () => { assert.fail('Health aging must not reset an open invitation form'); },
  });
  vm.runInContext(`${SOURCE.slice(start, end)}\nglobalThis.controls = {
    project: accountHealth, clock: healthNow, pause: pauseHealthExpiry, schedule: scheduleHealthExpiry, refresh: refreshHealthState,
  };`, context);
  const controls = context.controls;
  function advance(milliseconds, { changeWall = true, runTimers = true } = {}) {
    const end = tick + milliseconds;
    for (let step = 0; runTimers && step < 10000; step++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next, elapsed = timer.at - tick;
      tick = timer.at; if (changeWall) wall += elapsed;
      timers.delete(id); timer.callback();
      assert.ok(step < 9999, 'Timer must not re-arm in a zero-delay loop');
    }
    const elapsed = end - tick; tick = end; if (changeWall) wall += elapsed;
  }
  return { controls, timers, rendered, state, document: context.document, appView, advance,
    clearRendered() { rendered.summary = 0; rendered.accounts = 0; rendered.health = 0; },
    setWall(value) { wall = value; }, project: value => plain(controls.project(value)) };
}

test('one visible timer ages the display locally and unchanged minute checks do not repaint', () => {
  const f = timedLogic(); f.controls.refresh(); f.clearRendered();
  assert.equal(f.timers.size, 1);
  for (let index = 0; index < 5; index++) f.controls.schedule();
  assert.equal(f.timers.size, 1, 'Rescheduling replaces rather than multiplies timers');
  f.advance(60000); assert.deepEqual(f.rendered, { summary: 0, accounts: 0, health: 0 });
  f.advance(STALE_MS - 60000); assert.equal(f.project(f.state.accounts[0]).fresh, true);
  assert.deepEqual(f.rendered, { summary: 0, accounts: 0, health: 0 });
  f.advance(1); assert.equal(f.project(f.state.accounts[0]).fresh, false);
  assert.deepEqual(f.rendered, { summary: 1, accounts: 1, health: 1 });
  f.advance(60000); assert.deepEqual(f.rendered, { summary: 1, accounts: 1, health: 1 });
  assert.equal(f.timers.size, 1);
});

test('timers repaint at each blocking deadline and configured expiry without another HTTP sample', () => {
  const f = timedLogic([account({ state: 'limited', label: '限流中', recoverAt: iso(100),
    issues: [{ code: 'rate_limit', label: '请求限流', until: iso(50) }, { code: 'overload', label: '服务过载', until: iso(100) }] })]);
  f.controls.refresh(); f.clearRendered();
  assert.equal([...f.timers.values()][0].delay, 50);
  f.advance(49); assert.equal(f.rendered.health, 0);
  f.advance(1); assert.equal(f.project(f.state.accounts[0]).state, 'temporary'); assert.equal(f.rendered.health, 1);
  f.advance(50); assert.equal(f.project(f.state.accounts[0]).state, 'unknown'); assert.equal(f.rendered.health, 2);
  const expires = timedLogic([account({ expiresAt: iso(75) })]);
  expires.controls.refresh(); expires.clearRendered(); expires.advance(75);
  assert.equal(expires.project(expires.state.accounts[0]).state, 'expired'); assert.equal(expires.rendered.accounts, 1);
});

test('hidden pages stop the timer and visibility restoration immediately re-ages both views', () => {
  const f = timedLogic(); f.controls.refresh(); f.clearRendered();
  f.document.hidden = true; f.controls.pause();
  assert.equal(f.timers.size, 0); f.controls.schedule(); assert.equal(f.timers.size, 0);
  f.advance(STALE_MS + 1); assert.deepEqual(f.rendered, { summary: 0, accounts: 0, health: 0 });
  f.document.hidden = false; f.controls.refresh();
  assert.equal(f.project(f.state.accounts[0]).fresh, false);
  assert.deepEqual(f.rendered, { summary: 1, accounts: 1, health: 1 }); assert.equal(f.timers.size, 1);
  f.appView.hidden = true; f.controls.refresh(); assert.equal(f.timers.size, 0);
  f.appView.hidden = false; f.state.publicAccess = false; f.controls.schedule(); assert.equal(f.timers.size, 0);
});

test('a backwards wall clock cannot rejuvenate cached health while monotonic time advances', () => {
  const f = timedLogic(); f.controls.refresh(); f.clearRendered();
  f.setWall(NOW - 3600000); f.advance(STALE_MS + 1, { changeWall: false });
  assert.equal(f.controls.clock(), NOW + STALE_MS + 1);
  assert.equal(f.project(f.state.accounts[0]).fresh, false); assert.equal(f.rendered.health, 1);
  f.setWall(NOW - 7200000); assert.equal(f.project(f.state.accounts[0]).fresh, false);
});

test('a later server sample replaces the stale fingerprint and schedules its own expiration', () => {
  const f = timedLogic(); f.controls.refresh(); f.advance(STALE_MS + 1); f.clearRendered();
  f.state.accounts = [account({ observedAt: iso(STALE_MS + 1), freshness: 'fresh' })];
  f.controls.refresh(); assert.equal(f.project(f.state.accounts[0]).fresh, true);
  assert.deepEqual(f.rendered, { summary: 1, accounts: 1, health: 1 }); assert.equal(f.timers.size, 1);
  f.advance(STALE_MS); assert.equal(f.project(f.state.accounts[0]).fresh, true);
  f.advance(1); assert.equal(f.project(f.state.accounts[0]).fresh, false); assert.equal(f.rendered.health, 2);
});
