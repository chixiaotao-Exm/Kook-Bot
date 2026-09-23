import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.js';
import { WebConsole } from '../src/web.js';
import { UserError } from '../src/util.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-smart-links-'));
  const config = readConfig({ KOOK_TOKEN: 'private-bot-token', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false' });
  config.webPort = 0;
  const calls = []; const added = [];
  const track = (source, id) => ({ id, source, name: `${source} Song`, artists: 'Artist', durationMs: 180000 });
  const music = {
    async resolve(id, source) { calls.push({ method: 'resolve', id, source }); return track(source, id); },
    async playlistDetails(id, page, source) {
      calls.push({ method: 'playlistDetails', id, page, source });
      return { playlist: { id, source, name: `${source} Playlist`, trackCount: 200 },
        tracks: [track(source, '1'), track(source, '2')], total: 200, ...page, hasMore: true };
    },
    async playlist(id, limit, source) { calls.push({ method: 'playlist', id, limit, source }); return Array.from({ length: limit }, (_, i) => track(source, String(i + 1))); },
  };
  const player = { context: { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, free: 500,
    capacity() { return this.free; }, async add(context, tracks, binding) { added.push({ context, tracks, binding }); this.free -= tracks.length; return tracks.length; } };
  const web = new WebConsole({ config, music, player, api: {}, gateway: { ready: true }, self: { username: 'Bot' } });
  const { port } = await web.start(); const base = `http://127.0.0.1:${port}`;
  const request = (route, data, headers = {}) => fetch(`${base}${route}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const response = await request('/api/session'); const { csrf } = await response.json();
  const auth = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrf };
  const preview = (input, extra = {}, headers = auth) => request(`/api/resolve?${new URLSearchParams({ input, ...extra })}`, undefined, headers);
  t.after(async () => { await web.close(); assert.ok(path.basename(dir).startsWith('kook-smart-links-')); await rm(dir, { recursive: true, force: true }); });
  return { web, music, player, calls, added, request, preview, auth };
}

test('smart previews are session-protected and work without any usable bot, channel or capacity', async (t) => {
  const { web, player, preview, calls } = await fixture(t);
  assert.equal((await preview('https://y.qq.com/playlist/123', {}, {})).status, 401);
  assert.equal(calls.length, 0);
  player.context = null; player.free = 0;
  web.manager = { list: () => [], get() { throw new Error('Preview must not inspect bot runtimes'); } };
  const response = await preview('https://y.qq.com/playlist/123', { source: 'netease', botId: 'missing-bot' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.kind, 'playlist'); assert.equal(result.source, 'qq'); assert.equal(result.id, '123');
  assert.equal(result.total, 200); assert.equal(result.playlist.name, 'qq Playlist');
  assert.deepEqual(calls, [{ method: 'playlistDetails', id: '123', page: { offset: 0, limit: 5 }, source: 'qq' }]);
  assert.equal((await preview('https://music.163.com/song?id=456', { source: 'qq' })).status, 200);
  assert.deepEqual(calls[1], { method: 'resolve', id: '456', source: 'netease' });
});

test('keyword previews are descriptors without provider requests and plain IDs honor the source/type hint', async (t) => {
  const { preview, calls } = await fixture(t);
  assert.deepEqual(await (await preview('葡萄成熟时', { source: 'qq' })).json(),
    { source: 'qq', kind: 'search', query: '葡萄成熟时', input: '葡萄成熟时', isLink: false });
  assert.equal(calls.length, 0);
  const song = await (await preview('123', { source: 'qq' })).json();
  const playlist = await (await preview('123', { source: 'qq', kind: 'playlist' })).json();
  assert.equal(song.kind, 'song'); assert.equal(song.track.source, 'qq'); assert.equal(playlist.kind, 'playlist');
  assert.deepEqual(calls.map((call) => call.method), ['resolve', 'playlistDetails']);
});

test('canonical preview cache separates platform and kind, discards share data and invalidates after account changes', async (t) => {
  const { web, preview, calls } = await fixture(t);
  const urls = ['https://music.163.com/song?id=123&userid=private-share-data', 'https://music.163.com/#/song?id=123'];
  const responses = await Promise.all(urls.map((input) => preview(input, { source: 'qq' })));
  assert.ok(responses.every((response) => response.status === 200)); assert.equal(calls.length, 1);
  assert.ok(!(await responses[0].text()).includes('private-share-data'));
  const plain = await (await preview('123')).json(); assert.equal(plain.isLink, false); assert.equal(calls.length, 1);
  await preview('123', { source: 'qq' });
  await preview('123', { source: 'netease', kind: 'playlist' });
  await preview('123', { source: 'qq', kind: 'playlist' });
  assert.equal(calls.length, 4);
  web.clearAccountCache('qq');
  await preview('123', { source: 'netease' }); assert.equal(calls.length, 4);
  await preview('123', { source: 'qq' }); assert.equal(calls.length, 5);
});

test('preview errors are safe, cached failures recover and foreign/short URLs never reach providers', async (t) => {
  const { music, preview, calls } = await fixture(t);
  for (const input of ['https://private.invalid/song?id=1&secret=hidden', 'https://127.0.0.1:8787/song?id=1',
    'https://user:secret@music.163.com/song?id=1', 'https://163cn.tv/hidden', 'https://y.qq.com/base/fcgi-bin/u?__=hidden']) {
    const response = await preview(input); assert.equal(response.status, 400);
    const body = await response.text(); assert.ok(!body.includes('hidden')); assert.ok(!body.includes('secret'));
  }
  assert.equal(calls.length, 0);
  const resolve = music.resolve; let attempt = 0;
  music.resolve = async (...args) => { if (!attempt++) throw new UserError('请稍后重试。'); return resolve(...args); };
  assert.equal((await preview('123')).status, 400);
  assert.equal((await preview('123')).status, 200); assert.equal(attempt, 2);
});

test('play/import reparses source and rejects mismatched link kinds before provider requests', async (t) => {
  const { request, auth, calls, added } = await fixture(t);
  assert.equal((await request('/api/play', { input: 'https://y.qq.com/playlist/123', source: 'netease' }, auth)).status, 400);
  assert.equal((await request('/api/playlist', { id: 'https://music.163.com/song?id=123', source: 'qq' }, auth)).status, 400);
  assert.equal(calls.length, 0); assert.equal(added.length, 0);
  const song = await request('/api/play', { input: '分享 https://y.qq.com/song?songid=123。', source: 'netease' }, auth);
  assert.equal(song.status, 200); assert.deepEqual(await song.json(), { ok: true, added: 1 });
  const playlist = await request('/api/playlist', { id: 'https://music.163.com/#/playlist?id=456', source: 'qq', maxItems: 3 }, auth);
  assert.equal(playlist.status, 200); assert.deepEqual(await playlist.json(), { ok: true, added: 3 });
  assert.deepEqual(calls, [{ method: 'resolve', id: '123', source: 'qq' }, { method: 'playlist', id: '456', limit: 3, source: 'netease' }]);
  assert.equal(added[0].tracks[0].source, 'qq'); assert.equal(added[1].tracks[0].source, 'netease');
});

test('reviewed playlist quantity and live capacity both cap import, including an overproducing provider', async (t) => {
  const { request, auth, music, player, calls, added } = await fixture(t);
  player.free = 50;
  const original = music.playlist;
  music.playlist = async (id, limit, source) => [...await original(id, limit, source), { id: '999', source }];
  let response = await request('/api/playlist', { id: '123', maxItems: 3 }, auth);
  assert.deepEqual(await response.json(), { ok: true, added: 3 }); assert.equal(calls[0].limit, 3);
  player.free = 2;
  response = await request('/api/playlist', { id: '123', maxItems: 5 }, auth);
  assert.deepEqual(await response.json(), { ok: true, added: 2 }); assert.equal(calls[1].limit, 2);
  player.free = 10;
  music.playlist = async (...args) => { const tracks = await original(...args); player.free = 1; return tracks; };
  response = await request('/api/playlist', { id: '123', maxItems: 5 }, auth);
  assert.deepEqual(await response.json(), { ok: true, added: 1 }); assert.equal(added[2].tracks.length, 1);
  assert.equal((await request('/api/play', { input: '123' }, auth)).status, 400);
});

test('import maxItems validates strictly, legacy unbounded imports retain capacity bound and writes retain CSRF', async (t) => {
  const { request, auth, calls, player } = await fixture(t);
  for (const maxItems of [0, -1, 501, 1.5, '3', null, true]) {
    assert.equal((await request('/api/playlist', { id: '123', maxItems }, auth)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/playlist', { id: 'https://y.qq.com/playlist/123', maxItems: 1 }, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request('/api/play', { input: 'https://y.qq.com/song?songid=123' }, { ...auth, Origin: 'https://other.invalid' })).status, 403);
  assert.equal(calls.length, 0);
  player.free = 4;
  const response = await request('/api/playlist', { id: '123', source: 'qq' }, auth);
  assert.deepEqual(await response.json(), { ok: true, added: 4 }); assert.equal(calls[0].limit, 4);
});

test('smart submissions validate their preview channel before provider lookup and pass the binding to the atomic player operation', async (t) => {
  const { request, auth, calls, added, player, web } = await fixture(t);
  for (const expectedVoiceChannelId of ['', '   ', 123, null, true, 'x'.repeat(65), 'v2']) {
    for (const [route, input] of [['/api/play', { input: '123' }], ['/api/playlist', { id: '123', maxItems: 2 }]]) {
      assert.equal((await request(route, { ...input, expectedVoiceChannelId }, auth)).status, 400);
    }
  }
  assert.equal(calls.length, 0); assert.equal(added.length, 0);
  assert.equal((await request('/api/play', { input: '123', expectedVoiceChannelId: 'v1' }, auth)).status, 200);
  assert.equal((await request('/api/playlist', { id: '123', maxItems: 2, expectedVoiceChannelId: 'v1' }, auth)).status, 200);
  assert.deepEqual(added.map((entry) => entry.binding.expectedVoiceChannelId), ['v1', 'v1']);
  assert.ok(added.every((entry) => typeof entry.binding.checkState === 'function' && entry.binding.checkState()));
  player.context = null;
  web.catalog = async () => { throw new Error('A stopped bot must reject a bound add before channel discovery'); };
  const stopped = await request('/api/play', { input: '123', expectedVoiceChannelId: 'v1', guildId: 'g1', voiceChannelId: 'v1' }, auth);
  assert.equal(stopped.status, 400); assert.match((await stopped.json()).error, /频道已变化/);
  assert.equal(calls.length, 2); assert.equal(added.length, 2);
});
