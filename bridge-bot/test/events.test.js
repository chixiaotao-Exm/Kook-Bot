import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubEvent, validNotification } from '../src/events.js';

const repository = 'chixiaotao-Exm/Kook-Bot', before = 'a'.repeat(40), after = 'b'.repeat(40);
const base = () => ({ repository: { full_name: repository, private: true }, sender: { login: 'maintainer' } });
const push = patch => ({ ...base(), ref: 'refs/heads/main', before, after, deleted: false, size: 4,
  commits: Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1).repeat(40), message: `Change ${index}\nprivate body`, author: { name: 'Author' } })), ...patch });
const pr = (patch = {}, top = {}) => ({ ...base(), action: 'opened', number: 12, pull_request: { number: 12, title: 'Fix playback',
  updated_at: '2026-09-24T01:00:00Z', head: { ref: 'fix/playback', repo: { full_name: 'fork/private', html_url: 'https://github.com/fork/private' } },
  base: { ref: 'main', repo: { full_name: repository } }, body: 'PRIVATE_PR_BODY', html_url: 'https://evil.invalid/private', merged: false, ...patch }, ...top });
const ci = patch => ({ ...base(), action: 'completed', workflow_run: { id: 12345, workflow_id: 88, run_attempt: 1,
  status: 'completed', conclusion: 'success', name: 'Verify repository', head_sha: after, head_branch: 'main', event: 'push',
  html_url: 'https://evil.invalid/private-run', logs_url: 'PRIVATE_LOG_URL', ...patch } });

test('branch pushes show only bounded first-line summaries and build links for the configured private repository', () => {
  const result = normalizeGithubEvent('push', push());
  assert.equal(result.kind, 'push'); assert.equal(result.theme, 'info'); assert.equal(result.lines.length, 6);
  assert.match(result.lines[1], /4/); assert.ok(result.lines.some(line => line.includes('Change 2')));
  assert.ok(!result.lines.some(line => line.includes('Change 3')));
  assert.equal(result.url, `https://github.com/${repository}/compare/${before}...${after}`);
  assert.doesNotMatch(JSON.stringify(result), /private body|PRIVATE/); assert.equal(validNotification(result, repository), true);
  assert.equal(normalizeGithubEvent('push', push({ before: '0'.repeat(40) })).url, `https://github.com/${repository}/commit/${after}`);
  const deleted = normalizeGithubEvent('push', push({ deleted: true, after: '0'.repeat(40), commits: undefined, size: undefined }));
  assert.equal(deleted.url, `https://github.com/${repository}`); assert.equal(deleted.theme, 'warning'); assert.match(deleted.title, /已删除/);
});

test('push keys ignore delivery IDs and authors but distinguish branch, revisions and deletion', () => {
  const one = normalizeGithubEvent('push', push(), { deliveryId: 'first' });
  assert.equal(one.key, normalizeGithubEvent('push', push({ sender: { login: 'another' } }), { deliveryId: 'second' }).key);
  for (const patch of [{ ref: 'refs/heads/develop' }, { after: 'c'.repeat(40) }, { before: 'c'.repeat(40) }, { deleted: true }]) {
    assert.notEqual(one.key, normalizeGithubEvent('push', push(patch)).key);
  }
});

test('only selected PR lifecycle actions notify and fork URLs or bodies never enter notifications', () => {
  for (const action of ['opened', 'reopened', 'closed', 'ready_for_review']) {
    const result = normalizeGithubEvent('pull_request', pr({}, { action }));
    assert.ok(result); assert.equal(result.url, `https://github.com/${repository}/pull/12`);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PR_BODY|evil\.invalid|fork\/private/);
  }
  const merged = normalizeGithubEvent('pull_request', pr({ merged: true }, { action: 'closed' }));
  assert.equal(merged.theme, 'success'); assert.match(merged.title, /合并/);
  for (const action of ['synchronize', 'edited', 'labeled', 'assigned']) assert.equal(normalizeGithubEvent('pull_request', pr({}, { action })), null);
  assert.equal(normalizeGithubEvent('ping', base()), null);
});

test('PR deduplication retains lifecycle actions and later updates, using delivery only if timestamp is missing', () => {
  const one = normalizeGithubEvent('pull_request', pr());
  assert.equal(one.key, normalizeGithubEvent('pull_request', pr(), { deliveryId: 'a'.repeat(36) }).key);
  assert.notEqual(one.key, normalizeGithubEvent('pull_request', pr({ updated_at: '2026-09-24T01:01:00Z' })).key);
  assert.notEqual(one.key, normalizeGithubEvent('pull_request', pr({}, { action: 'reopened' })).key);
  assert.notEqual(normalizeGithubEvent('pull_request', pr({}, { action: 'closed' })).key,
    normalizeGithubEvent('pull_request', pr({ merged: true }, { action: 'closed' })).key);
  assert.equal(normalizeGithubEvent('pull_request', pr({ updated_at: undefined })), null);
  const fallback = normalizeGithubEvent('pull_request', pr({ updated_at: undefined }), { deliveryId: 'a'.repeat(36) });
  assert.ok(fallback); assert.notEqual(fallback.key,
    normalizeGithubEvent('pull_request', pr({ updated_at: undefined }), { deliveryId: 'b'.repeat(36) }).key);
});

test('completed CI de-duplicates push and PR runs for the same workflow, commit, attempt and result', () => {
  const one = normalizeGithubEvent('workflow_run', ci());
  const duplicate = normalizeGithubEvent('workflow_run', ci({ id: 99999, event: 'pull_request', head_branch: 'feature' }));
  assert.equal(one.key, duplicate.key); assert.equal(one.url, `https://github.com/${repository}/actions/runs/12345`);
  assert.equal(one.theme, 'success'); assert.match(one.title, /Verify repository.*通过/);
  for (const patch of [{ run_attempt: 2 }, { conclusion: 'failure' }, { workflow_id: 89 }, { head_sha: before }]) {
    assert.notEqual(one.key, normalizeGithubEvent('workflow_run', ci(patch)).key);
  }
  for (const conclusion of ['failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    assert.ok(normalizeGithubEvent('workflow_run', ci({ conclusion })));
  }
  for (const patch of [{ status: 'in_progress' }, { conclusion: null }, { conclusion: 'private-unknown' }, { run_attempt: 0 }, { workflow_id: null }]) {
    assert.equal(normalizeGithubEvent('workflow_run', ci(patch)), null);
  }
});

test('public text strips credentials, mentions, control characters and remote links without splitting Unicode', () => {
  const secret = 'TOKEN=secretfixture password: "private password" sk-privatesynthetic123 admin-private123 ghp_privatefixture123 github_pat_privatefixture123';
  const result = normalizeGithubEvent('push', push({ sender: { login: '@all' }, commits: [{ id: before,
    message: `${secret} (met)123456(met) <@456> @here https://github.com/fork/private\nPRIVATE_BODY`,
    author: { name: 'member@example.test\u0000\u202e😀'.repeat(25) } }], ref: `refs/heads/${'😀'.repeat(100)}`, size: 1 }));
  assert.ok(result); assert.ok(result.title.length <= 100); assert.ok(result.lines.every(line => line.length <= 500 && line.isWellFormed()));
  assert.equal(result.title.isWellFormed(), true);
  assert.doesNotMatch(JSON.stringify(result), /secretfixture|private password|privatesynthetic|admin-private|ghp_private|github_pat_private|\(met\)|<@|@all|@here|fork\/private|member@example|PRIVATE_BODY|\u202e/);
  const workflow = normalizeGithubEvent('workflow_run', ci({ name: '😀'.repeat(400) }));
  assert.ok(workflow); assert.ok(workflow.title.length <= 100); assert.ok(workflow.title.endsWith('通过'));
});

test('wrong repository, tags, malformed shapes and supplied URLs cannot bypass normalization', () => {
  const mixed = push(); mixed.repository.full_name = repository.toUpperCase();
  assert.ok(normalizeGithubEvent('push', mixed));
  for (const payload of [null, [], {}, { ...push(), repository: { full_name: 'fork/Kook-Bot' } }, push({ ref: 'refs/tags/v1' }),
    push({ ref: 'refs/heads/../unsafe' }), push({ before: 'secret' }), push({ deleted: 'false' }), push({ commits: [null] }),
    push({ size: -1 }), push({ after: '0'.repeat(40) }), push({ commits: [{ id: after, message: {} }] })]) {
    assert.equal(normalizeGithubEvent('push', payload), null);
  }
  assert.equal(normalizeGithubEvent('push', push(), { repository: '../escape' }), null);
  assert.equal(normalizeGithubEvent('pull_request', pr({ number: 13 })), null);
  assert.equal(normalizeGithubEvent('pull_request', pr({ base: { ref: 'main', repo: { full_name: 'other/repo' } } })), null);
});

test('queue restoration accepts only exact sanitized notification fields and repository URLs', () => {
  const original = normalizeGithubEvent('workflow_run', ci());
  assert.equal(validNotification(original, repository), true);
  for (const patch of [{ key: 'x'.repeat(64) }, { kind: 'other' }, { theme: 'custom' }, { title: 'x'.repeat(101) },
    { title: '@all' }, { title: '\ud800' }, { lines: Array(9).fill('line') }, { lines: ['\nsecret'] },
    { lines: ['TOKEN=private-secret'] }, { lines: ['https://github.com/fork/repo'] }, { lines: ['a'.repeat(501)] },
    { url: 'https://github.com/fork/Kook-Bot/actions/runs/1' }, { url: `https://github.com/${repository}/actions/runs/1?secret=yes` },
    { url: `https://github.com/${repository}/pull/../settings` }, { extra: 'untrusted' }]) {
    assert.equal(validNotification({ ...original, ...patch }, repository), false, JSON.stringify(patch));
  }
  assert.equal(validNotification(null, repository), false);
});
