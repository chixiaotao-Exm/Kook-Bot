import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReportBot } from '../src/bot.js';
import { openStore, validateStore } from '../src/store.js';
import { CHANNEL_ID, DAY_MS, DRAFT_TTL_MS, normalizeNickname, RESULT_MESSAGES } from '../src/domain.js';

const USER = '1234567890123', OTHER = '1234567890124', BOT = '9999999999999', GUILD = '7654321098765';
const messageId = number => `aabbccdd-1234-4321-aabb-${String(number).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'report-bot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = overrides.store ?? await openStore(file);
  let now = 1_800_000_000_000, sequence = 1;
  const sends = [], submissions = [];
  const send = async (input, options) => { sends.push({ ...input, options }); return messageId(9000 + sends.length); };
  const submit = async (input, options) => { submissions.push({ input, options }); return { kind: 'success' }; };
  const bot = new ReportBot({ store, send, submit, enabled: true, now: () => now, ...overrides });
  t.after(() => bot.close());
  const event = (content = 'Player_01', patch = {}) => ({
    channel_type: 'GROUP', type: 1, target_id: CHANNEL_ID, author_id: USER,
    content, msg_id: messageId(sequence++), msg_timestamp: now,
    extra: { guild_id: GUILD, author: { id: USER, bot: false } }, ...patch
  });
  const handle = (input, options = {}) => bot.handle(input, { botId: BOT, ...options });
  const click = (card, action = 'confirm', body = {}, patch = {}) => ({
    // KOOK system callbacks legitimately have a PERSON envelope; the bound card body is authoritative.
    type: 255, channel_type: 'PERSON', target_id: BOT, author_id: '1', content: '',
    msg_id: messageId(sequence++), msg_timestamp: now,
    extra: { type: 'message_btn_click', body: {
      target_id: CHANNEL_ID, user_id: USER, msg_id: card.cardId,
      value: card.buttons.find(button => button.value.startsWith(`report:${action}:`)).value,
      user_info: { id: USER, bot: false }, ...body
    } }, ...patch
  });
  const preview = async (name = 'Player_01', patch = {}) => {
    now += 4000;
    await handle(event(name, patch));
    const card = sends.findLast(item => item.buttons);
    assert.ok(card, 'a preview was sent');
    return { ...card, cardId: messageId(9000 + sends.indexOf(card) + 1) };
  };
  return { bot, file, directory, store, sends, submissions, event, click, preview, handle,
    advance: (amount = 4000) => { now += amount; }, now: () => now };
}

test('preview preserves nickname case, strips only the leading tag, and never submits before confirm', async t => {
  const h = await setup(t);
  const card = await h.preview('举报 [ABC]Player_O1');
  assert.match(card.text, /举报昵称：Player_O1/);
  assert.match(card.text, /不预先断定.*作弊行为/);
  assert.match(card.text, /未提供具体对局时间或作弊证据/);
  assert.deepEqual(card.buttons.map(button => button.label), ['确认举报', '修改昵称', '取消']);
  assert.equal(h.submissions.length, 0);
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].input.player, 'Player_O1');
  assert.ok(h.submissions[0].options.signal instanceof AbortSignal);
  assert.equal(h.store.data.reports.player_o1.kind, 'success');
});

test('pending target marker and attempt budget are durably saved before the submitter is invoked', async t => {
  let h;
  h = await setup(t, { submit: async draft => {
    const saved = JSON.parse(await readFile(h.file, 'utf8'));
    assert.equal(saved.reports[draft.player.toLowerCase()].kind, 'pending');
    assert.equal(saved.attempts.length, 1);
    assert.deepEqual(Object.keys(saved.drafts), []);
    return { kind: 'success' };
  } });
  const card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.bot.status().success, 1);
});

test('an initiator can confirm immediately after the preview without the message throttle swallowing the click', async t => {
  const h=await setup(t);const card=await h.preview();await h.handle(h.click(card));
  assert.equal(h.submissions.length,1);await h.handle(h.click(card));assert.equal(h.submissions.length,1);
});

test('duplicate events and concurrent double clicks produce one preview and one submission', async t => {
  const h = await setup(t);
  const input = h.event();
  await Promise.all([h.handle(input), h.handle(input), h.handle(input)]);
  assert.equal(h.sends.length, 1);
  const card = { ...h.sends[0], cardId: messageId(9001) };
  h.advance(); const click = h.click(card);
  await Promise.all([h.handle(click), h.handle(click), h.handle(h.click(card))]);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.store.data.attempts.length, 1);
});

test('buttons reject wrong author, channel, card, stale time, malformed IDs, and explicit bot metadata', async t => {
  let identityCalls = 0;
  const h = await setup(t, { resolveButtonAuthor: async () => { identityCalls++; return { id: USER, bot: false }; } });
  const card = await h.preview(); h.advance();
  for (const action of ['confirm', 'cancel', 'edit']) {
    for (const body of [
      { user_id: OTHER, user_info: { id: OTHER, bot: false } },
      { target_id: '1234567890000' }, { msg_id: messageId(5000) },
      { user_id: BOT, user_info: { id: BOT, bot: false } },
      { user_info: { id: OTHER, bot: false } }, { user_info: { bot: true } },
      { user_info: { bot: 'false' } }, { user_info: null }, { user_info: [] }, { msg_id: '__proto__' }
    ]) await h.handle(h.click(card, action, body));
  }
  for (const patch of [{ msg_id: '__proto__' }, { msg_timestamp: h.now() - 300001 }, { msg_timestamp: h.now() + 60001 }])
    await h.handle(h.click(card, 'confirm', {}, patch));
  assert.equal(identityCalls, 0); assert.equal(h.sends.length, 1); assert.equal(h.submissions.length, 0);
  assert.equal(Object.keys(h.store.data.drafts).length, 1);
});

test('message scope and explicit author conflicts are rejected before identity/OCR calls', async t => {
  let lookups = 0, ocr = 0;
  const h = await setup(t, { resolveAuthor: async () => { lookups++; return { id: USER, bot: false }; },
    ocr: async () => { ocr++; return 'Player_01'; } });
  const invalid = [
    { channel_type: 'PERSON' }, { target_id: '1234567890000' }, { type: 10 },
    { author_id: BOT }, { author_id: '__proto__' }, { msg_id: '__proto__' },
    { msg_timestamp: h.now() - 300001 }, { msg_timestamp: h.now() + 60001 },
    { extra: { author: { id: OTHER, bot: false } } }, { extra: { author: { bot: true } } },
    { extra: { author: { bot: 'false' } } }, { extra: { author: null } }, { extra: { author: [] } }
  ];
  for (const patch of invalid) await h.handle(h.event('Player_01', patch));
  await h.bot.handle(h.event(), {});
  assert.equal(lookups, 0); assert.equal(ocr, 0); assert.equal(h.sends.length, 0);
});

test('missing message bot flag requires successful official resolution for the exact user', async t => {
  let answer = null; const calls = [];
  const h = await setup(t, { resolveAuthor: async (id, event) => { calls.push({ id, event }); return answer; } });
  const input = () => h.event('Player_01', { extra: { guild_id: GUILD, author: { id: USER } } });
  await h.handle(input()); answer = { id: USER, bot: true }; await h.handle(input());
  answer = { id: OTHER, bot: false }; await h.handle(input());
  assert.equal(h.sends.length, 0);
  answer = { id: USER, bot: false }; await h.handle(input());
  assert.equal(h.sends.length, 1); assert.equal(calls.length, 4);
  assert.equal(calls[3].id, USER); assert.ok(calls[3].event.signal instanceof AbortSignal);
});

test('button missing user_info resolves real human identity from the bound channel and draft guild', async t => {
  const calls = [];
  const h = await setup(t, { resolveButtonAuthor: async body => { calls.push(body); return { id: USER, bot: false }; } });
  const card = await h.preview(); h.advance();
  await h.handle(h.click(card, 'confirm', { user_info: undefined, guild_id: '000000000' }));
  assert.equal(calls.length, 1); assert.equal(calls[0].guild_id, GUILD);
  assert.equal(calls[0].target_id, CHANNEL_ID); assert.equal(calls[0].user_id, USER);
  assert.ok(calls[0].signal instanceof AbortSignal); assert.equal(h.submissions.length, 1);
});

test('unresolved button identity and absent identity dependency cannot submit', async t => {
  const h = await setup(t);
  const card = await h.preview(); h.advance();
  await h.handle(h.click(card, 'confirm', { user_info: undefined }));
  assert.equal(h.submissions.length, 0);
});

test('cancel is immediate and durable even inside the per-user cooldown', async t => {
  const h = await setup(t); const card = await h.preview();
  await h.handle(h.click(card, 'cancel'));
  assert.deepEqual(Object.keys(h.store.data.drafts), []);
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.match(h.sends.at(-1).text, /已取消/);
  const saved = JSON.parse(await readFile(h.file, 'utf8'));
  assert.deepEqual(saved.drafts, {});
});

test('modify nickname invalidates old buttons and only a new preview can be confirmed', async t => {
  const h = await setup(t), first = await h.preview(); h.advance();
  await h.handle(h.click(first, 'edit'));
  assert.match(h.sends.at(-1).text, /修改后的昵称/);
  h.advance(); await h.handle(h.click(first)); assert.equal(h.submissions.length, 0);
  const second = await h.preview('Correct_Name'); h.advance();
  await h.handle(h.click(first)); await h.handle(h.click(second));
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].input.player, 'Correct_Name');
});

test('new previews replace only the sender drafts and expired cards are unusable', async t => {
  const h = await setup(t), first = await h.preview();
  const other = await h.preview('OtherPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } });
  const second = await h.preview('NewPlayer');
  assert.equal(Object.keys(h.store.data.drafts).length, 2);
  h.advance(); await h.handle(h.click(first)); assert.equal(h.submissions.length, 0);
  h.advance(DRAFT_TTL_MS); await h.handle(h.click(second));
  await h.handle(h.click(other, 'confirm', { user_id: OTHER, user_info: { id: OTHER, bot: false } }));
  assert.equal(h.submissions.length, 0);
});

test('preview mode cannot invoke the real submitter and consumes no official attempt budget', async t => {
  const h = await setup(t, { enabled: false }); const card = await h.preview(); h.advance();
  await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(h.store.data.attempts.length, 0);
  assert.match(h.sends.at(-1).text, /未发送举报/);
});

for (const outcome of ['success', 'verification', 'unknown']) {
  test(`${outcome} outcomes block case-insensitive target duplicates for 24h across users and restart`, async t => {
    const h = await setup(t, { submit: async () => ({ kind: outcome, message: 'do not echo private@example.test' }) });
    const card = await h.preview('Player_Name'); h.advance(); await h.handle(h.click(card));
    assert.equal(h.store.data.reports.player_name.kind, outcome);
    const persisted = await openStore(h.file);
    h.bot.store = persisted;
    const again = await h.preview('pLaYeR_nAmE', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } });
    h.advance(); await h.handle(h.click(again, 'confirm', { user_id: OTHER, user_info: { id: OTHER, bot: false } }));
    assert.equal(h.bot.status().attempts, 1); assert.match(h.sends.at(-1).text, /不会重复发送/);
    assert.ok(h.sends.every(item => !item.text.includes('private@example.test')));
  });
}

test('uncaught submitter failure is unknown, never definitely not_sent, and never auto-retried', async t => {
  const h = await setup(t, { submit: async () => { throw new Error('private@example.test'); } });
  const card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.store.data.reports.player_01.kind, 'unknown');
  assert.match(h.sends.at(-1).text, /结果未知/);
  assert.doesNotMatch(h.sends.at(-1).text, /private@example/);
});

test('definite not_sent can be retried only with another confirmed preview and counts against daily budget', async t => {
  const h = await setup(t, { submit: async () => ({ kind: 'not_sent' }) });
  const card = await h.preview(); h.advance(); await h.handle(h.click(card));
  h.advance(); await h.handle(h.click(card)); assert.equal(h.bot.status().attempts, 1);
  const again = await h.preview(); h.advance(); await h.handle(h.click(again));
  assert.equal(h.bot.status().attempts, 2); assert.equal(h.store.data.attempts.length, 2);
});

test('target protection ends at 24h only after an explicit fresh confirmation', async t => {
  const h = await setup(t); let card = await h.preview(); h.advance(); await h.handle(h.click(card));
  const attemptedAt = h.store.data.reports.player_01.at;
  h.advance(DAY_MS - (h.now() - attemptedAt) - 8001);
  card = await h.preview('PLAYER_01'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1);
  h.advance(2); await h.handle(h.click(card));
  // The failed duplicate click also has its own user cooldown.
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 2);
});

test('persistent global one-second and user three-second cooldowns reject bursts across fresh message IDs', async t => {
  const h = await setup(t);
  await h.handle(h.event('FirstPlayer'));
  await h.handle(h.event('SecondPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } }));
  assert.equal(h.sends.length, 1);
  h.advance(1000);
  await h.handle(h.event('SecondPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } }));
  assert.equal(h.sends.length, 2);
  h.bot.store = await openStore(h.file);
  h.advance(1000); await h.handle(h.event('ThirdPlayer'));
  assert.equal(h.sends.length, 2);
  h.advance(1000); await h.handle(h.event('ThirdPlayer'));
  assert.equal(h.sends.length, 3);
});

test('pre-submit storage failure prevents official traffic and fails readiness closed', async t => {
  const h = await setup(t); const card = await h.preview();
  const save = h.store.save.bind(h.store);
  h.store.save = async () => {
    if (Object.values(h.store.data.reports).some(item => item.kind === 'pending')) throw new Error('disk full');
    await save();
  };
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(h.bot.status().ready, false);
  h.advance(); await h.handle(h.event('FreshPlayer')); assert.equal(h.sends.length, 1);
});

test('result-save failure keeps durable pending, restores unknown on restart and blocks resubmission', async t => {
  const h = await setup(t); const card = await h.preview();
  const save = h.store.save.bind(h.store);
  h.store.save = async () => {
    if (Object.values(h.store.data.reports).some(item => item.kind === 'success')) throw new Error('disk full');
    await save();
  };
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.bot.status().ready, false);
  assert.equal(h.store.data.reports.player_01.kind, 'unknown');
  const disk = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(disk.reports.player_01.kind, 'pending');
  const restart = await openStore(h.file);
  assert.equal(restart.data.reports.player_01.kind, 'unknown');
  assert.equal(restart.data.attempts.length, 1);
});

test('failure to send the processing notice proves official submission never started', async t => {
  const h = await setup(t); const card = await h.preview();
  h.bot.send = async input => { if (input.text.startsWith('⏳')) throw new Error('KOOK down'); return messageId(9999); };
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(h.store.data.reports.player_01.kind, 'not_sent');
});

test('per-user fifth-attempt boundary and rolling channel twentieth-attempt boundary are persisted', async t => {
  const h = await setup(t);
  h.store.data.attempts = Array.from({ length: 5 }, () => ({ at: h.now(), author: USER }));
  let card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.match(h.sends.at(-1).text, /提交上限/);
  h.store.data.attempts = Array.from({ length: 19 }, () => ({ at: h.now(), author: OTHER }));
  card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.store.data.attempts.length, 20);
  card = await h.preview('AnotherPlayer'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1);
  h.advance(DAY_MS); card = await h.preview('AnotherPlayer'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 2); assert.equal(h.store.data.attempts.length, 1);
});

test('preview/OCR hourly budget blocks external OCR before work and recovers after expiry', async t => {
  let ocrCalls = 0;
  const h = await setup(t, { ocr: async (_event, { signal }) => { assert.ok(signal instanceof AbortSignal); ocrCalls++; return 'FromImage'; } });
  h.store.data.previews = Array.from({ length: 60 }, () => h.now());
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.equal(ocrCalls, 0); assert.match(h.sends.at(-1).text, /60 次预览/);
  h.advance(60 * 60_000 + 1);
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.equal(ocrCalls, 1); assert.match(h.sends.at(-1).text, /举报昵称：FromImage/);
  assert.equal(h.submissions.length, 0);
});

test('multi-line OCR and ambiguous clan strings never become report targets', async t => {
  const h = await setup(t, { ocr: async () => 'PlayerOne\nPlayerTwo' });
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.deepEqual(Object.keys(h.store.data.drafts), []); assert.match(h.sends.at(-1).text, /一行昵称/);
  assert.equal(normalizeNickname('【CLAN】 Oo0_I1l'), 'Oo0_I1l');
  for (const raw of ['[CLANPlayer', '[A][B]Player', 'one two', 'ab', 'a\u0000b']) assert.throws(() => normalizeNickname(raw));
});

test('queue is bounded at eight and shutdown aborts OCR and drains queued work without sending', async t => {
  let started; const gate = new Promise(resolve => { started = resolve; });
  let signal;
  const h = await setup(t, { ocr: async (_event, options) => { signal = options.signal; started(); return new Promise(() => {}); } });
  const work = h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  await gate;
  const queued = Array.from({ length: 20 }, () => h.handle(h.event('QueuedPlayer')));
  assert.equal(h.bot.status().pending, 8);
  await h.bot.close(); await Promise.all([work, ...queued]);
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().pending, 0);
  assert.equal(h.bot.status().active, 0); assert.equal(h.sends.length, 0); assert.equal(h.submissions.length, 0);
});

test('shutdown during official operation records unknown durably and cannot resume a late promise', async t => {
  let started, finish; const gate = new Promise(resolve => { started = resolve; }); let signal;
  const h = await setup(t, { submit: async (_draft, options) => {
    signal = options.signal; started(); return new Promise(resolve => { finish = resolve; });
  } });
  const card = await h.preview(); h.advance(); const work = h.handle(h.click(card)); await gate;
  await h.bot.close(); await work;
  assert.equal(signal.aborted, true); assert.equal(h.store.data.reports.player_01.kind, 'unknown');
  finish({ kind: 'success' }); await tick();
  const disk = await openStore(h.file);
  assert.equal(disk.data.reports.player_01.kind, 'unknown');
  assert.equal(h.sends.length, 2);
});

test('submit timeout remains unknown and does not block subsequent read-only status', async t => {
  const h = await setup(t, { submit: async () => new Promise(() => {}), timeouts: { submit: 15 } });
  const card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.store.data.reports.player_01.kind, 'unknown');
  h.advance(); await h.handle(h.event('状态 PLAYER_01'));
  assert.match(h.sends.at(-1).text, /结果未知/);
  assert.equal(h.bot.status().ready, true);
});

test('uncertain storage timeout fails closed even if its delayed operation eventually resolves', async t => {
  const h = await setup(t, { timeouts: { storage: 10 } });
  const card = await h.preview(); let finish;
  h.store.save = () => new Promise(resolve => { finish = resolve; });
  h.advance(); await h.handle(h.click(card));
  assert.equal(h.bot.status().ready, false); assert.equal(h.submissions.length, 0);
  finish(); await tick();
  h.advance(); await h.handle(h.event('NextPlayer'));
  assert.equal(h.sends.length, 1);
});

test('unexpired seen capacity refuses new work instead of dropping replay protection', async t => {
  const h = await setup(t);
  for (let index = 0; index < 2000; index++) h.store.data.seen[messageId(10000 + index)] = h.now();
  await h.handle(h.event()); assert.equal(h.sends.length, 0); assert.equal(Object.keys(h.store.data.seen).length, 2000);
  h.advance(DAY_MS); await h.handle(h.event()); assert.equal(h.sends.length, 1);
  assert.equal(Object.keys(h.store.data.seen).length, 1);
});

test('unknown records protected within 24h are never evicted to make room for another target', async t => {
  const h = await setup(t);
  for (let index = 0; index < 2000; index++) h.store.data.reports[`player_${index}`] = { at: h.now(), kind: 'unknown', message: RESULT_MESSAGES.unknown };
  const card = await h.preview('NewTarget'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(Object.keys(h.store.data.reports).length, 2000);
  assert.match(h.sends.at(-1).text, /容量已满/);
});

test('case-insensitive reserved property nickname is handled as data without prototype pollution', async t => {
  const h = await setup(t); const card = await h.preview('__proto__'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.store.data.reports.__proto__.kind, 'success');
  assert.equal(Object.getPrototypeOf(h.store.data.reports), null);
  assert.equal({}.kind, undefined);
  const restored = await openStore(h.file);
  assert.equal(Object.getPrototypeOf(restored.data.reports), null);
  assert.equal(restored.data.reports.__proto__.kind, 'success');
});

test('store rejects corrupt or oversized schema instead of silently resetting dedupe records', async t => {
  const h = await setup(t);
  for (const contents of ['{bad json', '{}', 'null', JSON.stringify({ seen: [], drafts: {}, reports: {} }),
    JSON.stringify({ seen: {}, drafts: {}, reports: { player: { kind: 'surprise', at: h.now() } } })]) {
    await writeFile(h.file, contents);
    await assert.rejects(openStore(h.file), /状态文件/);
  }
  await writeFile(h.file, 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(openStore(h.file), /状态文件/);
});

test('snapshot writes are atomic and an I/O failure permanently prevents reuse of that store', async t => {
  const h = await setup(t); h.store.data.seen[messageId(1)] = h.now();
  await h.store.save();
  const disk = await openStore(h.file); assert.equal(disk.data.seen[messageId(1)], h.now());
  const badPath = path.join(h.directory, 'destination'); await mkdir(badPath);
  const store = await openStore(path.join(h.directory, 'temporary.json'));
  // A directory at the target makes rename fail; subsequent saves must stay closed even after removal.
  const destination = path.join(h.directory, 'temporary.json'); await mkdir(destination);
  await assert.rejects(store.save(), /状态保存失败/); await rm(destination, { recursive: true });
  await assert.rejects(store.save(), /状态保存失败/);
});

test('store validation discards unrecognized private fields and reconstitutes neutral drafts only', () => {
  const data = validateStore({ seen: {}, drafts: {}, reports: {}, password: 'private', profile: { email: 'private' } });
  assert.equal(data.password, undefined); assert.equal(data.profile, undefined);
  assert.equal(Object.getPrototypeOf(data.seen), null);
});

test('status exposes safe counts and does not include users, targets, payloads or requester profile', async t => {
  const h = await setup(t); await h.preview('PrivateTarget');
  const status = JSON.stringify(h.bot.status());
  assert.doesNotMatch(status, /PrivateTarget|1234567890123|description|email|steam/);
  assert.equal(h.bot.status().ready, true); assert.equal(h.bot.status().previews, 1);
});
