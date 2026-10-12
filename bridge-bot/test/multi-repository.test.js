import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { normalizeRepositories } from '../src/repositories.js';
import { createRepositoryRouter } from '../src/routing.js';
import { BridgeServer } from '../src/server.js';
import { normalizeGithubEvent, validNotification } from '../src/events.js';
import { NotificationQueue } from '../src/queue.js';

const REPOSITORIES = ['example/first', 'example/second'];
const SECRET = 'multi-repository-fixture-' + 'a'.repeat(32);
const CHANNEL = '1234567890123456';
const MESSAGE_ID = '12345678-1234-1234-1234-1234567890ab';
const BEFORE = 'a'.repeat(40), AFTER = 'b'.repeat(40);
const environment = { GITHUB_REPOSITORY: REPOSITORIES[0], GITHUB_WEBHOOK_SECRET: SECRET,
  KOOK_TOKEN: 'fixture-only-token', KOOK_CHANNEL_ID: CHANNEL };

function eventPayload(kind, repository) {
  const base = { repository: { full_name: repository }, sender: { login: 'fixture-user' } };
  if (kind === 'push') return { ...base, ref: 'refs/heads/main', before: BEFORE, after: AFTER,
    deleted: false, size: 1, commits: [{ id: AFTER, message: 'An ordinary change' }] };
  if (kind === 'pull_request') return { ...base, action: 'opened', number: 7, pull_request: {
    number: 7, title: 'An ordinary pull request', updated_at: '2026-10-01T00:00:00Z',
    head: { ref: 'feature' }, base: { ref: 'main', repo: { full_name: repository } } } };
  return { ...base, action: 'completed', workflow_run: { id: 42, workflow_id: 6, run_attempt: 1,
    status: 'completed', conclusion: 'success', name: 'Verify', head_sha: AFTER, head_branch: 'main' } };
}
const notification = (repository, kind = 'push') => normalizeGithubEvent(kind, eventPayload(kind, repository), { repository });

function routerFixture() {
  const calls = [];
  const router = createRepositoryRouter({ repositories: REPOSITORIES, token: 'fixture-only-token', channelId: CHANNEL,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ code: 0, data: { msg_id: MESSAGE_ID } }); } });
  return { router, calls };
}

test('repository configuration is explicit, immutable and backwards compatible', () => {
  assert.deepEqual(loadConfig(environment).repositories, [REPOSITORIES[0]]);
  const config = loadConfig({ ...environment, GITHUB_REPOSITORIES: ' example/first,example/second,EXAMPLE/FIRST ' });
  assert.deepEqual(config.repositories, REPOSITORIES);
  assert.equal(config.repository, REPOSITORIES[0]);
  assert.ok(Object.isFrozen(config.repositories));
  assert.deepEqual(loadConfig({ ...environment, GITHUB_REPOSITORY: 'invalid', GITHUB_REPOSITORIES: REPOSITORIES[1] }).repositories, [REPOSITORIES[1]]);
  const mutable = [...REPOSITORIES], normalized = normalizeRepositories(mutable);
  mutable.push('example/unapproved');
  assert.deepEqual(normalized, REPOSITORIES);
  assert.ok(Object.isFrozen(normalized));
  for (const value of ['', ' ', 'example/first,', ',example/first', 'example/first,,example/second',
    'example/first-other?x=1', 'https://github.com/example/first', '../first', 'example/..', [], [REPOSITORIES[0], null]]) {
    assert.throws(() => normalizeRepositories(value));
  }
  assert.throws(() => loadConfig({ ...environment, GITHUB_REPOSITORIES: '' }), 'An explicitly empty list must not silently use the legacy value');
});

test('repository token configuration accepts only configured sources and valid private tokens', () => {
  const configured = { ...environment, GITHUB_REPOSITORIES: REPOSITORIES.join(',') };
  const config = loadConfig({ ...configured,
    GITHUB_REPOSITORY_TOKENS: JSON.stringify({ 'EXAMPLE/SECOND': 'fixture-second-token' }) });
  assert.equal(config.repositoryTokens[REPOSITORIES[1]], 'fixture-second-token');
  assert.equal(config.repositoryTokens[REPOSITORIES[0]], undefined);
  assert.ok(Object.isFrozen(config.repositoryTokens));
  for (const value of ['{broken', '[]', 'null', JSON.stringify({ 'example/unapproved': 'fixture-token' }),
    JSON.stringify({ 'example/second': '' }), JSON.stringify({ 'example/second': 'bad\ntoken' }),
    JSON.stringify({ 'example/second': 123 })]) {
    assert.throws(() => loadConfig({ ...configured, GITHUB_REPOSITORY_TOKENS: value }));
  }
});

test('two signed repositories share one listener, while pings never enter its queue', async t => {
  const queued = [], keys = new Set(), configured = [...REPOSITORIES];
  const server = new BridgeServer({ port: 0, repositories: configured, secret: SECRET,
    queue: { enqueue: async value => {
      const duplicate = keys.has(value.key);
      if (!duplicate) { queued.push(value); keys.add(value.key); }
      return { duplicate };
    } } });
  configured.push('example/unapproved');
  const address = await server.start();
  t.after(() => server.close());
  const send = async (payload, event = 'push', signature) => {
    const raw = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${address.port}/github`, { method: 'POST', body: raw, headers: {
      'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': signature ?? 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'),
    } });
  };
  for (const repository of REPOSITORIES) {
    const ping = await send({ repository: { full_name: repository }, zen: 'Not forwarded' }, 'ping');
    assert.equal(ping.status, 200); assert.deepEqual(await ping.json(), { pong: true });
  }
  assert.equal(queued.length, 0);
  for (const repository of REPOSITORIES) {
    const first = await send(eventPayload('push', repository.toUpperCase()));
    assert.equal(first.status, 202);
    assert.equal((await send(eventPayload('push', repository))).status, 200);
  }
  assert.equal(queued.length, 2);
  assert.notEqual(queued[0].key, queued[1].key);
  assert.equal(queued[0].url, `https://github.com/${REPOSITORIES[0]}/compare/${BEFORE}...${AFTER}`);
  assert.equal(queued[1].url, `https://github.com/${REPOSITORIES[1]}/compare/${BEFORE}...${AFTER}`);
  for (const repository of ['example/unapproved', 'example/first-other', 'other/first']) {
    assert.equal((await send(eventPayload('push', repository))).status, 403);
    assert.equal((await send({ repository: { full_name: repository } }, 'ping')).status, 403);
  }
  assert.equal((await send(eventPayload('push', REPOSITORIES[1]), 'push', 'sha256=' + '0'.repeat(64))).status, 401);
  assert.equal(queued.length, 2);
});

test('identical pushes, PR numbers and workflow runs remain independently deduplicated per repository', () => {
  for (const kind of ['push', 'pull_request', 'workflow_run']) {
    const first = notification(REPOSITORIES[0], kind), second = notification(REPOSITORIES[1], kind);
    assert.ok(first); assert.ok(second); assert.notEqual(first.key, second.key);
    assert.equal(notification(REPOSITORIES[0], kind).key, first.key);
    assert.equal(notification(REPOSITORIES[1], kind).key, second.key);
    assert.equal(validNotification(first, REPOSITORIES[0]), true);
    assert.equal(validNotification(first, REPOSITORIES[1]), false);
    assert.deepEqual(Object.keys(first).sort(), ['key', 'kind', 'lines', 'theme', 'title', 'url']);
  }
});

test('the router sends both repositories to one channel and identifies each source in its card', async () => {
  const { router, calls } = routerFixture();
  for (const repository of REPOSITORIES) {
    const value = notification(repository);
    assert.equal(router.validate(value), true);
    assert.deepEqual(await router.send(value), { messageId: MESSAGE_ID });
  }
  assert.equal(calls.length, 2);
  calls.forEach(({ url, init }, index) => {
    assert.equal(url, 'https://www.kookapp.cn/api/v3/message/create');
    const body = JSON.parse(init.body), card = JSON.parse(body.content)[0];
    assert.equal(body.target_id, CHANNEL);
    const context = card.modules.filter(module => module.type === 'context').flatMap(module => module.elements);
    assert.ok(context.some(element => element.type === 'plain-text' && element.content === `仓库：${REPOSITORIES[index]}`));
    assert.equal(card.modules.at(-1).elements[0].value, notification(REPOSITORIES[index]).url);
    assert.equal(init.redirect, 'manual');
  });
});

test('a repository token override selects a different bot without changing the destination channel', async () => {
  const calls = [];
  const router = createRepositoryRouter({ repositories: REPOSITORIES, token: 'fixture-default-token', channelId: CHANNEL,
    repositoryTokens: { [REPOSITORIES[1]]: 'fixture-second-token' },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ code: 0, data: { msg_id: MESSAGE_ID } }); } });
  await router.send(notification(REPOSITORIES[0]));
  await router.send(notification(REPOSITORIES[1]));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, 'Bot fixture-default-token');
  assert.equal(calls[1].init.headers.Authorization, 'Bot fixture-second-token');
  assert.ok(calls.every(({ init }) => JSON.parse(init.body).target_id === CHANNEL));
  assert.ok(calls.every(({ init }) => !/fixture-(?:default|second)-token/.test(JSON.parse(init.body).content)));
});

test('multi-repository dispatch rejects unapproved or tampered links before any KOOK request', async () => {
  const { router, calls } = routerFixture(), value = notification(REPOSITORIES[0]);
  const badUrls = [
    'https://github.com/example/third/pull/1', 'https://github.com/example/first-other/pull/1',
    'https://github.com/example/first/../second/pull/1', 'https://github.com/example%2ffirst/pull/1',
    'https://github.com/example/second/pull/1?token=fixture', 'https://github.com/example/second/settings',
    'https://github.com.example.test/example/second/pull/1', 'https://fixture@github.com/example/second/pull/1',
  ];
  for (const url of badUrls) {
    const invalid = { ...value, url };
    assert.equal(router.validate(invalid), false);
    await assert.rejects(router.send(invalid), error => error.delivery === 'rejected');
  }
  assert.equal(router.validate({ ...value, repository: REPOSITORIES[1] }), false);
  await assert.rejects(router.send({ ...value, repository: REPOSITORIES[1] }), error => error.delivery === 'rejected');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(router.send(notification(REPOSITORIES[1]), { signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.equal(calls.length, 0);
});

test('a legacy queued item and new repository items restore without migration or replay', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-multi-repository-'));
  const { router, calls } = routerFixture();
  let queue;
  t.after(async () => { await queue?.close(); await rm(directory, { recursive: true, force: true }); });
  const first = notification(REPOSITORIES[0]), second = notification(REPOSITORIES[1]);
  queue = await new NotificationQueue({ dataDir: directory, send: router.send,
    validate: value => validNotification(value, REPOSITORIES[0]), intervalMs: 1 }).init();
  assert.equal((await queue.enqueue(first)).accepted, true);
  await queue.close();
  const legacy = JSON.parse(await readFile(path.join(directory, 'bridge-queue.json'), 'utf8'));
  assert.equal(legacy.version, 1); assert.deepEqual(legacy.records[0].notification, first);

  const options = { dataDir: directory, send: router.send, validate: router.validate, intervalMs: 1 };
  queue = await new NotificationQueue(options).init();
  assert.equal(queue.snapshot().queued, 1);
  assert.equal((await queue.enqueue(first)).duplicate, true);
  assert.equal((await queue.enqueue(second)).accepted, true);
  await queue.close();
  assert.equal(calls.length, 0);

  queue = await new NotificationQueue(options).init();
  assert.equal(queue.snapshot().queued, 2);
  queue.start();
  const deadline = Date.now() + 3000;
  while (queue.snapshot().sent !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queue.snapshot().sent, 2); assert.equal(calls.length, 2);
  await queue.close();

  queue = await new NotificationQueue(options).init();
  assert.equal(queue.snapshot().sent, 2); assert.equal(queue.snapshot().queued, 0);
  assert.equal((await queue.enqueue(first)).duplicate, true);
  assert.equal((await queue.enqueue(second)).duplicate, true);
  assert.equal(calls.length, 2);
  const state = JSON.parse(await readFile(path.join(directory, 'bridge-queue.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.ok(state.records.every(record => record.state === 'sent' && record.notification === undefined));
});
