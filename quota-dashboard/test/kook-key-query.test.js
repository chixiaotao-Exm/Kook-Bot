import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { KookKeyQueryBot, parseKeyQuery, formatKeyUsageReply } from '../src/kook-key-query.js';
import { KeyUsageClient, KeyUsageError } from '../src/key-usage.js';
import { createKookQueryReply } from '../src/kook-query-reply.js';

const SELF = '380108001', CHANNEL = '9000000000000104', USER = '1122334455';
const KEY = 'sk-fixture_never_production_1234';
const NOW = Date.parse('2026-09-20T15:00:00Z');
const message = (overrides = {}) => ({ channel_type: 'GROUP', type: 9, target_id: CHANNEL, author_id: USER,
  content: KEY, msg_id: '00000000-0000-0000-0000-000000000001', msg_timestamp: NOW, extra: { author: { bot: false } }, ...overrides });
const stats = { requests: 417, tokens: 18800000, cost: 57.15 };
const result = () => ({ keyHint: 'sk-…1234', quota: { scope: 'account', remaining: 900 }, periods: [{ key: 'today', ...stats }, { key: '7d', ...stats }], totals: stats, queriedAt: new Date(NOW).toISOString() });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota-key-bot-')), calls = [], replies = [], logs = [];
  let now = NOW;
  const config = { dataDir: dir, getSelfId: () => SELF, channelIds: [CHANNEL], now: () => now,
    keyUsage: { async query(key) { calls.push(key); return result(); } }, reply: async item => { replies.push(item); return { messageId: 'reply' }; },
    logger: item => logs.push(item), ...options };
  const bot = await new KookKeyQueryBot(config).init();
  t.after(async () => { await bot.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('quota-key-bot-')); await rm(dir, { recursive: true, force: true }); });
  return { bot, dir, calls, replies, logs, config, advance(ms) { now += ms; }, now: () => now };
}

test('parses exact key, optional query command, code formatting and own mention only', () => {
  for (const text of [KEY, ` ${KEY}\n`, `查询 ${KEY}`, `/查询 ${KEY}`, `用量 ${KEY}`, `\`${KEY}\``, `\`\`\`\n${KEY}\n\`\`\``, `(met)${SELF}(met) ${KEY}`]) {
    assert.deepEqual(parseKeyQuery(text, SELF), { kind: 'key', key: KEY });
  }
  for (const text of ['hello', 'some text ' + KEY, 'https://other.test?key=' + KEY, `(met)123456(met) ${KEY}`]) assert.equal(parseKeyQuery(text, SELF), null);
  for (const text of ['sk-short', `${KEY} ${KEY}`, '查询 other', `${KEY}\nAuthorization: secret`]) assert.equal(parseKeyQuery(text).kind, 'invalid');
  assert.equal(parseKeyQuery('/查询').kind, 'help');
  assert.equal(parseKeyQuery('x'.repeat(1025)), null);
});

test('summary distinguishes shared balance, actual costs, unknown and true zero without reflecting metadata', () => {
  const data = result(); data.label = KEY; data.quota.remaining = 0; data.periods[0] = { key: 'today', requests: 0, tokens: 0, cost: .001 };
  data.periods[1] = { key: '7d', requests: null, tokens: null, cost: null };
  const content = formatKeyUsageReply(data);
  assert.match(content, /账户共享余额 \$0.00/); assert.match(content, /今日 0 次 · 0 Token · \$<0.01/);
  assert.match(content, /近7天 未知 次 · 未知 Token · 未知/); assert.match(content, /累计 417 次 · 18.80M Token · \$57.15/);
  assert.match(content, /实际扣费/); assert.ok(!content.includes(KEY));
  data.keyHint = KEY; assert.ok(!formatKeyUsageReply(data).includes(KEY));
  data.quota = { scope: 'key', remaining: 3, used: 7, limit: 10 };
  assert.match(formatKeyUsageReply(data), /Key 剩余 \$3.00\n已用 \$7.00 \/ 限额 \$10.00/);
});

test('configured channel queries key and replies there once, persisting only message id and time', async t => {
  const f = await fixture(t);
  await f.bot.handle(message()); await f.bot.handle(message());
  assert.deepEqual(f.calls, [KEY]); assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].targetId, CHANNEL); assert.equal(f.replies[0].channelType, 'GROUP');
  assert.ok(!JSON.stringify(f.replies).includes(KEY)); assert.ok(!JSON.stringify(f.logs).includes(KEY));
  const saved = await readFile(path.join(f.dir, 'key-query-seen.json'), 'utf8');
  assert.ok(!saved.includes(KEY)); assert.ok(!saved.includes(USER));
  assert.deepEqual(Object.keys(JSON.parse(saved).seen[0]), ['id', 'at']);
  assert.equal(f.bot.snapshot().replies, 1);
});

test('private query replies to original author and never broadcasts it', async t => {
  const f = await fixture(t);
  await f.bot.handle(message({ channel_type: 'PERSON', target_id: SELF }));
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0].authorId, USER); assert.equal(f.replies[0].channelType, 'PERSON');
  f.advance(4000);
  await f.bot.handle(message({ channel_type: 'PERSON', target_id: USER, msg_id: '00000000-0000-0000-0000-000000000002' }));
  assert.equal(f.replies.length, 2); assert.equal(f.replies[1].authorId, USER); assert.equal(f.replies[1].channelType, 'PERSON');
});

test('ignores other channels, system/bot/self events, stale messages and unrelated chat', async t => {
  const f = await fixture(t);
  for (const change of [{ target_id: '999999999999' }, { type: 255 }, { type: 10 }, { extra: { author: { bot: true } } },
    { author_id: SELF }, { msg_timestamp: NOW - 300001 }, { msg_timestamp: NOW + 60001 }, { msg_timestamp: undefined },
    { msg_id: KEY }, { content: 'hello' }, { channel_type: 'BROADCAST' }]) await f.bot.handle(message(change));
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('safe hints and failures reply without querying invalid keys or echoing errors', async t => {
  let failure = new Error(KEY);
  const f = await fixture(t, { keyUsage: { query: async () => { throw failure; } } });
  await f.bot.handle(message({ content: '/查询' }));
  assert.match(f.replies[0].content, /完整/);
  f.advance(4000); await f.bot.handle(message({ content: 'sk-short', msg_id: '00000000-0000-0000-0000-000000000002' }));
  assert.match(f.replies[1].content, /每条消息/);
  f.advance(4000); await f.bot.handle(message({ msg_id: '00000000-0000-0000-0000-000000000003' }));
  assert.match(f.replies[2].content, /暂不可用/);
  failure = new KeyUsageError('AUTH', 'API Key 无效、已停用或无查询权限。', 401);
  f.advance(4000); await f.bot.handle(message({ msg_id: '00000000-0000-0000-0000-000000000004' }));
  assert.match(f.replies[3].content, /无效/); assert.ok(!JSON.stringify(f.replies).includes(KEY));
});

test('saved reservation prevents duplicate reply after restart and ambiguous delivery', async t => {
  let count = 0;
  const f = await fixture(t, { reply: async () => { count++; throw new Error('unconfirmed'); } });
  await f.bot.handle(message()); await f.bot.close();
  const next = await new KookKeyQueryBot(f.config).init();
  await next.handle(message()); await next.close();
  assert.equal(count, 1); assert.equal(f.bot.snapshot().lastError, 'DELIVERY');
});

test('storage failure or corrupted ledger prevents queries and replies', async t => {
  const f = await fixture(t, { writeState: async () => { throw new Error(KEY); } });
  await f.bot.handle(message());
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.bot.snapshot().lastError, 'STORAGE');
  await writeFile(path.join(f.dir, 'key-query-seen.json'), 'invalid');
  const next = await new KookKeyQueryBot(f.config).init();
  await next.handle(message()); assert.equal(next.snapshot().enabled, false); await next.close();
});

test('per-user cooldown and global minute bound contain repeated queries', async t => {
  const f = await fixture(t);
  await f.bot.handle(message());
  await f.bot.handle(message({ msg_id: '00000000-0000-0000-0000-000000000002' }));
  assert.equal(f.calls.length, 1);
  for (let i = 2; i <= 40; i++) await f.bot.handle(message({ author_id: String(2000000000 + i), msg_id: `00000000-0000-0000-0000-${String(i + 2).padStart(12, '0')}` }));
  assert.equal(f.calls.length, 30);
});

test('shutdown during query cancels replies and future incoming events', async t => {
  let resolve, started;
  const began = new Promise(done => { started = done; });
  const f = await fixture(t, { keyUsage: { query: () => { started(); return new Promise(done => { resolve = done; }); } } });
  const handling = f.bot.handle(message()); await began;
  const closing = f.bot.close(); resolve(result()); await Promise.all([handling, closing]);
  await f.bot.handle(message()); assert.equal(f.replies.length, 0);
});

test('actual query adapter and reply transport connect with fixture upstreams and no raw-key reflection', async t => {
  const usageRequests = [], deliveries = [];
  const keyUsage = new KeyUsageClient({ now: () => NOW, fetchImpl: async (url, options) => {
    usageRequests.push({ url, options }); return Response.json({ mode: 'unrestricted', isValid: true, balance: 50,
      usage: { total: { requests: 12, total_tokens: 123000, actual_cost: 2 } }, daily_usage: [] });
  } });
  const reply = createKookQueryReply({ token: 'fixture-only-token', fetchImpl: async (url, options) => {
    deliveries.push({ url, body: JSON.parse(options.body) }); return Response.json({ code: 0, data: { msg_id: 'fixture-reply-id' } });
  } });
  const f = await fixture(t, { keyUsage, reply }); await f.bot.handle(message());
  assert.equal(usageRequests.length, 2);
  assert.deepEqual(usageRequests.map(request => new URL(request.url).searchParams.get('days')), ['1', '7']);
  assert.ok(usageRequests.every(request => request.options.headers.authorization === `Bearer ${KEY}`));
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(deliveries[0].body.target_id, CHANNEL); assert.equal(deliveries[0].body.type, 10);
  assert.match(deliveries[0].body.content, /账户共享余额/); assert.ok(!JSON.stringify(deliveries).includes(KEY));
});
