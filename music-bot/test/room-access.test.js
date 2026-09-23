import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RoomAccess, IDENTITY_TTL_MS, INVITE_TTL_MS } from '../src/room-access.js';

const execute = promisify(execFile);
const forbidden = (error) => error.statusCode === 403;

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-room-access-'));
  t.after(async () => { assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); });
  let now = 1000000;
  const access = await new RoomAccess({ dataDir: dir, now: () => now, ...options }).init();
  const visitor = async (name) => {
    const identity = await access.ensure();
    if (name) identity.actor = await access.profile(identity.actor.id, name);
    return identity;
  };
  const admin = async () => {
    const identity = await visitor('站长');
    const link = await access.rotateAdminLink();
    await access.redeem(identity.actor.id, link);
    return { ...identity, actor: access.actor(identity.actor.id), link };
  };
  return { access, dir, visitor, admin, advance: (milliseconds) => { now += milliseconds; } };
}

test('visitor identity persists hashed bearer independently from public id and requires a nickname for member', async (t) => {
  const { access, dir } = await fixture(t);
  const first = await access.ensure();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(first.actor.id, first.token);
  assert.deepEqual(first.actor, { id: first.actor.id, name: '', siteAdmin: false });
  assert.equal(access.role(first.actor.id, 'default'), 'guest');
  assert.equal(access.get(first.actor.id), null); assert.equal(access.get('forged-token'), null);
  assert.deepEqual(await access.ensure(first.token), { actor: first.actor });
  const member = await access.profile(first.actor.id, '  小桃  ');
  assert.equal(member.name, '小桃'); assert.equal(access.role(member.id, 'default'), 'member');
  assert.equal(access.require(member.id, 'default', 'member').id, member.id);
  assert.throws(() => access.require(member.id, 'default', 'dj'), forbidden);
  const restored = await new RoomAccess({ dataDir: dir, now: access.now }).init();
  assert.deepEqual(restored.get(first.token), member);
  const raw = await readFile(access.file, 'utf8');
  assert.ok(!raw.includes(first.token)); assert.ok(!JSON.stringify(member).includes('hash'));
  if (process.platform !== 'win32') assert.equal((await stat(access.file)).mode & 0o777, 0o600);
});

test('nickname validation rejects markup, hidden controls and overlong names without modifying existing profile', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor('小桃');
  for (const name of ['', '   ', '<script>', 'a\nb', 'a\u200bb', 'a\u202eb', '🙂'.repeat(33), {}, null]) {
    await assert.rejects(access.profile(user.actor.id, name));
    assert.equal(access.actor(user.actor.id).name, '小桃');
  }
  assert.equal((await access.profile(user.actor.id, 'ＡＣＧ')).name, 'ACG');
  await assert.rejects(access.profile('forged-id', 'Somebody'), forbidden);
});

test('site administrator link is reusable on devices and rotation revokes old admin sessions and old links', async (t) => {
  const { access, admin, visitor, dir } = await fixture(t);
  const first = await admin(), second = await visitor('另一设备');
  const redeemed = await access.redeem(second.actor.id, first.link);
  assert.equal(redeemed.siteAdmin, true); assert.equal(access.role(second.actor.id, 'another-room'), 'owner');
  assert.equal(access.requireAdmin(second.actor.id).siteAdmin, true);
  const token = await access.rotateAdminLink();
  assert.equal(access.get(first.token).siteAdmin, false); assert.equal(access.get(second.token).siteAdmin, false);
  assert.throws(() => access.requireAdmin(first.actor.id), forbidden);
  await assert.rejects(access.redeem(second.actor.id, first.link));
  await access.redeem(first.actor.id, token); assert.equal(access.get(first.token).siteAdmin, true);
  assert.ok(!(await readFile(access.file, 'utf8')).includes(token));
  const restored = await new RoomAccess({ dataDir: dir, now: access.now }).init();
  assert.equal(restored.get(first.token).siteAdmin, true); assert.equal(restored.get(second.token).siteAdmin, false);
});

test('room owner is scoped, may invite DJs but cannot grant owners, and role revocation is immediate', async (t) => {
  const { access, admin, visitor } = await fixture(t), site = await admin();
  const owner = await visitor('房主'), dj = await visitor('DJ'), outsider = await visitor('路人');
  const ownerInvite = await access.issueInvite(site.actor.id, 'room-one', 'owner');
  await access.redeem(owner.actor.id, ownerInvite.token);
  assert.equal(access.role(owner.actor.id, 'room-one'), 'owner'); assert.equal(access.role(owner.actor.id, 'room-two'), 'member');
  assert.equal(access.actor(owner.actor.id).siteAdmin, false);
  await assert.rejects(access.issueInvite(owner.actor.id, 'room-one', 'owner'), forbidden);
  await assert.rejects(access.issueInvite(owner.actor.id, 'room-two', 'dj'), forbidden);
  await assert.rejects(access.issueInvite(outsider.actor.id, 'room-one', 'dj'), forbidden);
  const invitation = await access.issueInvite(owner.actor.id, 'room-one', 'dj');
  const result = await access.redeem(dj.actor.id, invitation.token);
  assert.equal(result.botId, 'room-one'); assert.equal(result.role, 'dj'); assert.equal(result.siteAdmin, false);
  assert.equal(access.role(dj.actor.id, 'room-two'), 'member');
  assert.ok(access.members('room-one').some((member) => member.id === dj.actor.id && member.role === 'dj'));
  assert.ok(!access.members('room-two').some((member) => member.id === dj.actor.id));
  await assert.rejects(access.revoke(owner.actor.id, 'room-one', site.actor.id), forbidden);
  await assert.rejects(access.revoke(owner.actor.id, 'room-one', owner.actor.id), forbidden);
  await access.revoke(owner.actor.id, 'room-one', dj.actor.id);
  assert.equal(access.get(dj.token).id, dj.actor.id); assert.equal(access.role(dj.actor.id, 'room-one'), 'member');
  assert.throws(() => access.require(dj.actor.id, 'room-one', 'dj'), forbidden);
  await access.revoke(site.actor.id, 'room-one', owner.actor.id);
  assert.equal(access.role(owner.actor.id, 'room-one'), 'member');
});

test('single-use invites serialize concurrent redemption and reject revoked, expired or forged tokens', async (t) => {
  const { access, admin, visitor, advance } = await fixture(t), site = await admin();
  const users = await Promise.all([visitor('一'), visitor('二')]);
  const invite = await access.issueInvite(site.actor.id, 'room-one', 'dj');
  assert.equal(invite.expires - access.now(), INVITE_TTL_MS);
  const results = await Promise.allSettled(users.map((user) => access.redeem(user.actor.id, invite.token)));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(users.filter((user) => access.role(user.actor.id, 'room-one') === 'dj').length, 1);
  await assert.rejects(access.redeem(users[0].actor.id, invite.token));
  await assert.rejects(access.redeem(users[0].actor.id, 'a'.repeat(43)));
  const revoked = await access.issueInvite(site.actor.id, 'room-one', 'dj');
  await assert.rejects(access.revokeInvite(site.actor.id, 'wrong-room', revoked.id));
  assert.ok(access.invites(site.actor.id, 'room-one').some((entry) => entry.id === revoked.id));
  await access.revokeInvite(site.actor.id, 'room-one', revoked.id);
  await assert.rejects(access.redeem(users[0].actor.id, revoked.token));
  const expired = await access.issueInvite(site.actor.id, 'room-one', 'dj');
  advance(INVITE_TTL_MS);
  await assert.rejects(access.redeem(users[0].actor.id, expired.token));
  assert.equal(access.invites(site.actor.id, 'room-one').length, 0);
});

test('revoked owner and rotated site admin cannot leave reusable privilege invitations behind', async (t) => {
  const { access, admin, visitor } = await fixture(t), site = await admin(), owner = await visitor('房主'), target = await visitor('访客');
  await access.redeem(owner.actor.id, (await access.issueInvite(site.actor.id, 'room-one', 'owner')).token);
  const fromOwner = await access.issueInvite(owner.actor.id, 'room-one', 'dj');
  await access.revoke(site.actor.id, 'room-one', owner.actor.id);
  await assert.rejects(access.redeem(target.actor.id, fromOwner.token));
  const fromAdmin = await access.issueInvite(site.actor.id, 'room-two', 'owner');
  const newAdminLink = await access.rotateAdminLink();
  await assert.rejects(access.redeem(target.actor.id, fromAdmin.token));
  await access.redeem(site.actor.id, newAdminLink);
  await assert.rejects(access.redeem(target.actor.id, fromAdmin.token), 'Reauthorizing the issuer must not revive old-epoch invitations');
});

test('expired identities cannot authorize and capacity pruning never removes authorized identities', async (t) => {
  const { access, admin, visitor, advance } = await fixture(t, { identityLimit: 4 });
  const site = await admin(), owner = await visitor('房主'), guest = await visitor('访客'), spare = await visitor();
  await access.redeem(owner.actor.id, (await access.issueInvite(site.actor.id, 'room-one', 'owner')).token);
  const extra = await visitor();
  assert.equal(access.get(guest.token), null, 'At capacity, an unprivileged visitor can be displaced but not an authorized identity');
  assert.equal(access.requireAdmin(site.actor.id).siteAdmin, true);
  assert.equal(access.role(owner.actor.id, 'room-one'), 'owner');
  advance(IDENTITY_TTL_MS);
  assert.equal(access.get(owner.token), null); assert.equal(access.actor(owner.actor.id), null);
  assert.equal(access.role(owner.actor.id, 'room-one'), 'guest'); assert.throws(() => access.requireAdmin(site.actor.id), forbidden);
  const created = await visitor('新访客'); assert.ok(created.actor.id);
  assert.ok(access.state.identities.some((entry) => entry.id === site.actor.id));
  assert.ok(access.state.identities.some((entry) => entry.id === owner.actor.id));
  assert.ok(!access.state.identities.some((entry) => [guest.actor.id, spare.actor.id, extra.actor.id].includes(entry.id)));
  assert.ok(access.members('room-one').some((entry) => entry.id === owner.actor.id && entry.expired));
});

test('failed writes do not consume invitations, change profiles, revoke roles or rotate administrator authorization', async (t) => {
  const { access, admin, visitor } = await fixture(t), site = await admin(), user = await visitor('原昵称');
  const invite = await access.issueInvite(site.actor.id, 'default', 'dj'), writeState = access.writeState;
  const before = await readFile(access.file, 'utf8');
  access.writeState = async () => { throw new Error('disk is full'); };
  await assert.rejects(access.profile(user.actor.id, '新昵称'), /未生效/);
  await assert.rejects(access.redeem(user.actor.id, invite.token), /未生效/);
  await assert.rejects(access.rotateAdminLink(), /未生效/);
  await assert.rejects(access.logout(site.actor.id), /未生效/);
  assert.equal(access.actor(user.actor.id).name, '原昵称'); assert.equal(access.role(user.actor.id, 'default'), 'member');
  assert.equal(access.requireAdmin(site.actor.id).siteAdmin, true); assert.equal(await readFile(access.file, 'utf8'), before);
  access.writeState = writeState; await access.redeem(user.actor.id, invite.token);
  access.writeState = async () => { throw new Error('disk is full'); };
  await assert.rejects(access.revoke(site.actor.id, 'default', user.actor.id), /未生效/);
  assert.equal(access.role(user.actor.id, 'default'), 'dj');
  access.writeState = writeState;
});

test('server-side logout invalidates copied identity tokens and outstanding invites but preserves granted profile history', async (t) => {
  const { access, admin, visitor, dir } = await fixture(t), site = await admin(), owner = await visitor('曾经的房主'), other = await visitor('新访客');
  await access.redeem(owner.actor.id, (await access.issueInvite(site.actor.id, 'default', 'owner')).token);
  const pending = await access.issueInvite(owner.actor.id, 'default', 'dj');
  await access.logout(owner.actor.id);
  assert.equal(access.get(owner.token), null); assert.equal(access.actor(owner.actor.id), null);
  assert.throws(() => access.require(owner.actor.id, 'default', 'owner'), forbidden);
  assert.ok(access.members('default').some((entry) => entry.id === owner.actor.id && entry.name === '曾经的房主' && entry.expired));
  await assert.rejects(access.redeem(other.actor.id, pending.token));
  await assert.rejects(access.profile(owner.actor.id, '不能复活'), forbidden);
  const renewed = await access.ensure(owner.token);
  assert.notEqual(renewed.actor.id, owner.actor.id); assert.equal(access.role(renewed.actor.id, 'default'), 'guest');
  await access.logout(site.actor.id);
  assert.equal(access.get(site.token), null); assert.throws(() => access.requireAdmin(site.actor.id), forbidden);
  await access.redeem(other.actor.id, site.link);
  assert.equal(access.requireAdmin(other.actor.id).siteAdmin, true, 'The private management link can authorize a new browser identity');
  const restored = await new RoomAccess({ dataDir: dir, now: access.now }).init();
  assert.equal(restored.get(owner.token), null); assert.equal(restored.get(site.token), null);
});

test('capacity refuses admission when every retained identity has explicit authorization', async (t) => {
  const { access, admin, visitor } = await fixture(t, { identityLimit: 2 });
  const site = await admin(), owner = await visitor('房主');
  await access.redeem(owner.actor.id, (await access.issueInvite(site.actor.id, 'default', 'owner')).token);
  await assert.rejects(visitor(), /上限/);
  assert.equal(access.get(site.token).siteAdmin, true); assert.equal(access.role(owner.actor.id, 'default'), 'owner');
});

test('corrupt permission files remain untouched and reload failures preserve the last working cache', async (t) => {
  const { access, visitor, dir } = await fixture(t), user = await visitor('成员');
  const broken = '{"version":1,"identities":"broken"}';
  await writeFile(access.file, broken);
  await assert.rejects(new RoomAccess({ dataDir: dir }).init(), /原文件已保留/);
  await assert.rejects(access.reload(), /原文件已保留/);
  await assert.rejects(access.profile(user.actor.id, '不能覆盖坏文件'), /原文件已保留/);
  assert.equal(await readFile(access.file, 'utf8'), broken); assert.equal(access.get(user.token).name, '成员');
});

test('invite metadata and roster never reveal bearer material and a lower invite cannot downgrade an owner', async (t) => {
  const { access, admin, visitor } = await fixture(t), site = await admin(), owner = await visitor('房主');
  const first = await access.issueInvite(site.actor.id, 'default', 'owner'); await access.redeem(owner.actor.id, first.token);
  const next = await access.issueInvite(site.actor.id, 'default', 'dj');
  const metadata = JSON.stringify({ invites: access.invites(site.actor.id, 'default'), members: access.members('default') });
  assert.ok(!metadata.includes(next.token)); assert.ok(!metadata.includes('hash')); assert.ok(!metadata.includes(site.token));
  assert.equal((await access.redeem(owner.actor.id, next.token)).role, 'owner');
});

test('offline administrator CLI writes a private fragment link and never prints its token', async (t) => {
  const { dir } = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/room-admin.js', import.meta.url)), output = path.join(dir, 'private-entry.txt');
  const { stdout, stderr } = await execute(process.execPath, [script, '--base-url', 'https://music.example.test/', '--data-dir', dir, '--output', output]);
  const url = new URL((await readFile(output, 'utf8')).trim()), token = new URLSearchParams(url.hash.slice(1)).get('admin');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(url.search, ''); assert.equal(url.pathname, '/rooms');
  assert.ok(!stdout.includes(token)); assert.ok(!stderr.includes(token));
  const access = await new RoomAccess({ dataDir: dir }).init(), identity = await access.ensure();
  await access.redeem(identity.actor.id, token); assert.equal(access.requireAdmin(identity.actor.id).siteAdmin, true);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});
