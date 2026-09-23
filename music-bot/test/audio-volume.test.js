import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import http from 'node:http';
import dgram from 'node:dgram';
import { Audio } from '../src/audio.js';

const voice = { ip: '127.0.0.1', port: 5004, rtcp_mux: true, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111 };

function fixture(t, options = {}) {
  const child = new EventEmitter(); const writes = []; const signals = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) { writes.push(chunk.toString()); callback(); } });
  child.kill = (signal) => { signals.push(signal); queueMicrotask(() => child.emit('close', 0)); return true; };
  const handle = new Audio('fake', { spawnImpl: () => child, ...options }).start('https://music.126.net/test', voice, 60, 0, () => {});
  t.after(() => handle.stop());
  return { child, handle, writes, signals };
}

test('live volume serializes commands and waits for complete FFmpeg acknowledgements', async (t) => {
  const { handle, child, writes, signals } = fixture(t);
  const first = handle.setVolume(20); const second = handle.setVolume(80);
  await Promise.resolve();
  assert.deepEqual(writes, ['cvolume@kookvolume -1 volume 0.20\n']);
  child.stderr.write('ignored media diagnostics\nCommand reply for stream 0: re');
  child.stderr.write('t:0 res:\n'); await first;
  await Promise.resolve();
  assert.deepEqual(writes, ['cvolume@kookvolume -1 volume 0.20\n', 'cvolume@kookvolume -1 volume 0.80\n']);
  child.stderr.write('Command reply for stream 0: ret:0 res:\n'); await second;
  assert.deepEqual(signals, []);
});

test('volume timeout leaves playback alive and rejects later commands despite late replies', async (t) => {
  const { handle, child, writes, signals } = fixture(t, { volumeTimeoutMs: 25 });
  await assert.rejects(handle.setVolume(20), /超时/);
  child.stderr.write('Command reply for stream 0: ret:0 res:\n');
  await assert.rejects(handle.setVolume(80), /超时/);
  assert.equal(writes.length, 1); assert.deepEqual(signals, []);
});

test('volume rejects invalid or paused requests without sending commands', async (t) => {
  const { handle, writes } = fixture(t);
  for (const value of [-1, 101, 20.5, '20']) await assert.rejects(handle.setVolume(value), /0-100/);
  handle.paused = true;
  await assert.rejects(handle.setVolume(20), /暂停/);
  handle.paused = false;
  assert.deepEqual(writes, []);
});

test('stop promptly rejects active and queued volume commands', async (t) => {
  const { handle, writes } = fixture(t);
  const first = assert.rejects(handle.setVolume(20), /停止/);
  const second = assert.rejects(handle.setVolume(80), /停止/);
  await Promise.resolve();
  await handle.stop(); await Promise.all([first, second]);
  assert.equal(writes.length, 1);
  await assert.rejects(handle.setVolume(50), /停止/);
});

test('FFmpeg command rejection and stdin errors do not terminate playback', async (t) => {
  const { handle, child, signals } = fixture(t);
  const rejected = assert.rejects(handle.setVolume(20), /不支持/);
  await Promise.resolve(); child.stderr.write('Command reply for stream 0: ret:-38 res:\n'); await rejected;
  const broken = assert.rejects(handle.setVolume(30), /关闭/);
  await Promise.resolve(); child.stdin.emit('error', new Error('EPIPE')); await broken;
  assert.deepEqual(signals, []);
});

test('real live volume changes PCM amplitude without changing RTP source or progress', {
  skip: !process.env.TEST_FFMPEG_PATH, timeout: 20000,
}, async (t) => {
  const frames = 48000 * 7; const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 4000), 44 + i * 2);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const udp = dgram.createSocket('udp4'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const packets = []; const sourcePorts = new Set(); const encoded = []; const progress = [];
  udp.on('message', (packet, info) => {
    if ((packet[1] & 127) === 111) { packets.push(packet); sourcePorts.add(info.port); }
  });
  let handle; let decoder; let decoderTimer; let spawns = 0;
  t.after(async () => {
    clearTimeout(decoderTimer); decoder?.kill('SIGKILL'); await handle?.stop();
    udp.close(); server.close(); server.closeAllConnections();
  });
  // Capture the exact encoded output alongside RTP so the gain can be measured after decoding.
  const audio = new Audio(process.env.TEST_FFMPEG_PATH, { spawnImpl(executable, args, options) {
    spawns++;
    const copy = [...args]; copy[copy.length - 1] += '|[select=a:f=ogg]pipe:3';
    const child = spawn(executable, copy, { ...options, stdio: [...options.stdio, 'pipe'] });
    child.stdio[3].on('data', (chunk) => encoded.push(chunk));
    return child;
  } });
  const ended = new Promise((resolve) => {
    handle = audio.start(`http://127.0.0.1:${server.address().port}/tone.wav`, { ...voice, port: udp.address().port }, 100, 0, resolve);
  });
  const pid = handle.child.pid;
  const waitUntil = async (seconds) => {
    const deadline = Date.now() + 9000;
    while (handle.seconds < seconds && Date.now() < deadline) {
      progress.push(handle.seconds);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(handle.seconds >= seconds, 'Audio progress must continue');
  };
  await waitUntil(1.5); await handle.setVolume(20);
  await waitUntil(3.5); await handle.setVolume(80);
  assert.equal(await ended, null);
  assert.equal(handle.child.pid, pid); assert.equal(spawns, 1); assert.equal(sourcePorts.size, 1);
  assert.ok(handle.seconds >= 6.9);
  assert.ok(progress.every((seconds, i) => i === 0 || seconds >= progress[i - 1]));
  assert.ok(packets.length > 300);
  for (let i = 1; i < packets.length; i++) {
    assert.equal((packets[i].readUInt16BE(2) - packets[i - 1].readUInt16BE(2) + 65536) % 65536, 1);
    assert.equal((packets[i].readUInt32BE(4) - packets[i - 1].readUInt32BE(4)) >>> 0, 960);
  }
  decoder = spawn(process.env.TEST_FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pcm = []; decoder.stdout.on('data', (chunk) => pcm.push(chunk)); decoder.stderr.resume();
  decoder.stdin.on('error', () => {});
  decoderTimer = setTimeout(() => decoder.kill('SIGKILL'), 5000);
  const decoded = once(decoder, 'close'); decoder.stdin.end(Buffer.concat(encoded));
  const [code] = await decoded; clearTimeout(decoderTimer); assert.equal(code, 0);
  const samples = Buffer.concat(pcm);
  const rms = (from, to) => {
    let sum = 0;
    for (let i = from * 48000; i < to * 48000; i++) { const sample = samples.readFloatLE(i * 4); sum += sample * sample; }
    return Math.sqrt(sum / ((to - from) * 48000));
  };
  assert.ok(samples.length >= 48000 * 6.9 * 4);
  const before = rms(0.5, 1); const reduced = rms(2.5, 3); const raised = rms(4.5, 6);
  assert.ok(Math.abs(reduced / before - 0.2) < 0.025, `Reduced gain ratio: ${reduced / before}`);
  assert.ok(Math.abs(raised / before - 0.8) < 0.025, `Raised gain ratio: ${raised / before}`);
});
