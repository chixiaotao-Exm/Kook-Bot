import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookImageSender, KookImageDeliveryError } from '../src/kook-image-sender.js';

const token = 'PRIVATE_BOT_TOKEN';
const channelId = '9000000000000104';
const api = 'https://www.kookapp.cn/api/v3/';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const image = (overrides = {}) => ({ buffer: png, mimeType: 'image/png', width: 1, height: 1, ...overrides });
const json = (value, options = {}) => new Response(JSON.stringify(value), { status: 200, ...options });
const uploaded = (suffix = 'report.png') => json({ code: 0, data: { url: `https://img.kookapp.cn/attachments/${suffix}` } });
const sent = () => json({ code: 0, data: { msg_id: 'safe-message-id' } });
function sender(fetchImpl, extra = {}) { return createKookImageSender({ token, channelId, fetchImpl, ...extra }); }

test('uploads PNG multipart files and sends one uncropped image container with a clean dashboard link', async () => {
  const calls = [];
  const send = sender(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('asset/create') ? uploaded(`${calls.length}.png`) : sent();
  }, { dashboardUrl: 'https://api.example.com/quota/?secret=PRIVATE#PRIVATE' });
  assert.deepEqual(await send('PRIVATE_RAW_SUMMARY', { images: [image({ alt: 'PRIVATE_ALT', id: 'PRIVATE_ID' }), image()] }), { messageId: 'safe-message-id' });
  assert.deepEqual(calls.map(call => call.url), [`${api}asset/create`, `${api}asset/create`, `${api}message/create`]);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, `Bot ${token}`);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  for (const { options } of calls.slice(0, 2)) {
    assert.ok(options.body instanceof FormData);
    assert.equal(options.headers['Content-Type'], undefined, 'fetch must set its own multipart boundary');
    const file = options.body.get('file');
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    assert.equal([...options.body.keys()].join(','), 'file');
  }
  const message = JSON.parse(calls[2].options.body);
  assert.equal(message.type, 10); assert.equal(message.target_id, channelId);
  const cards = JSON.parse(message.content);
  assert.equal(cards.length, 1); assert.equal(cards[0].theme, 'invisible');
  assert.equal(cards[0].modules[0].type, 'container');
  assert.equal(cards[0].modules[0].elements.length, 2);
  const button = cards[0].modules[1].elements[0];
  assert.equal(button.click, 'link'); assert.equal(button.value, 'https://api.example.com/quota/');
  assert.doesNotMatch(message.content, /PRIVATE|secret|file:|data:/);
});

test('all images validate before any upload including byte signature, dimensions, MIME and total count', async () => {
  let calls = 0;
  const send = sender(async () => { calls++; return uploaded(); });
  const invalidSets = [
    undefined, [], Array.from({ length: 9 }, () => image()),
    [image({ buffer: Buffer.alloc(40) })], [image({ buffer: 'not bytes' })],
    [image({ mimeType: 'image/jpeg' })], [image({ width: 2 })], [image({ height: 0 })],
    [image(), image({ buffer: Buffer.alloc(4 * 1024 * 1024 + 1) })],
  ];
  for (const images of invalidSets) {
    await assert.rejects(send('report', { images }), error => error instanceof KookImageDeliveryError && error.code === 'INVALID_IMAGES' && error.delivery === 'not_sent');
  }
  assert.equal(calls, 0);
});

test('image bytes are snapshotted before asynchronous uploads', async () => {
  const second = Buffer.from(png);
  let calls = 0;
  const send = sender(async (url, options) => {
    calls++;
    if (calls === 1) second.fill(0);
    if (calls === 2) assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), png);
    return url.endsWith('asset/create') ? uploaded() : sent();
  });
  await send('report', { images: [image(), image({ buffer: second })] });
  assert.equal(calls, 3);
});

test('eight images use one message POST and no automatic retries', async () => {
  let uploads = 0, messages = 0;
  const send = sender(async url => {
    if (url.endsWith('asset/create')) { uploads++; return uploaded(); }
    messages++; return sent();
  });
  await send('report', { images: Array.from({ length: 8 }, () => image()) });
  assert.equal(uploads, 8); assert.equal(messages, 1);
});

test('second upload failure prevents any message and hides raw provider messages', async () => {
  let calls = 0;
  const send = sender(async () => {
    calls++;
    if (calls === 1) return uploaded();
    return json({ code: 40000, message: `${token} PRIVATE_KEY`, data: {} });
  });
  await assert.rejects(send('report', { images: [image(), image()] }), error => {
    assert.equal(error.code, 'KOOK_UPLOAD_API'); assert.equal(error.status, 40000); assert.equal(error.delivery, 'not_sent');
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /PRIVATE/);
    return true;
  });
  assert.equal(calls, 2);
});

test('official asset domains are accepted without re-downloading their content', async () => {
  for (const host of ['img.kookapp.cn', 'img.kaiheila.cn', 'img.kookapp.com']) {
    let calls = 0;
    const send = sender(async url => {
      calls++;
      return url.endsWith('asset/create') ? json({ code: 0, data: { url: `https://${host}/attachments/x.png` } }) : sent();
    });
    await send('report', { images: [image()] }); assert.equal(calls, 2);
  }
});

test('untrusted asset origins, credentials, query secrets, fragments and non-HTTPS fail before sending', async () => {
  for (const url of [
    'http://img.kookapp.cn/a.png', 'https://127.0.0.1/a.png', 'https://img.kookapp.cn.evil.test/a.png',
    'https://evilkookapp.cn/a.png', 'https://evil.test/a.png', 'https://img.kookapp.cn:8443/a.png',
    'https://private@img.kookapp.cn/a.png', 'https://img.kookapp.cn/a.png?key=PRIVATE',
    'https://img.kookapp.cn/a.png#PRIVATE', 'file:///private', 'data:image/png;base64,PRIVATE', null,
  ]) {
    let calls = 0;
    const send = sender(async () => { calls++; return json({ code: 0, data: { url } }); });
    await assert.rejects(send('report', { images: [image()] }), error => error.code === 'KOOK_UPLOAD_RESPONSE' && error.delivery === 'not_sent' && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('upload network and HTTP failures remain not_sent and are never retried', async () => {
  for (const [response, code, status] of [
    [() => { throw new Error(`${token} private network failure`); }, 'KOOK_UPLOAD_NETWORK', undefined],
    [() => new Response('PRIVATE', { status: 503 }), 'KOOK_UPLOAD_HTTP', 503],
    [() => new Response('PRIVATE', { status: 403 }), 'KOOK_UPLOAD_HTTP', 403],
  ]) {
    let calls = 0;
    const send = sender(async () => { calls++; return response(); });
    await assert.rejects(send('report', { images: [image()] }), error => error.code === code && error.delivery === 'not_sent' && error.status === status && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('missing, malformed and oversized upload responses never reach message/create', async () => {
  for (const response of [
    () => new Response('PRIVATE non JSON'), () => json({ code: '0', data: {} }),
    () => json({ code: 0 }), () => json({ code: 0, data: { url: 'https://img.kookapp.cn/a.png' } }, { headers: { 'content-length': '70000' } }),
    () => new Response(' '.repeat(65537)),
  ]) {
    let calls = 0;
    const send = sender(async () => { calls++; return response(); });
    await assert.rejects(send('report', { images: [image()] }), error => error.code === 'KOOK_UPLOAD_RESPONSE' && error.delivery === 'not_sent');
    assert.equal(calls, 1);
  }
});

test('message network failure, invalid response and 5xx are uncertain; explicit HTTP/API rejections are rejected', async () => {
  const cases = [
    [() => { throw new Error('PRIVATE'); }, 'KOOK_NETWORK', 'uncertain'],
    [() => new Response('PRIVATE', { status: 502 }), 'KOOK_HTTP', 'uncertain'],
    [() => new Response('PRIVATE', { status: 403 }), 'KOOK_HTTP', 'rejected'],
    [() => json({ code: 40000, message: 'PRIVATE' }), 'KOOK_API', 'rejected'],
    [() => json({ code: 0, data: {} }), 'KOOK_RESPONSE', 'uncertain'],
    [() => json({ code: 0, data: { msg_id: 'unsafe/private' } }), 'KOOK_RESPONSE', 'uncertain'],
    [() => new Response('PRIVATE'), 'KOOK_RESPONSE', 'uncertain'],
    [() => new Response(' '.repeat(65537)), 'KOOK_RESPONSE', 'uncertain'],
  ];
  for (const [response, code, delivery] of cases) {
    let messages = 0;
    const send = sender(async url => {
      if (url.endsWith('asset/create')) return uploaded();
      messages++; return response();
    });
    await assert.rejects(send('report', { images: [image()] }), error => error.code === code && error.delivery === delivery && !error.message.includes('PRIVATE'));
    assert.equal(messages, 1);
  }
});

test('aborting before uploads sends nothing', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const send = sender(async () => { calls++; return uploaded(); });
  await assert.rejects(send('report', { images: [image()], signal: controller.signal }), error => error.delivery === 'not_sent');
  assert.equal(calls, 0);
});

test('aborting after the last upload but before message dispatch sends nothing', async () => {
  const controller = new AbortController();
  let calls = 0;
  const send = sender(async () => {
    calls++;
    const response = uploaded();
    const original = response.body.getReader.bind(response.body);
    response.body.getReader = () => {
      const reader = original(), read = reader.read.bind(reader);
      reader.read = async () => { const value = await read(); if (value.done) controller.abort(); return value; };
      return reader;
    };
    return response;
  });
  await assert.rejects(send('report', { images: [image()], signal: controller.signal }), error => error.delivery === 'not_sent');
  assert.equal(calls, 1);
});

test('request timeouts cover ignored fetch cancellation and never proceed to message dispatch after an upload timeout', async () => {
  let calls = 0, finishUpload;
  const send = sender(async () => {
    calls++; return await new Promise(resolve => { finishUpload = resolve; });
  }, { requestTimeoutMs: 15 });
  await assert.rejects(send('report', { images: [image()] }), error => error.code === 'KOOK_UPLOAD_TIMEOUT' && error.delivery === 'not_sent');
  finishUpload(uploaded());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('timeout while reading an upload body cancels its reader and prevents sending', async () => {
  let cancelled = false, calls = 0;
  const send = sender(async () => {
    calls++;
    return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }));
  }, { requestTimeoutMs: 15 });
  await assert.rejects(send('report', { images: [image()] }), error => error.code === 'KOOK_UPLOAD_TIMEOUT' && error.delivery === 'not_sent');
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test('message dispatch timeout or caller cancellation is uncertain and never retries', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let messages = 0;
    const send = sender(async url => {
      if (url.endsWith('asset/create')) return uploaded();
      messages++;
      if (cancel) queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    }, { requestTimeoutMs: 15 });
    await assert.rejects(send('report', { images: [image()], signal: controller.signal }), error => error.delivery === 'uncertain' && (cancel ? error.code === 'SEND_INTERRUPTED' : error.code === 'KOOK_SEND_TIMEOUT'));
    assert.equal(messages, 1);
  }
});

test('constructor and summary validation do not expose private inputs', async () => {
  for (const options of [
    { token: '' }, { token: 'PRIVATE\r\n' }, { channelId: 'PRIVATE' },
    { requestTimeoutMs: 0 }, { dashboardUrl: 'https://PRIVATE@site.test' }, { dashboardUrl: 'file:///PRIVATE' },
  ]) assert.throws(() => createKookImageSender({ token, channelId, ...options }), error => !error.message.includes('PRIVATE'));
  let calls = 0;
  const send = sender(async () => { calls++; return uploaded(); });
  for (const value of ['', null, 'x'.repeat(12001)]) await assert.rejects(send(value, { images: [image()] }), error => error.code === 'INVALID_MESSAGE' && error.delivery === 'not_sent');
  assert.equal(calls, 0);
});
