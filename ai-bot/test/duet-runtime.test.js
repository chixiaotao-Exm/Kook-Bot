import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDuetRuntime } from '../src/duet-index.js';

class Gateway {
  constructor({ onEvent }) { this.onEvent = onEvent; this.connected = false; this.botId = ''; }
  async start() { this.connected = true; }
  close() { this.connected = false; }
  snapshot() { return { connected: this.connected, botId: this.botId }; }
}
const event = (content, number = 1) => ({ type: 1, channel_type: 'GROUP', target_id: '88888888',
  author_id: '99999999', msg_id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  msg_timestamp: Date.now(), content, extra: { author: { id: '99999999', bot: false } } });
async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected duet state transition');
}

test('only primary gateway routes human commands; both identities alternate confirmed posts', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-runtime-'));
  const config = { tokens: ['fixture-bot-a', 'fixture-bot-b'], models: ['gpt-6-astra', 'gpt-6-astra'],
    labels: ['A', 'B'], channelId: '88888888', dataDir, host: '127.0.0.1', port: 0,
    rounds: 0, betweenTurnsMs: 0, deadlineMs: 0 };
  const generated = [], deliveries = [], notices = [];
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
    clients: [0, 1].map(index => ({ async generate(messages) { generated.push({ index, messages }); return { text: `第${index}方的观点` }; } })),
    replies: [0, 1].map(index => async payload => { deliveries.push({ index, payload }); return { messageId: `00000000-0000-4000-8000-${String(100 + deliveries.length).padStart(12, '0')}` }; }),
    commandReply: async payload => { notices.push(payload); return { messageId: '00000000-0000-4000-8000-000000000099' }; },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.bots.length, 2);
  assert.deepEqual(health.defaults, { unlimited: true, rounds: null, deadlineMs: null });
  assert.ok(!JSON.stringify(health).includes(config.tokens[0]));
  const input = event('/互聊 1 如何规划周末散步');
  await runtime.gateways[1].onEvent(input); assert.equal(generated.length, 0);
  await runtime.gateways[0].onEvent(input);
  await waitFor(() => generated.length === 2 && !runtime.session.snapshot().active);
  assert.deepEqual(generated.map(item => item.index), [0, 1]);
  assert.deepEqual(deliveries.slice(0, 2).map(item => item.index), [0, 1]);
  assert.ok(deliveries.every(item => item.payload.textOnly === true && item.payload.targetId === config.channelId));
  assert.ok(JSON.stringify(generated[1].messages).includes('第0方的观点'));
  await runtime.gateways[0].onEvent(input); assert.equal(generated.length, 2);
  assert.ok(!(await readFile(path.join(dataDir, 'duet-seen.json'), 'utf8')).includes('周末散步'));
  assert.ok(!JSON.stringify(runtime.snapshot()).includes('周末散步'));
});

test('same bot account behind different tokens is rejected before gateways start', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-identity-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 6, deadlineMs: 600000, betweenTurnsMs: 0 };
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '11111111' }] }),
    clients: [{ generate() { throw Error('Must not generate'); } }, { generate() { throw Error('Must not generate'); } }],
    replies: [async () => {}, async () => {}], commandReply: async () => {},
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(runtime.start(), /identity/);
  assert.ok(runtime.gateways.every(gateway => !gateway.connected));
});
