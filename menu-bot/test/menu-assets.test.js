import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMenu } from '../src/menu-assets.js';
import { loadConfig } from '../src/config.js';

const assetDir = fileURLToPath(new URL('../assets/', import.meta.url));
test('the eight reviewed Chinese menu pages match their declared hashes and sizes', async () => {
  const menu = await loadMenu(assetDir);
  assert.equal(menu.pages.length, 8); assert.match(menu.title, /中文菜单/);
  assert.ok(menu.pages.every(page => page.width === 1183 && page.height === 1530 && page.buffer.length < 4 * 1024 * 1024));
});
test('asset metadata cannot read paths outside its configured folder or accept corrupted bytes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kook-menu-assets-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(path.join(assetDir, 'menu.json'), 'utf8'));
  const manifest = { ...original, pages: [original.pages[0]] };
  await writeFile(path.join(dir, 'menu.json'), JSON.stringify({ ...manifest, pages: [{ ...manifest.pages[0], file: '../page-1.png' }] }));
  await assert.rejects(loadMenu(dir), /Invalid menu page/);
  await writeFile(path.join(dir, 'menu.json'), JSON.stringify(manifest));
  const buffer = Buffer.from((await loadMenu(assetDir)).pages[0].buffer); buffer[100] ^= 1;
  await writeFile(path.join(dir, 'page-1.png'), buffer); await assert.rejects(loadMenu(dir), /verification failed/);
});
test('configuration requires a token and explicit channel allowlist and stays on loopback', () => {
  const env = { KOOK_TOKEN: 'fixture-only-token', KOOK_CHANNEL_IDS: '9000000000000103' };
  const value = loadConfig(env); assert.equal(value.host, '127.0.0.1'); assert.equal(value.port, 18995); assert.deepEqual(value.channelIds, ['9000000000000103']);
  assert.throws(() => loadConfig({ ...env, HOST: '0.0.0.0' }));
  assert.throws(() => loadConfig({ ...env, KOOK_CHANNEL_IDS: '' }));
  assert.throws(() => loadConfig({ ...env, KOOK_TOKEN: 'invalid\nvalue' }));
});
