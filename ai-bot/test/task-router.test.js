import test from 'node:test';
import assert from 'node:assert/strict';
import { codeTaskIntent, TaskRouter } from '../src/task-router.js';

test('code intent targets only the explicitly configured repository', () => {
  assert.deepEqual(codeTaskIntent('https://github.com/chixiaotao-Exm/Kook-Bot 检查并修复'), { requested: true, allowed: true });
  assert.deepEqual(codeTaskIntent('https://github.com/elsewhere/private 修复'), { requested: true, allowed: false });
  assert.equal(codeTaskIntent('代码任务：读取源码').requested, true);
  assert.equal(codeTaskIntent('检查这个仓库').requested, true);
  assert.equal(codeTaskIntent('先开始读项目源码').requested, true);
  assert.equal(codeTaskIntent('人工智能如何影响未来？').requested, false);
});

test('only authorized code requests replace discussion; feedback and stop route to the active task', async () => {
  const calls = []; let codeActive = false, discussionActive = true;
  const discussion = { snapshot: () => ({ active: discussionActive }),
    stop: async () => { calls.push('discussion.stop'); discussionActive = false; return { stopped: true }; },
    start: async () => { calls.push('discussion.start'); discussionActive = true; return { accepted: true }; },
    contribute: async () => { calls.push('discussion.contribute'); return { accepted: true }; } };
  const code = { snapshot: () => ({ active: codeActive, status: 'running' }),
    start: async () => { calls.push('code.start'); codeActive = true; return { accepted: true }; },
    contribute: async () => { calls.push('code.contribute'); return { accepted: true }; },
    stop: async ({ userId }) => { calls.push(`code.stop:${userId}`); codeActive = false; return { stopped: true }; } };
  const router = new TaskRouter({ discussion, code, operatorIds: new Set(['owner']) });
  const options = { topic: '代码任务：修复这个项目', userId: 'other' };
  assert.equal((await router.start(options)).reason, 'NOT_AUTHORIZED'); assert.deepEqual(calls, []);
  assert.equal((await router.start({ ...options, userId: 'owner' })).mode, 'code');
  assert.deepEqual(calls, ['discussion.stop', 'code.start']);
  await router.contribute({ text: '先处理配置部分', userId: 'owner' });
  assert.equal(calls.at(-1), 'code.contribute');
  assert.equal(router.snapshot().mode, 'code');
  await router.stop({ userId: 'owner' }); assert.equal(calls.at(-1), 'code.stop:owner');
});
