import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import dgram from 'node:dgram';
import { Audio } from '../src/audio.js';
import { PersistentAudio } from '../src/audio-session.js';

const ffmpeg = process.env.TEST_FFMPEG_PATH;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, message) => {
  const deadline = Date.now() + 10000;
  while (!condition() && Date.now() < deadline) await wait(20);
  assert.ok(condition(), message);
};
const wav = (frames, frequency = 440) => {
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i * frequency * 2 * Math.PI / 48000) * 4000), 44 + i * 2);
  return data;
};
async function setup(t, capture = false) {
  const tones = { '/first.wav': wav(48000 * 4), '/second.wav': wav(54321, 880) };
  const server = http.createServer((req, res) => {
    const data = tones[req.url];
    if (!data) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length }); res.end(data);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const udp = dgram.createSocket('udp4'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const packets = []; const ports = new Set(); const encoded = []; let senderSpawns = 0; let writtenSamples = 0;
  udp.on('message', (packet, info) => { if ((packet[1] & 127) === 111) { packets.push(packet); ports.add(info.port); } });
  const audio = new Audio(ffmpeg, { spawnImpl(executable, args, options) {
    senderSpawns++;
    const copy = [...args];
    if (capture) copy[copy.length - 1] += '|[select=a:f=ogg]pipe:4';
    const child = spawn(executable, copy, { ...options, stdio: [...options.stdio, ...(capture ? ['pipe'] : [])] });
    if (capture) child.stdio[4].on('data', (chunk) => encoded.push(chunk));
    const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = (chunk, ...rest) => { writtenSamples += chunk.length / 8; return write(chunk, ...rest); };
    return child;
  } });
  const session = new PersistentAudio(ffmpeg, { audio });
  t.after(async () => { await session.disconnect(); udp.close(); server.close(); server.closeAllConnections(); });
  const voice = { ip: '127.0.0.1', port: udp.address().port, rtcp_mux: true, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111 };
  const url = (name) => `http://127.0.0.1:${server.address().port}/${name}.wav`;
  return { session, voice, url, packets, ports, encoded, get spawns() { return senderSpawns; }, time: () => writtenSamples / 48000 };
}

async function decode(encoded, t) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pcm = []; child.stdout.on('data', (chunk) => pcm.push(chunk)); child.stderr.resume(); child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
  const closed = once(child, 'close'); child.stdin.end(Buffer.concat(encoded));
  const [code] = await closed; clearTimeout(timer); assert.equal(code, 0);
  return Buffer.concat(pcm);
}

test('persistent PCM sender keeps RTP continuous through pause, volume, stop and new songs', {
  skip: !ffmpeg, timeout: 25000,
}, async (t) => {
  const fixture = await setup(t, true); const { session, voice, url, packets, ports, encoded, time } = fixture;
  await session.connect(voice, 100); assert.equal(session.connected, true);
  const sender = session.sender; const pid = sender.child.pid; let firstEnd = 0;
  const firstStart = time();
  const first = session.start(url('first'), voice, 100, 0, () => { firstEnd++; });
  await until(() => first.seconds >= 0.7, 'First song starts');
  first.pause(); const frozen = first.seconds; const pausedAt = time(); const pausedPackets = packets.length;
  await wait(400);
  assert.equal(first.seconds, frozen); assert.ok(packets.length > pausedPackets + 10, 'Pause keeps RTP alive');
  assert.ok(first.bufferedBytes + first.child.stdout.readableLength < 512 * 1024, 'Paused decoder buffer stays bounded');
  await first.setVolume(20);
  const resumedAt = time(); first.resume();
  await until(() => first.seconds >= 1.4, 'Same decoder resumes');
  const stoppedAt = time(); await first.stop();
  assert.equal(firstEnd, 0); assert.equal(session.connected, true); assert.equal(session.sender, sender);
  await wait(250); assert.equal(first.seconds >= 1.4, true);
  await session.setVolume(80);
  const secondStart = time(); let secondResult = 'pending';
  const second = session.start(url('second'), voice, 80, 0, (error) => { secondResult = error; });
  await until(() => secondResult !== 'pending', 'Second song drains decoded PCM before completion');
  assert.equal(secondResult, null); assert.ok(Math.abs(second.seconds - 54321 / 48000) < 0.0001, `Drained seconds: ${second.seconds}`);
  await wait(250);
  assert.equal(session.connected, true); assert.equal(session.sender.child.pid, pid);
  assert.equal(fixture.spawns, 1); assert.equal(ports.size, 1); assert.ok(packets.length > 150);
  for (let i = 1; i < packets.length; i++) {
    assert.equal((packets[i].readUInt16BE(2) - packets[i - 1].readUInt16BE(2) + 65536) % 65536, 1);
    assert.equal((packets[i].readUInt32BE(4) - packets[i - 1].readUInt32BE(4)) >>> 0, 960);
  }
  const reportedSeconds = session.sender.seconds;
  await session.disconnect();
  const pcm = await decode(encoded, t);
  t.diagnostic(JSON.stringify({ firstStart, pausedAt, resumedAt, stoppedAt, secondStart, writtenSeconds: time(), reportedSeconds, decodedSeconds: pcm.length / 4 / 48000 }));
  const rms = (from, to) => {
    let sum = 0; let samples = 0;
    for (let i = Math.ceil(from * 48000); i < Math.floor(to * 48000); i++) {
      const sample = pcm.readFloatLE(i * 4); sum += sample * sample; samples++;
    }
    return Math.sqrt(sum / samples);
  };
  const baseline = rms(pausedAt - 0.4, pausedAt - 0.1);
  const quiet = rms(resumedAt + 0.25, stoppedAt - 0.05);
  const raised = rms(secondStart + 0.3, secondStart + 0.8);
  assert.ok(pausedAt - firstStart >= 0.7);
  assert.ok(rms(pausedAt + 0.15, resumedAt - 0.1) < baseline * 0.01, 'Paused PCM is silence');
  assert.ok(Math.abs(quiet / baseline - 0.2) < 0.035, `20% gain ratio: ${quiet / baseline}`);
  assert.ok(Math.abs(raised / baseline - 0.8) < 0.035, `80% gain ratio: ${raised / baseline}`);
});

test('transport failure reports one source error and disconnect reaps both processes', {
  skip: !ffmpeg, timeout: 15000,
}, async (t) => {
  const { session, voice, url } = await setup(t);
  await session.connect(voice, 60);
  const errors = []; const source = session.start(url('first'), voice, 60, 7, (error) => errors.push(error));
  session.sender.child.kill('SIGTERM');
  await until(() => errors.length > 0, 'Transport failure reaches current source');
  assert.equal(errors.length, 1); assert.ok(errors[0] instanceof Error); assert.equal(session.connected, false);
  assert.equal(source.seconds, 7); await session.disconnect();
  assert.ok(source.child.exitCode !== null || source.child.signalCode !== null); assert.equal(session.pendingStops.size, 0);
});
