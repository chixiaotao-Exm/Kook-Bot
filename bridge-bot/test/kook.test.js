import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookSender, DeliveryError } from '../src/kook.js';

const messageId = '02f43956-814e-407b-9289-de7b9ba8c3f0';
const token = 'fixture-only-bot-token', channelId = '7887470271136485';
const notification = patch => ({ key: 'a'.repeat(64), kind: 'pr', title: 'PR #10 已打开',
  lines: ['仓库：chixiaotao-Exm/Kook-Bot', '作者：fixture-user'], theme: 'info',
  url: 'https://github.com/chixiaotao-Exm/Kook-Bot/pull/10', ...patch });
const success = () => Response.json({ code: 0, data: { msg_id: messageId } });
function fixture(fetchImpl = async () => success(), options = {}) {
  const calls = [];
  const send = createKookSender({ token, channelId, fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); }, ...options });
  return { calls, send };
}

test('sends one official plain-text card to its configured channel without quotes or original payloads', async () => {
  const f = fixture(); assert.deepEqual(await f.send(notification()), { messageId }); assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0], body = JSON.parse(init.body), cards = JSON.parse(body.content);
  assert.equal(url, 'https://www.kookapp.cn/api/v3/message/create'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Bot ${token}`); assert.equal(body.target_id, channelId); assert.equal(body.type, 10);
  assert.deepEqual(Object.keys(body).sort(), ['content', 'target_id', 'type']);
  assert.equal(cards.length, 1); assert.equal(cards[0].size, 'lg'); assert.equal(cards[0].theme, 'info');
  assert.deepEqual(cards[0].modules[0], { type: 'header', text: { type: 'plain-text', content: 'PR #10 已打开', emoji: false } });
  assert.ok(cards[0].modules.slice(1, -1).every(module => module.type === 'section' && module.text.type === 'plain-text'));
  const button = cards[0].modules.at(-1).elements[0];
  assert.equal(button.type, 'button'); assert.equal(button.click, 'link'); assert.equal(button.value, notification().url);
  assert.ok(Buffer.byteLength(init.body) <= 32768); assert.ok(body.content.length <= 8000);
});

test('sender defense removes secrets, mentions and directional/control characters', async () => {
  const f = fixture();
  await f.send(notification({ title: '@all (met)all(met) 发布\u202e', lines: [
    'sk-private_test_secret_123456 admin-private_test_secret_123456 1/YWJjZA==/MTIzNDU2Nzg5MA==',
    'Authorization: Bearer fixture-private-token password=private-value cookie=private-cookie',
    'ghp_private_fixture_secret_123456 github_pat_private_fixture_secret_123456 token="private secret with spaces"',
    '@everyone @here @全体成员 (rol)123456(rol) (chn)123456(chn) 控制\u0000正常',
  ] }));
  const body = JSON.parse(f.calls[0].init.body), visible = JSON.parse(body.content)[0].modules.slice(0, -1);
  assert.doesNotMatch(JSON.stringify(visible), /private|@all|@everyone|@here|@全体成员|\(met\)|\(rol\)|\(chn\)|123456|202e|0000/);
  assert.match(body.content, /已隐藏/); assert.match(body.content, /控制 正常/);
});

test('rejects malformed, oversized and extra payload fields before any request', async () => {
  const f = fixture();
  for (const input of [null, [], notification({ key: 'bad' }), notification({ kind: 'comment' }), notification({ theme: 'invisible' }),
    notification({ title: '' }), notification({ title: 'x'.repeat(101) }), notification({ title: '\ud800' }),
    notification({ lines: Array(9).fill('line') }), notification({ lines: ['x'.repeat(501)] }), notification({ lines: [null] }),
    notification({ lines: ['\ud800'] }), notification({ raw: { diff: 'private' } }), notification({ targetId: '9999999999' })]) {
    await assert.rejects(f.send(input), error => error instanceof DeliveryError && error.code === 'INVALID_NOTIFICATION' && error.delivery === 'rejected');
  }
  assert.equal(f.calls.length, 0);
  await f.send(notification({ title: '字'.repeat(100), lines: Array(8).fill('字'.repeat(500)) }));
  assert.equal(f.calls.length, 1); assert.ok(Buffer.byteLength(f.calls[0].init.body) < 32768);
});

test('links stay inside the configured GitHub repository without redirects, queries or encoded secrets', async () => {
  const f = fixture();
  for (const url of ['http://github.com/chixiaotao-Exm/Kook-Bot/pull/1', 'https://other.invalid/chixiaotao-Exm/Kook-Bot',
    'https://github.com/chixiaotao-Exm/Kook-Bot-other/pull/1', 'https://github.com/other/Kook-Bot/pull/1',
    'https://secret@github.com/chixiaotao-Exm/Kook-Bot', 'https://github.com/chixiaotao-Exm/Kook-Bot?token=private',
    'https://github.com/chixiaotao-Exm/Kook-Bot#secret', 'https://github.com:444/chixiaotao-Exm/Kook-Bot',
    'https://github.com/chixiaotao-Exm/Kook-Bot/%3Ftoken=private', 'https://github.com/chixiaotao-Exm/Kook-Bot/%5cother',
    'https://github.com/chixiaotao-Exm%2fKook-Bot/pull/1',
    'https://github.com/chixiaotao-Exm/Kook-Bot/sk-private_fixture_secret_123456',
    'https://github.com/chixiaotao-Exm/Kook-Bot/../../other/repository']) {
    await assert.rejects(f.send(notification({ url })), error => error.code === 'INVALID_NOTIFICATION');
  }
  assert.equal(f.calls.length, 0);
  for (const path of ['', '/pull/1', '/commit/abcdef1234', '/compare/abc...def', '/actions/runs/123']) {
    assert.deepEqual(await f.send(notification({ url: 'https://github.com/chixiaotao-Exm/Kook-Bot' + path })), { messageId });
  }
  const custom = fixture(undefined, { repository: 'example/approved' });
  await custom.send(notification({ url: 'https://github.com/example/approved/pull/1' }));
  await assert.rejects(custom.send(notification()), error => error.code === 'INVALID_NOTIFICATION');
});

test('only HTTP 429 supplies a bounded retry hint and no sender call retries itself', async () => {
  for (const [header, expected] of [[undefined, 15000], ['0', 15000], ['2', 15000], ['60', 60000], ['900', 300000], ['bad', 15000]]) {
    const f = fixture(async () => new Response('private error body', { status: 429, headers: header ? { 'Retry-After': header } : {} }));
    await assert.rejects(f.send(notification()), error => error.code === 'RATE_LIMITED' && error.delivery === 'rejected'
      && error.retryAfterMs === expected && !error.message.includes('private'));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(async () => new Response('', { status: 429, headers: { 'Retry-After': new Date(Date.now() + 60000).toUTCString() } }));
  await assert.rejects(f.send(notification()), error => error.retryAfterMs > 57000 && error.retryAfterMs <= 60000);
});

test('explicit 4xx/API rejection is terminal, while 5xx, redirects and network failures remain uncertain', async () => {
  for (const [reply, code, delivery] of [
    [() => new Response('private', { status: 400 }), 'REJECTED', 'rejected'],
    [() => new Response('private', { status: 401 }), 'REJECTED', 'rejected'],
    [() => new Response('private', { status: 403 }), 'REJECTED', 'rejected'],
    [() => Response.json({ code: 40000, message: 'private' }), 'REJECTED', 'rejected'],
    [() => Response.json({ code: 0, data: { msg_id: messageId } }, { status: 503 }), 'UPSTREAM', 'uncertain'],
    [() => new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }), 'REDIRECT', 'uncertain'],
    [() => { throw Error('private token https://other.invalid'); }, 'NETWORK', 'uncertain'],
  ]) {
    const f = fixture(reply);
    await assert.rejects(f.send(notification()), error => error.code === code && error.delivery === delivery
      && error.retryAfterMs === undefined && !/private|other.invalid/.test(error.message));
    assert.equal(f.calls.length, 1);
  }
});

test('invalid, oversized and missing receipts remain ambiguous without echoing any remote data', async () => {
  for (const reply of [() => new Response('private invalid json'), () => Response.json(null), () => Response.json([]),
    () => Response.json({ code: '0', data: { msg_id: messageId } }), () => Response.json({ code: 0, data: {} }),
    () => Response.json({ code: 0, data: { msg_id: 'private secret token' } }),
    () => new Response('x'.repeat(32769)), () => new Response('{}', { headers: { 'content-length': '32769' } }),
    () => new Response(new Uint8Array([255, 255]))]) {
    const f = fixture(reply);
    await assert.rejects(f.send(notification()), error => error.code === 'RESPONSE' && error.delivery === 'uncertain'
      && error.retryAfterMs === undefined && !/private|secret/.test(error.message));
    assert.equal(f.calls.length, 1);
  }
});

test('hard timeout bounds an uncooperative transport and a stalled response body', async () => {
  let requestSignal, resolveLate;
  const f = fixture(async (_url, init) => { requestSignal = init.signal; return new Promise(resolve => { resolveLate = resolve; }); }, { timeoutMs: 15 });
  await assert.rejects(f.send(notification()), error => error.code === 'TIMEOUT' && error.delivery === 'uncertain');
  assert.equal(requestSignal.aborted, true); assert.equal(f.calls.length, 1); resolveLate(success());
  let cancelled = false;
  const stalled = fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"code":0')); },
    cancel() { cancelled = true; },
  })), { timeoutMs: 15 });
  await assert.rejects(stalled.send(notification()), error => error.code === 'TIMEOUT' && error.delivery === 'uncertain');
  assert.equal(cancelled, true); assert.equal(stalled.calls.length, 1);
});

test('cancellation before dispatch sends nothing and in-flight cancellation never repeats a POST', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  await assert.rejects(f.send(notification(), { signal: controller.signal }), error => error.code === 'CANCELLED' && error.delivery === 'rejected');
  assert.equal(f.calls.length, 0);
  const active = new AbortController(); let requestSignal;
  const pending = fixture(async (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); });
  const sent = pending.send(notification(), { signal: active.signal }); active.abort();
  await assert.rejects(sent, error => error.code === 'CANCELLED' && error.delivery === 'uncertain');
  assert.equal(requestSignal.aborted, true); assert.equal(pending.calls.length, 1);
});

test('configuration errors fail without reflecting supplied credentials', () => {
  for (const patch of [{ token: 'private\r\nheader' }, { token: '' }, { channelId: 'not-a-channel' }, { timeoutMs: 0 },
    { timeoutMs: 60001 }, { repository: 'https://other.invalid' }, { repository: '../repo' }]) {
    assert.throws(() => createKookSender({ token, channelId, ...patch }), error => error.code === 'CONFIG' && !/private|other.invalid/.test(error.message));
  }
});
