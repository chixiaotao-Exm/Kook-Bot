import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGmailReader, GmailMonitor } from '../src/mail-monitor.js';

const mailbox = 'test@gmail.com', password = 'a'.repeat(16), at = 1_800_000_000_000;
function child() {
  const process = new EventEmitter(); process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kills = 0; process.kill = () => { process.kills++; }; return process;
}
test('Gmail subprocess isolates credentials and never includes them in command arguments', async () => {
  const proc = child(); let command;
  const read = createGmailReader({ address: mailbox, password, spawnImpl: (binary, args, opts) => { command = { binary, args, opts }; return proc; } });
  const promise = read({ sinceMs: at });
  proc.stdout.write(JSON.stringify({ messages: [], truncated: false })); proc.emit('close', 0);
  assert.deepEqual(await promise, { messages: [], truncated: false });
  assert.ok(!JSON.stringify(command.args).includes(password)); assert.equal(command.opts.env.GMAIL_APP_PASSWORD, password);
  assert.equal(command.opts.env.KOOK_TOKEN, undefined); assert.equal(command.opts.env.REPORT_BROWSER_TOKEN, undefined);
});
test('reader abort and bad output fail closed without leaking library stderr', async () => {
  for (const scenario of ['abort', 'invalid', 'auth']) {
    const proc = child(), controller = new AbortController();
    const read = createGmailReader({ address: mailbox, password, spawnImpl: () => proc });
    const promise = read({ sinceMs: at, signal: controller.signal });
    proc.stderr.write('private ' + password);
    if (scenario === 'abort') controller.abort();
    else { proc.stdout.write(scenario === 'auth' ? '{"error":"auth_failed"}' : 'bad'); proc.emit('close', 1); }
    await assert.rejects(promise, error => !error.message.includes(password) && /cancelled|mail_invalid_response|auth_failed/.test(error.message));
  }
});

test('bounded Gmail output permits escaped Chinese receipts but kills oversized output', async () => {
  const proc = child();
  const read = createGmailReader({ address: mailbox, password, spawnImpl: () => proc });
  const promise = read({ sinceMs: at });
  const text = '{"messages":[' + Array.from({ length: 50 }, () => '{"bodyText":"' + '\\u4e2d'.repeat(18000) + '"}').join(',') + '],"truncated":false}';
  assert.ok(Buffer.byteLength(text) > 4 * 1024 * 1024); proc.stdout.write(text); proc.emit('close', 0);
  assert.equal((await promise).messages.length, 50);
  const huge = child(), pending = createGmailReader({ address: mailbox, password, spawnImpl: () => huge })({ sinceMs: at });
  huge.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(pending, /mail_response_too_large/); assert.equal(huge.kills, 1);
});
test('poller prevents overlap, reports connection failure, and never creates report submissions', async () => {
  let release, reads = 0, flushed = 0;
  const bot = { mailCandidates: () => [], flushMailNotifications: async () => { flushed++; }, confirmMail: () => assert.fail('unexpected receipt') };
  const monitor = new GmailMonitor({ bot, mailbox, now: () => at, reader: () => { reads++; return new Promise(resolve => { release = resolve; }); } });
  const first = monitor.check(); assert.equal(monitor.check(), first);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  release({ messages: [], truncated: true }); await first;
  assert.equal(monitor.status().connected, true); assert.equal(monitor.status().truncated, true); assert.equal(flushed, 1);
  monitor.reader = async () => { throw Error('private arbitrary error'); }; await monitor.check();
  assert.equal(monitor.status().lastError, 'mail_unavailable'); await monitor.close();
});
test('poller correlates real two-message PUBG receipt shape before updating bot status', async () => {
  const record = { key: 'player_01', player: 'Player_01', at, kind: 'unknown' }, applied = [];
  const base = { internalDate: at + 1000, fromAddress: 'support@pubgsupport.zendesk.com', toAddresses: [mailbox],
    authenticationResults: ['mx.google.com; dkim=pass header.i=@zendesk.com; dmarc=pass header.from=zendesk.com'] };
  const messages = [{ ...base, id: '10:20', subject: '#81234567 【PUBG 咨询已正常接收】', bodyText: '您好，玩家,\n我们已经正常接收了您的咨询内容，相关人员正在进行确认。' },
    { ...base, id: '10:21', subject: '#81234567 PUBG : 请求核查玩家 Player_01 的游戏行为', bodyText: '感谢您联系 PUBG 支持团队。' }];
  const bot = { mailCandidates: () => [record], flushMailNotifications: async () => {}, confirmMail: async (...args) => { applied.push(args); return true; } };
  const monitor = new GmailMonitor({ bot, mailbox, now: () => at + 5000, reader: async () => ({ messages, truncated: false }) });
  await monitor.check(); assert.equal(applied.length, 1); assert.equal(applied[0][1].ticketId, '81234567');
  assert.equal(monitor.status().confirmed, 1); await monitor.close();
});

test('reader passes a bounded cursor privately and rejects a cursor that does not advance', async () => {
  const proc = child();
  const read = createGmailReader({ address: mailbox, password, spawnImpl: () => proc });
  const promise = read({ sinceMs: at, cursor: '10:100' });
  assert.deepEqual(JSON.parse(proc.stdin.read().toString()), { sinceMs: at, limit: 50, cursor: '10:100' });
  proc.stdout.write(JSON.stringify({ messages: [], truncated: true, skipped: false, nextCursor: '10:50' })); proc.emit('close', 0);
  assert.equal((await promise).nextCursor, '10:50');
  for (const nextCursor of ['10:100', '10:101', '11:50', 'bad']) {
    const bad = child();
    const pending = createGmailReader({ address: mailbox, password, spawnImpl: () => bad })({ sinceMs: at, cursor: '10:100' });
    bad.stdout.write(JSON.stringify({ messages: [], truncated: true, nextCursor })); bad.emit('close', 0);
    await assert.rejects(pending, /mail_invalid_response/);
  }
});

function fiftyReceipts() {
  const records = Array.from({ length: 50 }, (_, index) => ({ key: 'player_01', player: 'Player_01', at, kind: 'unknown',
    mailRef: 'KOOK-' + index.toString(16).padStart(32, '0') }));
  const base = { internalDate: at + 1000, fromAddress: 'support@pubg.com', toAddresses: [mailbox],
    authenticationResults: ['mx.google.com; dkim=pass header.i=@pubg.com'] };
  const acknowledgements = records.map((record, index) => ({ ...base, id: `10:${200 - index}`, subject: `#${10000 + index} Request received`,
    bodyText: `Your request (${10000 + index}) has been received.` }));
  const details = records.map((record, index) => ({ ...base, id: `10:${100 - index}`,
    subject: `#${10000 + index} Player_01 [${record.mailRef}]`, bodyText: 'Report detail.' }));
  return { records, acknowledgements, details };
}

test('fifty accounts correlate one hundred emails across pages and successive checks', async () => {
  const { records, acknowledgements, details } = fiftyReceipts(), applied = [], cursors = [];
  const bot = { mailCandidates: () => records, flushMailNotifications: async () => {},
    confirmMail: async (record, receipt) => { applied.push({ record, receipt }); return true; } };
  const monitor = new GmailMonitor({ bot, mailbox, now: () => at + 5000, pagesPerCheck: 1, reader: async ({ cursor }) => {
    cursors.push(cursor);
    return cursor ? { messages: details, truncated: false, nextCursor: null }
      : { messages: acknowledgements, truncated: true, nextCursor: '10:151' };
  } });
  await monitor.check(); assert.equal(applied.length, 0); assert.equal(monitor.status().truncated, true);
  await monitor.check(); assert.equal(applied.length, 50); assert.equal(monitor.status().truncated, false);
  assert.deepEqual(cursors, [undefined, '10:151']);
  assert.equal(new Set(applied.map(item => item.receipt.ticketId)).size, 50);
  assert.equal(monitor.status().confirmed, 50); await monitor.close();
});

test('a conflicting ticket on an older page prevents a premature email confirmation', async () => {
  const { records, acknowledgements, details } = fiftyReceipts(), applied = [];
  const bot = { mailCandidates: () => [records[0]], flushMailNotifications: async () => {}, confirmMail: async (...args) => { applied.push(args); return true; } };
  const monitor = new GmailMonitor({ bot, mailbox, now: () => at + 5000, reader: async ({ cursor }) => cursor
    ? { messages: [{ ...details[0], id: '10:99', subject: details[0].subject.replace('10000', '99999') }], truncated: false }
    : { messages: [acknowledgements[0], details[0]], truncated: true, nextCursor: '10:100' } });
  await monitor.check(); assert.equal(applied.length, 0); await monitor.close();
});

test('a failed page or repeating cursor discards partial matches and starts a fresh scan', async () => {
  for (const failure of ['network', 'repeated', 'mailbox_changed']) {
    const { records, acknowledgements, details } = fiftyReceipts(); let calls = 0;
    const bot = { mailCandidates: () => [records[0]], flushMailNotifications: async () => {}, confirmMail: () => assert.fail('incomplete scan confirmed') };
    const monitor = new GmailMonitor({ bot, mailbox, now: () => at + 5000, reader: async ({ cursor }) => {
      calls++;
      if (!cursor) return { messages: [acknowledgements[0], details[0]], truncated: true, nextCursor: '10:100' };
      if (failure === 'network') throw Error('private credentials');
      return { messages: [], truncated: true, nextCursor: failure === 'repeated' ? '10:100' : '11:99' };
    } });
    await monitor.check(); assert.equal(calls, 2); assert.equal(monitor.scan, null);
    assert.equal(monitor.status().lastError, 'mail_unavailable');
    await monitor.close();
  }
});
