import test from 'node:test';
import assert from 'node:assert/strict';
import { createKookReply } from '../src/kook-reply.js';

test('duet output remains plain text even when it quotes SVG code', async () => {
  const calls = [];
  const reply = createKookReply({ token: 'fixture-duet-token', fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ code: 0, data: { msg_id: '00000000-0000-4000-8000-000000000001' } }));
  } });
  const content = '讨论 SVG 示例：<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
  await reply({ targetId: '88888888', replyMessageId: '00000000-0000-4000-8000-000000000002', content, textOnly: true });
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/message/create'));
  const modules = JSON.parse(calls[0].body.content)[0].modules;
  assert.equal(modules[0].text.type, 'plain-text'); assert.equal(modules[0].text.content, content);
  assert.ok(modules.every(module => module.type === 'section'));
});
