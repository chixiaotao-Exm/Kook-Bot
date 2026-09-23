import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RoomAccess } from '../src/room-access.js';

const execute = promisify(execFile);
const username = 'test.admin', password = 'test-secret-one', replacement = 'test-secret-two';
const status = (code) => (error) => error.statusCode === code;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-admin-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000000;
  const access = await new RoomAccess({ dataDir: dir, now: () => now, ...options }).init();
  const visitor = async (name = '听众') => {
    const result = await access.ensure();
    result.actor = await access.profile(result.actor.id, name); return result;
  };
  return { dir, access, visitor, advance: (milliseconds) => { now += milliseconds; } };
}

test('first password migration disables old link but preserves admin epochs, room grants and pending invitations', async (t) => {
  const { access, visitor, dir } = await fixture(t);
  const site = await visitor('旧站长'), owner = await visitor('房主'), dj = await visitor('DJ'), target = await visitor('新成员');
  const link = await access.rotateAdminLink(); await access.redeem(site.actor.id, link);
  await access.redeem(owner.actor.id, (await access.issueInvite(site.actor.id, 'room-one', 'owner')).token);
  await access.redeem(dj.actor.id, (await access.issueInvite(owner.actor.id, 'room-one', 'dj')).token);
  const pending = await access.issueInvite(site.actor.id, 'room-two', 'owner');
  const epoch = access.state.adminEpoch;
  assert.deepEqual(access.adminLoginStatus(), { enabled: false });
  assert.deepEqual(await access.setAdminLogin(username, password), { enabled: true, username });
  assert.equal(access.state.adminEpoch, epoch); assert.equal(access.state.adminLink, null);
  assert.equal(access.get(site.token).siteAdmin, true);
  assert.equal(access.role(owner.actor.id, 'room-one'), 'owner'); assert.equal(access.role(dj.actor.id, 'room-one'), 'dj');
  assert.equal(access.actor(target.actor.id).name, '新成员');
  await assert.rejects(access.redeem(target.actor.id, link), /邀请链接无效/);
  await assert.rejects(access.rotateAdminLink(), /不能重新生成/);
  assert.equal((await access.redeem(target.actor.id, pending.token)).role, 'owner');
  const restored = await new RoomAccess({ dataDir: dir, now: access.now }).init();
  assert.deepEqual(restored.adminLoginStatus(), { enabled: true, username });
  assert.equal(restored.get(site.token).siteAdmin, true); assert.equal(restored.role(owner.actor.id, 'room-one'), 'owner');
});

test('successful password login upgrades and rotates bearer atomically without changing public identity or nickname', async (t) => {
  const { access, visitor, dir } = await fixture(t), user = await visitor('我的原昵称');
  await access.setAdminLogin(username, password);
  assert.equal(access.state.adminEpoch, 1);
  const result = await access.loginAdmin(user.actor.id, username, password, 'client-one');
  assert.deepEqual(result.actor, { id: user.actor.id, name: '我的原昵称', siteAdmin: true });
  assert.notEqual(result.token, user.token); assert.equal(access.get(user.token), null);
  assert.equal(access.get(result.token).siteAdmin, true);
  const safe = JSON.stringify({ actor: result.actor, status: access.adminLoginStatus() });
  for (const secret of ['hash', 'salt', password, access.state.adminLogin.hash]) assert.ok(!safe.includes(secret));
  const raw = await readFile(access.file, 'utf8');
  for (const secret of [password, user.token, result.token]) assert.ok(!raw.includes(secret));
  assert.equal(access.state.adminLogin.algorithm, 'scrypt'); assert.match(access.state.adminLogin.hash, /^[a-f0-9]{128}$/);
  const restored = await new RoomAccess({ dataDir: dir, now: access.now }).init();
  assert.equal(restored.get(result.token).siteAdmin, true);
});

test('wrong username and password have identical unauthorized errors and never grant access', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor();
  await access.setAdminLogin(username, password);
  const errors = [];
  for (const [name, secret] of [[username, 'wrong-secret'], ['wrong-name', password], [username, null], [username, 'x'.repeat(201)]]) {
    try { await access.loginAdmin(user.actor.id, name, secret, 'login-errors'); assert.fail('Expected rejection'); }
    catch (error) { assert.equal(error.statusCode, 401); errors.push(error.message); }
    assert.equal(access.actor(user.actor.id).siteAdmin, false); assert.ok(access.get(user.token));
  }
  assert.equal(new Set(errors).size, 1);
  await assert.rejects(access.loginAdmin('not-an-actor', username, password, 'client'), status(403));
});

test('pair, client and account rate limits are bounded and expire without delaying guest operations', async (t) => {
  const { access, visitor, advance } = await fixture(t), user = await visitor();
  await access.setAdminLogin(username, password);
  access.deriveKey = async () => Buffer.alloc(64);
  for (let index = 0; index < 8; index++) await assert.rejects(access.loginAdmin(user.actor.id, username, 'wrong-secret', 'fixed-client'), status(401));
  await assert.rejects(access.loginAdmin(user.actor.id, username, password, 'fixed-client'), (error) => error.statusCode === 429 && error.retryAfterSeconds === 900);
  assert.equal((await access.profile(user.actor.id, '还能点歌')).name, '还能点歌');
  for (let index = 0; index < 20; index++) await assert.rejects(access.loginAdmin(user.actor.id, `user-${index}`, 'wrong-secret', 'rotating-names'), status(401));
  await assert.rejects(access.loginAdmin(user.actor.id, 'one-more-user', password, 'rotating-names'), status(429));
  // A distributed attempt against the same username is limited independently.
  for (let index = 0; index < 92; index++) await assert.rejects(access.loginAdmin(user.actor.id, username, 'wrong-secret', `client-${index}`), status(401));
  await assert.rejects(access.loginAdmin(user.actor.id, username, password, 'new-client'), status(429));
  advance(15 * 60 * 1000);
  await assert.rejects(access.loginAdmin(user.actor.id, username, 'wrong-secret', 'fixed-client'), status(401));
  assert.equal(access.loginBuckets.size, 3);
});

test('global KDF gate rejects excess parallel work across access instances and releases after failure', async (t) => {
  const first = await fixture(t), second = await fixture(t);
  await first.access.setAdminLogin(username, password); await second.access.setAdminLogin(username, password);
  const firstUser = await first.visitor(), secondUser = await second.visitor();
  const pending = [];
  first.access.deriveKey = second.access.deriveKey = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const a = first.access.loginAdmin(firstUser.actor.id, username, password, 'a');
  const b = second.access.loginAdmin(secondUser.actor.id, username, password, 'b');
  assert.equal(pending.length, 2);
  await assert.rejects(first.access.loginAdmin(firstUser.actor.id, username, password, 'c'), status(429));
  const aResult = assert.rejects(a, /test KDF error/); pending[0].reject(new Error('test KDF error')); await aResult;
  const c = first.access.loginAdmin(firstUser.actor.id, username, password, 'c'); assert.equal(pending.length, 3);
  pending[1].resolve(Buffer.from(second.access.state.adminLogin.hash, 'hex'));
  pending[2].resolve(Buffer.from(first.access.state.adminLogin.hash, 'hex'));
  assert.equal((await b).actor.siteAdmin, true); assert.equal((await c).actor.siteAdmin, true);
});

test('online password change checks old password, revokes other admins, rotates current token and preserves explicit room roles', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor('当前站长'), other = await visitor('另一设备'), owner = await visitor('房主');
  await access.setAdminLogin(username, password);
  const current = await access.loginAdmin(user.actor.id, username, password, 'one');
  const oldOther = await access.loginAdmin(other.actor.id, username, password, 'two');
  await access.redeem(owner.actor.id, (await access.issueInvite(user.actor.id, 'room', 'owner')).token);
  const fromOwner = await access.issueInvite(owner.actor.id, 'room', 'dj');
  const fromAdmin = await access.issueInvite(user.actor.id, 'another-room', 'owner');
  await assert.rejects(access.setAdminLogin(username, replacement, { actorId: owner.actor.id, currentPassword: password }), status(403));
  await assert.rejects(access.setAdminLogin(username, replacement, { actorId: user.actor.id, currentPassword: 'wrong-old-password' }), status(401));
  const epoch = access.state.adminEpoch;
  const changed = await access.setAdminLogin('new.admin', replacement, { actorId: user.actor.id, currentPassword: password });
  assert.equal(changed.username, 'new.admin'); assert.equal(changed.actor.siteAdmin, true); assert.equal(changed.actor.name, '当前站长');
  assert.equal(access.state.adminEpoch, epoch + 1); assert.equal(access.get(current.token), null);
  assert.equal(access.get(changed.token).id, user.actor.id); assert.equal(access.get(oldOther.token).siteAdmin, false);
  assert.equal(access.role(owner.actor.id, 'room'), 'owner');
  assert.ok(access.state.invites.some((invite) => invite.id === fromOwner.id)); assert.ok(!access.state.invites.some((invite) => invite.id === fromAdmin.id));
  await assert.rejects(access.loginAdmin(other.actor.id, username, password, 'old-credentials'), status(401));
  assert.equal((await access.loginAdmin(other.actor.id, 'new.admin', replacement, 'new-credentials')).actor.siteAdmin, true);
});

test('management logout and standalone token rotation retain nickname, identity id and explicit room role', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor('房主也是站长');
  const oldLink = await access.rotateAdminLink(); await access.redeem(user.actor.id, oldLink);
  await access.redeem(user.actor.id, (await access.issueInvite(user.actor.id, 'room', 'owner')).token);
  await access.setAdminLogin(username, password);
  const current = await access.loginAdmin(user.actor.id, username, password, 'one');
  const invite = await access.issueInvite(user.actor.id, 'room', 'dj');
  assert.deepEqual(await access.logoutAdmin(user.actor.id), { id: user.actor.id, name: '房主也是站长', siteAdmin: false });
  assert.equal(access.get(current.token).siteAdmin, false); assert.equal(access.role(user.actor.id, 'room'), 'owner');
  assert.ok(!access.state.invites.some((item) => item.id === invite.id));
  const rotated = await access.rotateIdentity(user.actor.id);
  assert.equal(rotated.actor.id, user.actor.id); assert.equal(access.get(current.token), null); assert.equal(access.role(rotated.actor.id, 'room'), 'owner');
});

test('failed persistence never partially upgrades an actor, changes password, or consumes its bearer', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor();
  await access.setAdminLogin(username, password);
  const writer = access.writeState, before = await readFile(access.file, 'utf8');
  access.writeState = async () => { throw new Error('full disk'); };
  await assert.rejects(access.loginAdmin(user.actor.id, username, password, 'disk-test'), /未生效/);
  assert.equal(access.get(user.token).siteAdmin, false); assert.equal(await readFile(access.file, 'utf8'), before);
  access.writeState = writer;
  const loggedIn = await access.loginAdmin(user.actor.id, username, password, 'disk-test');
  const epoch = access.state.adminEpoch; access.writeState = async () => { throw new Error('full disk'); };
  await assert.rejects(access.setAdminLogin(username, replacement, { actorId: user.actor.id, currentPassword: password }), /未生效/);
  assert.equal(access.state.adminEpoch, epoch); assert.equal(access.get(loggedIn.token).siteAdmin, true);
});

test('credentials changing during verification cannot authorize an old-password login', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor();
  await access.setAdminLogin(username, password);
  const oldHash = access.state.adminLogin.hash, original = access.deriveKey;
  let finish;
  access.deriveKey = () => new Promise((resolve) => { finish = resolve; });
  const login = access.loginAdmin(user.actor.id, username, password, 'racing-login');
  access.deriveKey = original; await access.setAdminLogin(username, replacement);
  finish(Buffer.from(oldHash, 'hex'));
  await assert.rejects(login, status(401)); assert.equal(access.get(user.token).siteAdmin, false);
});

test('concurrent successful logins for one browser cannot return two competing bearer rotations', async (t) => {
  const { access, visitor } = await fixture(t), user = await visitor();
  await access.setAdminLogin(username, password);
  const expected = Buffer.from(access.state.adminLogin.hash, 'hex'), pending = [];
  access.deriveKey = () => new Promise((resolve) => pending.push(resolve));
  const first = access.loginAdmin(user.actor.id, username, password, 'same-client');
  const second = access.loginAdmin(user.actor.id, username, password, 'same-client');
  pending[0](expected); const accepted = await first;
  pending[1](expected); await assert.rejects(second, status(403));
  assert.equal(access.get(accepted.token).siteAdmin, true); assert.equal(access.get(user.token), null);
});

test('malformed password state is rejected without overwriting original permissions', async (t) => {
  const { access, visitor, dir } = await fixture(t); await visitor(); await access.setAdminLogin(username, password);
  const valid = structuredClone(access.state);
  for (const broken of [
    { ...valid, adminLogin: { ...valid.adminLogin, algorithm: 'sha256' } },
    { ...valid, adminLogin: { ...valid.adminLogin, salt: 'bad' } },
    { ...valid, adminLogin: { ...valid.adminLogin, hash: 'bad' } },
    { ...valid, adminEpoch: 0 },
    { ...valid, adminLink: { hash: 'a'.repeat(64), createdAt: 1000000 } },
  ]) {
    const raw = JSON.stringify(broken); await writeFile(access.file, raw);
    await assert.rejects(new RoomAccess({ dataDir: dir }).init(), /原文件已保留/);
    await assert.rejects(access.reload(), /原文件已保留/);
    await assert.rejects(access.setAdminLogin(username, replacement), /原文件已保留/);
    assert.equal(await readFile(access.file, 'utf8'), raw);
  }
});

test('CLI reads password file, prints no secret, validates input, and refuses to restore link login', async (t) => {
  const { dir } = await fixture(t), passwordFile = path.join(dir, 'password.txt');
  const script = fileURLToPath(new URL('../scripts/admin-login.js', import.meta.url));
  const linkScript = fileURLToPath(new URL('../scripts/room-admin.js', import.meta.url));
  await writeFile(passwordFile, password + '\n', { mode: 0o600 });
  const args = [script, '--username', username, '--password-file', passwordFile, '--data-dir', dir];
  const result = await execute(process.execPath, args);
  assert.ok(result.stdout.includes(username)); assert.ok(!result.stdout.includes(password)); assert.ok(!result.stderr.includes(password));
  const access = await new RoomAccess({ dataDir: dir }).init(), guest = await access.ensure();
  assert.equal((await access.loginAdmin(guest.actor.id, username, password, 'cli')).actor.siteAdmin, true);
  await assert.rejects(execute(process.execPath, [linkScript, '--base-url', 'https://example.test', '--data-dir', dir, '--output', path.join(dir, 'old-link.txt')]), (error) => error.stderr.includes('不能重新生成'));
  const before = await readFile(access.file, 'utf8');
  await writeFile(passwordFile, 'short');
  await assert.rejects(execute(process.execPath, args), (error) => !error.stderr.includes('short') && error.stderr.includes('10–200'));
  assert.equal(await readFile(access.file, 'utf8'), before);
  for (const badName of ['ab', 'bad user', '<script>', 'a'.repeat(41)]) await assert.rejects(access.setAdminLogin(badName, password), /用户名/);
});
