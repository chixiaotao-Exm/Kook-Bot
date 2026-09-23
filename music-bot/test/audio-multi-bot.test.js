import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';
import { PersistentAudio } from '../src/audio-session.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, message) {
  const deadline = Date.now() + 7000;
  while (!condition() && Date.now() < deadline) await wait(25);
  assert.ok(condition(), message);
}

test('two real bot transports keep independent sockets, progress and lifecycle', {
  skip: !process.env.TEST_FFMPEG_PATH, timeout: 20000,
}, async (t) => {
  const wav = Buffer.alloc(44 + 48000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(Math.sin((i - 44) / 2 * 440 * 2 * Math.PI / 48000) * 4000), i);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = [], sessions = [];
  t.after(async () => { await Promise.all(sessions.map((session) => session.disconnect())); sockets.forEach((socket) => socket.close()); server.close(); server.closeAllConnections(); });
  const fixture = async () => {
    const rtp = dgram.createSocket('udp4'), rtcp = dgram.createSocket('udp4');
    for (const socket of [rtp, rtcp]) { socket.bind(0, '127.0.0.1'); await once(socket, 'listening'); sockets.push(socket); }
    const packets = [], ports = new Set();
    rtp.on('message', (packet, info) => { if ((packet[1] & 127) === 111) { packets.push(packet); ports.add(info.port); } });
    const voice = { ip: '127.0.0.1', port: rtp.address().port, rtcp_port: rtcp.address().port,
      rtcp_mux: false, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111 };
    const session = new PersistentAudio(process.env.TEST_FFMPEG_PATH); sessions.push(session);
    return { session, voice, packets, ports };
  };
  const [a, b] = await Promise.all([fixture(), fixture()]);
  await Promise.all([a.session.connect(a.voice, 70), b.session.connect(b.voice, 45)]);
  const aPid = a.session.sender.child.pid, bPid = b.session.sender.child.pid;
  assert.notEqual(aPid, bPid);
  const endings = [];
  const url = `http://127.0.0.1:${server.address().port}/tone.wav`;
  const left = a.session.start(url, a.voice, 70, 0, (error) => endings.push(error));
  const right = b.session.start(url, b.voice, 45, 0, (error) => endings.push(error));
  await until(() => left.seconds > 0.6 && right.seconds > 0.6, 'Both bots play simultaneously');
  await left.stop(); const frozen = left.seconds, before = right.seconds;
  await a.session.setVolume(20);
  await until(() => right.seconds > before + 0.5, 'Other channel keeps progressing through pause and volume changes');
  assert.equal(left.seconds, frozen); assert.equal(b.session.volume, 45);
  assert.equal(a.session.sender.child.pid, aPid); assert.equal(b.session.sender.child.pid, bPid);
  assert.equal(a.ports.size, 1); assert.equal(b.ports.size, 1);
  assert.notEqual([...a.ports][0], [...b.ports][0], 'Bot RTP source sockets must be distinct');
  await a.session.disconnect(); const packetsBefore = b.packets.length, secondsBefore = right.seconds;
  await until(() => b.packets.length > packetsBefore + 20 && right.seconds > secondsBefore + 0.4, 'Removing one bot keeps the other sender alive');
  assert.equal(b.session.sender.child.pid, bPid); assert.deepEqual(endings, []);
  for (let i = 1; i < b.packets.length; i++) {
    assert.equal((b.packets[i].readUInt16BE(2) - b.packets[i - 1].readUInt16BE(2) + 65536) % 65536, 1);
    assert.equal((b.packets[i].readUInt32BE(4) - b.packets[i - 1].readUInt32BE(4)) >>> 0, 960);
  }
});
