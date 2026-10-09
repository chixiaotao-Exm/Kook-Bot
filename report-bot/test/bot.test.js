import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReportBot } from '../src/bot.js';
import { createOcr } from '../src/ocr.js';
import { openStore, validateStore } from '../src/store.js';
import { CHANNEL_ID, DAY_MS, normalizeNickname, RESULT_MESSAGES } from '../src/domain.js';
import { parseReporters, mailboxHash } from '../src/reporters.js';

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

test('mail receipt reference is persisted before submission and survives restart', async t => {
  const h = await setup(t, { mailEnabled: true });
  const card = await h.preview('Player_01'); await h.handle(h.click(card));
  const record = h.store.data.reports.player_01;
  assert.match(record.mailRef, /^KOOK-[a-f0-9]{32}$/);
  assert.equal(record.player, 'Player_01'); assert.ok(h.submissions[0].input.subject.endsWith('[' + record.mailRef + ']'));
  const restored = await openStore(h.file); assert.equal(restored.data.reports.player_01.mailRef, record.mailRef);
  assert.match(h.sends.at(-1).text, /自动核对 Gmail/);
});

test('official mail confirms unknown once and updates status without another submission', async t => {
  const h = await setup(t, { mailEnabled: true, submit: async () => ({ kind: 'unknown' }) });
  const card = await h.preview('Player_01'); await h.handle(h.click(card));
  const candidate = h.bot.mailCandidates()[0];
  const receipt = { messageId: '10:200', ticketId: '81234567', receivedAt: h.now() + 1000 };
  assert.equal(await h.bot.confirmMail(candidate, receipt), true);
  assert.equal(await h.bot.confirmMail(candidate, receipt), false);
  assert.equal(h.store.data.reports.player_01.kind, 'success');
  assert.equal(h.sends.filter(item => item.text.includes('邮箱已确认提交')).length, 1);
  await h.bot.flushMailNotifications(); assert.equal(h.sends.filter(item => item.text.includes('邮箱已确认提交')).length, 1);
  h.advance(); await h.handle(h.event('状态 Player_01')); assert.match(h.sends.at(-1).text, /工单 #81234567/);
  const restored = await openStore(h.file); assert.equal(restored.data.reports.player_01.mail.notification, 'attempted');
  assert.equal(restored.data.attempts.length, 1);
});

test('stale mail candidates, not-sent reports and reused ticket IDs cannot confirm another attempt', async t => {
  const h = await setup(t, { mailEnabled: true });
  const first = await h.preview('Player_01'); await h.handle(h.click(first));
  const candidate = h.bot.mailCandidates()[0], receipt = { messageId: '10:200', ticketId: '81234567', receivedAt: h.now() };
  assert.equal(await h.bot.confirmMail({ ...candidate, at: candidate.at - 1 }, receipt), false);
  assert.equal(await h.bot.confirmMail({ ...candidate, mailRef: 'KOOK-' + '0'.repeat(32) }, receipt), false);
  assert.equal(await h.bot.confirmMail(candidate, receipt), true);
  const second = await h.preview('Player_02'); await h.handle(h.click(second));
  assert.equal(await h.bot.confirmMail(h.bot.mailCandidates()[0], receipt), false);
  h.store.data.reports.player_02.kind = 'not_sent'; assert.equal(h.bot.mailCandidates().length, 0);
});

test('mail notification send timeout is not retried and mail write failure does not claim success', async t => {
  const h = await setup(t, { mailEnabled: true, submit: async () => ({ kind: 'unknown' }) });
  const card = await h.preview(); await h.handle(h.click(card)); const candidate = h.bot.mailCandidates()[0];
  let sends = 0; h.bot.send = async () => { sends++; throw Error('delivery unknown'); };
  await h.bot.confirmMail(candidate, { messageId: '1:2', ticketId: '12345', receivedAt: h.now() });
  await h.bot.flushMailNotifications(); assert.equal(sends, 1);
  const second = await setup(t, { mailEnabled: true, submit: async () => ({ kind: 'unknown' }) });
  const preview = await second.preview(); await second.handle(second.click(preview));
  second.store.save = async () => { throw Error('disk'); };
  assert.equal(await second.bot.confirmMail(second.bot.mailCandidates()[0], { messageId: '1:3', ticketId: '12346', receivedAt: second.now() }), false);
  assert.equal(second.store.data.reports.player_01.kind, 'unknown'); assert.equal(second.bot.status().ready, false);
});

test('desktop image-only cards reach OCR and require an initiator confirmation before submission', async t => {
  let imageEvent;
  const h = await setup(t, { ocr: async event => { imageEvent = event; return '[ABC] EXAMPLE_PLAYER'; } });
  const url = 'https://img.kookapp.cn/assets/nickname.png';
  const content = JSON.stringify([{ theme: 'invisible', size: 'lg', modules: [{ type: 'container', elements: [{ type: 'image', src: url, width: 165, height: 39 }] }] }]);
  const card = await h.preview(content, { type: 10 });
  assert.equal(imageEvent.type, 2); assert.equal(imageEvent.content, url);
  assert.equal(imageEvent.author_id, USER); assert.equal(imageEvent.target_id, CHANNEL_ID);
  assert.match(card.text, /举报昵称：EXAMPLE_PLAYER/); assert.equal(h.submissions.length, 0);
  await h.handle(h.click(card, 'confirm', { user_id: OTHER })); assert.equal(h.submissions.length, 0);
  await h.handle(h.click(card)); assert.equal(h.submissions.length, 1);
});

test('ambiguous or malformed image cards request a single image without running OCR', async t => {
  let calls = 0;
  const h = await setup(t, { ocr: async () => { calls++; return 'Player_01'; } });
  const image = { type: 'image', src: 'https://img.kookapp.cn/assets/nickname.png' };
  const module = { type: 'container', elements: [image] };
  for (const input of ['{', 'null', '{}', '[]', JSON.stringify([null]),
    JSON.stringify([{ modules: [module] }, { modules: [module] }]),
    JSON.stringify([{ modules: [module, { type: 'section', text: { content: 'Player_02' } }] }]),
    JSON.stringify([{ modules: [{ ...module, elements: [image, image] }] }]),
    JSON.stringify([{ modules: [{ ...module, elements: [{ type: 'image', src: '' }] }] }])]) {
    h.advance(); await h.handle(h.event(input, { type: 10 }));
    assert.match(h.sends.at(-1).text, /一次发送一张/);
  }
  assert.equal(calls, 0); assert.equal(h.submissions.length, 0); assert.equal(h.store.data.previews.length, 0);
});

test('image cards retain channel and bot-author filtering', async t => {
  let calls = 0;
  const h = await setup(t, { ocr: async () => { calls++; return 'Player_01'; } });
  const content = JSON.stringify([{ type: 'card', modules: [{ type: 'image-group', elements: [{ type: 'image', src: 'https://img.kookapp.cn/assets/a.png' }] }] }]);
  await h.handle(h.event(content, { type: 10, target_id: OTHER }));
  await h.handle(h.event(content, { type: 10, extra: { guild_id: GUILD, author: { id: USER, bot: true } } }));
  assert.equal(calls, 0); assert.equal(h.sends.length, 0);
  await h.preview(content, { type: 10 }); assert.equal(calls, 1);
});

test('image cards retain OCR URL and multiple-attachment guards before network access', async t => {
  let calls = 0;
  const h = await setup(t, { ocr: createOcr({ token: 'test', fetchImpl: async () => { calls++; throw Error('unexpected network'); } }) });
  const card = src => JSON.stringify([{ modules: [{ type: 'container', elements: [{ type: 'image', src }] }] }]);
  await h.handle(h.event(card('https://evil.example/image.png'), { type: 10 }));
  h.advance();
  await h.handle(h.event(card('https://img.kookapp.cn/assets/a.png'), { type: 10, extra: {
    guild_id: GUILD, author: { id: USER, bot: false }, attachments: [{ url: 'a' }, { url: 'b' }]
  } }));
  assert.equal(calls, 0); assert.equal(h.sends.length, 2);
  for (const reply of h.sends) assert.match(reply.text, /图片识别失败/);
  assert.equal(Object.keys(h.store.data.drafts).length, 0); assert.equal(h.submissions.length, 0);
});

test('pending target marker and attempt history are durably saved before the submitter is invoked', async t => {
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
    { channel_type: 'PERSON' }, { target_id: '1234567890000' }, { type: 3 },
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

test('cancel is immediate and durable after a preview', async t => {
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

test('multiple previews stay independently confirmable and do not expire after a day', async t => {
  const h = await setup(t), first = await h.preview();
  const other = await h.preview('OtherPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } });
  const second = await h.preview('NewPlayer');
  assert.equal(Object.keys(h.store.data.drafts).length, 3);
  h.advance(); await h.handle(h.click(first)); assert.equal(h.submissions.length, 1);
  h.advance(DAY_MS); await h.handle(h.click(second));
  await h.handle(h.click(other, 'confirm', { user_id: OTHER, user_info: { id: OTHER, bot: false } }));
  assert.equal(h.submissions.length, 3);
});

test('editing multiple previews replaces one draft per correction without dropping the others', async t => {
  const h = await setup(t), first = await h.preview('FirstPlayer'), second = await h.preview('SecondPlayer');
  await h.handle(h.click(first, 'edit')); await h.handle(h.click(second, 'edit'));
  const one = await h.preview('FirstCorrected');
  assert.equal(Object.values(h.store.data.drafts).filter(d => d.editing).length, 1);
  const two = await h.preview('SecondCorrected');
  assert.equal(Object.keys(h.store.data.drafts).length, 2);
  await h.handle(h.click(one)); await h.handle(h.click(two));
  assert.deepEqual(h.submissions.map(x => x.input.player), ['FirstCorrected', 'SecondCorrected']);
});

test('preview mode cannot invoke the real submitter and adds no submission history', async t => {
  const h = await setup(t, { enabled: false }); const card = await h.preview(); h.advance();
  await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(h.store.data.attempts.length, 0);
  assert.match(h.sends.at(-1).text, /未发送举报/);
});

for (const outcome of ['success', 'verification', 'unknown']) {
  test(`${outcome} outcomes allow a fresh confirmed preview for the same nickname after restart`, async t => {
    const h = await setup(t, { submit: async () => ({ kind: outcome, message: 'do not echo private@example.test' }) });
    const card = await h.preview('Player_Name'); h.advance(); await h.handle(h.click(card));
    assert.equal(h.store.data.reports.player_name.kind, outcome);
    const persisted = await openStore(h.file);
    h.bot.store = persisted;
    const again = await h.preview('pLaYeR_nAmE', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } });
    h.advance(); await h.handle(h.click(again, 'confirm', { user_id: OTHER, user_info: { id: OTHER, bot: false } }));
    assert.equal(h.bot.status().attempts, 2); assert.equal(persisted.data.attempts.length, 2);
    assert.doesNotMatch(h.sends.at(-1).text, /已有 24 小时内/);
    await h.handle(h.click(again, 'confirm', { user_id: OTHER, user_info: { id: OTHER, bot: false } }));
    assert.equal(h.bot.status().attempts, 2);
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

test('definite not_sent can be retried only with another confirmed preview and retains attempt history', async t => {
  const h = await setup(t, { submit: async () => ({ kind: 'not_sent' }) });
  const card = await h.preview(); h.advance(); await h.handle(h.click(card));
  h.advance(); await h.handle(h.click(card)); assert.equal(h.bot.status().attempts, 1);
  const again = await h.preview(); h.advance(); await h.handle(h.click(again));
  assert.equal(h.bot.status().attempts, 2); assert.equal(h.store.data.attempts.length, 2);
});

test('same-user manual retry uses a new receipt reference and rejects stale mail confirmation', async t => {
  const h = await setup(t, { mailEnabled: true });
  const original = await h.preview(); await h.handle(h.click(original));
  const previous = h.bot.mailCandidates()[0];
  const again = await h.preview('PLAYER_01');
  assert.equal(h.submissions.length, 1); // Preparing a retry alone never submits it.
  await h.handle(h.click(original)); assert.equal(h.submissions.length, 1);
  await h.handle(h.click(again)); assert.equal(h.submissions.length, 2);
  const latest = h.bot.mailCandidates()[0];
  assert.notEqual(latest.mailRef, previous.mailRef);
  assert.ok(latest.at - previous.at < DAY_MS);
  assert.equal(await h.bot.confirmMail(previous, { messageId: '1:200', ticketId: '12345', receivedAt: h.now() }), false);
  assert.equal(h.store.data.reports.player_01.mail, undefined);
  assert.equal(h.store.data.attempts.length, 2);
});

test('same-user confirmed retries are not limited to five daily submissions', async t => {
  const h = await setup(t);
  for (let attempt = 0; attempt < 6; attempt++) {
    const card = await h.preview('Player_01'); await h.handle(h.click(card));
  }
  assert.equal(h.submissions.length, 6); assert.equal(h.store.data.attempts.length, 6);
  assert.doesNotMatch(h.sends.at(-1).text, /提交上限/);
});

test('distinct same-second messages are processed without global or per-user cooldowns after restart', async t => {
  const h = await setup(t);
  await h.handle(h.event('FirstPlayer'));
  await h.handle(h.event('SecondPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } }));
  assert.equal(h.sends.length, 2);
  await h.handle(h.event('SecondPlayer', { author_id: OTHER, extra: { author: { id: OTHER, bot: false } } }));
  assert.equal(h.sends.length, 3);
  h.bot.store = await openStore(h.file);
  await h.handle(h.event('ThirdPlayer'));
  assert.equal(h.sends.length, 4);
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

test('result-save failure keeps durable pending and restores unknown without replaying a submission', async t => {
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

test('existing daily attempt history never blocks another explicit submission, including after restart', async t => {
  const h = await setup(t);
  h.store.data.attempts = Array.from({ length: 5 }, () => ({ at: h.now(), author: USER }));
  let card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.store.data.attempts.length, 6);
  h.store.data.attempts = Array.from({ length: 20 }, () => ({ at: h.now(), author: OTHER }));
  await h.store.save(); h.bot.store = await openStore(h.file);
  card = await h.preview(); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 2); assert.equal(h.bot.store.data.attempts.length, 21);
  await h.handle(h.click(card)); assert.equal(h.submissions.length, 2);
});

test('attempt history can grow beyond the former capacity without blocking submission', async t => {
  const h = await setup(t);
  h.store.data.attempts = Array.from({ length: 2000 }, () => ({ at: h.now() - 1000, author: OTHER }));
  const card = await h.preview(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.bot.status().ready, true);
  const disk = await openStore(h.file);
  assert.equal(disk.data.attempts.length, 2001);
  assert.deepEqual(disk.data.attempts.at(-1), { at: h.now(), author: USER });
  assert.equal(disk.data.reports.player_01.kind, 'success');
});

test('legacy hourly preview history never blocks another OCR request', async t => {
  let ocrCalls = 0;
  const h = await setup(t, { ocr: async (_event, { signal }) => { assert.ok(signal instanceof AbortSignal); ocrCalls++; return 'FromImage'; } });
  h.store.data.previews = Array.from({ length: 60 }, () => h.now());
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.equal(ocrCalls, 1); assert.match(h.sends.at(-1).text, /举报昵称：FromImage/);
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.equal(ocrCalls, 2); assert.match(h.sends.at(-1).text, /举报昵称：FromImage/);
  assert.equal(h.submissions.length, 0);
});

test('multi-line OCR and ambiguous clan strings never become report targets', async t => {
  const h = await setup(t, { ocr: async () => 'PlayerOne\nPlayerTwo' });
  await h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  assert.deepEqual(Object.keys(h.store.data.drafts), []); assert.match(h.sends.at(-1).text, /一行昵称/);
  assert.equal(normalizeNickname('【CLAN】 Oo0_I1l'), 'Oo0_I1l');
  for (const raw of ['[CLANPlayer', '[A][B]Player', 'one two', 'ab', 'a\u0000b']) assert.throws(() => normalizeNickname(raw));
});

test('queue accepts more than eight tasks and shutdown cancels pending work without sending', async t => {
  let started; const gate = new Promise(resolve => { started = resolve; });
  let signal;
  const h = await setup(t, { ocr: async (_event, options) => { signal = options.signal; started(); return new Promise(() => {}); } });
  const work = h.handle(h.event('https://cdn.example.invalid/nickname.png', { type: 2 }));
  await gate;
  const queued = Array.from({ length: 20 }, () => h.handle(h.event('QueuedPlayer')));
  assert.equal(h.bot.status().pending, 21);
  await h.bot.close(); await Promise.all([work, ...queued]);
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().pending, 0);
  assert.equal(h.bot.status().active, 0); assert.equal(h.sends.length, 0); assert.equal(h.submissions.length, 0);
});

test('fresh messages remain processable after waiting in a long task queue', async t => {
  let begin, finish; const started = new Promise(resolve => { begin = resolve; });
  const h = await setup(t, { ocr: async () => { begin(); return new Promise(resolve => { finish = resolve; }); } });
  const first = h.handle(h.event('https://img.kookapp.cn/test.png', { type: 2 })); await started;
  const queued = h.handle(h.event('QueuedPlayer')); h.advance(10 * 60_000);
  finish('ImagePlayer'); await Promise.all([first, queued]);
  assert.equal(h.sends.filter(item => item.buttons).length, 2);
  const delayed = h.event('GatewayQueued', { msg_timestamp: h.now() - 10 * 60_000 });
  await h.handle(delayed, { receivedAt: delayed.msg_timestamp });
  assert.match(h.sends.at(-1).text, /GatewayQueued/);
});

test('more than two hundred pending previews remain usable after restart', async t => {
  const h = await setup(t); let first;
  for (let i = 0; i < 201; i++) { const card = await h.preview('Player_' + i); first ||= card; }
  assert.equal(Object.keys(h.store.data.drafts).length, 201);
  h.bot.store = await openStore(h.file); h.advance(DAY_MS);
  await h.handle(h.click(first)); assert.equal(h.submissions[0].input.player, 'Player_0');
  assert.equal(Object.keys(h.bot.store.data.drafts).length, 200);
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

test('seen history beyond the former capacity accepts new work without losing replay protection', async t => {
  const h = await setup(t);
  for (let index = 0; index < 2000; index++) h.store.data.seen[messageId(10000 + index)] = h.now();
  const input = h.event(); await h.handle(input); await h.handle(input);
  assert.equal(h.sends.length, 1); assert.equal(Object.keys(h.store.data.seen).length, 2001);
  h.advance(DAY_MS); await h.handle(h.event()); assert.equal(h.sends.length, 2);
  assert.equal(Object.keys(h.store.data.seen).length, 1);
});

test('new targets work beyond the former record capacity while retaining older unknown results', async t => {
  const h = await setup(t);
  for (let index = 0; index < 2000; index++) h.store.data.reports[`player_${index}`] = { at: h.now(), kind: 'unknown', message: RESULT_MESSAGES.unknown };
  const card = await h.preview('NewTarget'); h.advance(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(Object.keys(h.store.data.reports).length, 2001);
  assert.equal(h.store.data.reports.player_0.kind, 'unknown');
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

test('store rejects corrupt data instead of silently resetting dedupe records', async t => {
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

const fixedSettings = { email: 'receipts@gmail.com', language: 'english' };
const accountText = '76561198000000001\tReporter_1\n76561198000000002\tReporter_2\n76561198000000003\tReporter_3';
const accounts = () => parseReporters(accountText, fixedSettings);

test('TXT account count controls sequential submissions, with durable per-account markers and no replay', async t => {
  let h, active = 0, calls = 0;
  h = await setup(t, { getReporters: async () => accounts(), submit: async (draft, { profile, signal }) => {
    assert.equal(++active, 1); assert.ok(signal instanceof AbortSignal);
    const saved = JSON.parse(await readFile(h.file, 'utf8')), index = calls++;
    const batch = saved.reports.player_01;
    assert.deepEqual(Object.keys(saved.drafts), []);
    assert.equal(batch.results[index].kind, 'pending'); assert.equal(saved.attempts.length, index + 1);
    assert.equal(profile.steam, accounts()[index].steam);
    assert.equal(profile.nickname, accounts()[index].nickname);
    assert.equal(profile.email, fixedSettings.email); assert.equal(profile.language, fixedSettings.language);
    assert.equal(draft.player, 'Player_01');
    await tick(); active--; return { kind: 'success' };
  } });
  const card = await h.preview(); assert.match(card.text, /举报人账号：3 个/); assert.match(card.text, /预计提交 3 次/);
  assert.equal(calls, 0);
  await h.handle(h.click(card, 'confirm', { user_id: OTHER })); assert.equal(calls, 0);
  const click = h.click(card); await Promise.all([h.handle(click), h.handle(click), h.handle(h.click(card))]);
  assert.equal(calls, 3); assert.equal(h.bot.status().success, 3);
  assert.match(h.sends.at(-1).text, /成功 3 · 未发送 0/);
  assert.doesNotMatch(JSON.stringify(h.sends), /receipts@gmail|7656119800000000|Reporter_[123]/);
  const disk = await openStore(h.file); assert.equal(disk.data.version, 2);
  assert.equal(disk.data.reports.player_01.results.length, 3);
  assert.ok(disk.data.reports.player_01.results.every(item => item.kind === 'success'));
  await h.handle(h.event('状态 Player_01')); assert.match(h.sends.at(-1).text, /成功 3/);
});

test('duplicate TXT rows do not increase count and a new preview uses the updated file', async t => {
  let text = accountText + '\n' + accountText.split('\n')[0];
  const h = await setup(t, { getReporters: async () => parseReporters(text, fixedSettings) });
  const first = await h.preview(); await h.handle(h.click(first)); assert.equal(h.submissions.length, 3);
  text = accountText.split('\n')[0];
  const second = await h.preview(); assert.match(second.text, /预计提交 1 次/);
  await h.handle(h.click(second)); assert.equal(h.submissions.length, 4);
  assert.equal(h.store.data.reports.player_01.results.length, 1);
});

test('changed identity, nickname, count or shared email invalidates an already displayed preview', async t => {
  for (const changed of [accounts().slice(0, 2), accounts().map((item, i) => i ? item : { ...item, steam: '76561198000000004' }),
    accounts().map(item => ({ ...item, email: 'changed@gmail.com' })), accounts().map(item => ({ ...item, nickname: item.nickname + 'X' })),
    accounts().map(item => ({ ...item, language: 'korean' }))]) {
    let current = accounts();
    const h = await setup(t, { getReporters: async () => current });
    const card = await h.preview(); current = changed; await h.handle(h.click(card));
    assert.equal(h.submissions.length, 0); assert.match(h.sends.at(-1).text, /账号列表已变化/);
    assert.deepEqual(Object.keys(h.store.data.drafts), []);
  }
});

test('a saved preview retains the account snapshot across restart, while legacy previews require confirmation anew', async t => {
  const h = await setup(t, { getReporters: async () => accounts() });
  const card = await h.preview(); h.bot.store = await openStore(h.file);
  await h.handle(h.click(card)); assert.equal(h.submissions.length, 3);
  const legacy = await setup(t); const oldCard = await legacy.preview();
  legacy.bot.getReporters = async () => accounts(); await legacy.handle(legacy.click(oldCard));
  assert.equal(legacy.submissions.length, 0); assert.match(legacy.sends.at(-1).text, /重新发送昵称/);
});

test('an unreadable or invalid list cannot submit or silently fall back to one account', async t => {
  let fail = false;
  const h = await setup(t, { getReporters: async () => { if (fail) throw Error('private path and mailbox'); return accounts(); } });
  const card = await h.preview(); fail = true; await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.match(h.sends.at(-1).text, /本次未提交/);
  assert.doesNotMatch(h.sends.at(-1).text, /private path/);
  await h.handle(h.event('AnotherPlayer')); assert.equal(h.sends.filter(item => item.buttons).length, 1);
});

test('preview mode displays the batch count but never calls the submitter', async t => {
  const h = await setup(t, { getReporters: async () => accounts(), enabled: false });
  const card = await h.preview(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 0); assert.equal(h.store.data.attempts.length, 0);
  assert.match(h.sends.at(-1).text, /已确认 3 个账号.*未发送举报/);
});

test('known not-sent results remain distinct from successful accounts in the batch summary', async t => {
  let count = 0;
  const h = await setup(t, { getReporters: async () => accounts(), submit: async () => ({ kind: count++ === 1 ? 'not_sent' : 'success' }) });
  const card = await h.preview(); await h.handle(h.click(card));
  assert.equal(count, 3); assert.match(h.sends.at(-1).text, /成功 2 · 未发送 1/);
  const disk = await openStore(h.file);
  assert.deepEqual(disk.data.reports.player_01.results.map(item => item.kind), ['success', 'not_sent', 'success']);
});

for (const kind of ['verification', 'unknown']) {
  test(`a ${kind} result stops remaining accounts without retrying earlier accounts`, async t => {
    let count = 0;
    const h = await setup(t, { getReporters: async () => accounts(), submit: async () => ({ kind: count++ ? kind : 'success' }) });
    const card = await h.preview(); await h.handle(h.click(card));
    assert.equal(count, 2); assert.equal(h.store.data.attempts.length, 2);
    assert.deepEqual(h.store.data.reports.player_01.results.map(item => item.kind), ['success', kind, 'not_sent']);
    assert.match(h.sends.at(-1).text, /已停止本批后续提交/);
    await h.handle(h.click(card)); assert.equal(count, 2);
  });
}

test('shutdown or timeout preserves the active account as unknown and never starts remaining accounts', async t => {
  for (const shutdown of [true, false]) {
    let started, finish, count = 0;
    const gate = new Promise(resolve => { started = resolve; });
    const h = await setup(t, { getReporters: async () => accounts(), timeouts: { submit: shutdown ? 1000 : 15 },
      submit: async () => { if (!count++) return { kind: 'success' }; started(); return new Promise(resolve => { finish = resolve; }); } });
    const card = await h.preview(); const work = h.handle(h.click(card)); await gate;
    if (shutdown) await h.bot.close();
    await work; finish({ kind: 'success' }); await tick();
    const disk = await openStore(h.file);
    assert.equal(count, 2); assert.equal(disk.data.reports.player_01.finished, true);
    assert.deepEqual(disk.data.reports.player_01.results.map(item => item.kind), ['success', 'unknown', 'not_sent']);
    assert.deepEqual(Object.keys(disk.data.drafts), []);
  }
});

test('each account has an independent mail reference and receipt, including after restart', async t => {
  const h = await setup(t, { getReporters: async () => accounts(), mailEnabled: true, receiptMailbox: fixedSettings.email });
  const card = await h.preview(); await h.handle(h.click(card));
  const candidates = h.bot.mailCandidates(); assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map(item => item.mailRef)).size, 3);
  for (const [index, item] of candidates.entries()) {
    assert.ok(h.submissions[index].input.subject.endsWith('[' + item.mailRef + ']'));
    assert.equal(item.mailboxHash, mailboxHash(fixedSettings.email));
  }
  const receipt = { messageId: '10:200', ticketId: '81234567', receivedAt: h.now() };
  assert.equal(await h.bot.confirmMail({ ...candidates[1], batchId: 'outdated' }, receipt), false);
  assert.equal(await h.bot.confirmMail(candidates[1], receipt), true);
  assert.equal(await h.bot.confirmMail(candidates[0], receipt), false);
  assert.equal(h.bot.mailCandidates().length, 2);
  assert.match(h.sends.at(-1).text, /本次账号序号：2/);
  h.bot.store = await openStore(h.file);
  assert.equal(h.bot.store.data.reports.player_01.results[1].mail.ticketId, receipt.ticketId);
  assert.equal(h.bot.mailCandidates().length, 2);
  await h.handle(h.event('状态 Player_01')); assert.match(h.sends.at(-1).text, /邮箱已确认 1 次/);
  const newer = await h.preview(); await h.handle(h.click(newer));
  assert.equal(await h.bot.confirmMail(candidates[0], { ...receipt, ticketId: '81234568', messageId: '10:201' }), false);
});

test('a storage failure before the next account prevents that submission and all subsequent accounts', async t => {
  const h = await setup(t, { getReporters: async () => accounts() });
  const save = h.store.save;
  h.store.save = async () => {
    if (h.store.data.reports.player_01?.results?.[1].kind === 'pending') throw Error('disk failure');
    return save();
  };
  const card = await h.preview(); await h.handle(h.click(card));
  assert.equal(h.submissions.length, 1); assert.equal(h.bot.status().ready, false);
  const disk = await openStore(h.file);
  assert.deepEqual(disk.data.reports.player_01.results.map(item => item.kind), ['success', 'not_sent', 'not_sent']);
});

test('crash recovery retains per-account uncertainty and refuses corrupt batch state', async t => {
  let started;
  const gate = new Promise(resolve => { started = resolve; });
  const h = await setup(t, { getReporters: async () => accounts(), submit: async () => { started(); return new Promise(() => {}); } });
  const card = await h.preview(); const work = h.handle(h.click(card)); await gate;
  const persisted = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(persisted.reports.player_01.results[0].kind, 'pending');
  const restored = validateStore(persisted);
  assert.deepEqual(restored.reports.player_01.results.map(item => item.kind), ['unknown', 'not_sent', 'not_sent']);
  assert.equal(restored.reports.player_01.finished, true);
  for (const mutate of [value => { value.reports.player_01.results = []; },
    value => { value.reports.player_01.results[1].reporterId = value.reports.player_01.results[0].reporterId; },
    value => { value.reports.player_01.results[0].mailboxHash = 'bad'; },
    value => { value.reports.player_01.results[0].kind = 'bad'; },
    value => { value.reports.player_01.batchId = 'bad'; }]) {
    const bad = structuredClone(persisted); mutate(bad); assert.throws(() => validateStore(bad), /状态文件结构无效/);
  }
  await h.bot.close(); await work;
});
