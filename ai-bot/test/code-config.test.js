import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDuetConfig } from '../src/duet-config.js';
const env = { KOOK_BOT_A_TOKEN: 'fixture-token-a', KOOK_BOT_B_TOKEN: 'fixture-token-b', KOOK_CHANNEL_ID: '123456789', OPENAI_API_KEY: 'fixture-model-key' };
test('repository execution is opt-in and requires explicit operator identities', () => {
  assert.equal(loadDuetConfig(env).codeEnabled, false);
  assert.throws(() => loadDuetConfig({ ...env, CODE_AGENT_ENABLED: 'true' }), /操作者/);
  assert.throws(() => loadDuetConfig({ ...env, CODE_AGENT_ENABLED: 'true', CODE_AGENT_OPERATOR_IDS: 'not-an-id' }), /操作者/);
  const config = loadDuetConfig({ ...env, CODE_AGENT_ENABLED: 'true', CODE_AGENT_OPERATOR_IDS: '12345678,23456789' });
  assert.deepEqual(config.codeOperators, ['12345678', '23456789']);
  assert.equal(config.codeSocket, '/run/kook-code-agent/broker.sock');
});
