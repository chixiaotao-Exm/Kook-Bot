import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { MusicSources, musicSource, validTrack } from '../src/music-sources.js';
import { parseMusicInput } from '../src/music-input.js';
import { parseMusicInputAsync } from '../src/short-links.js';
import { WebConsole } from '../src/web.js';
import { Diagnostics } from '../src/diagnostics.js';

const ID = '7501674235158431760';
const song = (source, id = ID) => ({ id, source, name: 'Song', artists: 'Singer', durationMs: 180000 });
function providersFixture() {
  const calls = [];
  const providers = Object.fromEntries(['netease', 'qq', 'qishui'].map((source) => [source, {
    async init() { calls.push([source, 'init']); },
    async search() { calls.push([source, 'search']); return [song(source)]; },
    async resolve(id) { calls.push([source, 'resolve', id]); return song(source, id); },
    async account() { calls.push([source, 'account']); return { loggedIn: true, name: source }; },
    async playlistDetails(id, page) { calls.push([source, 'playlist', id]); return { playlist: { id, name: source }, tracks: [song(source)], ...page, total: 1 }; },
    async hot() { return { name: source, tracks: [song(source)] }; },
    async discover() { calls.push([source, 'discover']); return []; },
    async lyrics() { return { lyric: '[00:01]歌词' }; },
    async stream(item) { calls.push([source, 'stream', item.id]); return 'media'; },
  }]));
  return { calls, providers, music: new MusicSources({}, providers) };
}

test('optional Qishui configuration enables only a valid configured provider and preserves source capabilities', () => {
  const base = readConfig({}, { requireToken: false });
  assert.equal(base.qishuiApiUrl, ''); assert.equal(base.qishuiApiToken, '');
  for (const config of [base, { ...base, qishuiApiUrl: 'http://remote.invalid', qishuiApiToken: 'token' }, { ...base, qishuiApiUrl: 'http://127.0.0.1:18790' }]) {
    const music = new MusicSources(config);
    assert.equal(music.sources().find((item) => item.id === 'qishui').enabled, false);
    assert.throws(() => music.forSource('qishui'), /不可用/);
    music.close();
  }
  const config = readConfig({ QISHUI_API_URL: ' http://127.0.0.1:18790 ', QISHUI_API_TOKEN: ' internal-token ' }, { requireToken: false });
  const music = new MusicSources(config), descriptor = music.sources().find((item) => item.id === 'qishui');
  assert.equal(descriptor.enabled, true);
  assert.deepEqual(descriptor.capabilities, { search: true, play: true, playlist: true, discover: true, lyrics: true, login: false, heart: false, mine: false });
  assert.equal(musicSource('qishui'), 'qishui');
  for (const value of [['qishui'], { toString: () => 'qishui' }, 1, false, '__proto__']) assert.throws(() => musicSource(value), /音乐平台无效/);
  music.close();
});

test('Qishui IDs retain all 19 digits through parsing, provider routing and queue validation', async () => {
  const { music, calls } = providersFixture();
  const parsed = parseMusicInput(ID, { source: 'qishui' });
  assert.equal(parsed.id, ID); assert.equal(validTrack(song('qishui')), true);
  assert.equal(validTrack(song('netease')), false);
  assert.equal(validTrack({ ...song('qishui'), id: Number(ID) }), false);
  assert.equal(validTrack(song('qishui', `${ID}0`)), false);
  const track = await music.resolve(parsed.id, parsed.source);
  await music.stream(track);
  assert.deepEqual(calls, [['qishui', 'resolve', ID], ['qishui', 'stream', ID]]);
  assert.equal((await music.lyrics(ID, 'qishui')).id, ID);
});

test('official Qishui full links auto-detect source and reject ambiguous IDs or unverified redirects', async () => {
  for (const [route, parameter, kind] of [['track', 'track_id', 'song'], ['playlist', 'playlist_id', 'playlist']]) {
    const url = `https://music.douyin.com/qishui/share/${route}?${parameter}=${ID}&share_user=private`;
    const result = await parseMusicInputAsync(`分享 ${url}`, { source: 'netease' }, { requestImpl() { throw new Error('Full URL must not fetch'); } });
    assert.deepEqual(result, { source: 'qishui', kind, id: ID, input: ID, isLink: true });
    for (const suffix of [`&${parameter}=123`, '&id=123', '#unverified']) assert.throws(() => parseMusicInput(`${url}${suffix}`));
  }
  for (const input of [`https://music.douyin.com/redirect?track_id=${ID}`, `https://music.douyin.com/qishui/share/track?track_id=${ID}0`,
    `https://music.douyin.com.evil.invalid/qishui/share/track?track_id=${ID}`, `https://qishui.douyin.com/s/unverified/`,
    `https://music.douyin.com/qishui/share/track?track_id=${ID}&playlist_id=${ID}`, 'music.douyin.com/qishui/share/track?track_id=123']) {
    assert.throws(() => parseMusicInput(input, { source: 'qishui' }), input);
  }
});

test('joint search and unsupported Qishui actions are isolated from the existing providers', async () => {
  const { music, providers, calls } = providersFixture();
  let result = await music.searchAll('hello');
  assert.deepEqual(result.tracks.map((track) => track.source), ['netease', 'qq', 'qishui']);
  providers.qishui.search = async () => { throw new Error('private bridge details'); };
  result = await music.searchAll('hello');
  assert.deepEqual(result.tracks.map((track) => track.source), ['netease', 'qq']);
  assert.match(result.results.qishui.error, /汽水/); assert.doesNotMatch(result.results.qishui.error, /private/);
  await assert.rejects(music.heart({}, 'qishui'), /不支持心动/);
  await assert.rejects(music.discover('mine', 'qishui'), /不支持/);
  assert.equal(calls.some(([source, method]) => source === 'qishui' && method === 'discover'), false);
  providers.qishui.configured = false;
  result = await music.searchAll('hello'); assert.equal(result.results.qishui, undefined);
});

test('HTTP Qishui account/playlist/search work and QR/logout cannot modify NetEase credentials', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-qishui-routing-'));
  const config = readConfig({ DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false', QISHUI_API_TOKEN: 'private-bridge-token' }, { requireToken: false });
  config.webPort = 0;
  const { music, calls } = providersFixture();
  const web = new WebConsole({ config, music, player: {}, api: {}, gateway: {}, self: {} });
  const cookiePath = path.join(dir, 'netease-cookie.json');
  await writeFile(cookiePath, '{"cookie":"preserve-net-account"}');
  const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await web.close(); music.close(); assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); });
  const sessionResponse = await fetch(`${base}/api/session`), session = await sessionResponse.json();
  const headers = { Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const get = async (route) => { const response = await fetch(base + route, { headers }); return { status: response.status, body: await response.json() }; };
  const post = async (route) => { const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ source: 'qishui' }) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await get('/api/sources')).body.sources.find((source) => source.id === 'qishui').enabled, true);
  const account = await get('/api/account?source=qishui'); assert.equal(account.status, 200); assert.equal(account.body.name, 'qishui');
  const playlist = await get(`/api/playlist?source=qishui&id=${ID}`); assert.equal(playlist.status, 200); assert.equal(playlist.body.playlist.id, ID);
  assert.deepEqual((await get('/api/search-all?q=hello')).body.groups.map((group) => group.source), ['netease', 'qq', 'qishui']);
  for (const response of [await get('/api/account/qr?source=qishui'), await post('/api/account/qr'), await post('/api/account/logout')]) {
    assert.equal(response.status, 400); assert.match(response.body.error, /汽水音乐.*不支持/);
  }
  assert.equal(await readFile(cookiePath, 'utf8'), '{"cookie":"preserve-net-account"}');
  assert.equal(calls.some(([source, method]) => source === 'netease' && method === 'account'), false);
  assert.equal(web.safeMessage('private-bridge-token'), '[已隐藏]');
});

test('diagnostics include enabled Qishui accounts, skip disabled providers and redact bridge tokens', async () => {
  const { music, calls, providers } = providersFixture();
  const config = { dataDir: '.', qishuiApiToken: 'private-bridge-token' }, manager = { list: () => [] };
  const enabled = new Diagnostics(config, manager, music);
  await enabled.refreshAccounts(); assert.equal(enabled.accounts.qishui.loggedIn, true);
  assert.equal(enabled.redact('private-bridge-token'), '[已隐藏]'); await enabled.close();
  providers.qishui.configured = false; calls.length = 0;
  const disabled = new Diagnostics(config, manager, music);
  await disabled.refreshAccounts(); assert.equal(disabled.accounts.qishui, undefined);
  assert.deepEqual(calls.map(([source]) => source), ['netease', 'qq']); await disabled.close();
});
