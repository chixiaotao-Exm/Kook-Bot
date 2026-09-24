import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotificationQueue } from '../src/queue.js';
import { BridgeServer } from '../src/server.js';
import { validNotification } from '../src/events.js';

test('signed webhook, durable queue, send receipt and replay survive a restart together', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kook-bridge-integration-'));
  const repository = 'chixiaotao-Exm/Kook-Bot', secret = 'test-secret-' + 'b'.repeat(32);
  let sent, sends = 0;
  const delivered = new Promise(resolve => { sent = resolve; });
  const dependencies = { dataDir, intervalMs: 1, validate: value => validNotification(value, repository),
    send: async notification => {
      sends++;assert.equal(notification.kind, 'push');sent();return { messageId: '12345678-1234-1234-1234-1234567890ab' };
    } };
  let queue = await new NotificationQueue(dependencies).init();
  let server = new BridgeServer({ port: 0, repository, secret, queue });
  let address = await server.start();queue.start();
  t.after(async () => { await server.close();await queue.close();await rm(dataDir, { recursive: true, force: true }); });
  const raw = JSON.stringify({ repository: { full_name: repository }, ref: 'refs/heads/main', deleted: false,
    before: 'a'.repeat(40), after: 'c'.repeat(40), commits: [{ id: 'c'.repeat(40), message: 'Functional change' }] });
  const request = () => fetch(`http://127.0.0.1:${address.port}/github`, { method: 'POST', body: raw, headers: {
    'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': randomUUID(),
    'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
  } });
  assert.equal((await request()).status, 202);
  let timer;
  try { await Promise.race([delivered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery did not start')), 3000); })]); }
  finally { clearTimeout(timer); }
  await server.close();await queue.close();
  const state = JSON.parse(await readFile(path.join(dataDir, 'bridge-queue.json'), 'utf8'));
  assert.equal(state.records[0].state, 'sent');assert.equal(state.records[0].notification, undefined);
  queue = await new NotificationQueue(dependencies).init();server = new BridgeServer({ port: 0, repository, secret, queue });
  address = await server.start();queue.start();
  const replay = await request();assert.equal(replay.status, 200);assert.equal((await replay.json()).duplicate, true);
  assert.equal(sends, 1);assert.equal(queue.snapshot().sent, 1);
});
