import test from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration, createBrowserPool } from '../src/browser-pool.js';
import { CATEGORY, ORIGIN } from '../src/protocol.mjs';

const token = 'a'.repeat(64);
const baseUrls = [8191, 8192, 8193].map(port => `http://127.0.0.1:${port}`);
const profile = index => ({ email: 'reporter@example.com', steam: String(76561198000000000n + BigInt(index)),
  nickname: `Reporter_${index}`, language: 'english', category: CATEGORY });
const draft = { player: 'Player_01', subject: '请求核查 Player_01', description: '请核查玩家行为。' };
const success = '<script>{"flash_messages":[{"type":"notice","title":"您的请求已成功提交。"}]}</script>';
const json = data => new Response(JSON.stringify(data));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('configuration defaults to one worker and validates independent loopback endpoints', () => {
  assert.deepEqual(browserConfiguration({}), { baseUrls: [], concurrency: 1, pooled: false });
  assert.deepEqual(browserConfiguration({ REPORT_BROWSER_URL: baseUrls[0] }), { baseUrls: [baseUrls[0]], concurrency: 1, pooled: false });
  assert.deepEqual(browserConfiguration({ REPORT_BROWSER_URLS: baseUrls.join(', '), REPORT_BROWSER_URL: 'ignored', REPORT_CONCURRENCY: '3' }),
    { baseUrls, concurrency: 3, pooled: true });
  for (const raw of ['0', '5', '3.5', '03', 'NaN']) assert.throws(() => browserConfiguration({ REPORT_CONCURRENCY: raw }));
  for (const urls of [baseUrls[0] + ',' + baseUrls[0], baseUrls[0] + ',', 'https://example.com', 'http://localhost:8191',
    'http://127.0.0.1:8195', baseUrls[0] + '/', 'http://user:pass@127.0.0.1:8191', baseUrls[0] + '?secret=x'])
    assert.throws(() => browserConfiguration({ REPORT_BROWSER_URLS: urls }));
  assert.throws(() => browserConfiguration({ REPORT_BROWSER_URL: baseUrls[0], REPORT_CONCURRENCY: '2' }));
});

function fixture(options = {}) {
  const slots = baseUrls.map(() => ({ session: null, prepares: 0, posts: [], closes: 0 }));
  const calls = [], releases = [];
  const fetchImpl = async (url, request) => {
    const endpoint = new URL(url), index = Number(endpoint.port) - 8191, slot = slots[index];
    calls.push({ index, path: endpoint.pathname, method: request.method });
    if (endpoint.pathname === '/health') return json({ ok: true, available: slot.session === null });
    assert.equal(request.headers.Authorization, 'Bearer ' + token);
    const payload = JSON.parse(request.body);
    if (endpoint.pathname === '/prepare') {
      assert.equal(slot.session, null);
      slot.session = `12345678-1234-1234-1234-${String(++slot.prepares + index * 100).padStart(12, '0')}`;
      return json({ sessionId: slot.session });
    }
    assert.equal(payload.sessionId, slot.session);
    if (endpoint.pathname === '/close') {
      slot.closes++;
      if (options.stallClose?.()) return new Promise(() => {});
      slot.session = null; return json({ ok: true });
    }
    if (payload.method === 'GET') return json({ status: 200, url: payload.url,
      body: JSON.stringify({ current_session: { csrf_token: `token-${index}-${slot.prepares}` } }) });
    const body = new URLSearchParams(payload.body);
    assert.equal(body.get('authenticity_token'), `token-${index}-${slot.prepares}`);
    slot.posts.push(body);
    if (options.gatePosts) await new Promise(resolve => { releases[index] = resolve; });
    return json({ status: 200, url: ORIGIN + '/hc/zh-cn', body: success });
  };
  const pool = createBrowserPool({ baseUrls, token, enabled: true, fetchImpl, readyTimeoutMs: 40, pollIntervalMs: 1,
    probeTimeoutMs: 10, submitOptions: options.submitOptions });
  return { pool, slots, calls, releases };
}

test('three workers submit concurrently with independent sessions and profiles, each at most once', async () => {
  const h = fixture({ gatePosts: true });
  assert.deepEqual(await Promise.all(baseUrls.map((_, index) => h.pool.ready(index))), [true, true, true]);
  const pending = baseUrls.map((_, index) => h.pool.submit(draft, { profile: profile(index), workerIndex: index }));
  for (let i = 0; i < 20 && h.slots.some(slot => slot.posts.length === 0); i++) await tick();
  assert.ok(h.slots.every(slot => slot.posts.length === 1));
  assert.equal(new Set(h.slots.map(slot => slot.session)).size, 3);
  assert.equal(await h.pool.ready(0), false);
  assert.deepEqual(await h.pool.submit(draft, { profile: profile(9), workerIndex: 0 }), { kind: 'not_sent' });
  for (const index of [2, 0, 1]) h.releases[index]();
  assert.deepEqual((await Promise.all(pending)).map(result => result.kind), ['success', 'success', 'success']);
  h.slots.forEach((slot, index) => {
    assert.equal(slot.posts[0].get('request[custom_fields][4413697824537]'), profile(index).steam);
    assert.equal(slot.posts[0].get('request[custom_fields][4413716837017]'), profile(index).nickname);
    assert.equal(slot.closes, 1); assert.equal(slot.session, null);
  });
});

test('uncertain cleanup keeps a worker unavailable until its old browser is actually gone', async () => {
  let stalled = true;
  const h = fixture({ stallClose: () => stalled, submitOptions: { closeTimeoutMs: 5 } });
  assert.equal((await h.pool.submit(draft, { profile: profile(0), workerIndex: 0 })).kind, 'success');
  assert.notEqual(h.slots[0].session, null);
  assert.equal(await h.pool.ready(0), false);
  assert.equal(h.slots[0].prepares, 1); assert.equal(h.slots[0].posts.length, 1);
  h.slots[0].session = null; stalled = false;
  assert.equal(await h.pool.ready(0), true);
  assert.equal((await h.pool.submit(draft, { profile: profile(1), workerIndex: 0 })).kind, 'success');
  assert.equal(h.slots[0].prepares, 2); assert.equal(h.slots[0].posts.length, 2);
});

test('readiness polls only health and bounds hung responses without creating a session', async () => {
  for (const kind of ['busy', 'legacy', 'hung', 'oversized']) {
    let calls = 0;
    const pool = createBrowserPool({ baseUrls: [baseUrls[0]], token, enabled: true, readyTimeoutMs: 15, pollIntervalMs: 1, probeTimeoutMs: 5,
      fetchImpl: async (url, request) => {
        assert.equal(url, baseUrls[0] + '/health'); assert.equal(request.method, 'GET'); assert.equal(request.body, undefined); calls++;
        if (kind === 'hung') return new Promise(() => {});
        if (kind === 'oversized') return new Response('x'.repeat(2048));
        return json(kind === 'busy' ? { ok: true, available: false } : { ok: true });
      } });
    assert.equal(await pool.ready(0), false); assert.ok(calls >= 1);
  }
});

test('cancelled or disabled readiness and invalid worker indices cannot contact an adapter', async () => {
  const controller = new AbortController(); controller.abort();
  const pool = createBrowserPool({ baseUrls, token, enabled: true, fetchImpl: () => assert.fail('network') });
  assert.equal(await pool.ready(0, { signal: controller.signal }), false);
  await assert.rejects(pool.ready(3), /Invalid browser worker/);
  await assert.rejects(pool.submit(draft, { profile: profile(0), workerIndex: -1 }), /Invalid browser worker/);
  const disabled = createBrowserPool({ baseUrls, token, enabled: false, fetchImpl: () => assert.fail('network') });
  assert.equal(await disabled.ready(0), false);
  assert.equal((await disabled.submit(draft, { profile: {}, workerIndex: 0 })).kind, 'not_sent');
});
