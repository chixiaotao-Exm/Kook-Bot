import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookReply, KookReplyError } from '../src/kook-reply.js';

const targetId = '1234567890123456';
const replyMessageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sentId = '50974c-364c983fa6cb';
const input = { targetId, replyMessageId, content: '你好，我可以帮你。' };
const success = () => Response.json({ code: 0, data: { msg_id: sentId } });
function harness(options = {}) {
  const calls = [];
  return { calls, reply: createKookReply({ token: 'fixture-private-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return success(); }, ...options }) };
}
const sections = init => JSON.parse(JSON.parse(init.body).content)[0].modules.map(module => module.text);

test('sends a single fixed-endpoint card with official quote and first-reply credit fields', async () => {
  const h = harness(); assert.deepEqual(await h.reply(input), { messageId: sentId });
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bot fixture-private-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.target_id, targetId); assert.equal(body.type, 10);
  assert.equal(body.quote, replyMessageId); assert.equal(body.reply_msg_id, replyMessageId);
  assert.equal(body.temp_target_id, undefined);
  assert.deepEqual(sections(init), [{ type: 'plain-text', emoji: false, content: input.content }]);
});

test('AI mention markup, code and links remain plain text with no notification fields', async () => {
  const h = harness();
  const content = '(met)all(met) (met)here(met) (rol)123(rol) @everyone\n'
    + '```js\nconst x = "https://example.test";\n\tconsole.log(x);\n```';
  await h.reply({ ...input, content });
  const body = JSON.parse(h.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['content', 'quote', 'reply_msg_id', 'target_id', 'type']);
  assert.equal(sections(h.calls[0].init).map(part => part.content).join(''), content);
  assert.ok(sections(h.calls[0].init).every(part => part.type === 'plain-text' && part.emoji === false));
});

test('normalizes line endings and removes controls while preserving useful code whitespace', async () => {
  const h = harness(); await h.reply({ ...input, content: 'hello\r\n\tworld\u0000\u0001\u007F!' });
  assert.equal(sections(h.calls[0].init)[0].content, 'hello\n\tworld!');
});

test('bounds long and escape-heavy answers including serialized payload, without broken surrogate pairs', async () => {
  for (const content of ['中'.repeat(12000), '\\"\t\n'.repeat(6000), '🎶'.repeat(6000)]) {
    const h = harness(); await h.reply({ ...input, content });
    const { init } = h.calls[0], parts = sections(init), text = parts.map(part => part.content).join('');
    assert.ok(init.body.length <= 8000, `request ${init.body.length}`);
    assert.ok(text.length <= 6000);
    assert.match(text, /后续内容已截断/);
    assert.ok(parts.every(part => part.content.length <= 1800));
    assert.ok(parts.every(part => part.content.isWellFormed()));
    assert.ok(parts.length <= 4);
  }
});

test('rejects invalid identifiers or empty content before making any request', async () => {
  const h = harness();
  for (const patch of [{ targetId: 'https://evil.test' }, { targetId: 12345678 },
    { replyMessageId: 'arbitrary-reference' }, { replyMessageId: '\r\n' },
    { content: ' \u0000\u0001 ' }, { content: null }]) {
    await assert.rejects(h.reply({ ...input, ...patch }), { code: 'KOOK_INVALID_INPUT' });
  }
  assert.equal(h.calls.length, 0);
  assert.throws(() => createKookReply({ token: 'secret\r\nheader' }), { code: 'KOOK_INVALID_INPUT' });
});

test('HTTP rejection, API errors and network errors are sanitized and never retried', async () => {
  for (const [response, code] of [[() => new Response('private-token upstream detail', { status: 429 }), 'KOOK_RATE_LIMITED'],
    [() => new Response('private-token upstream detail', { status: 403 }), 'KOOK_REJECTED'],
    [() => Response.json({ code: 40000, message: 'private-token upstream detail' }), 'KOOK_REJECTED'],
    [() => { throw new Error('private-token https://private-url.test'); }, 'KOOK_NETWORK']]) {
    let calls = 0;
    const reply = createKookReply({ token: 'private-token', fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(reply(input), error => {
      assert.ok(error instanceof KookReplyError); assert.equal(error.code, code);
      assert.doesNotMatch(error.stack, /private-token|private-url|upstream detail/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('malformed, oversized and incomplete successes fail with no response content disclosure', async () => {
  for (const [response, code] of [[() => new Response('secret invalid json'), 'KOOK_INVALID_RESPONSE'],
    [() => Response.json({ code: 0, data: {} }), 'KOOK_INVALID_RESPONSE'],
    [() => Response.json({ code: 0, data: { msg_id: 'secret invalid id' } }), 'KOOK_INVALID_RESPONSE'],
    [() => new Response('secret', { headers: { 'content-length': '40000' } }), 'KOOK_RESPONSE_TOO_LARGE'],
    [() => new Response('s'.repeat(40000)), 'KOOK_RESPONSE_TOO_LARGE']]) {
    const h = harness({ fetchImpl: async () => response() });
    await assert.rejects(h.reply(input), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /secret/); return true;
    });
  }
});

test('timeout aborts an ambiguous in-flight send exactly once', async () => {
  let calls = 0, requestSignal;
  const h = harness({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    calls++; requestSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret aborted'))));
  } });
  await assert.rejects(h.reply(input), { code: 'KOOK_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
});

test('shutdown cancellation propagates and does not attempt already-aborted sends', async () => {
  const controller = new AbortController(); let calls = 0, requestSignal;
  const h = harness({ fetchImpl: async (_url, { signal }) => {
    calls++; requestSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret aborted'))));
  } });
  const send = h.reply({ ...input, signal: controller.signal }); controller.abort();
  await assert.rejects(send, { code: 'KOOK_ABORTED' });
  await assert.rejects(h.reply({ ...input, signal: controller.signal }), { code: 'KOOK_ABORTED' });
  assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
});

test('timeout remains in effect while response body is streaming', async () => {
  let signal;
  const h = harness({ timeoutMs: 10, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":0,"data":'));
      signal.addEventListener('abort', () => controller.error(new Error('secret response aborted')));
    } }));
  } });
  await assert.rejects(h.reply(input), { code: 'KOOK_TIMEOUT' });
  assert.equal(signal.aborted, true);
});
