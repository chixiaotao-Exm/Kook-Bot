import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuSender, KookMenuDeliveryError } from '../src/kook-menu.js';

const CHANNEL = '1234567890123456';
const MESSAGE = '09cac271-1111-2222-3333-123456789abc';
const SECRET = 'private-token-never-reflect';
const flush = () => new Promise(resolve => setImmediate(resolve));

function page(index = 0) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12);
  buffer.writeUInt32BE(1200, 16);
  buffer.writeUInt32BE(1800, 20);
  buffer[32] = index;
  return { buffer, width: 1200, height: 1800, title: `菜单分类 ${index + 1}` };
}

function json(data, code = 0, status = 200) {
  return new Response(JSON.stringify({ code, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('asset/create')
      ? json({ url: `https://img.kookapp.cn/assets/menu-${calls.length}.png` })
      : json({ msg_id: MESSAGE });
  };
  return { calls, fetchImpl };
}

function sender(overrides = {}) {
  return createMenuSender({ token: SECRET, channelIds: [CHANNEL], pages: [page()], ...overrides });
}

test('eight pages upload once each, then publish a single card with full-width page containers', async () => {
  const { calls, fetchImpl } = mockFetch();
  const send = sender({ pages: Array.from({ length: 8 }, (_, index) => page(index)), fetchImpl });
  assert.deepEqual(await send({ channelId: CHANNEL, replyMessageId: MESSAGE }), { messageId: MESSAGE });
  assert.equal(calls.length, 9);
  assert.ok(calls.every(call => call.options.method === 'POST' && call.options.redirect === 'error'));
  assert.ok(calls.every(call => call.options.headers.Authorization === `Bot ${SECRET}`));
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.equal(payload.target_id, CHANNEL);
  assert.equal(payload.quote, MESSAGE);
  assert.equal(payload.reply_msg_id, MESSAGE);
  assert.equal(payload.type, 10);
  const cards = JSON.parse(payload.content);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].size, 'lg');
  const containers = cards[0].modules.filter(module => module.type === 'container');
  assert.equal(containers.length, 8);
  assert.ok(containers.every(container => container.elements.length === 1 && container.elements[0].type === 'image'));
  assert.match(payload.content, /8\/8/);
  assert.match(payload.content, /点击图片查看原图/);
  assert.match(payload.content, /中西双语菜单/);
  assert.match(payload.content, /西班牙语原名/);
  assert.ok(!payload.content.includes('image-group'));
});

test('selected pages retain original numbering; repeated sends use cached uploads', async () => {
  const { calls, fetchImpl } = mockFetch();
  const send = sender({ pages: [page(0), page(1), page(2)], fetchImpl });
  await send({ channelId: CHANNEL, pageIndices: [2] });
  await send({ channelId: CHANNEL, pageIndices: [2] });
  assert.equal(calls.filter(call => call.url.endsWith('asset/create')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('message/create')).length, 2);
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.match(payload.content, /菜单分类 3 · 3\/3/);
  assert.equal(payload.quote, undefined);
  assert.equal(payload.reply_msg_id, undefined);
});

test('nine pages stay full width in one bounded card and the ice cream page can be selected alone', async () => {
  const { calls, fetchImpl } = mockFetch();
  const send = sender({ pages: Array.from({ length: 9 }, (_, index) => page(index)), fetchImpl });
  await send({ channelId: CHANNEL });
  assert.equal(calls.filter(call => call.url.endsWith('asset/create')).length, 9);
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.ok(payload.content.length <= 8000);
  const containers = JSON.parse(payload.content)[0].modules.filter(module => module.type === 'container');
  assert.equal(containers.length, 9);
  assert.ok(containers.every(container => container.elements.length === 1 && container.elements[0].type === 'image'));
  assert.match(payload.content, /9\/9/);
  await send({ channelId: CHANNEL, pageIndices: [8] });
  const selected = JSON.parse(calls.at(-1).options.body);
  assert.equal(JSON.parse(selected.content)[0].modules.filter(module => module.type === 'container').length, 1);
  assert.match(selected.content, /菜单分类 9 · 9\/9/);
  assert.equal(calls.filter(call => call.url.endsWith('asset/create')).length, 9);
});

test('nine individually bounded PNGs cannot exceed the total image byte budget', () => {
  const pages = Array.from({ length: 9 }, (_, index) => {
    const value = page(index);
    const buffer = Buffer.alloc(4 * 1024 * 1024 - 1);
    value.buffer.copy(buffer);
    return { ...value, buffer };
  });
  assert.throws(() => sender({ pages }), { code: 'INVALID_PAGES' });
});

test('upload cache expires after one hour and does not survive a backwards clock', async () => {
  const { calls, fetchImpl } = mockFetch();
  let clock = 100;
  const send = sender({ fetchImpl, now: () => clock });
  await send({ channelId: CHANNEL });
  clock += 3600000;
  await send({ channelId: CHANNEL });
  clock -= 1;
  await send({ channelId: CHANNEL });
  assert.equal(calls.filter(call => call.url.endsWith('asset/create')).length, 3);
});

test('configured page bytes, channel allowlist and selected indices are snapshotted', async () => {
  const original = page();
  const channelIds = [CHANNEL];
  const selected = [0];
  let uploadedBuffer;
  let resolveUpload;
  const send = sender({ pages: [original], channelIds, fetchImpl: async (url, options) => {
    if (url.endsWith('asset/create')) {
      uploadedBuffer = Buffer.from(await options.body.get('file').arrayBuffer());
      return new Promise(resolve => { resolveUpload = resolve; });
    }
    return json({ msg_id: MESSAGE });
  } });
  original.buffer.fill(0);
  channelIds.push('9999999999999999');
  const pending = send({ channelId: CHANNEL, pageIndices: selected });
  await flush();
  selected.push(999);
  resolveUpload(json({ url: 'https://img.kookapp.cn/assets/menu.png' }));
  await pending;
  assert.equal(uploadedBuffer[0], 137);
  await assert.rejects(send({ channelId: '9999999999999999' }), { code: 'CHANNEL_NOT_ALLOWED', delivery: 'not_sent' });
});

test('concurrent sends share upload and cancelling one does not abort the other', async () => {
  let resolveUpload, uploadSignal, uploads = 0, messages = 0;
  const send = sender({ fetchImpl: async (url, options) => {
    if (url.endsWith('asset/create')) {
      uploads += 1;
      uploadSignal = options.signal;
      return new Promise(resolve => { resolveUpload = resolve; });
    }
    messages += 1;
    return json({ msg_id: MESSAGE });
  } });
  const controller = new AbortController();
  const first = send({ channelId: CHANNEL }, { signal: controller.signal });
  const second = send({ channelId: CHANNEL });
  const cancelled = assert.rejects(first, { code: 'SEND_CANCELLED', delivery: 'not_sent' });
  controller.abort();
  await cancelled;
  assert.equal(uploadSignal.aborted, false);
  resolveUpload(json({ url: 'https://img.kookapp.cn/assets/menu.png' }));
  await second;
  assert.equal(uploads, 1);
  assert.equal(messages, 1);
});

test('cancelling an active message reports uncertain delivery and never retries', async () => {
  const controller = new AbortController();
  let messages = 0;
  const send = sender({ fetchImpl: async url => {
    if (url.endsWith('asset/create')) return json({ url: 'https://img.kookapp.cn/menu.png' });
    messages += 1;
    controller.abort();
    return new Promise(() => {});
  } });
  await assert.rejects(send({ channelId: CHANNEL }, { signal: controller.signal }), { code: 'SEND_INTERRUPTED', delivery: 'uncertain' });
  assert.equal(messages, 1);
});

test('pre-cancelled sends do not upload', async () => {
  const { calls, fetchImpl } = mockFetch();
  await assert.rejects(sender({ fetchImpl })({ channelId: CHANNEL }, { signal: AbortSignal.abort() }), { code: 'SEND_CANCELLED', delivery: 'not_sent' });
  assert.equal(calls.length, 0);
});

test('the absolute deadline stops an eight-page upload sequence before message publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploads = 0, messages = 0;
  const send = sender({ pages: Array.from({ length: 8 }, (_, index) => page(index)), fetchImpl: async url => {
    if (url.endsWith('asset/create')) {
      uploads += 1;
      return new Promise(resolve => setTimeout(() => resolve(json({ url: `https://img.kookapp.cn/page-${uploads}.png` })), 14000));
    }
    messages += 1;
    return json({ msg_id: MESSAGE });
  } });
  const completion = assert.rejects(send({ channelId: CHANNEL }), { code: 'MENU_TIMEOUT', delivery: 'not_sent' });
  for (let index = 0; index < 6; index += 1) { t.mock.timers.tick(14000); await flush(); }
  assert.equal(uploads, 7);
  t.mock.timers.tick(6000);
  await completion;
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(uploads, 7);
  assert.equal(messages, 0);
});

test('a stuck upload times out even when fetch ignores abort', async () => {
  let count = 0;
  const send = sender({ uploadTimeoutMs: 5, fetchImpl: () => { count += 1; return new Promise(() => {}); } });
  await assert.rejects(send({ channelId: CHANNEL }), { code: 'KOOK_UPLOAD_TIMEOUT', delivery: 'not_sent' });
  assert.equal(count, 1);
});

test('a stuck message times out with uncertain delivery and no automatic resend', async () => {
  let messages = 0;
  const send = sender({ requestTimeoutMs: 5, fetchImpl: async url => {
    if (url.endsWith('asset/create')) return json({ url: 'https://img.kookapp.cn/menu.png' });
    messages += 1;
    return new Promise(() => {});
  } });
  await assert.rejects(send({ channelId: CHANNEL }), { code: 'KOOK_SEND_TIMEOUT', delivery: 'uncertain' });
  assert.equal(messages, 1);
});

test('rejected uploads are not cached and do not send a partial menu', async () => {
  let uploads = 0, messages = 0;
  const send = sender({ fetchImpl: async url => {
    if (url.endsWith('asset/create')) {
      uploads += 1;
      return uploads === 1 ? json({ message: SECRET }, 40000) : json({ url: 'https://img.kookapp.cn/menu.png' });
    }
    messages += 1;
    return json({ msg_id: MESSAGE });
  } });
  await assert.rejects(send({ channelId: CHANNEL }), error => error.code === 'KOOK_UPLOAD_API' && error.delivery === 'not_sent' && !error.message.includes(SECRET));
  assert.equal(messages, 0);
  await send({ channelId: CHANNEL });
  assert.equal(uploads, 2);
  assert.equal(messages, 1);
});

for (const [label, response, code, delivery] of [
  ['API rejection', () => json({ message: SECRET }, 40000), 'KOOK_API', 'rejected'],
  ['HTTP 403', () => new Response(SECRET, { status: 403 }), 'KOOK_HTTP', 'rejected'],
  ['HTTP 502', () => new Response(SECRET, { status: 502 }), 'KOOK_HTTP', 'uncertain'],
  ['invalid JSON', () => new Response(SECRET), 'KOOK_RESPONSE', 'uncertain'],
  ['oversized body', () => new Response(SECRET.repeat(7000)), 'KOOK_RESPONSE', 'uncertain'],
  ['missing message ID', () => json({}), 'KOOK_RESPONSE', 'uncertain'],
  ['invalid message ID', () => json({ msg_id: 'bad\nmessage' }), 'KOOK_RESPONSE', 'uncertain'],
]) {
  test(`message ${label} is classified and sanitized without retry`, async () => {
    let messages = 0;
    const send = sender({ fetchImpl: async url => {
      if (url.endsWith('asset/create')) return json({ url: 'https://img.kookapp.cn/menu.png' });
      messages += 1;
      return response();
    } });
    await assert.rejects(send({ channelId: CHANNEL }), error => error instanceof KookMenuDeliveryError
      && error.code === code && error.delivery === delivery && !error.message.includes(SECRET));
    assert.equal(messages, 1);
  });
}

test('network exceptions cannot expose credentials', async () => {
  const send = sender({ fetchImpl: async url => {
    if (url.endsWith('asset/create')) return json({ url: 'https://img.kookapp.cn/menu.png' });
    throw new Error(`authorization=${SECRET}`);
  } });
  await assert.rejects(send({ channelId: CHANNEL }), error => error.code === 'KOOK_NETWORK' && error.delivery === 'uncertain' && !error.message.includes(SECRET));
});

test('only official HTTPS image URLs without credentials or query parameters are accepted', async () => {
  for (const url of ['http://img.kookapp.cn/a.png', 'https://kookapp.cn.evil.test/a.png', 'https://evil.test/a.png',
    'https://user:pass@img.kookapp.cn/a.png', 'https://img.kookapp.cn/a.png?secret=x', 'https://img.kookapp.cn/a.png#x',
    'https://img.kookapp.cn:8443/a.png', 'not-a-url']) {
    let count = 0;
    const send = sender({ fetchImpl: async () => { count += 1; return json({ url }); } });
    await assert.rejects(send({ channelId: CHANNEL }), { code: 'KOOK_UPLOAD_RESPONSE', delivery: 'not_sent' });
    assert.equal(count, 1);
  }
});

test('invalid authorization targets, reply IDs and selections fail before upload', async () => {
  const { calls, fetchImpl } = mockFetch();
  const send = sender({ fetchImpl });
  for (const input of [{ channelId: '99999999' }, { channelId: CHANNEL, replyMessageId: 'too-short' },
    { channelId: CHANNEL, pageIndices: [] }, { channelId: CHANNEL, pageIndices: [1] },
    { channelId: CHANNEL, pageIndices: [0, 0] }, { channelId: CHANNEL, pageIndices: [0.5] },
    { channelId: CHANNEL, pageIndices: '0' }]) {
    await assert.rejects(send(input), error => error.delivery === 'not_sent');
  }
  assert.equal(calls.length, 0);
});

test('invalid PNG signatures, dimensions, huge files and page counts fail configuration', () => {
  const wrongMagic = page(); wrongMagic.buffer[0] = 0;
  const wrongIhdr = page(); wrongIhdr.buffer.write('OTHER', 12);
  const wrongDimensions = page(); wrongDimensions.width += 1;
  const oversizedDimensions = page(); oversizedDimensions.width = 20000; oversizedDimensions.buffer.writeUInt32BE(20000, 16);
  const huge = page(); huge.buffer = Buffer.alloc(4 * 1024 * 1024);
  for (const pages of [[], Array.from({ length: 10 }, () => page()), [wrongMagic], [wrongIhdr], [wrongDimensions],
    [oversizedDimensions], [huge], [{ ...page(), title: 'bad\nlabel' }], [{ ...page(), buffer: 'data' }]]) {
    assert.throws(() => sender({ pages }), { code: 'INVALID_PAGES' });
  }
});
