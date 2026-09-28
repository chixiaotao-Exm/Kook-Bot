import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQishuiServer } from '../qishui/server.js';

const ID = '7501674235158431760';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-qishui-review-'));
  const credentialsFile = path.join(dir, 'credentials.json'), cacheDir = path.join(dir, 'media');
  await writeFile(credentialsFile, JSON.stringify({ cookie: 'sessionid=private-fixture' }));
  const token = 'r'.repeat(48);
  const server = createQishuiServer({ token, publicUrl: 'https://bridge.example.test/qishui', credentialsFile, cacheDir,
    catalog: { close() {} }, playback: {}, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.closeBridge();
    assert.equal(path.dirname(dir), tmpdir()); assert.match(path.basename(dir), /^kook-qishui-review-/);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/qishui`;
  return { server, dir, cacheDir, base, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

test('an upstream account outage is not reported as an expired login', async (t) => {
  const f = await fixture(t, { fetchImpl: async () => new Response('temporary upstream failure', { status: 503 }) });
  const response = await fetch(`${f.base}/account`, { headers: f.headers });
  const body = await response.json();
  assert.notEqual(body.expired, true, 'Network/server errors must not instruct the user to re-login');
  assert.ok(response.status >= 500 || body.unavailable === true, 'Account outage must remain distinguishable from logged out');
});

test('closing the bridge cannot publish or orphan a media file prepared concurrently', async (t) => {
  const started = deferred(), completed = deferred();
  const f = await fixture(t, { playback: { async prepare() { started.resolve(); return completed.promise; } } });
  const { mkdir } = await import('node:fs/promises'); await mkdir(f.cacheDir, { recursive: true });
  const file = path.join(f.cacheDir, `${'c'.repeat(48)}.mp3`);
  await writeFile(file, Buffer.alloc(16));
  const request = fetch(`${f.base}/stream`, { method: 'POST', headers: f.headers, body: JSON.stringify({ id: ID }) }).catch(() => null);
  await started.promise;
  const closing = f.server.closeBridge(); await tick();
  completed.resolve({ file, durationMs: 180000, fullTrack: true, encrypted: false });
  await closing; await request; await tick(); await tick();
  assert.deepEqual(await readdir(f.cacheDir), [], 'Shutdown must drain/reject pending preparations and remove their output');
});

test('account data never reflects private cookies or upstream diagnostics', async (t) => {
  const f = await fixture(t, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=private-fixture');
    assert.equal(options.redirect, 'error');
    return Response.json({ status_code: 0, my_info: { id: '7501674235158431760', nickname: 'Test account' }, cookie: 'never-return', diagnostics: 'private-data' });
  } });
  const response = await fetch(`${f.base}/account`, { headers: f.headers });
  const body = await response.json();
  assert.equal(body.loggedIn, true); assert.equal(body.id, ID);
  assert.doesNotMatch(JSON.stringify(body), /private|never-return|sessionid/);
});
