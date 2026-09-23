import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPlan } from '../src/account-plan.js';
import { normalizeAccounts } from '../src/sub2api.js';

test('saved OpenAI subscription metadata displays confirmed tier without inferring multipliers', () => {
  for (const [plan_type, label] of [['prolite', 'Pro 5x'], ['team', 'Team'], ['self_serve_business_prolite', 'Team Pro'],
    ['plus', 'Plus'], ['pro', 'Pro'], ['chatgptpro', 'Pro'], ['enterprise', 'Enterprise'], ['free', 'Free']]) {
    const [account] = normalizeAccounts([{ id: 1, name: 'Unrelated title', platform: 'openai', type: 'oauth', credentials: { plan_type, access_token: 'private-access' } }]);
    assert.equal(account.planLabel, label); assert.equal(account.planSource, 'upstream');
    assert.ok(!JSON.stringify(account).includes('private-access'));
  }
  assert.equal(accountPlan({ platform: 'openai', type: 'oauth', extra: { codex_plan_type: 'prolite' } }).planLabel, 'Pro 5x');
  assert.equal(accountPlan({ platform: 'openai', type: 'oauth', credentials: { plan_type: 'plus' }, extra: { codex_plan_type: 'pro' } }).planLabel, 'Plus');
});

test('API billing is a connection type, and names/rate multipliers do not identify a subscription', () => {
  for (const platform of ['openai', 'deepseek', 'anthropic']) {
    assert.deepEqual(accountPlan({ platform, type: 'apikey', name: 'Pro 5x', credentials: { plan_type: 'pro' } }), { planLabel: 'API 计费', planSource: 'type' });
  }
  for (const raw of [null, {}, { platform: 'openai', type: 'oauth', name: 'OpenAI_5X', rate_multiplier: 5 },
    { platform: 'anthropic', type: 'oauth', name: 'Max 20x', extra: { quota_limit: 1000 } },
    { platform: 'openai', type: 'oauth', credentials: { plan_type: 'future-unverified-tier' } },
    { platform: 'openai', type: 'oauth', credentials: { plan_type: '__proto__' } },
    { platform: 'openai', type: 'oauth', credentials: { plan_type: 'sk-private_secret_value_123456789' } }]) {
    assert.deepEqual(accountPlan(raw), { planLabel: '版本未知', planSource: 'unknown' });
  }
});

test('platform labels stay separate and emit only fixed strings', () => {
  assert.deepEqual(accountPlan({ platform: 'grok', type: 'oauth', extra: { subscription_tier: 'supergrok_heavy' } }), { planLabel: 'SuperGrok Heavy', planSource: 'upstream' });
  assert.deepEqual(accountPlan({ platform: 'anthropic', type: 'oauth', credentials: { plan_type: 'pro' } }), { planLabel: 'Pro', planSource: 'upstream' });
  assert.equal(accountPlan({ platform: 'anthropic', type: 'oauth', credentials: { plan_type: 'prolite' } }).planSource, 'unknown');
  assert.equal(accountPlan({ platform: 'openai', type: 'oauth', credentials: { plan_type: '<script>pro</script>' } }).planSource, 'unknown');
});
