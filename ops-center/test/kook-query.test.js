import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsQueryBot } from '../src/kook-query.js';
import { OPS_CHANNELS } from './fixtures/channels.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const event = (number = 1, text = '状态', changes = {}) => ({ type: 1, channel_type: 'GROUP', target_id: OPS_CHANNELS.infra,
  author_id: '223456789', msg_id: String(number).padStart(8, '0') + '-bbbb-cccc-dddd-eeeeeeeeeeee', msg_timestamp: NOW,
  content: text, extra: { guild_id: '1234567890123456', author: { id: '223456789', bot: false } }, ...changes });
const sample = () => ({ updatedAt: new Date(NOW).toISOString(), hosts: [{ id: 'main', name: '主服务器', state: 'up',
  metrics: { cpuPercent: 12, memoryPercent: 30, diskPercent: 40 }, services: [{ id: 'duet', name: '思维互聊', expected: 'stopped', ok: false }],
  bots: [{ name: '思维1', state: 'stopped' }, { name: '音乐机器人', state: 'online', playing: true }, { name: '未知机器人', state: 'unknown' }] }],
  monitors: [{ name: '额度网站', state: 'up', latencyMs: 33, tlsDays: 14 }] });
async function fixture(t, options = {}) {
  let wall = NOW, reads = 0; const sent = [], logs = [], gateways = [];
  class Gateway {
    constructor(config) { this.options = config; this.connected = false; gateways.push(this); }
    snapshot() { return { botId: '123456789', connected: this.connected }; }
    async start() { this.connected = true; }
    close() { this.connected = false; }
  }
  const bot = new OpsQueryBot({ token: 'fixture-token', channelIds: OPS_CHANNELS, getSnapshot: () => { reads++; return sample(); },
    sendReply: async payload => { sent.push(payload); return { messageId: 'a'.repeat(32) }; },
    logger: value => logs.push(value), now: () => wall, Gateway, ...options });
  await bot.start(); t.after(() => bot.close());
  return { bot, sent, logs, gateways, reads: () => reads, advance(ms) { wall += ms; } };
}

test('start makes no announcement, and explicit queries summarize only whitelisted snapshot data in the caller channel', async t => {
  const f = await fixture(t); assert.deepEqual(f.sent, []); assert.equal(f.bot.status().connected, true);
  await f.bot.handle(event()); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].category, 'infra');
  assert.ok(f.sent[0].lines.some(line => line.includes('CPU 12%'))); assert.ok(f.sent[0].lines.some(line => line.includes('思维1：已停止')));
  assert.ok(f.sent[0].lines.some(line => line.includes('未知机器人：未知'))); assert.equal(f.sent[0].theme, 'warning');
  f.advance(3001); await f.bot.handle(event(2, '网站状态', { target_id: OPS_CHANNELS.web }));
  assert.equal(f.sent[1].category, 'web'); assert.match(f.sent[1].lines[0], /额度网站：正常.*33ms.*14 天/);
  f.advance(3001); await f.bot.handle(event(3, '运维帮助')); assert.equal(f.reads(), 2);
});

test('only exact human commands in authorized group channels can query or receive a reply', async t => {
  const f = await fixture(t);
  for (const evt of [event(1, '状态', { channel_type: 'PERSON' }), event(2, '状态', { target_id: '99999999' }),
    event(3, '帮我看状态'), event(4, '重启服务器'), event(5, '状态', { author_id: '123456789' }),
    event(6, '状态', { extra: { author: { id: '223456789', bot: true } } }),
    event(7, '状态', { extra: { author: { id: 'wrong-user', bot: false } } }),
    event(8, '状态', { extra: { author: { bot: 'false' } } }), event(9, '状态', { msg_timestamp: NOW - 300001 })]) await f.bot.handle(evt);
  assert.equal(f.reads(), 0); assert.deepEqual(f.sent, []);
});

test('query captures custom channel configuration and does not follow later mutation', async t => {
  const channelIds = { infra: '3333333333333333', web: '4444444444444444' };
  const f = await fixture(t, { channelIds });
  channelIds.infra = '5555555555555555';
  await f.bot.handle(event(1, '状态', { target_id: channelIds.infra }));
  await f.bot.handle(event(2, '状态'));
  assert.equal(f.sent.length, 0);
  await f.bot.handle(event(3, '状态', { target_id: '3333333333333333' }));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].category, 'infra');
  f.advance(3001);
  await f.bot.handle(event(4, '状态', { target_id: '4444444444444444' }));
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].category, 'web');
});

test('repair status is read-only and does not claim restart execution means recovery', async t => {
  const f=await fixture(t,{getSnapshot:()=>({...sample(),autoRepair:{enabled:true,states:[{phase:'verifying',message:'重启命令完成，仍在复核'}],events:[]}})});
  await f.bot.handle(event(1,'修复状态'));
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].title,'自动修复状态');
  assert.ok(f.sent[0].lines.some(line=>line.includes('连续2次未获取到健康状态')));
  assert.ok(f.sent[0].lines.some(line=>line.includes('仍在复核')));
  assert.ok(!f.sent[0].lines.some(line=>line.includes('已确认恢复')));
});

test('unknown bot flags require authoritative identity and never echo identity errors or arbitrary chat', async t => {
  let identity = { id: '223456789', bot: true }, calls = 0;
  const f = await fixture(t, { resolveAuthor: async () => { calls++; return identity; } });
  const missing = { extra: { guild_id: '1234567890123456' } };
  await f.bot.handle(event(1, '状态', missing)); assert.equal(f.sent.length, 0);
  f.advance(10001);
  identity = { id: 'wrong-user', bot: false }; await f.bot.handle(event(2, '状态', missing)); assert.equal(f.sent.length, 0);
  f.advance(10001);
  identity = { id: '223456789', bot: false }; await f.bot.handle(event(3, '状态', missing)); assert.equal(f.sent.length, 1); assert.equal(calls, 3);
  assert.doesNotMatch(JSON.stringify(f.logs), /223456789|1234567890123456/);
});

test('production identity lookup uses only the official read endpoint, caches results and bounds unknown-author traffic', async t => {
  const calls = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json({ code: 0, data: { id: new URL(url).searchParams.get('user_id'), bot: calls.length > 1, private: 'hidden' } });
  } });
  const missing = { extra: { guild_id: '1234567890123456' } };
  await f.bot.handle(event(1, '状态', missing)); f.advance(3001); await f.bot.handle(event(2, '状态', missing));
  assert.equal(f.sent.length, 2); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://www.kookapp.cn/api/v3/user/view');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, 'Bot fixture-token');
  for (let i = 3; i <= 50; i++) await f.bot.handle(event(i, '状态', { ...missing, author_id: String(400000000 + i) }));
  assert.equal(calls.length, 30); assert.equal(f.sent.length, 2);
});

test('message receipts, cooldowns and a minute budget prevent duplicate or runaway replies', async t => {
  const f = await fixture(t);
  await f.bot.handle(event(1)); await f.bot.handle(event(1)); await f.bot.handle(event(2));
  assert.equal(f.sent.length, 1);
  for (let i = 3; i <= 40; i++) await f.bot.handle(event(i, '状态', { author_id: String(300000000 + i),
    extra: { author: { bot: false } } }));
  assert.equal(f.sent.length, 30); assert.equal(f.bot.status().replies, 30);
});

test('unknown snapshots, many resources and private fields stay bounded and do not imply healthy resources', async t => {
  const f = await fixture(t, { getSnapshot: () => ({ hosts: Array.from({ length: 20 }, () => ({ name: 'token=private-secret @all',
    state: 'unknown', credentials: 'private-credential', bots: [{ name: 'Bot', state: 'stopped', lastError: 'private-token-value' }] })) }) });
  await f.bot.handle(event()); const message = f.sent[0];
  assert.equal(message.lines.length, 12); assert.match(message.lines.at(-1), /另有/); assert.equal(message.theme, 'warning');
  assert.doesNotMatch(JSON.stringify(message), /private-secret|private-credential|private-token-value|@all/);
});

test('delivery failures are never retried and close suppresses late snapshots', async t => {
  let attempts = 0;
  const failed = await fixture(t, { sendReply: async () => { attempts++; throw Error('private upstream'); } });
  await failed.bot.handle(event()); await failed.bot.handle(event()); assert.equal(attempts, 1);
  assert.equal(failed.bot.status().lastError, 'DELIVERY'); assert.doesNotMatch(JSON.stringify(failed.logs), /private/);
  let release; const late = await fixture(t, { getSnapshot: () => new Promise(resolve => { release = resolve; }) });
  const pending = late.bot.handle(event()); await new Promise(setImmediate); await late.bot.close();
  release(sample()); await pending; assert.deepEqual(late.sent, []); assert.equal(late.bot.status().connected, false);
});
