import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { QQMusic, qqId, validateQQMediaUrl } from '../src/qq-music.js';
import { MusicSources } from '../src/music-sources.js';
import { UserError, UnavailableError } from '../src/util.js';

const config = { dataDir: 'data/test-qq', qqPython: '/usr/bin/python3' };

test('QQ identifiers distinguish song MID, playlist and charts without accepting foreign links', () => {
  assert.equal(qqId('0039MnYb0qxYhV'), '0039MnYb0qxYhV');
  assert.equal(qqId('12345'), '12345');
  assert.equal(qqId('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV'), '0039MnYb0qxYhV');
  assert.equal(qqId('https://i.y.qq.com/v8/playsong.html?songid=12345'), '12345');
  assert.equal(qqId('https://y.qq.com/n/ryqq/playlist/12345', 'playlist'), '12345');
  assert.equal(qqId('https://y.qq.com/n/ryqq/toplist/26', 'playlist'), 'top:26');
  assert.equal(qqId('top:26', 'playlist'), 'top:26');
  for (const value of ['https://evil.test/songDetail/0039MnYb0qxYhV', 'file:///song/123', 'https://user:pass@y.qq.com/song/123', '123; echo hi', '0']) assert.equal(qqId(value), null);
  assert.equal(qqId('https://y.qq.com/n/ryqq/playlist/12345'), null);
});

test('QQ stream URLs accept only regular authorized MP3 on QQ music stream CDN', () => {
  const url = 'https://isure.stream.qqmusic.qq.com/M5000039MnYb0qxYhV.mp3?vkey=secret';
  assert.equal(validateQQMediaUrl(url), url);
  for (const value of ['file:///etc/passwd', 'http://127.0.0.1/M500123.mp3', 'https://stream.qqmusic.qq.com.evil.test/M500123.mp3',
    'https://evil.qq.com/M500123.mp3', 'https://x:y@isure.stream.qqmusic.qq.com/M500123.mp3',
    'https://isure.stream.qqmusic.qq.com:8080/M500123.mp3', 'https://isure.stream.qqmusic.qq.com/RS02123.mp3',
    'https://isure.stream.qqmusic.qq.com/F0M0123.mflac']) assert.throws(() => validateQQMediaUrl(value), UnavailableError);
});

test('QQ adapter routes bounded requests and search fallback through its isolated bridge', async () => {
  const calls = []; const track = { id: '123', source: 'qq', name: 'Song', artists: 'Artist' };
  const music = new QQMusic(config, { bridge: async (method, params) => {
    calls.push({ method, params }); return method === 'search' ? [track] : track;
  } });
  assert.equal(await music.resolve('搜索歌曲'), track);
  await music.resolve('0039MnYb0qxYhV'); await music.playlist('top:26', 500);
  await music.playlistDetails('123', { offset: 150, limit: 50 }); await music.discover('mine');
  assert.deepEqual(calls, [
    { method: 'search', params: { keywords: '搜索歌曲', limit: 1 } },
    { method: 'resolve', params: { id: '0039MnYb0qxYhV' } },
    { method: 'playlist', params: { id: 'top:26', limit: 500 } },
    { method: 'playlistDetails', params: { id: '123', offset: 150, limit: 50 } },
    { method: 'discover', params: { category: 'mine' } },
  ]);
  assert.throws(() => music.search(''), UserError); assert.throws(() => music.search('song', 101), UserError);
  assert.throws(() => music.playlist('123', 501), UserError); assert.throws(() => music.playlistDetails('123', { offset: -1 }), UserError);
  assert.throws(() => music.discover('arbitrary'), UserError); assert.throws(() => music.qrCreate('mobile'), UserError);
  await assert.rejects(music.resolve('https://evil.test/song/123'), UserError);
});

test('empty, trial or encrypted QQ media never becomes a playable stream', async () => {
  let reply = { url: 'https://isure.stream.qqmusic.qq.com/M500abc.mp3', full: true, preview: false };
  const music = new QQMusic(config, { bridge: async () => reply });
  assert.equal(await music.stream({ id: '123' }), reply.url);
  for (const candidate of [{}, { ...reply, full: false }, { ...reply, preview: true },
    { ...reply, url: 'https://isure.stream.qqmusic.qq.com/RS02abc.mp3' }]) {
    reply = candidate; await assert.rejects(music.stream({ id: '123' }), UnavailableError);
  }
});

function processFixture(t, options = {}) {
  const children = []; const launches = [];
  const music = new QQMusic(config, { ...options, spawnImpl(executable, args, settings) {
    launches.push({ executable, args, settings });
    const child = new EventEmitter(); child.lines = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { child.lines.push(JSON.parse(chunk.toString())); callback(); } });
    child.kill = (signal) => { child.signal = signal; return true; };
    children.push(child); return child;
  } });
  t.after(() => music.close());
  return { music, children, launches };
}

test('persistent QQ bridge matches response IDs and preserves split UTF-8 text', async (t) => {
  const { music, children, launches } = processFixture(t);
  const first = music.search('你好'); const second = music.account();
  const child = children[0]; assert.equal(children.length, 1);
  assert.equal(launches[0].settings.shell, false); assert.equal(launches[0].executable, config.qqPython);
  assert.ok(launches[0].args.includes('--data-dir'));
  child.stdout.write(JSON.stringify({ id: child.lines[1].id, ok: true, result: { loggedIn: false } }) + '\n');
  const bytes = Buffer.from(JSON.stringify({ id: child.lines[0].id, ok: true, result: [{ name: '你好' }] }) + '\n');
  const index = bytes.indexOf(Buffer.from('你好')) + 1;
  child.stdout.write(bytes.subarray(0, index)); child.stdout.write(bytes.subarray(index));
  assert.deepEqual(await first, [{ name: '你好' }]); assert.deepEqual(await second, { loggedIn: false });
  assert.equal(music.pending.size, 0);
});

test('QQ QR calls pass only login type and safe status; errors never expose upstream text', async (t) => {
  const { music, children } = processFixture(t);
  const qr = music.qrCreate('wx'); const child = children[0];
  assert.deepEqual(child.lines[0].params, { type: 'wx' });
  child.stdout.write(JSON.stringify({ id: child.lines[0].id, ok: true, result: { image: 'data:image/png;base64,eA==', expires: 123, status: 'waiting' } }) + '\n');
  assert.equal((await qr).status, 'waiting');
  const status = music.qrStatus();
  child.stdout.write(JSON.stringify({ id: child.lines[1].id, ok: true, result: { status: 'scanned' } }) + '\n');
  assert.deepEqual(await status, { status: 'scanned' });
  const failed = music.account();
  child.stdout.write(JSON.stringify({ id: child.lines[2].id, ok: false, error: 'private-token-and-url' }) + '\n');
  await assert.rejects(failed, (error) => error instanceof UserError && !error.message.includes('private'));
});

test('one QQ timeout cancels only its request and the same helper continues serving others', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, children } = processFixture(t, { timeoutMs: 50 });
  const one = assert.rejects(music.account(), /超时/), child = children[0];
  t.mock.timers.tick(25);
  const two = music.qrStatus(), secondId = child.lines.at(-1).id;
  t.mock.timers.tick(25);
  await one;
  assert.equal(child.signal, undefined); assert.equal(music.pending.size, 1);
  assert.deepEqual(child.lines.at(-1), { id: child.lines[0].id, method: 'cancel', params: {} });
  child.stdout.write(JSON.stringify({ id: secondId, ok: true, result: { status: 'waiting' } }) + '\n');
  assert.deepEqual(await two, { status: 'waiting' });
  const next = music.account(); assert.equal(children.length, 1);
  child.stdout.write(JSON.stringify({ id: child.lines.at(-1).id, ok: true, result: { loggedIn: false } }) + '\n');
  assert.deepEqual(await next, { loggedIn: false });
});

test('eight slow QQ requests wait for dispatch before their individual timeout starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, children } = processFixture(t, { timeoutMs: 80, queueTimeoutMs: 500 });
  const jobs = Array.from({ length: 8 }, () => music.account()); const child = children[0];
  assert.equal(child.lines.length, 4); assert.equal(music.pending.size, 4); assert.equal(music.waiting.length, 4);
  t.mock.timers.tick(50);
  for (const entry of child.lines.slice(0, 4)) child.stdout.write(JSON.stringify({ id: entry.id, ok: true, result: entry.id }) + '\n');
  assert.equal(child.lines.length, 8); assert.equal(music.pending.size, 4);
  t.mock.timers.tick(50);
  for (const entry of child.lines.slice(4)) child.stdout.write(JSON.stringify({ id: entry.id, ok: true, result: entry.id }) + '\n');
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(child.signal, undefined); assert.equal(music.waiting.length, 0);
});

test('QQ queued cancellation and bounded waiting never cancel running requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, children } = processFixture(t, { timeoutMs: 500, queueTimeoutMs: 25 });
  const active = Array.from({ length: 4 }, () => music.account()), child = children[0];
  const abort = new AbortController();
  const canceled = assert.rejects(music.call('search', {}, { signal: abort.signal }), /取消/);
  abort.abort(); await canceled;
  const queued = assert.rejects(music.qrStatus(), /排队超时/); t.mock.timers.tick(25); await queued;
  assert.equal(child.lines.length, 4); assert.equal(music.pending.size, 4); assert.equal(music.waiting.length, 0);
  for (const entry of child.lines) child.stdout.write(JSON.stringify({ id: entry.id, ok: true, result: null }) + '\n');
  await Promise.all(active);
});

test('QQ bridge close drains active and queued requests and cannot call injected bridge after closing', async (t) => {
  const { music, children } = processFixture(t);
  const active = Array.from({ length: 16 }, () => assert.rejects(music.account(), /关闭/));
  await assert.rejects(music.account(), /较多/);
  assert.equal(children[0].lines.length, 4); music.close(); await Promise.all(active);
  assert.equal(music.pending.size, 0); assert.equal(music.waiting.length, 0);
  const isolated = new QQMusic(config, { bridge: () => { throw new Error('must not run'); } });
  isolated.close(); await assert.rejects(isolated.account(), /关闭/);
});

test('QQ lyrics use track MID when available and reject malformed identifiers', async () => {
  const calls = []; const music = new QQMusic(config, { bridge: async (method, params) => { calls.push([method, params]); return { lyric: '[00:01]hello' }; } });
  await music.lyrics({ id: '123', mid: '0039MnYb0qxYhV' }); await music.lyrics('456');
  assert.deepEqual(calls, [['lyrics', { id: '0039MnYb0qxYhV' }], ['lyrics', { id: '456' }]]);
  assert.throws(() => music.lyrics('invalid'), UserError);
});

test('QQ bridge fails closed on malformed or oversized output and stops on close', async (t) => {
  const { music, children } = processFixture(t);
  const first = assert.rejects(music.account(), UserError);
  children[0].stdout.write('not-json\n'); await first; assert.equal(children[0].signal, 'SIGKILL');
  const second = assert.rejects(music.account(), UserError);
  children[1].stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); await second;
  const third = assert.rejects(music.account(), /关闭/); music.close(); await third;
  await assert.rejects(music.account(), /关闭/);
});

test('QQ rate limits cool down only the affected method while preserving its process and other operations', async (t) => {
  let now = 100000;
  const { music, children } = processFixture(t, { now: () => now });
  const first = music.search('Song'); const child = children[0];
  child.stdout.write(JSON.stringify({ id: child.lines[0].id, ok: false, error: 'rate',
    diagnostic: { class: 'RatelimitedError', code: 2001 } }) + '\n');
  await assert.rejects(first, (error) => error.code === 'QQ_RATE_LIMIT' && error.retryAfterSeconds === 60);
  now += 10000;
  await assert.rejects(music.search('Another song'), (error) => error.code === 'QQ_RATE_LIMIT' && error.retryAfterSeconds === 50);
  assert.equal(child.lines.length, 1); assert.equal(child.signal, undefined);
  const sources = new MusicSources({}, { qq: music, netease: { async search() { return [{ id: '456', name: 'NetEase song', artists: 'Artist' }]; } } });
  assert.deepEqual(await sources.search('Song'), [{ id: '456', name: 'NetEase song', artists: 'Artist', source: 'netease' }]);
  const account = music.account(); const qr = music.qrStatus(); const lists = music.discover('hot');
  for (const request of child.lines.slice(1)) {
    const result = request.method === 'account' ? { loggedIn: false } : request.method === 'qrStatus' ? { status: 'waiting' } : [];
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
  }
  assert.deepEqual(await account, { loggedIn: false }); assert.deepEqual(await qr, { status: 'waiting' }); assert.deepEqual(await lists, []);
  now += 50000;
  const recovered = music.search('Song');
  child.stdout.write(JSON.stringify({ id: child.lines.at(-1).id, ok: true, result: [{ id: '123', source: 'qq' }] }) + '\n');
  assert.deepEqual(await recovered, [{ id: '123', source: 'qq' }]);
  assert.equal(children.length, 1); assert.equal(child.signal, undefined); assert.equal(music.pending.size, 0);
});
