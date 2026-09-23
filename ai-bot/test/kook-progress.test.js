import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKookProgress, KookProgressError } from '../src/kook-progress.js';

const TOKEN = 'fixture-private-progress-token';
const targetId = '1234567890123456';
const replyMessageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sentId = '50974c-364c983fa6cb';
const input = { targetId, replyMessageId };
const success = () => Response.json({ code: 0, data: { msg_id: sentId } });
const updateSuccess = () => Response.json({ code: 0, data: [] });
const code = expected => caught => caught instanceof KookProgressError && caught.code === expected && !caught.message.includes(TOKEN);
const body = call => JSON.parse(call.init.body);
const card = call => JSON.parse(body(call).content)[0];
const text = call => card(call).modules.map(module => module.text?.content || module.elements?.map(element => element.content).join('\n')).join('\n');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settled = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function harness(options = {}) {
  const calls = [], timers = new Map(), cleared = [];
  let time = 1_000_000, id = 0;
  const fetchImpl = options.fetchImpl || (async url => String(url).endsWith('/message/create') ? success() : updateSuccess());
  const progress = createKookProgress({ token: TOKEN,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    now: () => time,
    setIntervalImpl: (callback, ms) => { const key = ++id; timers.set(key, { callback, ms }); return key; },
    clearIntervalImpl: key => { cleared.push(key); timers.delete(key); },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'fetchImpl')),
  });
  return { progress, calls, timers, cleared, advance(ms) { time += ms; }, tick() { for (const timer of [...timers.values()]) timer.callback(); } };
}

test('pause freezes elapsed time, resume preserves the card and safe action detail shows real work', async () => {
  const h = harness(); const handle = await h.progress.start(input);
  h.advance(12000); await handle.setDetail('读取 ai-bot/src/duet-session.js');
  await handle.pause(); assert.match(text(h.calls.at(-1)), /已暂停/); assert.match(text(h.calls.at(-1)), /00:12/);
  assert.equal(h.timers.size, 0); const count = h.calls.length;
  h.advance(60000); h.tick(); await settled(); assert.equal(h.calls.length, count);
  await handle.resume(); assert.equal(h.timers.size, 1); assert.match(text(h.calls.at(-1)), /00:12/);
  assert.match(text(h.calls.at(-1)), /读取 ai-bot/);
  await handle.setDetail('sk-private-secret-do-not-log'); assert.doesNotMatch(text(h.calls.at(-1)), /private-secret/);
  h.advance(8000); await handle.pause(); h.advance(20000); await handle.finish();
  assert.match(text(h.calls.at(-1)), /已完成/); assert.match(text(h.calls.at(-1)), /00:20/);
  const terminalCount=h.calls.length; await handle.resume(); await handle.setDetail('late detail');
  assert.equal(h.calls.length, terminalCount); assert.equal(h.timers.size, 0);
});

test('creates one quoted status card using the official endpoint and only fixed stage text', async () => {
  const h = harness(); const handle = await h.progress.start({ ...input, content: TOKEN, model: TOKEN });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0], data = body(call);
  assert.equal(call.url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.headers.Authorization, `Bot ${TOKEN}`);
  assert.equal(data.type, 10); assert.equal(data.target_id, targetId);
  assert.equal(data.quote, replyMessageId); assert.equal(data.reply_msg_id, replyMessageId);
  assert.match(text(call), /✓ 已接收/); assert.match(text(call), /⏳ AI 生成中/); assert.match(text(call), /00:00/);
  assert.equal(call.init.body.includes(TOKEN), false);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 15000);
  assert.equal(card(call).size, 'sm');
  await handle.finish();
});

test('updates the same card with elapsed time and finite actual stages, without percentages or an extra message', async () => {
  const h = harness(); const handle = await h.progress.start(input);
  h.advance(15000); h.tick(); await settled();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, 'https://www.kookapp.cn/api/v3/message/update');
  assert.deepEqual(Object.keys(body(h.calls[1])).sort(), ['content', 'msg_id']);
  assert.equal(body(h.calls[1]).msg_id, sentId);
  assert.match(text(h.calls[1]), /00:15/);
  await handle.setPhase('rendering');
  assert.match(text(h.calls.at(-1)), /✓ AI 已生成/); assert.match(text(h.calls.at(-1)), /⏳ 渲染图片/);
  await handle.setPhase('uploading'); await handle.setPhase('sending');
  assert.match(text(h.calls.at(-1)), /✓ 图片已渲染/); assert.match(text(h.calls.at(-1)), /✓ 内容已上传/);
  assert.match(text(h.calls.at(-1)), /⏳ 发送回复/);
  const before = h.calls.length;
  await handle.setPhase('sending'); await handle.setPhase('received'); await handle.setPhase(TOKEN);
  assert.equal(h.calls.length, before);
  assert.ok(h.calls.every(call => !text(call).includes('%') && !text(call).includes(TOKEN)));
  assert.equal(h.calls.filter(call => call.url.endsWith('/create')).length, 1);
  h.advance(9000); await handle.finish();
  assert.match(text(h.calls.at(-1)), /已完成/); assert.match(text(h.calls.at(-1)), /00:24/);
  assert.equal(card(h.calls.at(-1)).theme, 'success');
  assert.equal(h.timers.size, 0);
});

test('coalesces ticks and phase changes while a request is pending and sends the terminal state last', async () => {
  const wait = deferred(); let active = 0, maximum = 0, updates = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    active++; maximum = Math.max(maximum, active); updates++;
    if (updates === 1) await wait.promise;
    active--; return updateSuccess();
  } });
  const handle = await h.progress.start(input);
  h.advance(15000); h.tick();
  for (let i = 0; i < 100; i++) h.tick();
  void handle.setPhase('rendering'); void handle.setPhase('uploading');
  const finishing = handle.finish(); void handle.setPhase('sending'); void handle.fail(TOKEN); void handle.cancel();
  assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
  wait.resolve(); await finishing;
  assert.equal(maximum, 1); assert.equal(h.calls.length, 3);
  assert.match(text(h.calls.at(-1)), /已完成/); assert.match(text(h.calls.at(-1)), /✓ 内容已上传/);
  assert.doesNotMatch(text(h.calls.at(-1)), /发送回复|处理失败|已取消/);
  h.tick(); await handle.finish(); await handle.cancel();
  assert.equal(h.calls.length, 3);
});

test('coalesces a burst into the latest stage after the in-flight update', async () => {
  const wait = deferred(); let updates = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    if (++updates === 1) await wait.promise;
    return updateSuccess();
  } });
  const handle = await h.progress.start(input);
  h.tick(); void handle.setPhase('rendering'); const latest = handle.setPhase('uploading');
  for (let i = 0; i < 30; i++) h.tick();
  wait.resolve(); await latest;
  assert.equal(h.calls.length, 3); assert.match(text(h.calls.at(-1)), /⏳ 上传内容/);
  assert.match(text(h.calls.at(-1)), /✓ 图片已渲染/);
  await handle.finish();
});

test('failure details use the fixed whitelist and freeze elapsed time', async () => {
  for (const [failure, expected] of [['TIMEOUT', 'AI 回复超时'], [TOKEN, 'AI 暂时无法回复']]) {
    const h = harness(); const handle = await h.progress.start(input);
    h.advance(61234); await handle.fail(failure);
    const failed = h.calls.at(-1);
    assert.match(text(failed), /处理失败/); assert.ok(text(failed).includes(expected));
    assert.match(text(failed), /01:01/); assert.equal(card(failed).theme, 'danger');
    assert.equal(text(failed).includes(TOKEN), false);
    const before = h.calls.length; h.advance(90000); h.tick(); await handle.finish();
    assert.equal(h.calls.length, before); assert.equal(h.timers.size, 0);
  }
});

test('continuous conversations keep accurate elapsed time after 24 hours', async () => {
  const h = harness(); const handle = await h.progress.start(input);
  h.advance((25 * 3600 + 61) * 1000);
  h.tick(); await settled();
  assert.match(text(h.calls.at(-1)), /25:01:01/);
  await handle.finish();
  assert.match(text(h.calls.at(-1)), /25:01:01/);
  assert.equal(h.timers.size, 0);
});

test('caller abort cancels the status with a fresh bounded request and prevents later updates', async () => {
  const caller = new AbortController(), h = harness();
  const handle = await h.progress.start({ ...input, signal: caller.signal });
  caller.abort(new Error(TOKEN));
  await handle.cancel();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 2);
  assert.match(text(h.calls[1]), /已取消/); assert.equal(card(h.calls[1]).theme, 'warning');
  assert.equal(h.calls[1].init.signal.aborted, false);
  h.tick(); await handle.setPhase('uploading'); await handle.finish();
  assert.equal(h.calls.length, 2);
});

test('abort while an update is pending serializes one cancellation after it', async () => {
  const wait = deferred(), caller = new AbortController(); let updates = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    if (++updates === 1) await wait.promise;
    return updateSuccess();
  } });
  const handle = await h.progress.start({ ...input, signal: caller.signal });
  h.tick(); caller.abort(); const closing = handle.cancel();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 2);
  wait.resolve(); await closing;
  assert.equal(h.calls.length, 3); assert.match(text(h.calls.at(-1)), /已取消/);
  await handle.fail('TIMEOUT'); assert.equal(h.calls.length, 3);
});

test('transient update failures retry the newest state and return to the normal refresh interval', async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 'network']) {
    let updates = 0;
    const h = harness({ fetchImpl: async url => {
      if (url.endsWith('/create')) return success();
      if (++updates > 1) return updateSuccess();
      if (status === 'network') throw new Error(TOKEN);
      return Response.json({ message: TOKEN }, { status });
    } });
    const handle = await h.progress.start(input);
    h.tick(); await settled();
    assert.equal(h.timers.size, 1);
    const delay = [...h.timers.values()][0].ms;
    assert.equal(delay, status === 429 ? 15000 : 2000);
    await handle.setPhase('uploading'); await handle.setDetail('正在上传');
    assert.equal(updates, 1, 'State changes must not bypass retry backoff');
    h.advance(delay); h.tick(); await settled();
    assert.equal(updates, 2); assert.match(text(h.calls.at(-1)), /上传内容/);
    assert.match(text(h.calls.at(-1)), /正在上传/);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 15000);
    await handle.finish(); assert.equal(h.timers.size, 0);
    assert.equal(h.calls.filter(call => call.url.endsWith('/create')).length, 1);
  }
});

test('rate-limit delays honor Retry-After and survive pause, resume and terminal transitions', async () => {
  for (const [header, delay] of [['45', 45000], [new Date(1060000).toUTCString(), 60000],
    ['999999999999', 300000], ['invalid', 15000], ['1.5', 15000], ['1', 15000]]) {
    let updates = 0;
    const h = harness({ fetchImpl: async url => {
      if (url.endsWith('/create')) return success();
      return ++updates === 1 ? Response.json({}, { status: 429, headers: { 'Retry-After': header } }) : updateSuccess();
    } });
    const handle = await h.progress.start(input);
    h.tick(); await settled(); const originalTimer = [...h.timers.keys()][0];
    assert.equal([...h.timers.values()][0].ms, delay);
    await handle.pause(); await handle.resume(); await handle.resume(); await handle.finish();
    assert.equal(updates, 1); assert.deepEqual([...h.timers.keys()], [originalTimer]);
    h.advance(delay); h.tick(); await settled();
    assert.equal(updates, 2); assert.match(text(h.calls.at(-1)), /已完成/);
    assert.equal(h.timers.size, 0);
  }
});

test('repeated transient updates back off to a bounded delay without accumulating schedulers', async () => {
  let updates = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    return ++updates <= 5 ? Response.json({}, { status: 500 }) : updateSuccess();
  } });
  const handle = await h.progress.start(input);
  h.tick(); await settled();
  const abandoned = [...h.timers.values()][0].callback;
  for (const delay of [2000, 4000, 8000, 15000, 15000]) {
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, delay);
    h.advance(delay); h.tick(); await settled();
  }
  assert.equal(updates, 6); assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 15000);
  await handle.finish(); const completed = h.calls.length;
  abandoned(); await settled(); assert.equal(h.calls.length, completed); assert.equal(h.timers.size, 0);
});

test('timed-out updates recover and late abandoned responses cannot revive completed updates', async () => {
  const late = deferred(); let updates = 0, abandonedSignal;
  const h = harness({ timeoutMs: 10, fetchImpl: async (url, init) => {
    if (url.endsWith('/create')) return success();
    if (++updates === 1) { abandonedSignal = init.signal; return late.promise; }
    return updateSuccess();
  } });
  const handle = await h.progress.start(input);
  await handle.setPhase('uploading'); assert.equal(abandonedSignal.aborted, true);
  await handle.setDetail('最新状态'); await handle.finish();
  assert.equal(updates, 1); assert.equal(h.timers.size, 1);
  h.tick(); await handle.finish();
  assert.equal(updates, 2); assert.equal(h.timers.size, 0);
  assert.match(text(h.calls.at(-1)), /已完成/); assert.match(text(h.calls.at(-1)), /最新状态/);
  late.resolve(updateSuccess()); await settled();
  assert.equal(updates, 2); assert.equal(h.timers.size, 0);
});

test('paused status retries without counting paused time or creating duplicate tickers on resume', async () => {
  let updates = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    return ++updates === 1 ? Response.json({}, { status: 503 }) : updateSuccess();
  } });
  const handle = await h.progress.start(input);
  h.advance(12000); await handle.pause(); assert.equal(h.timers.size, 1);
  h.advance(60000); h.tick(); await settled();
  assert.match(text(h.calls.at(-1)), /已暂停/); assert.match(text(h.calls.at(-1)), /00:12/);
  assert.equal(h.timers.size, 0);
  await handle.resume(); const timer = [...h.timers.keys()][0]; await handle.resume();
  assert.deepEqual([...h.timers.keys()], [timer]);
  h.advance(8000); await handle.pause(); h.advance(10000); await handle.finish();
  assert.match(text(h.calls.at(-1)), /00:20/); assert.equal(h.timers.size, 0);
});

test('terminal updates retry in the background with fixed content and stop after success or three attempts', async () => {
  for (const succeeds of [true, false]) {
    let updates = 0;
    const h = harness({ fetchImpl: async url => {
      if (url.endsWith('/create')) return success();
      return ++updates === 3 && succeeds ? updateSuccess() : Response.json({}, { status: 503 });
    } });
    const handle = await h.progress.start(input);
    h.advance(12345); await handle.finish();
    assert.equal(updates, 1, 'finish returns before the scheduled retries');
    const terminalContent = body(h.calls.at(-1)).content;
    await handle.fail('AUTH'); await handle.cancel(); await handle.setDetail('late'); await handle.resume();
    assert.equal(updates, 1);
    for (const delay of [2000, 4000]) {
      assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, delay);
      h.advance(60000); h.tick(); await handle.finish();
      assert.equal(body(h.calls.at(-1)).content, terminalContent);
    }
    assert.equal(updates, 3); assert.equal(h.timers.size, 0);
    h.tick(); await handle.finish(); assert.equal(updates, 3);
  }
});

test('a failing in-flight update cannot override terminal state or start overlapping retries', async () => {
  const wait = deferred(); let updates = 0, active = 0, maximum = 0;
  const h = harness({ fetchImpl: async url => {
    if (url.endsWith('/create')) return success();
    active++; maximum = Math.max(maximum, active);
    const attempt = ++updates;
    if (attempt === 1) await wait.promise;
    active--; return attempt === 1 ? Response.json({}, { status: 503 }) : updateSuccess();
  } });
  const handle = await h.progress.start(input);
  h.tick(); void handle.setPhase('sending'); const finishing = handle.finish();
  for (let i = 0; i < 20; i++) h.tick();
  wait.resolve(); await finishing;
  assert.equal(updates, 1); assert.equal(h.timers.size, 1);
  h.tick(); await handle.finish();
  assert.equal(updates, 2); assert.equal(maximum, 1); assert.match(text(h.calls.at(-1)), /已完成/);
  assert.equal(h.timers.size, 0);
});

test('permanent HTTP, API and format rejections stop all updates without retrying', async () => {
  for (const rejected of [() => Response.json({}, { status: 400 }), () => Response.json({}, { status: 401 }),
    () => Response.json({}, { status: 403 }), () => Response.json({}, { status: 404 }),
    () => Response.json({}, { status: 302 }), () => Response.json({}, { status: 501 }),
    () => Response.json({ code: 40000, message: TOKEN }), () => new Response('not json')]) {
    const h = harness({ fetchImpl: async url => url.endsWith('/create') ? success() : rejected() });
    const handle = await h.progress.start(input);
    h.tick(); await settled(); assert.equal(h.timers.size, 0);
    await handle.setPhase('rendering'); await handle.pause(); await handle.resume(); await handle.finish();
    h.tick(); assert.equal(h.calls.length, 2);
  }
});

test('background terminal retries do not keep a completed short-lived process alive', async () => {
  const moduleUrl = new URL('../src/kook-progress.js', import.meta.url).href;
  const script = `import { createKookProgress } from ${JSON.stringify(moduleUrl)};
    const progress = createKookProgress({ token: 'fixture-only', fetchImpl: async url => url.endsWith('/create')
      ? Response.json({ code: 0, data: { msg_id: ${JSON.stringify(sentId)} } }) : Response.json({}, { status: 503 }) });
    const handle = await progress.start(${JSON.stringify(input)}); await handle.finish(); process.stdout.write('finished');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, windowsHide: true });
  assert.equal(result.stdout, 'finished'); assert.equal(result.stderr, '');
});

test('invalid input and pre-aborted requests do not create cards', async () => {
  const h = harness();
  for (const value of [{ targetId: TOKEN, replyMessageId }, { targetId, replyMessageId: TOKEN }, { targetId: Number(targetId), replyMessageId }]) await assert.rejects(h.progress.start(value), code('KOOK_INVALID_INPUT'));
  const caller = new AbortController(); caller.abort(TOKEN);
  await assert.rejects(h.progress.start({ ...input, signal: caller.signal }), code('KOOK_ABORTED'));
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  for (const options of [{ token: '' }, { token: `secret\n${TOKEN}` }, { timeoutMs: 0 }, { intervalMs: 0 }, { fetchImpl: null }, { now: null }]) assert.throws(() => createKookProgress({ token: TOKEN, ...options }), code('KOOK_INVALID_INPUT'));
});

test('initial HTTP, API, redirect, JSON and network failures stay sanitized and are never retried', async () => {
  for (const [status, expected] of [[401, 'KOOK_REJECTED'], [403, 'KOOK_REJECTED'], [302, 'KOOK_REJECTED'], [429, 'KOOK_RATE_LIMITED'], [500, 'KOOK_REJECTED']]) {
    const h = harness({ fetchImpl: async () => Response.json({ message: TOKEN }, { status }) });
    await assert.rejects(h.progress.start(input), code(expected));
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  }
  for (const fetchImpl of [async () => Response.json({ code: 40000, message: TOKEN }), async () => Response.json({ code: 0, data: { msg_id: TOKEN } }), async () => new Response(TOKEN), async () => { throw new Error(TOKEN); }]) {
    const h = harness({ fetchImpl });
    await assert.rejects(h.progress.start(input), caught => caught instanceof KookProgressError && !String(caught).includes(TOKEN));
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  }
});

test('enforces the 32KB response bound on headers and streamed bytes', async () => {
  for (const fetchImpl of [async () => new Response('x', { headers: { 'content-length': String(32 * 1024 + 1) } }), async () => new Response('x'.repeat(32 * 1024 + 1))]) {
    const h = harness({ fetchImpl });
    await assert.rejects(h.progress.start(input), code('KOOK_RESPONSE_TOO_LARGE'));
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  }
});

test('initial timeout and abort bound even an uncooperative request', async () => {
  let pendingSignal;
  const h = harness({ timeoutMs: 10, fetchImpl: async (_url, init) => { pendingSignal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(h.progress.start(input), code('KOOK_TIMEOUT'));
  assert.equal(pendingSignal.aborted, true); assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1);
  const caller = new AbortController(), h2 = harness({ fetchImpl: async () => new Promise(() => {}) });
  const pending = h2.progress.start({ ...input, signal: caller.signal });
  caller.abort(new Error(TOKEN)); await assert.rejects(pending, code('KOOK_ABORTED'));
  assert.equal(h2.calls.length, 1); assert.equal(h2.timers.size, 0);
});

test('timeout also bounds a hanging body and final status updates', async () => {
  let cancelled = false;
  const h = harness({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } })) });
  await assert.rejects(h.progress.start(input), code('KOOK_TIMEOUT'));
  assert.equal(cancelled, true);
  const final = harness({ timeoutMs: 10, fetchImpl: async url => url.endsWith('/create') ? success() : new Promise(() => {}) });
  const handle = await final.progress.start(input);
  await assert.doesNotReject(handle.finish());
  await handle.cancel(); assert.equal(final.calls.length, 2); assert.equal(final.timers.size, 1);
  for (let attempt = 0; attempt < 2; attempt++) { final.tick(); await handle.finish(); }
  assert.equal(final.calls.length, 4); assert.equal(final.timers.size, 0);
});
