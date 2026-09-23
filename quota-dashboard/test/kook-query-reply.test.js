import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookQueryReply, KookQueryReplyError } from '../src/kook-query-reply.js';

const TOKEN = '1/test-fixture/token';
const KEY = 'sk-test_only_nonproduction_key_123456789';
const params = { channelType: 'GROUP', targetId: '1234567890123456', authorId: '1122334455', content: 'API Key sk-…6789\n今日 3 次 · 120 Token · $0.01' };
const json = (data = { code: 0, data: { msg_id: '50974c-364c983fa6cb', extra: KEY } }, status = 200, headers = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const make = fetchImpl => createKookQueryReply({ token: TOKEN, fetchImpl });

test('channel replies use one plain text card at fixed official endpoint and never quote or mention', async () => {
  const calls = [];
  const send = make(async (url, options) => { calls.push({ url, options }); return json(); });
  assert.deepEqual(await send(params), { messageId: '50974c-364c983fa6cb' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bot ${TOKEN}`);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['content', 'target_id', 'type']);
  assert.equal(body.target_id, params.targetId);
  assert.equal(body.type, 10);
  const [card] = JSON.parse(body.content);
  assert.equal(card.type, 'card');
  assert.deepEqual(card.modules, [{ type: 'section', text: { type: 'plain-text', content: params.content, emoji: false } }]);
});

test('private replies use target user ID, never the received target or chat code', async () => {
  await make(async (url, options) => {
    assert.equal(url, 'https://www.kookapp.cn/api/v3/direct-message/create');
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['content', 'target_id', 'type']);
    assert.equal(JSON.parse(options.body).target_id, params.authorId);
    return json();
  })({ ...params, channelType: 'PERSON', targetId: 'opaque-private-session', chatCode: 'unused' });
});

test('defense in depth removes unmasked credentials, controls and mention notation', async () => {
  await make(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(!body.content.includes(KEY));
    assert.ok(!body.content.includes('admin-1234567890abcdef1234'));
    assert.ok(!body.content.includes('(met)'));
    assert.ok(!body.content.includes('(rol)'));
    assert.ok(!body.content.includes('@everyone'));
    assert.ok(!body.content.includes('hidden-password'));
    assert.ok(body.content.includes('sk-…6789'));
    return json();
  })({ ...params, content: `${params.content}\n${KEY} admin-1234567890abcdef1234\n(met)all(met) (rol)55(rol) @everyone password=hidden-password\u202e` });
});

test('splits long text below the card element limit without splitting emoji pairs', async () => {
  const content = `${'文'.repeat(1799)}😀${'字'.repeat(1900)}`;
  await make(async (url, options) => {
    const modules = JSON.parse(JSON.parse(options.body).content)[0].modules;
    assert.equal(modules.map(item => item.text.content).join(''), content);
    assert.ok(modules.every(item => item.text.content.length <= 1800 && !/^[\uDC00-\uDFFF]/.test(item.text.content)));
    return json();
  })({ ...params, content });
});

test('invalid configuration and parameters fail before a network request', async () => {
  for (const token of [undefined, null, '', 'token\r\nkey', ' token', 'x'.repeat(513)]) {
    assert.throws(() => createKookQueryReply({ token }), error => error.code === 'CONFIG');
  }
  let calls = 0;
  const send = make(async () => { calls++; return json(); });
  for (const options of [{ channelType: 'OTHER' }, { targetId: '../somewhere' }, { targetId: 1234567890 },
    { content: '' }, { content: 'x'.repeat(3801) }, { content: null }, { signal: {} },
    { channelType: 'PERSON', authorId: 'bad-id' }]) {
    await assert.rejects(send({ ...params, ...options }), error => error.code === 'INPUT' && error.delivery === 'not_sent');
  }
  await assert.rejects(send({ ...params, signal: AbortSignal.abort() }), error => error.code === 'CANCELLED' && error.delivery === 'not_sent');
  assert.equal(calls, 0);
});

test('network, HTTP and API failures are fixed text and are never retried', async () => {
  for (const [fetchResult, code, delivery] of [
    [() => { throw new Error(KEY); }, 'NETWORK', 'uncertain'],
    [() => json({ message: KEY }, 429), 'HTTP', 'rejected'],
    [() => json({ message: KEY }, 500), 'HTTP', 'uncertain'],
    [() => json({ code: 40000, message: KEY }), 'API', 'rejected'],
    [() => json(KEY), 'RESPONSE', 'uncertain'],
    [() => json({ code: '0', data: { msg_id: 'abcd' } }), 'RESPONSE', 'uncertain'],
    [() => json({ code: 0, data: { msg_id: KEY } }), 'RESPONSE', 'uncertain'],
  ]) {
    let calls = 0;
    await assert.rejects(make(async () => { calls++; return fetchResult(); })(params), error => {
      assert.ok(error instanceof KookQueryReplyError);
      assert.equal(error.code, code);
      assert.equal(error.delivery, delivery);
      assert.ok(!JSON.stringify(error).includes(KEY));
      assert.ok(!error.message.includes(KEY));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('oversized and streaming responses are bounded', async () => {
  for (const result of [() => json({}, 200, { 'content-length': '65537' }), () => json('x'.repeat(65537)),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(33000)); controller.enqueue(new Uint8Array(33000)); controller.close();
    } }))]) {
    await assert.rejects(make(async () => result())(params), error => error.code === 'RESPONSE');
  }
});

test('caller cancellation bounds an uncooperative transport and aborts its signal', async () => {
  const controller = new AbortController();
  let requestSignal, called = 0;
  const pending = make(async (url, options) => { called++; requestSignal = options.signal; return new Promise(() => {}); })({ ...params, signal: controller.signal });
  controller.abort(new Error(KEY));
  await assert.rejects(pending, error => error.code === 'CANCELLED' && !error.message.includes(KEY));
  assert.equal(requestSignal.aborted, true);
  assert.equal(called, 1);
});

test('ten second deadline also bounds a stalled body and never retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal, calls = 0;
  const pending = make(async (url, options) => {
    calls++; requestSignal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  })(params);
  await Promise.resolve();
  t.mock.timers.tick(9999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, error => error.code === 'TIMEOUT');
  assert.equal(requestSignal.aborted, true);
  assert.equal(calls, 1);
});
