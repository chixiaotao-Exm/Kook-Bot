import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
const env = { KOOK_TOKEN: 'fixture-token', OPENAI_API_KEY: 'sk-fixture-secret-key', KOOK_CHANNEL_ID: '123456789' };
test('defaults preserve requested model and bind health locally', () => {
  const config = loadConfig(env);
  assert.equal(config.model, 'gpt-6-astra'); assert.equal(config.host, '127.0.0.1');
  assert.equal(config.timeoutMs, 180000); assert.equal(config.port, 18999);
  assert.equal(config.reasoningEffort, 'low'); assert.equal(config.maxOutputTokens, 8192);
  assert.ok(!config.systemPrompt.includes(env.OPENAI_API_KEY));
});
test('invalid configuration is rejected without echoing secrets', () => {
  for (const changes of [{ KOOK_TOKEN: '' }, { OPENAI_API_KEY: '' }, { HOST: '0.0.0.0' }, { KOOK_CHANNEL_ID: 'bad' }, { PORT: 'NaN' }, { MAX_OUTPUT_TOKENS: '999999' }, { MODEL_TIMEOUT_SECONDS: '0' }, { OPENAI_MODEL: 'bad\nmodel' }, { REASONING_EFFORT: 'invalid' }]) {
    assert.throws(() => loadConfig({ ...env, ...changes }), error => !error.message.includes(env.OPENAI_API_KEY));
  }
});
