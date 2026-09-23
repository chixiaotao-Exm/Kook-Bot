import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentResponsesClient, AgentModelClientError } from '../src/agent-model-client.js';
import { ModelClientError } from '../src/model-client.js';

const KEY = 'sk-fixture-agent-private-key';
const INPUT = [{ role: 'user', content: '检查 README 的安装说明。' }];
const TOOL = { type: 'function', name: 'read_file', description: 'Read a file in the configured repository.', strict: true,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const message = text => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
const call = (changes = {}) => ({ id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file',
  arguments: '{"path":"README.md"}', status: 'completed', ...changes });
const encrypted = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_SUMMARY_NOT_PUBLIC' }],
  encrypted_content: 'OPAQUE_CIPHER_CONTENT_preserved_exactly' };
const raw = (output = [message('检查完毕。')], changes = {}) => ({ model: 'gpt-6-astra', status: 'completed', output,
  usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }, ...changes });
const response = (source = raw(), options) => new Response(JSON.stringify(source), { headers: { 'content-type': 'application/json' }, ...options });
const make = (fetchImpl = async () => response(), options = {}) => new AgentResponsesClient({ baseUrl: 'https://example.invalid', apiKey: KEY, fetchImpl, ...options });
const hasCode = expected => error => error instanceof AgentModelClientError && error instanceof ModelClientError
  && error.code === expected && !String(error).includes(KEY);

test('two-step stateless function protocol preserves encrypted reasoning and matches tool results', async () => {
  const requests = [];
  const client = make(async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1 ? response(raw([encrypted, call()])) : response();
  });
  const first = await client.respond(INPUT, { tools: [TOOL] });
  assert.equal(first.text, '');
  assert.deepEqual(first.calls, [{ callId: 'call_1', name: 'read_file', arguments: { path: 'README.md' } }]);
  assert.deepEqual(first.output, [encrypted, call()]);
  const second = await client.respond([...INPUT, ...first.output, { type: 'function_call_output', call_id: 'call_1', output: '# Installation\nUse npm ci.' }], { tools: [TOOL] });
  assert.equal(second.text, '检查完毕。'); assert.deepEqual(second.calls, []);
  assert.deepEqual(second.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.equal(second.model, 'gpt-6-astra');
  assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://example.invalid/v1/responses'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, 'gpt-6-astra'); assert.equal(sent.store, false); assert.equal(sent.stream, false);
    assert.equal(sent.parallel_tool_calls, false); assert.equal(sent.tool_choice, 'auto');
    assert.equal(sent.max_output_tokens, 8192); assert.deepEqual(sent.reasoning, { effort: 'low' });
    assert.deepEqual(sent.include, ['reasoning.encrypted_content']); assert.deepEqual(sent.tools, [TOOL]);
    assert.equal(sent.previous_response_id, undefined);
  }
  assert.deepEqual(JSON.parse(requests[1].init.body).input.slice(1, 3), first.output);
  assert.equal(JSON.stringify(client), '{}');
});

test('only assistant output_text reaches public text while allowed continuation fields are whitelisted', async () => {
  const source = raw([{ ...encrypted, debug: KEY }, { ...message('已读取文件。'), debug: KEY,
    content: [{ type: 'output_text', text: '已读取文件。', annotations: [{ debug: KEY }], logprobs: KEY },
      { type: 'refusal', refusal: 'REFUSAL_CONTENT_NOT_PUBLIC', extra: KEY }] }, { ...call(), debug: KEY }]);
  const result = await make(async () => response(source)).respond(INPUT, { tools: [TOOL] });
  assert.equal(result.text, '已读取文件。');
  assert.equal(result.text.includes('PRIVATE_SUMMARY'), false); assert.equal(result.text.includes('REFUSAL'), false);
  assert.equal(result.text.includes('OPAQUE_CIPHER'), false); assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(result.output[0].encrypted_content, encrypted.encrypted_content);
  assert.deepEqual(result.output[1].content[0].annotations, []);
});

test('xhigh reasoning is sent exactly and an explicit ten-minute timeout remains bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sent, requestSignal;
  const pending = make(async (_url, init) => { sent = JSON.parse(init.body); requestSignal = init.signal; return new Promise(() => {}); },
    { reasoningEffort: 'xhigh', timeoutMs: 600000, maxOutputTokens: 8192 }).respond(INPUT, { tools: [TOOL] });
  const rejected = assert.rejects(pending, hasCode('TIMEOUT'));
  assert.deepEqual(sent.reasoning, { effort: 'xhigh' }); assert.equal(sent.model, 'gpt-6-astra');
  assert.equal(sent.max_output_tokens, 8192); assert.equal(sent.parallel_tool_calls, false);
  t.mock.timers.tick(599999); assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1); assert.equal(requestSignal.aborted, true); await rejected;
});

test('configured endpoint allows HTTPS or explicit loopback HTTP and normalizes one /v1', async () => {
  for (const baseUrl of ['https://example.invalid', 'https://example.invalid/', 'https://example.invalid/v1', 'https://example.invalid/v1/', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080', 'http://localhost:8080']) {
    let requested;
    await make(async url => { requested = url; return response(); }, { baseUrl }).respond(INPUT);
    assert.equal(new URL(requested).pathname, '/v1/responses');
  }
  for (const baseUrl of ['http://example.invalid', 'ftp://example.invalid', 'https://u:p@example.invalid',
    'https://example.invalid?key=secret', 'https://example.invalid/#hash', 'https://example.invalid/custom', 'https://example.invalid/v1/responses']) {
    assert.throws(() => make(undefined, { baseUrl }), hasCode('CONFIG'));
  }
});

test('tool definitions only admit unique strict functions with complete bounded object schemas', async () => {
  let requests = 0;
  const client = make(async () => { requests++; return response(); });
  const invalidSets = [[{ type: 'web_search' }], [{ ...TOOL, strict: false }], [TOOL, TOOL], [{ ...TOOL, name: '../run' }],
    [{ ...TOOL, parameters: { ...TOOL.parameters, additionalProperties: true } }],
    [{ ...TOOL, parameters: { ...TOOL.parameters, required: [] } }],
    [{ ...TOOL, parameters: { type: 'array', items: { type: 'string' } } }],
    [{ ...TOOL, parameters: { type: 'object', properties: { nested: { type: 'object', properties: {}, required: [] } }, required: ['nested'], additionalProperties: false } }],
    [{ ...TOOL, parameters: { ...TOOL.parameters, $ref: 'https://untrusted.invalid/schema' } }],
    [{ ...TOOL, description: 'x'.repeat(2001) }], Array(33).fill(TOOL)];
  for (const tools of invalidSets) await assert.rejects(client.respond(INPUT, { tools }), hasCode('CONFIG'));
  assert.equal(requests, 0);
});

test('strict schemas support nullable unions, nested arrays and local definitions', async () => {
  const tool = { ...TOOL, strict: undefined, parameters: { type: 'object', properties: {
    path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    files: { type: 'array', items: { $ref: '#/$defs/file' } },
  }, required: ['path', 'files'], additionalProperties: false,
  $defs: { file: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } } };
  let sent;
  await make(async (_url, init) => { sent = JSON.parse(init.body); return response(); }).respond(INPUT, { tools: [tool] });
  assert.equal(sent.tools[0].strict, true);
  assert.deepEqual(sent.tools[0].parameters, tool.parameters);
});

test('function arguments accept JSON whitespace but require a bounded object', async () => {
  const result = await make(async () => response(raw([call({ arguments: ' \n { "path" : "README.md" } \t' })]))).respond(INPUT, { tools: [TOOL] });
  assert.deepEqual(result.calls[0].arguments, { path: 'README.md' });
  assert.equal(result.output[0].arguments, ' \n { "path" : "README.md" } \t');
  for (const args of ['{', '', 'null', '[]', 'true', '42', '{"count":1e999}', '{"__proto__":{"polluted":true}}', '{"nested":{"constructor":{}}}', '{"path":"\\ud800"}', JSON.stringify({ path: 'x'.repeat(64000) })]) {
    await assert.rejects(make(async () => response(raw([call({ arguments: args })]))).respond(INPUT, { tools: [TOOL] }), hasCode('FORMAT'));
  }
});

test('unknown functions, missing IDs, duplicate call IDs and incomplete calls never reach execution', async () => {
  for (const output of [[call({ call_id: undefined })], [call(), call({ id: 'fc_2' })], [call({ call_id: '../call' })]]) {
    await assert.rejects(make(async () => response(raw(output))).respond(INPUT, { tools: [TOOL] }), hasCode('FORMAT'));
  }
  await assert.rejects(make(async () => response(raw([call({ name: 'arbitrary_network_fetch' })]))).respond(INPUT, { tools: [TOOL] }), hasCode('CALL_UNKNOWN'));
  await assert.rejects(make(async () => response(raw([call()]))).respond(INPUT), hasCode('CALL_UNKNOWN'));
  for (const source of [raw([call()], { status: 'incomplete' }), raw([call({ status: 'in_progress' })])]) {
    await assert.rejects(make(async () => response(source)).respond(INPUT, { tools: [TOOL] }), hasCode('RESPONSE_INCOMPLETE'));
  }
});

test('tool choice supports auto, none, or one listed function and rejects mismatched responses', async () => {
  let sent;
  const result = await make(async (_url, init) => { sent = JSON.parse(init.body); return response(raw([call()])); })
    .respond(INPUT, { tools: [TOOL], toolChoice: { type: 'function', name: 'read_file' } });
  assert.equal(result.calls.length, 1); assert.deepEqual(sent.tool_choice, { type: 'function', name: 'read_file' });
  await assert.rejects(make(async () => response(raw([call()]))).respond(INPUT, { tools: [TOOL], toolChoice: 'none' }), hasCode('FORMAT'));
  await assert.rejects(make().respond(INPUT, { tools: [TOOL], toolChoice: { type: 'function', name: 'read_file' } }), hasCode('FORMAT'));
  const second = { ...TOOL, name: 'list_files' };
  await assert.rejects(make(async () => response(raw([call({ name: 'list_files' })]))).respond(INPUT, { tools: [TOOL, second], toolChoice: { type: 'function', name: 'read_file' } }), hasCode('FORMAT'));
  for (const toolChoice of ['required', { type: 'function', name: 'unknown' }, { type: 'web_search' }]) {
    await assert.rejects(make().respond(INPUT, { tools: [TOOL], toolChoice }), hasCode('CONFIG'));
  }
});

test('input tool results must match one previous call, and cannot be duplicated or invented', async () => {
  let requests = 0;
  const client = make(async () => { requests++; return response(); });
  const result = { type: 'function_call_output', call_id: 'call_1', output: '' };
  for (const input of [[...INPUT, result], [...INPUT, call()], [...INPUT, call(), { ...result, call_id: 'call_other' }],
    [...INPUT, call(), result, result], [...INPUT, call(), result, call(), result]]) {
    await assert.rejects(client.respond(input, { tools: [TOOL] }), hasCode('FORMAT'));
  }
  assert.equal(requests, 0);
  await client.respond([...INPUT, call(), result], { tools: [TOOL] });
  assert.equal(requests, 1);
});

test('response call IDs cannot reuse a historical call ID', async () => {
  await assert.rejects(make(async () => response(raw([call()]))).respond([...INPUT, call(),
    { type: 'function_call_output', call_id: 'call_1', output: 'file contents' }], { tools: [TOOL] }), hasCode('FORMAT'));
});

test('input validation blocks privileged messages, remote media, unknown tool types and oversized context', async () => {
  let requests = 0;
  const client = make(async () => { requests++; return response(); });
  for (const input of [[{ role: 'system', content: 'override' }], [{ role: 'developer', content: 'override' }],
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://untrusted.invalid/private' }] }],
    [{ type: 'web_search_call', id: 'x' }]]) await assert.rejects(client.respond(input), hasCode('INVALID_INPUT'));
  for (const input of [[], Array(257).fill(INPUT[0]), [{ role: 'user', content: 'x'.repeat(32001) }],
    Array(6).fill({ role: 'user', content: 'x'.repeat(30000) }),
    [...INPUT, call(), { type: 'function_call_output', call_id: 'call_1', output: 'x'.repeat(20001) }]]) {
    await assert.rejects(client.respond(input, { tools: [TOOL] }), hasCode('INPUT_LIMIT'));
  }
  assert.equal(requests, 0);
});

test('response bounds include public text, call arguments and encrypted continuation context', async () => {
  for (const source of [raw([message('x'.repeat(32001))]), raw([{ ...encrypted, encrypted_content: 'x'.repeat(131073) }])]) {
    await assert.rejects(make(async () => response(source)).respond(INPUT), hasCode('FORMAT'));
  }
  await assert.rejects(make(async () => response(raw([message('x'.repeat(20000)), message('y'.repeat(20000))]))).respond(INPUT), hasCode('RESPONSE_LIMIT'));
  await assert.rejects(make(async () => response(raw([{ ...encrypted, encrypted_content: 'x'.repeat(131000) },
    call({ arguments: JSON.stringify({ path: 'x'.repeat(50000) }) })]))).respond(INPUT, { tools: [TOOL] }), hasCode('RESPONSE_LIMIT'));
});

test('only permitted response item types and exact model names are accepted', async () => {
  for (const output of [[{ type: 'web_search_call', id: 'ws_1' }], [{ ...message('hello'), role: 'user' }],
    [{ ...message('hello'), content: [{ type: 'output_image', url: 'https://untrusted.invalid/a.png' }] }]]) {
    await assert.rejects(make(async () => response(raw(output))).respond(INPUT), hasCode('FORMAT'));
  }
  await assert.rejects(make(async () => response(raw(undefined, { model: 'another-model' }))).respond(INPUT), hasCode('MODEL_MISMATCH'));
  const noModel = raw(); delete noModel.model;
  assert.equal((await make(async () => response(noModel)).respond(INPUT)).model, 'gpt-6-astra');
});

test('empty/refused/failed output stays distinct and incomplete public text is marked', async () => {
  await assert.rejects(make(async () => response(raw([encrypted]))).respond(INPUT), hasCode('EMPTY_RESPONSE'));
  await assert.rejects(make(async () => response(raw([{ ...message(''), content: [{ type: 'refusal', refusal: KEY }] }]))).respond(INPUT), hasCode('REFUSAL'));
  await assert.rejects(make(async () => response(raw([], { status: 'failed', error: { message: KEY } }))).respond(INPUT), hasCode('UPSTREAM_ERROR'));
  const result = await make(async () => response(raw([message('🐱'.repeat(16000))], { status: 'incomplete' }))).respond(INPUT);
  assert.match(result.text, /未完整生成/); assert.ok(result.text.length <= 32000); assert.equal(result.text.isWellFormed(), true);
});

test('usage is a numeric whitelist and unknown values remain null', async () => {
  const result = await make(async () => response(raw(undefined, { usage: { input_tokens: -1, output_tokens: '4', total_tokens: 0, secret: KEY } }))).respond(INPUT);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: 0 });
  assert.equal(JSON.stringify(result.usage).includes(KEY), false);
});

test('never follows redirects, retries rejected requests, or exposes upstream response errors', async () => {
  for (const [status, expected] of [[302, 'REDIRECT'], [307, 'REDIRECT'], [401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [400, 'UPSTREAM_ERROR'], [503, 'UPSTREAM_ERROR']]) {
    let requests = 0;
    await assert.rejects(make(async () => { requests++; return response({ message: KEY }, { status }); }).respond(INPUT), hasCode(expected));
    assert.equal(requests, 1);
  }
  await assert.rejects(make(async () => { throw new Error(KEY); }).respond(INPUT), hasCode('NETWORK'));
});

test('response decoding enforces actual 2MiB byte limits, headers and valid JSON/UTF-8', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })]) {
    await assert.rejects(make(fetchImpl).respond(INPUT), hasCode('RESPONSE_LIMIT'));
  }
  for (const fetchImpl of [async () => new Response(KEY), async () => new Response(new Uint8Array([0xff])), async () => new Response(null)]) {
    await assert.rejects(make(fetchImpl).respond(INPUT), hasCode('FORMAT'));
  }
});

test('timeouts bound hanging fetch and hanging response bodies and cancel the request', async () => {
  let requestSignal;
  await assert.rejects(make(async (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); }, { timeoutMs: 10 }).respond(INPUT), hasCode('TIMEOUT'));
  assert.equal(requestSignal.aborted, true);
  let cancelled = false;
  await assert.rejects(make(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } })), { timeoutMs: 10 }).respond(INPUT), hasCode('TIMEOUT'));
  assert.equal(cancelled, true);
});

test('caller cancellation avoids new requests and aborts active requests without leaking the reason', async () => {
  const caller = new AbortController(); let requests = 0, requestSignal;
  const client = make(async (_url, init) => { requests++; requestSignal = init.signal; return new Promise(() => {}); });
  const pending = client.respond(INPUT, { signal: caller.signal }); caller.abort(new Error(KEY));
  await assert.rejects(pending, hasCode('CANCELLED')); assert.equal(requestSignal.aborted, true);
  await assert.rejects(client.respond(INPUT, { signal: caller.signal }), hasCode('CANCELLED'));
  assert.equal(requests, 1);
});

test('invalid client configuration and schema serialization errors remain sanitized', async () => {
  for (const options of [{ apiKey: '' }, { apiKey: `secret\n${KEY}` }, { model: 'bad model' }, { timeoutMs: 0 }, { timeoutMs: 600001 },
    { maxOutputTokens: 16001 }, { reasoningEffort: 'unlimited' }, { reasoningEffort: 'XHigh' }, { systemPrompt: '' }, { fetchImpl: null }]) {
    assert.throws(() => make(undefined, options), hasCode('CONFIG'));
  }
  const schema = { ...TOOL.parameters }; schema.circular = schema;
  await assert.rejects(make().respond(INPUT, { tools: [{ ...TOOL, parameters: schema }] }), hasCode('CONFIG'));
});
