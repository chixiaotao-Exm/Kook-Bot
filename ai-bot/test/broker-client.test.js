import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners, once } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { CodeBrokerClient } from '../src/broker-client.js';

const job = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function fixture(value, status = 200) {
  const calls = [];
  const client = new CodeBrokerClient({ requestImpl(options, callback) {
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = body => { calls.push({ options, body: JSON.parse(body) });
      const response = new PassThrough(); response.statusCode = status; response.headers = {};
      callback(response);
      const chunks = Array.isArray(value) ? value : [typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)];
      for (const chunk of chunks) response.write(chunk);
      response.end(); };
    return request;
  } });
  return { client, calls };
}
test('rejects malformed UTF-8 and retains the existing BOM rejection', async () => {
  for (const bytes of [[0xff], [0xe4, 0xb8]]) {
    const raw = Buffer.concat([Buffer.from('{"ok":true,"data":"'), Buffer.from(bytes), Buffer.from('"}')]);
    await assert.rejects(fixture(raw).client.request('read_file', job), error => error.code === 'BROKER_FAILED');
  }
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true,"data":{}}')]);
  await assert.rejects(fixture(bom).client.request('read_file', job), error => error.code === 'BROKER_FAILED');
});

test('preserves multibyte source characters split across response chunks', async () => {
  const text = '中文源码 😀 � \ufeff', raw = Buffer.from(JSON.stringify({ ok: true, data: text }));
  const first = raw.indexOf(Buffer.from('中')) + 1, second = raw.indexOf(Buffer.from('😀')) + 2;
  const chunks = [raw.subarray(0, first), raw.subarray(first, second), raw.subarray(second)];
  assert.equal(await fixture(chunks).client.request('read_file', job), text);
});

test('real HTTP responses distinguish normal end/close from truncated transport', { timeout: 15000 }, async t => {
  for (const mode of ['complete', 'content-length', 'chunked']) await t.test(mode, async t => {
    const raw = Buffer.from(JSON.stringify({ ok: true, data: '中文源码 😀' }));
    const server = http.createServer((request, response) => {
      request.resume();
      if (mode === 'complete') { response.end(raw); return; }
      response.writeHead(200, mode === 'content-length'
        ? { 'Content-Length': raw.length + 1 } : { 'Transfer-Encoding': 'chunked' });
      // The JSON itself is complete; the missing HTTP body/terminator must still fail.
      response.write(raw, () => setImmediate(() => response.destroy()));
    });
    t.after(async () => {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await closed;
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const events = [];
    let closed;
    const responseClosed = new Promise(resolve => { closed = resolve; });
    const client = new CodeBrokerClient({ requestImpl(options, callback) {
      const { socketPath, ...requestOptions } = options;
      return http.request({ ...requestOptions, host: '127.0.0.1', port: server.address().port, agent: false }, response => {
        response.on('end', () => events.push('end'));
        response.on('close', () => { events.push('close'); closed(); });
        callback(response);
      });
    } });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    t.after(() => clearTimeout(timer));
    const result = client.request('read_file', job, {}, { signal: controller.signal });
    if (mode === 'complete') assert.equal(await result, '中文源码 😀');
    else await assert.rejects(result, error => error.code === 'BROKER_FAILED');
    await responseClosed;
    assert.deepEqual(events, mode === 'complete' ? ['end', 'close'] : ['close']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('premature response close fails promptly and destroys the request', async () => {
  let destroyed = false;
  const controller = new AbortController();
  const client = new CodeBrokerClient({ requestImpl(options, callback) {
    const req = new EventEmitter();
    req.destroy = () => { destroyed = true; };
    req.end = () => {
      const response = new PassThrough(); response.statusCode = 200; response.headers = {};
      callback(response); response.write('{"ok":true'); response.destroy();
    };
    return req;
  } });
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await assert.rejects(client.request('read_file', job, {}, { signal: controller.signal }), error => error.code === 'BROKER_FAILED');
    assert.equal(destroyed, true);
  } finally { clearTimeout(timer); }
});

test('uses only a local socket with a bounded typed request', async () => {
  const f = fixture({ ok: true, data: { files: ['README.md'] } });
  assert.deepEqual(await f.client.request('list_files', job, { path: '', limit: 10 }), { files: ['README.md'] });
  assert.equal(f.calls[0].options.socketPath, '/run/kook-code-agent/broker.sock');
  assert.equal(f.calls[0].options.path, '/rpc'); assert.equal(f.calls[0].body.jobId, job);
  await assert.rejects(f.client.request('exec_shell', job, {}), error => error.code === 'TOOL_INVALID');
  await assert.rejects(f.client.request('read_file', '../escape', {}), error => error.code === 'TOOL_INVALID');
  assert.equal(f.calls.length, 1);
});
test('preserves safe error codes but never upstream messages', async () => {
  const f = fixture({ ok: false, error: { code: 'STALE_HASH', message: 'secret request details' } }, 400);
  await assert.rejects(f.client.request('read_file', job, {}), error => error.code === 'STALE_HASH' && !error.message.includes('secret'));
  await assert.rejects(fixture('not json').client.request('job_status', job), error => error.code === 'BROKER_FAILED');
});
test('pre-cancelled operations are not sent and in-flight cancellation closes transport', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({ ok: true, data: {} });
  await assert.rejects(f.client.request('job_status', job, {}, { signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.equal(f.calls.length, 0);
  let destroyed = false;
  const c = new AbortController();
  const client = new CodeBrokerClient({ requestImpl() { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; }; return req; } });
  const result = client.request('job_status', job, {}, { signal: c.signal }); c.abort();
  await assert.rejects(result, error => error.code === 'CANCELLED'); assert.equal(destroyed, true);
});

test('per-call deadlines may only shorten each operation timeout and are not sent in the RPC body', async () => {
  for (const [operation, target, cap] of [['job_status', job, 30000], ['publish', job, 120000], ['create_job', null, 120000], ['run_checks', job, 210000]]) {
    const f = fixture({ ok: true, data: {} });
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '5', null, cap + 1]) {
      await assert.rejects(f.client.request(operation, target, {}, { timeoutMs }), error => error.code === 'TOOL_INVALID');
    }
    assert.equal(f.calls.length, 0);
    await f.client.request(operation, target, {}, { timeoutMs: cap });
    assert.deepEqual(f.calls[0].body, { operation, jobId: target, args: {} });
  }
});

test('shortened deadlines destroy a hanging request and release cancellation listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signal = new AbortController(); let destroyed = 0;
  const client = new CodeBrokerClient({ requestImpl() {
    const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed++; }; return req;
  } });
  const pending = client.request('job_status', job, {}, { timeoutMs: 10, signal: signal.signal });
  const rejected = assert.rejects(pending, error => error.code === 'TIMEOUT');
  t.mock.timers.tick(9); assert.equal(destroyed, 0);
  t.mock.timers.tick(1); await rejected; assert.equal(destroyed, 1);
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  signal.abort(); t.mock.timers.tick(30000); assert.equal(destroyed, 1);
});

test('cleanup diagnostics preserve the original broker failure without exposing its body', async () => {
  const f = fixture({ ok: false, error: { code: 'GIT_FAILED', cleanupFailed: true, message: 'private path/token' } }, 400);
  await assert.rejects(f.client.request('create_job', null), error => error.code === 'GIT_FAILED'
    && error.cleanupFailed === true && !error.message.includes('private'));
  for (const value of [null, true, 42, '"unexpected"']) {
    await assert.rejects(fixture(value).client.request('job_status', job), error => error.code === 'BROKER_FAILED');
  }
});
