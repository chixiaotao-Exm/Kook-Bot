const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 6000;
const MAX_INPUT_CHARS = 48000;
const MAX_OUTPUT_CHARS = 32000;
const INCOMPLETE_MARKER = '\n\n（回复未完整生成，可发送“继续”接着聊。）';
const HISTORY_MARKER = '\n\n[前文较长，完整内容已作为附件提供]';
const DEFAULT_PROMPT = '你是 KOOK 文字频道里的 AI 助手。请用简洁、自然的中文回复用户；用户指定其他语言时按其要求回复。';

export class ModelClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelClientError';
    this.code = code;
  }
}

const failure = (code, message) => new ModelClientError(code, message);
const withMarker = (text, limit, marker) => text.slice(0, limit - marker.length)
  .replace(/[\uD800-\uDBFF]$/, '').trimEnd() + marker;

function endpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw failure('CONFIG', 'AI 服务地址配置不正确。'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw failure('CONFIG', 'AI 服务地址必须是 HTTPS 地址或本机 HTTP 地址，且只能使用根路径或 /v1。');
  }
  url.pathname = '/v1/responses';
  return url.toString();
}

function inputMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw failure('INPUT_LIMIT', '对话记录过长，请清空上下文后重试。');
  }
  let length = 0;
  const input = messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || !message.content.trim()) {
      throw failure('INVALID_INPUT', '对话消息格式不正确。');
    }
    length += message.content.length;
    if (message.content.length > MAX_MESSAGE_CHARS || length > MAX_INPUT_CHARS) {
      throw failure('INPUT_LIMIT', '消息或对话记录过长，请缩短消息或清空上下文后重试。');
    }
    return { role: message.role, content: message.content };
  });
  if (input.at(-1).role !== 'user') throw failure('INVALID_INPUT', '最后一条对话消息需要来自用户。');
  return input;
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already closed. */ }
}

async function boundedJson(response, signal) {
  const advertisedBytes = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > MAX_BODY_BYTES) {
    cancelBody(response.body);
    throw failure('RESPONSE_LIMIT', 'AI 回复数据过大，请缩短问题后重试。');
  }
  if (!response.body?.getReader) throw failure('FORMAT', 'AI 服务没有返回有效的回复。');
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ } };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure('FORMAT', 'AI 服务返回的数据格式不正确。');
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        cancel();
        throw failure('RESPONSE_LIMIT', 'AI 回复数据过大，请缩短问题后重试。');
      }
      chunks.push(value);
    }
    if (signal.aborted) throw signal.reason;
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('FORMAT', 'AI 服务返回的数据格式不正确。'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* A cancelled read can still be pending. */ }
  }
}

function normalize(raw, model) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('FORMAT', 'AI 服务返回的数据格式不正确。');
  if (raw.error || ['failed', 'cancelled'].includes(raw.status)) throw failure('UPSTREAM_ERROR', 'AI 服务暂时未能生成回复，请稍后重试。');
  if (raw.model != null && raw.model !== model) throw failure('MODEL_MISMATCH', 'AI 服务返回的模型与设置不一致，已停止本次回复。');
  if (!['completed', 'incomplete'].includes(raw.status) || !Array.isArray(raw.output)) {
    throw failure('FORMAT', 'AI 服务没有返回完整的回复数据。');
  }
  const parts = [];
  let refusal = false;
  for (const item of raw.output) {
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === 'refusal') refusal = true;
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  let text = parts.join('\n').trim();
  if (!text) throw failure(refusal ? 'REFUSAL' : 'EMPTY_RESPONSE', refusal
    ? '模型无法回答这条消息，请换个问法。' : 'AI 没有生成文字回复，请换个问法或稍后重试。');
  const incomplete = raw.status === 'incomplete' || text.length > MAX_OUTPUT_CHARS;
  if (incomplete) text = withMarker(text, MAX_OUTPUT_CHARS, INCOMPLETE_MARKER);
  const historyText = text.length > MAX_MESSAGE_CHARS ? withMarker(text, MAX_MESSAGE_CHARS, HISTORY_MARKER) : text;
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    text, historyText, incomplete, model,
    usage: {
      inputTokens: number(raw.usage?.input_tokens),
      outputTokens: number(raw.usage?.output_tokens),
      totalTokens: number(raw.usage?.total_tokens),
    },
  };
}

export class ModelResponsesClient {
  #url; #apiKey; #model; #fetch; #timeoutMs; #maxOutputTokens; #systemPrompt; #reasoningEffort;

  constructor({ baseUrl, apiKey, model = 'gpt-6-astra', fetchImpl = globalThis.fetch,
    timeoutMs = 180000, maxOutputTokens = 8192, reasoningEffort = 'low', systemPrompt = DEFAULT_PROMPT } = {}) {
    this.#url = endpoint(baseUrl);
    if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(apiKey)
      || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)
      || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000
      || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16000
      || !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)
      || typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 12000) {
      throw failure('CONFIG', 'AI 服务配置不正确，请联系管理员。');
    }
    this.#apiKey = apiKey; this.#model = model; this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs; this.#maxOutputTokens = maxOutputTokens; this.#systemPrompt = systemPrompt;
    this.#reasoningEffort = reasoningEffort;
  }

  async generate(messages, { signal } = {}) {
    const input = inputMessages(messages);
    if (signal?.aborted) throw failure('CANCELLED', '本次 AI 回复已取消。');
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = error => { rejectAbort(error); controller.abort(error); };
    const callerAbort = () => abort(failure('CANCELLED', '本次 AI 回复已取消。'));
    signal?.addEventListener('abort', callerAbort, { once: true });
    const timer = setTimeout(() => abort(failure('TIMEOUT', 'AI 回复超时，请稍后重试。')), this.#timeoutMs);
    try {
      const request = async () => {
        const response = await this.#fetch(this.#url, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify({ model: this.#model, instructions: this.#systemPrompt, input,
            store: false, stream: false, max_output_tokens: this.#maxOutputTokens, reasoning: { effort: this.#reasoningEffort } }),
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (response?.type === 'opaqueredirect' || response?.redirected || (response?.status >= 300 && response.status < 400)) {
          cancelBody(response.body);
          throw failure('REDIRECT', 'AI 服务地址发生重定向，请联系管理员检查配置。');
        }
        if (!response?.ok) {
          cancelBody(response?.body);
          if ([401, 403].includes(response?.status)) throw failure('AUTH', 'AI 服务密钥无效或无模型权限，请联系管理员。');
          if (response?.status === 429) throw failure('RATE_LIMIT', 'AI 服务请求过于频繁或额度不足，请稍后重试。');
          throw failure('UPSTREAM_ERROR', 'AI 服务暂时不可用，请稍后重试。');
        }
        return normalize(await boundedJson(response, controller.signal), this.#model);
      };
      return await Promise.race([aborted, request()]);
    } catch (error) {
      if (error instanceof ModelClientError) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof ModelClientError) throw controller.signal.reason;
      throw failure('NETWORK', '暂时无法连接 AI 服务，请稍后重试。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', callerAbort);
    }
  }
}
