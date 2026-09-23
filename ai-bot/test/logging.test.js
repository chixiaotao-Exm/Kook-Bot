import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLog } from '../src/index.js';

test('runtime logs preserve safe failure details and omit private payloads', t => {
  const lines = []; t.mock.method(console, 'info', line => lines.push(JSON.parse(line)));
  safeLog({ event: 'model_failed', code: 'TIMEOUT', durationMs: 180000, message: 'private prompt', token: 'private token' });
  assert.equal(lines[0].code, 'TIMEOUT'); assert.equal(lines[0].durationMs, 180000);
  assert.equal(JSON.stringify(lines).includes('private'), false);
  safeLog({ event: 'model_failed', code: 'private token', durationMs: 'private prompt' });
  assert.equal(lines[1].code, 'UNKNOWN'); assert.equal(lines[1].durationMs, 0);
  safeLog('kook_gateway_connected'); assert.equal(lines[2].event, 'kook_gateway_connected');
  safeLog({ event: 'invalid\nevent', code: 'TIMEOUT' }); assert.equal(lines.length, 3);
});
