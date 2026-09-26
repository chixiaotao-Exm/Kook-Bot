import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextSender } from '../src/kook-text.js';

const channelId = '4380882890465110', messageId = '09cac271-1111-2222-3333-123456789abc';
const json = value => new Response(JSON.stringify(value));
const input = { channelId, replyMessageId: messageId, text: '12 + 14 × 2 = 40' };
const sender = overrides => createTextSender({ token: 'private-token', channelIds: [channelId], ...overrides });

test('calculator sends only one official plain-text card, with original-message quote', async () => {
  const calls = [], channels = [channelId];
  const send = sender({ channelIds: channels, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ code: 0, data: { msg_id: messageId } });
  } });
  channels.push('1111111111');
  assert.deepEqual(await send({ ...input, text: '(met)all(met) **text**' }), { messageId });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  const payload = JSON.parse(calls[0].options.body), cards = JSON.parse(payload.content);
  assert.equal(payload.type, 10); assert.equal(payload.target_id, channelId);
  assert.equal(payload.quote, messageId); assert.equal(payload.reply_msg_id, messageId);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].modules.every(module => module.text.type === 'plain-text'));
  assert.equal(cards[0].modules[1].text.content, '(met)all(met) **text**');
  await assert.rejects(send({ ...input, channelId: '1111111111' }), { code: 'CHANNEL_NOT_ALLOWED' });
  assert.equal(calls.length, 1);
});

test('invalid destinations, quote IDs, empty or excessive text never reach KOOK', async () => {
  let calls = 0;
  const send = sender({ fetchImpl: async () => { calls++; } });
  for (const change of [{ channelId: '999999' }, { replyMessageId: 'not-a-message' }, { text: '' },
    { text: 'x'.repeat(2001) }, { text: 'secret\u0000content' }]) await assert.rejects(send({ ...input, ...change }));
  assert.equal(calls, 0);
  assert.throws(() => sender({ requestTimeoutMs: 10_001 }));
});

test('HTTP/API failures, invalid success and oversized responses are never retried or reflected', async () => {
  for (const fixture of [new Response('private-body', { status: 403 }), json({ code: 40000, message: 'private-body' }),
    json({ code: 0, data: { msg_id: 'bad' } }), new Response('a'.repeat(32 * 1024 + 1)),
    new Response('{}', { headers: { 'content-length': String(32 * 1024 + 1) } }),
    new Response('not-json')]) {
    let calls = 0;
    const send = sender({ fetchImpl: async () => { calls++; return fixture; } });
    await assert.rejects(send(input), error => {
      assert.ok(!error.message.includes('private')); return true;
    });
    assert.equal(calls, 1);
  }
});

test('absolute deadline bounds a fetch ignoring abort without retry', async () => {
  let calls = 0, signal;
  const send = sender({ requestTimeoutMs: 5, fetchImpl: async (_, options) => {
    calls++; signal = options.signal; await new Promise(() => {});
  } });
  await assert.rejects(send(input), { code: 'SEND_TIMEOUT', delivery: 'uncertain' });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('deadline covers a stalled response body and cancels it', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const send = sender({ requestTimeoutMs: 5, fetchImpl: async () => new Response(body) });
  await assert.rejects(send(input), { code: 'SEND_TIMEOUT' });
  assert.equal(cancelled, 1);
});

test('pre-aborted sends do not fetch; mid-flight abort cancels pending send', async () => {
  let calls = 0, signal, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const send = sender({ fetchImpl: async (_, options) => {
    calls++; signal = options.signal; entered(); await new Promise(() => {});
  } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(send(input, { signal: controller.signal }), { code: 'SEND_CANCELLED', delivery: 'not_sent' });
  assert.equal(calls, 0);
  const running = new AbortController(), pending = send(input, { signal: running.signal });
  await started; running.abort();
  await assert.rejects(pending, { code: 'SEND_CANCELLED', delivery: 'uncertain' });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
