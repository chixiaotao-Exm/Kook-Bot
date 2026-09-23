import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebConsole } from '../src/web.js';
import { readConfig } from '../src/config.js';
import { UserError } from '../src/util.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-multi-web-'));
  const config = readConfig({ KOOK_TOKEN: 'secret-default-token', ALLOWED_GUILD_IDS: 'guild-default', DATA_DIR: dir, MAX_QUEUE_SIZE: '500' });
  config.webPort = 0; config.webRequirePassword = false;
  const runtimes = new Map(); const calls = []; const leases = [];
  function create(id, token = `secret-${id}-token`) {
    const ctx = { guildId: `guild-${id}`, voiceChannelId: `voice-${id}`, textChannelId: `text-${id}` };
    const player = {
      context: ctx, current: { id: `${id}-song`, source: 'netease' }, queue: [], volume: 40, mode: 'off', stayConnected: true,
      snapshot() { return { current: this.current, queue: this.queue, context: this.context, volume: this.volume, mode: this.mode, stayConnected: this.stayConnected, status: 'paused' }; },
      capacity() { return 500 - this.queue.length - (this.current ? 1 : 0); },
      async join(context) { this.context = context; calls.push({ id, action: 'join', context }); },
      async add(context, tracks) { this.context = context; this.queue.push(...tracks); calls.push({ id, action: 'add', tracks }); },
      async control(action, value) {
        calls.push({ id, action, value });
        if (action === 'volume') this.volume = value;
        if (action === 'stay') this.stayConnected = value;
        return `${id}: ${action}`;
      },
    };
    const api = { async request(route, params) {
      calls.push({ id, route, params });
      if (route === 'guild/view') return { name: `Guild ${id}`, token };
      return { items: [{ id: params.type === 1 ? `text-${id}` : `voice-${id}`, name: `Channel ${id}`, type: params.type, token }], meta: { page_total: 1 } };
    } };
    const runtime = { id, config: { ...config, token, guilds: new Set([`guild-${id}`]) }, api, player,
      self: { username: `Bot ${id}` }, gateway: { ready: true }, status: 'ready', managed: id !== 'default', error: '' };
    runtimes.set(id, runtime); return runtime;
  }
  const summary = (r) => ({ id: r.id, name: r.self?.username || r.id, username: r.self?.username || '', online: Boolean(r.gateway?.ready),
    status: r.status, error: r.error, managed: r.managed, guildIds: [...r.config.guilds], context: r.player?.context, playing: false,
    token: r.config.token, config: r.config });
  create('default'); create('second');
  const manager = {
    get(id = 'default') { const runtime = runtimes.get(id); if (!runtime) throw new UserError('机器人不存在。'); return runtime; },
    list() { return [...runtimes.values()].map(summary); },
    async withBot(id, fn) { const runtime = this.get(id); leases.push(`start:${id}`); try { return await fn(runtime); } finally { leases.push(`end:${id}`); } },
    async add({ token, name, guildIds }) { if (token === 'rejected-secret') throw new UserError(`Invalid token: ${token}`); const runtime = create('third', token); runtime.self.username = name; runtime.config.guilds = new Set(guildIds); return summary(runtime); },
    async remove(id) { if (id === 'default') throw new UserError('不能删除默认机器人。'); runtimes.delete(id); calls.push({ id, action: 'removeBot' }); },
    async retry(id) { calls.push({ id, action: 'retryBot' }); this.get(id).status = 'ready'; },
  };
  const track = (id) => ({ id, name: id, artists: 'Artist', durationMs: 100000, source: 'netease' });
  const music = {
    resolve: async (input) => track(input), playlist: async (id) => [track(`playlist-${id}`)],
    heart: async ({ songId }) => ({ mode: 'heart', name: 'Heart', tracks: [track(`heart-${songId}`)] }),
    hot: async () => ({ mode: 'hot', name: 'Hot', tracks: [track('hot-song')] }),
  };
  const web = new WebConsole({ config, manager, music });
  const address = await web.start(); const base = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${base}/api/session`); const session = await sessionResponse.json();
  const auth = { Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const request = (route, data, headers = auth) => fetch(`${base}${route}`, { method: data === undefined ? 'GET' : 'POST', headers,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  t.after(async () => { await web.close(); assert.equal(path.dirname(dir), tmpdir()); assert.ok(path.basename(dir).startsWith('kook-multi-web-')); await rm(dir, { recursive: true, force: true }); });
  return { web, manager, music, runtimes, calls, leases, request, auth };
}

test('every playback route and activity log belongs to the selected bot', async (t) => {
  const { request, runtimes, calls, leases } = await fixture(t);
  const original = structuredClone(runtimes.get('default').player.snapshot());
  for (const [route, data] of [
    ['/api/channel', { guildId: 'guild-second', voiceChannelId: 'voice-second', textChannelId: 'text-second' }],
    ['/api/play', { input: 'my-song' }], ['/api/playlist', { id: '123' }], ['/api/heart', {}], ['/api/hot', {}],
    ['/api/control', { action: 'volume', value: 72 }], ['/api/settings', { stayConnected: false }],
  ]) assert.equal((await request(route, { ...data, botId: 'second' })).status, 200, route);
  assert.deepEqual(runtimes.get('default').player.snapshot(), original);
  assert.equal(runtimes.get('second').player.volume, 72);
  assert.equal(runtimes.get('second').player.stayConnected, false);
  assert.equal(runtimes.get('second').player.queue.length, 4);
  assert.ok(calls.every((call) => call.id === 'second'));
  assert.equal(leases.filter((lease) => lease === 'start:second').length, 7);
  const second = await (await request('/api/state?botId=second')).json();
  const primary = await (await request('/api/state')).json();
  assert.equal(second.botId, 'second'); assert.equal(second.bot.name, 'Bot second');
  assert.equal(second.activity.length, 7); assert.equal(primary.activity.length, 0);
  assert.equal(second.bots.length, 2); assert.equal(primary.botId, 'default');
});

test('a slow bot command neither blocks nor retargets another bot and prevents lifecycle races', async (t) => {
  const { request, music, runtimes, calls, leases } = await fixture(t);
  const entered = deferred(); const release = deferred();
  music.resolve = async (input) => { entered.resolve(); await release.promise; return { id: input, name: input }; };
  const slow = request('/api/play', { botId: 'second', input: 'slow-song' });
  await entered.promise;
  try {
    assert.equal((await request('/api/control', { botId: 'second', action: 'pause' })).status, 409);
    assert.equal((await request('/api/bots/remove', { botId: 'second' })).status, 409);
    assert.equal((await request('/api/bots/retry', { botId: 'second' })).status, 409);
    assert.equal((await request('/api/control', { action: 'volume', value: 81 })).status, 200);
    assert.equal((await (await request('/api/state?botId=second')).json()).busy, true);
    assert.equal((await (await request('/api/state')).json()).busy, false);
    assert.equal(runtimes.get('default').player.volume, 81);
    assert.equal(runtimes.get('second').player.volume, 40);
  } finally { release.resolve(); }
  assert.equal((await slow).status, 200);
  assert.equal(runtimes.get('second').player.queue[0].id, 'slow-song');
  assert.equal(runtimes.get('default').player.queue.length, 0);
  assert.equal(calls.some((call) => ['removeBot', 'retryBot'].includes(call.action)), false);
  assert.deepEqual(leases, ['start:second', 'start:default', 'end:default', 'end:second']);
});

test('previous control is routed to its explicit bot and keeps the other bot untouched', async (t) => {
  const { request, runtimes, calls } = await fixture(t);
  const original = structuredClone(runtimes.get('default').player.snapshot());
  assert.equal((await request('/api/control', { botId: 'second', action: 'previous' })).status, 200);
  assert.deepEqual(calls, [{ id: 'second', action: 'previous', value: undefined }]);
  assert.deepEqual(runtimes.get('default').player.snapshot(), original);
});

test('whole hot-chart shortcuts honor source and remaining capacity and report actual imports', async (t) => {
  const { request, music, runtimes } = await fixture(t);
  const original = structuredClone(runtimes.get('default').player.snapshot());
  const player = runtimes.get('second').player; const requests = [];
  music.hot = async (limit, source) => {
    requests.push({ limit, source });
    return { mode: 'hot', name: `${source} hot`, tracks: Array.from({ length: Math.min(limit, source === 'qq' ? 300 : 200) }, (_, i) => ({ id: String(i + 1), name: `Song ${i}`, artists: 'Artist', source })) };
  };
  let response = await request('/api/hot', { botId: 'second', source: 'qq', full: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).added, 300);
  assert.equal(player.queue.length, 300); assert.ok(player.queue.every((track) => track.source === 'qq'));
  response = await request('/api/hot', { botId: 'second', source: 'netease', full: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).added, 199);
  assert.equal(player.capacity(), 0); assert.equal(player.queue.length, 499);
  assert.deepEqual(requests, [{ limit: 499, source: 'qq' }, { limit: 199, source: 'netease' }]);
  assert.equal((await request('/api/hot', { botId: 'second', source: 'qq', full: true })).status, 400);
  assert.equal(requests.length, 2);
  assert.deepEqual(runtimes.get('default').player.snapshot(), original);
});

test('hot shortcut options reject malformed full flags and preserve the existing default size', async (t) => {
  const { request, music } = await fixture(t); const limits = [];
  music.hot = async (limit) => { limits.push(limit); return { mode: 'hot', name: 'Hot', tracks: [{ id: '1', name: 'Song', artists: 'Artist' }] }; };
  for (const full of ['true', 1, null, {}]) assert.equal((await request('/api/hot', { botId: 'second', source: 'netease', full })).status, 400);
  assert.equal(limits.length, 0);
  const response = await request('/api/hot', { botId: 'second', source: 'netease' });
  assert.equal(response.status, 200); assert.equal((await response.json()).added, 1); assert.deepEqual(limits, [30]);
});

test('catalog caches are isolated and retries invalidate only the selected bot catalog', async (t) => {
  const { request, calls, runtimes } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const primary = await (await request('/api/catalog')).json();
    const second = await (await request('/api/catalog?botId=second')).json();
    assert.equal(primary.guilds[0].id, 'guild-default'); assert.equal(second.guilds[0].id, 'guild-second');
    assert.equal(second.guilds[0].channels[1].id, 'voice-second');
    assert.equal(JSON.stringify(second).includes('secret-second-token'), false);
  }
  assert.equal(calls.filter((call) => call.route === 'guild/view').length, 2);
  assert.equal((await request('/api/channel', { botId: 'second', guildId: 'guild-default', voiceChannelId: 'voice-default' })).status, 400);
  const oldAPI = runtimes.get('second').api.request;
  runtimes.get('second').api.request = async (route, params) => route === 'guild/view' ? { name: 'Updated Guild' } : oldAPI(route, params);
  assert.equal((await request('/api/bots/retry', { botId: 'second' })).status, 200);
  const refreshed = await (await request('/api/catalog?botId=second')).json();
  assert.equal(refreshed.guilds[0].name, 'Updated Guild');
  await request('/api/catalog');
  assert.equal(calls.filter((call) => call.id === 'default' && call.route === 'guild/view').length, 1);
});

test('unknown and malformed bot IDs cannot fall back to the default bot', async (t) => {
  const { request, calls } = await fixture(t);
  for (const id of ['missing', '', '../default']) {
    assert.equal((await request(`/api/state?botId=${encodeURIComponent(id)}`)).status, 400);
    assert.equal((await request(`/api/catalog?botId=${encodeURIComponent(id)}`)).status, 400);
  }
  for (const id of ['missing', '', null, 42, {}, '../default']) {
    for (const route of ['/api/control', '/api/bots/remove', '/api/bots/retry']) {
      assert.equal((await request(route, { botId: id, action: 'stop' })).status, 400);
    }
  }
  assert.equal(calls.length, 0);
});

test('failed bot state is displayable and token-free while healthy bots remain usable', async (t) => {
  const { request, runtimes } = await fixture(t);
  const failed = runtimes.get('second'); failed.player = null; failed.api = null; failed.gateway = null;
  failed.status = 'error'; failed.error = 'Login rejected for secret-second-token';
  const response = await request('/api/state?botId=second'); const raw = await response.text(); const state = JSON.parse(raw);
  assert.equal(response.status, 200); assert.equal(state.player.disabled, true); assert.equal(state.player.status, 'unavailable');
  assert.equal(state.bot.status, 'error'); assert.equal(state.bot.online, false); assert.deepEqual(state.player.queue, []);
  assert.equal(raw.includes('secret-second-token'), false); assert.equal(raw.includes('secret-default-token'), false);
  assert.equal((await request('/api/control', { botId: 'second', action: 'resume' })).status, 400);
  assert.equal((await request('/api/catalog?botId=second')).status, 400);
  assert.equal((await request('/api/control', { action: 'volume', value: 55 })).status, 200);
});

test('bot management preserves CSRF protection and exposes only public descriptors', async (t) => {
  const { request, auth } = await fixture(t);
  assert.equal((await request('/api/bots', undefined, {})).status, 401);
  assert.equal((await request('/api/bots/add', { token: 'secret-third-token' }, { ...auth, 'X-CSRF-Token': '' })).status, 403);
  const created = await request('/api/bots/add', { token: 'secret-third-token', name: 'Third Bot', guildIds: ['guild-third'] });
  const text = await created.text(); const body = JSON.parse(text);
  assert.equal(created.status, 200); assert.equal(body.bot.id, 'third'); assert.equal(body.bots.length, 3);
  assert.equal(text.includes('secret-third-token'), false); assert.equal(text.includes('"config"'), false); assert.equal(text.includes('"token"'), false);
  const rejected = await request('/api/bots/add', { token: 'rejected-secret' }); const error = await rejected.text();
  assert.equal(rejected.status, 400); assert.equal(error.includes('rejected-secret'), false);
  assert.equal((await request('/api/bots/remove', { botId: 'default' })).status, 400);
  assert.equal((await request('/api/bots/remove', { botId: 'third' })).status, 200);
  assert.equal((await request('/api/state?botId=third')).status, 400);
  const listed = await (await request('/api/bots')).json();
  assert.equal(listed.defaultBotId, 'default'); assert.deepEqual(listed.bots.map((bot) => bot.id), ['default', 'second']);
});

test('shared account mutations are serialized separately from playback', async (t) => {
  const { request, music } = await fixture(t);
  const entered = deferred(); const release = deferred(); const events = [];
  music.forSource = () => ({
    async qrStatus() { entered.resolve(); await release.promise; events.push('checked'); return { status: 'success' }; },
    async logout() { events.push('logout'); },
  });
  const status = request('/api/account/qr?source=qq'); await entered.promise;
  const logout = request('/api/account/logout', { source: 'qq' });
  try {
    assert.equal((await request('/api/control', { botId: 'second', action: 'volume', value: 61 })).status, 200);
    assert.deepEqual(events, []);
  } finally { release.resolve(); }
  assert.equal((await status).status, 200); assert.equal((await logout).status, 200);
  assert.deepEqual(events, ['checked', 'logout']);
});
