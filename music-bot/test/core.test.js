import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfig } from '../src/config.js';
import { Kook } from '../src/kook.js';
import { Gateway, SequenceBuffer } from '../src/gateway.js';
import { Music } from '../src/music.js';
import { Player } from '../src/player.js';
import { Bot, parseCommand } from '../src/bot.js';
import { audioArgs } from '../src/audio.js';
import { musicId, validateMediaUrl, AuthRequiredError, UserError, UnavailableError } from '../src/util.js';

const song = (id) => ({ id: String(id), name: `Song ${id}`, artists: 'Artist', durationMs: 180000 });
const context = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' };
const voice = { ip: '127.0.0.1', port: '5004', rtcp_mux: true, bitrate: 48000, audio_ssrc: '1111', audio_pt: '111' };

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-bot-test-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1,g2', DATA_DIR: dir });
  const calls = []; const handles = []; const messages = [];
  const api = { async post(endpoint, params) { calls.push({ endpoint, params }); return voice; } };
  const music = { async stream(track) { return `https://m801.music.126.net/${track.id}.mp3`; } };
  const audio = { start(url, params, volume, offset, onEnd) {
    const handle = { url, params, volume, offset, onEnd, paused: false, seconds: offset,
      async stop() { this.stopped = true; }, async setVolume(value) { this.volume = value; }, pause() { this.paused = true; }, resume() { this.paused = false; } };
    handles.push(handle); return handle;
  } };
  const player = new Player(config, api, music, audio, async (_, message) => messages.push(message));
  t.after(async () => {
    await player.shutdown();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('kook-bot-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { player, config, api, music, audio, calls, handles, messages, dir };
}

test('configuration requires token and guild allowlist', () => {
  assert.throws(() => readConfig({}), /KOOK_TOKEN/);
  assert.throws(() => readConfig({ DEFAULT_VOLUME: '101' }, { requireToken: false }), /DEFAULT_VOLUME/);
  assert.deepEqual([...readConfig({ ALLOWED_GUILD_IDS: ' a, b ' }, { requireToken: false }).guilds], ['a', 'b']);
});
test('Chinese and English commands preserve full song names', () => {
  assert.deepEqual(parseCommand('/点歌 富士山下 陈奕迅'), { action: 'play', value: '富士山下 陈奕迅' });
  assert.deepEqual(parseCommand('!PLAY 123', '!'), { action: 'play', value: '123' });
  assert.equal(parseCommand('普通聊天'), null);
});
test('ID parser supports full and hash links without accepting foreign URLs', () => {
  assert.equal(musicId('https://music.163.com/#/song?id=66285'), '66285');
  assert.equal(musicId('https://y.music.163.com/m/song?id=66285'), '66285');
  assert.equal(musicId('https://music.163.com/playlist?id=123', 'playlist'), '123');
  assert.equal(musicId('https://evil.test/song?id=123'), null);
  assert.equal(musicId('https://music.163.com/playlist?id=123'), null);
  assert.equal(musicId('123; touch /tmp/a'), null);
});
test('media URLs accept NetEase hosts and reject file, credentials and hostname tricks', () => {
  assert.equal(validateMediaUrl('https://m801.music.126.net/a.mp3'), 'https://m801.music.126.net/a.mp3');
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/a', 'https://music.126.net.evil.test/a', 'https://x:y@music.126.net/a']) assert.throws(() => validateMediaUrl(url));
});
test('gateway delivers in sequence and discards duplicate packets', () => {
  const delivered = []; const buffer = new SequenceBuffer((x) => delivered.push(x));
  buffer.push(2, 'two'); assert.equal(buffer.sn, 0);
  buffer.push(1, 'one'); buffer.push(2, 'duplicate');
  assert.deepEqual(delivered, ['one', 'two']); assert.equal(buffer.sn, 2);
  buffer.reset(); assert.equal(buffer.sn, 0); assert.equal(buffer.pending.size, 0);
});
test('gateway does not acknowledge an event rejected by the inbox', () => {
  const buffer = new SequenceBuffer(() => false);
  assert.throws(() => buffer.push(1, {}), /inbox/); assert.equal(buffer.sn, 0);
});
test('gateway enforces bounded sequence gaps', () => {
  assert.throws(() => new SequenceBuffer(() => {}).push(1001, {}), /overflow/);
});
test('gateway resumes with last accepted sequence and clears state on RECONNECT', async (t) => {
  class Socket extends EventEmitter {
    static instances = [];
    constructor(url) { super(); this.url = url; this.readyState = 1; Socket.instances.push(this); }
    terminate() { this.readyState = 3; this.emit('close'); }
    send() {}
  }
  const gateway = new Gateway({ request: async () => ({ url: 'wss://gateway.example/?compress=0' }) }, () => true, { Socket });
  t.after(() => gateway.stop());
  gateway.stopped = false; await gateway.connect();
  const first = Socket.instances[0]; first.emit('open');
  first.emit('message', Buffer.from(JSON.stringify({ s: 1, d: { code: 0, session_id: 'abc' } })));
  first.emit('message', Buffer.from(JSON.stringify({ s: 0, sn: 1, d: {} })));
  first.terminate(); gateway.clearTimers(); await gateway.connect();
  const second = Socket.instances[1];
  assert.equal(second.url.searchParams.get('resume'), '1');
  assert.equal(second.url.searchParams.get('sn'), '1');
  assert.equal(second.url.searchParams.get('session_id'), 'abc');
  second.emit('message', Buffer.from(JSON.stringify({ s: 5 })));
  assert.equal(gateway.session, ''); assert.equal(gateway.sequence.sn, 0);
});
test('KOOK handles rate limits without losing request body or auth', async () => {
  const requests = []; const waits = []; let clock = 0;
  const api = new Kook('private-token', {
    now: () => clock, sleepImpl: async (ms) => { waits.push(ms); clock += ms; }, fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) :
        Response.json({ code: 0, data: { ok: true } });
    },
  });
  assert.deepEqual(await api.post('voice/join', { channel_id: 'v1' }), { ok: true });
  assert.deepEqual(waits, [2000]); assert.equal(requests[1].options.headers.Authorization, 'Bot private-token');
  assert.equal(requests[1].options.body, '{"channel_id":"v1"}');
});
test('KOOK respects official reset header and preemptively pauses an exhausted bucket', async () => {
  let clock = 0; let count = 0; const waits = [];
  const api = new Kook('test', {
    now: () => clock, sleepImpl: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async () => Response.json({ code: 0, data: {} }, { headers: ++count === 1 ? {
      'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '14', 'x-rate-limit-bucket': 'voice',
    } : {} }),
  });
  await api.post('voice/join', {}); await api.post('voice/join', {});
  assert.deepEqual(waits, [14000]);
});
test('KOOK errors omit secrets and raw upstream messages', async () => {
  const api = new Kook('secret', { fetchImpl: async () => Response.json({ code: 401, message: 'secret' }, { status: 401 }) });
  await assert.rejects(api.request('user/me'), (error) => !error.message.includes('secret') && error.message.includes('401'));
});
test('replies use plain text cards, protecting against mentions in song titles', async () => {
  const api = new Kook('test'); let request;
  api.post = async (_, value) => { request = value; };
  await api.reply('t1', '(met)all(met)', 'm1');
  assert.equal(request.reply_msg_id, 'm1');
  assert.equal(JSON.parse(request.content)[0].modules[0].text.type, 'plain-text');
});
test('FFmpeg uses granted bitrate, muxed RTCP, SSRC, payload type and input pacing', () => {
  const args = audioArgs('https://music.126.net/a.mp3', voice, 60, 12.5);
  assert.ok(args.indexOf('-re') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-b:a') + 1], '48000');
  assert.equal(args[args.indexOf('-vbr') + 1], 'off');
  assert.match(args.at(-1), /ssrc=1111:payload_type=111/);
  assert.match(args.at(-1), /rtcpport=5004/);
  assert.equal(args[args.indexOf('-ss') + 1], '12.500');
  assert.throws(() => audioArgs('url', { ...voice, ip: '127.0.0.1;bad' }, 50));
});
test('FFmpeg supports a separately granted RTCP port', () => {
  assert.match(audioArgs('url', { ...voice, rtcp_mux: false, rtcp_port: 5005 }, 50).at(-1), /rtcpport=5005/);
});
test('music skips previews and never enables unblock sources', async () => {
  let params;
  const music = new Music({ cookie: 'private-cookie' }, { song_url_v1: async (p) => {
    params = p; return { body: { code: 200, data: [{ id: 1, url: 'https://music.126.net/a', freeTrialInfo: { end: 30 } }] } };
  } });
  await assert.rejects(music.stream(song(1)), UnavailableError);
  assert.equal(params.unblock, 'false');
});
test('music permits complete audio and blocks non-NetEase URLs', async () => {
  let url = 'https://music.126.net/a';
  const music = new Music({ cookie: '' }, { song_url_v1: async () => ({ body: { code: 200, data: [{ id: 1, url, freeTrialInfo: null }] } }) });
  music.cookie = async () => '';
  assert.equal(await music.stream(song(1)), url);
  url = 'http://localhost/secret'; await assert.rejects(music.stream(song(1)), /允许列表/);
});
test('new tracks reuse the voice connection and concurrent point requests remain ordered', async (t) => {
  const { player, calls, handles } = await fixture(t);
  await Promise.all([player.add(context, [song(1)]), player.add(context, [song(2)])]);
  assert.equal(player.current.id, '1'); assert.equal(player.queue[0].id, '2');
  handles[0].onEnd(null); await player.tail;
  assert.equal(player.current.id, '2'); assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
  assert.equal(calls.find((x) => x.endpoint === 'voice/join').params.rtcp_mux, false);
});
test('late close from a skipped process cannot advance the new track', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1), song(2), song(3)]);
  await player.control('skip'); handles[0].onEnd(null); await player.tail;
  assert.equal(player.current.id, '2'); assert.equal(player.queue[0].id, '3');
});
test('unavailable tracks are skipped but transient failures preserve the queue', async (t) => {
  const { player, music } = await fixture(t);
  music.stream = async (track) => {
    if (track.id === '1') throw new UnavailableError('Preview');
    throw new UserError('Network temporarily unavailable');
  };
  await player.add(context, [song(1), song(2), song(3)]);
  await new Promise((resolve) => setTimeout(resolve, 10)); await player.tail;
  assert.equal(player.current.id, '2'); assert.deepEqual(player.queue.map((x) => x.id), ['3']);
  assert.equal(player.snapshot().status, 'recovering');
});

test('provider login expiry pauses the current track, preserves progress and asks for re-login', async (t) => {
  const { player, music, messages } = await fixture(t);
  const qishui = { ...song(1), source: 'qishui' };
  music.stream = async () => { throw new AuthRequiredError('汽水音乐账号登录已失效，请重新扫码登录。'); };
  await player.add(context, [qishui, song(2)]);
  await new Promise((resolve) => setTimeout(resolve, 10)); await player.tail;
  assert.equal(player.current.id, '1'); assert.equal(player.snapshot().status, 'paused');
  assert.equal(player.queue[0].id, '2'); assert.equal(player.snapshot().seconds, 0);
  assert.match(messages.at(-1), /重新登录/); assert.match(messages.at(-1), /继续/);
});
test('a long unavailable playlist yields to a stop request between songs', async (t) => {
  const { player, music } = await fixture(t); let attempts = 0;
  music.stream = async () => { attempts++; throw new UnavailableError('No full audio'); };
  await player.add(context, Array.from({ length: 20 }, (_, i) => song(i + 1)));
  await player.control('stop');
  assert.equal(attempts, 1); assert.equal(player.context, null); assert.equal(player.queue.length, 0);
});
test('volume changes retain the process, RTP source and measured position', async (t) => {
  const { player, handles, calls } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 32;
  await player.control('volume', 40);
  assert.equal(handles.length, 1); assert.equal(handles[0].stopped, undefined);
  assert.equal(handles[0].volume, 40); assert.equal(player.snapshot().seconds, 32);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
  await player.control('pause'); await player.control('volume', 25);
  assert.equal(handles.length, 1); assert.equal(handles[0].stopped, true);
  assert.equal(player.stream, null); assert.equal(player.snapshot().status, 'paused');
  await player.control('resume');
  assert.equal(handles.length, 2); assert.equal(handles[1].volume, 25);
  assert.equal(handles[1].paused, false); assert.equal(handles[1].seconds, 32);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
  assert.equal(player.current.id, '1');
});
test('failed volume acknowledgement does not stop playback or lose progress', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 62;
  handles[0].setVolume = async () => { throw new UserError('No acknowledgement'); };
  await assert.rejects(player.control('volume', 30), /acknowledgement/);
  assert.equal(player.stream, handles[0]); assert.equal(handles[0].stopped, undefined);
  assert.equal(player.current.id, '1'); assert.equal(player.snapshot().seconds, 62);
  await player.control('pause'); await player.control('resume');
  assert.equal(player.stream, handles[1]); assert.equal(handles[1].paused, false);
  assert.equal(handles[1].offset, 62);
});

test('resident connection survives pause, resume, seek and next without another join', async (t) => {
  const { player, audio, handles, calls } = await fixture(t);
  let connects = 0; let disconnects = 0;
  audio.connected = false;
  audio.connect = async () => { connects++; audio.connected = true; };
  audio.disconnect = async () => { disconnects++; audio.connected = false; };
  await player.join(context);
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 52;
  await player.control('pause'); await player.control('resume');
  assert.equal(player.stream, handles[1]); assert.equal(player.snapshot().seconds, 52);
  assert.equal(handles[0].stopped, true);
  await player.control('seek', 90);
  assert.equal(handles[1].stopped, true); assert.equal(handles[2].offset, 90);
  await player.control('skip');
  assert.equal(player.current.id, '2'); assert.equal(connects, 1); assert.equal(disconnects, 0);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
  await player.control('stop'); assert.equal(disconnects, 1);
});

test('a long pause closes the old media connection and refreshes the URL at the exact saved position', async (t) => {
  const { player, audio, music, handles, calls } = await fixture(t);
  let mediaRequests = 0;
  music.stream = async (track) => `https://music.126.net/${track.id}.mp3?source=${++mediaRequests}`;
  audio.connected = false;
  audio.connect = async () => { audio.connected = true; };
  audio.disconnect = async () => { audio.connected = false; };
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 52.48;
  await player.control('pause');
  assert.equal(handles[0].stopped, true); assert.equal(audio.connected, true);
  assert.equal(player.stream, null); assert.equal(player.intent, 'paused');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(56 * 60 * 1000);
  assert.equal(player.snapshot().seconds, 52.48);
  await player.control('resume');
  assert.equal(mediaRequests, 2); assert.notEqual(handles[1].url, handles[0].url);
  assert.equal(handles[1].offset, 52.48); assert.equal(player.queue[0].id, '2');
  assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 1);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
});

test('a lost RTP sender is replaced at the saved position', async (t) => {
  const { player, audio, handles, calls } = await fixture(t);
  let connects = 0;
  audio.connected = false;
  audio.connect = async () => { connects++; audio.connected = true; };
  audio.disconnect = async () => { audio.connected = false; };
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 63;
  audio.connected = false;
  await player.exclusive(() => player.maintainVoice());
  assert.equal(connects, 2); assert.equal(handles[0].stopped, true);
  assert.equal(handles[1].offset, 63); assert.equal(player.current.id, '1');
  assert.equal(player.queue[0].id, '2'); assert.equal(player.snapshot().status, 'playing');
  assert.equal(calls.filter((x) => x.endpoint === 'voice/join').length, 2);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 1);
});

test('failed sender startup releases the voice allocation and preserves recovery state', async (t) => {
  const { player, audio, calls } = await fixture(t);
  audio.connect = async () => { throw new UserError('Sender unavailable'); };
  await player.add(context, [song(1), song(2)]);
  assert.equal(player.voiceJoined, false); assert.equal(player.voiceConnection, null);
  assert.equal(player.current.id, '1'); assert.equal(player.queue[0].id, '2');
  assert.equal(player.snapshot().status, 'recovering');
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 1);
});

test('resident retry survives sender loss and exhausted music recovery', async (t) => {
  const { player, audio, music } = await fixture(t);
  player.stayConnected = true;
  audio.connect = async () => { audio.connected = true; };
  audio.disconnect = async () => { audio.connected = false; };
  await player.add(context, [song(1)]);
  audio.connected = false; player.retryCount = 5;
  music.stream = async () => { throw new UserError('Offline'); };
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.intent, 'idle'); assert.equal(player.voiceJoined, false);
  assert.equal(player.keepalive._destroyed, false);
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.voiceJoined, true); assert.equal(player.stream, null);
});

test('resident retry stays armed after sender startup fails', async (t) => {
  const { player, audio } = await fixture(t);
  player.stayConnected = true; player.context = context; player.startKeepalive();
  audio.connect = async () => { throw new UserError('Sender unavailable'); };
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.voiceJoined, false); assert.equal(player.keepalive._destroyed, false);
});
test('stop cancels playback, clears queue and releases voice resource', async (t) => {
  const { player, calls, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]); await player.control('stop');
  assert.equal(handles[0].stopped, true); assert.equal(player.context, null);
  assert.equal(player.queue.length, 0); assert.equal(calls.at(-1).endpoint, 'voice/leave');
});
test('single-track loop repeats normal completion but skip overrides it', async (t) => {
  const { player, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]); await player.control('loop', 'one');
  handles[0].onEnd(null); await player.tail; assert.equal(player.current.id, '1');
  await player.control('skip'); assert.equal(player.current.id, '2');
});
test('capacity and cross-channel requests are rejected without changing queue', async (t) => {
  const { player, config } = await fixture(t); config.maxQueue = 2;
  await player.add(context, [song(1), song(2)]);
  await assert.rejects(player.add(context, [song(3)]), /最多容纳/);
  await assert.rejects(player.add({ ...context, voiceChannelId: 'v2' }, [song(3)]), /另一个语音频道/);
  assert.deepEqual(player.queue.map((x) => x.id), ['2']);
});
test('shutdown persists position and playing intent, then restart restores the same song', async (t) => {
  const { player, config, api, music, audio, dir, handles } = await fixture(t);
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 48.5; await player.shutdown();
  const saved = JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.current.id, '1'); assert.equal(saved.queue[0].id, '2');
  assert.equal(saved.positionSeconds, 48.5); assert.equal(saved.intent, 'playing');
  const restored = new Player(config, api, music, audio, async () => {});
  await restored.restore();
  assert.equal(restored.current.id, '1'); assert.equal(restored.snapshot().seconds, 48.5);
  await restored.resumeAfterRestart(); assert.equal(handles.at(-1).offset, 48.5);
  assert.deepEqual(restored.queue.map((x) => x.id), ['2']); await restored.shutdown();
});
test('paused progress survives restart without automatic playback', async (t) => {
  const { player, config, api, music, audio, handles } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 24;
  await player.control('pause'); await player.shutdown();
  const restored = new Player(config, api, music, audio, async () => {});
  await restored.restore(); await restored.resumeAfterRestart();
  assert.equal(restored.stream, null); assert.equal(restored.snapshot().status, 'paused');
  assert.equal(restored.snapshot().seconds, 24);
  await restored.control('resume'); assert.equal(handles.at(-1).offset, 24); await restored.shutdown();
});
test('legacy queue files migrate without inventing a saved position', async (t) => {
  const { player, dir } = await fixture(t);
  await writeFile(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, context, current: song(1), queue: [song(2)] }));
  await player.restore();
  assert.equal(player.current.id, '1'); assert.equal(player.snapshot().seconds, 0);
  assert.equal(player.snapshot().status, 'ready');
  assert.deepEqual(player.queue.map((x) => x.id), ['2']);
});
test('stream failure retains the checkpoint and retries the same song', async (t) => {
  const { player, handles, dir } = await fixture(t);
  await player.add(context, [song(1), song(2)]); handles[0].seconds = 75;
  handles[0].onEnd(new UserError('Network')); await player.tail;
  assert.equal(player.current.id, '1'); assert.equal(player.snapshot().seconds, 75);
  assert.equal(player.queue[0].id, '2'); assert.equal(player.snapshot().status, 'recovering');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8')).positionSeconds, 75);
  await player.control('resume'); assert.equal(handles.at(-1).offset, 75);
});
test('transient voice health errors do not halt an audible stream', async (t) => {
  const { player, api, handles, calls } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 19;
  api.request = async () => { throw new UserError('Query timeout'); };
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.stream, handles[0]); assert.equal(handles[0].stopped, undefined);
  assert.equal(calls.filter((x) => x.endpoint === 'voice/leave').length, 0);
});
test('failed keep-alive still checks membership and reconnects at the last position', async (t) => {
  const { player, api, handles } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 37;
  const post = api.post.bind(api);
  api.post = async (route, params) => { if (route === 'voice/keep-alive') throw new UserError('No membership'); return post(route, params); };
  api.request = async () => ({ items: [] });
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.current.id, '1'); assert.equal(handles.at(-1).offset, 37);
  assert.equal(player.snapshot().status, 'playing');
});
test('membership recovery cannot reset an exhausted retry budget', async (t) => {
  const { player, api, music, handles } = await fixture(t);
  await player.add(context, [song(1)]); handles[0].seconds = 45;
  player.retryCount = 5; api.request = async () => ({ items: [] });
  music.stream = async () => { throw new UserError('Offline'); };
  await player.exclusive(() => player.maintainVoice());
  assert.equal(player.retryCount, 6); assert.equal(player.intent, 'idle');
  assert.equal(player.current.id, '1'); assert.equal(player.snapshot().seconds, 45);
});
test('checkpoint saves progress even while a network operation holds the player lock', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { player, handles, dir } = await fixture(t);
  await player.add(context, [song(1)]);
  let release;
  const blocked = player.exclusive(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  try {
    handles[0].seconds = 81;
    t.mock.timers.tick(5000); await player.persistTail;
    assert.equal(JSON.parse(await readFile(path.join(dir, 'queue.json'), 'utf8')).positionSeconds, 81);
  } finally { release(); await blocked; }
});
test('queued-only playing state resumes after a restart between unavailable songs', async (t) => {
  const { player, dir } = await fixture(t);
  await writeFile(path.join(dir, 'queue.json'), JSON.stringify({ version: 2, context, current: null, queue: [song(2)], intent: 'playing' }));
  await player.restore(); await player.resumeAfterRestart();
  assert.equal(player.current.id, '2'); assert.equal(player.snapshot().status, 'playing');
});
test('bot filters messages from bots, other guilds and disallowed text channels', () => {
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', ALLOWED_TEXT_CHANNEL_IDS: 't1' });
  const bot = new Bot(config, {}, {}, {}); let count = 0; bot.drain = async () => { count++; };
  const event = { msg_id: 'm1', author_id: 'u1', type: 1, channel_type: 'GROUP', target_id: 't1', content: '/点歌 1', extra: { guild_id: 'g1' } };
  bot.accept({ ...event, extra: { guild_id: 'g1', author: { bot: true } } });
  bot.accept({ ...event, extra: { guild_id: 'g2' } }); bot.accept({ ...event, target_id: 't2' });
  assert.equal(count, 0); bot.accept(event); bot.accept(event); assert.equal(count, 1);
});
test('controls require same voice channel; configured admins may bypass within guild', async () => {
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', ADMIN_USER_IDS: 'admin' });
  const api = { request: async () => ({ items: [{ id: 'v2', type: 2 }] }) };
  const bot = new Bot(config, api, {}, { context });
  await assert.rejects(bot.voiceContext({ extra: { guild_id: 'g1' }, author_id: 'user' }, true), /机器人所在/);
  assert.deepEqual(await bot.voiceContext({ extra: { guild_id: 'g1' }, author_id: 'admin' }, true), context);
  await assert.rejects(bot.voiceContext({ extra: { guild_id: 'g2' }, author_id: 'admin' }, true), /另一个服务器/);
});
