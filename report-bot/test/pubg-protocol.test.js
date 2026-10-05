import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, FORM_ID, CATEGORY, FIELD, importProfile, buildBody, classifyResponse, validate, submitReport } from '../src/protocol.mjs';
import { createSubmitter, sessionFetch, checkOfficialSession } from '../src/pubg.js';

const profile = Object.freeze({ email: 'test+report@example.com', steam: '76561198000000000', nickname: 'Reporter_1', language: 'english', category: CATEGORY, subject: '请求核查 {player}' });
const draft = Object.freeze({ player: 'Player_123', subject: '请求核查玩家 Player_123', description: '请核实玩家行为。\n尚未提供对局证据，不预先断定违规。' });
const sessionUrl = ORIGIN + '/api/v2/help_center/sessions.json';
const submitUrl = ORIGIN + '/hc/zh-cn/requests';
const successHtml = '<script>window.HelpCenter={"flash_messages":[{"type":"notice","title":"您的请求已成功提交。"}]};</script>';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function response(url, body = '', status = 200, headers = {}) {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
function session(headers) { return response(sessionUrl, JSON.stringify({ current_session: { csrf_token: 'fresh-csrf-token' } }), 200, headers); }
function har(params = buildBody(profile, draft.player, draft.description, 'old-token')) {
  return { log: { entries: [{ request: { method: 'POST', url: submitUrl, headers: [{ name: 'Cookie', value: 'secret=old' }], postData: { mimeType: 'application/x-www-form-urlencoded;charset=UTF-8', text: params.toString() } } }] } };
}

test('body uses the fixed official form and report fields with UTF-8 and safe HTML escaping', () => {
  const body = buildBody(profile, draft.player, '<证据> & "原文" \'昵称\'\r\n下一行\r末行', 'new+token/=');
  const decoded = new URLSearchParams(body.toString());
  assert.equal(decoded.get('request[ticket_form_id]'), FORM_ID);
  assert.equal(decoded.get('request[custom_fields][5050432733209]'), draft.player);
  assert.equal(decoded.get('request[subject]'), '请求核查 Player_123');
  assert.equal(decoded.get('request[description]'), '<p>&lt;证据&gt; &amp; &quot;原文&quot; &#39;昵称&#39;<br>下一行<br>末行</p>');
  assert.equal(decoded.get('authenticity_token'), 'new+token/=');
  assert.equal(decoded.get(FIELD.email), 'test+report@example.com');
});

test('HAR import only retains the five reporter fields and decodes once', () => {
  const input = har(buildBody({ ...profile, nickname: '玩家+A%2B' }, draft.player, draft.description, 'old-csrf-token'));
  const result = importProfile(input);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(FIELD).sort());
  assert.equal(result.nickname, '玩家+A%2B');
  assert.equal(result.email, 'test+report@example.com');
  assert.doesNotMatch(JSON.stringify(result), /old-token|old-csrf|Cookie|证据|subject|description/);
});

test('HAR params variants preserve literal plus, percent and UTF-8', () => {
  for (const encoded of [false, true]) {
    const body = buildBody({ ...profile, nickname: '玩家+A%2B' }, draft.player, draft.description, 'unused');
    const input = har(body);
    input.log.entries[0].request.postData = { params: [...body].map(([name, value]) => ({ name: encoded ? encodeURIComponent(name) : name, value: encoded ? encodeURIComponent(value) : value })) };
    const imported = importProfile(input);
    assert.equal(imported.nickname, '玩家+A%2B');
    assert.equal(imported.email, profile.email);
  }
});

test('HAR rejects lookalike hosts, wrong form/category and duplicate identity fields', () => {
  const otherHost = har(); otherHost.log.entries[0].request.url = 'https://support.pubg.com.evil.test/hc/zh-cn/requests';
  assert.throws(() => importProfile(otherHost));
  for (const [key, value] of [['request[ticket_form_id]', '123'], [FIELD.category, 'other_category']]) {
    const params = buildBody(profile, draft.player, draft.description, 'token'); params.set(key, value);
    assert.throws(() => importProfile(har(params)));
  }
  const duplicate = buildBody(profile, draft.player, draft.description, 'token'); duplicate.append(FIELD.email, 'other@example.com');
  assert.throws(() => importProfile(har(duplicate)));
});

test('all caller controlled form fields are bounded and control characters rejected', () => {
  for (const changed of [
    { email: 'x'.repeat(300) + '@example.com' }, { steam: '123' }, { nickname: '\r\nspoof' },
    { nickname: 'x'.repeat(129) }, { language: 'english\n' }, { category: 'anything_else' }, { subject: 'x'.repeat(201) }
  ]) assert.throws(() => validate({ ...profile, ...changed }, draft.player, draft.description));
  assert.throws(() => validate(profile, 'Player\nSpoof', draft.description));
  assert.throws(() => validate(profile, draft.player, 'x'.repeat(12001)));
  assert.throws(() => buildBody(profile, draft.player, draft.description, 'csrf\ninvalid'));
});

test('success needs both the exact official flash notice and expected landing page', () => {
  assert.equal(classifyResponse(response(ORIGIN + '/hc/zh-cn'), successHtml).kind, 'success');
  assert.equal(classifyResponse(response(ORIGIN + '/hc/zh-cn/'), successHtml).kind, 'success');
  for (const [url, html, status] of [
    [submitUrl, successHtml, 200], [ORIGIN + '/hc/zh-cn', 'OK', 200],
    [ORIGIN + '/hc/zh-cn', successHtml.replace('notice', 'error'), 200],
    [ORIGIN + '/hc/zh-cn', successHtml, 500], ['https://example.com/hc/zh-cn', successHtml, 200]
  ]) assert.equal(classifyResponse(response(url, '', status), html).kind, 'unknown');
  assert.equal(classifyResponse(response(submitUrl, '', 403), '<h1>Verify</h1>').kind, 'verification');
  assert.equal(classifyResponse(response(submitUrl, '', 429), '').kind, 'unknown');
  assert.equal(classifyResponse({ status: 200, url: '' }, successHtml).kind, 'unknown');
});

test('fresh cookies survive the single POST and same-origin GET redirects', async () => {
  const calls = [];
  const submit = createSubmitter({ ...profile, cookie: 'old-secret', token: 'old-token' }, true, { fetchImpl: async (url, opts) => {
    calls.push({ url, ...opts });
    assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers.get('Authorization'), null);
    assert.doesNotMatch(opts.headers.get('Cookie') || '', /old-secret/);
    if (calls.length === 1) {
      assert.equal(url, sessionUrl); assert.equal(opts.method, 'GET');
      return session({ 'Set-Cookie': '_session=fresh; Path=/; HttpOnly; Secure' });
    }
    if (calls.length === 2) {
      assert.equal(url, submitUrl); assert.equal(opts.method, 'POST');
      assert.match(opts.headers.get('Cookie'), /_session=fresh/);
      assert.equal(new URLSearchParams(opts.body).get('authenticity_token'), 'fresh-csrf-token');
      assert.equal(opts.headers.get('Origin'), ORIGIN);
      return response(submitUrl, '', 302, { Location: '/hc/zh-cn', 'Set-Cookie': 'flash=success; Path=/; Secure' });
    }
    assert.equal(url, ORIGIN + '/hc/zh-cn'); assert.equal(opts.method, 'GET'); assert.equal(opts.body, undefined);
    assert.equal(opts.headers.get('Content-Type'), null);
    assert.match(opts.headers.get('Cookie'), /flash=success/);
    return response(url, successHtml);
  } });
  assert.equal((await submit(draft)).kind, 'success');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('separate attempts never reuse prior session cookies', async () => {
  let count = 0;
  const submit = createSubmitter(profile, true, { fetchImpl: async (url, opts) => {
    if (url === sessionUrl) { count++; assert.equal(opts.headers.get('Cookie'), null); return session({ 'Set-Cookie': 'session=' + count + '; Path=/; Secure' }); }
    assert.equal(opts.headers.get('Cookie'), 'session=' + count);
    return response(ORIGIN + '/hc/zh-cn', successHtml);
  } });
  assert.equal((await submit(draft)).kind, 'success');
  assert.equal((await submit(draft)).kind, 'success');
});

test('POST 307/308 never resends the report', async () => {
  for (const status of [307, 308]) {
    const calls = [];
    const submit = createSubmitter(profile, true, { fetchImpl: async (url, opts) => {
      calls.push(opts.method);
      return url === sessionUrl ? session() : response(url, '', status, { Location: '/hc/zh-cn/requests' });
    } });
    assert.equal((await submit(draft)).kind, 'unknown');
    assert.deepEqual(calls, ['GET', 'POST']);
  }
});

test('cross-origin redirect cannot receive cookies, body or even a GET', async () => {
  for (const duringPost of [false, true]) {
    const calls = [];
    const submit = createSubmitter(profile, true, { fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url === sessionUrl && duringPost) return session({ 'Set-Cookie': 'private=1; Path=/; Secure' });
      return response(url, '', 302, { Location: 'https://example.com/steal' });
    } });
    assert.equal((await submit(draft)).kind, duringPost ? 'unknown' : 'not_sent');
    assert.ok(calls.every(url => url.startsWith(ORIGIN + '/')));
    assert.equal(calls.length, duringPost ? 2 : 1);
  }
});

test('preflight rejection including verification, malformed token and huge body sends no POST', async () => {
  for (const result of [response(sessionUrl, 'challenge', 403), response(sessionUrl, 'slow', 429), response(sessionUrl, '{}'), response(sessionUrl, 'x'.repeat(32769))]) {
    const methods = [];
    const submit = createSubmitter(profile, true, { fetchImpl: async (_url, options) => { methods.push(options.method); return result; } });
    assert.equal((await submit(draft)).kind, 'not_sent');
    assert.deepEqual(methods, ['GET']);
  }
});

test('no HTTP errors after a POST are retried or misreported as not sent', async () => {
  for (const status of [403, 429, 500]) {
    const methods = [];
    const submit = createSubmitter(profile, true, { fetchImpl: async (url, opts) => {
      methods.push(opts.method); return url === sessionUrl ? session() : response(url, 'failed', status);
    } });
    const result = await submit(draft);
    assert.equal(result.kind, status === 403 ? 'verification' : 'unknown');
    assert.deepEqual(methods, ['GET', 'POST']);
    assert.match(result.message, /可能已送达/);
  }
});

test('cancelled before GET is not sent; cancellation after POST is unknown', async () => {
  const before = new AbortController(); before.abort(); let beforeCalls = 0;
  const noStart = createSubmitter(profile, true, { fetchImpl: async () => { beforeCalls++; return session(); } });
  assert.equal((await noStart(draft, { signal: before.signal })).kind, 'not_sent'); assert.equal(beforeCalls, 0);
  const after = new AbortController(); const calls = [];
  const started = createSubmitter(profile, true, { fetchImpl: async (url, opts) => {
    calls.push(opts.method); if (url === sessionUrl) return session();
    after.abort(); return new Promise(() => {});
  } });
  assert.equal((await started(draft, { signal: after.signal })).kind, 'unknown');
  assert.deepEqual(calls, ['GET', 'POST']);
});

test('abort during preflight prevents any later POST even if fetch ignores cancellation', async () => {
  const controller = new AbortController(); let calls = 0;
  const submit = createSubmitter(profile, true, { fetchImpl: async () => { calls++; controller.abort(); await delay(15); return session(); } });
  assert.equal((await submit(draft, { signal: controller.signal })).kind, 'not_sent');
  await delay(25); assert.equal(calls, 1);
});

test('timeout bounds fetch implementations that ignore AbortSignal', async () => {
  for (const atPost of [false, true]) {
    let calls = 0;
    const submit = createSubmitter(profile, true, { sessionTimeoutMs: 15, submitTimeoutMs: 15, fetchImpl: async url => {
      calls++; if (atPost && url === sessionUrl) return session(); return new Promise(() => {});
    } });
    assert.equal((await submit(draft)).kind, atPost ? 'unknown' : 'not_sent');
    assert.equal(calls, atPost ? 2 : 1);
  }
});

test('timeout also bounds stalled response body reads', async () => {
  for (const atPost of [false, true]) {
    const submit = createSubmitter(profile, true, { sessionTimeoutMs: 15, submitTimeoutMs: 15, fetchImpl: async url => {
      if (atPost && url === sessionUrl) return session();
      return { ok: true, status: 200, url, headers: new Headers(), text: () => new Promise(() => {}) };
    } });
    assert.equal((await submit(draft)).kind, atPost ? 'unknown' : 'not_sent');
  }
});

test('oversized chunked submission response is bounded and remains unknown', async () => {
  let cancelled = false;
  const submit = createSubmitter(profile, true, { fetchImpl: async url => {
    if (url === sessionUrl) return session();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; } });
    return response(ORIGIN + '/hc/zh-cn', stream);
  } });
  assert.equal((await submit(draft)).kind, 'unknown'); assert.equal(cancelled, true);
});

test('failed checkpoint or cancellation inside checkpoint prevents POST', async () => {
  const controller = new AbortController();
  for (const checkpoint of [async () => { throw new Error('Disk error with secret'); }, async () => controller.abort()]) {
    const calls = [];
    const result = await submitReport(profile, draft.player, draft.description, async (_url, opts) => { calls.push(opts.method); return session(); }, checkpoint, { signal: controller.signal });
    assert.equal(result.kind, 'not_sent'); assert.deepEqual(calls, ['GET']);
    assert.doesNotMatch(result.message, /Disk error|secret/);
  }
});

test('disabled mode allows missing profile; enabled mode fails before starting with generic diagnostics', async () => {
  assert.throws(() => createSubmitter({ email: 'private-invalid-secret' }, true), error => !error.message.includes('private-invalid-secret'));
  let calls = 0;
  const submit = createSubmitter({}, false, { fetchImpl: async () => calls++ });
  assert.equal((await submit(draft)).kind, 'not_sent'); assert.equal(calls, 0);
});

test('read-only readiness check sends only GET and never discloses session token', async () => {
  const calls = [];
  const result = await checkOfficialSession({ fetchImpl: async (url, opts) => { calls.push({ url, method: opts.method }); return session(); } });
  assert.deepEqual(result, { ok: true, kind: 'ready' });
  assert.deepEqual(calls, [{ url: sessionUrl, method: 'GET' }]);
  assert.doesNotMatch(JSON.stringify(result), /fresh-csrf/);
});

test('GET redirect cookies are reused; redirect loops are bounded', async () => {
  let count = 0;
  const fetcher = sessionFetch(async (url, opts) => {
    count++;
    if (count === 1) return response(url, '', 302, { Location: '/api/v2/help_center/sessions.json?next=1', 'Set-Cookie': 'challenge=passed; Path=/; Secure' });
    assert.equal(opts.headers.get('Cookie'), 'challenge=passed');
    return session();
  });
  assert.equal((await fetcher(sessionUrl)).status, 200); assert.equal(count, 2);
  count = 0;
  await assert.rejects(sessionFetch(async url => { count++; return response(url, '', 302, { Location: '/loop' }); })(sessionUrl));
  assert.equal(count, 6);
});
