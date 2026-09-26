import test from 'node:test';
import assert from 'node:assert/strict';
import { KookGateway } from '../src/kook-gateway.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness(options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], sockets = [], events = [], logs = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    packet(packet) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }
    raw(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    hello(session = 'session-secret') { this.packet({ s: 1, d: { code: 0, session_id: session } }); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ code: 0, data: String(url).includes('user/me')
      ? { id: '380108001', username: 'bug' }
      : { url: 'wss://nws.kaiheila.cn/gateway?token=private-gateway-token&compress=0' } });
  };
  const gateway = new KookGateway({ token: 'private-bot-token',
    onEvent: async event => { events.push(event); }, fetchImpl, Socket,
    logger: (code, details) => logs.push({ code, details }), random: () => 0.5,
    now: () => now, setTimeoutImpl: (callback, delay) => {
      const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id;
    }, clearTimeoutImpl: id => timers.delete(id),
    heartbeatMs: 100, pongTimeoutMs: 6, pingRetryBaseMs: 2,
    handshakeTimeoutMs: 20, reconnectBaseMs: 2, resumeBaseMs: 2, reconnectMaxMs: 60,
    eventTimeoutMs: 1000, ...options,
  });
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      await flush();
      const [id, timer] = [...timers.entries()].filter(([, item]) => item.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer) break;
      now = timer.at; timers.delete(id); timer.callback();
    }
    now = end; await flush();
  };
  return { gateway, sockets, calls, events, logs, timers, advance };
}

test('gateway gets bot identity before opening only the fixed KOOK gateway endpoint', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start();
  assert.equal(h.gateway.snapshot().botId, '380108001');
  assert.deepEqual(h.calls.map(call => call.url), [
    'https://www.kookapp.cn/api/v3/user/me',
    'https://www.kookapp.cn/api/v3/gateway/index?compress=0',
  ]);
  for (const call of h.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, 'Bot private-bot-token');
    assert.equal(call.init.redirect, 'error');
  }
  h.sockets[0].open(); h.sockets[0].hello();
  assert.equal(h.gateway.snapshot().connected, true);
  assert.doesNotMatch(JSON.stringify(h.gateway.snapshot()), /private-|session-secret/);
});

test('out of order and repeated events are delivered once, in sequence order', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 2, d: { content: 'second' } });
  await flush(); assert.equal(h.events.length, 0);
  socket.packet({ s: 0, sn: 1, d: { content: 'first' } });
  socket.packet({ s: 0, sn: 1, d: { content: 'first duplicate' } });
  await flush();
  socket.packet({ s: 0, sn: 2, d: { content: 'second duplicate' } });
  await flush();
  assert.deepEqual(h.events.map(event => event.content), ['first', 'second']);
  assert.equal(h.gateway.snapshot().lastEventSn, 2);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
});

test('a sequence gap resumes despite healthy heartbeats and additional future events', async t => {
  const h = harness({ sequenceGapMs: 40, heartbeatMs: 10 }); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  first.packet({ s: 0, sn: 2, d: { number: 2 } });
  for (let i = 0; i < 3; i++) {
    await h.advance(10); first.packet({ s: 3 });
    first.packet({ s: 0, sn: i + 3, d: { number: i + 3 } });
  }
  await h.advance(9); assert.equal(h.gateway.snapshot().connected, true);
  await h.advance(1); assert.equal(h.gateway.snapshot().lastError, 'sequence_gap');
  assert.equal(h.events.length, 0);
  await h.advance(2); const second = h.sockets[1];
  assert.equal(new URL(second.url).searchParams.get('resume'), '1');
  assert.equal(new URL(second.url).searchParams.get('sn'), '0');
  second.open(); second.packet({ s: 6, d: { session_id: 'session-secret' } });
  for (const number of [1, 2, 3, 4, 5]) second.packet({ s: 0, sn: number, d: { number } });
  await h.advance(0);
  assert.deepEqual(h.events.map(event => event.number), [1, 2, 3, 4, 5]);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
  assert.equal(h.gateway.timers.has('gap'), false);
});

test('filling a temporary gap cancels recovery without reconnecting', async t => {
  const h = harness({ sequenceGapMs: 20 }); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 2, d: { number: 2 } });
  await h.advance(19); socket.packet({ s: 0, sn: 1, d: { number: 1 } });
  await h.advance(2);
  assert.deepEqual(h.events.map(event => event.number), [1, 2]);
  assert.equal(h.gateway.snapshot().connected, true);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.gateway.timers.has('gap'), false);
});

test('an unfinished handler does not start a sequence gap deadline', async t => {
  let complete;
  const handled = [];
  const h = harness({ sequenceGapMs: 20, onEvent: async event => {
    handled.push(event.number);
    if (event.number === 1) await new Promise(resolve => { complete = resolve; });
  } }); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 1, d: { number: 1 } });
  socket.packet({ s: 0, sn: 3, d: { number: 3 } });
  await h.advance(30);
  assert.equal(h.gateway.snapshot().connected, true);
  assert.equal(h.gateway.timers.has('gap'), false);
  complete(); await flush();
  await h.advance(19); socket.packet({ s: 0, sn: 2, d: { number: 2 } });
  await h.advance(2);
  assert.deepEqual(handled, [1, 2, 3]);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.gateway.timers.has('gap'), false);
});

test('slow asynchronous handlers do not block heartbeat; ping only acknowledges completed events', async t => {
  let complete;
  const h = harness({ onEvent: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 1, d: { content: 'sk-private-test' } });
  await flush(); await h.advance(100);
  assert.deepEqual(socket.sent, [{ s: 2, sn: 0 }]);
  socket.packet({ s: 3 });
  assert.equal(h.gateway.snapshot().lastPongAt, '1970-01-01T00:00:00.100Z');
  complete(); await flush(); await h.advance(100);
  assert.deepEqual(socket.sent[1], { s: 2, sn: 1 });
  assert.doesNotMatch(JSON.stringify(h.logs), /sk-private-test|private-bot|private-gateway/);
});

test('connection loss resumes the acknowledged sequence without duplicate deliveries', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  first.packet({ s: 0, sn: 1, d: { number: 1 } }); await flush();
  first.packet({ s: 0, sn: 3, d: { number: 3 } });
  first.close(); await h.advance(2);
  assert.equal(h.sockets.length, 2); assert.equal(h.calls.length, 2);
  const second = h.sockets[1], url = new URL(second.url);
  assert.equal(url.searchParams.get('resume'), '1');
  assert.equal(url.searchParams.get('sn'), '1');
  assert.equal(url.searchParams.get('session_id'), 'session-secret');
  second.open(); second.hello();
  second.packet({ s: 0, sn: 1, d: { number: 1 } });
  second.packet({ s: 0, sn: 2, d: { number: 2 } });
  second.packet({ s: 6, d: { session_id: 'session-secret' } });
  await flush();
  assert.deepEqual(h.events.map(event => event.number), [1, 2, 3]);
  assert.equal(h.gateway.snapshot().lastEventSn, 3);
});

test('server reconnect discards old sequence and acquires a fresh gateway', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  first.packet({ s: 0, sn: 3, d: { number: 3 } });
  first.packet({ s: 5, d: { code: 40107, err: 'unsafe sk-private-value' } });
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
  await h.advance(2); const second = h.sockets[1];
  assert.equal(h.calls.length, 3);
  assert.equal(new URL(second.url).searchParams.has('resume'), false);
  second.open(); second.hello('fresh-session');
  second.packet({ s: 0, sn: 1, d: { number: 1 } }); await flush();
  assert.deepEqual(h.events.map(event => event.number), [1]);
  assert.doesNotMatch(JSON.stringify(h.logs), /unsafe|sk-private|session-secret/);
});

test('missing pong retries twice then reconnects; abandoned socket messages are ignored', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  await h.advance(126);
  assert.equal(first.sent.length, 3);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.gateway.snapshot().connected, false);
  first.packet({ s: 0, sn: 1, d: { content: 'old message' } }); await flush();
  assert.equal(h.events.length, 0);
});

test('pending event count and bytes are bounded; overflow reconnects with prior sn', async t => {
  const h = harness({ maxBufferedEvents: 2 }); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  for (const sn of [2, 3, 4]) socket.packet({ s: 0, sn, d: { content: 'key' } });
  assert.equal(h.gateway.snapshot().pendingEvents, 2);
  assert.equal(h.gateway.snapshot().lastError, 'event_buffer_full');
  await h.advance(2);
  assert.equal(new URL(h.sockets[1].url).searchParams.get('sn'), '0');
  const bytes = harness({ maxBufferedBytes: 60 }); t.after(() => bytes.gateway.close());
  await bytes.gateway.start(); bytes.sockets[0].open(); bytes.sockets[0].hello();
  bytes.sockets[0].packet({ s: 0, sn: 2, d: { content: 'x'.repeat(80) } });
  assert.equal(bytes.gateway.snapshot().pendingEvents, 0);
  assert.equal(bytes.gateway.snapshot().lastError, 'event_buffer_full');
});

test('a full buffer accepts the missing next event and recovers evicted tail events', async t => {
  const h = harness({ maxBufferedEvents: 2, sequenceGapMs: 20 }); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  for (const number of [2, 3, 4]) first.packet({ s: 0, sn: number, d: { number } });
  assert.equal(h.gateway.snapshot().lastError, 'event_buffer_full');
  await h.advance(2); const second = h.sockets[1]; second.open(); second.hello();
  second.packet({ s: 0, sn: 1, d: { number: 1 } });
  assert.equal(h.gateway.snapshot().pendingEvents, 2);
  assert.ok(h.gateway.pendingBytes <= h.gateway.maxBufferedBytes);
  await flush();
  assert.deepEqual(h.events.map(event => event.number), [1, 2]);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
  // The discarded 3 and rejected 4 must not disappear merely because the queue is empty.
  await h.advance(20); assert.equal(h.gateway.snapshot().lastError, 'sequence_gap');
  await h.advance(2); const third = h.sockets[2];
  assert.equal(new URL(third.url).searchParams.get('sn'), '2');
  third.open(); third.packet({ s: 6, d: { session_id: 'session-secret' } });
  for (const number of [1, 2, 3, 4]) third.packet({ s: 0, sn: number, d: { number } });
  await flush();
  assert.deepEqual(h.events.map(event => event.number), [1, 2, 3, 4]);
  assert.equal(h.gateway.snapshot().lastEventSn, 4);
  assert.equal(h.gateway.timers.has('gap'), false);
});

test('the missing next event can reclaim multiple future entries without exceeding byte limits', async t => {
  const frame = (sn, content) => ({ s: 0, sn, d: { content } });
  const maxBufferedBytes = Buffer.byteLength(JSON.stringify(frame(2, 'x'))) * 3;
  const content = 'y'.repeat(maxBufferedBytes - Buffer.byteLength(JSON.stringify(frame(1, ''))));
  const h = harness({ maxBufferedBytes }); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  for (const sn of [2, 3, 4]) socket.packet(frame(sn, 'x'));
  assert.equal(h.gateway.pendingBytes, maxBufferedBytes);
  socket.packet(frame(1, content));
  assert.equal(h.gateway.pendingBytes, maxBufferedBytes);
  assert.equal(h.gateway.snapshot().pendingEvents, 1);
  await flush();
  assert.deepEqual(h.events.map(event => event.content), [content]);
  assert.equal(h.gateway.pendingBytes, 0);
  assert.equal(h.gateway.snapshot().lastEventSn, 1);
  assert.equal(h.gateway.timers.has('gap'), true);
});

test('malformed, oversized and binary frames reconnect without exposing their content', async t => {
  for (const raw of ['not-json sk-private', 'x'.repeat(513 * 1024), new ArrayBuffer(4)]) {
    const h = harness(); t.after(() => h.gateway.close());
    await h.gateway.start(); h.sockets[0].open(); h.sockets[0].hello(); h.sockets[0].raw(raw);
    assert.equal(h.gateway.snapshot().connected, false);
    assert.match(h.gateway.snapshot().lastError, /^invalid_(packet|frame)$/);
    assert.doesNotMatch(JSON.stringify(h.logs), /sk-private/);
  }
});

test('handler failures and timeouts are consumed without secret logs, and next event proceeds', async t => {
  const handled = [];
  const h = harness({ eventTimeoutMs: 10, onEvent: async (event, { signal }) => {
    handled.push(event.number);
    if (event.number === 1) throw new Error('sk-private-exception');
    if (event.number === 2) await new Promise(resolve => signal.addEventListener('abort', resolve));
  } }); t.after(() => h.gateway.close());
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  for (const number of [1, 2, 3]) socket.packet({ s: 0, sn: number, d: { number } });
  await flush(); await h.advance(10);
  assert.deepEqual(handled, [1, 2, 3]);
  assert.equal(h.gateway.snapshot().lastEventSn, 3);
  assert.doesNotMatch(JSON.stringify(h.logs), /sk-private-exception/);
});

test('close aborts in-flight handlers and prevents queued callbacks, timers and reconnects', async () => {
  const h = harness();
  await h.gateway.start(); const socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 1, d: { number: 1 } }); h.gateway.close();
  await flush(); await h.advance(1000);
  assert.equal(h.events.length, 0);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.gateway.snapshot().running, false);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
});

test('API failures, invalid gateways and oversized API responses only yield safe error codes', async t => {
  for (const [response, expected] of [
    [Response.json({ code: 40000, message: 'sk-private-reason' }), 'api_rejected'],
    [Response.json({ code: 0, data: { url: 'ws://nws.kaiheila.cn?token=private' } }), 'invalid_gateway'],
    [Response.json({ code: 0, data: { url: 'wss://kookapp.cn.evil.test/?token=private' } }), 'invalid_gateway'],
    [new Response('x'.repeat(65 * 1024)), 'api_response_too_large'],
  ]) {
    const h = harness({ fetchImpl: async url => String(url).includes('user/me')
      ? Response.json({ code: 0, data: { id: '380108001' } }) : response });
    t.after(() => h.gateway.close()); await h.gateway.start();
    assert.equal(h.gateway.snapshot().lastError, expected);
    assert.equal(h.sockets.length, 0);
    assert.doesNotMatch(JSON.stringify(h.logs), /sk-private|token=|evil/);
  }
});

test('HTTP read is aborted on close and does not create a socket afterwards', async () => {
  let requestSignal;
  const h = harness({ fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    requestSignal = signal;
    signal.addEventListener('abort', () => reject(new Error('private URL')));
  }) });
  const start = h.gateway.start(); await flush(); h.gateway.close(); await start;
  assert.equal(requestSignal.aborted, true);
  assert.equal(h.sockets.length, 0); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.logs, []);
});

test('two failed resume attempts fall back to a new gateway and clear old session state', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  first.packet({ s: 0, sn: 2, d: { number: 2 } });
  first.close(); await h.advance(2);
  assert.equal(new URL(h.sockets[1].url).searchParams.get('resume'), '1');
  h.sockets[1].close(); await h.advance(4);
  assert.equal(new URL(h.sockets[2].url).searchParams.get('resume'), '1');
  h.sockets[2].close(); await h.advance(8);
  assert.equal(new URL(h.sockets[3].url).searchParams.has('resume'), false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
});

test('successful resume handshakes without sequence progress eventually use a fresh session', async t => {
  const h = harness({ sequenceGapMs: 10 }); t.after(() => h.gateway.close());
  await h.gateway.start(); const first = h.sockets[0]; first.open(); first.hello();
  first.packet({ s: 0, sn: 2, d: { number: 2 } });
  for (const delay of [2, 4]) {
    await h.advance(10); assert.equal(h.gateway.snapshot().lastError, 'sequence_gap');
    await h.advance(delay); const resumed = h.sockets.at(-1);
    assert.equal(new URL(resumed.url).searchParams.get('resume'), '1');
    resumed.open(); resumed.packet({ s: 6, d: { session_id: 'session-secret' } });
    // Replayed future/duplicate events are not acknowledgement progress.
    resumed.packet({ s: 0, sn: 2, d: { number: 2 } });
  }
  await h.advance(10); await h.advance(2);
  assert.equal(h.sockets.length, 4);
  const fresh = h.sockets[3];
  assert.equal(new URL(fresh.url).searchParams.has('resume'), false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.gateway.snapshot().pendingEvents, 0);
  assert.equal(h.gateway.observedSn, 0);
  fresh.open(); fresh.hello('fresh-session');
  first.packet({ s: 0, sn: 1, d: { number: 'abandoned' } });
  fresh.packet({ s: 0, sn: 1, d: { number: 'fresh' } }); await flush();
  assert.deepEqual(h.events.map(event => event.number), ['fresh']);
  h.gateway.close(); await h.advance(100);
  assert.equal(h.timers.size, 0);
});

test('acknowledged events renew the resume budget after a successful recovery', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); let socket = h.sockets[0]; socket.open(); socket.hello();
  socket.packet({ s: 0, sn: 1, d: { number: 1 } }); await flush();
  for (const sn of [2, 3, 4]) {
    socket.close(); await h.advance(2); socket = h.sockets.at(-1);
    assert.equal(new URL(socket.url).searchParams.get('resume'), '1');
    socket.open(); socket.packet({ s: 6, d: { session_id: 'session-secret' } });
    socket.packet({ s: 0, sn, d: { number: sn } }); await flush();
    assert.equal(h.gateway.snapshot().lastEventSn, sn);
  }
  assert.deepEqual(h.events.map(event => event.number), [1, 2, 3, 4]);
  assert.equal(h.calls.length, 2);
});

test('handshake and HTTP timeouts do not leave a permanently connecting gateway', async t => {
  const h = harness(); t.after(() => h.gateway.close());
  await h.gateway.start(); await h.advance(20);
  assert.equal(h.gateway.snapshot().lastError, 'connect_timeout');
  await h.advance(2); assert.equal(h.sockets.length, 2);
  const api = harness({ apiTimeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private token')));
  }) }); t.after(() => api.gateway.close());
  const start = api.gateway.start(); await api.advance(5); await start;
  assert.equal(api.gateway.snapshot().lastError, 'connection_failed');
  assert.equal(api.sockets.length, 0);
  assert.doesNotMatch(JSON.stringify(api.logs), /private token/);
});
