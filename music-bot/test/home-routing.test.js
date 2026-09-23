import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RoomAccess } from '../src/room-access.js';
import { WebConsole } from '../src/web.js';

test('public home stays the room lobby while console HTML follows current management roles', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-home-routing-'));
  const access = await new RoomAccess({ dataDir: dir }).init();
  const config = { dataDir: dir, webRequirePassword: false, webPort: 0, webHost: '127.0.0.1' };
  const manager = { list: () => [{ id: 'default', name: 'Bot', status: 'ready', online: true }] };
  const web = new WebConsole({ config, access, rooms: {}, manager, music: {} }); const address = await web.start();
  const base = `http://127.0.0.1:${address.port}`;
  const get = (route, identity) => fetch(base + route, { headers: identity ? { Cookie: `kook_identity=${identity.token}` } : {}, redirect: 'manual' });
  t.after(async () => { await web.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-home-routing-')); await rm(dir, { recursive: true, force: true }); });
  const visitor = await access.ensure(); await access.profile(visitor.actor.id, 'Member');
  for (const identity of [undefined, visitor]) {
    const home = await get('/', identity); assert.equal(home.status, 200); assert.match(await home.text(), /id="room-cards"/);
    const consoleResponse = await get('/admin/console?botId=default&view=room', identity);
    assert.equal(consoleResponse.status, 302); assert.equal(consoleResponse.headers.get('cache-control'), 'no-store');
    const login = new URL(consoleResponse.headers.get('location'), base); assert.equal(login.pathname, '/admin');
    assert.equal(login.searchParams.get('returnTo'), '/admin/console?botId=default&view=room');
  }
  const alias = await get('/index.html?botId=default'); assert.equal(alias.status, 302); assert.equal(alias.headers.get('location'), '/admin/console?botId=default');
  const admin = await access.ensure(); await access.redeem(admin.actor.id, await access.rotateAdminLink());
  assert.match(await (await get('/', admin)).text(), /id="room-cards"/);
  assert.match(await (await get('/admin/console', admin)).text(), /id="bot-select"/);
  const invite = await access.issueInvite(admin.actor.id, 'default', 'dj'); await access.redeem(visitor.actor.id, invite.token);
  assert.equal((await get('/admin/console?botId=default', visitor)).status, 200);
  await access.revoke(admin.actor.id, 'default', visitor.actor.id);
  assert.equal((await get('/admin/console', visitor)).status, 302);
  assert.match(await (await get('/rooms')).text(), /id="room-cards"/);
});
