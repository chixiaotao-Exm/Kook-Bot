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

test('search cards use bounded return-val buttons and plain text labels', async () => {
  const calls = [];
  const send = sender({ fetchImpl: async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) }); return json({ code: 0, data: { msg_id: messageId } });
  } });
  const buttons = [{ label: '上一页', value: 'menu-page:opaque-token:1' }, { label: '下一页', value: 'menu-page:opaque-token:3' }];
  await send({ ...input, title: '中文菜单 · 菜品搜索', buttons });
  const card = JSON.parse(calls[0].payload.content)[0];
  assert.equal(card.modules.length, 3);
  assert.equal(card.modules[0].text.content, '中文菜单 · 菜品搜索');
  assert.deepEqual(card.modules[2], { type: 'action-group', elements: buttons.map(button => ({
    type: 'button', theme: 'primary', click: 'return-val', value: button.value,
    text: { type: 'plain-text', content: button.label },
  })) });
  await send({ ...input, buttons: [] });
  assert.equal(JSON.parse(calls[1].payload.content)[0].modules.length, 2);
});

test('invalid pagination buttons are rejected for both create and update before network calls', async () => {
  let calls = 0;
  const send = sender({ fetchImpl: async () => { calls++; } });
  const next = { label: '下一页', value: 'menu-page:token:2' };
  const fixtures = [null, {}, new Array(1), [null], [next, next], [next, next, next],
    [{ ...next, label: '管理员操作' }], [{ ...next, value: 'https://evil.test' }],
    [{ ...next, value: 'menu-page:' }], [{ ...next, value: 'menu-page:fish\n' }],
    [{ ...next, value: 'menu-page:鱼' }], [{ ...next, value: `menu-page:${'x'.repeat(247)}` }],
    [next, { label: '上一页', value: next.value }]];
  for (const buttons of fixtures) {
    await assert.rejects(send({ ...input, buttons }), { code: 'INVALID_BUTTONS' });
    await assert.rejects(send.update({ channelId, messageId, text: input.text, buttons }), { code: 'INVALID_BUTTONS' });
  }
  assert.equal(calls, 0);
});

test('updates preserve the existing quote and accept the documented empty success data', async () => {
  const calls = [];
  for (const data of [[], {}, undefined]) {
    const send = sender({ fetchImpl: async (url, options) => {
      calls.push({ url, options }); return json({ code: 0, data });
    } });
    assert.deepEqual(await send.update({ channelId, messageId, text: '菜单搜索：鱼 · 第2/3页',
      buttons: [{ label: '下一页', value: 'menu-page:token:3' }],
      target_id: '999999', quote: '', replyMessageId: 'ignored' }), { messageId });
  }
  for (const call of calls) {
    assert.equal(call.url, 'https://www.kookapp.cn/api/v3/message/update');
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error');
    const payload = JSON.parse(call.options.body);
    assert.deepEqual(Object.keys(payload).sort(), ['content', 'msg_id']);
    assert.equal(payload.msg_id, messageId);
    assert.equal(JSON.parse(payload.content)[0].modules[0].text.content, '中文菜单 · 菜品搜索');
  }
});

test('updates retain channel allowlist, message, title and content validation', async () => {
  let calls = 0;
  const send = sender({ fetchImpl: async () => { calls++; } });
  const update = { channelId, messageId, text: 'menu page' };
  for (const change of [{ channelId: '999999' }, { channelId: undefined }, { messageId: 'bad' },
    { messageId: undefined }, { text: '' }, { text: 'x'.repeat(2001) }, { text: 'bad\0text' }, { title: 'untrusted title' }]) {
    await assert.rejects(send.update({ ...update, ...change }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(send.update(update, { signal: controller.signal }), { code: 'SEND_CANCELLED', delivery: 'not_sent' });
  assert.equal(calls, 0);
});

test('updates time out and API failures are not retried or leaked', async () => {
  const update = { channelId, messageId, text: 'page 2' };
  let calls = 0;
  const send = sender({ requestTimeoutMs: 5, fetchImpl: async () => { calls++; await new Promise(() => {}); } });
  await assert.rejects(send.update(update), { code: 'SEND_TIMEOUT', delivery: 'uncertain' });
  assert.equal(calls, 1);
  for (const fixture of [json({ code: 40000, message: 'private-body' }), new Response('private-body', { status: 403 }),
    json({ data: {} }), new Response('not-json')]) {
    calls = 0;
    const failing = sender({ fetchImpl: async () => { calls++; return fixture; } });
    await assert.rejects(failing.update(update), error => !error.message.includes('private'));
    assert.equal(calls, 1);
  }
});
