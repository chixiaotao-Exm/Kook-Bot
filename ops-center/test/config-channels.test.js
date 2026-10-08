import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';
import { OPS_CHANNELS } from './fixtures/channels.js';

const raw = { hosts: [], monitors: [] };
const env = () => ({ KOOK_TOKEN: 'fixture-token', KOOK_INFRA_CHANNEL_ID: OPS_CHANNELS.infra, KOOK_WEB_CHANNEL_ID: OPS_CHANNELS.web });

test('KOOK notifications require two private configured destinations, with no production defaults', () => {
  const local = validateConfig(raw, {});
  assert.deepEqual(local.channelIds, { infra: '', web: '' });
  assert.equal(local.publicUrl, 'https://example.com/ops/');
  for (const patch of [{ KOOK_INFRA_CHANNEL_ID: '' }, { KOOK_WEB_CHANNEL_ID: '' },
    { KOOK_INFRA_CHANNEL_ID: 'invalid' }, { KOOK_WEB_CHANNEL_ID: OPS_CHANNELS.infra },
    { KOOK_INFRA_CHANNEL_ID: 123456 }]) {
    assert.throws(() => validateConfig(raw, { ...env(), ...patch }), /KOOK channel configuration/);
  }
  assert.throws(() => validateConfig(raw, { KOOK_TOKEN: 'fixture-token' }), /KOOK channel configuration/);
});

test('configured channels are trimmed, captured and immutable', () => {
  const values = env(); values.KOOK_INFRA_CHANNEL_ID = ` ${values.KOOK_INFRA_CHANNEL_ID} `;
  const config = validateConfig(raw, values);
  values.KOOK_INFRA_CHANNEL_ID = '3333333333333333';
  assert.deepEqual(config.channelIds, OPS_CHANNELS);
  assert.equal(Object.isFrozen(config.channelIds), true);
  assert.throws(() => { config.channelIds.web = '3333333333333333'; }, TypeError);
});
