import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaServer } from '../src/server.js';

test('guest schedule editing requires explicitly enabled public management and valid anonymous CSRF session', async t => {
  let saves = 0;
  const scheduler = { snapshot: () => ({ enabled: true, available: true, times: ['09:00'], timeZone: 'UTC' }),
    configure: async value => { saves++; assert.deepEqual(value, { enabled: true, times: ['09:00'], timeZone: 'UTC' }); } };
  const server = new QuotaServer({ host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://identity.invalid',
    publicManagement: true, scheduler, dashboard: { snapshot: () => ({ accounts: [] }) } });
  const address = await server.start(); t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}/quota/api/`;
  const response = await fetch(base + 'session'), session = await response.json();
  assert.equal(session.publicManagement, true); assert.equal(session.authenticated, false); assert.equal(session.canManage, true); assert.equal(session.publicAccess, true);
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrf, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ enabled: true, times: ['09:00'], timeZone: 'UTC' });
  assert.equal((await fetch(base + 'report-config', { method: 'POST', headers, body })).status, 200);
  for (const override of [{ cookie: '' }, { 'x-csrf-token': 'wrong' }, { Origin: 'https://foreign.invalid' }]) {
    assert.ok([401, 403].includes((await fetch(base + 'report-config', { method: 'POST', headers: { ...headers, ...override }, body })).status));
  }
  server.publicManagement = false;
  assert.equal((await fetch(base + 'report-config', { method: 'POST', headers, body })).status, 401);
  server.publicManagement = true; server.auth.logout(server.auth.get(headers.cookie));
  assert.equal((await fetch(base + 'report-config', { method: 'POST', headers, body })).status, 401);
  assert.equal(saves, 1);
});
