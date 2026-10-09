import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CATEGORY, FIELD, FORM_ID, ORIGIN } from '../src/protocol.mjs';
import { parseReporters, createReportersReader, formatReporter, reportersSnapshot } from '../src/reporters.js';

const settings = { email: 'receipts@gmail.com', language: 'english' };
const first = '76561198000000001\tReporter_1';
const second = '76561198000000002\tReporter_2';
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reporter-list-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('two-column Windows TXT accepts a BOM, header, whitespace, comments and duplicate lines', () => {
  const profiles = parseReporters(`\uFEFFSteamID64\tPUBG游戏昵称\r\n# private list\r\n\r\n${first}\r\n${second.replace('\t', '   ')}\r\n${first}\r\n`, settings);
  assert.deepEqual(profiles, [
    { ...settings, steam: '76561198000000001', nickname: 'Reporter_1', category: CATEGORY },
    { ...settings, steam: '76561198000000002', nickname: 'Reporter_2', category: CATEGORY }
  ]);
  assert.equal(parseReporters(first, { email: settings.email })[0].language, 'english');
  assert.equal(formatReporter(profiles[0]), first);
  assert.ok(Object.isFrozen(profiles) && Object.isFrozen(profiles[0]));
});

test('bad or conflicting rows and empty lists fail without exposing reporter data', () => {
  for (const text of ['', '# empty\nSteamID64\tPUBG游戏昵称', '123\tReporter_1', first + '\textra',
    first + '\n76561198000000001\tOtherName', first + '\ninvalid', first + '\0', 'x'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => parseReporters(text, settings), error => !error.message.includes(settings.email) && !error.message.includes('Reporter_1'));
  }
  assert.throws(() => parseReporters(first));
  assert.throws(() => parseReporters(first, { ...settings, email: 'invalid' }));
  assert.throws(() => parseReporters(first, { ...settings, language: 'bad language' }));
});

test('preview fingerprint binds the entire list and shared email/language, not only its count', () => {
  const original = reportersSnapshot(parseReporters(first, settings));
  assert.equal(reportersSnapshot(parseReporters(first + '\n' + first, settings)), original);
  for (const profiles of [parseReporters(second, settings), parseReporters(first, { ...settings, email: 'changed@gmail.com' }),
    parseReporters(first, { ...settings, language: 'korean' }), parseReporters(first.replace('Reporter_1', 'Changed'), settings)])
    assert.notEqual(reportersSnapshot(profiles), original);
});

test('reader reloads TXT, inherits fixed legacy settings and never falls back after invalid TXT', async t => {
  const dir = await directory(t), file = path.join(dir, 'reporters.txt'), legacyFile = path.join(dir, 'profile.json');
  await writeFile(legacyFile, JSON.stringify(parseReporters(first, settings)[0]));
  const read = createReportersReader({ file, legacyFile, allowLegacy: true });
  assert.equal((await read()).length, 1);
  await writeFile(file, first + '\n' + second); assert.equal((await read()).length, 2);
  await writeFile(file, ''); await assert.rejects(read(), /没有有效账号/);
  await rm(file); await assert.rejects(createReportersReader({ file, legacyFile })(), /无法读取/);
  await writeFile(file, second);
  const fixed = createReportersReader({ file, legacyFile, email: 'fixed@gmail.com', language: 'korean' });
  const [profile] = await fixed(); assert.equal(profile.email, 'fixed@gmail.com'); assert.equal(profile.language, 'korean');
  await rm(legacyFile); assert.equal((await fixed())[0].steam, '76561198000000002');
});

test('HAR importer appends two-column accounts while keeping the first fixed settings', async t => {
  const dir = await directory(t), file = path.join(dir, 'reporters.txt');
  const script = fileURLToPath(new URL('../src/import-profile.js', import.meta.url));
  const run = promisify(execFile);
  const env = { ...process.env, DATA_DIR: dir, REPORTERS_FILE: file, PUBG_REPORTER_EMAIL: '', PUBG_REPORTER_LANGUAGE: '' };
  const profiles = parseReporters(first + '\n' + second, settings);
  const harFiles = [];
  for (const [index, profile] of profiles.entries()) {
    const body = new URLSearchParams({ 'request[ticket_form_id]': FORM_ID });
    for (const [key, field] of Object.entries(FIELD)) body.set(field, index ? { ...profile, email: 'other@example.com', language: 'korean' }[key] : profile[key]);
    const harFile = path.join(dir, `account${index}.har`); harFiles.push(harFile);
    await writeFile(harFile, JSON.stringify({ log: { entries: [{ request: { method: 'POST', url: ORIGIN + '/hc/zh-cn/requests',
      postData: { mimeType: 'application/x-www-form-urlencoded', text: body.toString() } } }] } }));
  }
  await run(process.execPath, [script, harFiles[0]], { env });
  const defaults = await readFile(path.join(dir, 'profile.json'), 'utf8');
  const { stdout } = await run(process.execPath, [script, harFiles[1]], { env });
  assert.match(stdout, /2 个不同账号/);
  assert.equal(await readFile(path.join(dir, 'profile.json'), 'utf8'), defaults);
  assert.equal(await readFile(file, 'utf8'), first + '\n' + second + '\n');
  const read = createReportersReader({ file, legacyFile: path.join(dir, 'profile.json') });
  assert.deepEqual(await read(), profiles);
  const before = await readFile(file, 'utf8');
  await writeFile(harFiles[1], '{invalid');
  await assert.rejects(run(process.execPath, [script, harFiles[1]], { env }));
  assert.equal(await readFile(file, 'utf8'), before);
});
