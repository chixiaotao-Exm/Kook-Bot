import test from 'node:test';
import assert from 'node:assert/strict';
import { KookGateway } from '../src/kook-gateway.js';

test('report gateway buffers more than 100 events and 4 MiB without losing original arrival times', async () => {
  let firstDone, allDone, time = 1_800_000_000_000;
  const finished = new Promise(resolve => { allDone = resolve; }), seen = [];
  const gateway = new KookGateway({ token: 'test', Socket: class {}, now: () => time,
    onEvent: async (event, context) => {
      seen.push({ id: event.id, receivedAt: context.receivedAt });
      if (event.id === 1) await new Promise(resolve => { firstDone = resolve; });
      if (event.id === 151) allDone();
    } });
  gateway.running = true; gateway.connected = true; gateway.botId = '1234567890';
  try {
    gateway.enqueue(1, { id: 1 }, 40000); await new Promise(resolve => setImmediate(resolve));
    for (let i = 2; i <= 151; i++) gateway.enqueue(i, { id: i }, 40000);
    assert.equal(gateway.pending.size, 151); assert.ok(gateway.pendingBytes > 4 * 1024 * 1024);
    time += 10 * 60_000; firstDone(); await finished;
    assert.equal(seen.length, 151); assert.deepEqual(seen.map(x => x.id), Array.from({ length: 151 }, (_, i) => i + 1));
    assert.ok(seen.every(x => x.receivedAt === 1_800_000_000_000));
  } finally { gateway.close(); }
});
