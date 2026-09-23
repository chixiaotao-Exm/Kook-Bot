import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFailureMessage, sanitizeFailureCode, sanitizeDurationMs } from '../src/failure.js';

test('error codes come from an explicit allowlist and cannot reflect secrets', () => {
  for (const code of ['TIMEOUT', 'EMPTY_RESPONSE', 'AUTH', 'RATE_LIMIT', 'NETWORK', 'UPSTREAM_ERROR',
    'MODEL_MISMATCH', 'FORMAT', 'RESPONSE_LIMIT', 'REFUSAL', 'INPUT_LIMIT', 'INVALID_INPUT', 'REDIRECT',
    'CONFIG', 'CANCELLED', 'UNKNOWN', 'KOOK_REJECTED', 'KOOK_TIMEOUT']) assert.equal(sanitizeFailureCode(code), code);
  for (const code of [null, undefined, 42, {}, '__proto__', 'constructor', 'sk-fixture_secret_private', 'KOOK_sk_fixture']) {
    assert.equal(sanitizeFailureCode(code), 'UNKNOWN');
    assert.equal(modelFailureMessage(code), 'AI 暂时无法回复，请稍后再试。');
  }
});

test('duration fields are finite nonnegative rounded and bounded numbers', () => {
  assert.equal(sanitizeDurationMs(123.45), 123);
  assert.equal(sanitizeDurationMs(Number.MAX_VALUE), 86_400_000);
  for (const value of [null, 'secret', Infinity, -5, NaN, {}, undefined]) assert.equal(sanitizeDurationMs(value), 0);
});

test('timeout, no output, and rate limit have distinct actionable messages', () => {
  assert.match(modelFailureMessage('TIMEOUT'), /超时.*拆短/);
  assert.match(modelFailureMessage('EMPTY_RESPONSE'), /没有生成.*简短版本/);
  assert.match(modelFailureMessage('RATE_LIMIT'), /频率限制.*稍后/);
  assert.match(modelFailureMessage('INPUT_LIMIT'), /\/重置/);
});
