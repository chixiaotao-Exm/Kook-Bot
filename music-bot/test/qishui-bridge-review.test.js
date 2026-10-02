import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQishuiServer } from '../qishui/server.js';

const ID = '7501674235158431760';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-qishui-review-'));
  const credentialsFile = path.join(dir, 'credentials.json'), cacheDir = path.join(dir, 'media');
  await writeFile(credentialsFile, JSON.stringify({ cookie: 'sessionid=private-fixture' }));
  const token = 'r'.repeat(48);
  const server = createQishuiServer({ token, publicUrl: 'https://bridge.example.test/qishui', credentialsFile, cacheDir,
    catalog: { close() {} }, playback: {}, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.closeBridge();
    assert.equal(path.dirname(dir), tmpdir()); assert.match(path.basename(dir), /^kook-qishui-review-/);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/qishui`;
  return { server, dir, cacheDir, base, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

test('an upstream account outage is not reported as an expired login', async (t) => {
  const f = await fixture(t, { fetchImpl: async () => new Response('temporary upstream failure', { status: 503 }) });
  const response = await fetch(`${f.base}/account`, { headers: f.headers });
  const body = await response.json();
  assert.notEqual(body.expired, true, 'Network/server errors must not instruct the user to re-login');
  assert.ok(response.status >= 500 || body.unavailable === true, 'Account outage must remain distinguishable from logged out');
});

test('account checks distinguish authentication rejection from rate limits and forbidden network responses', async (t) => {
  for (const [upstream, expired] of [
    [() => Response.json({ status_code: 429, message: 'rate limit' }), false],
    [() => Response.json({ status_code: 500, my_info: { id: ID } }), false],
    [() => new Response('blocked', { status: 403 }), false],
    [() => new Response('login required', { status: 401 }), true],
    [() => Response.json({ status_info: { code: 1001, message: '用户未登录' } }), true],
  ]) {
    const f = await fixture(t, { fetchImpl: async () => upstream() });
    const response = await fetch(`${f.base}/account`, { headers: f.headers }), data = await response.json();
    assert.equal(data.expired === true, expired);
    assert.equal(response.status, expired ? 200 : 502);
  }
});

test('account cache does not preserve old login state after a cookie is replaced', async (t) => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async (_url, options) => {
    calls++;
    return options.headers.Cookie === 'sessionid=private-fixture' ? Response.json({ my_info: { id: ID } })
      : new Response('login required', { status: 401 });
  } });
  const read = async () => (await fetch(`${f.base}/account`, { headers: f.headers })).json();
  assert.equal((await read()).loggedIn, true); assert.equal((await read()).loggedIn, true); assert.equal(calls, 1);
  await writeFile(path.join(f.dir, 'credentials.json'), JSON.stringify({ cookie: 'sessionid=replaced' }));
  assert.equal((await read()).expired, true); assert.equal(calls, 2);
  await writeFile(path.join(f.dir, 'credentials.json'), JSON.stringify({ cookie: '' }));
  assert.equal((await read()).loggedIn, false); assert.equal(calls, 2);
});

test('closing the bridge cannot publish or orphan a media file prepared concurrently', async (t) => {
  const started = deferred(), completed = deferred();
  const f = await fixture(t, { playback: { async prepare() { started.resolve(); return completed.promise; } } });
  const { mkdir } = await import('node:fs/promises'); await mkdir(f.cacheDir, { recursive: true });
  const file = path.join(f.cacheDir, `${'c'.repeat(48)}.mp3`);
  await writeFile(file, Buffer.alloc(16));
  const request = fetch(`${f.base}/stream`, { method: 'POST', headers: f.headers, body: JSON.stringify({ id: ID }) }).catch(() => null);
  await started.promise;
  const closing = f.server.closeBridge(); await tick();
  completed.resolve({ file, durationMs: 180000, fullTrack: true, encrypted: false });
  await closing; await request; await tick(); await tick();
  assert.deepEqual(await readdir(f.cacheDir), [], 'Shutdown must drain/reject pending preparations and remove their output');
});

test('account data never reflects private cookies or upstream diagnostics', async (t) => {
  const f = await fixture(t, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=private-fixture');
    assert.equal(options.redirect, 'error');
    return Response.json({ status_code: 0, my_info: { id: '7501674235158431760', nickname: 'Test account' }, cookie: 'never-return', diagnostics: 'private-data' });
  } });
  const response = await fetch(`${f.base}/account`, { headers: f.headers });
  const body = await response.json();
  assert.equal(body.loggedIn, true); assert.equal(body.id, ID);
  assert.doesNotMatch(JSON.stringify(body), /private|never-return|sessionid/);
});

test('hot endpoint uses the saved library and does not bypass an exhausted or blocked library', async (t) => {
  let tracks=[{id:ID,name:'Saved song'}],total=1;
  const f=await fixture(t,{library:{hot:()=>({mode:'hot',name:'抖音热歌库',tracks}),snapshot:page=>({enabled:true,counts:{total},lastSuccessAt:1,tracks,...page}),close:async()=>{}},
    catalog:{hot:()=>assert.fail('must not reintroduce blocked songs from live catalog'),close(){}}});
  const get=async route=>(await fetch(f.base+route,{headers:f.headers})).json();
  assert.equal((await get('/hot?limit=10')).tracks[0].id,ID);
  tracks=[];assert.deepEqual((await get('/hot?limit=10')).tracks,[]);
  const library=await get('/library?offset=0&limit=20');assert.equal(library.enabled,true);assert.equal(library.limit,20);
  assert.equal((await fetch(f.base+'/library')).status,401);
});

test('playback feedback only marks explicit unavailable tracks and never login or network failures', async (t) => {
  const calls=[];let code='not_full_track';
  const f=await fixture(t,{library:{recordPlayback:async(id,result)=>calls.push([id,result]),close:async()=>{}},playback:{prepare:async()=>{throw Object.assign(Error('private'),{code})}}});
  for(const value of ['not_full_track','media_unavailable','login_required','upstream_unavailable','signer_unavailable','media_key_invalid']){
    code=value;await fetch(f.base+'/stream',{method:'POST',headers:f.headers,body:JSON.stringify({id:ID})});
  }
  assert.deepEqual(calls,[[ID,'unavailable'],[ID,'unavailable']]);
});
