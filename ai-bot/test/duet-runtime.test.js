import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDuetRuntime } from '../src/duet-index.js';

class Gateway {
  constructor({ onEvent }) { this.onEvent = onEvent; this.connected = false; this.botId = ''; }
  async start() { this.connected = true; }
  close() { this.connected = false; }
  snapshot() { return { connected: this.connected, botId: this.botId }; }
}
const event = (content, number = 1) => ({ type: 1, channel_type: 'GROUP', target_id: '88888888',
  author_id: '99999999', msg_id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  msg_timestamp: Date.now(), content, extra: { author: { id: '99999999', bot: false } } });
async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected duet state transition');
}

test('only primary gateway routes human commands; both identities alternate confirmed posts', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-runtime-'));
  const config = { tokens: ['fixture-bot-a', 'fixture-bot-b'], models: ['gpt-6-astra', 'gpt-6-astra'],
    labels: ['A', 'B'], channelId: '88888888', dataDir, host: '127.0.0.1', port: 0,
    rounds: 0, betweenTurnsMs: 0, deadlineMs: 0 };
  const generated = [], deliveries = [], notices = [];
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
    clients: [0, 1].map(index => ({ async generate(messages) { generated.push({ index, messages }); return { text: `第${index}方的观点` }; } })),
    replies: [0, 1].map(index => async payload => { deliveries.push({ index, payload }); return { messageId: `00000000-0000-4000-8000-${String(100 + deliveries.length).padStart(12, '0')}` }; }),
    commandReply: async payload => { notices.push(payload); return { messageId: '00000000-0000-4000-8000-000000000099' }; },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.bots.length, 2);
  assert.deepEqual(health.defaults, { unlimited: true, rounds: null, deadlineMs: null });
  assert.ok(!JSON.stringify(health).includes(config.tokens[0]));
  const input = event('/互聊 1 如何规划周末散步');
  await runtime.gateways[1].onEvent(input); assert.equal(generated.length, 0);
  await runtime.gateways[0].onEvent(input);
  await waitFor(() => generated.length === 2 && !runtime.session.snapshot().active);
  assert.deepEqual(generated.map(item => item.index), [0, 1]);
  assert.deepEqual(deliveries.slice(0, 2).map(item => item.index), [0, 1]);
  assert.ok(deliveries.every(item => item.payload.textOnly === true && item.payload.targetId === config.channelId));
  assert.ok(JSON.stringify(generated[1].messages).includes('第0方的观点'));
  await runtime.gateways[0].onEvent(input); assert.equal(generated.length, 2);
  assert.ok(!(await readFile(path.join(dataDir, 'duet-seen.json'), 'utf8')).includes('周末散步'));
  assert.ok(!JSON.stringify(runtime.snapshot()).includes('周末散步'));
});

test('same bot account behind different tokens is rejected before gateways start', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-identity-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 6, deadlineMs: 600000, betweenTurnsMs: 0 };
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '11111111' }] }),
    clients: [{ generate() { throw Error('Must not generate'); } }, { generate() { throw Error('Must not generate'); } }],
    replies: [async () => {}, async () => {}], commandReply: async () => {},
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(runtime.start(), /identity/);
  assert.ok(runtime.gateways.every(gateway => !gateway.connected));
});

test('a direct human question starts continuous discussion and plain stop cancels the next turn', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-natural-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 0, deadlineMs: 0, betweenTurnsMs: 0 };
  let calls = 0; const sent = [], signals = [];
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
    clients: [0, 1].map(index => ({ async generate(messages, { signal }) {
      calls++; signals.push(signal);
      if (calls > 2) return new Promise(() => {});
      return { text: `${index} 对这个问题的观点` };
    } })),
    replies: [0, 1].map(index => async payload => {
      sent.push({ index, payload });
      return { messageId: `00000000-0000-4000-8000-${String(100 + sent.length).padStart(12, '0')}` };
    }),
    commandReply: async () => ({ messageId: '00000000-0000-4000-8000-000000000099' }),
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  await runtime.gateways[0].onEvent(event('2026 年的音乐社区应该如何建设？', 10));
  await waitFor(() => calls === 3 && sent.length === 2);
  assert.equal(runtime.session.snapshot().unlimited, true);
  assert.equal(runtime.session.snapshot().deadlineAt, null);
  await runtime.gateways[0].onEvent(event('停止', 11));
  await waitFor(() => runtime.session.snapshot().status === 'stopped');
  assert.equal(runtime.session.snapshot().active, false);
  assert.equal(signals[2].aborted, true);
  assert.deepEqual(sent.map(item => item.index), [0, 1]);
  assert.equal(calls, 3);
});

test('a human joins during generation, the next speaker answers them and old draft never posts', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-three-party-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 0, deadlineMs: 0, betweenTurnsMs: 0 };
  const generated = [], delivered = [], notices = [];
  let releaseOld;
  const oldDraft = new Promise(resolve => { releaseOld = resolve; });
  const initial = event('一起规划音乐社区活动', 20), addition = event('补充：预算只有1000元，优先给出免费方案', 21);
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
    clients: [0, 1].map(index => ({ async generate(messages, { signal }) {
      generated.push({ index, messages, signal });
      if (generated.length === 1) return { text: 'A建议举办社区分享会。' };
      if (generated.length === 2) return oldDraft;
      if (index === 1 && JSON.stringify(messages).includes('预算只有1000元')) return { text: 'B回应你的预算，建议使用免费场地。' };
      return new Promise(() => {});
    } })),
    replies: [0, 1].map(index => async payload => {
      delivered.push({ index, payload });
      return { messageId: `00000000-0000-4000-8000-${String(100 + delivered.length).padStart(12, '0')}` };
    }),
    commandReply: async payload => { notices.push(payload.content); return { messageId: '00000000-0000-4000-8000-000000000099' }; },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  await runtime.gateways[0].onEvent(initial);
  await waitFor(() => generated.length === 2 && delivered.length === 1);
  await runtime.gateways[0].onEvent(addition);
  await waitFor(() => generated.length >= 3);
  releaseOld({ text: '这个过时草稿没有考虑预算。' });
  await waitFor(() => delivered.length === 2 && generated.length >= 4);
  assert.equal(generated[1].signal.aborted, true);
  assert.deepEqual(generated.map(value => value.index), [0, 1, 1, 0]);
  assert.deepEqual(delivered.map(value => value.index), [0, 1]);
  assert.match(delivered[1].payload.content, /B回应你的预算/);
  assert.equal(delivered[1].payload.replyMessageId, initial.msg_id);
  assert.ok(!JSON.stringify(delivered).includes('过时草稿'));
  assert.ok(JSON.stringify(generated[2].messages).includes(initial.content));
  assert.ok(JSON.stringify(generated[2].messages).includes('A建议举办社区分享会'));
  assert.ok(JSON.stringify(generated[3].messages).includes(addition.content));
  assert.equal(runtime.snapshot().humanParticipation, true);
  assert.equal(runtime.session.snapshot().runs, 1);
  await runtime.gateways[0].onEvent(event('停止', 22));
  await waitFor(() => !runtime.session.snapshot().active);
  assert.equal(runtime.session.snapshot().status, 'stopped');
  assert.equal(delivered.length, 2);
  assert.ok(!(await readFile(path.join(dataDir, 'duet-state.json'), 'utf8')).includes('预算只有1000元'));
});

test('both identities retain the original anchor and public context after stop, a new human message and process restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-shared-thread-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 0, deadlineMs: 0, betweenTurnsMs: 0 };
  const generated = [], deliveries = [], runtimes = [];
  let runNumber = 0;
  const build = () => {
    const boot = ++runNumber; let calls = 0;
    const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
      verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
      clients: [0, 1].map(index => ({ async generate(messages, { signal }) {
        calls++; generated.push({ boot, index, messages: structuredClone(messages), signal });
        if (calls % 3 === 0) return new Promise(() => {});
        return { text: `第${boot}次启动${calls}号${index === 0 ? '甲' : '乙'}已公开回应` };
      } })),
      replies: [0, 1].map(index => async payload => {
        deliveries.push({ boot, index, payload });
        return { messageId: `00000000-0000-4000-8000-${String(500 + deliveries.length).padStart(12, '0')}` };
      }),
      commandReply: async () => ({ messageId: '00000000-0000-4000-8000-000000000099' }),
    });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => { await Promise.all(runtimes.map(runtime => runtime.close())); await rm(dataDir, { recursive: true, force: true }); });
  const first = build(); await first.start();
  const initial = event('原始话题：社区花园如何设计？', 100);
  await first.gateways[0].onEvent(initial);
  await waitFor(() => generated.length === 3 && deliveries.length === 2);
  const originalThread = first.thread.context();
  assert.equal(originalThread.anchorMessageId, initial.msg_id);
  await first.gateways[0].onEvent(event('停止', 101));
  await waitFor(() => !first.session.snapshot().active);
  assert.equal(first.thread.context().id, originalThread.id);
  const addition = { ...event('补充：花园需要适合儿童。', 102), author_id: '99999998', extra: { author: { id: '99999998', bot: false } } };
  await first.gateways[0].onEvent(addition);
  await waitFor(() => generated.length === 6 && deliveries.length === 4);
  for (const call of generated.slice(3, 5)) {
    const context = JSON.stringify(call.messages);
    assert.ok(context.includes(initial.content)); assert.ok(context.includes(addition.content));
    assert.ok(context.includes('第1次启动1号甲已公开回应'));
    assert.ok(context.includes('第1次启动2号乙已公开回应'));
  }
  assert.equal(first.thread.context().id, originalThread.id);
  assert.ok(deliveries.every(item => item.payload.replyMessageId === initial.msg_id));
  await first.gateways[0].onEvent(event('停止', 103));
  await waitFor(() => !first.session.snapshot().active); await first.close();

  const restarted = build(); await restarted.start();
  assert.equal(restarted.thread.context().id, originalThread.id);
  assert.equal(restarted.thread.context().anchorMessageId, initial.msg_id);
  assert.equal(restarted.session.snapshot().active, false);
  const afterRestart = event('继续补充：也要保留无障碍通道。', 104);
  await restarted.gateways[0].onEvent(afterRestart);
  await waitFor(() => generated.length === 9 && deliveries.length === 6);
  for (const call of generated.slice(6, 8)) {
    const context = JSON.stringify(call.messages);
    assert.ok(context.includes(initial.content)); assert.ok(context.includes(addition.content));
    assert.ok(context.includes(afterRestart.content)); assert.ok(context.includes('第1次启动4号甲已公开回应'));
    assert.ok(context.includes('第1次启动5号乙已公开回应'));
  }
  assert.equal(restarted.session.snapshot().threadId, originalThread.id);
  assert.ok(deliveries.every(item => item.payload.replyMessageId === initial.msg_id));
  assert.ok(!JSON.stringify(restarted.snapshot()).includes('社区花园'));
  await restarted.gateways[0].onEvent(event('停止', 105));
  await waitFor(() => !restarted.session.snapshot().active);
});

test('explicit new topic clears shared history, changes the anchor and blocks late old-topic replies', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-new-topic-'));
  const config = { tokens: ['fixture-a', 'fixture-b'], models: ['gpt-6-astra', 'gpt-6-astra'], labels: ['A', 'B'],
    channelId: '88888888', dataDir, host: '127.0.0.1', port: 0, rounds: 0, deadlineMs: 0, betweenTurnsMs: 0 };
  const generated = [], deliveries = [], notices = [];
  let releaseOld;
  const oldDraft = new Promise(resolve => { releaseOld = resolve; });
  const runtime = createDuetRuntime({ config, Gateway, progress: null, logger: () => {},
    verify: async () => ({ channelAccessible: true, bots: [{ botId: '11111111' }, { botId: '22222222' }] }),
    clients: [0, 1].map(index => ({ async generate(messages, { signal }) {
      generated.push({ index, messages: structuredClone(messages), signal });
      if (generated.length === 3) return oldDraft;
      if (generated.length > 4) return new Promise(() => {});
      return { text: generated.length < 3 ? `旧主题已发观点${index}` : '新主题回应：从星空观测开始。' };
    } })),
    replies: [0, 1].map(index => async payload => { deliveries.push({ index, payload });
      return { messageId: `00000000-0000-4000-8000-${String(700 + deliveries.length).padStart(12, '0')}` }; }),
    commandReply: async payload => { notices.push(payload); return { messageId: '00000000-0000-4000-8000-000000000099' }; },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  const initial = event('旧主题：烹饪晚餐', 200);
  await runtime.gateways[0].onEvent(initial); await waitFor(() => generated.length === 3 && deliveries.length === 2);
  const oldId = runtime.thread.context().id;
  await runtime.gateways[0].onEvent(event('新话题', 201));
  await waitFor(() => !runtime.session.snapshot().active);
  assert.equal(runtime.thread.context(), null); assert.equal(generated[2].signal.aborted, true);
  const fresh = { ...event('新内容：如何观测星空？', 202), author_id: '99999997', extra: { author: { id: '99999997', bot: false } } };
  await runtime.gateways[0].onEvent(fresh);
  await waitFor(() => generated.length === 5 && deliveries.length === 3);
  releaseOld({ text: '旧主题迟到草稿，绝不能发布。' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const current = runtime.thread.context();
  assert.notEqual(current.id, oldId); assert.equal(current.anchorMessageId, fresh.msg_id);
  assert.equal(current.topic, fresh.content);
  assert.ok(JSON.stringify(generated[3].messages).includes(fresh.content));
  assert.doesNotMatch(JSON.stringify(generated[3].messages), /烹饪晚餐|旧主题已发观点/);
  assert.equal(deliveries[2].payload.replyMessageId, fresh.msg_id);
  assert.doesNotMatch(JSON.stringify(current), /旧主题|烹饪晚餐/);
  assert.doesNotMatch(JSON.stringify(deliveries), /迟到草稿/);
  assert.ok(notices.some(item => item.content.includes('已清空话题')));
  await runtime.gateways[0].onEvent(event('停止', 203)); await waitFor(() => !runtime.session.snapshot().active);
});
