import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { Audio } from '../src/audio.js';

test('real FFmpeg sends timed Opus RTP with the granted SSRC and payload type', {
  skip: !process.env.TEST_FFMPEG_PATH, timeout: 15000,
}, async (t) => {
  const frames = 48000 * 2;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 4000), 44 + i * 2);
  const server = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const udp = dgram.createSocket('udp4'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const packets = []; udp.on('message', (packet) => { if ((packet[1] & 127) === 111) packets.push(packet); });
  let handle;
  t.after(async () => { await handle?.stop(); udp.close(); server.close(); server.closeAllConnections(); });
  const started = Date.now();
  const ended = new Promise((resolve, reject) => {
    handle = new Audio(process.env.TEST_FFMPEG_PATH).start(`http://127.0.0.1:${server.address().port}/tone.wav`, {
      ip: '127.0.0.1', port: udp.address().port, rtcp_mux: true, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111,
    }, 60, 0, (error) => error ? reject(error) : resolve());
  });
  if (process.platform === 'linux') {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 3000;
    while (packets.length < 5 && Date.now() < deadline) await wait(20);
    assert.ok(packets.length >= 5, 'Audio must start before pausing');
    handle.pause();
    await wait(150);
    const pausedPackets = packets.length;
    await wait(350);
    assert.equal(packets.length, pausedPackets, 'Paused process must stop sending audio');
    handle.resume();
  }
  await ended;
  assert.ok(packets.length > 50, `Expected audio RTP, received ${packets.length}`);
  assert.equal(packets[0][0] >> 6, 2); assert.equal(packets[0].readUInt32BE(8), 1111);
  assert.ok(packets.every((packet) => packet.length <= 1200));
  assert.ok(Date.now() - started >= 1500, 'Audio must be paced, not sent in a burst');
  assert.ok(handle.seconds > 1.5, 'FFmpeg progress must be parsed');
});
