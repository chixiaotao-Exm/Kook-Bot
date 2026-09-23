import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { Audio } from '../src/audio.js';

test('separate KOOK RTP and RTCP ports bind audio to the actual RTP source', {
  skip: !process.env.TEST_FFMPEG_PATH, timeout: 10000,
}, async (t) => {
  const rtp = dgram.createSocket('udp4'); const rtcp = dgram.createSocket('udp4');
  rtp.bind(0, '127.0.0.1'); await once(rtp, 'listening');
  rtcp.bind(0, '127.0.0.1'); await once(rtcp, 'listening');
  const received = []; let binding = null; let rejected = 0;
  const observe = (destination) => (packet, info) => {
    const control = packet[1] >= 200 && packet[1] <= 211;
    received.push({ destination, control, packet, source: info.port });
    if (destination === 'rtp') {
      binding ??= info.port;
      if (binding !== info.port) rejected++;
    }
  };
  rtp.on('message', observe('rtp')); rtcp.on('message', observe('rtcp'));
  let sender; let pump; const errors = [];
  t.after(async () => { clearInterval(pump); await sender?.stop(); rtp.close(); rtcp.close(); });
  sender = new Audio(process.env.TEST_FFMPEG_PATH).startPcm({
    ip: '127.0.0.1', port: rtp.address().port, rtcp_port: rtcp.address().port,
    rtcp_mux: false, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111,
  }, 60, (error) => { if (error) errors.push(error); });
  const frame = Buffer.alloc(7680);
  pump = setInterval(() => { if (!sender.input.destroyed) sender.input.write(frame); }, 20);
  const deadline = Date.now() + 3000;
  while ((received.filter((item) => !item.control).length < 20 || !received.some((item) => item.control)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  clearInterval(pump); await sender.stop();
  const audio = received.filter((item) => item.destination === 'rtp');
  const control = received.filter((item) => item.destination === 'rtcp');
  assert.ok(audio.length >= 20); assert.ok(control.length >= 1);
  assert.ok(audio.every((item) => !item.control), 'RTP endpoint must never bind to an initial RTCP packet');
  assert.ok(control.every((item) => item.control), 'RTCP uses its separately granted endpoint');
  assert.equal(rejected, 0); assert.equal(new Set(audio.map((item) => item.source)).size, 1);
  assert.equal(binding, audio[0].source); assert.deepEqual(errors, []);
  for (const { packet } of audio) {
    assert.equal(packet[0] >> 6, 2); assert.equal(packet[1] & 127, 111); assert.equal(packet.readUInt32BE(8), 1111);
  }
  assert.ok(control.some(({ packet }) => packet[1] === 200 && packet.readUInt32BE(4) === 1111));
});
