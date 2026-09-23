import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InvitationClient } from '../src/invitations.js';
import { atomicJson } from '../src/storage.js';

const NOW = Date.parse('2026-09-23T17:00:00Z');
const PROGRAM = 'codex_referral_consumer';
const eligibility = (patch = {}) => ({ available_invites: 3, should_show: true, program_id: PROGRAM,
  requires_explicit_confirmation: false, fetched_at: NOW / 1000, ...patch });
const reply = data => Response.json({ code: 0, data });
const request = (patch = {}) => ({ email: 'friend@example.test', programId: PROGRAM, confirmed: false, requestId: randomUUID(), ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quota-invitations-'));
  const calls = [], updates = [];
  const account = { id: '6269', invitation: { supported: true } };
  const config = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-private-fixture', dataDir: directory,
    getAccount: id => id === account.id ? account : null, now: () => NOW,
    onUpdated: async (id, invitation) => { updates.push({ id, invitation }); account.invitation = invitation; },
    fetchImpl: async (url, init) => {
      calls.push({ path: new URL(url).pathname, ...init });
      if (options.fetch) return options.fetch(url, init, calls);
      return reply({ eligibility: eligibility(options.eligibility), cache_persisted: true,
        ...(url.pathname.endsWith('/invite') ? { sent: true, email: 'should-not-enter-journal@example.test', access_token: 'private-upstream' } : {}) });
    }, ...options.config };
  if (options.file !== undefined) await writeFile(path.join(directory, 'invitation-requests.json'), options.file);
  const client = await new InvitationClient(config).init();
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, calls, updates, account, config, directory, file: path.join(directory, 'invitation-requests.json') };
}

test('invitation refresh and send use fixed endpoints and persist a private pending record before delivery', async t => {
  let f;
  f = await fixture(t, { fetch: async (url, init) => {
    assert.equal(init.headers['x-api-key'], 'admin-private-fixture'); assert.equal(init.redirect, 'manual');
    if (url.pathname.endsWith('/invite')) {
      const journal = JSON.parse(await readFile(f.file, 'utf8'));
      assert.equal(journal.records[0].state, 'pending');
      assert.deepEqual(JSON.parse(init.body), { email: 'friend@example.test', program_id: PROGRAM, confirmed: false });
      return reply({ sent: true, eligibility: eligibility({ available_invites: 2 }), cache_persisted: true, email: 'private@example.test', token: 'secret-token' });
    }
    assert.equal(init.body, '{}'); return reply({ eligibility: eligibility(), cache_persisted: true });
  } });
  const result = await f.client.invite('6269', request());
  assert.equal(result.sent, true); assert.equal(result.invitation.availableCount, 2);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/v1/admin/openai/accounts/6269/referrals/refresh', '/api/v1/admin/openai/accounts/6269/referrals/invite']);
  assert.equal(f.updates.length, 2);
  const journal = await readFile(f.file, 'utf8');
  assert.doesNotMatch(journal, /@|secret|token|admin-/i); assert.doesNotMatch(JSON.stringify(result), /private|secret|token/i);
  assert.equal(JSON.parse(journal).records[0].state, 'sent');
});

test('fresh eligibility, program and explicit consent are authoritative before sending', async t => {
  for (const [patch, code] of [[{ available_invites: 0 }, 'UNAVAILABLE'], [{ available_invites: null }, 'UNAVAILABLE'],
    [{ should_show: false }, 'UNAVAILABLE'], [{ program_id: 'codex_referral_workspace' }, 'PROGRAM_CHANGED'],
    [{ requires_explicit_confirmation: true }, 'CONFIRMATION_REQUIRED']]) {
    await t.test(code + JSON.stringify(patch), async t => {
      const f = await fixture(t, { eligibility: patch });
      await assert.rejects(f.client.invite('6269', request()), error => error.code === code);
      assert.equal(f.calls.length, 1); assert.ok(f.calls[0].path.endsWith('/refresh'));
    });
  }
});

test('invalid recipients, paths, programs and request identifiers never reach Sub2API', async t => {
  const f = await fixture(t);
  for (const patch of [{ email: 'bad' }, { email: 'a@b.test\nBcc:person@other.test' }, { email: 'a'.repeat(260) + '@b.test' },
    { requestId: ['00000000-0000-4000-8000-000000000000'] }, { requestId: 'unsafe' }, { programId: '../../reset-quota' },
    { confirmed: 'true' }, { extra: true }]) await assert.rejects(f.client.invite('6269', request(patch)));
  for (const id of ['../6269', '6269/referrals/invite', '6270', 6269]) await assert.rejects(f.client.invite(id, request()));
  assert.equal(f.calls.length, 0);
});

test('authorization is rechecked after upstream refresh and after durable admission', async t => {
  const gate = deferred(); let allowed = true;
  const f = await fixture(t, { fetch: async () => { await gate.promise; return reply({ eligibility: eligibility(), cache_persisted: true }); } });
  const pending = f.client.invite('6269', request(), { authorize: () => allowed });
  await new Promise(resolve => setImmediate(resolve)); allowed = false; gate.resolve();
  await assert.rejects(pending, error => error.code === 'FORBIDDEN'); assert.equal(f.calls.length, 1);
  const writeGate = deferred(), entered = deferred(); allowed = true;
  const g = await fixture(t, { config: { writeState: async (file, data) => {
    if (data.records.some(record => record.state === 'pending')) { entered.resolve(); await writeGate.promise; }
    await atomicJson(file, data);
  } } });
  const second = g.client.invite('6269', request(), { authorize: () => allowed });
  await entered.promise; allowed = false; writeGate.resolve();
  await assert.rejects(second, error => error.code === 'FORBIDDEN'); assert.equal(g.calls.length, 1);
  assert.deepEqual(JSON.parse(await readFile(g.file, 'utf8')).records, []);
});

test('double submit and process restart cannot deliver the same request twice', async t => {
  const gate = deferred(); let deliveries = 0;
  const f = await fixture(t, { fetch: async url => {
    if (url.pathname.endsWith('/invite')) { deliveries++; await gate.promise; }
    return reply({ sent: true, eligibility: eligibility(), cache_persisted: true });
  } });
  const input = request();
  const first = f.client.invite('6269', input), second = f.client.invite('6269', input);
  await new Promise(resolve => setImmediate(resolve)); gate.resolve();
  assert.equal((await first).sent, true); assert.equal((await second).sent, true); assert.equal(deliveries, 1);
  await assert.rejects(f.client.invite('6269', { ...input, email: 'different@example.test' }), error => error.code === 'REQUEST_CONFLICT');
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'ALREADY_EXISTS');
  const restarted = await new InvitationClient({ ...f.config, fetchImpl: () => { throw new Error('must not deliver again'); } }).init();
  assert.equal((await restarted.invite('6269', input)).sent, true); await restarted.close();
});

test('an ambiguous send is recorded and cannot be retried under a new request id', async t => {
  let deliveries = 0;
  const f = await fixture(t, { fetch: async url => {
    if (url.pathname.endsWith('/invite')) { deliveries++; throw new Error('private token and email'); }
    return reply({ eligibility: eligibility(), cache_persisted: true });
  } });
  const input = request();
  await assert.rejects(f.client.invite('6269', input), error => error.code === 'SEND_UNKNOWN' && !/private|email/.test(error.message));
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).records[0].state, 'unknown');
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'SEND_UNKNOWN');
  const restarted = await new InvitationClient(f.config).init();
  await assert.rejects(restarted.invite('6269', input), error => error.code === 'SEND_UNKNOWN');
  await restarted.close(); assert.equal(deliveries, 1);
});

test('send timeout is bounded even if transport ignores abort and never auto-retries', async t => {
  let signal, deliveries = 0;
  const f = await fixture(t, { config: { sendTimeoutMs: 15 }, fetch: async (url, init) => {
    if (url.pathname.endsWith('/invite')) { deliveries++; signal = init.signal; return new Promise(() => {}); }
    return reply({ eligibility: eligibility(), cache_persisted: true });
  } });
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'SEND_UNKNOWN');
  assert.equal(signal.aborted, true); assert.equal(deliveries, 1);
});

test('failure to durably record intent blocks delivery but keeps refresh available', async t => {
  const f = await fixture(t, { config: { writeState: async () => { throw new Error('disk full'); } } });
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'STORAGE');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.client.refresh('6269')).invitation.availableCount, 3);
});

test('a sent invitation remains sent when the final journal or cache write fails', async t => {
  let writes = 0;
  const f = await fixture(t, { config: { writeState: async (file, data) => {
    if (++writes === 2) throw new Error('disk full after send'); await atomicJson(file, data);
  }, onUpdated: async () => { throw new Error('cache unavailable'); } } });
  const input = request(), result = await f.client.invite('6269', input);
  assert.equal(result.sent, true); assert.equal(result.cachePersisted, false);
  const restarted = await new InvitationClient(f.config).init();
  await assert.rejects(restarted.invite('6269', input), error => error.code === 'SEND_UNKNOWN'); await restarted.close();
  assert.equal(f.calls.filter(call => call.path.endsWith('/invite')).length, 1);
});

test('confirmed sends settle even when the final local write or cache update never settles', async t => {
  for (const blocked of ['journal', 'cache']) await t.test(blocked, async t => {
    const gate = deferred(); let writes = 0, updates = 0;
    const f = await fixture(t, { config: { localTimeoutMs: 50,
      // This case injects a stalled callback, not filesystem latency. Keep the
      // other writes immediate; real atomic durability is covered separately.
      writeState: async () => { if (++writes === 2 && blocked === 'journal') await gate.promise; },
      onUpdated: async () => { if (++updates === 2 && blocked === 'cache') await gate.promise; },
    } });
    const input = request(), pending = f.client.invite('6269', input); let timer;
    let outcome;
    try {
      outcome = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve({ stuck: true }), 500); })]);
    } finally { clearTimeout(timer); gate.resolve(); }
    assert.equal(outcome.sent, true); assert.equal(outcome.cachePersisted, false);
    await pending;
    if (blocked === 'journal') await assert.rejects(f.client.invite('6269', input), error => error.code === 'STORAGE');
    else assert.equal((await f.client.invite('6269', input)).sent, true);
    assert.equal(f.calls.filter(call => call.path.endsWith('/invite')).length, 1);
  });
});

test('a stalled pending journal blocks sends and keeps later writes serialized after timing out', async t => {
  const gate = deferred(), entered = deferred(), drained = deferred(); let writes = 0, active = 0, maximum = 0;
  const f = await fixture(t, { config: { localTimeoutMs: 50,
    getAccount: id => ['6269', '6270'].includes(id) ? { id, invitation: { supported: true } } : null,
    writeState: async (file, data) => {
      const number = ++writes; active++; maximum = Math.max(maximum, active);
      try {
        if (number === 1) { entered.resolve(); await gate.promise; }
        await atomicJson(file, data);
      } finally { active--; if (number === 2) drained.resolve(); }
    },
  } });
  const first = assert.rejects(f.client.invite('6269', request()), error => error.code === 'STORAGE');
  await entered.promise;
  const second = assert.rejects(f.client.invite('6270', request()), error => error.code === 'STORAGE');
  try {
    await Promise.all([first, second]);
    assert.equal(writes, 1); assert.equal(maximum, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/invite')).length, 0);
    let timer;
    try {
      const closed = await Promise.race([f.client.close().then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
      assert.equal(closed, true, 'Closing must not hang behind a stalled local write');
    } finally { clearTimeout(timer); }
  } finally { gate.resolve(); }
  let drainTimer;
  try { await Promise.race([drained.promise, new Promise((_, reject) => { drainTimer = setTimeout(() => reject(Error('Local writes did not drain')), 1000); })]); }
  finally { clearTimeout(drainTimer); }
  assert.equal(maximum, 1);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).records.length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/invite')).length, 0);
});

test('server errors stay ambiguous even when their response includes a normally retryable reason', async t => {
  for (const reason of ['REJECTED', 'UNAVAILABLE', 'ALREADY_EXISTS']) await t.test(reason, async t => {
    const f = await fixture(t, { fetch: async url => url.pathname.endsWith('/invite')
      ? Response.json({ code: 500, reason: `OPENAI_REFERRAL_${reason}` }, { status: 503 })
      : reply({ eligibility: eligibility(), cache_persisted: true }) });
    await assert.rejects(f.client.invite('6269', request()), error => error.code === 'SEND_UNKNOWN');
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).records[0].state, 'unknown');
    await assert.rejects(f.client.invite('6269', request()), error => error.code === 'SEND_UNKNOWN');
    assert.equal(f.calls.filter(call => call.path.endsWith('/invite')).length, 1);
  });
});

test('damaged journal fails closed without disabling cached view or eligibility refresh', async t => {
  const f = await fixture(t, { file: '{invalid' });
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'STORAGE');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.refresh('6269')).invitation.availableCount, 3);
});

test('known Sub2API errors are translated and raw messages never leave the client', async t => {
  const f = await fixture(t, { fetch: async url => url.pathname.endsWith('/invite')
    ? Response.json({ code: 400, reason: 'OPENAI_REFERRAL_ALREADY_EXISTS', message: 'admin-secret user@example.test' }, { status: 400 })
    : reply({ eligibility: eligibility(), cache_persisted: true }) });
  await assert.rejects(f.client.invite('6269', request()), error => error.code === 'ALREADY_EXISTS' && !/admin-|@/.test(error.message));
});

test('malformed, redirect and oversized send responses stay ambiguous', async t => {
  for (const make of [() => new Response('broken'), () => new Response('', { status: 302 }),
    () => new Response('x'.repeat(256 * 1024 + 1)), () => reply({ sent: false }), () => Response.json({}, { status: 503 })]) {
    await t.test('response boundary', async t => {
      const f = await fixture(t, { fetch: async url => url.pathname.endsWith('/invite') ? make() : reply({ eligibility: eligibility(), cache_persisted: true }) });
      await assert.rejects(f.client.invite('6269', request()), error => error.code === 'SEND_UNKNOWN');
      assert.equal(f.calls.length, 2);
    });
  }
});
