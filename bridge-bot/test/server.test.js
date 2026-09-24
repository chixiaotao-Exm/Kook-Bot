import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import { BridgeServer, verifySignature } from '../src/server.js';

const SECRET = 'test-only-secret-' + 'a'.repeat(32), REPO = 'chixiaotao-Exm/Kook-Bot';
const sign = raw => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
const push = () => ({ repository: { full_name: REPO }, ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40),
  deleted: false, size: 1, commits: [{ id: 'b'.repeat(40), message: 'Fix a regression', author: { name: 'Example' } }], sender: { login: 'example' } });
async function fixture(t, options = {}) {
  const queued = [], logs = [], keys = new Set();
  const queue = { async enqueue(value) { if (options.failure) throw new Error('private storage path');
    const duplicate = keys.has(value.key); if (!duplicate) { queued.push(value); keys.add(value.key); } return { accepted: !duplicate, duplicate }; },
  snapshot: () => ({ queued: queued.length }) };
  const server = new BridgeServer({ host: '127.0.0.1', port: 0, secret: SECRET, repository: REPO, queue, logger: entry => logs.push(entry), ...options });
  const address = await server.start();t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const send = async (payload = push(), extra = {}) => {
    const raw = extra.raw ?? JSON.stringify(payload);
    return fetch(origin + (extra.route || '/github'), { method: extra.method || 'POST', body: extra.method === 'GET' ? undefined : raw,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': extra.event || 'push', 'X-GitHub-Delivery': randomUUID(),
        'X-Hub-Signature-256': sign(raw), ...(extra.headers || {}) } });
  };
  return { queued, logs, send, origin, server };
}

async function socketFixture(t, origin) {
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  let text = '';
  socket.on('data', chunk => { text += chunk.toString('utf8'); });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  const closed = new Promise(resolve => socket.once('close', resolve));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return { socket, closed, text: () => text };
}
function wireHeaders(raw, extra = []) {
  return ['POST /github HTTP/1.1', 'Host: localhost', 'Connection: close', 'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(raw)}`, 'X-GitHub-Event: push', `X-GitHub-Delivery: ${randomUUID()}`,
    `X-Hub-Signature-256: ${sign(raw)}`, ...extra, '', ''].join('\r\n');
}
async function closesPromptly(connection) {
  let timer;
  try { await Promise.race([connection.closed, new Promise((_, reject) => {
    timer = setTimeout(() => { connection.socket.destroy(); reject(Error('Request did not close within one second')); }, 1000);
  })]); } finally { clearTimeout(timer); }
}

test('raw-body signatures reject tampering and malformed digests', () => {
  const raw = Buffer.from('{ "text": "你好" }');
  assert.equal(verifySignature(raw, sign(raw), SECRET), true);
  assert.equal(verifySignature(Buffer.from('{"text":"你好"}'), sign(raw), SECRET), false);
  for (const value of [undefined, 'sha1=abc', 'sha256=' + 'x'.repeat(64), 'sha256=0']) assert.equal(verifySignature(raw, value, SECRET), false);
});

test('signed configured repository events are durably queued, duplicates do not send again', async t => {
  const f = await fixture(t);
  const first = await f.send();assert.equal(first.status, 202);assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
  const second = await f.send();assert.equal(second.status, 200);assert.deepEqual(await second.json(), { accepted: false, duplicate: true });
  assert.equal(f.queued.length, 1); assert.deepEqual(f.logs.map(log => log.outcome), ['queued', 'duplicate']);
  assert.doesNotMatch(JSON.stringify(f.logs), /regression|Example|secret/);
});

test('ping acknowledges configuration without queuing a message', async t => {
  const f = await fixture(t);
  const response = await f.send({ repository: { full_name: REPO }, zen: 'not forwarded' }, { event: 'ping' });
  assert.equal(response.status, 200);assert.deepEqual(await response.json(), { pong: true });assert.equal(f.queued.length, 0);
});

test('invalid signature, repository, content and payload never enter the queue', async t => {
  const f = await fixture(t, { maxBodyBytes: 1024 });
  const cases = [
    [push(), { headers: { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) } }, 401],
    [{ repository: { full_name: 'other/repository' } }, {}, 403],
    [{ repository: { full_name: 123 } }, {}, 403],
    [[], {}, 403], [push(), { raw: '{bad' }, 400],
    [push(), { headers: { 'Content-Type': 'text/plain' } }, 415],
    [push(), { headers: { 'Content-Encoding': 'gzip' } }, 415],
    [push(), { headers: { 'X-GitHub-Delivery': '../bad' } }, 400],
    [push(), { event: 'repository' }, 400],
    [push(), { raw: JSON.stringify({ padding: 'a'.repeat(1200) }) }, 413],
  ];
  for (const [payload, options, status] of cases) assert.equal((await f.send(payload, options)).status, status);
  assert.equal(f.queued.length, 0);
});

test('queue storage failure fails receipt without leaking details', async t => {
  const f = await fixture(t, { failure: true });
  const response = await f.send();assert.equal(response.status, 503);assert.doesNotMatch(await response.text(), /private|storage/);
});

test('unhandled actions are ignored and routes cannot enable an arbitrary recipient', async t => {
  const f = await fixture(t);
  const ignored = await f.send({ repository: { full_name: REPO }, action: 'synchronize' }, { event: 'pull_request' });
  assert.equal(ignored.status, 200);assert.deepEqual(await ignored.json(), { ignored: true });
  assert.equal((await f.send(push(), { method: 'GET' })).status, 405);
  assert.equal((await f.send(push(), { route: '/github?channel=123456' })).status, 404);
  assert.equal((await fetch(f.origin + '/health')).status, 200);assert.equal(f.queued.length, 0);
});

test('webhook receipt waits for successful queue persistence', async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const queue = { enqueue: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { accepted: true, duplicate: false }; } };
  const f = await fixture(t, { queue });let resolved = false;
  const response = f.send().then(value => { resolved = true;return value; });
  await ready;await new Promise(resolve => setImmediate(resolve));assert.equal(resolved, false);
  release();assert.equal((await response).status, 202);
});

test('an absolute body deadline closes a real slow socket despite ongoing bytes and never queues late data', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 25 }), raw = JSON.stringify(push());
  const connection = await socketFixture(t, f.origin); let offset = 1;
  connection.socket.write(wireHeaders(raw) + raw.slice(0, offset));
  const trickle = setInterval(() => {
    if (!connection.socket.destroyed) connection.socket.write(raw.slice(offset, ++offset));
  }, 5);
  try { await closesPromptly(connection); } finally { clearInterval(trickle); }
  assert.ok(connection.text() === '' || /^HTTP\/1\.1 408\b/.test(connection.text()));
  assert.equal(f.queued.length, 0);
  assert.doesNotThrow(() => connection.socket.write(raw.slice(offset), () => {}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queued.length, 0);
  assert.equal((await f.send()).status, 202, 'The listener still accepts a complete valid event');
});

test('completed body reads clear their deadline before waiting for durable queue admission', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { bodyTimeoutMs: 25, queue: { enqueue: async () => {
    entered(); await new Promise(resolve => { release = resolve; }); return { accepted: true, duplicate: false };
  } } });
  const pending = f.send(); await ready;
  await new Promise(resolve => setTimeout(resolve, 75)); release();
  assert.equal((await pending).status, 202);
});

test('duplicate signature, event and delivery headers are rejected on real HTTP sockets', async t => {
  const f = await fixture(t), raw = JSON.stringify(push());
  for (const header of [`X-Hub-Signature-256: ${sign(raw)}`, 'X-GitHub-Event: push', `X-GitHub-Delivery: ${randomUUID()}`]) {
    const connection = await socketFixture(t, f.origin);
    connection.socket.write(wireHeaders(raw, [header]) + raw);
    await closesPromptly(connection);
    assert.match(connection.text(), /^HTTP\/1\.1 400\b/);
    assert.match(connection.text(), /invalid_headers/);
    assert.equal(f.queued.length, 0);
  }
});

test('body timeout configuration stays within the ten-second maximum', () => {
  const options = { repository: REPO, secret: SECRET, queue: { enqueue: async () => {} } };
  assert.equal(new BridgeServer(options).bodyTimeoutMs, 10000);
  for (const bodyTimeoutMs of [0, -1, 10001, 1.5, '25', Infinity]) {
    assert.throws(() => new BridgeServer({ ...options, bodyTimeoutMs }), /Invalid bridge listener/);
  }
});
