import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createKookReply, KookReplyError } from '../src/kook-reply.js';

const targetId = '1234567890123456';
const replyMessageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sentId = '50974c-364c983fa6cb';
const input = { targetId, replyMessageId, content: '你好，我可以帮你。' };
const success = () => Response.json({ code: 0, data: { msg_id: sentId } });
const assetSuccess = () => Response.json({ code: 0, data: { url: 'https://img.kookapp.cn/attachments/fixture.svg' } });
function harness(options = {}) {
  const calls = [];
  return { calls, reply: createKookReply({ token: 'fixture-private-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return String(url).endsWith('/asset/create') ? assetSuccess() : success(); }, ...options }) };
}
const sections = init => JSON.parse(JSON.parse(init.body).content)[0].modules.map(module => module.text);
async function zipSource(file, expectedName) {
  assert.equal(file.type, 'application/zip');
  const buffer = Buffer.from(await file.arrayBuffer());
  assert.ok(buffer.length <= 256 * 1024);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50); assert.equal(buffer.readUInt16LE(8), 0);
  assert.equal(buffer.readUInt16LE(6), 0); assert.equal(buffer.readUInt16LE(28), 0);
  const nameLength = buffer.readUInt16LE(26), size = buffer.readUInt32LE(22);
  assert.equal(buffer.readUInt32LE(18), size);
  assert.equal(buffer.subarray(30, 30 + nameLength).toString('ascii'), expectedName);
  const data = buffer.subarray(30 + nameLength, 30 + nameLength + size);
  assert.equal(buffer.readUInt32LE(14), crc32(data));
  const central = 30 + nameLength + size;
  assert.equal(buffer.readUInt32LE(central), 0x02014b50);
  assert.equal(buffer.readUInt16LE(central + 10), 0);
  assert.equal(buffer.readUInt32LE(central + 16), crc32(data));
  assert.equal(buffer.readUInt32LE(central + 20), size); assert.equal(buffer.readUInt32LE(central + 24), size);
  assert.equal(buffer.readUInt32LE(central + 42), 0);
  assert.equal(buffer.subarray(central + 46, central + 46 + nameLength).toString('ascii'), expectedName);
  const end = central + 46 + nameLength;
  assert.equal(buffer.length, end + 22); assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 8), 1); assert.equal(buffer.readUInt16LE(end + 10), 1);
  assert.equal(buffer.readUInt32LE(end + 12), 46 + nameLength);
  assert.equal(buffer.readUInt32LE(end + 16), central);
  return data.toString('utf8');
}

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

test('preserves long and escape-heavy answers exactly as text attachments', async () => {
  for (const content of ['中'.repeat(12000), '\\"\t\n'.repeat(1200), '🎶'.repeat(6000)]) {
    const h = harness(); const result = await h.reply({ ...input, content });
    assert.deepEqual(result, { messageId: sentId, attachmentType: 'text' });
    assert.equal(h.calls.length, 2);
    const file = h.calls[0].init.body.get('file');
    assert.equal(file.name, 'answer.zip'); assert.equal(await zipSource(file, 'answer.txt'), content);
    assert.ok(h.calls[1].init.body.length <= 8000);
    const body = JSON.parse(h.calls[1].init.body), modules = JSON.parse(body.content)[0].modules;
    assert.equal(body.quote, replyMessageId); assert.equal(body.reply_msg_id, replyMessageId);
    assert.deepEqual(modules.at(-1), { type: 'file', src: 'https://img.kookapp.cn/attachments/fixture.svg', title: 'answer.zip' });
  }
});

test('uploads one complete static SVG as exact source even for a short fenced answer', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><text x="1" y="12">Hello &amp; goodbye</text></svg>';
  for (const content of [svg, `这是生成的图案。\n\n\`\`\`svg\n${svg}\n\`\`\`\n下载后可自行编辑。`]) {
    const h = harness();
    assert.deepEqual(await h.reply({ ...input, content }), { messageId: sentId, attachmentType: 'svg' });
    const file = h.calls[0].init.body.get('file');
    assert.equal(file.name, 'drawing.zip'); assert.equal(await zipSource(file, 'drawing.svg'), svg);
    assert.equal(h.calls[0].init.headers['Content-Type'], undefined);
    assert.equal(h.calls[0].init.headers.Authorization, 'Bot fixture-private-token');
    assert.equal(h.calls[0].init.method, 'POST'); assert.equal(h.calls[0].init.redirect, 'error');
    assert.equal(JSON.parse(JSON.parse(h.calls[1].init.body).content)[0].modules.at(-1).title, 'drawing.zip');
  }
});

test('partial, multiple, nested, malformed or active SVG remains unmodified text source', async () => {
  const examples = ['<svg><rect/>', '<svg><g></svg>', '<svg><rect/></svg><svg></svg>',
    '<svg><svg></svg></svg>', '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>', '<svg><foreignObject/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "private">]><svg></svg>',
    '<svg><use href="https://private.example/image.svg#x"/></svg>',
    '<svg><use href="javascript:alert(1)"/></svg>', '<svg><rect style="fill:url(https://private.example/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"><object data="https://private.example"/></svg>',
    '<svg><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>',
    '<svg xmlns:other="http://www.w3.org/2000/svg"><rect/></svg>',
    '<svg><use href="#icon" xml:base="https://private.example/remote.svg"/></svg>',
    '<svg><style>rect { fill: &#117;rl(https://private.example); }</style></svg>',
    '<svg><rect width=123/></svg>'];
  for (const content of examples) {
    const h = harness();
    assert.equal((await h.reply({ ...input, content })).attachmentType, 'text');
    assert.equal(h.calls[0].init.body.get('file').name, 'answer.zip');
    assert.equal(await zipSource(h.calls[0].init.body.get('file'), 'answer.txt'), content);
  }
  const h = harness(); const content = '<svg><rect/></svg>';
  assert.equal((await h.reply({ ...input, content, incomplete: true })).attachmentType, 'text');
  assert.equal(await zipSource(h.calls[0].init.body.get('file'), 'answer.txt'), content);
  assert.match(h.calls[1].init.body, /尚未生成完整/);
});

test('rejects oversized attachments without upload or source truncation', async () => {
  const h = harness();
  await assert.rejects(h.reply({ ...input, content: '中'.repeat(90000) }), { code: 'KOOK_INVALID_INPUT' });
  await assert.rejects(h.reply({ ...input, content: 'x'.repeat(256 * 1024) }), { code: 'KOOK_INVALID_INPUT' });
  assert.equal(h.calls.length, 0);
});

test('untrusted or malformed asset URLs never reach message create', async () => {
  for (const url of ['http://img.kookapp.cn/a.svg', 'https://kookapp.cn.evil.test/a.svg',
    'https://evil.test/a.svg', 'https://user:pass@img.kookapp.cn/a.svg',
    'https://img.kookapp.cn:8443/a.svg', 'file:///private/path', 'https://img.kookapp.cn/a.svg?private=1', null]) {
    let calls = 0;
    const h = harness({ fetchImpl: async () => { calls++; return Response.json({ code: 0, data: { url } }); } });
    await assert.rejects(h.reply({ ...input, content: '<svg></svg>' }), { code: 'KOOK_ASSET_INVALID_RESPONSE' });
    assert.equal(calls, 1);
  }
});

test('upload errors are sanitized and are not retried or followed by a message', async () => {
  for (const [response, code] of [[() => new Response('private-token', { status: 400 }), 'KOOK_ASSET_REJECTED'],
    [() => Response.json({ code: 40000, message: 'private-token' }), 'KOOK_ASSET_REJECTED'],
    [() => new Response('private invalid JSON'), 'KOOK_ASSET_INVALID_RESPONSE'],
    [() => new Response('x'.repeat(33000)), 'KOOK_ASSET_RESPONSE_TOO_LARGE'],
    [() => { throw new Error('private-token'); }, 'KOOK_ASSET_NETWORK']]) {
    let calls = 0;
    const h = harness({ fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(h.reply({ ...input, content: '<svg></svg>' }), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.stack, /private-token|private invalid/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('rejects unexpected redirects even when an injected fetch ignores the redirect policy', async () => {
  for (const content of [input.content, '<svg></svg>']) {
    let calls = 0;
    const h = harness({ fetchImpl: async () => {
      calls++; const response = content === input.content ? success() : assetSuccess();
      Object.defineProperty(response, 'redirected', { value: true }); return response;
    } });
    await assert.rejects(h.reply({ ...input, content }), { code: content === input.content ? 'KOOK_REJECTED' : 'KOOK_ASSET_REJECTED' });
    assert.equal(calls, 1);
  }
});

test('abort after upload prevents message creation, and timeout also bounds a hung upload', async () => {
  const controller = new AbortController(); let calls = 0;
  const h = harness({ fetchImpl: async () => { calls++; controller.abort(); return assetSuccess(); } });
  await assert.rejects(h.reply({ ...input, content: '<svg></svg>', signal: controller.signal }), { code: 'KOOK_ABORTED' });
  assert.equal(calls, 1);
  let requestSignal;
  const hung = harness({ timeoutMs: 10, fetchImpl: async (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(hung.reply({ ...input, content: '<svg></svg>' }), { code: 'KOOK_ASSET_TIMEOUT' });
  assert.equal(requestSignal.aborted, true);
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
