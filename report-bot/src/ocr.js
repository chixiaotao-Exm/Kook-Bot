import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_ENDPOINT = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
const IMAGE_DOMAINS = ['kookapp.cn', 'kookapp.com', 'kaiheila.cn', 'kaiheila.com'];
const RESULT_DOMAINS = ['bcebos.com', 'baidubce.com', 'aistudio-app.com'];
const IMAGE_LIMIT = 5 * 1024 * 1024;
const RESULT_LIMIT = 2 * 1024 * 1024;

class OcrError extends Error {
  constructor(code) { super('Nickname image recognition failed. Enter the nickname manually with "report CorrectNickname".'); this.name = 'OcrError'; this.code = code; }
}

function trustedUrl(raw, domains) {
  let url;
  try { url = new URL(raw); } catch { throw new OcrError('unsafe_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new OcrError('unsafe_url');
  }
  return url;
}

function imageUrl(event) {
  const attachments = event?.extra?.attachments;
  if (Array.isArray(attachments) && attachments.length !== 1) throw new OcrError('multiple_images');
  const attachment = Array.isArray(attachments) ? attachments[0] : attachments;
  const raw = typeof event?.content === 'string' && event.content.trim() ? event.content.trim() : attachment?.url;
  return trustedUrl(raw, IMAGE_DOMAINS);
}

async function boundedBytes(response, limit, signal) {
  if (response.redirected || !response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OcrError('request_failed');
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new OcrError('response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OcrError('empty_response');
  const parts = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new OcrError('response_too_large');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR') return { type: 'image/png', extension: 'png' };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { type: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return { type: 'image/webp', extension: 'webp' };
  throw new OcrError('unsupported_image');
}

function recognizedText(bytes) {
  let records;
  try {
    records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  } catch { throw new OcrError('invalid_result'); }
  if (!records.length) throw new OcrError('empty_result');
  const recognized = [];
  for (const record of records) {
    const results = record?.result?.ocrResults;
    if (!Array.isArray(results) || !results.length) throw new OcrError('invalid_result');
    for (const result of results) {
      const texts = result?.prunedResult?.rec_texts, scores = result?.prunedResult?.rec_scores;
      if (!Array.isArray(texts) || !Array.isArray(scores) || texts.length !== scores.length) throw new OcrError('invalid_result');
      texts.forEach((text, index) => {
        if (typeof text !== 'string' || typeof scores[index] !== 'number' || !Number.isFinite(scores[index])) throw new OcrError('invalid_result');
        if (text.trim()) recognized.push({ text, score: scores[index] });
      });
    }
  }
  // Never select one name from a leaderboard or concatenate partial OCR lines.
  if (recognized.length !== 1) throw new OcrError('ambiguous_result');
  const { text, score } = recognized[0];
  if (score < 0.8 || score > 1) throw new OcrError('low_confidence');
  if (text.length > 150 || /[\r\n\u0000-\u001f]/.test(text)) throw new OcrError('invalid_nickname');
  return text;
}

/** Return raw OCR text; domain.normalizeNickname performs clan-tag/nickname validation. */
export function createOcr({ token, endpoint = DEFAULT_ENDPOINT, model = 'PP-OCRv6', fetchImpl = fetch,
  pollIntervalMs = 5000, pollTimeoutMs = 60000, totalTimeoutMs = 80000, requestTimeoutMs = 20000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new OcrError('missing_token');
  const base = trustedUrl(endpoint, ['paddleocr.aistudio-app.com']);
  if (base.hostname !== 'paddleocr.aistudio-app.com' || base.pathname !== '/api/v2/ocr/jobs' || base.search) throw new OcrError('unsafe_endpoint');
  if (model !== 'PP-OCRv6') throw new OcrError('invalid_model');
  for (const timeout of [pollIntervalMs, pollTimeoutMs, totalTimeoutMs, requestTimeoutMs]) {
    if (!Number.isInteger(timeout) || timeout <= 0) throw new OcrError('invalid_timeout');
  }
  const authorization = 'Bearer ' + token.trim();
  return async function ocr(event, { signal } = {}) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), totalTimeoutMs);
    const totalSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const request = async (url, options = {}, limit = RESULT_LIMIT) => {
      totalSignal.throwIfAborted();
      const requestSignal = AbortSignal.any([totalSignal, AbortSignal.timeout(requestTimeoutMs)]);
      const response = await fetchImpl(url.toString(), { ...options, redirect: 'error', signal: requestSignal });
      return boundedBytes(response, limit, requestSignal);
    };
    const api = async (url, options = {}) => {
      const bytes = await request(url, { ...options, headers: { Authorization: authorization } });
      let json;
      try { json = JSON.parse(bytes.toString('utf8')); } catch { throw new OcrError('invalid_api_response'); }
      if (json?.errorCode && json.errorCode !== '0') throw new OcrError('api_error');
      return json;
    };
    try {
      const bytes = await request(imageUrl(event), {}, IMAGE_LIMIT);
      const { type, extension } = imageType(bytes);
      const body = new FormData();
      body.set('model', model);
      body.set('optionalPayload', JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false }));
      body.set('file', new Blob([bytes], { type }), 'nickname.' + extension);
      // Creating a job can be billed: never retry an uncertain POST.
      const created = await api(base, { method: 'POST', body });
      const jobId = created?.data?.jobId;
      if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(jobId)) throw new OcrError('invalid_job_id');
      const pollController = new AbortController();
      const pollDeadline = setTimeout(() => pollController.abort(), pollTimeoutMs);
      const pollSignal = AbortSignal.any([totalSignal, pollController.signal]);
      try {
        for (;;) {
          await sleep(pollIntervalMs, undefined, { signal: pollSignal });
          // Include the polling deadline in requests, including response-body reads.
          const requestSignal = AbortSignal.any([pollSignal, AbortSignal.timeout(requestTimeoutMs)]);
          const response = await fetchImpl(base.toString() + '/' + encodeURIComponent(jobId), {
            headers: { Authorization: authorization }, redirect: 'error',
            signal: requestSignal
          });
          const pollBytes = await boundedBytes(response, RESULT_LIMIT, requestSignal);
          let done;
          try { done = JSON.parse(pollBytes.toString('utf8')); } catch { throw new OcrError('invalid_api_response'); }
          if (done?.errorCode && done.errorCode !== '0') throw new OcrError('api_error');
          const state = done?.data?.state;
          if (state === 'done') {
            const resultUrl = trustedUrl(done.data.resultUrl?.jsonUrl, RESULT_DOMAINS);
            return recognizedText(await request(resultUrl));
          }
          if (!['pending', 'queued', 'running', 'processing'].includes(state)) throw new OcrError('job_failed');
        }
      } finally { clearTimeout(pollDeadline); }
    } catch (error) {
      // Upstream errors/URLs may contain credentials or signed query parameters.
      if (error instanceof OcrError) throw error;
      throw new OcrError(totalSignal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'cancelled_or_timeout' : 'request_failed');
    } finally { clearTimeout(deadline); }
  };
}
