import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { BroadcastImageRenderer } from '../src/broadcast-image.js';

const input = resolve(process.argv[2] || 'data/broadcast-cards-live-snapshot.json');
const output = resolve(process.argv[3] || 'output/broadcast-glass');
const snapshot = JSON.parse(await readFile(input, 'utf8'));
snapshot.accounts = (snapshot.accounts || []).filter(account => account.platform === 'openai');
// createRequire also supports the desktop runtime's optional NODE_PATH libraries.
const sharp = createRequire(import.meta.url)('sharp');
const renderer = new BroadcastImageRenderer({ renderPng: async svg => {
  const render = () => sharp(svg, { limitInputPixels: 32_000_000 });
  const options = { compressionLevel: 9, adaptiveFiltering: true };
  const fullColor = await render().png(options).toBuffer();
  return fullColor.length <= 4 * 1024 * 1024 ? fullColor : render().png({ ...options, palette: true, colours: 256, effort: 10, dither: .25 }).toBuffer();
} });
const result = await renderer.render(snapshot, { dashboardUrl: process.env.PUBLIC_URL || 'https://quota.example.com/quota/' });
await mkdir(output, { recursive: true });
for (const image of result.images) {
  const path = join(output, 'openai-glass-overview.png');
  await writeFile(path, image.buffer);
  console.log(JSON.stringify({ path, width: image.width, height: image.height, bytes: image.buffer.length }));
}
