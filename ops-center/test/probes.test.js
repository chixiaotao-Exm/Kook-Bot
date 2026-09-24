import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probeMonitor } from '../src/probes.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const monitor = changes => ({ id: 'site', name: 'Website', url: 'http://127.0.0.1:18998/health', expectedStatus: 200, ...changes });
function tlsFixture({ authorized = true, expires = NOW + 40 * 86400000, hang = false } = {}) {
  const sockets = [], options = [];
  const connect = settings => {
    options.push(settings); const socket = new EventEmitter(); socket.authorized = authorized;
    socket.getPeerCertificate = () => ({ valid_to: new Date(expires).toUTCString() });
    socket.destroy = () => { socket.destroyed = true; };
    sockets.push(socket);
    if (!hang) queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  };
  return { connect, sockets, options };
}

test('HTTP monitor uses only configured GET target and matches JSON with no credentials or redirects', async () => {
  const calls = [];
  const result = await probeMonitor(monitor({ jsonPath: 'status', jsonEquals: 'ok' }), { now: () => NOW,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ status: 'ok', ignored: 'private-response' }); },
    tlsConnectImpl: () => { throw Error('No TLS for HTTP'); } });
  assert.equal(result.ok, true); assert.equal(result.httpStatus, 200); assert.equal(result.tlsDays, null);
  assert.equal(result.checkedAt, new Date(NOW).toISOString()); assert.ok(result.latencyMs >= 0);
  assert.deepEqual(calls[0].url, monitor().url); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' }); assert.equal(calls[0].options.body, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-response/);
});

test('HTTPS monitors validate certificate lifetime with SNI and close the dedicated socket', async () => {
  const tls = tlsFixture();
  const result = await probeMonitor(monitor({ url: 'https://site.example:443/health' }), { now: () => NOW,
    fetchImpl: async () => new Response('healthy'), tlsConnectImpl: tls.connect });
  assert.equal(result.ok, true); assert.equal(result.tlsDays, 40);
  assert.deepEqual(tls.options[0], { host: 'site.example', port: 443, rejectUnauthorized: true, servername: 'site.example' });
  assert.equal(tls.sockets[0].destroyed, true);
});

test('TLS failures and stalled handshakes fail within the same bounded probe deadline', async () => {
  for (const config of [{ authorized: false }, { expires: NOW - 1 }, { hang: true }]) {
    const tls = tlsFixture(config);
    const result = await probeMonitor(monitor({ url: 'https://site.example/' }), { now: () => NOW, timeoutMs: 15,
      fetchImpl: async () => new Response('ok'), tlsConnectImpl: tls.connect });
    assert.equal(result.ok, false); assert.equal(result.tlsDays, null); assert.equal(tls.sockets[0].destroyed, true);
    assert.match(result.error, config.hang ? /超时/ : /TLS/);
  }
});

test('HTTP mismatches, redirects and invalid or mismatched JSON fail without reflecting upstream text', async () => {
  for (const response of [new Response('private redirect', { status: 302 }), new Response('private failure', { status: 503 }),
    Response.json({ status: 'bad', message: 'private-token' }), new Response('private non-json')]) {
    const result = await probeMonitor(monitor({ jsonPath: 'status', jsonEquals: 'ok' }), { now: () => NOW, fetchImpl: async () => response });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /private/);
  }
  assert.equal((await probeMonitor(monitor({ expectedStatus: 204 }), { fetchImpl: async () => new Response(null, { status: 204 }) })).ok, true);
  assert.equal((await probeMonitor(monitor({ jsonPath: 'ready.value', jsonEquals: false }), { fetchImpl: async () => Response.json({ ready: { value: false } }) })).ok, true);
});

test('absolute timeout bounds hanging fetch/body and excludes oversized or invalid response bytes', async () => {
  let signal, cancelled = false;
  const hang = await probeMonitor(monitor(), { timeoutMs: 15, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(hang.ok, false); assert.match(hang.error, /超时/); assert.equal(signal.aborted, true);
  const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } });
  const stalled = await probeMonitor(monitor(), { timeoutMs: 15, fetchImpl: async () => new Response(body) });
  assert.equal(stalled.ok, false); assert.equal(cancelled, true);
  for (const response of [new Response('x'.repeat(128 * 1024 + 1)), new Response('', { headers: { 'content-length': String(128 * 1024 + 1) } }),
    new Response(new Uint8Array([0xff]))]) {
    const result = await probeMonitor(monitor({ jsonPath: 'status', jsonEquals: 'ok' }), { fetchImpl: async () => response });
    assert.equal(result.ok, false); assert.match(result.error, /响应内容/);
  }
});

test('invalid targets/options fail without dispatch and transport errors are sanitized', async () => {
  let calls = 0;
  for (const patch of [{ url: 'file:///private' }, { url: 'https://user:secret@example.test/' }, { url: 'https://example.test/#secret' },
    { jsonPath: '__proto__.value', jsonEquals: true }, { jsonPath: 'status', jsonEquals: {} }, { expectedStatus: '200' }]) {
    const result = await probeMonitor(monitor(patch), { fetchImpl: () => { calls++; throw Error('must not execute'); } });
    assert.equal(result.ok, false); assert.equal(result.latencyMs, null);
  }
  assert.equal(calls, 0);
  const failed = await probeMonitor(monitor(), { fetchImpl: async () => { throw Error('private token sk-should-not-leak'); } });
  assert.equal(failed.ok, false); assert.doesNotMatch(failed.error, /private|sk-/);
});
