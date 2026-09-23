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
      callback(response); response.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    return request;
  } });
  return { client, calls };
}
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
