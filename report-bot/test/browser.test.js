import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSubmitter } from '../src/browser.js';
import { CATEGORY, ORIGIN } from '../src/protocol.mjs';

const token = 'a'.repeat(64), sessionId = '12345678-1234-1234-1234-123456789abc';
const profile = { email: 'test@example.com', steam: '76561198000000000', nickname: 'Reporter', language: 'english', category: CATEGORY };
const draft = { player: 'Player_01', subject: '请求核查 Player_01', description: '请核查，不预先断定作弊。' };
const success = '<script>{"flash_messages":[{"type":"notice","title":"您的请求已成功提交。"}]}</script>';
const json = data => new Response(JSON.stringify(data));
function fixture(handler = () => undefined, options = {}) {
  const calls = [];
  const submit = createBrowserSubmitter(profile, true, { baseUrl: 'http://127.0.0.1:8191', token, ...options,
    fetchImpl: async (url, opts) => {
      assert.ok(url.startsWith('http://127.0.0.1:8191/')); assert.equal(opts.redirect, 'error');
      assert.equal(opts.headers.Authorization, 'Bearer ' + token);
      const body = JSON.parse(opts.body); calls.push({ url, body });
      const override = await handler(url, body, opts); if (override !== undefined) return override;
      if (url.endsWith('/prepare')) return json({ sessionId });
      if (url.endsWith('/close')) return json({ ok: true });
      assert.equal(body.sessionId, sessionId);
      if (body.method === 'GET') return json({ status: 200, url: ORIGIN + '/api/v2/help_center/sessions.json', body: '{"current_session":{"csrf_token":"new-token"}}' });
      return json({ status: 200, url: ORIGIN + '/hc/zh-cn', body: success });
    } });
  return { submit, calls, posts: () => calls.filter(c => c.body.method === 'POST') };
}

test('uses one private browser session, fresh CSRF, a single POST and closes afterward', async () => {
  const h = fixture(); assert.equal((await h.submit(draft)).kind, 'success');
  assert.equal(h.posts().length, 1);
  const form = new URLSearchParams(h.posts()[0].body.body);
  assert.equal(form.get('authenticity_token'), 'new-token'); assert.equal(form.get('request[custom_fields][5050432733209]'), draft.player);
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), ['/prepare', '/request', '/request', '/close']);
});

test('unavailable browser or invalid preflight session cannot send a report', async () => {
  for (const fail of ['prepare', 'csrf', 'abort']) {
    const h = fixture((url, body) => {
      if (fail === 'prepare' && url.endsWith('/prepare')) return new Response('unavailable', { status: 503 });
      if (fail === 'csrf' && body.method === 'GET') return json({ status: 403, url: body.url, body: 'challenge' });
    });
    const controller = new AbortController(); if (fail === 'abort') controller.abort();
    assert.equal((await h.submit(draft, { signal: controller.signal })).kind, 'not_sent');
    assert.equal(h.posts().length, 0);
  }
});

test('browser HTTP ok without exact official success evidence remains unknown', async () => {
  for (const answer of [
    { status: 200, url: ORIGIN + '/hc/zh-cn', body: 'FlareSolverr status ok' },
    { status: 0, url: ORIGIN + '/hc/zh-cn/requests', body: '' },
    { status: 200, url: ORIGIN + '/hc/zh-cn/requests', body: success },
    { status: 200, url: 'https://other.example/hc/zh-cn', body: success }
  ]) {
    const h = fixture((_url, body) => body.method === 'POST' ? json(answer) : undefined);
    assert.equal((await h.submit(draft)).kind, 'unknown'); assert.equal(h.posts().length, 1);
    assert.ok(h.calls.at(-1).url.endsWith('/close'));
  }
});

test('POST transport errors and deadlines remain unknown and never retry', async () => {
  for (const stalled of [false, true]) {
    const h = fixture((_url, body) => {
      if (body.method === 'POST') { if (stalled) return new Promise(() => {}); throw Error('private upstream detail'); }
    }, { requestTimeoutMs: 15 });
    const result = await h.submit(draft); assert.equal(result.kind, 'unknown');
    assert.doesNotMatch(result.message, /private/); assert.equal(h.posts().length, 1);
  }
});

test('prepare timeout cannot issue a late report and does not expose raw diagnostics', async () => {
  const h = fixture(url => url.endsWith('/prepare') ? new Promise(() => {}) : undefined, { prepareTimeoutMs: 10 });
  assert.equal((await h.submit(draft)).kind, 'not_sent'); assert.equal(h.posts().length, 0);
});

test('oversized responses, bad session IDs and untrusted adapter addresses are rejected', async () => {
  for (const prepared of [{ sessionId: '../other' }, { sessionId: 'x'.repeat(100) }]) {
    const h = fixture(url => url.endsWith('/prepare') ? json(prepared) : undefined);
    assert.equal((await h.submit(draft)).kind, 'not_sent'); assert.equal(h.posts().length, 0);
  }
  const h = fixture((_url, body) => body.method === 'POST' ? json({ status: 200, url: ORIGIN + '/hc/zh-cn', body: 'x'.repeat(512 * 1024 + 1) }) : undefined);
  assert.equal((await h.submit(draft)).kind, 'unknown'); assert.equal(h.posts().length, 1);
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1:8191/', 'http://user:pass@127.0.0.1:8191'])
    assert.throws(() => createBrowserSubmitter(profile, true, { baseUrl, token }));
});

test('preview mode performs no network activity', async () => {
  const submit = createBrowserSubmitter({}, false, { baseUrl: 'http://127.0.0.1:8191', token, fetchImpl: () => assert.fail('network') });
  assert.equal((await submit(draft)).kind, 'not_sent');
});

test('a temporarily busy cleanup is retried without repeating the official request', async () => {
  let closes = 0;
  const h = fixture(url => {
    if (url.endsWith('/close') && ++closes === 1) return new Response('{"error":"browser_busy"}', { status: 409 });
  }, { closeTimeoutMs: 1000 });
  assert.equal((await h.submit(draft)).kind, 'success');
  assert.equal(h.posts().length, 1); assert.equal(closes, 2);
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/close')).map(call => call.body.sessionId), [sessionId, sessionId]);
});
