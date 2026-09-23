import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationThread } from '../src/conversation-thread.js';
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kook-thread-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, thread: await new ConversationThread({ dataDir }).init() };
}
test('one topic and quote survive new inputs and process restart', async t => {
  const { thread, dataDir } = await fixture(t);
  const initial = await thread.accept({ text: '原始话题', receiptId: id(1) });
  await thread.recordAssistant({ threadId: initial.id, content: '思维1的回应', speaker: '思维1' });
  const next = await thread.accept({ text: '继续补充', receiptId: id(2) });
  assert.equal(next.id, initial.id); assert.equal(next.topic, '原始话题'); assert.equal(next.anchorMessageId, id(1));
  const restored = await new ConversationThread({ dataDir }).init();
  assert.deepEqual(restored.context(), next);
  assert.equal(JSON.stringify(restored.snapshot()).includes('原始话题'), false);
});
test('explicit reset alone creates a new anchor and rejects late old-thread replies', async t => {
  const { thread } = await fixture(t);
  const initial = await thread.accept({ text: '旧话题', receiptId: id(1) });
  await thread.reset(); await thread.accept({ text: '新内容', receiptId: id(2) });
  await thread.recordAssistant({ threadId: initial.id, content: '迟到回复', speaker: '思维2' });
  assert.equal(thread.context().anchorMessageId, id(2)); assert.equal(thread.context().messages.length, 1);
  assert.notEqual(thread.context().id, initial.id);
});
test('duplicate input is not appended and history remains bounded without dropping original topic', async t => {
  const { thread } = await fixture(t);
  const first = await thread.accept({ text: '持续话题', receiptId: id(1) });
  await thread.accept({ text: '持续话题', receiptId: id(1) }); assert.equal(thread.context().messages.length, 1);
  for (let n = 2; n < 35; n++) await thread.recordAssistant({ threadId: first.id, content: '字'.repeat(5999) + '😀', speaker: '思维1' });
  assert.ok(thread.context().messages.every(item => item.content.isWellFormed()));
  assert.ok(thread.context().messages.reduce((sum, item) => sum + item.content.length, 0) <= 24000);
  assert.equal(thread.context().topic, '持续话题');
});
test('failed durable write does not replace the current topic', async t => {
  const { thread, dataDir } = await fixture(t);
  await thread.accept({ text: '已有话题', receiptId: id(1) });
  const blocked = await new ConversationThread({ dataDir, writeState: async () => { throw Error('disk'); } }).init();
  await assert.rejects(blocked.reset()); assert.equal(blocked.context().topic, '已有话题');
});

test('imported user and assistant credentials are excluded from saved shared context', async t => {
  const { thread, dataDir } = await fixture(t);
  const secret = 'sk-fixture_should_never_persist';
  const state = await thread.accept({ text: `历史内容 ${secret}`, receiptId: id(1) });
  await thread.recordAssistant({ threadId: state.id, content: 'Authorization: Bearer fixture-secret-credential', speaker: '思维1' });
  const raw = await readFile(path.join(dataDir, 'conversation-thread.json'), 'utf8');
  assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('fixture-secret-credential'));
  assert.match(raw, /已隐藏密钥/);
});
