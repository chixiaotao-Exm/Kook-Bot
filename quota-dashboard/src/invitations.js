import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';
import { normalizeInvitation } from './invitation-snapshot.js';

const PROGRAMS = new Set(['codex_referral_consumer', 'codex_referral_workspace']);
const ID = /^[1-9]\d{0,15}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const DAY = 86400000, MAX_RECORDS = 2000, MAX_BYTES = 256 * 1024;
const MESSAGES = {
  UNAVAILABLE: '此账号暂不支持邀请。', INVALID_EMAIL: '请输入有效的邮箱地址。',
  REJECTED: '上游未接受邀请，请核对邮箱和邀请规则。', ALREADY_EXISTS: '此邮箱已有邀请，请先核对收件箱。',
  RATE_LIMITED: '邀请操作较频繁，请稍后再试。', SEND_UNKNOWN: '邀请结果尚未确认，请先核对收件箱，不要重复发送。',
  PROGRAM_CHANGED: '邀请活动已变化，请刷新后重新确认。', CONFIRMATION_REQUIRED: '请先确认当前邀请规则。',
};
export class InvitationError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'InvitationError'; this.code = code; this.status = status; }
}
const fault = (code, status = 400) => new InvitationError(code, MESSAGES[code] || '邀请功能暂不可用，请稍后重试。', status);
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

/** Only fixed Sub2API referral endpoints; credentials and recipient addresses never enter public snapshots. */
export class InvitationClient {
  #base; #key; #fetch; #getAccount; #onUpdated; #now; #write; #file; #localTimeout; #ready = false; #closed = false;
  #records = new Map(); #running = new Map(); #busy = new Set(); #recent = []; #writes = Promise.resolve();
  constructor({ baseUrl, adminApiKey, getAccount, onUpdated, dataDir, fetchImpl = fetch, now = Date.now,
    writeState = atomicJson, refreshTimeoutMs = 20000, sendTimeoutMs = 90000, localTimeoutMs = 1000 } = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || typeof adminApiKey !== 'string' || !adminApiKey.trim() || /[\r\n]/.test(adminApiKey)
      || typeof getAccount !== 'function' || typeof dataDir !== 'string' || !dataDir
      || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof writeState !== 'function'
      || !Number.isInteger(refreshTimeoutMs) || refreshTimeoutMs < 1 || refreshTimeoutMs > 30000
      || !Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 90000
      || !Number.isInteger(localTimeoutMs) || localTimeoutMs < 1 || localTimeoutMs > 1000) throw new Error('Invalid invitation configuration');
    this.#base = base.origin; this.#key = adminApiKey.trim(); this.#fetch = fetchImpl;
    this.#getAccount = getAccount; this.#onUpdated = onUpdated; this.#now = now; this.#write = writeState;
    this.#file = path.join(dataDir, 'invitation-requests.json'); this.#localTimeout = localTimeoutMs;
    this.refreshTimeoutMs = refreshTimeoutMs; this.sendTimeoutMs = sendTimeoutMs;
  }
  async init() {
    try {
      if ((await stat(this.#file)).size > 1024 * 1024) throw new Error('oversized');
      const state = JSON.parse(await readFile(this.#file, 'utf8'));
      if (state?.version !== 1 || !Array.isArray(state.records) || state.records.length > MAX_RECORDS) throw new Error('invalid');
      for (const record of state.records) {
        if (!object(record) || !UUID.test(record.id) || !ID.test(record.accountId) || !/^[a-f\d]{64}$/.test(record.hash)
          || !/^[a-f\d]{64}$/.test(record.recipientHash) || !Number.isFinite(record.at)
          || !['pending', 'sent', 'unknown', 'failed'].includes(record.state) || record.code && !Object.hasOwn(MESSAGES, record.code)
          || this.#records.has(record.id)) throw new Error('invalid');
        if (record.at > this.#now() - DAY) this.#records.set(record.id, { id: record.id, accountId: record.accountId,
          hash: record.hash, recipientHash: record.recipientHash, at: record.at, state: record.state, ...(record.code ? { code: record.code } : {}) });
      }
      this.#ready = true;
    } catch (error) { this.#ready = error.code === 'ENOENT'; }
    return this;
  }
  #account(id) {
    if (this.#closed) throw fault('UNAVAILABLE', 503);
    if (typeof id !== 'string' || !ID.test(id)) throw new InvitationError('INVALID_ACCOUNT', '账号不存在。', 404);
    const account = this.#getAccount(id);
    if (!account || !account.invitation?.supported) throw fault('UNAVAILABLE', 404);
    return account;
  }
  async #authorize(authorize) { if (authorize && await authorize() === false) throw new InvitationError('FORBIDDEN', '当前会话不能发送邀请。', 403); }
  #rate(id, send) {
    const now = this.#now(); this.#recent = this.#recent.filter(item => item.at > now - 60000);
    if (this.#recent.length >= 60 || this.#recent.filter(item => item.id === id).length >= 12
      || send && this.#recent.filter(item => item.send).length >= 10) {
      throw Object.assign(fault('RATE_LIMITED', 429), { retryAfterSeconds: 60 });
    }
    this.#recent.push({ id, send, at: now });
  }
  async #localWait(operation) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local invitation state timeout')), this.#localTimeout);
    })]); } finally { clearTimeout(timer); }
  }
  #persist() {
    const write = this.#writes.then(() => this.#write(this.#file, { version: 1,
      records: [...this.#records.values()].map(record => ({ ...record })) }));
    // Keep the actual writes serialized after a timeout. A late atomic rename
    // must never overtake a newer journal snapshot.
    this.#writes = write.catch(() => {}); return this.#localWait(write);
  }
  async #request(id, operation, body) {
    const sending = operation === 'invite', controller = new AbortController();
    let timer;
    const interrupted = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 504));
    }, sending ? this.sendTimeoutMs : this.refreshTimeoutMs); });
    const request = async () => {
      const response = await this.#fetch(new URL(`/api/v1/admin/openai/accounts/${id}/referrals/${operation}`, this.#base), {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'x-api-key': this.#key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (controller.signal.aborted) { cancelBody(response?.body); throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 504); }
      if (response.redirected || response.status >= 300 && response.status < 400) { cancelBody(response.body); throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502); }
      if (response.status === 429) { cancelBody(response.body); throw Object.assign(fault('RATE_LIMITED', 429), { retryAfterSeconds: 60 }); }
      if (sending && response.status >= 500) { cancelBody(response.body); throw fault('SEND_UNKNOWN', 502); }
      if (Number(response.headers?.get('content-length')) > MAX_BYTES) { cancelBody(response.body); throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502); }
      const reader = response.body?.getReader();
      if (!reader) throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502);
      const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
      controller.signal.addEventListener('abort', cancel, { once: true });
      let raw;
      try {
        const chunks = []; let size = 0;
        for (;;) {
          if (controller.signal.aborted) throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 504);
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > MAX_BYTES) throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502);
          chunks.push(Buffer.from(value));
        }
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } finally { controller.signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
      if (!response.ok || raw?.code !== 0) {
        const reason = [raw?.reason, raw?.code, raw?.error?.code, raw?.data?.reason].find(value => typeof value === 'string' && value.startsWith('OPENAI_REFERRAL_'));
        const code = reason?.slice('OPENAI_REFERRAL_'.length);
        if (code && Object.hasOwn(MESSAGES, code)) throw fault(code, code === 'RATE_LIMITED' ? 429 : code === 'SEND_UNKNOWN' ? 502 : 400);
        if (response.status === 429) throw fault('RATE_LIMITED', 429);
        throw fault(sending && (response.status >= 500 || response.ok) ? 'SEND_UNKNOWN' : sending ? 'REJECTED' : 'UNAVAILABLE', 502);
      }
      if (!object(raw.data)) throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502);
      return raw.data;
    };
    try { return await Promise.race([request(), interrupted]); }
    catch (error) { if (error instanceof InvitationError) throw error; throw fault(sending ? 'SEND_UNKNOWN' : 'UNAVAILABLE', 502); }
    finally { clearTimeout(timer); }
  }
  async #update(id, data) {
    const invitation = normalizeInvitation({ platform: 'openai', type: 'oauth', extra: { codex_referral_snapshot: data.eligibility } }, { now: this.#now() });
    let cachePersisted = data.cache_persisted === true;
    try { await this.#localWait(this.#onUpdated?.(id, invitation)); } catch { cachePersisted = false; }
    return { invitation, cachePersisted };
  }
  async refresh(id, { authorize } = {}) {
    this.#account(id); await this.#authorize(authorize);
    if (this.#busy.has(id)) throw new InvitationError('BUSY', '此账号正在处理邀请，请稍后刷新。', 409);
    this.#rate(id, false); this.#busy.add(id);
    try { await this.#authorize(authorize); return await this.#update(id, await this.#request(id, 'refresh', {})); }
    finally { this.#busy.delete(id); }
  }
  #replay(record) {
    if (record.state === 'sent') return { sent: true, duplicate: true, invitation: this.#getAccount(record.accountId)?.invitation || null,
      refreshFailed: true, cachePersisted: true };
    throw fault(record.state === 'failed' ? record.code || 'REJECTED' : 'SEND_UNKNOWN', record.state === 'failed' ? 400 : 409);
  }
  async invite(id, input, { authorize } = {}) {
    this.#account(id); await this.#authorize(authorize);
    if (!this.#ready) throw new InvitationError('STORAGE', '邀请记录暂不可用，已暂停发送。', 503);
    if (!object(input) || Object.keys(input).length !== 4 || !['email','programId','confirmed','requestId'].every(key => Object.hasOwn(input,key))
      || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !PROGRAMS.has(input.programId) || typeof input.confirmed !== 'boolean') {
      throw new InvitationError('INVALID_REQUEST', '邀请请求无效，请刷新后重试。', 400);
    }
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (email.length > 254 || !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(email)) throw fault('INVALID_EMAIL');
    const requestId = input.requestId.toLowerCase();
    const recipientHash = digest(`${id}\n${email.toLowerCase()}\n${input.programId}`);
    const hash = digest(`${recipientHash}\n${input.confirmed}`);
    const running = this.#running.get(requestId);
    if (running) { if (running.hash !== hash) throw new InvitationError('REQUEST_CONFLICT', '请勿修改正在提交的邀请。', 409); return running.promise; }
    const previous = this.#records.get(requestId);
    if (previous) { if (previous.hash !== hash) throw new InvitationError('REQUEST_CONFLICT', '邀请编号已使用，请重新提交。', 409); return this.#replay(previous); }
    for (const [key, record] of this.#records) if (record.at <= this.#now() - DAY) this.#records.delete(key);
    const duplicate = [...this.#records.values()].find(record => record.recipientHash === recipientHash && record.state !== 'failed');
    if (duplicate) throw fault(duplicate.state === 'sent' ? 'ALREADY_EXISTS' : 'SEND_UNKNOWN', 409);
    if (this.#records.size >= MAX_RECORDS) throw fault('RATE_LIMITED', 429);
    if (this.#busy.has(id)) throw new InvitationError('BUSY', '此账号正在处理邀请，请稍后重试。', 409);
    this.#rate(id, true); this.#busy.add(id);
    const promise = this.#send(id, { ...input, email, requestId }, { hash, recipientHash, authorize })
      .finally(() => { this.#busy.delete(id); this.#running.delete(requestId); });
    this.#running.set(requestId, { hash, promise }); return promise;
  }
  async #send(id, input, { hash, recipientHash, authorize }) {
    await this.#authorize(authorize);
    const refreshed = await this.#update(id, await this.#request(id, 'refresh', {}));
    const invitation = refreshed.invitation;
    if (invitation.programId !== input.programId) throw fault('PROGRAM_CHANGED', 409);
    if (!invitation.shouldShow || invitation.availableCount === null || invitation.availableCount <= 0) throw fault('UNAVAILABLE', 409);
    if (invitation.requiresConfirmation && !input.confirmed) throw fault('CONFIRMATION_REQUIRED');
    this.#account(id); await this.#authorize(authorize);
    const record = { id: input.requestId, accountId: id, hash, recipientHash, at: this.#now(), state: 'pending' };
    this.#records.set(record.id, record);
    try { await this.#persist(); }
    catch { this.#ready = false; throw new InvitationError('STORAGE', '邀请记录未能保存，本次没有发送。', 503); }
    try { await this.#authorize(authorize); }
    catch (error) { this.#records.delete(record.id); try { await this.#persist(); } catch { this.#ready = false; } throw error; }
    let data;
    try {
      data = await this.#request(id, 'invite', { email: input.email, program_id: input.programId, confirmed: input.confirmed });
      if (data.sent !== true) throw fault('SEND_UNKNOWN', 502);
    } catch (error) {
      record.code = Object.hasOwn(MESSAGES, error.code) ? error.code : 'SEND_UNKNOWN';
      record.state = record.code === 'SEND_UNKNOWN' ? 'unknown' : 'failed';
      try { await this.#persist(); } catch { this.#ready = false; }
      throw error;
    }
    record.state = 'sent';
    let persisted = true;
    try { await this.#persist(); } catch { persisted = false; this.#ready = false; }
    const result = await this.#update(id, data);
    return { sent: true, ...result, cachePersisted: result.cachePersisted && persisted,
      refreshFailed: data.refresh_failed === true || !object(data.eligibility) };
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#running.values()].map(item => item.promise));
    await this.#localWait(this.#writes).catch(() => {});
  }
}
