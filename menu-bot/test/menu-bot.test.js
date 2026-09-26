import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MenuBot, parseMenuRequest } from '../src/menu-bot.js';
import { createWaiterService } from '../src/waiter-service.js';
import { createMenuSearch } from '../src/menu-search.js';
import { createSearchPages } from '../src/search-pages.js';

const channelId = '1234567890123456', channel2 = '1234567890123457';
const botId = '900000001', userId = '900000002', guildId = '900000003';
const messageId = number => number.toString(16).padStart(32, '0');
const event = (number = 1, patch = {}) => ({ type: 1, channel_type: 'GROUP', target_id: channelId,
  author_id: userId, msg_id: messageId(number), msg_timestamp: 1_800_000_000_000,
  content: '菜单', extra: { guild_id: guildId, author: { id: userId, bot: false } }, ...patch });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'menu-bot-test-'));
  let now = 1_800_000_000_000, options;
  const sends = [], logs = [];
  class Gateway {
    constructor(value) { options = value; this.running = false; }
    async start() { this.running = true; }
    close() { this.running = false; }
    snapshot() { return { botId, running: this.running, connected: this.running }; }
  }
  const config = { token: 'private-token', channelIds: [channelId, channel2], dataDir, Gateway,
    now: () => now, sendMenu: async (input, options) => { sends.push({ input, options }); return { messageId: messageId(99) }; },
    logger: code => logs.push(code), ...overrides };
  const bot = await new MenuBot(config).init();
  t.after(async () => { await bot.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { bot, config, dataDir, sends, logs, gatewayOptions: () => options,
    setNow: value => { now = value; }, now: () => now };
}

test('matches only exact Chinese menu requests and optional supported page', () => {
  for (const value of ['菜单', ' 中文菜单 \n']) assert.deepEqual(parseMenuRequest(value), [0,1,2,3,4,5,6,7]);
  for (const value of ['菜单1', '菜单 １', '中文菜单 一']) assert.deepEqual(parseMenuRequest(value), [0]);
  assert.deepEqual(parseMenuRequest('菜单 八'), [7]);
  for (const value of ['', '请发菜单', '菜单 9', '菜单 0', '菜单 1 2', '菜单\n然后', null, '(met)12345(met)菜单'])
    assert.equal(parseMenuRequest(value), null);
  assert.equal(parseMenuRequest('菜单 8', 4), null);
});

test('starts without sending; gateway handler uses fixed channel and sends all pages', async t => {
  const h = await setup(t);
  await h.bot.start(); assert.equal(h.sends.length, 0);
  assert.equal(h.gatewayOptions().eventTimeoutMs, 120_000);
  await h.gatewayOptions().onEvent(event(), { botId });
  assert.deepEqual(h.sends[0].input, { channelId, replyMessageId: messageId(1), pageIndices: [0,1,2,3,4,5,6,7] });
  assert.equal(h.bot.status().replies, 1);
});

test('single page uses zero-based index and accepts kmarkdown', async t => {
  const h = await setup(t);
  await h.bot.handle(event(1, { type: 9, content: '菜单 8' }));
  assert.deepEqual(h.sends[0].input.pageIndices, [7]);
});

test('ignores other channels, DMs, bot/system events, malformed identities and old/future events', async t => {
  const h = await setup(t);
  const patches = [{ target_id: '888888888' }, { channel_type: 'PERSON' }, { type: 255 },
    { author_id: botId }, { author_id: 'bad' }, { msg_id: 'bad' },
    { msg_timestamp: h.now() - 300_001 }, { msg_timestamp: h.now() + 60_001 },
    { extra: {} }, { extra: { author: { bot: true } } }, { extra: { author: { bot: 'false' } } },
    { extra: { author: { id: botId, bot: false } } }, { content: 'hello 菜单' }];
  for (const patch of patches) await h.bot.handle(event(1, patch));
  assert.equal(h.sends.length, 0);
});

test('omitted bot flag requires verified human and guild; unresolved/bot authors never send', async t => {
  let response = { id: userId, bot: false }, calls = 0;
  const h = await setup(t, { resolveAuthor: async input => { calls++; assert.deepEqual(input, { userId, guildId }); return response; } });
  await h.bot.handle(event(1, { extra: { guild_id: guildId, author: {} } }));
  assert.equal(h.sends.length, 1);
  h.setNow(h.now() + 11_000);
  for (const [index, author] of [null, { id: userId, bot: true }, { id: botId, bot: false }].entries()) {
    response = author;
    await h.bot.handle(event(index + 2, { msg_timestamp: h.now(), extra: { guild_id: guildId, author: {} } }));
  }
  await h.bot.handle(event(6, { msg_timestamp: h.now(), extra: { author: {} } }));
  assert.equal(h.sends.length, 1); assert.equal(calls, 4);
});

test('persists before any send and keeps only receipt metadata', async t => {
  let file;
  const h = await setup(t, { sendMenu: async () => {
    const ledger = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(ledger, { version: 1, receipts: [{ id: messageId(1), at: 1_800_000_000_000 }] });
  } });
  file = path.join(h.dataDir, 'menu-receipts.json');
  await h.bot.handle(event());
  const source = await readFile(file, 'utf8');
  for (const privateValue of [userId, guildId, channelId, '菜单', 'private-token']) assert.equal(source.includes(privateValue), false);
  assert.equal(h.bot.status().replies, 1);
});

test('concurrent duplicate and restart replay do not resend within 24 hours', async t => {
  const h = await setup(t);
  await Promise.all([h.bot.handle(event()), h.bot.handle(event())]);
  assert.equal(h.sends.length, 1);
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  h.setNow(h.now() + 23 * 60 * 60_000);
  await again.handle(event(1, { msg_timestamp: h.now() }));
  assert.equal(h.sends.length, 1);
});

test('expired receipts are pruned after 24 hours', async t => {
  const h = await setup(t);
  await h.bot.handle(event());
  h.setNow(h.now() + 24 * 60 * 60_000 + 1);
  await h.bot.handle(event(1, { msg_timestamp: h.now() }));
  assert.equal(h.sends.length, 2);
});

test('unknown send failure is never retried, including after restart', async t => {
  let calls = 0;
  const h = await setup(t, { sendMenu: async () => { calls++; throw new Error('private-url?token=private-token'); } });
  await h.bot.handle(event()); await h.bot.handle(event());
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  h.setNow(h.now() + 11_000); await again.handle(event(1, { msg_timestamp: h.now() }));
  assert.equal(calls, 1); assert.equal(h.bot.status().failures, 1);
  assert.equal(JSON.stringify(h.logs).includes('private'), false);
});

test('write failure disables future processing without sending', async t => {
  const h = await setup(t, { writeState: async () => { throw new Error('private failure'); } });
  await h.bot.handle(event()); await h.bot.handle(event(2));
  assert.equal(h.sends.length, 0); assert.equal(h.bot.status().enabled, false);
  assert.equal(h.bot.status().lastError, 'storage_failed');
});

test('stuck receipt write is bounded and its late completion cannot trigger a send', async t => {
  const write = defer();
  const h = await setup(t, { storageTimeoutMs: 5, writeState: () => write.promise });
  await h.bot.handle(event());
  assert.equal(h.bot.status().enabled, false);
  write.resolve(); await flush(); await h.bot.handle(event(2));
  assert.equal(h.sends.length, 0);
});

test('corrupt persisted receipts fail closed and cannot start gateway', async t => {
  const h = await setup(t);
  await writeFile(path.join(h.dataDir, 'menu-receipts.json'), '{broken');
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  assert.equal(again.status().enabled, false);
  await assert.rejects(again.start(), /not ready/); await again.handle(event());
  assert.equal(h.sends.length, 0);
});

test('2000 recent receipts stop intake instead of evicting live deduplication', async t => {
  const h = await setup(t);
  await writeFile(path.join(h.dataDir, 'menu-receipts.json'), JSON.stringify({ version: 1,
    receipts: Array.from({ length: 2000 }, (_, index) => ({ id: messageId(index + 1), at: h.now() })) }));
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  await again.handle(event(2001));
  assert.equal(again.status().lastError, 'receipt_capacity'); assert.equal(h.sends.length, 0);
});

test('channel and user cooldowns persist suppressed receipts without delayed replay', async t => {
  const h = await setup(t);
  await h.bot.handle(event(1));
  h.setNow(h.now() + 1500);
  await h.bot.handle(event(2, { msg_timestamp: h.now(), target_id: channel2 }));
  await h.bot.handle(event(3, { msg_timestamp: h.now(), author_id: '900000004', extra: { author: { bot: false } } }));
  h.setNow(h.now() + 10_000);
  await h.bot.handle(event(2, { msg_timestamp: h.now(), target_id: channel2 }));
  assert.equal(h.sends.length, 1);
  await h.bot.handle(event(4, { msg_timestamp: h.now() })); assert.equal(h.sends.length, 2);
});

test('global cooldown applies across different channels and users', async t => {
  const h = await setup(t);
  await h.bot.handle(event(1)); h.setNow(h.now() + 999);
  await h.bot.handle(event(2, { target_id: channel2, author_id: '900000004', extra: { author: { bot: false } }, msg_timestamp: h.now() }));
  assert.equal(h.sends.length, 1); assert.equal(h.bot.status().rejected, 1);
});

test('bounded pending queue does not retain unlimited gateway events', async t => {
  const send = defer(); let started;
  const entered = new Promise(resolve => { started = resolve; });
  const h = await setup(t, { sendMenu: async () => { started(); await send.promise; } });
  const first = h.bot.handle(event()); await entered;
  const tasks = Array.from({ length: 20 }, (_, index) => h.bot.handle(event(index + 2)));
  assert.equal(h.bot.status().pending, 8);
  send.resolve(); await Promise.all([first, ...tasks]);
  assert.equal(h.bot.status().pending, 0);
});

test('send timeout aborts request without retries and frees processing', async t => {
  let signal, calls = 0;
  const h = await setup(t, { sendTimeoutMs: 5, sendMenu: async (_, options) => { calls++; signal = options.signal; await new Promise(() => {}); } });
  await h.bot.handle(event());
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().active, 0);
  await h.bot.handle(event()); assert.equal(calls, 1);
});

test('gateway cancellation before processing causes no receipt or send', async t => {
  const h = await setup(t), controller = new AbortController(); controller.abort();
  await h.bot.handle(event(), { signal: controller.signal });
  assert.equal(h.sends.length, 0);
  await assert.rejects(readFile(path.join(h.dataDir, 'menu-receipts.json')), { code: 'ENOENT' });
});

test('closing aborts in-flight send and prevents queued and future sends', async t => {
  let signal, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = await setup(t, { sendMenu: async (_, options) => { signal = options.signal; entered(); await new Promise(() => {}); } });
  const first = h.bot.handle(event()); await started;
  const queued = h.bot.handle(event(2));
  await h.bot.close(); await Promise.all([first, queued]);
  await h.bot.handle(event(3));
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().requests, 1);
  assert.equal(h.bot.status().enabled, false); assert.equal(h.bot.status().pending, 0);
});

test('closing during identity resolution cannot produce a late reply', async t => {
  const resolution = defer(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = await setup(t, { resolveAuthor: async () => { entered(); return resolution.promise; } });
  const request = h.bot.handle(event(1, { extra: { guild_id: guildId, author: {} } }));
  await started; await h.bot.close();
  resolution.resolve({ id: userId, bot: false }); await request; await flush();
  assert.equal(h.sends.length, 0);
});

test('calculator replies with result without uploading menus; plain numbers and ordinary chat are ignored', async t => {
  const texts = [];
  const h = await setup(t, { sendText: async input => { texts.push(input); } });
  for (const content of ['12+14*2', '今天吃什么', '我会用计算器']) await h.bot.handle(event(1, { content }));
  assert.equal(texts.length, 0);
  await h.bot.handle(event(2, { content: '计算 12+14×2' }));
  assert.equal(texts.length, 1); assert.equal(h.sends.length, 0);
  assert.equal(texts[0].channelId, channelId); assert.equal(texts[0].replyMessageId, messageId(2));
  assert.match(texts[0].text, /计算结果/); assert.match(texts[0].text, /= 40\b/);
});

test('calculator help, arithmetic and errors use separate cooldown from menu with no raw-error echo', async t => {
  const texts = [];
  const h = await setup(t, { sendText: async input => { texts.push(input.text); } });
  await h.bot.handle(event(1));
  h.setNow(h.now() + 1000);
  await h.bot.handle(event(2, { content: '计算器', msg_timestamp: h.now() }));
  assert.match(texts[0], /美元/); assert.match(texts[0], /示例/);
  h.setNow(h.now() + 3000);
  await h.bot.handle(event(3, { content: '计算 1/0', msg_timestamp: h.now() }));
  assert.match(texts[1], /无法计算/);
  h.setNow(h.now() + 3000);
  await h.bot.handle(event(4, { content: '计算 $50 + €1 (met)all(met)', msg_timestamp: h.now() }));
  assert.match(texts[2], /无法计算/);
  assert.ok(!texts[2].includes('€1')); assert.ok(!texts[2].includes('(met)'));
  assert.equal(h.sends.length, 1);
});

test('calculator respects human and channel restrictions and shared receipts survive restart', async t => {
  const texts = [];
  const h = await setup(t, { sendText: async input => { texts.push(input.text); } });
  for (const patch of [{ target_id: '999999999' }, { extra: { author: { bot: true } } },
    { channel_type: 'PERSON' }, { author_id: botId }]) await h.bot.handle(event(1, { content: '计算 2+2', ...patch }));
  assert.equal(texts.length, 0);
  const calc = event(1, { content: '计算 123.456+7' });
  await Promise.all([h.bot.handle(calc), h.bot.handle(calc)]);
  assert.equal(texts.length, 1);
  const ledger = await readFile(path.join(h.dataDir, 'menu-receipts.json'), 'utf8');
  assert.ok(!ledger.includes('123.456')); assert.ok(!ledger.includes('计算'));
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  h.setNow(h.now() + 20_000);
  await again.handle({ ...calc, msg_timestamp: h.now() });
  await again.handle(event(1, { msg_timestamp: h.now() }));
  assert.equal(texts.length, 1); assert.equal(h.sends.length, 0);
});

test('calculator cooldown suppresses receipts permanently without a delayed second reply', async t => {
  const texts = [];
  const h = await setup(t, { sendText: async input => { texts.push(input.text); } });
  await h.bot.handle(event(1, { content: '计算 1+1' }));
  h.setNow(h.now() + 2000);
  await h.bot.handle(event(2, { content: '计算 2+2', msg_timestamp: h.now() }));
  h.setNow(h.now() + 1000);
  await h.bot.handle(event(2, { content: '计算 2+2', msg_timestamp: h.now() }));
  assert.equal(texts.length, 1);
  await h.bot.handle(event(3, { content: '计算 3+3', msg_timestamp: h.now() }));
  assert.equal(texts.length, 2);
});

test('calculator normalizes Windows multiline whitespace before card validation', async t => {
  const texts = [];
  const h = await setup(t, { sendText: async input => { texts.push(input.text); } });
  await h.bot.handle(event(1, { content: '计算 12\r\n+3' }));
  assert.equal(texts.length, 1); assert.match(texts[0], /= 15\b/); assert.ok(!texts[0].includes('\r'));
});

test('legacy menu-only integration ignores calculators without modifying receipts', async t => {
  const h = await setup(t);
  await h.bot.handle(event(1, { content: '计算 2+2' }));
  await assert.rejects(readFile(path.join(h.dataDir, 'menu-receipts.json')), { code: 'ENOENT' });
  await h.bot.handle(event()); assert.equal(h.sends.length, 1);
});

test('closing cancels calculator send, blocks queued replies and does not store expressions', async t => {
  let entered, signal, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const h = await setup(t, { sendText: async (_, options) => {
    calls++; signal = options.signal; entered(); await new Promise(() => {});
  } });
  const pending = h.bot.handle(event(1, { content: '计算 77+88' })); await started;
  const queued = h.bot.handle(event(2, { content: '计算 2+2' }));
  await h.bot.close(); await Promise.all([pending, queued]);
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(h.sends.length, 0);
  assert.ok(!(await readFile(path.join(h.dataDir, 'menu-receipts.json'), 'utf8')).includes('77+88'));
});

const waiterItems = [{ key: 'm1:1', group: '菜单一', code: '1', name: '春卷',
  spanish: 'LUMPIA', priceCents: 400, aliases: [], uncertain: false }];
const suggestion = { text: JSON.stringify({ action: 'suggest',
  items: [{ key: 'm1:1', quantity: 2 }], note: '' }), incomplete: false };

test('waiter help and direct Chinese dishes use waiter header while menu and calculator retain routing', async t => {
  const texts = []; let modelCalls = 0;
  const waiter = createWaiterService({ items: waiterItems, client: { generate: async () => { modelCalls++; return suggestion; } } });
  const h = await setup(t, { waiter, sendText: async input => { texts.push(input); } });
  await h.bot.handle(event(1, { content: '服务员' }));
  assert.equal(texts[0].title, '中文菜单 · 点餐服务员');
  assert.equal(texts[0].channelId, channelId); assert.equal(texts[0].replyMessageId, messageId(1));
  assert.match(texts[0].text, /中文菜名和数量/);
  h.setNow(h.now() + 3000);
  await h.bot.handle(event(2, { content: '春卷2份', msg_timestamp: h.now() }));
  assert.equal(texts[1].title, '中文菜单 · 点餐服务员');
  assert.match(texts[1].text, /LUMPIA/); assert.match(texts[1].text, /合计：\$8\.00/);
  h.setNow(h.now() + 1000);
  await h.bot.handle(event(3, { content: '计算 4*2', msg_timestamp: h.now() }));
  assert.match(texts[2].text, /计算结果/); assert.notEqual(texts[2].title, '中文菜单 · 点餐服务员');
  h.setNow(h.now() + 1000);
  await h.bot.handle(event(4, { msg_timestamp: h.now() }));
  assert.equal(h.sends.length, 1); assert.equal(modelCalls, 0);
});

test('waiter does not call AI or write receipts for unauthorized channels or non-human authors', async t => {
  let modelCalls = 0;
  const texts = [];
  const waiter = createWaiterService({ items: waiterItems, client: { generate: async () => { modelCalls++; return suggestion; } } });
  const h = await setup(t, { waiter, resolveAuthor: async () => null, sendText: async input => { texts.push(input); } });
  const patches = [
    { target_id: '999999999' }, { channel_type: 'PERSON' }, { type: 255 }, { author_id: botId },
    { author_id: 'bad' }, { msg_id: 'bad' }, { extra: {} },
    { extra: { author: { bot: true } } }, { extra: { author: { bot: 'false' } } },
    { extra: { author: { id: botId, bot: false } } },
    { extra: { guild_id: guildId, author: {} } }, { extra: { author: {} } },
    { msg_timestamp: h.now() - 300_001 }, { msg_timestamp: h.now() + 60_001 },
  ];
  for (const [index, patch] of patches.entries()) await h.bot.handle(event(index + 1, { content: '两个人吃，推荐一下', ...patch }));
  assert.equal(modelCalls, 0); assert.equal(texts.length, 0); assert.equal(h.sends.length, 0);
  await assert.rejects(readFile(path.join(h.dataDir, 'menu-receipts.json')), { code: 'ENOENT' });
});

test('waiter receipt exists before AI and progress or final replies; input and model content remain out of storage', async t => {
  const input = '两个人吃，推荐一下，private-diet-context';
  let file, modelCalls = 0;
  const texts = [];
  const checkReceipt = async () => assert.deepEqual(JSON.parse(await readFile(file, 'utf8')),
    { version: 1, receipts: [{ id: messageId(1), at: 1_800_000_000_000 }] });
  const waiter = createWaiterService({ items: waiterItems, client: { generate: async messages => {
    await checkReceipt(); modelCalls++;
    assert.equal(messages[0].content, input);
    return { ...suggestion, text: JSON.stringify({ ...JSON.parse(suggestion.text), note: 'private-model-output' }) };
  } } });
  const h = await setup(t, { waiter, sendText: async payload => { await checkReceipt(); texts.push(payload); } });
  file = path.join(h.dataDir, 'menu-receipts.json');
  await h.bot.handle(event(1, { content: input }));
  assert.equal(modelCalls, 1); assert.equal(texts.length, 2);
  assert.match(texts[0].text, /gpt-6-astra/); assert.match(texts[1].text, /合计：\$8\.00/);
  assert.ok(texts.every(payload => payload.title === '中文菜单 · 点餐服务员' && payload.replyMessageId === messageId(1)));
  const ledger = await readFile(file, 'utf8');
  for (const privateValue of [input, 'private-diet-context', 'private-model-output', '春卷', 'LUMPIA', 'gpt-6-astra', userId, guildId, channelId])
    assert.equal(ledger.includes(privateValue), false, privateValue);
  assert.equal(h.bot.status().replies, 1);
});

test('waiter never starts when durable receipt write fails', async t => {
  let calls = 0;
  const h = await setup(t, {
    waiter: { accepts: () => true, reply: async () => { calls++; return 'unexpected'; } },
    sendText: async () => { calls++; }, writeState: async () => { throw new Error('private-write-error'); },
  });
  await h.bot.handle(event(1, { content: '春卷2份' }));
  assert.equal(calls, 0); assert.equal(h.bot.status().enabled, false);
  assert.equal(h.bot.status().lastError, 'storage_failed');
});

test('closing aborts waiter generation and suppresses late answers and queued menu sends', async t => {
  const generation = defer(), entered = defer();
  const texts = []; let signal;
  const h = await setup(t, {
    waiter: { accepts: () => true, reply: async (_, options) => {
      signal = options.signal; entered.resolve(); return generation.promise;
    } }, sendText: async input => { texts.push(input); },
  });
  const first = h.bot.handle(event(1, { content: '两个人吃，推荐一下' }));
  await entered.promise;
  const queued = h.bot.handle(event(2));
  await h.bot.close(); await Promise.all([first, queued]);
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().active, 0);
  generation.resolve('private-late-ai-reply'); await flush();
  assert.equal(texts.length, 0); assert.equal(h.sends.length, 0);
  const ledger = await readFile(path.join(h.dataDir, 'menu-receipts.json'), 'utf8');
  assert.ok(!ledger.includes('private-late-ai-reply')); assert.ok(!ledger.includes('推荐'));
});

test('bounded waiter timeout frees a queued menu and suppresses an eventual late AI reply', { timeout: 3000 }, async t => {
  const generation = defer(), entered = defer();
  const texts = []; let signal, calls = 0;
  const h = await setup(t, { sendTimeoutMs: 25,
    waiter: { accepts: () => true, reply: async (_, options) => {
      calls++; signal = options.signal; entered.resolve(); return generation.promise;
    } }, sendText: async input => { texts.push(input); },
  });
  const first = h.bot.handle(event(1, { content: '帮我推荐' }));
  await entered.promise;
  h.setNow(h.now() + 1000);
  const menu = h.bot.handle(event(2, { msg_timestamp: h.now() }));
  await Promise.all([first, menu]);
  assert.equal(signal.aborted, true); assert.equal(h.bot.status().active, 0); assert.equal(h.bot.status().pending, 0);
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0].input.replyMessageId, messageId(2));
  assert.equal(h.bot.status().failures, 1); assert.equal(h.bot.status().replies, 1);
  generation.resolve('late-reply-after-timeout'); await flush();
  assert.equal(texts.length, 0);
  await h.bot.handle(event(1, { content: '帮我推荐', msg_timestamp: h.now() }));
  assert.equal(calls, 1);
});

test('waiter retries and restart replay share durable deduplication with other bot features', async t => {
  let calls = 0;
  const texts = [];
  const h = await setup(t, {
    waiter: { accepts: () => true, reply: async () => { calls++; return '点餐确认'; } },
    sendText: async input => { texts.push(input); },
  });
  const order = event(1, { content: '春卷2份' });
  await Promise.all([h.bot.handle(order), h.bot.handle(order)]);
  assert.equal(calls, 1); assert.equal(texts.length, 1);
  const again = await new MenuBot(h.config).init(); t.after(() => again.close());
  h.setNow(h.now() + 20_000);
  await again.handle({ ...order, msg_timestamp: h.now() });
  await again.handle(event(1, { content: '计算 2+2', msg_timestamp: h.now() }));
  await again.handle(event(1, { msg_timestamp: h.now() }));
  assert.equal(calls, 1); assert.equal(texts.length, 1); assert.equal(h.sends.length, 0);
});

const searchItems = Array.from({ length: 17 }, (_, index) => ({ key: `m2:${index + 1}`, group: '菜单二',
  code: `${index + 1}`, name: `清蒸鱼${index + 1}`, spanish: `PESCADO ${index + 1}`, priceCents: 1200,
  aliases: [], uncertain: false }));

async function setupPages(t, { ttlMs, update, ...overrides } = {}) {
  const texts = [], updates = [], cardId = messageId(9900);
  let h, waiterCalls = 0;
  const pages = createSearchPages({ search: createMenuSearch(searchItems),
    now: () => h?.now() ?? 1_800_000_000_000, ...(ttlMs === undefined ? {} : { ttlMs }) });
  const sendText = async (input, options) => { texts.push({ input, options }); return { messageId: cardId }; };
  sendText.update = async (input, options) => {
    updates.push({ input, options });
    if (update) return update(input, options);
    return { messageId: input.messageId };
  };
  h = await setup(t, { waiter: { accepts: text => typeof text === 'string',
    reply: async () => { waiterCalls++; return 'unexpected AI fallback'; } }, sendText, searchPages: pages, ...overrides });
  await h.bot.handle(event(1, { content: '搜索鱼' }));
  assert.equal(texts.length, 1);
  const button = texts[0].input.buttons.find(button => button.label === '下一页');
  assert.ok(button);
  const click = (number, body = {}, patch = {}) => ({ type: 255, channel_type: 'PERSON',
    target_id: 'unrelated-envelope-target', author_id: 'system-author', content: '',
    msg_id: messageId(number), msg_timestamp: h.now(), extra: { type: 'message_btn_click', body: {
      target_id: channelId, msg_id: cardId, user_id: userId, value: button.value,
      user_info: { id: userId, bot: false }, ...body,
    } }, ...patch });
  h.setNow(h.now() + 1000);
  return { ...h, texts, updates, cardId, click, pages, waiterCalls: () => waiterCalls };
}

test('search cards still get buttons when a verified-human message omits guild metadata', async t => {
  const texts = [], pages = createSearchPages({ search: createMenuSearch(searchItems) });
  const sendText = async input => { texts.push(input); return { messageId: messageId(9900) }; };
  sendText.update = async () => {};
  const h = await setup(t, { searchPages: pages, sendText,
    waiter: { accepts: () => true, reply: async () => { throw new Error('unexpected AI'); } } });
  await h.bot.handle(event(1, { content: '搜索鱼', extra: { author: { id: userId, bot: false } } }));
  assert.equal(texts.length, 1); assert.equal(texts[0].buttons[0].label, '下一页');
  assert.deepEqual(pages.context(texts[0].buttons[0].value, { channelId, messageId: messageId(9900) }), { guildId: null });
});

test('search buttons update the bound card in place using body channel instead of the PERSON envelope', async t => {
  const h = await setupPages(t);
  assert.equal(h.texts[0].input.title, '中文菜单 · 菜品搜索');
  assert.equal(h.texts[0].input.replyMessageId, messageId(1));
  assert.match(h.texts[0].input.text, /第 1\/3 页/);
  assert.doesNotMatch(h.texts[0].input.text, /查看下一页：/);
  await h.bot.handle(h.click(2));
  assert.equal(h.texts.length, 1); assert.equal(h.updates.length, 1);
  const updated = h.updates[0].input;
  assert.equal(updated.channelId, channelId); assert.equal(updated.messageId, h.cardId);
  assert.equal(updated.title, '中文菜单 · 菜品搜索');
  assert.match(updated.text, /第 2\/3 页/); assert.match(updated.text, /清蒸鱼9/);
  assert.deepEqual(updated.buttons.map(button => button.label), ['上一页', '下一页']);
  assert.equal(h.waiterCalls(), 0); assert.equal(h.sends.length, 0);
});

test('pagination callbacks cannot update another channel or card and reject malformed identity and timestamps', async t => {
  let resolutionCalls = 0;
  const h = await setupPages(t, { resolveButtonAuthor: async () => { resolutionCalls++; return null; } });
  const bodyPatches = [{ target_id: channel2 }, { target_id: '999999999' }, { msg_id: messageId(9901) },
    { user_info: { id: userId, bot: true } }, { user_info: { id: userId, bot: 'false' } },
    { user_info: { id: '900000099', bot: false } }, { user_info: null }, { user_info: [] },
    { user_id: botId, user_info: { id: botId, bot: false } }, { user_id: 'bad' },
    { msg_id: 'bad' }, { value: 'https://example.test' }, { value: 'menu-page:invalid' }];
  for (const [index, patch] of bodyPatches.entries()) {
    await h.bot.handle(h.click(index + 2, patch)); h.setNow(h.now() + 1000);
  }
  for (const [index, patch] of [{ msg_id: 'invalid' }, { msg_timestamp: h.now() - 300_001 },
    { msg_timestamp: h.now() + 60_001 }].entries()) await h.bot.handle(h.click(50 + index, {}, patch));
  assert.equal(h.updates.length, 0); assert.equal(h.texts.length, 1);
  assert.equal(resolutionCalls, 0); assert.equal(h.waiterCalls(), 0);
});

test('button clicks without user_info require a verified human from the original search guild', async t => {
  const resolutions = [];
  let author = { id: userId, bot: true };
  const h = await setupPages(t, { resolveButtonAuthor: async input => { resolutions.push(input); return author; } });
  await h.bot.handle(h.click(2, { user_info: undefined }));
  assert.equal(h.updates.length, 0);
  author = { id: userId, bot: false };
  await h.bot.handle(h.click(3, { user_info: undefined }));
  assert.equal(h.updates.length, 1); assert.equal(h.texts.length, 1); assert.equal(resolutions.length, 2);
  for (const input of resolutions) {
    assert.equal(input.userId, userId); assert.equal(input.guildId, guildId); assert.equal(input.channelId, channelId);
    assert.ok(input.signal instanceof AbortSignal);
  }
  assert.equal(h.waiterCalls(), 0);
});

test('button events have durable deduplication and expired cards give one restart-search hint', async t => {
  const h = await setupPages(t, { ttlMs: 2000 });
  const clicked = h.click(2);
  await Promise.all([h.bot.handle(clicked), h.bot.handle(clicked)]);
  assert.equal(h.updates.length, 1);
  h.setNow(h.now() + 2000);
  const expired = h.click(3);
  await h.bot.handle(expired); await h.bot.handle(expired);
  assert.equal(h.updates.length, 1); assert.equal(h.texts.length, 2);
  assert.match(h.texts[1].input.text, /已失效.*重新发送/);
  assert.equal(h.texts[1].input.channelId, channelId);
  const ledger = await readFile(path.join(h.dataDir, 'menu-receipts.json'), 'utf8');
  assert.deepEqual(JSON.parse(ledger).receipts.map(receipt => receipt.id), [messageId(1), messageId(2), messageId(3)]);
  for (const value of ['搜索鱼', clicked.extra.body.value, channelId, userId]) assert.equal(ledger.includes(value), false);
  const restarted = await new MenuBot(h.config).init(); t.after(() => restarted.close());
  await restarted.handle({ ...clicked, msg_timestamp: h.now() });
  await restarted.handle({ ...expired, msg_timestamp: h.now() });
  assert.equal(h.updates.length, 1); assert.equal(h.texts.length, 2); assert.equal(h.waiterCalls(), 0);
});

test('failed page updates never retry on event replay and do not generate a second search message', async t => {
  const h = await setupPages(t, { update: async () => { throw new Error('private-token network failure'); } });
  await h.bot.handle(h.click(2));
  h.setNow(h.now() + 2000); await h.bot.handle(h.click(2));
  assert.equal(h.updates.length, 1); assert.equal(h.texts.length, 1);
  assert.equal(h.bot.status().failures, 1); assert.equal(h.waiterCalls(), 0);
  assert.equal(JSON.stringify(h.logs).includes('private'), false);
});

test('closing aborts an in-flight page update and suppresses queued clicks', async t => {
  const entered = defer(); let signal;
  const h = await setupPages(t, { update: async (_, options) => {
    signal = options.signal; entered.resolve(); await new Promise(() => {});
  } });
  const pending = h.bot.handle(h.click(2)); await entered.promise;
  h.setNow(h.now() + 1000);
  const queued = h.bot.handle(h.click(3));
  await h.bot.close(); await Promise.all([pending, queued]);
  await h.bot.handle(h.click(4));
  assert.equal(signal.aborted, true); assert.equal(h.updates.length, 1); assert.equal(h.texts.length, 1);
  assert.equal(h.bot.status().active, 0); assert.equal(h.bot.status().pending, 0); assert.equal(h.waiterCalls(), 0);
});
