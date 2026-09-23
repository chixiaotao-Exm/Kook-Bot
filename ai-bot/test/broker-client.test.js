import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodeBrokerClient } from '../src/broker-client.js';

const job = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function fixture(value, status = 200) {
  const calls = [];
  const client = new CodeBrokerClient({ requestImpl(options, callback) {
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = body => { calls.push({ options, body: JSON.parse(body) });
      const response = new PassThrough(); response.statusCode = status; response.headers = {};
      callback(response); response.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
    return request;
  } });
  return { client, calls };
}
test('rejects malformed UTF-8 rather than silently changing tool content', async () => {
  const raw = Buffer.concat([Buffer.from('{"ok":true,"data":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await assert.rejects(fixture(raw).client.request('read_file', job), error => error.code === 'BROKER_FAILED');
  const text = '中文源码 😀 �';
  assert.equal(await fixture(Buffer.from(JSON.stringify({ ok: true, data: text }))).client.request('read_file', job), text);
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
