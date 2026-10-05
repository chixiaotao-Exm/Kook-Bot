import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReceipt, matchReceipts } from '../src/mail-match.js';

const at = Date.UTC(2026, 9, 5, 12);
const player = 'OVERSEAS_YOSHI';
const mailRef = 'KOOK-0123456789abcdef0123456789abcdef';
const record = { at, player, mailRef, kind: 'unknown' };
const options = { mailbox: 'reporter@gmail.com', now: at + 5 * 60_000 };
const base = {
  id: '12345:67890', internalDate: String(at + 60_000),
  subject: `Request received #123456: ${player} ${mailRef}`,
  fromAddress: 'support@pubg.com', toAddresses: ['reporter@gmail.com'],
  authenticationResults: ['mx.google.com; dkim=pass header.d=pubg.com; dmarc=pass header.from=pubg.com'],
  bodyText: `Hello,\nYour request (123456) has been received and is being reviewed by our support staff.\nOriginal request: ${player}\nReference: ${mailRef}`
};
const match = (change = {}, item = record, config = options) => matchReceipt({ ...base, ...change }, item, config);

test('matches a correlated authenticated Zendesk acknowledgement without returning private data', () => {
  assert.deepEqual(match(), { messageId: base.id, ticketId: '123456', receivedAt: at + 60_000 });
  assert.deepEqual(Object.keys(match()).sort(), ['messageId', 'receivedAt', 'ticketId']);
});

test('accepts DKIM alignment or DMARC alignment from the first Google authentication result', () => {
  for (const authenticationResults of [
    'mx.google.com; dkim=pass header.d=pubg.com',
    ['other.mail.example; dmarc=pass header.from=pubg.com', 'mx.google.com; dmarc=pass header.from=pubg.com'],
    ['mx.google.com 1;\r\n\tdkim=pass header.i=@pubg.com'],
    ['mx.google.com; dkim=pass header.i="support@pubg.com"'],
    ['mx.google.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=pubg.com'],
    ['mx.google.com; dkim=fail header.d=zendesk.com; dmarc=pass header.from=pubg.com']
  ]) assert.ok(match({ authenticationResults }));
});

test('rejects spoofed or unaligned sender authentication and does not trust a later fake pass', () => {
  for (const authenticationResults of [
    [], undefined, ['evil.example; dmarc=pass header.from=pubg.com'],
    ['mx.google.com.evil.example; dmarc=pass header.from=pubg.com'],
    ['mx.google.com; dkim=fail header.d=pubg.com; dmarc=fail header.from=pubg.com', 'mx.google.com; dmarc=pass header.from=pubg.com'],
    ['mx.google.com; dkim=pass header.d=evil.example'],
    ['mx.google.com; dkim=pass header.d=pubg.com.evil.example'],
    ['mx.google.com; dmarc=pass header.from=evil.example'],
    ['mx.google.com; dkim=pass header.d=evil.example header.d=pubg.com'],
    ['mx.google.com; dkim=pass header.i=pubg.com'],
    ['mx.google.com; dkim=pass (header.i=@pubg.com) header.d=evil.example'],
    ['mx.google.com; dkim=fail (reason; dmarc=pass header.from=pubg.com) header.d=evil.example'],
    ['mx.google.com; spf=pass smtp.mailfrom=pubg.com'],
    ['mx.google.com; dmarc=fail header.from=pubg.com\nAuthentication-Results: mx.google.com; dmarc=pass header.from=pubg.com']
  ]) assert.equal(match({ authenticationResults }), null);
});

test('requires exact allowlisted parsed sender and recipient, without Gmail dot or plus equivalence', () => {
  assert.ok(match({ fromAddress: 'SUPPORT@PUBG.COM', toAddresses: ['REPORTER@GMAIL.COM'] }));
  for (const fromAddress of ['support@pubg.com.evil.example', 'Support <support@pubg.com>', 'support@evil.example', '']) assert.equal(match({ fromAddress }), null);
  for (const toAddresses of [['other@gmail.com'], ['re.porter@gmail.com'], ['reporter+alias@gmail.com'], [], 'reporter@gmail.com']) assert.equal(match({ toAddresses }), null);
  assert.equal(match({}, record, { ...options, allowedSenders: [] }), null);
});

test('new receipts require exact reference and nickname tokens', () => {
  assert.ok(match({ subject: '', bodyText: base.bodyText.toLowerCase().replace(mailRef.toLowerCase(), mailRef) }));
  for (const value of ['', `${mailRef}1`, `x${mailRef}`, mailRef.toLowerCase(), mailRef.replace('0', 'a')]) {
    assert.equal(match({ subject: '', bodyText: `Your request (123456) has been received.\n${player}\n${value}` }), null);
  }
  for (const value of ['OTHER_PLAYER', `${player}2`, `x${player}`, `${player}-other`]) {
    assert.equal(match({ subject: '', bodyText: `Your request (123456) has been received.\n${value}\n${mailRef}` }), null);
  }
  assert.equal(match({}, { ...record, mailRef: 'invalid' }), null);
});

test('enforces bounded arrival timestamps and accepts only the documented small clock skew', () => {
  assert.ok(match({ internalDate: at - 60_000 }));
  assert.ok(match({ internalDate: at + 48 * 60 * 60_000 }, record, { ...options, now: at + 48 * 60 * 60_000 }));
  for (const internalDate of [at - 60_001, at + 48 * 60 * 60_000 + 1, options.now + 60_001, 'NaN', '', null, -1, true, Infinity]) assert.equal(match({ internalDate }), null);
  assert.equal(match({}, { ...record, at: 'not-a-date' }), null);
});

test('legacy records require nickname in subject and arrival at or after the attempt', () => {
  const legacy = { at, player: player.toLowerCase(), kind: 'verification' };
  assert.ok(match({}, legacy));
  assert.equal(match({ subject: 'Request received #123456' }, legacy), null);
  assert.equal(match({ internalDate: at - 1 }, legacy), null);
  assert.equal(match({ subject: `Request received #123456 ${player}2` }, legacy), null);
});

test('only considers potentially submitted report states', () => {
  for (const kind of ['pending', 'success', 'unknown', 'verification']) assert.ok(match({}, { ...record, kind }));
  for (const kind of ['not_sent', 'draft', 'cancelled', '', null]) assert.equal(match({}, { ...record, kind }), null);
});

test('requires affirmative official acknowledgement and a bounded unambiguous ticket ID', () => {
  const suffix = `\n${player}\n${mailRef}`;
  for (const bodyText of ['We have received your request.', 'We received your ticket.', '您的请求（123456）已收到。', '我们已收到您的请求（123456）。', 'Your ticket #123456 has been received.']) assert.ok(match({ bodyText: bodyText + suffix }));
  for (const bodyText of ['Please verify your request.', 'Your request has been rejected.', '> Your request (123456) has been received.', 'On Monday, support wrote:\nYour request (123456) has been received.', 'We never said your request (123456) has been received.']) assert.equal(match({ bodyText: bodyText + suffix }), null);
  assert.equal(match({ subject: player + ' ' + mailRef, bodyText: 'We have received your request.' }), null);
  assert.equal(match({ subject: '#987654 ' + player + ' ' + mailRef }), null);
  assert.equal(match({ subject: '#123456 #987654 ' + player + ' ' + mailRef }), null);
  assert.equal(match({ subject: '', bodyText: 'Your request (12) has been received.' + suffix }), null);
  assert.equal(match({ subject: '', bodyText: 'Your request (123456789012345678901) has been received.' + suffix }), null);
});

test('does not confuse a resolution or rejection with the original ticket receipt', () => {
  for (const subject of [`Your request #123456 has been resolved ${player} ${mailRef}`, `工单已关闭 #123456 ${player} ${mailRef}`]) assert.equal(match({ subject }), null);
  assert.equal(match({ bodyText: 'Your request has been rejected.\n' + base.bodyText }), null);
});

test('invalid or oversized fields fail closed without throwing', () => {
  for (const change of [{ id: '' }, { id: 'a\nb' }, { id: '12345' }, { id: '123456789012345678901:1' }, { subject: undefined }, { subject: 'a'.repeat(4097) }, { bodyText: undefined }, { bodyText: 'a'.repeat(256 * 1024 + 1) }]) assert.equal(match(change), null);
  assert.equal(matchReceipt(null, record, options), null);
  assert.equal(matchReceipt(base, null, options), null);
  assert.equal(match({}, { ...record, player: 'invalid nickname' }), null);
  assert.equal(matchReceipts(Array(51).fill(base), record, options), null);
});

const hosted = {
  ...base, fromAddress: 'support@pubgsupport.zendesk.com',
  authenticationResults: ['mx.google.com; dkim=pass header.i=@zendesk.com; spf=pass smtp.mailfrom=support@pubgsupport.zendesk.com; dmarc=pass header.from=zendesk.com']
};
const acknowledgement = {
  ...hosted, id: '12345:67891', subject: '#99887766 【PUBG 咨询已正常接收】',
  bodyText: '我们已经正常接收了您的咨询内容，相关人员正在进行确认。'
};
const detail = {
  ...hosted, id: '12345:67892', subject: `#99887766 PUBG : 请求核查玩家 ${player} 的游戏行为 [${mailRef}]`,
  bodyText: '感谢您联系 PUBG 支持团队。'
};

test('joins actual PUBG acknowledgement and detail email formats by unique ticket number', () => {
  assert.equal(matchReceipt(acknowledgement, record, options), null);
  assert.equal(matchReceipt(detail, record, options), null);
  assert.deepEqual(matchReceipts([detail, acknowledgement], record, options), { messageId: '12345:67891', ticketId: '99887766', receivedAt: at + 60_000 });
  assert.deepEqual(matchReceipts([acknowledgement, { ...detail, internalDate: at + 90_000 }], record, options), { messageId: '12345:67891', ticketId: '99887766', receivedAt: at + 90_000 });
});

test('recognizes the affirmative PUBG Chinese report-received reply', () => {
  const reply = { ...detail, bodyText: '感谢您联系 PUBG 支持团队。\n我们感谢您的举报，并确保将其转达至适当的团队以进行进一步调查。' };
  assert.deepEqual(matchReceipt(reply, record, options), { messageId: '12345:67892', ticketId: '99887766', receivedAt: at + 60_000 });
});

test('hosted Zendesk parent alignment applies only to the explicitly approved PUBG sender', () => {
  for (const fromAddress of ['support@other.zendesk.com', 'support@pubgsupport.zendesk.com.evil.example', 'support@pubg.com']) {
    assert.equal(matchReceipts([{ ...acknowledgement, fromAddress }, detail], record, options), null);
  }
  assert.ok(matchReceipts([{ ...acknowledgement, authenticationResults: ['mx.google.com; dmarc=pass header.from=zendesk.com'] }, detail], record, options));
  assert.ok(matchReceipts([{ ...acknowledgement, authenticationResults: ['mx.google.com; dkim=pass header.i=@zendesk.com'] }, detail], record, options));
  assert.equal(matchReceipts([{ ...acknowledgement, authenticationResults: ['mx.google.com; dmarc=pass header.from=evil.zendesk.com'] }, detail], record, options), null);
});

test('every joined message must independently authenticate, target the mailbox and meet the time window', () => {
  const badMessages = [
    { toAddresses: ['someone@gmail.com'] },
    { internalDate: at - 60_001 },
    { internalDate: options.now + 60_001 },
    { authenticationResults: ['mx.google.com; dmarc=fail header.from=zendesk.com', ...hosted.authenticationResults] }
  ];
  for (const bad of badMessages) {
    assert.equal(matchReceipts([{ ...acknowledgement, ...bad }, detail], record, options), null);
    assert.equal(matchReceipts([acknowledgement, { ...detail, ...bad }], record, options), null);
  }
});

test('does not correlate different tickets, references, players or ambiguous matches', () => {
  assert.equal(matchReceipts([acknowledgement, { ...detail, subject: detail.subject.replace('99887766', '88776655') }], record, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...detail, subject: detail.subject.replace(mailRef, 'KOOK-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }], record, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...detail, subject: detail.subject.replace(player, 'OTHER_PLAYER') }], record, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...detail, subject: detail.subject + ' #88776655' }], record, options), null);
  assert.equal(matchReceipts([acknowledgement, detail, { ...detail, id: '12345:67893', subject: detail.subject.replace('99887766', '88776655') }], record, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...detail, subject: detail.subject + ' ticket resolved' }], record, options), null);
});

test('legacy two-email correlation requires an exact subject nickname and no earlier mail', () => {
  const legacy = { at, player: player.toLowerCase(), kind: 'unknown' };
  const oldDetail = { ...detail, subject: `#99887766 PUBG : 请求核查玩家 ${player} 的游戏行为` };
  assert.ok(matchReceipts([acknowledgement, oldDetail], legacy, options));
  assert.equal(matchReceipts([{ ...acknowledgement, internalDate: at - 1 }, oldDetail], legacy, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...oldDetail, subject: '#99887766 PUBG : 谢谢', bodyText: player }], legacy, options), null);
  assert.equal(matchReceipts([acknowledgement, { ...oldDetail, subject: oldDetail.subject.replace(player, player + '2') }], legacy, options), null);
  assert.equal(matchReceipts([acknowledgement], legacy, options), null);
});
