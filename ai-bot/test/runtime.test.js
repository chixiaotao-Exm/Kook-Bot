import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';

class FixtureGateway {
  constructor({ onEvent }) { this.onEvent = onEvent; this.botId = '7777777'; this.connected = false; }
  async start() { this.connected = true; }
  close() { this.connected = false; }
  snapshot() { return { connected: this.connected }; }
}

test('real controller integrates gateway, model, replies and private local health', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-runtime-'));
  let received, replied;
  const delivered = new Promise(resolve => { replied = resolve; });
  const config = { token: 'fixture-private-token', apiKey: 'fixture-private-key', model: 'gpt-6-astra', channelId: '88888888', dataDir, host: '127.0.0.1', port: 0 };
  const runtime = createRuntime({ config, Gateway: FixtureGateway, progress: null, logger: () => {},
    modelClient: { async generate(messages) { received = messages; return { text: '你好，连接成功', model: 'gpt-6-astra' }; } },
    reply: async payload => { replied(payload); return { messageId: 'reply-fixture' }; } });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const response = await fetch(`${base}/health`), status = await response.json();
  assert.equal(response.status, 200); assert.equal(status.model, 'gpt-6-astra');
  assert.equal(JSON.stringify(status).includes(config.token), false);
  assert.equal(JSON.stringify(status).includes(config.apiKey), false);
  const event = { type: 1, channel_type: 'GROUP', target_id: config.channelId, author_id: '99999999',
    msg_id: '00000000-0000-4000-8000-000000000001', msg_timestamp: Date.now(), content: '你好', extra: { author: { id: '99999999', bot: false } } };
  await runtime.gateway.onEvent(event);
  const payload = await delivered;
  assert.deepEqual(received, [{ role: 'user', content: '你好' }]);
  assert.equal(payload.targetId, config.channelId); assert.equal(payload.replyMessageId, event.msg_id);
  const disk = await readFile(path.join(dataDir, 'seen.json'), 'utf8');
  assert.ok(disk.includes(event.msg_id)); assert.ok(!disk.includes('你好'));
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 404);
  await runtime.close(); assert.equal(runtime.snapshot().ok, false);
});
