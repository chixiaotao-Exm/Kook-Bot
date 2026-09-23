import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.js';
import { Player } from '../src/player.js';
import { Music } from '../src/music.js';
import { WebConsole } from '../src/web.js';
import { setPassword } from '../src/web-auth.js';

async function setup(t, publicAccess = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-web-test-'));
  const config = readConfig({ KOOK_TOKEN: 'never-expose-token', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dir, STAY_CONNECTED: 'true' });
  config.webPort = 0;
  config.webRequirePassword = !publicAccess;
  if (!publicAccess) await setPassword(dir, 'Test-password-12345');
  const calls = [];
  const api = { async request(route, params) {
    if (route === 'guild/view') return { name: 'Allowed Guild' };
    return { items: [{ id: params.type === 1 ? 't1' : 'v1', name: 'Channel', type: params.type }], meta: { page_total: 1 } };
  }, async post(route) { calls.push(route); return {}; } };
  const tracks = [{ id: '100', name: 'Song', artists: 'Artist', durationMs: 200000 }];
  const music = { search: async () => tracks, account: async () => ({ loggedIn: true, name: 'Account' }), playlist: async () => tracks, stream: async () => 'https://music.126.net/test' };
  const audio = { start() { return { seconds: 0, paused: false, async stop() {}, pause() { this.paused = true; } }; } };
  const player = new Player(config, api, music, audio, async () => {});
  const web = new WebConsole({ config, api, music, player, gateway: { ready: true }, self: { username: 'Bot' } });
  const address = await web.start(); const base = `http://127.0.0.1:${address.port}`;
  const request = (route, data, headers = {}) => fetch(`${base}${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const response = publicAccess ? await request('/api/session') : await request('/api/login', { password: 'Test-password-12345' });
  const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
  const auth = { Cookie: cookie, 'X-CSRF-Token': session.csrf };
  t.after(async () => { await web.close(); await player.shutdown(); assert.ok(path.basename(dir).startsWith('kook-web-test-')); await rm(dir, { recursive: true, force: true }); });
  return { web, player, music, request, auth, calls, api };
}
test('console requires authentication and does not expose server credentials', async (t) => {
  const { request, auth } = await setup(t);
  assert.equal((await request('/api/state')).status, 401);
  const response = await request('/api/state', undefined, auth); const text = await response.text();
  assert.equal(response.status, 200); assert.equal(text.includes('never-expose-token'), false);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/..%2f.env')).status, 404);
  assert.equal((await request('/src/index.js')).status, 404);
});
test('open access starts without a password file and grants a CSRF-protected session', async (t) => {
  const { request, auth, web } = await setup(t, true);
  const session = await (await request('/api/session', undefined, auth)).json();
  assert.equal(session.authenticated, true); assert.equal(session.passwordRequired, false);
  assert.equal((await request('/api/state', undefined, auth)).status, 200);
  assert.equal((await request('/api/settings', { stayConnected: true }, auth)).status, 200);
  assert.equal((await request('/api/settings', { stayConnected: false }, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request('/api/settings', { stayConnected: false }, { ...auth, Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/login', { password: 'anything' })).status, 404);
  web.auth.sessions.clear();
  const refreshed = await request('/api/session', undefined, auth);
  assert.equal((await refreshed.json()).authenticated, true);
  assert.ok(refreshed.headers.get('set-cookie'));
  assert.equal((await request('/data/web-admin.json')).status, 404);
});
test('console rejects missing CSRF and cross-origin writes', async (t) => {
  const { request, auth } = await setup(t);
  assert.equal((await request('/api/settings', { stayConnected: false }, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request('/api/settings', { stayConnected: false }, { ...auth, Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await request('/api/settings', { stayConnected: false }, auth)).status, 200);
});
test('channel selection is restricted to the configured guild and actual channels', async (t) => {
  const { request, auth, player } = await setup(t);
  assert.equal((await request('/api/channel', { guildId: 'other', voiceChannelId: 'v1' }, auth)).status, 400);
  assert.equal((await request('/api/channel', { guildId: 'g1', voiceChannelId: 't1' }, auth)).status, 400);
  assert.equal((await request('/api/channel', { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, auth)).status, 200);
  assert.equal(player.voiceJoined, true); assert.equal(player.idleTimer, undefined);
});
test('playback command validation rejects invalid values', async (t) => {
  const { request, auth } = await setup(t);
  for (const data of [{ action: 'volume', value: 101 }, { action: 'volume', value: '50' }, { action: 'loop', value: 'bad' }, { action: 'remove', value: 1.1 }, { action: 'unknown' }]) {
    assert.equal((await request('/api/control', data, auth)).status, 400);
  }
});
test('logout invalidates the server session', async (t) => {
  const { request, auth } = await setup(t);
  assert.equal((await request('/api/logout', {}, auth)).status, 200);
  assert.equal((await request('/api/state', undefined, auth)).status, 401);
});
test('resident playback keeps the voice connection after the queue finishes', async (t) => {
  const { player, music } = await setup(t);
  await player.add({ guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, await music.playlist());
  await player.control('skip');
  assert.equal(player.current, null); assert.equal(player.voiceJoined, true); assert.equal(player.idleTimer, undefined);
  await player.control('stay', false); assert.ok(player.idleTimer);
  await player.control('stop'); assert.equal(player.voiceJoined, false); assert.equal(player.context, null);
});
test('unavailable heart mode falls back to a real hot chart and explains the fallback', async () => {
  const music = new Music({});
  music.account = async () => ({ loggedIn: true }); music.discover = async () => [{ id: '1' }];
  music.playlist = async () => [{ id: '2' }]; music.call = async () => { throw new Error('Unavailable'); };
  music.hot = async () => ({ mode: 'hot', name: '热歌榜', tracks: [{ id: '3' }] });
  const result = await music.heart();
  assert.equal(result.mode, 'hot'); assert.deepEqual(result.tracks, [{ id: '3' }]); assert.match(result.notice, /不可用/);
});
test('resident mode detects lost KOOK membership even when keep-alive returns success', async (t) => {
  const { player, music, api, calls } = await setup(t);
  await player.add({ guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, await music.playlist());
  api.request = async () => ({ items: [] });
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.voiceJoined, true);
  assert.equal(player.current.id, '100');
  assert.equal(player.queue.length, 0);
  assert.equal(player.snapshot().status, 'playing');
  assert.equal(calls.filter((route) => route === 'voice/join').length, 2);
});
test('heart mode preserves actual recommendations when upstream supports it', async () => {
  const music = new Music({}); music.account = async () => ({ loggedIn: true });
  music.call = async () => ({ data: [{ songInfo: { id: 5, name: 'Recommended', ar: [{ name: 'Artist' }] } }] });
  const result = await music.heart({ playlistId: '1', songId: '2' });
  assert.equal(result.mode, 'heart'); assert.equal(result.tracks[0].name, 'Recommended');
});
