import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRouter } from '../src/task-router.js';
import { ConversationThread } from '../src/conversation-thread.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('unbound migrated context retains the incoming message as its reply fallback', () => {
  const router = new TaskRouter({ discussion: {} });
  const context = { id: id(1), topic: '原来的问题', anchorMessageId: null, messages: [] };
  const input = router.contextOptions({ receiptId: id(2), replyMessageId: id(2) }, context);
  assert.equal(input.replyMessageId, id(2)); assert.equal(input.threadId, context.id);
  assert.deepEqual(input.threadContext, [{ role: 'user', content: '本话题最初的问题：原来的问题' }]);
});

test('continuing interrupted code work cannot silently replace its saved job after restart', async () => {
  for (const status of ['interrupted', 'needs_input', 'stopped']) {
    let starts = 0;
    const router = new TaskRouter({ discussion: { snapshot: () => ({ active: false }) },
      code: { snapshot: () => ({ active: false, jobId: 'saved-job', status }), start: async () => { starts++; } },
      thread: { context: () => ({ mode: 'code' }) }, operatorIds: new Set(['12345678']) });
    assert.deepEqual(await router.resume({ userId: '12345678', receiptId: id(1) }), { resumed: false, reason: 'RESTART_REQUIRED' });
    assert.deepEqual(await router.resume({ userId: '87654321', receiptId: id(2) }), { resumed: false, reason: 'NOT_AUTHORIZED' });
    assert.equal(starts, 0);
  }
});

test('completed code follow-up stays in the same topic; only explicit newTopic changes mode and anchor', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kook-code-thread-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const thread = await new ConversationThread({ dataDir }).init(), starts = [];
  const discussion = { snapshot: () => ({ active: false }), start: async input => { starts.push({ mode: 'discussion', input }); return { accepted: true }; } };
  const code = { snapshot: () => ({ active: false, status: 'completed' }), start: async input => { starts.push({ mode: 'code', input }); return { accepted: true }; } };
  const router = new TaskRouter({ discussion, code, thread, operatorIds: new Set(['12345678']) });
  await router.start({ topic: '代码任务：检查这个项目', userId: '12345678', receiptId: id(1), replyMessageId: id(1) });
  const first = thread.context();
  await thread.recordAssistant({ threadId: first.id, speaker: '思维1', content: '已审查，结果见 PR #2。' });
  await router.start({ topic: '刚才那个结果还需要优化', userId: '12345678', receiptId: id(2), replyMessageId: id(2) });
  assert.deepEqual(starts.map(item => item.mode), ['code', 'code']);
  assert.equal(starts[1].input.threadId, first.id); assert.equal(starts[1].input.replyMessageId, id(1));
  assert.ok(JSON.stringify(starts[1].input.threadContext).includes('PR #2'));
  const before = thread.context();
  assert.equal((await router.start({ topic: '继续修改', userId: '87654321', receiptId: id(3) })).reason, 'NOT_AUTHORIZED');
  assert.deepEqual(thread.context(), before);
  await router.newTopic({ userId: '12345678', receiptId: id(4), replyMessageId: id(4) });
  await router.start({ topic: '聊聊旅行', userId: '12345678', receiptId: id(5), replyMessageId: id(5) });
  assert.equal(starts[2].mode, 'discussion'); assert.equal(starts[2].input.replyMessageId, id(5));
  assert.notEqual(thread.context().id, first.id);
  assert.ok(!JSON.stringify(starts[2].input.threadContext).includes('PR #2'));
});
