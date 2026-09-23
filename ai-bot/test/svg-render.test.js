import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderSvgPng, staticSvg } from '../src/svg-render.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#ff0000"/><circle cx="50" cy="25" r="10" fill="#0000ff"/></svg>';

test('real Sharp renders static shapes to a PNG with preserved aspect ratio and expected colors', async () => {
  const png = await renderSvgPng(svg), metadata = await sharp(png).metadata();
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width / metadata.height, 2);
  assert.ok(metadata.width <= 1600 && metadata.height <= 1600);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [255, 0, 0]);
  const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  assert.deepEqual([...data.subarray(center, center + 3)], [0, 0, 255]);
});

test('large valid SVG is resized to 1600 with aspect ratio preserved', async () => {
  const input = svg.replace('width="100" height="50"', 'width="1800" height="900" viewBox="0 0 100 50"');
  const metadata = await sharp(await renderSvgPng(input)).metadata();
  assert.equal(metadata.width, 1600); assert.equal(metadata.height, 800);
});

test('scripts, external resources, entities and namespaces are rejected before invoking Sharp', async () => {
  let calls = 0;
  for (const input of ['<svg><script>alert(1)</script></svg>', '<svg><image href="https://private.test/a.png"/></svg>',
    '<svg><use href="#x" xml:base="file:///private"/></svg>', '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg>&x;</svg>', '<svg><g></svg>',
    '<svg><style>@import "https://private.test/x.css";</style></svg>', 'x'.repeat(32001)]) {
    await assert.rejects(renderSvgPng(input, { sharpImpl: () => { calls++; } }), { code: 'SVG_INVALID_INPUT' });
  }
  assert.equal(calls, 0); assert.equal(staticSvg(`<svg><rect/></svg><svg></svg>`), null);
});

test('excessive input dimensions fail without disclosing raw SVG details', async () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><text>private-marker</text></svg>';
  await assert.rejects(renderSvgPng(input), error => {
    assert.equal(error.code, 'SVG_RENDER_FAILED'); assert.doesNotMatch(error.stack, /private-marker/); return true;
  });
});

test('render hard timeout and caller cancellation destroy stalled pipelines', async () => {
  let destroyed = 0, options;
  const pipeline = { resize() { return this; }, png() { return this; }, timeout() { return this; },
    toBuffer() { return new Promise(() => {}); }, destroy() { destroyed++; } };
  const sharpImpl = (_buffer, config) => { options = config; return pipeline; };
  await assert.rejects(renderSvgPng(svg, { sharpImpl, timeoutMs: 10 }), { code: 'SVG_TIMEOUT' });
  assert.equal(options.limitInputPixels, 16000000); assert.equal(options.density, 144); assert.equal(destroyed, 1);
  const controller = new AbortController(), promise = renderSvgPng(svg, { sharpImpl, signal: controller.signal });
  controller.abort(); await assert.rejects(promise, { code: 'SVG_ABORTED' }); assert.equal(destroyed, 2);
});

test('renderer bounds output bytes and dimensions independently of decoder claims', async () => {
  for (const result of [{ data: Buffer.alloc(4 * 1024 * 1024 + 1), info: { width: 1, height: 1 } },
    { data: Buffer.from('not a png'), info: { width: 1, height: 1 } }]) {
    const pipeline = { resize() { return this; }, png() { return this; }, timeout() { return this; },
      async toBuffer() { return result; }, destroy() {} };
    await assert.rejects(renderSvgPng(svg, { sharpImpl: () => pipeline }), { code: 'SVG_OUTPUT_LIMIT' });
  }
});
