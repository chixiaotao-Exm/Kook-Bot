import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BroadcastScheduler } from '../src/broadcast.js';
import { QuotaServer } from '../src/server.js';
import { createKookImageSender } from '../src/kook-image-sender.js';

const imageId = 'a'.repeat(64);
const buffer = Buffer.alloc(64); Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer); buffer.writeUInt32BE(13,8); buffer.write('IHDR',12); buffer.writeUInt32BE(1000,16); buffer.writeUInt32BE(1600,20);
const image = { id: imageId, buffer, mimeType: 'image/png', width: 1000, height: 1600, alt: 'OpenAI 图片示例 第1张' };
const snapshot = { accounts: [{ id: '1', name: 'Image test account', platform: 'openai', metrics: [], schedulable: true }], updatedAt: '2026-09-22T01:00:00Z' };

async function fixture(t, { publicAccess = true, fail = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota-image-http-'));
  let now = Date.parse('2026-09-22T00:59:00Z'), renders = 0;
  const requests = [];
  const imageRenderer = { async render() { renders++; if (fail) throw new Error('PRIVATE_KEY'); return { images: [image], accountCount: 1, generatedAt: new Date(now).toISOString() }; }, getImage: id => id === imageId ? image : null };
  const send = createKookImageSender({ token: 'fixture-bot', channelId: '9000000000000104', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.endsWith('asset/create') ? { code: 0, data: { url: 'https://img.kookapp.cn/assets/fixture.png' } } : { code: 0, data: { msg_id: 'fixture-image-message' } });
  } });
  const scheduler = new BroadcastScheduler({ dataDir: dir, getSnapshot: () => snapshot, imageRenderer, send, now: () => now }); await scheduler.init();
  const server = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080', publicAccess,
    dashboard: { snapshot: () => snapshot }, scheduler });
  const address = await server.start(), base = `http://127.0.0.1:${address.port}/quota/api`;
  t.after(async () => { await server.close(); await scheduler.close(); await rm(dir, { recursive: true, force: true }); });
  return { scheduler, base, requests, advance(ms) { now += ms; }, renders: () => renders };
}

test('anonymous image previews contain only metadata and same-origin PNG URLs, never upload or post messages', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/report-preview'), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.format, 'image'); assert.equal(result.images[0].url, `./api/report-images/${imageId}.png`);
  assert.equal(JSON.stringify(result).includes('buffer'), false); assert.equal(f.requests.length, 0);
  const png = await fetch(f.base + `/report-images/${imageId}.png`);
  assert.equal(png.headers.get('content-type'), 'image/png'); assert.equal(png.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), buffer);
  assert.equal((await fetch(f.base + `/report-images/${'b'.repeat(64)}.png`)).status, 404);
  assert.equal((await fetch(f.base + '/report-images/file.env')).status, 404);
  assert.equal((await fetch(f.base + `/report-images/${imageId}.png`, { method: 'POST' })).status, 405);
  assert.equal(f.renders(), 1);
});

test('private mode protects both image preview metadata and PNG routes', async t => {
  const f = await fixture(t, { publicAccess: false });
  assert.equal((await fetch(f.base + '/report-preview')).status, 401);
  assert.equal((await fetch(f.base + `/report-images/${imageId}.png`)).status, 401);
  assert.equal(f.renders(), 0);
});

test('scheduled image broadcasts upload then deliver one message while duplicate ticks and preview never resend', async t => {
  const f = await fixture(t);
  await f.scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' });
  f.advance(60001); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]); await f.scheduler.tick();
  assert.equal(f.requests.length, 2); assert.ok(f.requests[0].url.endsWith('asset/create')); assert.ok(f.requests[1].url.endsWith('message/create'));
  const body = JSON.parse(f.requests[1].options.body), cards = JSON.parse(body.content);
  assert.equal(cards[0].modules[0].type, 'container'); assert.equal(cards[0].modules[0].elements[0].src, 'https://img.kookapp.cn/assets/fixture.png');
  assert.equal(cards[0].modules[0].elements.length, 1); assert.equal(cards[0].modules[0].elements[0].alt, 'OpenAI 额度播报 · 高清总览');
  assert.equal(f.scheduler.snapshot().history[0].status, 'sent');
  await f.scheduler.preview(); assert.equal(f.requests.length, 2);
});

test('render errors mark the slot failed without sending or exposing renderer internals', async t => {
  const f = await fixture(t, { fail: true });
  await f.scheduler.configure({ enabled: true, times: ['09:00'], timeZone: 'Asia/Shanghai' }); f.advance(60001);
  await f.scheduler.tick(); await f.scheduler.tick();
  const last = f.scheduler.snapshot().history[0]; assert.equal(last.status, 'failed'); assert.match(last.error, /图片生成失败/);
  assert.equal(JSON.stringify(last).includes('PRIVATE_KEY'), false); assert.equal(f.requests.length, 0);
});
