import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('startup requires an explicit account binding when the upstream query key is configured', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quota-startup-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const entry = new URL('../src/index.js', import.meta.url).href;
  for (const accountId of [undefined, '']) {
    const env = {
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      PATH: process.env.PATH || '',
      DATA_DIR: dataDir,
      SUB2API_ADMIN_KEY: 'startup-admin-fixture',
      ARK717_QUERY_KEY: 'startup-query-fixture',
    };
    if (accountId !== undefined) env.ARK717_ACCOUNT_ID = accountId;
    // A regression must never reach a real upstream or start the server.
    const script = `globalThis.fetch = () => { process.stderr.write('UNEXPECTED_FETCH'); process.exit(92); };
      await import(${JSON.stringify(entry)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /必须指定小鸡毛对应的 sub2api 账号 ID/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_FETCH|startup-query-fixture|startup-admin-fixture/);
  }
});
