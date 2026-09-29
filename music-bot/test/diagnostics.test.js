import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Diagnostics } from '../src/diagnostics.js';
import { UserError } from '../src/util.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-health-')); let clock = 100000;
  const p = { current: null, status: 'idle', context: { voiceChannelId: 'v1' }, connected: true, stayConnected: true, volume: 60, queue: [], recoveryError: '' };
  const settings = { radio: { enabled: false, lastError: '' }, schedules: [] };
  const runtime = { config: { token: 'extra-private-secret' }, player: { snapshot: () => p, audio: { connected: true } }, features: { snapshot: () => settings, setReporter(fn) { this.report = fn; } } };
  const descriptor = { id: 'a', name: 'Bot', online: true, status: 'ready' };
  const manager = { list: () => [descriptor], get: () => runtime };
  const music = { account: async () => ({ loggedIn: true }) };
  const config = { dataDir: dir, token: 'main-private-secret', cookie: 'entire-private-cookie' };
  const health = new Diagnostics(config, manager, music, { now: () => clock }); await health.init();
  t.after(async () => { await health.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-health-')); await rm(dir, { recursive: true, force: true }); });
  return { health, p, settings, runtime, descriptor, manager, music, config, dir, advance: (n) => { clock += n; } };
}
test('health reports idle silence normally and records transitions, recovery and automation failures', async (t) => {
  const f = await fixture(t), h = f.health;
  assert.equal(h.snapshot().summary.issues, 0);
  f.descriptor.online = false; h.snapshot(); f.advance(16000);
  assert.equal(h.snapshot().summary.issues, 1); assert.equal(h.events[0].kind, 'gateway_offline');
  h.snapshot(); assert.equal(h.events.length, 1);
  f.descriptor.online = true; h.snapshot(); assert.equal(h.events[0].kind, 'recovered');
  f.settings.radio = { enabled: true, suspended: false, lastError: 'No songs' };
  assert.equal(h.snapshot().summary.issues, 1); assert.match(h.snapshot().bots[0].issue, /自动电台/);
  f.settings.radio.enabled = false;
  f.settings.schedules = [{ enabled: true, name: 'Evening', lastError: 'No permission' }];
  assert.match(h.snapshot().bots[0].issue, /Evening/);
  f.settings.schedules[0].enabled = false; assert.equal(h.snapshot().summary.issues, 0);
});
test('health distinguishes stopped audio input from idle residency and does not claim audibility', async (t) => {
  const f = await fixture(t);
  f.runtime.player.audio.source = { lastProgress: 1 };
  assert.equal(f.health.snapshot().summary.issues, 0);
  f.p.status = 'playing'; f.p.current = { source: 'qq', name: 'Song' };
  assert.match(f.health.snapshot().bots[0].issue, /12 秒/);
  f.runtime.player.audio.connected = false;
  assert.equal(f.health.snapshot().bots[0].transport, 'disconnected');
  assert.match(f.health.snapshot().limitations, /客户端/);
});
test('diagnostics bound and redact private messages before persistence and reload', async (t) => {
  const f = await fixture(t);
  f.health.record({ botId: 'a', level: 'error', kind: 'source_failed', message: 'main-private-secret extra-private-secret entire-private-cookie https://cdn.invalid/private?k=1 {"cookie":"never-show-me","token":"hidden-token"}' });
  await f.health.writeTail;
  const saved = await readFile(f.health.file, 'utf8');
  for (const secret of ['main-private-secret', 'extra-private-secret', 'entire-private-cookie', 'never-show-me', 'hidden-token', 'cdn.invalid']) assert.equal(saved.includes(secret), false);
  const reloaded = new Diagnostics(f.config, f.manager, f.music); await reloaded.init();
  assert.equal(reloaded.events.length, 1); await reloaded.close();
  for (let i = 0; i < 302; i++) f.health.record({ kind: 'sample', message: String(i) });
  await f.health.writeTail; assert.equal(f.health.events.length, 300);
});
test('account checks coalesce and stale pre-logout responses cannot restore a logged-in state', async (t) => {
  const f = await fixture(t); let release, entered, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.music.account = async (source) => { calls++; if (source === 'qq' && calls <= 2) { entered(); await gate; return { loggedIn: true }; } return { loggedIn: false }; };
  const first = f.health.refreshAccounts(), second = f.health.refreshAccounts(); await started;
  f.health.invalidateAccount('qq', false);
  assert.equal(f.health.snapshot().accounts.qq.status, 'logged_out');
  release(); await Promise.all([first, second]); await f.health.accountPending;
  assert.equal(f.health.snapshot().accounts.qq.status, 'logged_out'); assert.equal(calls, 4);
});
test('malformed health history is preserved while current monitoring remains available', async (t) => {
  const f = await fixture(t); await f.health.close();
  await writeFile(f.health.file, 'not valid json');
  const h = new Diagnostics(f.config, f.manager, f.music); await h.init();
  h.record({ kind: 'new_notice', message: 'Still usable' });
  assert.match(h.snapshot().storageError, /原文件已保留/); await h.close();
  assert.equal(await readFile(f.health.file, 'utf8'), 'not valid json');
});

test('cookie checks distinguish confirmed validity, expiry, missing login and unavailable sources without copying secrets', async (t) => {
  const f = await fixture(t);let values = {netease:{loggedIn:true,cookie:'private-cookie',token:'private-token'},qq:{loggedIn:false,expired:true}};
  f.music.account=async source=>values[source];await f.health.refreshAccounts();
  let accounts=f.health.snapshot().accounts;
  assert.equal(accounts.netease.cookieStatus,'valid');assert.equal(accounts.netease.status,'logged_in');assert.equal(accounts.netease.lastSuccessAt,100000);
  assert.equal(accounts.netease.nextCheckAt,400000);assert.equal(accounts.netease.checkIntervalMs,300000);
  assert.equal(accounts.qq.cookieStatus,'expired');assert.equal(accounts.qq.lastSuccessAt,null);
  assert.doesNotMatch(JSON.stringify(accounts),/private-cookie|private-token/);
  f.advance(300000);values={netease:{loggedIn:false},qq:{loggedIn:false,unavailable:true}};await f.health.refreshAccounts();
  accounts=f.health.snapshot().accounts;assert.equal(accounts.netease.cookieStatus,'missing');assert.equal(accounts.qq.cookieStatus,'unavailable');
});

test('network failures and malformed responses stay unknown while retaining the previous successful check', async (t) => {
  const f=await fixture(t);await f.health.refreshAccounts();const success=f.health.snapshot().accounts.netease.lastSuccessAt;
  f.advance(300000);f.music.account=async()=>{throw new UserError('cookie=private-cookie sk-secret-private https://upstream/private');};
  await f.health.refreshAccounts();let account=f.health.snapshot().accounts.netease;
  assert.equal(account.status,'error');assert.equal(account.cookieStatus,'unknown');assert.equal(account.loggedIn,false);assert.equal(account.lastSuccessAt,success);
  assert.doesNotMatch(JSON.stringify(f.health.snapshot()),/private-cookie|secret-private|upstream/);
  const events=f.health.events.length;f.advance(300000);await f.health.refreshAccounts();assert.equal(f.health.events.length,events);
  f.advance(300000);f.music.account=async()=>({loggedIn:true});await f.health.refreshAccounts();account=f.health.snapshot().accounts.netease;
  assert.equal(account.cookieStatus,'valid');assert.ok(account.lastSuccessAt>success);assert.ok(f.health.events.some(event=>event.kind==='account_recovered'));
  for(const result of [null,{}, {loggedIn:'yes'}, {loggedIn:true,status:'unknown'}]){
    f.advance(300000);f.music.account=async()=>result;await f.health.refreshAccounts();assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'unknown');
  }
});

test('one hung source has a bounded deadline and cannot accumulate duplicate provider calls or block healthy sources', async (t) => {
  const f=await fixture(t);f.health.accountTimeoutMs=15;let slowCalls=0,fastCalls=0,release;
  const slow=new Promise(resolve=>{release=resolve;});
  f.music.account=async source=>source==='netease'?(slowCalls++,slow):(fastCalls++,{loggedIn:true});
  const first=f.health.refreshAccounts(),second=f.health.refreshAccounts();await Promise.all([first,second]);
  let accounts=f.health.snapshot().accounts;assert.equal(accounts.netease.cookieStatus,'unknown');assert.match(accounts.netease.error,/超时/);
  assert.equal(accounts.qq.cookieStatus,'valid');assert.equal(slowCalls,1);assert.equal(fastCalls,1);
  f.advance(300000);await f.health.refreshAccounts();assert.equal(slowCalls,1);assert.equal(fastCalls,2);
  release({loggedIn:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'unknown');
  f.advance(300000);f.music.account=async()=>({loggedIn:true});await f.health.refreshAccounts();assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'valid');
});

test('account refreshes coalesce, rate-limit manual refresh and mark old success stale without calling providers from snapshots', async (t) => {
  const f=await fixture(t);let calls=0;f.music.account=async()=>{calls++;return {loggedIn:true};};
  await Promise.all([f.health.refreshAccounts(),f.health.refreshAccounts({force:true})]);assert.equal(calls,2);
  await f.health.refreshAccounts({force:true});assert.equal(calls,2);
  f.advance(59999);await f.health.refreshAccounts({force:true});assert.equal(calls,2);
  f.advance(1);await f.health.refreshAccounts({force:true});assert.equal(calls,4);
  f.advance(335001);const account=f.health.snapshot().accounts.netease;
  assert.equal(account.stale,true);assert.equal(account.cookieStatus,'unknown');assert.equal(account.loggedIn,false);assert.equal(account.lastSuccessAt,160000);
  assert.equal(f.health.snapshot().summary.issues,2);assert.equal(calls,4);
});

test('login invalidation never declares unverified cookies valid and a late old reply cannot overwrite new credentials', async (t) => {
  const f=await fixture(t);let release,entered;const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  let old=true;f.music.account=async source=>{if(source==='netease'&&old){entered();return gate;}return {loggedIn:true};};
  const pending=f.health.refreshAccounts();await started;
  f.health.invalidateAccount('netease',true);assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'checking');assert.equal(f.health.snapshot().accounts.netease.loggedIn,false);
  old=false;release({loggedIn:false,expired:true});await pending;await f.health.accountPending;
  assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'valid');assert.equal(f.health.events.some(event=>event.kind==='account_attention'&&event.message.includes('网易')),false);
});

test('close promptly cancels diagnostics checks and late provider completion cannot mutate account state', async (t) => {
  const f=await fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;});f.music.account=async()=>gate;
  const pending=f.health.refreshAccounts();await new Promise(resolve=>setImmediate(resolve));await f.health.close();await pending;
  const before=structuredClone(f.health.accounts);release({loggedIn:true});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.health.accounts,before);assert.equal(f.health.accountPending,null);
});

test('an old uncooperative request cannot undo an explicit logout or keep the other sources from rechecking', async (t) => {
  const f=await fixture(t);f.health.accountTimeoutMs=15;let release,old=true,fast=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.music.account=async source=>source==='netease'&&old?gate:(fast++,{loggedIn:false});
  const pending=f.health.refreshAccounts();await new Promise(resolve=>setImmediate(resolve));
  f.health.invalidateAccount('netease',false);await pending;await f.health.accountPending;
  assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'missing');assert.equal(fast,2);
  old=false;release({loggedIn:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.health.snapshot().accounts.netease.cookieStatus,'missing');
});
