import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorResolver } from '../src/kook-identity.js';

const userId = '123456789', guildId = '987654321';
const input = { userId, guildId };
const success = (id = userId, bot = false) => Response.json({ code: 0, data: { id, bot } });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('queries only the fixed identity endpoint and strips unneeded profile details', async () => {
  const calls = [];
  const resolve = createAuthorResolver({ token: 'fixture-private-token', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ code: 0, data: { id: userId, bot: false, username: 'private-name', roles: [1] } });
  } });
  assert.deepEqual(await resolve(input), { id: userId, bot: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://www.kookapp.cn/api/v3/user/view?user_id=${userId}&guild_id=${guildId}`);
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bot fixture-private-token');
});

test('validates user and guild identifiers without network calls', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', fetchImpl: async () => { calls++; return success(); } });
  for (const query of [{}, { ...input, userId: 123456789 }, { ...input, guildId: 987654321 },
    { ...input, userId: '123' }, { ...input, guildId: '9'.repeat(31) },
    { ...input, userId: `${userId}&other=true` }, { ...input, guildId: 'https://evil.test' }]) {
    assert.equal(await resolve(query), null);
  }
  assert.equal(calls, 0);
  assert.throws(() => createAuthorResolver({ token: 'private\r\nheader' }), /Invalid KOOK identity configuration/);
});

test('only exact user identity and boolean bot flags are accepted; errors stay private', async () => {
  for (const response of [() => success('11111111'),
    () => Response.json({ code: 0, data: { id: userId } }),
    () => success(userId, 'false'), () => success(userId, 0),
    () => Response.json({ code: 40000, message: 'secret-token private-details' }),
    () => new Response('private error', { status: 429 }),
    () => new Response('private invalid json'),
    () => { throw new Error('secret-token https://private.example'); }]) {
    const resolve = createAuthorResolver({ token: 'fixture-token', fetchImpl: async () => response() });
    assert.equal(await resolve(input), null);
  }
});

test('caches known humans and robots for five minutes without exposing mutable cache entries', async () => {
  let time = 1000, calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', now: () => time, fetchImpl: async url => {
    calls++; const id = new URL(url).searchParams.get('user_id'); return success(id, id !== userId);
  } });
  const first = await resolve(input); first.bot = true;
  assert.deepEqual(await resolve(input), { id: userId, bot: false });
  assert.deepEqual(await resolve({ ...input, userId: '11111111' }), { id: '11111111', bot: true });
  assert.deepEqual(await resolve({ ...input, userId: '11111111' }), { id: '11111111', bot: true });
  assert.equal(calls, 2);
  time += 299999; await resolve(input); assert.equal(calls, 2);
  time++; await resolve(input); assert.equal(calls, 3);
});

test('failed lookups back off for ten seconds and then recover', async () => {
  let time = 0, calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', now: () => time, fetchImpl: async () => {
    calls++; if (calls === 1) throw new Error('private failure'); return success();
  } });
  assert.equal(await resolve(input), null); time = 9999;
  assert.equal(await resolve(input), null); assert.equal(calls, 1);
  time = 10000; assert.deepEqual(await resolve(input), { id: userId, bot: false }); assert.equal(calls, 2);
});

test('singleflights the same user and guild and limits network concurrency to two', async () => {
  const waiting = defer(); let calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', fetchImpl: async url => {
    calls++; await waiting.promise; return success(new URL(url).searchParams.get('user_id'));
  } });
  const first = resolve(input), duplicate = resolve(input);
  const second = resolve({ ...input, guildId: '11111111' });
  assert.equal(calls, 2);
  assert.equal(await resolve({ ...input, userId: '22222222' }), null);
  waiting.resolve();
  assert.deepEqual(await first, { id: userId, bot: false });
  assert.deepEqual(await duplicate, { id: userId, bot: false });
  assert.deepEqual(await second, { id: userId, bot: false });
  assert.equal(calls, 2);
});

test('globally limits fresh lookups to thirty per rolling minute', async () => {
  let time = 0, calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', now: () => time, fetchImpl: async url => {
    calls++; return success(new URL(url).searchParams.get('user_id'));
  } });
  for (let n = 0; n < 30; n++) assert.ok(await resolve({ ...input, userId: String(10000000 + n) }));
  assert.equal(await resolve(input), null); assert.equal(calls, 30);
  time = 59999; assert.equal(await resolve(input), null);
  time = 60000; assert.ok(await resolve(input)); assert.equal(calls, 31);
});

test('bounded LRU cache evicts the least recently used identity before it expires', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'fixture-token', now: () => 0, maxCacheEntries: 3, fetchImpl: async url => {
    calls++; return success(new URL(url).searchParams.get('user_id'));
  } });
  const queries = [0, 1, 2, 3].map(n => ({ ...input, userId: String(10000000 + n) }));
  for (const query of queries.slice(0, 3)) await resolve(query);
  await resolve(queries[0]); assert.equal(calls, 3);
  await resolve(queries[3]); assert.equal(calls, 4);
  await resolve(queries[0]); assert.equal(calls, 4);
  await resolve(queries[1]); assert.equal(calls, 5);
  assert.throws(() => createAuthorResolver({ token: 'fixture-token', maxCacheEntries: 257 }), /Invalid KOOK/);
});

test('hard timeout releases the slot even if an injected fetch ignores abort and adds failure backoff', async () => {
  let calls = 0, requestSignal;
  const resolve = createAuthorResolver({ token: 'fixture-token', timeoutMs: 10, fetchImpl: async (_url, init) => {
    calls++; requestSignal = init.signal; return new Promise(() => {});
  } });
  assert.equal(await resolve(input), null); assert.equal(requestSignal.aborted, true);
  assert.equal(await resolve(input), null); assert.equal(calls, 1);
});

test('bounds response size and cancels a stalled body at the hard deadline', async () => {
  for (const response of [() => new Response('x'.repeat(33000)),
    () => new Response('{}', { headers: { 'content-length': '33000' } })]) {
    const resolve = createAuthorResolver({ token: 'fixture-token', fetchImpl: async () => response() });
    assert.equal(await resolve(input), null);
  }
  let cancelled = false;
  const resolve = createAuthorResolver({ token: 'fixture-token', timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"code":0')); },
    cancel() { cancelled = true; },
  })) });
  assert.equal(await resolve(input), null); assert.equal(cancelled, true);
});
