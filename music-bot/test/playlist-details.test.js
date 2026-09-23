import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Music } from '../src/music.js';
import { createProvider } from '../src/provider.js';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';
import { UserError } from '../src/util.js';

const rawSong = (id) => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }], dt: 180000,
  al: { name: 'Album', picUrl: 'http://p1.music.126.net/cover.jpg' } });
function musicFixture(count = 123) {
  const detail = { id: 99, name: 'Playlist', coverImgUrl: 'http://p1.music.126.net/list.jpg',
    creator: { nickname: 'Creator' }, description: 'Description', trackCount: count, playCount: 9000,
    trackIds: Array.from({ length: count }, (_, i) => ({ id: i + 1 })), tracks: [rawSong(1), rawSong(2)] };
  const calls = [];
  const sdk = {
    async playlist_detail(params) { calls.push({ method: 'playlist_detail', params }); return { body: { code: 200, playlist: detail } }; },
    async song_detail(params) { calls.push({ method: 'song_detail', params }); return { body: { code: 200,
      songs: params.ids.split(',').map(Number).reverse().map(rawSong) } }; },
  };
  return { music: new Music({ cookie: 'test-cookie' }, sdk), detail, sdk, calls };
}

test('playlist browsing pages full trackIds and restores playlist order after song lookup', async () => {
  const { music, calls } = musicFixture();
  const page = await music.playlistDetails('99', { offset: 50, limit: 50 });
  assert.deepEqual(page.tracks.map((song) => song.id), Array.from({ length: 50 }, (_, i) => String(i + 51)));
  assert.equal(calls[1].params.ids, Array.from({ length: 50 }, (_, i) => i + 51).join(','));
  assert.deepEqual(page.playlist, { id: '99', name: 'Playlist', cover: 'https://p1.music.126.net/list.jpg',
    description: 'Description', creator: 'Creator', trackCount: 123, playCount: 9000 });
  assert.equal(page.tracks[0].artists, 'Artist'); assert.equal(page.tracks[0].durationMs, 180000);
  assert.equal(page.total, 123); assert.equal(page.offset, 50); assert.equal(page.limit, 50); assert.equal(page.hasMore, true);
  const last = await music.playlistDetails('99', { offset: 100, limit: 50 });
  assert.equal(last.tracks.length, 23); assert.equal(last.tracks.at(-1).id, '123'); assert.equal(last.hasMore, false);
});

test('missing song details do not change pagination slots or reorder duplicate playlist IDs', async () => {
  const { music, detail, sdk } = musicFixture();
  detail.trackIds = [{ id: 7 }, { id: 2 }, { id: 7 }, { id: 5 }];
  sdk.song_detail = async () => ({ body: { code: 200, songs: [rawSong(5), rawSong(7)] } });
  const page = await music.playlistDetails('99', { limit: 3 });
  assert.deepEqual(page.tracks.map((song) => song.id), ['7', '7']);
  assert.equal(page.total, 4); assert.equal(page.playlist.trackCount, 4); assert.equal(page.hasMore, true);
});

test('empty and out-of-range playlist pages do not request empty song batches', async () => {
  for (const [count, offset] of [[0, 0], [3, 100]]) {
    const { music, calls } = musicFixture(count);
    const page = await music.playlistDetails('99', { offset });
    assert.deepEqual(page.tracks, []); assert.equal(page.total, count); assert.equal(page.hasMore, false);
    assert.equal(calls.length, 1); assert.equal(page.offset, offset); assert.equal(page.limit, 50);
  }
});

test('playlist service validates page boundaries before any upstream call', async () => {
  const { music, calls } = musicFixture();
  for (const id of ['', '0', '-1', 'invalid', 'https://other.example/playlist?id=1']) await assert.rejects(music.playlistDetails(id), UserError);
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { offset: '1' }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '50' }, { limit: Infinity }]) {
    await assert.rejects(music.playlistDetails('99', options), UserError);
  }
  assert.equal(calls.length, 0);
});

test('malformed and failed upstream playlist responses produce safe errors', async () => {
  const { music, sdk, detail } = musicFixture();
  sdk.playlist_detail = async () => { throw new Error('private upstream credential'); };
  await assert.rejects(music.playlistDetails('99'), (error) => error instanceof UserError && !error.message.includes('private'));
  sdk.playlist_detail = async () => ({ body: { code: 200, playlist: { ...detail, trackIds: null } } });
  await assert.rejects(music.playlistDetails('99'), /歌单详情/);
  sdk.playlist_detail = async () => ({ body: { code: 200, playlist: { ...detail, trackIds: [{ id: 'invalid' }] } } });
  await assert.rejects(music.playlistDetails('99'), /歌曲列表/);
  sdk.playlist_detail = async () => ({ body: { code: 200, playlist: detail } });
  sdk.song_detail = async () => ({ body: { code: 200 } });
  await assert.rejects(music.playlistDetails('99'), /歌曲详情/);
  sdk.song_detail = async () => { throw new Error('private media response'); };
  await assert.rejects(music.playlistDetails('99'), (error) => error instanceof UserError && !error.message.includes('private'));
});

test('existing playlist imports still use their original bounded SDK operation', async () => {
  let request;
  const music = new Music({ cookie: 'test-cookie' }, { async playlist_track_all(params) {
    request = params; return { body: { code: 200, songs: [rawSong(7), rawSong(2)] } };
  } });
  const tracks = await music.playlist('https://music.163.com/playlist?id=99', 2);
  assert.equal(request.id, '99'); assert.equal(request.limit, 2); assert.deepEqual(tracks.map((song) => song.id), ['7', '2']);
});

test('provider exposes playlist metadata through its bounded worker bridge', () => {
  const provider = createProvider(); assert.equal(typeof provider.playlist_detail, 'function'); provider.close();
});

async function webFixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-playlist-web-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir });
  config.webPort = 0; config.webRequirePassword = false;
  const calls = []; const result = { playlist: { id: '99', name: 'Playlist', creator: 'Creator', cover: '', description: '', trackCount: 123, playCount: 0 },
    tracks: [], total: 123, offset: 0, limit: 50, hasMore: true };
  const music = { async playlistDetails(id, page) { calls.push({ id, ...page }); return { ...result, ...page }; } };
  const player = Object.freeze({ context: null, current: null, queue: Object.freeze([{ id: '7' }]), capacity: () => 0,
    async add() { throw new Error('Read-only browsing must not add songs'); } });
  const api = { async request() { throw new Error('Read-only browsing must not query voice channels'); } };
  const web = new WebConsole({ config, api, music, player, gateway: { ready: true }, self: { username: 'Bot' } });
  const address = await web.start(); const base = `http://127.0.0.1:${address.port}`;
  const request = (route, data, headers = {}) => fetch(`${base}${route}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const sessionResponse = await request('/api/session'); const session = await sessionResponse.json();
  const auth = { Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrf };
  t.after(async () => {
    await web.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-playlist-web-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { web, music, player, calls, request, auth };
}

test('playlist HTTP browsing requires a session but works with a full queue and no voice channel', async (t) => {
  const { web, player, request, auth, calls } = await webFixture(t);
  assert.equal((await request('/api/playlist?id=99')).status, 401); assert.equal(calls.length, 0);
  const before = JSON.stringify(player); web.mutating = true;
  const response = await request('/api/playlist?id=99', undefined, { Cookie: auth.Cookie });
  assert.equal(response.status, 200); assert.equal((await response.json()).total, 123);
  assert.deepEqual(calls, [{ id: '99', offset: 0, limit: 50 }]); assert.equal(JSON.stringify(player), before);
  assert.equal(web.activity.length, 0); assert.equal(web.stateVersion, 0); assert.equal(web.mutating, true);
  web.mutating = false;
  const imported = await request('/api/playlist', { id: '99' }, auth);
  assert.equal(imported.status, 400); assert.match((await imported.json()).error, /队列已满/);
});

test('playlist HTTP validation rejects malformed IDs and numeric query values', async (t) => {
  const { request, auth, calls } = await webFixture(t);
  for (const query of ['', 'id=0', 'id=no', 'id=9999999999999999999', 'id=99&offset=-1', 'id=99&offset=1.5',
    'id=99&offset=1e3', 'id=99&offset=', 'id=99&offset=9007199254740992', 'id=99&limit=0',
    'id=99&limit=101', 'id=99&limit=1.5', 'id=99&limit=', 'id=99&limit=Infinity']) {
    assert.equal((await request(`/api/playlist?${query}`, undefined, auth)).status, 400, query);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/playlist?id=99&offset=0&limit=100', undefined, auth)).status, 200);
});

test('playlist import reports actual added count while preserving the queue capacity limit', async (t) => {
  const { web, music, request, auth } = await webFixture(t);
  const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }; let imported; let lookup;
  web.player = { context, capacity: () => 2, async add(ctx, tracks) { imported = { ctx, tracks }; } };
  music.playlist = async (id, limit) => { lookup = { id, limit }; return [{ id: '1' }, { id: '2' }, { id: '3' }].slice(0, limit); };
  const response = await request('/api/playlist', { id: '99' }, auth);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, added: 2 });
  assert.deepEqual(lookup, { id: '99', limit: 2 }); assert.equal(imported.ctx, context); assert.equal(imported.tracks.length, 2);
});

test('playlist pages cache independently and account changes invalidate their content', async (t) => {
  const { request, auth, calls } = await webFixture(t);
  const page = '/api/playlist?id=99&offset=50&limit=50';
  const responses = await Promise.all([request(page, undefined, auth), request(page, undefined, auth)]);
  assert.ok(responses.every((response) => response.status === 200)); assert.equal(calls.length, 1);
  await request('/api/playlist?id=99&offset=100&limit=50', undefined, auth); assert.equal(calls.length, 2);
  assert.equal((await request('/api/account/logout', {}, auth)).status, 200);
  assert.equal((await request(page, undefined, auth)).status, 200); assert.equal(calls.length, 3);
});

test('failed playlist reads are not cached and the next request can recover', async (t) => {
  const { request, auth, music } = await webFixture(t); let attempts = 0;
  music.playlistDetails = async () => {
    if (++attempts === 1) throw new UserError('网易云暂时不可用。');
    return { playlist: { id: '99' }, tracks: [], total: 0, offset: 0, limit: 50, hasMore: false };
  };
  const failed = await request('/api/playlist?id=99', undefined, auth);
  assert.equal(failed.status, 400); assert.match((await failed.json()).error, /暂时不可用/);
  const recovered = await request('/api/playlist?id=99', undefined, auth);
  assert.equal(recovered.status, 200); assert.equal((await recovered.json()).hasMore, false); assert.equal(attempts, 2);
});
