import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaServer } from '../src/server.js';

async function fixture(t, publicAccess) {
  let reads = 0;
  const snapshot = { enabled: true, loading: false, complete: true, stale: false, rows: [{ id: '7', name: '展示 Key', keyHint: 'sk-…abcd', today: { cost: 1.5 } }], totals: { keys: 1 } };
  const server = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080', publicAccess,
    dashboard: { snapshot: () => ({ accounts: [] }) }, scheduler: { snapshot: () => ({}) },
    allKeyUsage: { snapshot: () => { reads++; return structuredClone(snapshot); }, get: () => assert.fail('An HTTP page read must not trigger a full upstream scan') } });
  const address = await server.start(); t.after(() => server.close());
  return { server, url: `http://127.0.0.1:${address.port}/quota/api/status`, snapshot, reads: () => reads };
}
test('public overview status includes the shared safe key snapshot without an upstream scan per visitor', async t => {
  const f = await fixture(t, true);
  const values = await Promise.all(Array.from({ length: 3 }, async () => { const result = await fetch(f.url); assert.equal(result.status, 200); return result.json(); }));
  for (const result of values) assert.deepEqual(result.allKeyUsage, f.snapshot);
  assert.equal(f.reads(), 3);
});
test('key overview inherits existing private dashboard read authorization', async t => {
  const f = await fixture(t, false); assert.equal((await fetch(f.url)).status, 401); assert.equal(f.reads(), 0);
});
