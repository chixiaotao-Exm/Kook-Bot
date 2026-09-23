import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiChatBot, parseChatMessage } from '../src/chat-bot.js';
import { atomicJson } from '../src/storage.js';

const SELF = '100000001', USER = '200000001', CHANNEL = '300000001';
const NOW = Date.parse('2026-09-20T15:00:00Z');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const event = (n = 1, overrides = {}) => ({ channel_type: 'GROUP', type: 9, target_id: CHANNEL,
  author_id: USER, content: '你好', msg_id: id(n), msg_timestamp: NOW,
  extra: { author: { bot: false } }, ...overrides });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('background operation did not complete');
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-ai-chat-'));
  const calls = [], replies = [], logs = [];
  let now = NOW;
  const config = { dataDir, channelId: CHANNEL, getSelfId: () => SELF, now: () => now,
    generate: async (messages, request) => { calls.push({ messages, request }); return { text: '你好，我是 AI。' }; },
    reply: async response => { replies.push(response); return { messageId: 'reply' }; },
    logger: item => logs.push(item), ...options };
  const bot = await new AiChatBot(config).init();
  t.after(async () => { await bot.close(); assert.ok(path.basename(dataDir).startsWith('kook-ai-chat-')); await rm(dataDir, { force: true, recursive: true }); });
  return { bot, config, dataDir, calls, replies, logs,
    advance(ms) { now += ms; }, now: () => now,
    send(n, overrides = {}) { return bot.handle(event(n, { msg_timestamp: now, ...overrides })); },
    async finish() { await until(() => bot.snapshot().active === 0); } };
}

test('parses only exact commands, optional own mention and detects obvious credentials', () => {
  assert.deepEqual(parseChatMessage(`(met)${SELF}(met) /重置`, SELF), { kind: 'reset' });
  assert.deepEqual(parseChatMessage('/清空对话'), { kind: 'reset' });
  assert.deepEqual(parseChatMessage('/帮助'), { kind: 'help' });
  assert.deepEqual(parseChatMessage('/模型'), { kind: 'model' });
  assert.equal(parseChatMessage('/重置 everything').kind, 'chat');
  assert.equal(parseChatMessage(`(met)999999999(met) /重置`, SELF).kind, 'chat');
  assert.equal(parseChatMessage('  '), null);
  for (const content of ['please use sk-fixture_only_1234567890', '1/MTIzNDU=/fixtureToken123456789==',
    'Authorization: Bearer fixture_private_token_1234567890', 'admin-0123456789abcdef0123456789abcdef'])
    assert.equal(parseChatMessage(content).kind, 'credential');
});

test('durably reserves before generation, quotes origin and stores no conversation content', async t => {
  const f = await fixture(t);
  await f.send(1); await f.finish(); await f.send(1);
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
  assert.deepEqual(f.calls[0].messages, [{ role: 'user', content: '你好' }]);
  assert.equal(f.replies[0].targetId, CHANNEL); assert.equal(f.replies[0].replyMessageId, id(1));
  const saved = await readFile(path.join(f.dataDir, 'seen.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), { version: 1, seen: [{ id: id(1), at: NOW }] });
  assert.ok(!saved.includes(USER)); assert.ok(!saved.includes('你好')); assert.ok(!JSON.stringify(f.logs).includes('你好'));
});

test('model cannot start until atomic receipt persistence succeeds', async t => {
  const saving = defer(), persisted = defer();
  const f = await fixture(t, { writeState: async (file, value) => {
    saving.resolve(); await persisted.promise; await atomicJson(file, value);
  } });
  const handling = f.send(1); await saving.promise;
  assert.equal(f.calls.length, 0);
  persisted.resolve(); await handling; await f.finish(); assert.equal(f.calls.length, 1);
});

test('official segmented KOOK message ID is accepted and deduplicated across restart', async t => {
  const f = await fixture(t), messageId = '50974c-364c983fa6cb';
  await f.send(1, { msg_id: messageId }); await f.finish();
  await f.send(1, { msg_id: messageId }); await f.bot.close();
  const next = await new AiChatBot(f.config).init();
  await next.handle(event(1, { msg_id: messageId })); await next.close();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].replyMessageId, messageId);
});

test('gateway receipt completes while model is pending and contexts stay isolated between users', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, { generate: async messages => { calls.push(messages); return calls.length === 1 ? pending.promise : { text: 'user two answer' }; } });
  await f.send(1);
  assert.equal(calls.length, 1); assert.equal(f.bot.snapshot().active, 1);
  await f.send(2, { author_id: '200000002', content: 'other user' });
  await until(() => f.replies.length === 1);
  pending.resolve({ text: 'user one answer' }); await f.finish();
  f.advance(4000); await f.send(3, { content: 'followup' }); await f.finish();
  assert.deepEqual(calls[1], [{ role: 'user', content: 'other user' }]);
  assert.deepEqual(calls[2], [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'user one answer' }, { role: 'user', content: 'followup' }]);
});

test('ignores private, other channel, system, bots, self, malformed authors and stale events', async t => {
  const f = await fixture(t);
  const changes = [{ channel_type: 'PERSON' }, { channel_type: 'BROADCAST' }, { target_id: '300000002' },
    { type: 255 }, { type: 10 }, { author_id: SELF }, { author_id: 'bad-id' }, { author_id: undefined }, { author_id: 123456789 },
    { extra: {} }, { extra: { author: { bot: true } } }, { extra: { author: { bot: 'false' } } },
    { extra: { author: { bot: false, id: 'different' } } }, { msg_id: '----------------' },
    { msg_id: '-50974c-364c983fa6cb' }, { msg_id: '50974c-364c983fa6cb-' }, { msg_id: '50974c--364c983fa6cb' },
    { msg_timestamp: NOW - 300001 }, { msg_timestamp: NOW + 60001 }, { msg_timestamp: undefined }, { content: null }];
  for (let n = 0; n < changes.length; n++) await f.send(n + 1, changes[n]);
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('supports plain text and self mention without sending the mention to the model', async t => {
  const f = await fixture(t);
  await f.send(1, { type: 1, content: `(met)${SELF}(met)  test` }); await f.finish();
  assert.deepEqual(f.calls[0].messages, [{ role: 'user', content: 'test' }]);
});

test('missing bot field is accepted only after resolving an exact human identity', async t => {
  const lookups = [];
  const f = await fixture(t, { resolveAuthor: async input => { lookups.push(input); return { id: input.userId, bot: false }; } });
  const extra = { guild_id: '400000001', author: { id: USER } };
  await f.send(1, { extra }); await f.finish();
  await f.send(1, { extra });
  await f.send(2, { extra, msg_timestamp: NOW - 300001 });
  assert.deepEqual(lookups, [{ userId: USER, guildId: '400000001' }]);
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
});

test('author resolution rejects known bots, unknown flags, mismatched IDs and failed lookups', async t => {
  const resolved = [{ id: USER, bot: true }, { id: USER }, { id: '999999999', bot: false }, null, new Error('private upstream detail')];
  let lookups = 0;
  const f = await fixture(t, { resolveAuthor: async () => { const result = resolved[lookups++]; if (result instanceof Error) throw result; return result; } });
  for (let n = 1; n <= 5; n++) await f.send(n, { extra: { guild_id: '400000001', author: { id: USER } } });
  assert.equal(lookups, 5); assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
  assert.ok(!JSON.stringify(f.logs).includes('private upstream detail'));
});

test('missing bot flag without valid guild and explicitly malformed flags never invoke resolver', async t => {
  let lookups = 0;
  const f = await fixture(t, { resolveAuthor: async () => { lookups++; return { id: USER, bot: false }; } });
  const extras = [{ author: { id: USER } }, { guild_id: 'bad', author: { id: USER } },
    { guild_id: 400000001, author: { id: USER } }, { guild_id: '400000001', author: { id: USER, bot: null } },
    { guild_id: '400000001', author: { id: USER, bot: true } }, { guild_id: '400000001', author: { id: USER, bot: 'false' } },
    { guild_id: '400000001' }, { guild_id: '400000001', author: [] }];
  for (let n = 0; n < extras.length; n++) await f.send(n + 1, { extra: extras[n] });
  assert.equal(lookups, 0); assert.equal(f.calls.length, 0);
});

test('shutdown while author identity is resolving prevents generation', async t => {
  const pending = defer(), entered = defer();
  const f = await fixture(t, { closeTimeoutMs: 20, resolveAuthor: async () => { entered.resolve(); return pending.promise; } });
  const handling = f.send(1, { extra: { guild_id: '400000001', author: { id: USER } } });
  await entered.promise; await f.bot.close(); pending.resolve({ id: USER, bot: false }); await handling;
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('reset aborts pending generation, stops late replies and clears history', async t => {
  const first = defer(), calls = [];
  const f = await fixture(t, { generate: async (messages, request) => { calls.push({ messages, request }); return calls.length === 1 ? first.promise : { text: 'new answer' }; } });
  await f.send(1); await f.send(2, { content: '/重置' });
  assert.equal(calls[0].request.signal.aborted, true);
  first.resolve({ text: 'stale answer' }); await f.finish();
  await f.send(3, { content: 'new question' }); await f.finish();
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: 'new question' }]);
  assert.ok(!f.replies.some(item => item.content === 'stale answer'));
  assert.equal(f.bot.snapshot().resets, 1);
});

test('reset during delivery aborts reply and prevents history from reappearing', async t => {
  const delivering = defer(), sent = [], generated = [];
  const f = await fixture(t, { generate: async messages => { generated.push(messages); return { text: 'answer' }; },
    reply: async item => { sent.push(item); if (sent.length === 1) await delivering.promise; return { messageId: 'reply' }; } });
  await f.send(1); await until(() => sent.length === 1);
  await f.send(2, { content: '/清空对话' }); assert.equal(sent[0].signal.aborted, true);
  delivering.resolve(); await f.finish();
  await f.send(3, { content: 'fresh' }); await f.finish();
  assert.deepEqual(generated[1], [{ role: 'user', content: 'fresh' }]);
});

test('help and model commands do not call AI and reset works during cooldown', async t => {
  const f = await fixture(t, { model: 'fixture-model' });
  await f.send(1, { content: '/帮助' }); await until(() => f.replies.length === 1);
  assert.match(f.replies[0].content, /每位用户/);
  f.advance(10001); await f.send(2, { content: '/模型' }); await until(() => f.replies.length === 2);
  assert.equal(f.replies[1].content, '当前模型：fixture-model'); assert.equal(f.calls.length, 0);
  await f.send(3); await f.finish();
  await f.send(4, { content: '/重置' }); await f.send(5); await f.finish();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].messages.length, 1);
});

test('expired history is forgotten after two hours', async t => {
  const f = await fixture(t);
  await f.send(1); await f.finish(); f.advance(2 * 60 * 60_000 + 1);
  await f.send(2, { content: 'fresh day' }); await f.finish();
  assert.deepEqual(f.calls[1].messages, [{ role: 'user', content: 'fresh day' }]);
});

test('retains at most ten complete turn pairs and constrains history plus incoming text', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 13; i++) { await f.send(i, { content: `question ${i}` }); await f.finish(); f.advance(4000); }
  assert.equal(f.calls[12].messages.length, 21);
  assert.equal(f.calls[12].messages[0].content, 'question 3');
  const bounded = await fixture(t, { maxHistoryChars: 20, generate: async messages => { bounded.calls.push({ messages }); return { text: 'answer' }; } });
  for (let i = 1; i <= 4; i++) { await bounded.send(i, { content: `query${i}` }); await bounded.finish(); bounded.advance(4000); }
  assert.ok(bounded.calls.every(call => call.messages.reduce((n, item) => n + item.content.length, 0) <= 20));
  assert.equal(bounded.calls[3].messages[0].role, 'user');
});

test('full long model output reaches delivery while bounded client history is used for followup', async t => {
  const fullText = `<svg>${'x'.repeat(31_980)}</svg>`, calls = [];
  const f = await fixture(t, { generate: async messages => {
    calls.push(messages); return { text: fullText, historyText: 'A short SVG history summary.', incomplete: true };
  } });
  await f.send(1); await f.finish();
  assert.equal(f.replies[0].content, fullText); assert.equal(f.replies[0].incomplete, true);
  f.advance(4000); await f.send(2, { content: 'followup' }); await f.finish();
  assert.deepEqual(calls[1], [{ role: 'user', content: '你好' },
    { role: 'assistant', content: 'A short SVG history summary.' }, { role: 'user', content: 'followup' }]);
  f.advance(10_001); await f.send(3, { content: '/帮助' }); await until(() => f.replies.length === 3);
  assert.equal(f.replies[2].incomplete, false);
});

test('invalid history metadata falls back to a UTF16 safe local cap and retains current turn', async t => {
  const invalidHistories = [undefined, null, { toString() { throw new Error('do not coerce'); } }, '', ' ',
    'x'.repeat(6001), '\uD800', 42];
  for (const invalid of invalidHistories) {
    const calls = [], fullText = '😀'.repeat(15_990);
    const f = await fixture(t, { generate: async messages => { calls.push(messages); return { text: fullText, historyText: invalid, incomplete: 'true' }; } });
    await f.send(1); await f.finish();
    assert.equal(f.replies[0].content, fullText); assert.equal(f.replies[0].incomplete, false);
    f.advance(4000); await f.send(2); await f.finish();
    assert.equal(calls[1].length, 3);
    const remembered = calls[1][1].content;
    assert.ok(remembered.length <= 6000); assert.ok(remembered.isWellFormed());
    assert.match(remembered, /历史上下文仅保留前部内容/);
    assert.ok(calls[1].reduce((sum, message) => sum + message.content.length, 0) <= 20_000);
  }
});

test('rejects excessive input and credentials without generation or reflection', async t => {
  const f = await fixture(t);
  await f.send(1, { content: 'x'.repeat(4001) }); await until(() => f.replies.length === 1);
  f.advance(10001);
  await f.send(2, { content: 'secret sk-fixture_only_1234567890' }); await until(() => f.replies.length === 2);
  assert.equal(f.calls.length, 0); assert.match(f.replies[0].content, /4000/);
  assert.match(f.replies[1].content, /未发送给 AI/);
  assert.ok(!JSON.stringify(f.replies).includes('sk-fixture')); assert.ok(!JSON.stringify(f.logs).includes('sk-fixture'));
});

test('at most two users run at once, one per user, and overload responses are throttled', async t => {
  const pending = defer(), calls = [];
  const f = await fixture(t, { generate: async messages => { calls.push(messages); return pending.promise; } });
  await f.send(1); await f.send(2, { author_id: '200000002' });
  await f.send(3, { author_id: '200000003' }); await f.send(4, { author_id: '200000003' });
  await f.send(5); await f.send(6);
  await until(() => f.replies.length === 2);
  assert.equal(calls.length, 2); assert.equal(f.bot.snapshot().active, 2);
  pending.resolve({ text: 'finished' }); await f.finish();
  assert.equal(f.replies.filter(item => item.content !== 'finished').length, 2);
});

test('enforces per-user cooldown and global model request budget of thirty per minute', async t => {
  const f = await fixture(t);
  await f.send(1); await f.finish(); await f.send(2); await f.finish();
  assert.equal(f.calls.length, 1);
  for (let i = 3; i < 40; i++) { await f.send(i, { author_id: String(200000000 + i) }); await f.finish(); }
  assert.equal(f.calls.length, 30);
  f.advance(60_001); await f.send(40); await f.finish(); assert.equal(f.calls.length, 31);
});

test('receipt persisted before cost prevents duplicate generation after restart', async t => {
  const f = await fixture(t); await f.send(1); await f.finish(); await f.bot.close();
  const next = await new AiChatBot(f.config).init();
  await next.handle(event(1)); await next.close(); assert.equal(f.calls.length, 1);
});

test('storage failures and corrupt receipt ledgers fail closed without model calls', async t => {
  const f = await fixture(t, { writeState: async () => { throw new Error('private secret'); } });
  await f.send(1); assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
  assert.equal(f.bot.snapshot().lastError, 'STORAGE'); assert.equal(f.bot.snapshot().enabled, false);
  await writeFile(path.join(f.dataDir, 'seen.json'), '{invalid');
  const next = await new AiChatBot(f.config).init(); await next.handle(event(2));
  assert.equal(next.snapshot().enabled, false); await next.close();
  assert.ok(!JSON.stringify(f.logs).includes('private secret'));
});

test('ambiguous delivery is never resent and failed delivery adds no history', async t => {
  let deliveries = 0;
  const f = await fixture(t, { reply: async () => { deliveries++; throw new Error('private key'); } });
  await f.send(1); await f.finish(); await f.send(1);
  assert.equal(deliveries, 1); assert.equal(f.bot.snapshot().lastError, 'DELIVERY');
  f.advance(4000); await f.send(2); await f.finish();
  assert.equal(f.calls[1].messages.length, 1); assert.equal(deliveries, 2);
});

test('generation errors use a fixed safe response and keep no failed history', async t => {
  let generation = 0;
  const f = await fixture(t, { generate: async () => { generation++; throw new Error('sk-never_expose_fixture_secret'); } });
  await f.send(1); await f.finish(); assert.equal(generation, 1);
  assert.equal(f.replies[0].content, 'AI 暂时无法回复，请稍后再试。');
  assert.ok(!JSON.stringify(f.logs).includes('sk-never'));
});

test('model failure observations expose only whitelisted code and duration, with actionable replies', async t => {
  const errors = ['TIMEOUT', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'sk-private_fixture_injected_code'];
  let generated = 0;
  const f = await fixture(t, { generate: async () => {
    f.advance(1234);
    throw Object.assign(new Error('private fixture request content'), { code: errors[generated++] });
  } });
  for (let n = 1; n <= errors.length; n++) {
    await f.send(n); await f.finish(); f.advance(4000);
    assert.equal(f.bot.snapshot().lastErrorCode, n === 4 ? 'UNKNOWN' : errors[n - 1]);
  }
  assert.match(f.replies[0].content, /超时.*拆短/);
  assert.match(f.replies[1].content, /没有生成/);
  assert.match(f.replies[2].content, /频率限制/);
  const logs = f.logs.filter(item => item.event === 'model_failed');
  assert.deepEqual(logs.map(item => item.code), ['TIMEOUT', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'UNKNOWN']);
  assert.ok(logs.every(item => item.durationMs === 1234));
  const exposed = JSON.stringify({ logs: f.logs, replies: f.replies, snapshot: f.bot.snapshot() });
  assert.ok(!exposed.includes('private_fixture')); assert.ok(!exposed.includes('private fixture'));
});

test('empty generated text records EMPTY_RESPONSE and cancellation sends no failure reply', async t => {
  const empty = await fixture(t, { generate: async () => ({ text: ' ' }) });
  await empty.send(1); await empty.finish();
  assert.equal(empty.bot.snapshot().lastErrorCode, 'EMPTY_RESPONSE'); assert.match(empty.replies[0].content, /没有生成/);
  const cancelled = await fixture(t, { generate: async () => { throw Object.assign(new Error('private cancel reason'), { code: 'CANCELLED' }); } });
  await cancelled.send(1); await cancelled.finish();
  assert.equal(cancelled.replies.length, 0); assert.equal(cancelled.bot.snapshot().failures, 0);
});

test('delivery diagnostics are safe and successful next turn clears last failure code', async t => {
  let attempts = 0;
  const f = await fixture(t, { reply: async () => {
    if (++attempts === 1) throw Object.assign(new Error('private delivery payload'), { code: 'KOOK_TIMEOUT' });
    return { messageId: 'reply' };
  } });
  await f.send(1); await f.finish();
  assert.equal(f.bot.snapshot().lastErrorCode, 'KOOK_TIMEOUT');
  assert.deepEqual(f.logs.find(item => item.event === 'delivery_failed'), { event: 'delivery_failed', code: 'KOOK_TIMEOUT', durationMs: 0 });
  f.advance(4000); await f.send(2); await f.finish();
  assert.equal(f.bot.snapshot().lastError, null); assert.equal(f.bot.snapshot().lastErrorCode, null);
  assert.ok(!JSON.stringify(f.logs).includes('private delivery'));
});

test('progress is started before the one model call and actual delivery stages precede finish', async t => {
  const steps = [], started = defer(), proceed = defer();
  const handle = { setPhase: async phase => { steps.push(phase); }, finish: async () => { steps.push('finish'); },
    fail: async code => { steps.push(`fail:${code}`); }, cancel: async () => { steps.push('cancel'); } };
  const f = await fixture(t, { progress: { start: async input => {
    assert.equal(input.targetId, CHANNEL); assert.equal(input.replyMessageId, id(1));
    steps.push('start'); started.resolve(); await proceed.promise; return handle;
  } }, generate: async () => { steps.push('generate'); return { text: 'answer' }; },
  reply: async input => {
    for (const phase of ['rendering', 'uploading', 'sending']) await input.onStage(phase);
    steps.push('reply'); return { messageId: 'reply' };
  } });
  await f.send(1); await started.promise; assert.deepEqual(steps, ['start']);
  proceed.resolve(); await f.finish();
  assert.deepEqual(steps, ['start', 'generate', 'rendering', 'uploading', 'sending', 'reply', 'finish']);
});

test('failed progress startup keeps the model and final reply working without leaking exceptions', async t => {
  const f = await fixture(t, { progress: { start: async () => {
    throw Object.assign(new Error('private progress request'), { code: 'sk-private-progress-code' });
  } } });
  await f.send(1); await f.finish();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1); assert.equal(f.bot.snapshot().failures, 0);
  assert.deepEqual(f.logs.find(item => item.event === 'progress_failed'), { event: 'progress_failed', code: 'UNKNOWN' });
  assert.ok(!JSON.stringify(f.logs).includes('private progress')); assert.ok(!JSON.stringify(f.logs).includes('sk-private'));
});

test('progress update and finish failures never turn a successful answer into model failure', async t => {
  const f = await fixture(t, { progress: { start: async () => ({
    setPhase: async () => { throw new Error('private progress update'); },
    finish: async () => { throw new Error('private progress finish'); },
  }) }, reply: async input => { await input.onStage('sending'); f.replies.push(input); return { messageId: 'reply' }; } });
  await f.send(1); await f.finish();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
  assert.equal(f.bot.snapshot().lastError, null); assert.equal(f.bot.snapshot().failures, 0);
  assert.equal(f.logs.filter(item => item.event === 'progress_failed').length, 2);
});

test('model and final delivery errors terminate progress with safe failure codes', async t => {
  for (const category of ['model', 'delivery']) {
    const terminals = [];
    const options = { progress: { start: async () => ({ finish: async () => terminals.push('finish'),
      fail: async code => terminals.push(code), cancel: async () => terminals.push('cancel') }) } };
    if (category === 'model') options.generate = async () => { throw Object.assign(new Error('secret model'), { code: 'TIMEOUT' }); };
    else options.reply = async () => { throw Object.assign(new Error('secret delivery'), { code: 'KOOK_REJECTED' }); };
    const f = await fixture(t, options); await f.send(1); await f.finish();
    assert.deepEqual(terminals, [category === 'model' ? 'TIMEOUT' : 'KOOK_REJECTED']);
    assert.equal(f.replies.length, category === 'model' ? 1 : 0);
  }
});

test('reset while progress starts cancels its late handle and never calls the model', async t => {
  const entered = defer(), pending = defer(), terminals = [];
  const f = await fixture(t, { progress: { start: async () => { entered.resolve(); return pending.promise; } } });
  await f.send(1); await entered.promise; await f.send(2, { content: '/重置' });
  pending.resolve({ cancel: async () => terminals.push('cancel'), finish: async () => terminals.push('finish') });
  await f.finish();
  assert.equal(f.calls.length, 0); assert.deepEqual(terminals, ['cancel']);
  assert.ok(f.replies.every(item => item.content.includes('清空')));
});

test('reset cancels in-flight progress immediately and late model output cannot finish it', async t => {
  const pending = defer(), began = defer(), terminals = [];
  const f = await fixture(t, { progress: { start: async () => ({
    cancel: async () => terminals.push('cancel'), finish: async () => terminals.push('finish'),
    fail: async code => terminals.push(code),
  }) }, generate: async () => { began.resolve(); return pending.promise; } });
  await f.send(1); await began.promise; await f.send(2, { content: '/重置' });
  assert.deepEqual(terminals, ['cancel']);
  pending.resolve({ text: 'late private answer' }); await f.finish();
  assert.deepEqual(terminals, ['cancel']); assert.ok(!f.replies.some(item => item.content.includes('late private')));
});

test('help model and reset commands create no AI progress and cancellation has a cancelled terminal', async t => {
  let starts = 0; const terminals = [];
  const f = await fixture(t, { progress: { start: async () => { starts++; return {
    cancel: async () => terminals.push('cancel'), fail: async code => terminals.push(code), finish: async () => terminals.push('finish'),
  }; } }, generate: async () => { throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); } });
  for (const [index, command] of ['/帮助', '/模型', '/重置'].entries()) await f.send(index + 1, { content: command });
  assert.equal(starts, 0);
  await f.send(4); await f.finish(); assert.equal(starts, 1); assert.deepEqual(terminals, ['cancel']);
});

test('shutdown aborts active work, returns within its bound, and forbids late replies', async t => {
  const pending = defer(); let signal;
  const f = await fixture(t, { closeTimeoutMs: 20, generate: async (_, request) => { signal = request.signal; return pending.promise; } });
  await f.send(1); await f.bot.close(); assert.equal(signal.aborted, true);
  pending.resolve({ text: 'late' }); await f.finish(); await f.send(2);
  assert.equal(f.replies.length, 0); assert.equal(f.bot.snapshot().enabled, false);
});
