import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MusicSources, musicSource, validTrack } from '../src/music-sources.js';
import { WebConsole } from '../src/web.js';
import { Player } from '../src/player.js';
import { readConfig } from '../src/config.js';

const song = (source, id = '123') => ({ source, id, name: source + ' song', artists: 'Artist', durationMs: 200000 });
function fixture() {
  const calls = [];
  const providers = Object.fromEntries(['netease', 'qq'].map((source) => [source, {
    async init() {}, close() {}, async search() { calls.push(source + ':search'); return [song(source)]; },
    async resolve(id) { return song(source, id); }, async playlist() { return [song(source)]; },
    async playlistDetails(id, options) { return { playlist: { id, name: source }, tracks: [song(source)], ...options, total: 1, hasMore: false }; },
    async discover() { return [{ id: '123', name: source }]; },
    async account() { calls.push(source + ':account'); return { loggedIn: source === 'netease', name: source }; },
    async stream(track) { calls.push(source + ':stream:' + track.id); return source; },
    async hot() { return { name: source, tracks: [song(source)] }; },
    async heart(options) { calls.push({ source, seed: options.songId }); return { tracks: [song(source)] }; },
    async logout() { calls.push(source + ':logout'); }, async qrCreate(type) { calls.push(source + ':qr:' + type); return { image: 'data:image/png;base64,AA==', expires: 123 }; },
    async qrStatus() { return { status: 'waiting' }; },
  }]));
  return { music: new MusicSources({}, providers), calls, providers };
}
test('source router separates identical song IDs and defaults legacy records to NetEase', async () => {
  const { music, calls } = fixture();
  const n = (await music.search('Song'))[0], q = (await music.search('Song', 8, 'qq'))[0];
  assert.equal(n.id, q.id); assert.notEqual(n.source, q.source);
  assert.equal(await music.stream(q), 'qq'); assert.equal(await music.stream({ id: '123' }), 'netease');
  assert.deepEqual(calls, ['netease:search', 'qq:search', 'qq:stream:123', 'netease:stream:123']);
  assert.throws(() => musicSource('unknown')); assert.throws(() => musicSource({}));
  assert.ok(validTrack(song('qq', '0039MnYb0qxYhV'))); assert.ok(validTrack({ ...song(undefined) }));
  assert.equal(validTrack(song('netease', '0039MnYb0qxYhV')), false);
  assert.equal(validTrack(song('elsewhere')), false);
});
test('mixed queue keeps source identities and saved playback offset after shutdown', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-mixed-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir, MAX_QUEUE_SIZE: '500', STAY_CONNECTED: 'true' });
  const { music, calls } = fixture();
  const api = { async post() { return {}; } };
  const audio = { start(url, voice, volume, offset) { return { seconds: offset, async stop() {} }; } };
  const player = new Player(config, api, music, audio, async () => {});
  let restored;
  t.after(async () => { await player.shutdown(); await restored?.shutdown(); assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); });
  await player.add({ guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, [song('netease'), song('qq')]);
  await player.control('skip'); player.stream.seconds = 51.5;
  await player.shutdown();
  const saved = JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8'));
  assert.equal(saved.current.source, 'qq'); assert.equal(saved.positionSeconds, 51.5);
  restored = new Player(config, api, music, audio, async () => {});
  await restored.restore(); await restored.resumeAfterRestart();
  assert.equal(restored.current.source, 'qq'); assert.equal(restored.stream.seconds, 51.5);
  assert.deepEqual(calls, ['netease:stream:123', 'qq:stream:123', 'qq:stream:123']);
});
test('HTTP browsing, cache, account and QR operations remain separated by source', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-source-web-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false' }); config.webPort = 0;
  const { music, calls } = fixture(); const added = [];
  const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
  const player = { context, current: song('qq'), capacity: () => 499, async add(ctx, tracks) { added.push(...tracks); } };
  const web = new WebConsole({ config, api: {}, music, player, gateway: { ready: true }, self: {} });
  const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await web.close(); assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); });
  const sessionResponse = await fetch(base + '/api/session'), session = await sessionResponse.json();
  const headers = { Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const get = async (url) => (await fetch(base + url, { headers })).json();
  const post = (url, body, useHeaders = headers) => fetch(base + url, { method: 'POST', headers: useHeaders, body: JSON.stringify(body) });
  assert.equal((await get('/api/search?q=same')).tracks[0].source, 'netease');
  assert.equal((await get('/api/search?q=same&source=qq')).tracks[0].source, 'qq');
  await get('/api/search?q=same'); await get('/api/search?q=same&source=qq');
  assert.equal(calls.filter((call) => String(call).endsWith(':search')).length, 2);
  assert.equal((await get('/api/playlist?id=top:26&source=qq')).playlist.source, 'qq');
  assert.ok((await get('/api/playlist?id=top:26')).error);
  assert.ok((await get('/api/search?q=same&source=invalid')).error);
  await post('/api/play', { input: '123', source: 'qq' }); assert.equal(added[0].source, 'qq');
  await post('/api/heart', { source: 'netease' }); assert.deepEqual(calls.at(-1), { source: 'netease', seed: undefined });
  const n = await get('/api/account'); assert.equal(n.loggedIn, true);
  await get('/api/account?source=qq');
  assert.equal((await post('/api/account/logout', { source: 'qq' })).status, 200);
  await get('/api/account'); await get('/api/account?source=qq');
  assert.equal(calls.filter((call) => call === 'netease:account').length, 1);
  assert.equal(calls.filter((call) => call === 'qq:account').length, 2);
  const qr = await post('/api/account/qr', { source: 'qq', type: 'wx' }); assert.equal(qr.status, 200);
  assert.ok(calls.includes('qq:qr:wx')); assert.equal((await get('/api/account/qr?source=qq')).status, 'waiting');
  assert.equal((await post('/api/account/qr', { source: 'qq' }, { Cookie: headers.Cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.equal(player.current.source, 'qq');
});
