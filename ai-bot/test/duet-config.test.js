import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadDuetConfig } from '../src/duet-config.js';
import { doctorDuet } from '../src/duet-doctor.js';

const env = { KOOK_BOT_A_TOKEN: 'fixture-bot-a-private-token', KOOK_BOT_B_TOKEN: 'fixture-bot-b-private-token',
  KOOK_CHANNEL_ID: '1234567890123456', OPENAI_API_KEY: 'sk-fixture-private-key' };
const safeError = error => !Object.values(env).some(value => error.message.includes(value));

test('duet defaults use two separate bots, continuous discussion and an independent local health port', () => {
  const config = loadDuetConfig(env);
  assert.deepEqual(config.tokens, [env.KOOK_BOT_A_TOKEN, env.KOOK_BOT_B_TOKEN]);
  assert.deepEqual(config.models, ['gpt-6-astra', 'gpt-6-astra']);
  assert.deepEqual(config.labels, ['机器人A', '机器人B']);
  assert.equal(config.rounds, 0); assert.equal(config.deadlineMs, 0); assert.equal(config.betweenTurnsMs, 2000);
  assert.equal(config.modelTimeoutMs, 180000); assert.equal(config.maxOutputTokens, 1200); assert.equal(config.reasoningEffort, 'low');
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 19000); assert.equal(config.dataDir, path.resolve('./data'));
  assert.equal(config.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.match(config.systemPrompts[0], /提出观点/); assert.match(config.systemPrompts[1], /审阅与改进/);
  for (const prompt of config.systemPrompts) {
    assert.match(prompt, /100—200/); assert.match(prompt, /讨论素材/); assert.match(prompt, /没有联网、工具/);
    assert.doesNotMatch(prompt, /有轮数限制/);
    assert.ok(Object.values(env).every(value => !prompt.includes(value)));
  }
});

test('zero explicitly disables both total discussion limits while request timeout remains active', () => {
  const config = loadDuetConfig({ ...env, DUET_ROUNDS: '0', DUET_DEADLINE_SECONDS: '0' });
  assert.equal(config.rounds, 0); assert.equal(config.deadlineMs, 0);
  assert.equal(config.modelTimeoutMs, 180000); assert.equal(config.betweenTurnsMs, 2000);
  const finite = loadDuetConfig({ ...env, DUET_ROUNDS: '6', DUET_DEADLINE_SECONDS: '600' });
  assert.equal(finite.rounds, 6); assert.equal(finite.deadlineMs, 600000);
});

test('both distinct roles prioritize current human contributions and requested brevity without exposing credentials', () => {
  const config = loadDuetConfig({ ...env, BOT_A_LABEL: '构想者', BOT_B_LABEL: '审阅者' });
  assert.match(config.systemPrompts[0], /你是构想者.*提出观点、具体方案和例子/);
  assert.match(config.systemPrompts[1], /你是审阅者.*审阅与改进/);
  for (const prompt of config.systemPrompts) {
    assert.match(prompt, /人类参与者与两个 AI 的共同讨论/);
    assert.match(prompt, /优先回应最新的人类问题、约束与纠正，再回应另一位 AI/);
    assert.match(prompt, /原始主题和已提供的近期公开上下文/);
    assert.match(prompt, /人类明确指定一句话、字数、语言或格式时优先遵守，不再套用默认字数/);
    assert.match(prompt, /不冒充人类或另一位 AI/);
    assert.match(prompt, /不输出或索取凭据/);
    assert.ok(Object.values(env).every(secret => !prompt.includes(secret)));
  }
  assert.equal(config.rounds, 0); assert.equal(config.deadlineMs, 0);
});

test('model overrides, limits, role labels and data directory resolve independently', () => {
  const config = loadDuetConfig({ ...env, OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_MODEL: 'shared-model',
    DUET_MODEL_B: 'second-model', BOT_A_LABEL: '构想者', BOT_B_LABEL: '审阅者', HOST: '::1', PORT: '19100', DATA_DIR: './duet-data',
    DUET_ROUNDS: '2', DUET_DEADLINE_SECONDS: '90', DUET_BETWEEN_TURNS_MS: '500', DUET_MAX_OUTPUT_TOKENS: '2400',
    REASONING_EFFORT: 'medium', MODEL_TIMEOUT_SECONDS: '60' });
  assert.deepEqual(config.models, ['shared-model', 'second-model']);
  assert.deepEqual(config.labels, ['构想者', '审阅者']);
  assert.match(config.systemPrompts[0], /你是构想者/); assert.match(config.systemPrompts[1], /你是审阅者/);
  assert.equal(config.dataDir, path.resolve('./duet-data'));
  assert.equal(config.rounds, 2); assert.equal(config.deadlineMs, 90000); assert.equal(config.betweenTurnsMs, 500);
  assert.equal(config.maxOutputTokens, 2400); assert.equal(config.modelTimeoutMs, 60000); assert.equal(config.port, 19100);
});

test('missing or duplicate credentials and non-loopback health hosts fail without secret echo', () => {
  for (const changes of [{ KOOK_BOT_A_TOKEN: '' }, { KOOK_BOT_B_TOKEN: '' }, { KOOK_BOT_B_TOKEN: env.KOOK_BOT_A_TOKEN },
    { KOOK_BOT_A_TOKEN: `${env.KOOK_BOT_A_TOKEN}\nother` }, { OPENAI_API_KEY: '' }, { KOOK_CHANNEL_ID: '123157x' },
    { HOST: '0.0.0.0' }, { HOST: '192.168.1.1' }, { PORT: '0' }, { DATA_DIR: 42 }]) {
    assert.throws(() => loadDuetConfig({ ...env, ...changes }), safeError);
  }
});

test('optional discussion limits and labels reject malformed or excessive values', () => {
  for (const changes of [{ DUET_ROUNDS: '7' }, { DUET_ROUNDS: '-1' }, { DUET_ROUNDS: '1.5' }, { DUET_ROUNDS: 2 },
    { DUET_DEADLINE_SECONDS: '601' }, { DUET_DEADLINE_SECONDS: '-1' }, { DUET_DEADLINE_SECONDS: '1' }, { DUET_DEADLINE_SECONDS: '29' },
    { DUET_BETWEEN_TURNS_MS: '-1' }, { DUET_BETWEEN_TURNS_MS: '30001' },
    { DUET_MAX_OUTPUT_TOKENS: '2401' }, { DUET_MAX_OUTPUT_TOKENS: '0' }, { MODEL_TIMEOUT_SECONDS: '181' },
    { BOT_A_LABEL: '(met)all(met)' }, { BOT_A_LABEL: 'a'.repeat(33) }, { BOT_A_LABEL: 'same', BOT_B_LABEL: 'same' },
    { DUET_MODEL_A: 'bad model' }, { REASONING_EFFORT: 'unlimited' }]) assert.throws(() => loadDuetConfig({ ...env, ...changes }), safeError);
});

test('model endpoint validation matches the Responses client and does not access network', () => {
  for (const baseUrl of ['https://example.invalid', 'https://example.invalid/v1/', 'http://localhost:8080/v1', 'http://[::1]:8080/v1']) {
    assert.doesNotThrow(() => loadDuetConfig({ ...env, OPENAI_BASE_URL: baseUrl }));
  }
  for (const baseUrl of ['http://example.invalid', 'https://example.invalid/arbitrary', 'https://user:secret@example.invalid',
    'https://example.invalid?secret=value', 'file:///tmp/model']) assert.throws(() => loadDuetConfig({ ...env, OPENAI_BASE_URL: baseUrl }), safeError);
});

function fetchDoctor(calls, mutate = body => body) {
  return async (url, init) => {
    calls.push({ url, init });
    const isA = init.headers.Authorization === `Bot ${env.KOOK_BOT_A_TOKEN}`;
    const data = url.includes('/user/me') ? { id: isA ? '111111111' : '222222222', username: isA ? '测试甲' : '测试乙', bot: true }
      : { id: env.KOOK_CHANNEL_ID, type: 1, name: '公开互聊' };
    return Response.json({ code: 0, data: mutate(data, url, isA) });
  };
}

test('doctor default performs four read-only identity/access checks with no model calls or messages', async () => {
  const calls = [], config = loadDuetConfig(env);
  const result = await doctorDuet(config, { fetchImpl: fetchDoctor(calls) });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.init.method === 'GET' && call.init.redirect === 'error'
    && /^https:\/\/www\.kookapp\.cn\/api\/v3\/(user\/me|channel\/view\?target_id=\d+)$/.test(call.url)));
  assert.deepEqual(result.bots.map(bot => bot.botId), ['111111111', '222222222']);
  assert.equal(result.channelAccessible, true); assert.equal(result.channelName, '公开互聊');
  assert.equal(result.bots[0].modelConnected, undefined);
  assert.ok([env.KOOK_BOT_A_TOKEN, env.KOOK_BOT_B_TOKEN, env.OPENAI_API_KEY].every(secret => !JSON.stringify(result).includes(secret)));
});

test('doctor rejects same bot identity, inaccessible channel, voice channel and false bot identity', async () => {
  for (const mutate of [data => data.username ? { ...data, id: '111111111' } : data,
    data => data.type ? { ...data, id: '99999999' } : data,
    data => data.type ? { ...data, type: 2 } : data,
    data => data.username ? { ...data, bot: false } : data]) {
    await assert.rejects(doctorDuet(loadDuetConfig(env), { fetchImpl: fetchDoctor([], mutate) }), safeError);
  }
});

test('doctor suppresses sensitive upstream failures and bounds JSON response size', async () => {
  for (const fetchImpl of [async () => Response.json({ code: 40000, message: env.OPENAI_API_KEY }),
    async () => new Response(env.OPENAI_API_KEY, { status: 403 }), async () => { throw new Error(env.KOOK_BOT_A_TOKEN); },
    async () => new Response('x'.repeat(32 * 1024 + 1)), async () => new Response('x', { headers: { 'content-length': '9999999' } })]) {
    await assert.rejects(doctorDuet(loadDuetConfig(env), { fetchImpl }), safeError);
  }
});

test('doctor prevents credentials in account or channel display names from being echoed', async () => {
  const result = await doctorDuet(loadDuetConfig(env), { fetchImpl: fetchDoctor([], data => data.username
    ? { ...data, username: env.KOOK_BOT_A_TOKEN } : { ...data, name: env.OPENAI_API_KEY }) });
  assert.deepEqual(result.bots.map(bot => bot.botName), ['机器人A', '机器人B']);
  assert.equal(result.channelName, '互聊文字频道');
});

test('doctor times out even when an injected fetch ignores abort', async () => {
  const signals = [];
  await assert.rejects(doctorDuet(loadDuetConfig(env), { timeoutMs: 10, fetchImpl: async (_url, init) => {
    signals.push(init.signal); return new Promise(() => {});
  } }), safeError);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(signals.length, 4); assert.ok(signals.every(signal => signal.aborted));
});

test('optional model probe sends exactly two brief requests, no KOOK writes, and never returns generated content', async () => {
  const calls = [], readonly = fetchDoctor(calls);
  const result = await doctorDuet(loadDuetConfig(env), { testModel: true, fetchImpl: async (url, init) => {
    if (url.startsWith('https://www.kookapp.cn/')) return readonly(url, init);
    calls.push({ url, init });
    return Response.json({ model: 'gpt-6-astra', status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '连接成功，fixture-secret-output' }] }], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
  } });
  const probes = calls.filter(call => call.init.method === 'POST');
  assert.equal(probes.length, 2); assert.ok(probes.every(call => call.url === 'http://127.0.0.1:8080/v1/responses'));
  assert.ok(probes.every(call => JSON.parse(call.init.body).max_output_tokens === 256));
  assert.ok(result.bots.every(bot => bot.modelConnected && bot.modelReported === 'gpt-6-astra'));
  assert.equal(JSON.stringify(result).includes('fixture-secret-output'), false);
});
