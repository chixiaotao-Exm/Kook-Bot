import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
const valid = { GITHUB_REPOSITORY: 'chixiaotao-Exm/Kook-Bot', GITHUB_WEBHOOK_SECRET: 'a'.repeat(64), KOOK_TOKEN: 'fixture-only', KOOK_CHANNEL_ID: '7887470271136485' };
test('configuration keeps listener local and requires explicit repository, secret and destination', () => {
  assert.equal(loadConfig(valid).port, 18997);
  for (const patch of [{ HOST:'0.0.0.0' }, { PORT:'123abc' }, { GITHUB_REPOSITORY:'../repo' }, { GITHUB_REPOSITORY:'a/b/c' },
    { GITHUB_WEBHOOK_SECRET:'short' }, { KOOK_TOKEN:'bad\ntoken' }, { KOOK_CHANNEL_ID:'channel' }]) assert.throws(() => loadConfig({ ...valid, ...patch }));
});
