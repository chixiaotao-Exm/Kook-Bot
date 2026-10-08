import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookSender, KookDeliveryError } from '../src/kook.js';
import { OPS_CHANNELS } from './fixtures/channels.js';

const TOKEN = 'fixture-token-private', ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const note = changes => ({ category: 'infra', title: '服务异常', lines: ['服务待恢复'], theme: 'danger', ...changes });
const config = extra => ({ token: TOKEN, channelIds: OPS_CHANNELS, publicUrl: 'https://api.example.com/ops/', ...extra });
const ok = () => Response.json({ code: 0, data: { msg_id: ID } });

test('category selects only the two authorized channels and sends plain text cards once', async () => {
  const calls = []; const send = createKookSender(config({ fetchImpl: async (url, options) => { calls.push({ url, options }); return ok(); } }));
  for (const category of ['infra', 'web']) assert.deepEqual(await send(note({ category })), { messageId: ID });
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).target_id), Object.values(OPS_CHANNELS));
  for (const call of calls) {
    assert.equal(call.url, 'https://www.kookapp.cn/api/v3/message/create'); assert.equal(call.options.redirect, 'manual');
    const body = JSON.parse(call.options.body); assert.deepEqual(Object.keys(body).sort(), ['content', 'target_id', 'type']);
    const card = JSON.parse(body.content)[0]; assert.equal(card.theme, 'danger');
    assert.ok(card.modules.filter(module => module.text).every(module => module.text.type === 'plain-text' && module.text.emoji === false));
  }
});

test('sender removes keys, configured token, mentions, URLs and unsafe control characters', async () => {
  let body;
  const send = createKookSender(config({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return ok(); } }));
  await send(note({ title: '@all (met)123456(met) 状态', lines: [
    `${TOKEN} sk-private-secret123 admin-privatesecret123 github_pat_privatefixture123 password=secretpass`,
    'https://private.example/path?secret=yes member@example.test\u0000\u202e <@123> @here',
  ] }));
  assert.doesNotMatch(JSON.stringify(body), /fixture-token-private|private-secret|privatesecret|privatefixture|secretpass|private\.example|member@example|\(met\)|<@|@all|@here|\u202e/);
});

test('sender captures custom configured destinations and rejects missing, duplicate or extra channels', async () => {
  const channelIds = { infra: '3333333333333333', web: '4444444444444444' }, calls = [];
  const send = createKookSender(config({ channelIds, fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return ok(); } }));
  channelIds.infra = '5555555555555555';
  await send(note()); await send(note({ category: 'web' }));
  assert.deepEqual(calls.map(call => call.target_id), ['3333333333333333', '4444444444444444']);
  for (const invalid of [undefined, null, {}, [], { infra: OPS_CHANNELS.infra },
    { infra: OPS_CHANNELS.infra, web: OPS_CHANNELS.infra }, { ...OPS_CHANNELS, other: '3333333333333333' }]) {
    assert.throws(() => createKookSender(config({ channelIds: invalid })), KookDeliveryError);
  }
});

test('input and channel overrides are rejected before sending', async () => {
  let calls = 0; const send = createKookSender(config({ fetchImpl: () => { calls++; return ok(); } }));
  for (const patch of [{ category: 'other' }, { targetId: OPS_CHANNELS.infra }, { theme: 'custom' }, { lines: Array(13).fill('x') },
    { title: 'a'.repeat(101) }, { lines: ['a'.repeat(501)] }]) await assert.rejects(send(note(patch)), error => error.code === 'INPUT');
  assert.equal(calls, 0);
  assert.throws(() => createKookSender(config({ channelIds: { ...OPS_CHANNELS, web: 'not-a-channel' } })), KookDeliveryError);
  assert.throws(() => createKookSender(config({ publicUrl: 'https://user:secret@example.test' })), KookDeliveryError);
});

test('rate limit, rejection, server failure and unknown delivery never automatically repeat a send', async () => {
  for (const [status, code, delivery] of [[429, 'RATE_LIMITED', 'rejected'], [403, 'REJECTED', 'rejected'], [500, 'REJECTED', 'uncertain'], [302, 'REDIRECT', 'uncertain']]) {
    let calls = 0; const send = createKookSender(config({ fetchImpl: async () => { calls++; return new Response('private upstream', { status }); } }));
    await assert.rejects(send(note()), error => error.code === code && error.delivery === delivery && !error.message.includes('private'));
    assert.equal(calls, 1);
  }
  for (const response of [Response.json({ code: 0, data: {} }), new Response('invalid'), new Response('x'.repeat(32769)), new Response(new Uint8Array([0xff]))]) {
    await assert.rejects(createKookSender(config({ fetchImpl: async () => response }))(note()), error => error.code === 'RESPONSE' && error.delivery === 'uncertain');
  }
});

test('timeouts, pre-cancellation and shutdown bound uncooperative fetch and response readers', async () => {
  let signal, calls = 0;
  const send = createKookSender(config({ timeoutMs: 15, fetchImpl: async (_url, options) => { signal = options.signal; calls++; return new Promise(() => {}); } }));
  await assert.rejects(send(note()), error => error.code === 'TIMEOUT'); assert.equal(signal.aborted, true); assert.equal(calls, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(send(note(), { signal: aborted.signal }), error => error.code === 'CANCELLED' && error.delivery === 'rejected'); assert.equal(calls, 1);
  const active = new AbortController(); const sending = send(note(), { signal: active.signal }); active.abort();
  await assert.rejects(sending, error => error.code === 'CANCELLED' && error.delivery === 'uncertain');
  let cancelled = false;
  const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } });
  await assert.rejects(createKookSender(config({ timeoutMs: 15, fetchImpl: async () => new Response(body) }))(note()), error => error.code === 'TIMEOUT');
  assert.equal(cancelled, true);
});
