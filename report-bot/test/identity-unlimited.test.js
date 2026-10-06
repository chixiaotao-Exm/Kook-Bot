import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorResolver } from '../src/kook-identity.js';

const GUILD = '7654321098765';
const user = index => String(1234567890000 + index);
const request = index => ({ userId: user(index), guildId: GUILD });
const success = (url, bot = false) => Response.json({ code: 0, data: {
  id: new URL(url).searchParams.get('user_id'), bot,
} });

test('more than 30 different users resolve within the same minute', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', now: () => 1800000000000,
    fetchImpl: async url => { calls++; return success(url); } });
  for (let index = 0; index < 40; index++) {
    assert.deepEqual(await resolve(request(index)), { id: user(index), bot: false });
  }
  assert.equal(calls, 40);
});

test('more than two simultaneous distinct identity requests are all resolved', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', fetchImpl: async url => {
    calls++; await gate; return success(url);
  } });
  const tasks = Array.from({ length: 8 }, (_, index) => resolve(request(index)));
  try { assert.equal(calls, 8); }
  finally { release(); }
  assert.deepEqual(await Promise.all(tasks), Array.from({ length: 8 }, (_, index) => ({ id: user(index), bot: false })));
});

test('concurrent requests for the same identity share one official lookup', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', fetchImpl: async url => {
    calls++; await gate; return success(url);
  } });
  const tasks = Array.from({ length: 10 }, () => resolve(request(1)));
  try { assert.equal(calls, 1); }
  finally { release(); }
  const results = await Promise.all(tasks);
  assert.ok(results.every(result => result.id === user(1) && result.bot === false));
  assert.notEqual(results[0], results[1]);
  assert.deepEqual(await resolve(request(1)), { id: user(1), bot: false });
  assert.equal(calls, 1);
});

test('a failed lookup can be retried immediately without a negative-cache delay', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', now: () => 1800000000000,
    fetchImpl: async url => ++calls === 1 ? new Response(null, { status: 503 }) : success(url) });
  assert.equal(await resolve(request(1)), null);
  assert.deepEqual(await resolve(request(1)), { id: user(1), bot: false });
  assert.equal(calls, 2);
});

test('cache eviction allows a fresh lookup instead of denying additional users', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', now: () => 1800000000000,
    fetchImpl: async url => { calls++; return success(url); } });
  for (let index = 0; index < 257; index++) {
    assert.deepEqual(await resolve(request(index)), { id: user(index), bot: false });
  }
  assert.deepEqual(await resolve(request(0)), { id: user(0), bot: false });
  assert.equal(calls, 258);
});

test('verified bot identities remain bots for the caller authorization check', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', fetchImpl: async url => {
    calls++; return success(url, true);
  } });
  assert.deepEqual(await resolve(request(1)), { id: user(1), bot: true });
  assert.deepEqual(await resolve(request(1)), { id: user(1), bot: true });
  assert.equal(calls, 1);
});

test('invalid identities and oversized official responses remain rejected', async () => {
  let calls = 0;
  const resolve = createAuthorResolver({ token: 'test-token', fetchImpl: async () => {
    calls++; return new Response('x'.repeat(32 * 1024 + 1));
  } });
  assert.equal(await resolve({ userId: 'bad', guildId: GUILD }), null);
  assert.equal(await resolve({ userId: user(1), guildId: 'bad' }), null);
  assert.equal(calls, 0);
  assert.equal(await resolve(request(1)), null);
  assert.equal(calls, 1);
});
