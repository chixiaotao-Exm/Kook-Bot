import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcr } from '../src/ocr.js';

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(4), Buffer.from('IHDR'), Buffer.alloc(12)]);
const event = { content: '', extra: { attachments: [{ url: 'https://img.kookapp.cn/assets/evidence.png' }] } };
const jsonl = text => Buffer.from(JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: [text], rec_scores: [0.99] } }] } }) + '\n');
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });

function fetchOk() {
  return async (url, options = {}) => {
    if (url.includes('img.kookapp.cn')) return response(png, 200, { 'content-type': 'image/png' });
    if (options.method === 'POST') return response(JSON.stringify({ data: { jobId: 'job-1' } }), 200, { 'content-type': 'application/json' });
    if (url.endsWith('/job-1')) return response(JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: 'https://aistudio-app.com/results/x.jsonl' } } }));
    if (url.includes('aistudio-app.com/results')) return response(jsonl('[TEST] Player_01'));
    throw new Error('unexpected URL');
  };
}

test('uploads a trusted KOOK image, polls and returns one confident raw line', async () => {
  const ocr = createOcr({ token: 'token', fetchImpl: fetchOk(), pollIntervalMs: 1 });
  assert.equal(await ocr(event), '[TEST] Player_01');
});

test('rejects untrusted image URLs and does not fetch them', async () => {
  let calls = 0;
  const ocr = createOcr({ token: 'token', fetchImpl: async () => { calls++; throw new Error(); }, pollIntervalMs: 1, totalTimeoutMs: 50 });
  await assert.rejects(ocr({ content: 'https://evil.example/a.png', extra: {} }), error => error.code === 'unsafe_url');
  assert.equal(calls, 0);
});

test('rejects fake image bytes and unsafe result URL', async () => {
  const fake = async (url, options = {}) => url.includes('img.kookapp.cn') ? response(Buffer.from('not-image')) : fetchOk()(url, options);
  const ocr = createOcr({ token: 'token', fetchImpl: fake, pollIntervalMs: 1 });
  await assert.rejects(ocr(event), error => error.code === 'unsupported_image');
  const unsafe = async (url, options = {}) => {
    if (url.includes('img.kookapp.cn')) return response(png);
    if (options.method === 'POST') return response(JSON.stringify({ data: { jobId: 'x' } }));
    if (url.endsWith('/x')) return response(JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: 'https://evil.example/a.jsonl' } } }));
    return fetchOk()(url, options);
  };
  await assert.rejects(createOcr({ token: 'token', fetchImpl: unsafe, pollIntervalMs: 1 })(event), error => error.code === 'unsafe_url');
});

test('rejects low-confidence and multiple recognition lines', async () => {
  const run = async result => {
    const fetchImpl = async (url, options = {}) => {
      if (url.includes('img.kookapp.cn')) return response(png);
      if (options.method === 'POST') return response(JSON.stringify({ data: { jobId: 'j' } }));
      if (url.endsWith('/j')) return response(JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: 'https://aistudio-app.com/a.jsonl' } } }));
      return response(result);
    };
    return createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })(event);
  };
  await assert.rejects(run(JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['Player_01'], rec_scores: [0.79] } }] } })), e => e.code === 'low_confidence');
  await assert.rejects(run(JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['Player_01', 'Player_02'], rec_scores: [0.99, 0.99] } }] } })), e => e.code === 'ambiguous_result');
});

test('honors caller abort and polling timeout', async () => {
  const slow = async (url, options = {}) => {
    if (url.includes('img.kookapp.cn')) return response(png);
    if (options.method === 'POST') return response(JSON.stringify({ data: { jobId: 'slow' } }));
    return response(JSON.stringify({ data: { state: 'running' } }));
  };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createOcr({ token: 'token', fetchImpl: slow, pollIntervalMs: 1, totalTimeoutMs: 30 })(event, { signal: controller.signal }), e => e.code === 'cancelled_or_timeout');
  await assert.rejects(createOcr({ token: 'token', fetchImpl: slow, pollIntervalMs: 1, pollTimeoutMs: 5, totalTimeoutMs: 40 })(event), e => e.code === 'cancelled_or_timeout');
});

test('uses the official multipart API and never forwards bearer credentials to downloads', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([url, options]);
    return fetchOk()(url, options);
  };
  assert.equal(await createOcr({ token: 'private-test-token', fetchImpl, pollIntervalMs: 1 })(event), '[TEST] Player_01');
  assert.equal(seen.length, 4);
  for (const [, options] of seen) assert.equal(options.redirect, 'error');
  assert.equal(seen[0][1].headers, undefined);
  assert.equal(seen[3][1].headers, undefined);
  assert.equal(seen[1][1].headers.Authorization, 'Bearer private-test-token');
  assert.equal(seen[2][1].headers.Authorization, 'Bearer private-test-token');
  const form = seen[1][1].body;
  assert.equal(form.get('model'), 'PP-OCRv6');
  assert.deepEqual(JSON.parse(form.get('optionalPayload')), { useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false });
  assert.equal(form.get('file').type, 'image/png');
  assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), png);
});

test('rejects credentials, fragments, ports, lookalike and private URLs before fetching', async () => {
  const bad = ['http://img.kookapp.cn/x', 'https://kookapp.cn.evil.test/x', 'https://evil-kookapp.cn/x',
    'https://user:pass@img.kookapp.cn/x', 'https://img.kookapp.cn:8443/x', 'https://img.kookapp.cn/x#fragment',
    'http://127.0.0.1/a', 'https://127.0.0.1/a', 'file:///etc/passwd'];
  const fetchImpl = async () => assert.fail('unsafe URL fetched');
  for (const url of bad) await assert.rejects(createOcr({ token: 'token', fetchImpl })({ content: url }), e => e.code === 'unsafe_url');
  for (const endpoint of ['https://evil.example/api/v2/ocr/jobs', 'https://sub.paddleocr.aistudio-app.com/api/v2/ocr/jobs',
    'https://paddleocr.aistudio-app.com/api/v2/other', 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs?x=1']) {
    assert.throws(() => createOcr({ token: 'token', endpoint, fetchImpl }));
  }
});

test('rejects multiple attachments and image redirect responses before creating a job', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(null, 302, { location: 'https://evil.test/x' }); };
  const ocr = createOcr({ token: 'token', fetchImpl });
  await assert.rejects(ocr({ content: event.extra.attachments[0].url, extra: { attachments: [{ url: 'x' }, { url: 'y' }] } }), e => e.code === 'multiple_images');
  assert.equal(calls, 0);
  await assert.rejects(ocr(event), e => e.code === 'request_failed');
  assert.equal(calls, 1);
});

test('enforces the 5 MiB image limit on declared and streamed bodies', async () => {
  for (const useLength of [true, false]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return response(useLength ? png : Buffer.alloc(5 * 1024 * 1024 + 1), 200,
        useLength ? { 'content-length': String(5 * 1024 * 1024 + 1) } : {});
    };
    await assert.rejects(createOcr({ token: 'token', fetchImpl })(event), e => e.code === 'response_too_large');
    assert.equal(calls, 1);
  }
});

async function withResult(result, headers = {}) {
  const fetchImpl = async (url, options) => url.includes('/results/') ? response(result, 200, headers) : fetchOk()(url, options);
  return createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })(event);
}

test('requires one line across all pages and JSONL records', async () => {
  const page = { prunedResult: { rec_texts: ['Player_01'], rec_scores: [.99] } };
  await assert.rejects(withResult(JSON.stringify({ result: { ocrResults: [page, page] } })), e => e.code === 'ambiguous_result');
  await assert.rejects(withResult(Buffer.concat([jsonl('Player_01'), jsonl('Player_02')])) , e => e.code === 'ambiguous_result');
  await assert.rejects(withResult(JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: [], rec_scores: [] } }] } })), e => e.code === 'ambiguous_result');
});

test('bounds JSONL and rejects malformed, scoreless or oversized nicknames', async () => {
  await assert.rejects(withResult(Buffer.alloc(2 * 1024 * 1024 + 1)), e => e.code === 'response_too_large');
  await assert.rejects(withResult(jsonl('Player_01'), { 'content-length': String(2 * 1024 * 1024 + 1) }), e => e.code === 'response_too_large');
  for (const result of ['not-json', '{}', JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['Player_01'] } }] } }), Buffer.from([255])]) {
    await assert.rejects(withResult(result), e => e.code === 'invalid_result');
  }
  await assert.rejects(withResult(jsonl('A'.repeat(151))), e => e.code === 'invalid_nickname');
  await assert.rejects(withResult(jsonl('Player\n02')), e => e.code === 'invalid_nickname');
  assert.equal(await withResult(jsonl('  [TEST] Player_01  ')), '  [TEST] Player_01  ');
});

test('accepts JPEG and WebP magic without trusting the response content type', async () => {
  for (const [bytes, type] of [[Buffer.from([255,216,255,224,1]), 'image/jpeg'], [Buffer.from('RIFF0000WEBPVP8 '), 'image/webp']]) {
    const fetchImpl = async (url, options) => {
      if (url.includes('img.kookapp.cn')) return response(bytes, 200, { 'content-type': 'text/plain' });
      if (options.method === 'POST') assert.equal(options.body.get('file').type, type);
      return fetchOk()(url, options);
    };
    assert.equal(await createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })({ content: event.extra.attachments[0].url }), '[TEST] Player_01');
  }
});

test('failed or unknown jobs stop polling and never retry POST', async () => {
  for (const state of ['failed', 'cancelled', 'surprise']) {
    let posts = 0, polls = 0;
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') posts++;
      if (url.endsWith('/job-1')) { polls++; return Response.json({ data: { state, error: 'private diagnostic' } }); }
      return fetchOk()(url, options);
    };
    await assert.rejects(createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })(event), e => e.code === 'job_failed' && !e.message.includes('private'));
    assert.equal(posts, 1); assert.equal(polls, 1);
  }
  let posts = 0;
  const failingPost = async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('private-secret-token'); }
    return fetchOk()(url, options);
  };
  await assert.rejects(createOcr({ token: 'token', fetchImpl: failingPost })(event), e => !String(e).includes('private-secret-token'));
  assert.equal(posts, 1);
});

function abortingFetch({ signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('total and per-request deadlines abort stalled requests', async () => {
  for (const [totalTimeoutMs, requestTimeoutMs] of [[15, 1000], [1000, 15]]) {
    await assert.rejects(createOcr({ token: 'token', fetchImpl: (url, options) => abortingFetch(options), totalTimeoutMs, requestTimeoutMs })(event),
      e => e.code === 'cancelled_or_timeout');
  }
});

test('polling deadline aborts a stalled poll request and caller cancellation aborts an active request', async () => {
  let posts = 0, polls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') posts++;
    if (url.endsWith('/job-1')) { polls++; return abortingFetch(options); }
    return fetchOk()(url, options);
  };
  await assert.rejects(createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 15, totalTimeoutMs: 1000 })(event), e => e.code === 'cancelled_or_timeout');
  assert.equal(posts, 1); assert.equal(polls, 1);
  const controller = new AbortController();
  const pending = createOcr({ token: 'token', fetchImpl: (url, options) => abortingFetch(options) })(event, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, e => e.code === 'cancelled_or_timeout');
});

test('signed result URLs remain private and must use HTTPS without credentials, ports or fragments', async () => {
  for (const jsonUrl of ['http://files.bcebos.com/x', 'https://bcebos.com.evil.test/x', 'https://user:private@files.bcebos.com/x',
    'https://files.bcebos.com:8443/x', 'https://files.bcebos.com/x#part']) {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls++;
      if (url.endsWith('/job-1')) return Response.json({ data: { state: 'done', resultUrl: { jsonUrl } } });
      return fetchOk()(url, options);
    };
    await assert.rejects(createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })(event), e => e.code === 'unsafe_url' && !e.message.includes('private'));
    assert.equal(calls, 3);
  }
  const jsonUrl = 'https://files.bcebos.com/result.jsonl?signature=private-fixture';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/job-1')) return Response.json({ data: { state: 'done', resultUrl: { jsonUrl } } });
    if (url === jsonUrl) { assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error'); return response(null, 302); }
    return fetchOk()(url, options);
  };
  await assert.rejects(createOcr({ token: 'token', fetchImpl, pollIntervalMs: 1 })(event), e => e.code === 'request_failed' && !e.message.includes('private-fixture'));
});
