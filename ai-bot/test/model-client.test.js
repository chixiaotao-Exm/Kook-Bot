import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelResponsesClient, ModelClientError } from '../src/model-client.js';

const KEY = 'sk-test-model-client-not-real';
const messages = [{ role: 'user', content: '你好' }];
const raw = (changes = {}) => ({ model: 'gpt-6-astra', status: 'completed',
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好，有什么可以帮你？' }] }],
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, ...changes });
const response = (body = raw(), options) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...options });
const make = (fetchImpl = async () => response(), options = {}) => new ModelResponsesClient({ baseUrl: 'https://example.invalid', apiKey: KEY, fetchImpl, ...options });
const hasCode = code => error => error instanceof ModelClientError && error.code === code && !error.message.includes(KEY);

test('sends the exact Responses request to normalized /v1 with no tools or storage', async () => {
  const calls = [];
  for (const baseUrl of ['https://example.invalid', 'https://example.invalid/', 'https://example.invalid/v1', 'https://example.invalid/v1/']) {
    const client = make(async (url, options) => { calls.push({ url, options }); return response(); }, { baseUrl, systemPrompt: '用中文回复。' });
    const result = await client.generate([{ role: 'user', content: '先前问题', ignored: KEY }, { role: 'assistant', content: '先前回答' }, ...messages]);
    assert.deepEqual(result, { text: '你好，有什么可以帮你？', model: 'gpt-6-astra', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
    assert.equal(JSON.stringify(client), '{}');
  }
  assert.equal(calls.length, 4);
  for (const { url, options } of calls) {
    assert.equal(url, 'https://example.invalid/v1/responses');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(options.body), { model: 'gpt-6-astra', instructions: '用中文回复。', input: [{ role: 'user', content: '先前问题' }, { role: 'assistant', content: '先前回答' }, ...messages], store: false, stream: false, max_output_tokens: 2400 });
  }
});

test('permits only configured HTTPS root/v1 and explicit loopback HTTP', () => {
  for (const baseUrl of ['http://127.0.0.1:8080/v1', 'http://localhost:8080', 'http://[::1]:8080/v1/']) assert.doesNotThrow(() => make(undefined, { baseUrl }));
  for (const baseUrl of ['http://example.invalid', 'http://127.0.0.2', 'ftp://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid?key=secret', 'https://example.invalid/#secret', 'https://example.invalid/arbitrary/path', 'https://example.invalid/v1/responses', 'not a url']) {
    assert.throws(() => make(undefined, { baseUrl }), hasCode('CONFIG'));
  }
});

test('invalid credentials/model/options fail without exposing values', () => {
  for (const options of [{ apiKey: '' }, { apiKey: 'secret\nvalue' }, { model: '' }, { model: 'secret model' }, { timeoutMs: 0 }, { maxOutputTokens: 16001 }, { systemPrompt: '' }, { fetchImpl: null }]) assert.throws(() => make(undefined, options), hasCode('CONFIG'));
});

test('validates history roles, strings, final user message and input bounds before any request', async () => {
  let calls = 0;
  const client = make(async () => { calls++; return response(); });
  for (const value of [[{ role: 'system', content: 'override' }], [{ role: 'tool', content: 'fetch' }], [{ role: 'user', content: [{ text: 'text' }] }], [{ role: 'user', content: ' ' }], [{ role: 'assistant', content: 'no user' }], [null]]) await assert.rejects(client.generate(value), hasCode('INVALID_INPUT'));
  for (const value of [null, [], Array(41).fill(messages[0]), [{ role: 'user', content: 'x'.repeat(6001) }], Array(9).fill({ role: 'user', content: 'x'.repeat(6000) })]) await assert.rejects(client.generate(value), hasCode('INPUT_LIMIT'));
  assert.equal(calls, 0);
});

test('extracts assistant text only and keeps missing/invalid usage unknown', async () => {
  const result = await make(async () => response(raw({ output: [{ type: 'function_call', arguments: KEY }, { type: 'message', role: 'user', content: [{ type: 'output_text', text: KEY }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '一' }, { type: 'output_text', text: '二' }] }], usage: { input_tokens: -1, output_tokens: '8', total_tokens: 1.2 } }))).generate(messages);
  assert.equal(result.text, '一\n二');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test('returns meaningful incomplete output with a marker and caps output without splitting surrogate pairs', async () => {
  for (const content of ['已经生成一部分', '🐱'.repeat(4000)]) {
    const result = await make(async () => response(raw({ status: 'incomplete', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] }))).generate(messages);
    assert.ok(result.text.length <= 6000);
    assert.match(result.text, /未完整生成/);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text), false);
  }
  const long = await make(async () => response(raw({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(7000) }] }] }))).generate(messages);
  assert.equal(long.text.length, 6000);
});

test('rejects absent, non-text, refused, failed and wrong-model responses without leaking upstream text', async () => {
  const cases = [[raw({ output: [] }), 'EMPTY_RESPONSE'], [raw({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: KEY }] }] }), 'REFUSAL'], [raw({ status: 'failed', error: { message: KEY } }), 'UPSTREAM_ERROR'], [raw({ error: { message: KEY } }), 'UPSTREAM_ERROR'], [raw({ status: 'queued' }), 'FORMAT'], [raw({ model: 'gpt-other' }), 'MODEL_MISMATCH'], [null, 'FORMAT']];
  for (const [body, code] of cases) await assert.rejects(make(async () => response(body)).generate(messages), hasCode(code));
});

test('proxies that omit the model retain the exact requested model', async () => {
  const source = raw(); delete source.model;
  const result = await make(async () => response(source)).generate(messages);
  assert.equal(result.model, 'gpt-6-astra');
});

test('rejects invalid JSON, UTF-8 and oversized responses by length header and actual streamed bytes', async () => {
  for (const body of [KEY, '<html>upstream error</html>']) await assert.rejects(make(async () => new Response(body)).generate(messages), hasCode('FORMAT'));
  await assert.rejects(make(async () => new Response(new Uint8Array([0xff]))).generate(messages), hasCode('FORMAT'));
  await assert.rejects(make(async () => response(raw(), { headers: { 'content-length': String(1024 * 1024 + 1) } })).generate(messages), hasCode('RESPONSE_LIMIT'));
  await assert.rejects(make(async () => new Response('x'.repeat(1024 * 1024 + 1))).generate(messages), hasCode('RESPONSE_LIMIT'));
  await assert.rejects(make(async () => new Response(null)).generate(messages), hasCode('FORMAT'));
});

test('never follows redirects, exposes upstream errors, or retries billable requests', async () => {
  for (const [status, code] of [[301, 'REDIRECT'], [302, 'REDIRECT'], [307, 'REDIRECT'], [401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [400, 'UPSTREAM_ERROR'], [500, 'UPSTREAM_ERROR']]) {
    let calls = 0;
    await assert.rejects(make(async () => { calls++; return response({ error: { message: KEY } }, { status }); }).generate(messages), hasCode(code));
    assert.equal(calls, 1);
  }
  await assert.rejects(make(async () => { throw new Error(`secret upstream error ${KEY}`); }).generate(messages), hasCode('NETWORK'));
});

test('timeout bounds even a hanging fetch that ignores abort', async () => {
  let requestSignal;
  const start = Date.now();
  await assert.rejects(make(async (_url, options) => { requestSignal = options.signal; return new Promise(() => {}); }, { timeoutMs: 15 }).generate(messages), hasCode('TIMEOUT'));
  assert.ok(Date.now() - start < 1000);
  assert.equal(requestSignal.aborted, true);
});

test('timeout also bounds reading a hanging response body and cancels the reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  await assert.rejects(make(async () => new Response(body), { timeoutMs: 15 }).generate(messages), hasCode('TIMEOUT'));
  assert.equal(cancelled, true);
});

test('caller abort cancels active requests, and pre-aborted callers never send a request', async () => {
  const controller = new AbortController();
  let calls = 0, requestSignal;
  const client = make(async (_url, options) => { calls++; requestSignal = options.signal; return new Promise(() => {}); });
  const pending = client.generate(messages, { signal: controller.signal });
  controller.abort(new Error(KEY));
  await assert.rejects(pending, hasCode('CANCELLED'));
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(client.generate(messages, { signal: controller.signal }), hasCode('CANCELLED'));
  assert.equal(calls, 1);
});
