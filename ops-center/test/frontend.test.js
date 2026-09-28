import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const NOW = Date.parse('2026-09-25T12:00:00Z');
const iso = offset => new Date(NOW + offset).toISOString();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = () => ({ updatedAt: iso(0), hosts: [{ id: 'host-1', name: '中国服务器', state: 'up', observedAt: iso(0), lastSeenAt: iso(0), maintenance: false,
  metrics: { cpuPercent: 23.4, memoryPercent: 45, diskPercent: 31, load1: 0.42, uptimeSeconds: 86400 },
  services: [{ id: 'music', name: '音乐服务', activeState: 'active', pid: 123, restarts: 0, expected: 'running', restartAllowed: true, ok: true },
    { id: 'duet', name: '思维讨论', activeState: 'inactive', expected: 'stopped', restartAllowed: false, ok: true }],
  bots: [{ id: 'bot-1', name: '外卖音乐', kind: '音乐', state: 'online', channelName: '一起听歌', playing: true, lastError: '' },
    { id: 'bot-2', name: '思维讨论', kind: 'AI', state: 'stopped', playing: false }],
  history: [{ at: iso(-1000), cpuPercent: 20, memoryPercent: 40, diskPercent: 30 }, { at: iso(0), cpuPercent: 23, memoryPercent: 45, diskPercent: 31 }],
}], monitors: [{ id: 'web-1', name: '额度看板', url: 'https://api.example.test/quota/', state: 'up', maintenance: false,
  checkedAt: iso(0), latencyMs: 180, httpStatus: 200, tlsDays: 60, history: [{ at: iso(0), ok: true, latencyMs: 180 }] }],
  incidents: [], commands: [], notification: { enabled: true, botName: '思维2', infraChannel: '9000000000000101', webChannel: '9000000000000102' }, queryBot: { connected: true } });
const response = (data, status = 200) => Response.json(data, { status });
async function settle(check = () => true) {
  for (let count = 0; count < 100; count++) { await new Promise(resolve => setImmediate(resolve)); if (check()) return; }
  assert.fail('Frontend did not settle');
}

function element(id) {
  const classes = new Set(), handlers = new Map(), attributes = new Map();
  return { id, hidden: false, disabled: false, value: id === 'event-filter' ? 'all' : '', textContent: '', innerHTML: '', open: false, dataset: {},
    classList: { toggle(name, yes) { if (yes === undefined ? !classes.has(name) : yes) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); },
    addEventListener(name, callback) { handlers.set(name, callback); },
    async trigger(name, event = {}) { return handlers.get(name)?.({ preventDefault() {}, ...event }); },
    showModal() { this.open = true; }, close() { this.open = false; },
  };
}
async function harness(t, { authenticated = false, fetch: handler, onView = () => {} } = {}) {
  const elements = new Map(), timers = new Map(), calls = [], documentEvents = new Map(), windowEvents = new Map();
  let wall = NOW, tick = 0, timerId = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  get('app-view').hidden = true; get('login-view').hidden = true;
  const nav = ['overview', 'hosts', 'web', 'bots', 'events'].map(view => { const node = element(`nav-${view}`); node.dataset.view = view; return node; });
  const document = { hidden: false, querySelector: selector => { assert.ok(selector.startsWith('#')); return get(selector.slice(1)); },
    querySelectorAll: selector => selector === '.nav-item' ? nav : selector === '.view' ? nav.map(node => get(`view-${node.dataset.view}`)) : [],
    addEventListener: (name, callback) => documentEvents.set(name, callback) };
  class ClockDate extends Date { static now() { return wall; } }
  const context = vm.createContext({ Date: ClockDate, performance: { now: () => tick }, URL, document,
    window: { __OPS_EMBED_ONLY__: true, addEventListener: (name, callback) => windowEvents.set(name, callback) }, AbortController, crypto: { randomUUID: () => 'a6020d81-72fe-4b0e-a4d9-cf24a8080f25' },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay, at: tick + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      const call = { route: url.replace('./api/', ''), ...options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      if (handler) { const result = await handler(call, calls); if (result !== undefined) return result; }
      if (call.route === 'session') return response({ authenticated, csrf: 'csrf-fixture', ...(authenticated ? { user: { email: 'admin@example.test' } } : {}) });
      if (call.route === 'snapshot') return response(snapshot());
      if (call.route === 'login') return response({ authenticated: true, csrf: 'csrf-admin', user: { email: 'admin@example.test' } });
      if (call.route === 'logout') return response({ ok: true });
      if (call.route === 'maintenance') return response({ updated: true });
      if (call.route === 'commands') return response({ command: { id: 'command-1', hostId: call.body.hostId, serviceId: call.body.serviceId, status: 'pending', createdAt: iso(0) } });
      throw Error('Unexpected fixture route');
    },
  });
  const tail = SOURCE.lastIndexOf('  return {\n    show(view)'); assert.ok(tail > 0);
  vm.runInContext(SOURCE.slice(0, tail) + 'globalThis.ops = { state, currentTime, hostState, monitorState, botState, serviceState, monitorLink, sparkline, loadSnapshot, render, showView, openRestart, submitRestart, changeMaintenance, pausePolling, loseSession };\n' + SOURCE.slice(tail), context);
  const panel = context.window.createOpsPanel(document, { onView });
  await settle(() => !get('boot-view').hidden ? false : !context.ops.state.loading);
  t.after(() => context.ops.loseSession());
  return { panel, ops: context.ops, get, calls, timers, document, nav, async event(name) { documentEvents.get(name)?.(); await settle(); },
    advance(ms, { runTimers = true, changeWall = true } = {}) {
      const end = tick + ms;
      for (let index = 0; runTimers && index < 10000; index++) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
        const [id, timer] = next, elapsed = timer.at - tick; tick = timer.at; if (changeWall) wall += elapsed;
        timers.delete(id); timer.callback();
      }
      const elapsed = end - tick; tick = end; if (changeWall) wall += elapsed;
    }, setWall(value) { wall = value; } };
}

test('login uses a session CSRF token, clears the password and exposes all five views only after success', async t => {
  const f = await harness(t); assert.equal(f.get('app-view').hidden, true); assert.equal(f.get('login-view').hidden, false);
  assert.deepEqual(f.calls.map(call => call.route), ['session']);
  f.get('login-email').value = 'admin@example.test'; f.get('login-password').value = 'fixture-password';
  await f.get('login-form').trigger('submit'); await settle(() => !f.ops.state.loading);
  const login = f.calls.find(call => call.route === 'login');
  assert.deepEqual(login.body, { email: 'admin@example.test', password: 'fixture-password' });
  assert.equal(login.headers['X-CSRF-Token'], 'csrf-fixture'); assert.equal(login.credentials, 'same-origin');
  assert.equal(f.get('login-password').value, ''); assert.equal(f.get('app-view').hidden, false);
  for (const view of ['overview', 'hosts', 'web', 'bots', 'events']) {
    f.ops.showView(view); assert.equal(f.get(`view-${view}`).hidden, false);
    assert.equal(f.nav.find(node => node.dataset.view === view).classList.contains('active'), true);
  }
});

test('expired host and monitor observations become unknown and planned stops are distinct from offline bots', async t => {
  const f = await harness(t, { authenticated: true }), host = snapshot().hosts[0], monitor = snapshot().monitors[0];
  assert.equal(f.ops.botState(host.bots[1], host, NOW).label, '计划停用');
  assert.equal(f.ops.serviceState(host.services[1], host, NOW).label, '计划停用');
  assert.equal(f.ops.hostState(host, NOW + 120000).state, 'up'); assert.equal(f.ops.hostState(host, NOW + 120001).state, 'unknown');
  assert.equal(f.ops.monitorState(monitor, NOW + 150000).state, 'up'); assert.equal(f.ops.monitorState(monitor, NOW + 150001).state, 'unknown');
  assert.equal(f.ops.botState(host.bots[0], host, NOW + 120001).state, 'unknown');
  assert.equal(f.ops.hostState({ ...host, observedAt: 'bad' }, NOW).state, 'unknown');
  assert.equal(f.ops.hostState({ ...host, lastSeenAt: iso(-120001) }, NOW).state, 'unknown');
  assert.equal(f.ops.hostState({ ...host, lastSeenAt: null }, NOW).state, 'unknown');
  assert.equal(f.ops.monitorState({ ...monitor, checkedAt: iso(61000) }, NOW).state, 'unknown');
});

test('music cards show sampled bot uptime without extrapolation and hide it when stale or invalid', async t => {
  const raw = snapshot();raw.hosts[0].bots[0] = {...raw.hosts[0].bots[0],kind:'music',uptimeSeconds:93784,startedAt:iso(-93784000)};
  const f = await harness(t,{authenticated:true,fetch:call=>call.route==='snapshot'?response(raw):undefined});
  assert.match(f.get('bot-list').innerHTML,/运行时长（采样）/);assert.match(f.get('bot-list').innerHTML,/1 天 2 小时 3 分/);
  f.advance(60000,{runTimers:false});f.ops.render();assert.match(f.get('bot-list').innerHTML,/1 天 2 小时 3 分/);
  f.advance(60001,{runTimers:false});f.ops.render();assert.match(f.get('bot-list').innerHTML,/待确认（样本过期）/);
  assert.doesNotMatch(f.get('bot-list').innerHTML,/1 天 2 小时 3 分/);
  f.ops.state.data.hosts[0].observedAt = new Date(NOW+120001).toISOString();f.ops.state.data.hosts[0].lastSeenAt=f.ops.state.data.hosts[0].observedAt;
  const bot=f.ops.state.data.hosts[0].bots[0];
  for(const value of [undefined,null,-1,'100',true,Infinity,1e13]){bot.uptimeSeconds=value;f.ops.render();assert.match(f.get('bot-list').innerHTML,/运行时长（采样）<\/dt><dd>待确认/);}
  bot.uptimeSeconds=93784;bot.state='unknown';f.ops.render();assert.doesNotMatch(f.get('bot-list').innerHTML,/1 天 2 小时 3 分/);
  bot.kind='ai';f.ops.render();assert.doesNotMatch(f.get('bot-list').innerHTML,/运行时长（采样）|本次启动/);
});

test('background visibility pauses GET polling and resumes by aging old data before any new response', async t => {
  let block = false; const gate = deferred(); t.after(() => gate.resolve(response(snapshot())));
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' && block ? gate.promise : undefined });
  const before = f.calls.filter(call => call.route === 'snapshot').length;
  f.document.hidden = true; await f.event('visibilitychange'); f.advance(151000);
  assert.equal(f.calls.filter(call => call.route === 'snapshot').length, before);
  block = true; f.document.hidden = false; await f.event('visibilitychange');
  assert.equal(f.calls.filter(call => call.route === 'snapshot').length, before + 1);
  assert.match(f.get('overview-hosts').innerHTML, /待确认/); assert.match(f.get('overview-monitors').innerHTML, /待确认/);
  gate.resolve(response(snapshot())); await settle(() => !f.ops.state.loading);
});

test('logout cancels a pending snapshot and its late success cannot revive administrator display', async t => {
  let block = false; const late = deferred();
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' && block ? late.promise : undefined });
  block = true; const loading = f.ops.loadSnapshot(); await settle(() => f.ops.state.loading);
  const pending = f.calls.filter(call => call.route === 'snapshot').at(-1);
  await f.get('logout').trigger('click'); assert.equal(pending.signal.aborted, true);
  late.resolve(response(snapshot())); await loading;
  assert.equal(f.ops.state.authenticated, false); assert.equal(f.ops.state.data, null);
  assert.equal(f.get('app-view').hidden, true); assert.equal(f.get('login-view').hidden, false);
});

test('400, 401 and 403 from authenticated APIs immediately remove management controls', async t => {
  for (const status of [400, 401, 403]) {
    let fail = false;
    const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' && fail ? response({ error: '请重新登录' }, status) : undefined });
    fail = true; await f.ops.loadSnapshot();
    assert.equal(f.ops.state.authenticated, false); assert.equal(f.get('app-view').hidden, true);
    assert.equal(f.get('login-error').textContent, '请重新登录');
  }
});

test('HTML authorization failures also remove management controls', async t => {
  for (const status of [400, 401, 403]) {
    let fail = false;
    const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' && fail ? new Response('<h1>Access denied</h1>', { status }) : undefined });
    fail = true; await f.ops.loadSnapshot();
    assert.equal(f.ops.state.authenticated, false); assert.equal(f.get('app-view').hidden, true);
    assert.match(f.get('login-error').textContent, /重新登录/);
  }
});

test('restarts need confirmation, target only an allowed service and never claim pending commands succeeded', async t => {
  const f = await harness(t, { authenticated: true });
  f.ops.openRestart('host-1', 'duet'); assert.equal(f.get('restart-dialog').open, false);
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, true);
  assert.equal(f.calls.some(call => call.route === 'commands'), false);
  await f.ops.submitRestart();
  const calls = f.calls.filter(call => call.route === 'commands'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { hostId: 'host-1', serviceId: 'music', action: 'restart', requestId: 'a6020d81-72fe-4b0e-a4d9-cf24a8080f25' });
  assert.equal(calls[0].headers['X-CSRF-Token'], 'csrf-fixture'); assert.equal(f.get('restart-dialog').open, false);
  assert.match(f.get('toast').textContent, /请求已记录/); assert.doesNotMatch(f.get('toast').textContent, /成功/);
  await f.ops.submitRestart(); assert.equal(f.calls.filter(call => call.route === 'commands').length, 1);
});

test('a fresh degraded host retains actionable service and bot details without restarting planned stops', async t => {
  const data = snapshot(); data.hosts[0].state = 'down'; data.hosts[0].services[0].activeState = 'failed'; data.hosts[0].services[0].ok = false;
  data.hosts[0].services[1].restartAllowed = true;
  data.incidents.push({ id: 'i1', targetId: 'host-1', title: '服务故障', state: 'open', category: 'infra', openedAt: iso(0), notified: 'uncertain' });
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(data) : undefined });
  assert.equal(f.ops.hostState(data.hosts[0]).label, '异常');
  assert.equal(f.ops.serviceState(data.hosts[0].services[0], data.hosts[0]).label, '异常');
  assert.equal(f.ops.botState(data.hosts[0].bots[0], data.hosts[0]).label, '在线');
  f.ops.openRestart('host-1', 'duet'); assert.equal(f.get('restart-dialog').open, false);
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, true);
  assert.match(f.get('incident-list').innerHTML, /通知待确认/);
});

test('an ambiguous restart is not resent and maintenance failures do not update cached state', async t => {
  const f = await harness(t, { authenticated: true, fetch: call => ['commands', 'maintenance'].includes(call.route) ? response({ error: '执行结果未知' }, 503) : undefined });
  f.ops.openRestart('host-1', 'music'); await f.ops.submitRestart();
  assert.equal(f.get('restart-confirm').disabled, true); assert.match(f.get('restart-error').textContent, /未确认/);
  await f.ops.submitRestart(); assert.equal(f.calls.filter(call => call.route === 'commands').length, 1);
  await f.ops.changeMaintenance('monitor', 'web-1');
  assert.equal(f.ops.state.data.monitors[0].maintenance, false); assert.match(f.get('toast').textContent, /未知/);
  assert.equal(f.calls.find(call => call.route === 'maintenance').body.enabled, true);
});

test('only the exact restart request receipt clears its uncertain outcome', async t => {
  const raw = snapshot();
  raw.commands.push({ id: 'old-command', requestId: 'older-request', hostId: 'host-1', serviceId: 'music', status: 'succeeded', createdAt: iso(-120000) });
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw)
    : call.route === 'commands' ? response({ error: '回执未知' }, 503) : undefined });
  f.ops.openRestart('host-1', 'music'); await f.ops.submitRestart();
  await f.ops.loadSnapshot();
  assert.equal(f.ops.state.uncertainRestarts.has('host-1:music'), true);
  await f.get('restart-cancel').trigger('click'); f.ops.openRestart('host-1', 'music');
  assert.equal(f.get('restart-dialog').open, false);
  raw.commands.unshift({ id: 'current-command', requestId: f.calls.find(call => call.route === 'commands').body.requestId,
    hostId: 'host-1', serviceId: 'music', status: 'succeeded', createdAt: iso(0) });
  await f.ops.loadSnapshot();
  assert.equal(f.ops.state.uncertainRestarts.has('host-1:music'), false);
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, true);
});

test('maintenance needs a confirmed updated outcome and historical unknown commands do not override a later receipt', async t => {
  const raw = snapshot(); raw.commands = [
    { id: 'old', hostId: 'host-1', serviceId: 'music', status: 'unknown', createdAt: iso(-360000) },
    { id: 'new', hostId: 'host-1', serviceId: 'music', status: 'succeeded', createdAt: iso(-120000) },
  ];
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw)
    : call.route === 'maintenance' ? response({ updated: false }) : undefined });
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, true);
  await f.ops.changeMaintenance('host', 'host-1');
  assert.equal(f.ops.state.data.hosts[0].maintenance, false); assert.match(f.get('toast').textContent, /未确认/);
});

test('untrusted names, errors and URLs render as text while charts include only numeric coordinates', async t => {
  const raw = snapshot(); raw.hosts[0].name = '<img src=x onerror=alert(1)>'; raw.hosts[0].bots[0].lastError = '<script>secret()</script>';
  raw.monitors[0].url = 'javascript:alert(1)'; raw.monitors[0].error = '<img onerror=bad()>';
  raw.incidents.push({ id: 'i1', title: '<svg onload=bad()>', state: 'open', category: 'web', openedAt: iso(0) });
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw) : undefined });
  for (const id of ['host-list', 'bot-list', 'monitor-list', 'incident-list']) assert.doesNotMatch(f.get(id).innerHTML, /<img|<script|<svg onload|javascript:/);
  assert.match(f.get('host-list').innerHTML, /&lt;img/); assert.match(f.get('bot-list').innerHTML, /&lt;script/);
  assert.equal(f.ops.monitorLink('https://user:password@example.test/'), null);
  assert.equal(f.ops.monitorLink('https://example.test/health?token=secret').href, 'https://example.test/health');
  assert.doesNotMatch(f.ops.sparkline([{ cpuPercent: '" onload="bad' }], 'cpuPercent'), /onload|bad/);
});

test('automatic repair status and verified recovery history are read-only and distinct from manual restarts', async t => {
  const raw = snapshot(); raw.hosts[0].services[0].autoRepair = true;
  raw.autoRepair = { enabled: true, policy: { failureThreshold: 3, recoveryThreshold: 2, cooldownMs: 900000, maxAttemptsPerHour: 2 },
    states: [{ hostId: 'host-1', serviceId: 'music', phase: 'verifying', message: '重启完成，等待新采样。' },
      { hostId: 'host-1', serviceId: 'duet', phase: 'maintenance', message: '计划停用。' }],
    events: [{ hostId: 'host-1', serviceId: 'music', phase: 'recovered', title: '已确认恢复', message: '连续两次采样正常。', at: iso(-5000), notification: 'sent' }] };
  raw.commands = [{ hostId: 'host-1', serviceId: 'music', origin: 'auto', status: 'succeeded', reason: '连续三次异常', createdAt: iso(-10000) },
    { hostId: 'host-1', serviceId: 'music', status: 'succeeded', createdAt: iso(-30000) }];
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw) : undefined });
  const overview = f.get('notification-status').innerHTML, log = f.get('command-list').innerHTML;
  assert.match(overview, /自动修复/); assert.match(overview, /1 项处理中 · 0 项待确认/);
  assert.match(overview, /连续 3 次异常后重启，连续 2 次正常后确认恢复/);
  assert.match(overview, /间隔至少 15 分钟，每小时最多 2 次/);
  assert.match(log, /复核中/); assert.match(log, /已确认恢复/); assert.match(log, /连续三次异常/);
  assert.match(log, /重启已执行/); assert.match(log, /自动修复 ·/); assert.match(log, /手动重启 ·/);
  assert.match(f.get('host-list').innerHTML, /重启 0 次 · 自动修复/);
  assert.doesNotMatch(overview + log, /<button|<input/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('repair event fields are escaped and unknown phases or receipts stay unconfirmed', async t => {
  const raw = snapshot(); raw.autoRepair = { enabled: true, states: [null,
    { hostId: '<img src=x onerror=bad()>', serviceId: '<script>bad()</script>', phase: 'toString', message: '<img src=x>', nextAttemptAt: '<script>' }],
    events: [null, { hostId: 'host-1', serviceId: 'music', phase: '<svg onload=bad()>', title: '<script>bad()</script>',
      message: '<img src=x onerror=bad()>', notification: 'toString', at: 'invalid' }] };
  raw.commands = [{ hostId: 'host-1', serviceId: 'music', origin: 'auto', status: 'toString', reason: '<svg onload=bad()>', createdAt: iso(0) }];
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw) : undefined });
  const log = f.get('command-list').innerHTML;
  assert.match(log, /待确认/); assert.match(log, /通知待确认/); assert.match(log, /&lt;script&gt;/);
  assert.doesNotMatch(log, /<img|<script|<svg|已恢复|已通知/);
  assert.match(f.get('notification-status').innerHTML, /0 项处理中 · 1 项待确认/);
});

test('older snapshots without automatic repairs keep existing restart and notification views', async t => {
  const f = await harness(t, { authenticated: true });
  assert.doesNotMatch(f.get('command-list').innerHTML + f.get('notification-status').innerHTML, /自动修复|最近修复记录/);
  assert.match(f.get('command-list').innerHTML, /尚无操作记录/);
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, true);
});

test('a wall-clock rollback cannot turn old host data healthy again', async t => {
  const f = await harness(t, { authenticated: true }); f.document.hidden = true; await f.event('visibilitychange');
  f.setWall(NOW - 3600000); f.advance(151000, { changeWall: false });
  assert.equal(f.ops.hostState(snapshot().hosts[0]).state, 'unknown'); assert.equal(f.ops.monitorState(snapshot().monitors[0]).state, 'unknown');
});

test('late restart receipts retain their outcome without overriding a newer navigation choice', async t => {
  for (const navigation of ['hidden', 'another-view', 'hidden-and-returned', 'unchanged']) await t.test(navigation, async t => {
    const entered = deferred(), receipt = deferred(), navigations = [], raw = snapshot();
    const f = await harness(t, { authenticated: true, onView: view => navigations.push(view), fetch: call => {
      if (call.route === 'commands') { entered.resolve(); return receipt.promise; }
      if (call.route === 'snapshot') return response(raw);
    } });
    f.panel.show('hosts'); await settle(() => !f.ops.state.loading);
    f.ops.openRestart('host-1', 'music'); const pending = f.ops.submitRestart(); await entered.promise;
    if (navigation.startsWith('hidden')) f.panel.hide();
    if (navigation === 'hidden-and-returned' || navigation === 'another-view') { f.panel.show('bots'); await settle(() => !f.ops.state.loading); }
    const command = { id: 'late-command', hostId: 'host-1', serviceId: 'music', status: 'succeeded', createdAt: iso(0) };
    raw.commands = [command]; receipt.resolve(response({ command })); await pending;
    assert.deepEqual(navigations, navigation === 'unchanged' ? ['events'] : []);
    assert.equal(f.ops.state.view, navigation === 'unchanged' ? 'events' : navigation === 'hidden' ? 'hosts' : 'bots');
    assert.equal(f.ops.state.data.commands[0].status, 'succeeded'); assert.equal(f.ops.state.mutation, null);
    assert.equal(f.calls.filter(call => call.route === 'commands').length, 1);
    if (navigation === 'hidden') { f.panel.show('events'); await settle(() => !f.ops.state.loading); assert.match(f.get('command-list').innerHTML, /成功/); }
  });
});

test('a hidden restart whose receipt is uncertain stays protected from resubmission', async t => {
  const entered = deferred(), receipt = deferred(), navigations = [];
  const f = await harness(t, { authenticated: true, onView: view => navigations.push(view), fetch: call => {
    if (call.route === 'commands') { entered.resolve(); return receipt.promise; }
  } });
  f.ops.openRestart('host-1', 'music'); const pending = f.ops.submitRestart(); await entered.promise;
  f.panel.hide(); receipt.resolve(response({ error: '回执未知' }, 503)); await pending;
  assert.deepEqual(navigations, []); assert.equal(f.ops.state.uncertainRestarts.has('host-1:music'), true);
  f.panel.show('hosts'); await settle(() => !f.ops.state.loading);
  f.ops.openRestart('host-1', 'music'); assert.equal(f.get('restart-dialog').open, false);
});

test('degraded bot health is not counted or displayed as healthy playback, while old reports stay compatible', async t => {
  const raw = snapshot(), host = raw.hosts[0], music = host.bots[0];
  Object.assign(music, { health: 'degraded', transport: 'disconnected', playing: true, lastError: '语音连接中断' });
  const f = await harness(t, { authenticated: true, fetch: call => call.route === 'snapshot' ? response(raw) : undefined });
  assert.equal(f.ops.botState(music, host).state, 'degraded'); assert.equal(f.ops.botState(music, host).tone, 'bad');
  const html = f.get('bot-list').innerHTML;
  assert.match(html, /异常/); assert.match(html, /语音连接/); assert.match(html, /已断开/); assert.doesNotMatch(html, /正在播放|badge good/);
  assert.match(f.get('overview-stats').innerHTML, /<span>机器人<\/span>[\s\S]*?<strong class="stat-value">0<small>\/ 2/);
  assert.equal(f.ops.botState({ ...music, health: 'unknown' }, host).state, 'unknown');
  assert.equal(f.ops.botState({ ...music, state: 'stopped' }, host).label, '计划停用');
  assert.equal(f.ops.botState(music, host, NOW + 120001).state, 'unknown');
  const legacy = { ...music }; delete legacy.health;
  assert.equal(f.ops.botState(legacy, host).state, 'online');
  assert.equal(f.ops.botState({ ...music, health: 'healthy' }, host).tone, 'good');
});
