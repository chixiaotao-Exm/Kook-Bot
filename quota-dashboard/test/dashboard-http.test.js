import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Dashboard } from '../src/dashboard.js';
import { AdminAuth } from '../src/auth.js';
import { QuotaServer } from '../src/server.js';
import { BroadcastScheduler } from '../src/broadcast.js';

async function fixture(t, { publicAccess = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota-http-')); let now = Date.now(), fail = false, calls = 0, sent = 0;
  const accounts = [{ id: '1', name: 'Example', platform: 'openai', type: 'oauth', status: 'active', freshness: 'fresh', observedAt: new Date(now).toISOString(), metrics: [
    { key: '7d', label: '7d', kind: 'percent', scope: 'upstream', usedPercent: 13, remainingPercent: 87, freshness: 'fresh', observedAt: new Date(now).toISOString(), resetAt: new Date(now + 86400000).toISOString() },
  ] }];
  const dashboard = await new Dashboard({ client: { async refresh() { calls++; if (fail) throw new Error('secret admin-key network failure'); return { accounts: structuredClone(accounts), checkedAt: new Date(now).toISOString() }; } }, dataDir: dir, now: () => now }).init();
  await dashboard.refresh();
  const scheduler = new BroadcastScheduler({ dataDir: dir, getSnapshot: () => dashboard.snapshot(), now: () => now, send: async () => { sent++; return { messageId: 'fixture' }; } }); await scheduler.init();
  const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, email: 'admin@example.test' })).toString('base64url') + '.signature';
  const upstream = [];
  const auth = new AdminAuth({ baseUrl: 'http://localhost:8080', now: () => now, fetchImpl: async (url, options) => {
    upstream.push({ pathname: new URL(url).pathname, headers: options.headers });
    if (new URL(url).pathname === '/api/v1/auth/login') return Response.json({ code: 0, data: { access_token: jwt } });
    if (options.headers.Authorization !== `Bearer ${jwt}`) return Response.json({ message: 'secret private upstream response' }, { status: 403 });
    return Response.json({ code: 0, data: { items: [{ credentials: { secret: 'MUST_NOT_RETURN' } }] } });
  } });
  const web = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://localhost:8080', dashboard, scheduler, auth, publicAccess, reporter: { botName: 'Bot', channelName: 'Reports', channelId: '123' } });
  const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  const jar = new Map(); let csrf;
  async function request(route, data, headers = {}) {
    const response = await fetch(base + '/quota/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); jar.set(name, value); }
    const body = await response.json(); if (body.csrf) csrf = body.csrf;
    return { response, body };
  }
  t.after(async () => { await web.close(); dashboard.close(); await scheduler.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('quota-http-')); await rm(dir, { recursive: true, force: true }); });
  return { dir, dashboard, scheduler, auth, request, jwt, jar, upstream, now: () => now, advance: (ms) => { now += ms; }, fail: () => { fail = true; }, calls: () => calls, sent: () => sent };
}

test('dashboard requires verified sub2api admin, same-origin CSRF and a rotated private session', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/status')).response.status, 401);
  const first = await f.request('/session'); assert.equal(first.body.authenticated, false); assert.ok(first.body.csrf);
  assert.match(first.response.headers.get('set-cookie'), /HttpOnly.*Path=\/quota\//);
  const oldCookie = `quota_session=${f.jar.get('quota_session')}`, oldCsrf = first.body.csrf;
  assert.equal((await f.request('/login', { token: f.jwt }, { 'X-CSRF-Token': 'wrong' })).response.status, 403);
  assert.equal((await f.request('/login', { token: f.jwt }, { Origin: 'https://other.invalid' })).response.status, 403);
  assert.equal((await f.request('/login', { token: 'member-token' })).response.status, 401);
  const loggedIn = await f.request('/login', { token: f.jwt }); assert.equal(loggedIn.response.status, 200); assert.notEqual(loggedIn.body.csrf, oldCsrf);
  assert.equal(JSON.stringify(loggedIn.body).includes(f.jwt), false);
  assert.equal((await f.request('/status', undefined, { Cookie: oldCookie })).response.status, 401);
  const snapshot = await f.request('/status'); assert.equal(snapshot.body.accounts[0].metrics[0].usedPercent, 13);
  assert.equal(JSON.stringify(snapshot.body).includes('MUST_NOT_RETURN'), false);
  assert.equal((await f.request('/logout', {})).response.status, 200); assert.equal((await f.request('/status')).response.status, 401);
});

test('public access exposes quota reads and bounded refresh without granting scheduler administration', async (t) => {
  const f = await fixture(t, { publicAccess: true });
  for (const route of ['/status', '/report-config', '/reports', '/report-preview']) assert.equal((await f.request(route)).response.status, 200, route);
  assert.equal(f.upstream.length, 0, 'Public reads do not validate or acquire administrator tokens');
  assert.equal((await f.request('/refresh', {})).response.status, 200);
  assert.equal((await f.request('/refresh', {}, { Origin: 'https://other.invalid' })).response.status, 403);
  const settings = { enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' };
  assert.equal((await f.request('/report-config', settings)).response.status, 401);
  const session = await f.request('/session'); assert.equal(session.body.publicAccess, true); assert.equal(session.body.canManage, false); assert.equal(session.body.authenticated, false);
  assert.equal((await f.request('/report-config', { ...settings, authenticated: true, canManage: true })).response.status, 401);
  assert.equal(f.scheduler.snapshot().enabled, false); assert.equal(f.sent(), 0);
  const loggedIn = await f.request('/login', { token: f.jwt }); assert.equal(loggedIn.body.canManage, true); assert.equal(loggedIn.body.publicAccess, true);
  assert.equal((await f.request('/report-config', settings)).response.status, 200);
  assert.equal((await f.request('/logout', {})).response.status, 200);
  assert.equal((await f.request('/status')).response.status, 200); assert.equal((await f.request('/report-config', settings)).response.status, 401);
  assert.equal(f.sent(), 0);
});

test('report preview and configuration never send immediately; no manual send route exists', async (t) => {
  const f = await fixture(t); await f.request('/session'); await f.request('/login', { email: 'admin@example.test', password: 'fixture-password' });
  const config = await f.request('/report-config', { enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' }); assert.equal(config.body.enabled, true);
  const preview = await f.request('/report-preview'); assert.match(preview.body.text, /Example/); assert.equal(f.sent(), 0);
  assert.equal((await f.request('/send', {})).response.status, 404); assert.equal(f.sent(), 0);
  const file = await readFile(path.join(f.dir, 'broadcast.json'), 'utf8'); assert.equal(file.includes(f.jwt), false);
});

test('failed quota refresh preserves previous values with explicit age and sanitized failure', async (t) => {
  const f = await fixture(t); f.advance(20000); f.fail();
  const snapshot = await f.dashboard.refresh({ force: true }); assert.equal(snapshot.accounts[0].metrics[0].usedPercent, 13); assert.equal(snapshot.stale, true);
  assert.equal(snapshot.accounts[0].freshness, 'stale'); assert.ok(snapshot.lastError); assert.equal(snapshot.lastError.includes('secret'), false);
  await f.dashboard.refresh({ force: true }); assert.equal(f.calls(), 2, 'Rapid refreshes are bounded');
});

test('default automatic collection waits ten minutes and reports that interval to browsers', async t => {
  const f = await fixture(t, { publicAccess: true });
  assert.equal((await f.request('/status')).body.refreshIntervalMs, 600000);
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.dashboard.start(); f.advance(599999); t.mock.timers.tick(599999);
  assert.equal(f.calls(), 1);
  f.advance(1); t.mock.timers.tick(1); await f.dashboard.pending;
  assert.equal(f.calls(), 2);
  f.advance(600000); t.mock.timers.tick(600000); await f.dashboard.pending;
  assert.equal(f.calls(), 3); f.dashboard.close();
});

test('malformed saved snapshots cannot break live startup or expose unvalidated fields', async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.dir, 'snapshot.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), accounts: [{ id: '1', name: 'bad', metrics: null }] }));
  const next = await new Dashboard({ client: { refresh: async () => { throw new Error('offline'); } }, dataDir: f.dir }).init();
  assert.equal(next.snapshot().accounts.length, 0); assert.ok(next.snapshot().storageError); await next.refresh(); assert.ok(next.snapshot().lastError); next.close();
});

test('cached quota expiry also invalidates cost forecasts and reset-card availability', async (t) => {
  const f = await fixture(t), account = f.dashboard.data.accounts[0];
  account.metrics[0].resetAt = new Date(f.now() + 60000).toISOString();
  account.windowStats = [{ key: '7d', metricKey: '7d', complete: true, observedAt: new Date(f.now()).toISOString(), accountCost: 13, estimatedTotalCost: 100 }];
  account.resetCredits = { cachedCount: 1, availableCount: 1, checkedAt: new Date(f.now()).toISOString(), expiresAt: [new Date(f.now() + 60000).toISOString()], freshness: 'fresh' };
  f.advance(120000);
  const snapshot = f.dashboard.snapshot().accounts[0];
  assert.equal(snapshot.metrics[0].freshness, 'stale'); assert.equal(snapshot.windowStats[0].estimatedTotalCost, null);
  assert.equal(snapshot.windowStats[0].accountCost, 13); assert.equal(snapshot.resetCredits.availableCount, null); assert.equal(snapshot.resetCredits.cachedCount, 1);
  assert.equal(snapshot.resetCredits.freshness, 'stale');
});
