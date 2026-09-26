import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function boundedFile(file, max) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('Invalid menu asset');
  const buffer = await readFile(file);
  if (buffer.byteLength > max) throw new Error('Invalid menu asset');
  return buffer;
}
export async function loadMenu(assetDir) {
  const manifest = JSON.parse((await boundedFile(path.join(assetDir, 'menu.json'), 16384)).toString('utf8'));
  if (typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > 100
    || !Array.isArray(manifest.pages) || manifest.pages.length < 1 || manifest.pages.length > 8) throw new Error('Invalid menu manifest');
  const pages = [], seen = new Set();
  for (const page of manifest.pages) {
    if (!page || typeof page.file !== 'string' || !/^page-[1-8]\.png$/.test(page.file) || seen.has(page.file)
      || typeof page.title !== 'string' || !page.title.trim() || page.title.length > 100
      || typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error('Invalid menu page');
    seen.add(page.file);
    const buffer = await boundedFile(path.join(assetDir, page.file), 4 * 1024 * 1024);
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE) || buffer.readUInt32BE(8) !== 13
      || buffer.toString('ascii', 12, 16) !== 'IHDR' || createHash('sha256').update(buffer).digest('hex') !== page.sha256) throw new Error('Menu asset verification failed');
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!Number.isInteger(page.width) || !Number.isInteger(page.height) || page.width !== width || page.height !== height
      || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 64000000) throw new Error('Invalid menu image dimensions');
    pages.push({ buffer, width, height, title: page.title });
  }
  return { title: manifest.title, pages };
}
