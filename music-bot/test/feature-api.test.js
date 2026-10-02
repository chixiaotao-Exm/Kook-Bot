import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { WebConsole } from '../src/web.js';
import { RoomFeatures } from '../src/room-features.js';
import { Player } from '../src/player.js';
import { UserError } from '../src/util.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-features-api-'));
  const config = readConfig({ KOOK_TOKEN: 'test-token', ALLOWED_GUILD_IDS: '10001', DATA_DIR: dir, WEB_REQUIRE_PASSWORD: 'false' }); config.webPort = 0;
  const music = { searchAll: async () => ({ tracks: [{ id: '1', source: 'netease' }], results: { netease: { tracks: [{ id: '1', source: 'netease' }] }, qq: { tracks: [], error: 'QQ暂不可用' } } }),
    lyrics: async (id, source) => ({ id, source, available: true, lines: [{ time: 0, text: 'Lyrics' }], plain: '' }),
    parseInput: async () => ({ source: 'qq', kind: 'song', id: '123', input: '123', isLink: true, resolvedShortLink: true }),
    resolve: async (id, source) => ({ id, source, name: 'Resolved', artists: 'Artist' }) };
  const runtimes = new Map();
  for (const id of ['default', 'second']) {
    const cfg = { ...config, dataDir: path.join(dir, id) };
    const player = new Player(cfg, {}, music, {}, async () => {});
    const features = new RoomFeatures({ config: cfg, player, api: {}, music, selfId: id, intervalMs: 999999 }); await features.init();
    runtimes.set(id, { id, config: cfg, player, features, status: 'ready', self: { username: id }, gateway: { ready: true } });
  }
  const manager = { list: () => [...runtimes.values()].map((r) => ({ id: r.id, name: r.id, status: r.status, online: true })),
    get(id) { const r = runtimes.get(id); if (!r) throw new UserError('机器人不存在'); return r; },
    async withBot(id, fn) { return fn(this.get(id)); } };
  const diagnostics = { records: [], record(event) { this.records.push(event); }, invalidateAccount() {}, snapshot: () => ({ summary: { bots: 2, issues: 0 }, bots: [], events: [], accounts: {} }), refreshAccounts: async () => {} };
  const web = new WebConsole({ config, manager, music, diagnostics }); const address = await web.start(); const base = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(base + '/api/session'), session = await sessionResponse.json();
  const headers = { Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const request = (route, data, h = headers) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: h, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  t.after(async () => { await web.close(); for (const r of runtimes.values()) { await r.features.close(); await r.player.shutdown(); } assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-features-api-')); await rm(dir, { recursive: true, force: true }); });
  return { web, request, runtimes, music, diagnostics, headers };
}
test('room feature settings retain session/CSRF validation and target only the chosen bot', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/features?botId=second', undefined, {})).status, 401);
  const data = await (await f.request('/api/features?botId=second')).json();
  assert.equal(data.features.radio.enabled, false); assert.equal(data.features.rules.enabled, false);
  const value = { ...data.features.rules, enabled: true, perUserLimit: 3, managerIds: ['123'] };
  assert.equal((await f.request('/api/features', { botId: 'second', section: 'rules', value }, { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await f.request('/api/features', { botId: 'second', section: 'rules', value })).status, 200);
  assert.equal(f.runtimes.get('second').features.rules.enabled, true); assert.equal(f.runtimes.get('default').features.rules.enabled, false);
  assert.equal((await f.request('/api/features', { botId: 'missing', section: 'rules', value })).status, 400);
  assert.equal((await f.request('/api/features', { botId: 'second', section: 'rules', value: { ...value, perUserLimit: 0 } })).status, 400);
});
test('new read endpoints preserve partial search results, source lyrics and asynchronous short-link previews', async (t) => {
  const { request } = await fixture(t);
  const search = await (await request('/api/search-all?q=Song')).json();
  assert.equal(search.groups.length, 2); assert.equal(search.groups[0].tracks[0].source, 'netease'); assert.equal(search.errors[0].source, 'qq');
  assert.equal((await request('/api/search-all?q=')).status, 400);
  const lyrics = await (await request('/api/lyrics?source=qq&id=123')).json();
  assert.equal(lyrics.source, 'qq'); assert.equal(lyrics.lines[0].text, 'Lyrics');
  assert.equal((await request('/api/lyrics?source=qq&id=top:26')).status, 400);
  const short = await (await request('/api/resolve?input=https%3A%2F%2F163cn.tv%2Fexample')).json();
  assert.equal(short.resolvedShortLink, true); assert.equal(short.track.source, 'qq');
  assert.equal((await request('/api/health')).status, 200);
});

test('hot library is a session-protected read with bounded pagination and does not trigger collection or playback', async (t) => {
  const { request, music, runtimes } = await fixture(t), calls = [];
  music.hotLibrary = async page => { calls.push(page); return { enabled: true, tracks: [], total: 0, ...page, hasMore: false }; };
  assert.equal((await request('/api/hot-library', undefined, {})).status, 401);
  assert.deepEqual(await (await request('/api/hot-library?offset=50&limit=25')).json(), { enabled: true, tracks: [], total: 0, offset: 50, limit: 25, hasMore: false });
  for (const query of ['offset=-1','offset=5001','limit=101','limit=0','offset=1e2','limit=10&limit=20']) assert.equal((await request('/api/hot-library?'+query)).status, 400);
  assert.deepEqual(calls,[{offset:50,limit:25}]);
  assert.equal((await request('/api/hot-library',{})).status,400);
  assert.ok([...runtimes.values()].every(runtime=>runtime.player.current===null&&runtime.player.queue.length===0));
});
test('NetEase QR success is committed only after valid credentials are saved and failed saves can retry', async (t) => {
  const { web } = await fixture(t); let providerCalls = 0, writes = 0;
  web.qr = { key: 'test', expires: Date.now() + 999999, status: 'scanned', checkedAt: 0 };
  web.provider = () => ({ call: async () => { providerCalls++; return providerCalls === 1 ? { code: 803 } : { code: 803, cookie: 'fake-cookie' }; } });
  web.writeCredential = async () => { writes++; if (writes === 1) throw new Error('Disk full'); };
  await assert.rejects(web.qrStatus(), /凭据/); assert.equal(web.qr.status, 'scanned');
  web.qr.checkedAt = 0; await assert.rejects(web.qrStatus(), /Disk full/); assert.equal(web.qr.status, 'scanned');
  web.qr.checkedAt = 0; assert.deepEqual(await web.qrStatus(), { status: 'success' });
  assert.equal(providerCalls, 3); assert.equal(writes, 2);
  await web.qrStatus(); assert.equal(providerCalls, 3);
});
