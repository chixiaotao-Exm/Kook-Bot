import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './util.js';

export const IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const ranks = { guest: 0, member: 1, dj: 2, owner: 3 };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const validHash = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const validTime = (time) => Number.isSafeInteger(time) && time >= 0;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const blank = () => ({ version: 1, adminEpoch: 0, adminLink: null, identities: [], roles: [], invites: [] });
const forbidden = (message = '你没有执行此操作的权限。') => Object.assign(new UserError(message), { statusCode: 403 });
const invalidInvite = () => new UserError('邀请链接无效、已使用或已过期，请向管理员索取新链接。');
const invalidLogin = () => Object.assign(new UserError('用户名或密码不正确。'), { statusCode: 401 });
const busyLogin = (retryAfterSeconds = 1) => Object.assign(new UserError('登录尝试过于频繁，请稍后重试。'), { statusCode: 429, retryAfterSeconds });
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_BUCKETS = 5000;
const ADMIN_KDF_LIMIT = 2;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let activeAdminKdfs = 0;
const deriveAdminKey = (password, salt) => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
});
function adminUsername(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(value)) throw new UserError('管理员用户名需为 3–40 位英文字母、数字、下划线、点或短横线。');
  return value;
}
function adminPassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 200 || /[\r\n\0]/.test(value)) throw new UserError('管理员密码需为 10–200 个字符，不能包含换行或空字符。');
  return value;
}
function validAdminLogin(login) {
  return Boolean(login && login.algorithm === 'scrypt' && typeof login.salt === 'string' && /^[a-f0-9]{32}$/.test(login.salt) &&
    typeof login.hash === 'string' && /^[a-f0-9]{128}$/.test(login.hash) && validTime(login.updatedAt) && adminUsername(login.username) === login.username);
}

function botId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || ['constructor', 'prototype'].includes(value)) throw new UserError('机器人编号无效。');
  return value;
}
function nickname(value) {
  if (typeof value !== 'string') throw new UserError('请填写 1–32 个字符的昵称。');
  const name = value.normalize('NFKC').trim();
  if (!name || [...name].length > 32 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(name)) throw new UserError('昵称需为 1–32 个可见字符，不能包含控制字符或尖括号。');
  return name;
}

// Permissions are changed only after a complete, private replacement file has
// been flushed and atomically renamed. CLI rotation is performed while stopped.
async function writePrivateState(file, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new UserError('身份权限文件已达到容量上限。');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized);
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export class RoomAccess {
  constructor({ dataDir, now = Date.now, identityLimit = 5000, inviteLimit = 1000, writeState = writePrivateState, deriveKey = deriveAdminKey }) {
    Object.assign(this, { now, identityLimit, inviteLimit, writeState, deriveKey });
    this.file = path.join(dataDir, 'room-access.json');
    this.state = null; this.tail = Promise.resolve(); this.byId = new Map(); this.byHash = new Map(); this.persistDisabled = false;
    this.loginBuckets = new Map();
  }
  validate(state) {
    try {
      if (!state || state.version !== 1 || !Number.isSafeInteger(state.adminEpoch) || state.adminEpoch < 0 ||
          !Array.isArray(state.identities) || state.identities.length > 5000 || !Array.isArray(state.roles) || state.roles.length > 50000 ||
          !Array.isArray(state.invites) || state.invites.length > 1000) throw 0;
      if (state.adminLink !== null && (!validHash(state.adminLink?.hash) || !validTime(state.adminLink.createdAt) || !state.adminEpoch)) throw 0;
      if (state.adminLogin != null && (!validAdminLogin(state.adminLogin) || !state.adminEpoch || state.adminLink !== null)) throw 0;
      if (state.adminEpoch && !state.adminLink && !state.adminLogin) throw 0;
      const ids = new Set(), hashes = new Set(), grants = new Set(), inviteIds = new Set();
      for (const identity of state.identities) {
        if (!identity || !validId(identity.id) || ids.has(identity.id) || !validHash(identity.hash) || hashes.has(identity.hash) ||
            !validTime(identity.createdAt) || !validTime(identity.expiresAt) || identity.expiresAt <= identity.createdAt ||
            !Number.isSafeInteger(identity.adminEpoch) || identity.adminEpoch < 0 || identity.adminEpoch > state.adminEpoch ||
            identity.revoked !== undefined && typeof identity.revoked !== 'boolean' ||
            typeof identity.name !== 'string' || identity.name && nickname(identity.name) !== identity.name) throw 0;
        ids.add(identity.id); hashes.add(identity.hash);
      }
      for (const grant of state.roles) {
        botId(grant?.botId);
        const key = `${grant.botId}:${grant.actorId}`;
        if (!ids.has(grant.actorId) || !['dj', 'owner'].includes(grant.role) || grants.has(key)) throw 0;
        grants.add(key);
      }
      for (const invite of state.invites) {
        botId(invite?.botId);
        if (!validId(invite.id) || inviteIds.has(invite.id) || !validHash(invite.hash) || hashes.has(invite.hash) ||
            !ids.has(invite.issuedBy) || !['dj', 'owner'].includes(invite.role) || !validTime(invite.createdAt) ||
            !validTime(invite.expiresAt) || invite.expiresAt <= invite.createdAt || !Number.isSafeInteger(invite.issuerAdminEpoch) ||
            invite.issuerAdminEpoch < 0 || invite.issuerAdminEpoch > state.adminEpoch || invite.role === 'owner' && !invite.issuerAdminEpoch) throw 0;
        inviteIds.add(invite.id); hashes.add(invite.hash);
      }
      return state;
    } catch { throw new UserError('网页身份权限文件损坏，原文件已保留；请由服务器管理员检查 room-access.json。'); }
  }
  install(state) {
    this.state = state;
    this.byId = new Map(state.identities.map((identity) => [identity.id, identity]));
    this.byHash = new Map(state.identities.map((identity) => [identity.hash, identity]));
  }
  async read(allowMissing = false) {
    try {
      const raw = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error('Oversized');
      return this.validate(JSON.parse(raw));
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return blank();
      throw new UserError('网页身份权限文件无法读取或格式损坏，原文件已保留；请由服务器管理员检查 room-access.json。');
    }
  }
  async init() { if (!this.state) this.install(await this.read(true)); return this; }
  async reload() {
    return this.serial(async () => {
      try { this.install(await this.read(false)); this.persistDisabled = false; return this; }
      catch (error) { this.persistDisabled = true; throw error; }
    });
  }
  serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  ready() { if (!this.state) throw new UserError('网页身份服务尚未就绪。'); }
  async change(fn) {
    return this.serial(async () => {
      this.ready();
      if (this.persistDisabled) throw new UserError('权限文件读取失败，原文件已保留；修复并重新加载前暂不接受修改。');
      const next = structuredClone(this.state);
      const result = await fn(next);
      try { await this.writeState(this.file, next); }
      catch { throw new UserError('身份权限未能保存，本次修改未生效，请稍后重试。'); }
      this.install(next); return typeof result === 'function' ? result() : result;
    });
  }
  entry(id, state = this.state) { return state === this.state ? this.byId.get(id) : state?.identities.find((item) => item.id === id); }
  public(identity, state = this.state) {
    return { id: identity.id, name: identity.name, siteAdmin: state.adminEpoch > 0 && identity.adminEpoch === state.adminEpoch };
  }
  active(identity) { return Boolean(identity && !identity.revoked && identity.expiresAt > this.now()); }
  actor(id) {
    const identity = this.entry(id);
    return this.active(identity) ? this.public(identity) : null;
  }
  get(token) {
    if (!validToken(token)) return null;
    const identity = this.byHash.get(hashToken(token));
    return this.active(identity) ? this.public(identity) : null;
  }
  role(actorId, roomId, state = this.state) {
    botId(roomId);
    const identity = this.entry(actorId, state);
    if (!this.active(identity)) return 'guest';
    if (state.adminEpoch > 0 && identity.adminEpoch === state.adminEpoch) return 'owner';
    return state.roles.find((grant) => grant.botId === roomId && grant.actorId === actorId)?.role || (identity.name ? 'member' : 'guest');
  }
  require(actorId, roomId, minimumRole) {
    if (!Object.hasOwn(ranks, minimumRole)) throw new UserError('权限等级无效。');
    const actor = this.actor(actorId);
    if (!actor || ranks[this.role(actorId, roomId)] < ranks[minimumRole]) throw forbidden();
    return actor;
  }
  requireAdmin(actorId) {
    const actor = this.actor(actorId);
    if (!actor?.siteAdmin) throw forbidden('此操作仅限站点管理员。');
    return actor;
  }
  async ensure(token) {
    this.ready(); const existing = this.get(token);
    if (existing) return { actor: existing };
    return this.change((next) => {
      const now = this.now();
      const protectedIds = new Set([...next.roles.map((grant) => grant.actorId), ...next.invites.filter((item) => item.expiresAt > now).map((item) => item.issuedBy)]);
      next.identities = next.identities.filter((item) => item.expiresAt > now || protectedIds.has(item.id) || next.adminEpoch > 0 && item.adminEpoch === next.adminEpoch);
      next.invites = next.invites.filter((invite) => invite.expiresAt > now);
      if (next.identities.length >= this.identityLimit) {
        const discard = next.identities.filter((item) => !protectedIds.has(item.id) && !(next.adminEpoch > 0 && item.adminEpoch === next.adminEpoch))
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!discard) throw new UserError('访客身份数量已达到上限，请联系站点管理员。');
        next.identities = next.identities.filter((item) => item !== discard);
      }
      const raw = randomBytes(32).toString('base64url');
      const identity = { id: randomUUID(), hash: hashToken(raw), name: '', createdAt: now, expiresAt: now + IDENTITY_TTL_MS, adminEpoch: 0 };
      next.identities.push(identity);
      return () => ({ actor: this.public(identity), token: raw });
    });
  }
  async profile(actorId, name) {
    const checked = nickname(name);
    return this.change((next) => {
      const identity = this.entry(actorId, next);
      if (!this.active(identity)) throw forbidden('访客身份已失效，请刷新页面。');
      identity.name = checked; return () => this.public(identity);
    });
  }
  async logout(actorId) {
    return this.change((next) => {
      const identity = this.entry(actorId, next);
      if (!identity) throw forbidden('访客身份已失效，请刷新页面。');
      identity.revoked = true;
      next.invites = next.invites.filter((invite) => invite.issuedBy !== actorId);
      return { ok: true };
    });
  }
  adminLoginStatus() {
    this.ready();
    return this.state.adminLogin ? { enabled: true, username: this.state.adminLogin.username } : { enabled: false };
  }
  consumeLoginAttempt(username, rateKey) {
    const now = this.now();
    for (const [key, entry] of this.loginBuckets) if (entry.until <= now) this.loginBuckets.delete(key);
    // Hash caller-controlled fields to keep keys bounded. The web layer supplies
    // the network identity; a submitted form field must never be used as rateKey.
    const account = hashToken(typeof username === 'string' ? username.toLowerCase().slice(0, 200) : 'invalid');
    const client = hashToken(typeof rateKey === 'string' && rateKey ? rateKey.slice(0, 300) : 'unknown');
    const limits = [[`pair:${client}:${account}`, 8], [`client:${client}`, 20], [`account:${account}`, 100]];
    const missing = limits.filter(([key]) => !this.loginBuckets.has(key)).length;
    if (this.loginBuckets.size + missing > MAX_LOGIN_BUCKETS) throw busyLogin(60);
    for (const [key, maximum] of limits) {
      const bucket = this.loginBuckets.get(key);
      if (bucket && bucket.count >= maximum) throw busyLogin(Math.max(1, Math.ceil((bucket.until - now) / 1000)));
    }
    for (const [key] of limits) {
      const bucket = this.loginBuckets.get(key) || { count: 0, until: now + LOGIN_WINDOW_MS };
      bucket.count++; this.loginBuckets.set(key, bucket);
    }
  }
  async adminKey(password, salt) {
    if (activeAdminKdfs >= ADMIN_KDF_LIMIT) throw busyLogin();
    activeAdminKdfs++;
    try { return await this.deriveKey(password, Buffer.from(salt, 'hex')); }
    finally { activeAdminKdfs--; }
  }
  async verifyAdminPassword(login, password) {
    if (typeof password !== 'string' || password.length > 200 || /[\r\n\0]/.test(password)) return false;
    const actual = await this.adminKey(password, login.salt);
    return timingSafeEqual(actual, Buffer.from(login.hash, 'hex'));
  }
  rotateInState(identity) {
    const token = randomBytes(32).toString('base64url');
    identity.hash = hashToken(token); identity.expiresAt = this.now() + IDENTITY_TTL_MS;
    return token;
  }
  async rotateIdentity(actorId) {
    return this.change((next) => {
      const identity = this.entry(actorId, next);
      if (!this.active(identity)) throw forbidden('访客身份已失效，请刷新页面。');
      const token = this.rotateInState(identity);
      return () => ({ actor: this.public(identity), token });
    });
  }
  async loginAdmin(actorId, username, password, rateKey) {
    this.ready();
    if (!this.actor(actorId)) throw forbidden('访客身份已失效，请刷新页面。');
    const previousIdentity = this.entry(actorId), identityHash = previousIdentity.hash, identityEpoch = previousIdentity.adminEpoch;
    this.consumeLoginAttempt(username, rateKey);
    const login = this.state.adminLogin;
    if (!login) throw invalidLogin();
    const passwordCorrect = await this.verifyAdminPassword(login, password);
    const usernameCorrect = timingSafeEqual(Buffer.from(hashToken(typeof username === 'string' ? username : ''), 'hex'), Buffer.from(hashToken(login.username), 'hex'));
    if (!passwordCorrect || !usernameCorrect) throw invalidLogin();
    return this.change((next) => {
      if (!next.adminLogin || next.adminLogin.hash !== login.hash || next.adminLogin.username !== login.username) throw invalidLogin();
      const identity = this.entry(actorId, next);
      if (!this.active(identity)) throw forbidden('访客身份已失效，请刷新页面。');
      if (identity.hash !== identityHash || identity.adminEpoch !== identityEpoch) throw forbidden('当前身份已更新，请刷新后重新登录。');
      identity.adminEpoch = next.adminEpoch;
      if (!identity.name) identity.name = login.username;
      const token = this.rotateInState(identity);
      return () => ({ actor: this.public(identity), token });
    });
  }
  async setAdminLogin(username, password, { actorId, currentPassword } = {}) {
    this.ready(); username = adminUsername(username); password = adminPassword(password);
    const previous = this.state.adminLogin, epoch = this.state.adminEpoch;
    let identityHash;
    if (actorId !== undefined) {
      this.requireAdmin(actorId);
      identityHash = this.entry(actorId).hash;
      this.consumeLoginAttempt(previous?.username || username, `password-change:${actorId}`);
      if (!previous || !await this.verifyAdminPassword(previous, currentPassword)) throw invalidLogin();
    }
    const salt = randomBytes(16).toString('hex'), key = await this.adminKey(password, salt);
    return this.change((next) => {
      if (next.adminEpoch !== epoch || next.adminLogin?.hash !== previous?.hash) throw new UserError('管理员登录配置已更新，请刷新后重试。');
      if (actorId !== undefined) this.requireAdmin(actorId);
      if (actorId !== undefined && this.entry(actorId, next).hash !== identityHash) throw forbidden('当前身份已更新，请刷新后重试。');
      if (previous && next.adminEpoch >= Number.MAX_SAFE_INTEGER) throw new UserError('管理授权版本已达到上限。');
      // The first migration disables bearer links but preserves all existing
      // sessions and invitations. Later resets invalidate old admin epochs.
      if (previous) {
        next.adminEpoch++;
        next.invites = next.invites.filter((invite) => !invite.issuerAdminEpoch);
      } else if (!next.adminEpoch) next.adminEpoch = 1;
      next.adminLink = null;
      next.adminLogin = { username, algorithm: 'scrypt', salt, hash: key.toString('hex'), updatedAt: this.now() };
      if (actorId === undefined) return { enabled: true, username };
      const identity = this.entry(actorId, next);
      identity.adminEpoch = next.adminEpoch;
      const token = this.rotateInState(identity);
      return () => ({ enabled: true, username, actor: this.public(identity), token });
    });
  }
  async logoutAdmin(actorId) {
    return this.change((next) => {
      const identity = this.entry(actorId, next);
      if (!this.active(identity)) throw forbidden('访客身份已失效，请刷新页面。');
      identity.adminEpoch = 0;
      next.invites = next.invites.filter((invite) => invite.issuedBy !== actorId || !invite.issuerAdminEpoch);
      return () => this.public(identity);
    });
  }
  members(roomId) {
    botId(roomId); this.ready();
    return this.state.identities.flatMap((identity) => {
      const grant = this.state.roles.find((item) => item.botId === roomId && item.actorId === identity.id);
      const siteAdmin = this.active(identity) && this.public(identity).siteAdmin;
      if (!grant && !siteAdmin) return [];
      return [{ id: identity.id, name: identity.name, siteAdmin, role: siteAdmin ? 'owner' : grant.role, expired: !this.active(identity) }];
    });
  }
  canInvite(actorId, roomId, role) {
    this.require(actorId, roomId, 'owner');
    if (role === 'owner') this.requireAdmin(actorId);
  }
  async issueInvite(actorId, roomId, role = 'dj') {
    botId(roomId);
    if (!['dj', 'owner'].includes(role)) throw new UserError('只能邀请房间 DJ 或房间管理员。');
    return this.change((next) => {
      this.canInvite(actorId, roomId, role);
      const now = this.now(); next.invites = next.invites.filter((item) => item.expiresAt > now);
      if (next.invites.length >= this.inviteLimit) throw new UserError('有效邀请数量已达到上限，请先撤销不用的邀请。');
      const token = randomBytes(32).toString('base64url'), id = randomUUID(), expires = now + INVITE_TTL_MS;
      next.invites.push({ id, hash: hashToken(token), botId: roomId, role, issuedBy: actorId,
        issuerAdminEpoch: this.actor(actorId).siteAdmin ? next.adminEpoch : 0, createdAt: now, expiresAt: expires });
      return { id, token, expires, role, botId: roomId };
    });
  }
  invites(actorId, roomId) {
    this.require(actorId, roomId, 'owner');
    return this.state.invites.filter((item) => item.botId === roomId && item.expiresAt > this.now()).map((item) => ({
      id: item.id, botId: item.botId, role: item.role, expires: item.expiresAt, issuedBy: item.issuedBy,
    }));
  }
  async revokeInvite(actorId, roomId, tokenOrId) {
    botId(roomId);
    return this.change((next) => {
      this.require(actorId, roomId, 'owner');
      const hashed = validToken(tokenOrId) ? hashToken(tokenOrId) : null;
      const invite = next.invites.find((item) => item.id === tokenOrId || hashed && item.hash === hashed);
      if (!invite || invite.botId !== roomId) throw invalidInvite();
      this.canInvite(actorId, roomId, invite.role);
      next.invites = next.invites.filter((item) => item !== invite);
      return { ok: true };
    });
  }
  async redeem(actorId, token) {
    if (!validToken(token)) throw invalidInvite();
    return this.change((next) => {
      const identity = this.entry(actorId, next);
      if (!this.active(identity)) throw forbidden('访客身份已失效，请刷新页面。');
      const hash = hashToken(token);
      if (next.adminLink && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next.adminLink.hash, 'hex'))) {
        identity.adminEpoch = next.adminEpoch;
        return () => ({ botId: null, role: 'owner', siteAdmin: true, actor: this.public(identity) });
      }
      const invite = next.invites.find((item) => item.hash === hash && item.expiresAt > this.now());
      if (!invite) throw invalidInvite();
      if (invite.issuerAdminEpoch && invite.issuerAdminEpoch !== next.adminEpoch) throw invalidInvite();
      // Revoking or rotating the issuing administrator also invalidates their
      // outstanding invitations, even when the invite itself has not expired.
      try { this.canInvite(invite.issuedBy, invite.botId, invite.role); } catch { throw invalidInvite(); }
      const existing = next.roles.find((item) => item.actorId === actorId && item.botId === invite.botId);
      if (existing) { if (ranks[invite.role] > ranks[existing.role]) existing.role = invite.role; }
      else {
        if (next.roles.length >= 50000) throw new UserError('房间授权数量已达到上限，请联系站点管理员。');
        next.roles.push({ actorId, botId: invite.botId, role: invite.role });
      }
      next.invites = next.invites.filter((item) => item !== invite);
      return () => ({ botId: invite.botId, role: this.role(actorId, invite.botId), siteAdmin: Boolean(this.actor(actorId)?.siteAdmin), actor: this.actor(actorId) });
    });
  }
  async revoke(actorId, roomId, targetId) {
    botId(roomId);
    return this.change((next) => {
      this.require(actorId, roomId, 'owner');
      if (this.actor(targetId)?.siteAdmin) throw forbidden('站点管理授权需由管理员退出管理或修改管理员密码后撤销。');
      const grant = next.roles.find((item) => item.botId === roomId && item.actorId === targetId);
      if (!grant) throw new UserError('此访客没有该房间的专属授权。');
      if (grant.role === 'owner') this.requireAdmin(actorId);
      next.roles = next.roles.filter((item) => item !== grant);
      // Prevent an old owner from later regaining authority via issued links.
      next.invites = next.invites.filter((item) => !(item.botId === roomId && item.issuedBy === targetId));
      return () => ({ ok: true, role: this.role(targetId, roomId) });
    });
  }
  async rotateAdminLink() {
    return this.change((next) => {
      if (next.adminLogin) throw new UserError('管理员账号登录已启用，不能重新生成专属管理链接；请使用账号登录或重置密码。');
      if (next.adminEpoch >= Number.MAX_SAFE_INTEGER) throw new UserError('管理授权版本已达到上限。');
      const token = randomBytes(32).toString('base64url');
      next.adminEpoch++; next.adminLink = { hash: hashToken(token), createdAt: this.now() };
      next.invites = next.invites.filter((invite) => !invite.issuerAdminEpoch);
      return token;
    });
  }
}
