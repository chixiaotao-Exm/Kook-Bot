import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import dgram from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Audio } from '../src/audio.js';
import { PersistentAudio } from '../src/audio-session.js';
import { Player } from '../src/player.js';
import { readConfig } from '../src/config.js';

const ffmpeg = process.env.TEST_FFMPEG_PATH;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await wait(20);
  assert.ok(condition(), message);
}

async function setup(t) {
  const frames = 48000 * 24; const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 4000), 44 + i * 2);
  const oldBytes = 44 + 48000 * 2 * 8;
  const requests = []; const pcmFrames = []; let oldExpired = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const range = /^bytes=(\d+)-/.exec(req.headers.range || ''); const begin = range ? Number(range[1]) : 0;
    requests.push({ pathname, begin });
    if (pathname === '/old.wav' && oldExpired) { res.writeHead(410); res.end(); return; }
    if (begin >= wav.length) { res.writeHead(416); res.end(); return; }
    const headers = { 'Content-Type': 'audio/wav', 'Content-Length': wav.length - begin, 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${begin}-${wav.length - 1}/${wav.length}`;
    res.writeHead(range ? 206 : 200, headers);
    if (pathname === '/old.wav') {
      res.write(wav.subarray(begin, Math.max(begin, oldBytes)));
    } else res.end(wav.subarray(begin));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const udp = dgram.createSocket('udp4'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const packets = []; const ports = new Set();
  udp.on('message', (packet, info) => {
    if ((packet[1] & 127) === 111) { packets.push(packet); ports.add(info.port); }
  });
  const audio = new Audio(ffmpeg, { spawnImpl(executable, args, options) {
    const child = spawn(executable, args, options); const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = (chunk, ...rest) => {
      pcmFrames.push({ at: Date.now(), audible: chunk.some((value) => value !== 0) });
      return write(chunk, ...rest);
    };
    return child;
  } });
  const session = new PersistentAudio(ffmpeg, { audio });
  t.after(async () => { await session.disconnect(); server.closeAllConnections(); server.close(); udp.close(); });
  const voice = { ip: '127.0.0.1', port: udp.address().port, rtcp_mux: true, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111 };
  const media = (name) => `http://127.0.0.1:${server.address().port}/${name}.wav`;
  return { session, voice, media, pcmFrames, packets, ports, requests, invalidateOld() { oldExpired = true; } };
}

test('Player refreshes paused media and plays beyond 15 seconds without changing the RTP connection', {
  skip: !ffmpeg, timeout: 35000,
}, async (t) => {
  const { session, voice, media, pcmFrames, ports, requests, packets, invalidateOld } = await setup(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kook-pause-network-'));
  const config = readConfig({ KOOK_TOKEN: 'test', ALLOWED_GUILD_IDS: 'g1', DATA_DIR: dataDir, STAY_CONNECTED: 'true' });
  const calls = []; let mediaLookups = 0;
  const api = { async post(route) { calls.push(route); return voice; } };
  const music = { async stream() { mediaLookups++; return media(mediaLookups === 1 ? 'old' : 'fresh'); } };
  const player = new Player(config, api, music, session, async () => {});
  t.after(async () => {
    await player.shutdown();
    assert.equal(path.dirname(dataDir), tmpdir()); assert.ok(path.basename(dataDir).startsWith('kook-pause-network-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  await player.add({ guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1' }, [{ id: '1', name: 'Tone', artists: 'Test', durationMs: 24000 }]);
  const senderPid = session.sender.child.pid; const old = player.stream;
  await until(() => old.seconds >= 0.6, 'Initial audio starts');
  await player.control('pause'); const saved = player.snapshot().seconds; const pausedPackets = packets.length;
  invalidateOld();
  await wait(800);
  assert.equal(player.snapshot().seconds, saved); assert.ok(packets.length > pausedPackets + 20);
  assert.equal(session.sender.child.pid, senderPid);
  await player.control('resume'); const fresh = player.stream;
  assert.notEqual(fresh, old, 'Pause-expired decoder is replaced');
  assert.equal(mediaLookups, 2, 'Resume resolves a fresh media URL');
  assert.equal(fresh.startOffset, saved, 'New decoder seeks to the saved position');
  await until(() => fresh.seconds >= saved + 0.2, 'Fresh decoder starts at the saved position');
  const steadyAt = Date.now();
  await until(() => fresh.seconds >= saved + 16, 'Fresh media plays for more than 15 seconds', 21000);
  const steadyFrames = pcmFrames.filter((frame) => frame.at >= steadyAt);
  assert.ok(steadyFrames.length > 750 && steadyFrames.every((frame) => frame.audible));
  assert.equal(session.sender.child.pid, senderPid); assert.equal(session.connected, true); assert.equal(ports.size, 1);
  assert.ok(requests.some((request) => request.pathname === '/fresh.wav'));
  assert.equal(calls.filter((route) => route === 'voice/join').length, 1);
  assert.equal(calls.filter((route) => route === 'voice/leave').length, 0);
  assert.equal(player.stream, fresh); assert.equal(player.snapshot().status, 'playing');
  t.diagnostic(JSON.stringify({ savedPosition: saved, resumedPosition: fresh.seconds, steadyAudibleFrames: steadyFrames.length, sameRtpSender: true }));
});
