// Friendly labels for saved subscription metadata, not account names, models,
// billing multipliers or inferred quota sizes. Native mappings follow Sub2API
// e8cb019f PlatformTypeBadge.vue; Pro 5x and Team Pro use the user-confirmed labels.
const LABELS = {
  openai: {
    free: 'Free', basic: 'Free', plus: 'Plus', chatgptplus: 'Plus', pro: 'Pro', chatgptpro: 'Pro',
    prolite: 'Pro 5x', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
    selfservebusiness: 'Business', selfservebusinessprolite: 'Team Pro',
    selfservebusinessusagebased: 'Business 按量计费',
  },
  anthropic: { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' },
  grok: { free: 'Grok Free', basic: 'Grok Free', xbasic: 'X Basic', supergrok: 'SuperGrok',
    supergroklite: 'SuperGrok Lite', supergrokplus: 'SuperGrok Plus', supergrokheavy: 'SuperGrok Heavy', heavy: 'Heavy' },
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const normalize = value => typeof value === 'string' && value.length <= 80 ? value.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
const unknown = () => ({ planLabel: '版本未知', planSource: 'unknown' });

export function accountPlan(raw) {
  const account = object(raw), platform = account.platform === 'claude' ? 'anthropic' : account.platform;
  if (typeof account.type === 'string' && /^(apikey|api_key|bedrock)$/i.test(account.type)) {
    return { planLabel: 'API 计费', planSource: 'type' };
  }
  const extra = object(account.extra), credentials = object(account.credentials);
  const activeSample = typeof extra.codex_active_quota_observed_at === 'string'
    && Number.isFinite(Date.parse(extra.codex_active_quota_observed_at))
    && extra.codex_active_quota_observed_at === extra.codex_usage_updated_at;
  const candidates = platform === 'openai' ? [activeSample ? extra.codex_active_quota_plan_type : null,
    credentials.plan_type, extra.codex_plan_type, extra.plan_type, extra.subscription_plan]
    : platform === 'grok' ? [object(extra.grok_billing_snapshot).plan, object(extra.grok_usage_snapshot).subscription_tier, extra.subscription_tier, credentials.subscription_tier, credentials.plan_type]
      : platform === 'anthropic' ? [credentials.plan_type] : [];
  const value = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
  const normalized = normalize(value), mapping = LABELS[platform];
  if (!mapping || !Object.hasOwn(mapping, normalized)) return unknown();
  return { planLabel: mapping[normalized], planSource: 'upstream' };
}
