import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvitation, sanitizeInvitation } from '../src/invitation-snapshot.js';
import { normalizeAccounts } from '../src/sub2api.js';

const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const account = snapshot => ({ id: 6255, name: 'Account', platform: 'openai', type: 'oauth', status: 'active',
  extra: { codex_referral_snapshot: snapshot } });
const sample = overrides => ({ available_invites: 3, should_show: true, program_id: 'codex_referral_consumer',
  title: '邀请朋友', description: '发送邀请前核对规则', rules: ['每位新成员只可使用一次'], fetched_at: NOW / 1000, ...overrides });

test('eligible invitation capability stays available with unknown cache while other account types stay absent', () => {
  assert.deepEqual(normalizeInvitation(account(undefined), { now: NOW }), {
    supported: true, availableCount: null, shouldShow: false, programId: null, programLabel: '',
    requiresConfirmation: true, title: '', description: '', rules: [], checkedAt: null, freshness: 'unknown',
  });
  for (const patch of [{ platform: 'anthropic' }, { type: 'apikey' }, { type: 'setup' },
    { parent_account_id: 1 }, { parent_account_id: 0 }, { is_shadow: true }]) {
    assert.equal(normalizeInvitation({ ...account(sample()), ...patch }, { now: NOW }), null);
  }
  assert.equal(normalizeInvitation(null), null);
  assert.equal(normalizeInvitation({ ...account(sample()), parent_account_id: null }, { now: NOW }).supported, true);
});

test('only explicit safe counts become availability and unknown does not become zero', () => {
  for (const [value, expected] of [[0, 0], [3, 3], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [null, null], [undefined, null], ['', null], ['0', null], [-1, null], [1.2, null],
    [Number.MAX_SAFE_INTEGER + 1, null], [Infinity, null], [true, null]]) {
    assert.equal(normalizeInvitation(account(sample({ available_invites: value })), { now: NOW }).availableCount, expected);
  }
});

test('program and confirmation metadata follow explicit upstream fields without enabling unknown programs', () => {
  const workspace = normalizeInvitation(account(sample({ program_id: 'codex_referral_workspace', requires_explicit_confirmation: false })), { now: NOW });
  assert.equal(workspace.programLabel, '工作区邀请'); assert.equal(workspace.requiresConfirmation, false);
  assert.equal(normalizeInvitation(account(sample()), { now: NOW }).programLabel, '个人邀请');
  for (const program_id of ['new-program', '__proto__', null]) {
    const result = normalizeInvitation(account(sample({ program_id, supported: false })), { now: NOW });
    assert.equal(result.supported, true); assert.equal(result.programId, null); assert.equal(result.programLabel, '');
    assert.equal(result.shouldShow, true);
  }
  for (const value of [undefined, null, true, 0, 'false']) {
    assert.equal(normalizeInvitation(account(sample({ requires_explicit_confirmation: value })), { now: NOW }).requiresConfirmation, true);
  }
  assert.equal(normalizeInvitation(account(sample({ should_show: 'true' })), { now: NOW }).shouldShow, false);
});

test('freshness uses the invitation timestamp independently and validates missing, future and expired samples', () => {
  const at = value => normalizeInvitation(account(sample({ fetched_at: value })), { now: NOW });
  assert.equal(at(NOW / 1000).checkedAt, new Date(NOW).toISOString());
  assert.equal(at(NOW / 1000).freshness, 'fresh');
  assert.equal(at((NOW - 900001) / 1000).freshness, 'stale');
  assert.equal(at((NOW + 61000) / 1000).freshness, 'unknown');
  for (const invalid of [undefined, null, '', 0, -1, 'not-a-date', Infinity, {}]) {
    assert.equal(at(invalid).checkedAt, null); assert.equal(at(invalid).freshness, 'unknown');
  }
  assert.equal(normalizeInvitation(account(sample()), { now: NOW + 30001, staleAfterMs: 30000 }).freshness, 'stale');
});

test('invitation output is a bounded whitelist without credentials, emails, links or unsafe markup', () => {
  const dirty = sample({ title: '<b>欢迎</b>\u0000 sk-privatefixture123456789',
    description: '联系 member@example.test 或 https://private.example/invite?secret=fixture Bearer private-bearer-value',
    rules: ['访问 www.private.example/invite', '邮箱 mailto:other@example.test', '安全规则', { credentials: 'private-rule-object' },
      ...Array(30).fill('长'.repeat(1000))], credentials: { password: 'private-password' }, email: 'private@example.test',
    links: ['https://hidden.example/private'], unknown: 'private-extra' });
  const result = normalizeInvitation({ ...account(dirty), credentials: { access_token: 'private-access' } }, { now: NOW });
  assert.deepEqual(Object.keys(result), ['supported', 'availableCount', 'shouldShow', 'programId', 'programLabel', 'requiresConfirmation',
    'title', 'description', 'rules', 'checkedAt', 'freshness']);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /privatefixture|private-password|private-access|private-rule-object|private-extra|example\.test|private\.example|https?:|mailto:|<b>|\u0000/);
  assert.ok(result.title.includes('欢迎')); assert.ok(result.rules.includes('安全规则'));
  assert.ok(result.rules.length <= 20); assert.ok(result.rules.every(rule => rule.length <= 300));
  const safe = sanitizeInvitation({ ...result, email: 'again@example.test', token: 'private-normalized', freshness: 'fresh' }, { now: NOW + 900001 });
  assert.equal(safe.freshness, 'stale'); assert.equal('email' in safe, false); assert.equal('token' in safe, false);
});

test('normal accounts attach invitation data without exposing upstream cache or credentials', () => {
  const [result, shadow, other] = normalizeAccounts([account(sample()), { ...account(sample()), id: 6256, parent_account_id: 6255 },
    { ...account(sample()), id: 6257, platform: 'deepseek' }], { now: NOW });
  assert.equal(result.invitation.availableCount, 3); assert.equal(result.invitation.supported, true);
  assert.equal(shadow.invitation, null); assert.equal(other.invitation, null);
  assert.equal('extra' in result, false); assert.equal('credentials' in result, false);
});
