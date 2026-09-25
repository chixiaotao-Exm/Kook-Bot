import { ModelClientError } from './model-client.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_CONTEXT_CHARS = 160000;
const MAX_TEXT_CHARS = 32000;
const MAX_ARGUMENT_CHARS = 64000;
const MAX_TOOL_OUTPUT_CHARS = 20000;
const MAX_ENCRYPTED_CHARS = 131072;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DEFAULT_PROMPT = '你是 KOOK 中的代码协作助手，只使用提供的工具完成已授权的仓库任务。';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class AgentModelClientError extends ModelClientError {
  constructor(code, message, { retryable = false } = {}) { super(code, message, { retryable }); this.name = 'AgentModelClientError'; }
}
const failure = (code, message, retryable = false) => new AgentModelClientError(code, message, { retryable });
const invalid = code => failure(code, code === 'CONFIG' ? '代码助手配置不正确，请联系管理员。'
  : code === 'INPUT_LIMIT' ? '代码任务上下文过长，请缩小本次任务范围。'
    : code === 'RESPONSE_LIMIT' ? '模型返回的数据过大，已停止本次操作。' : '模型工具协议格式不正确，已停止本次操作。');

function endpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw invalid('CONFIG'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) throw invalid('CONFIG');
  url.pathname = '/v1/responses'; return url.toString();
}

function string(value, limit, code, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || !value.isWellFormed()) throw invalid(code);
  return value;
}

function jsonLength(value, limit, code) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw invalid(code); }
  if (typeof encoded !== 'string' || encoded.length > limit) throw invalid(code);
  return encoded;
}

function itemId(item, code) {
  if (item.id === undefined) return {};
  if (typeof item.id !== 'string' || !ID.test(item.id)) throw invalid(code);
  return { id: item.id };
}

function validateSchema(schema) {
  let nodes = 0;
  const visit = (value, depth) => {
    if (!object(value) || depth > 16 || ++nodes > 1024) throw invalid('CONFIG');
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.some(type => type !== undefined && !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(type))) throw invalid('CONFIG');
    if (value.$ref !== undefined && (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/') || value.$ref.length > 256)) throw invalid('CONFIG');
    if (types.includes('object') || value.properties !== undefined) {
      if (!object(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)
        || value.required.some(name => typeof name !== 'string') || new Set(value.required).size !== value.required.length) throw invalid('CONFIG');
      const keys = Object.keys(value.properties);
      if (keys.length > 100 || keys.length !== value.required.length || keys.some(key => !value.required.includes(key))) throw invalid('CONFIG');
      for (const child of Object.values(value.properties)) visit(child, depth + 1);
    }
    if (types.includes('array') && !object(value.items)) throw invalid('CONFIG');
    if (value.items !== undefined) visit(value.items, depth + 1);
    for (const key of ['anyOf', 'allOf', 'oneOf']) if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 32) throw invalid('CONFIG');
      for (const child of value[key]) visit(child, depth + 1);
    }
    if (value.$defs !== undefined) {
      if (!object(value.$defs) || Object.keys(value.$defs).length > 100) throw invalid('CONFIG');
      for (const child of Object.values(value.$defs)) visit(child, depth + 1);
    }
  };
  if (schema.type !== 'object') throw invalid('CONFIG');
  visit(schema, 0);
}

function toolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > 32) throw invalid('CONFIG');
  const names = new Set();
  const normalized = tools.map(tool => {
    if (!object(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !NAME.test(tool.name)
      || names.has(tool.name) || (tool.strict !== undefined && tool.strict !== true) || !object(tool.parameters)) throw invalid('CONFIG');
    names.add(tool.name);
    const parameters = JSON.parse(jsonLength(tool.parameters, 64000, 'CONFIG'));
    validateSchema(parameters);
    return { type: 'function', name: tool.name,
      ...(tool.description === undefined ? {} : { description: string(tool.description, 2000, 'CONFIG', { empty: true }) }),
      parameters, strict: true };
  });
  jsonLength(normalized, 80000, 'CONFIG');
  return { normalized, names };
}

function choice(value, names) {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'none') return 'none';
  if (object(value) && value.type === 'function' && typeof value.name === 'string' && names.has(value.name)) {
    return { type: 'function', name: value.name };
  }
  throw invalid('CONFIG');
}

function argumentsObject(value, code) {
  string(value, MAX_ARGUMENT_CHARS, code);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw invalid(code); }
  if (!object(parsed)) throw invalid(code);
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 32) throw invalid(code);
    if (typeof item === 'number' && !Number.isFinite(item)) throw invalid(code);
    if (typeof item === 'string' && !item.isWellFormed()) throw invalid(code);
    if (Array.isArray(item)) item.forEach(child => visit(child, depth + 1));
    else if (object(item)) for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid(code);
      visit(child, depth + 1);
    }
  };
  visit(parsed, 0); return parsed;
}

function functionCall(item, names, ids, code) {
  if (typeof item.call_id !== 'string' || !ID.test(item.call_id) || ids.has(item.call_id)) throw invalid('FORMAT');
  if (typeof item.name !== 'string' || !names.has(item.name)) throw failure('CALL_UNKNOWN', '模型请求了未开放的工具，已停止本次操作。');
  if (item.status !== undefined && item.status !== 'completed') throw invalid('RESPONSE_INCOMPLETE');
  const args = argumentsObject(item.arguments, code);
  ids.add(item.call_id);
  return { item: { ...itemId(item, code), type: 'function_call', call_id: item.call_id, name: item.name,
    arguments: item.arguments, ...(item.status === undefined ? {} : { status: item.status }) },
  call: { callId: item.call_id, name: item.name, arguments: args } };
}

function reasoning(item, code) {
  if (item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.length > 32)) throw invalid(code);
  const summary = (item.summary || []).map(part => {
    if (!object(part) || part.type !== 'summary_text') throw invalid(code);
    return { type: 'summary_text', text: string(part.text, MAX_TEXT_CHARS, code, { empty: true }) };
  });
  return { ...itemId(item, code), type: 'reasoning', summary,
    ...(item.encrypted_content == null ? {} : { encrypted_content: string(item.encrypted_content, MAX_ENCRYPTED_CHARS, code, { empty: true }) }) };
}

function assistantMessage(item, code) {
  if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 64
    || (item.status !== undefined && !['completed', 'incomplete'].includes(item.status))) throw invalid(code);
  const content = item.content.map(part => {
    if (!object(part)) throw invalid(code);
    if (part.type === 'output_text') return { type: 'output_text', text: string(part.text, MAX_TEXT_CHARS, code, { empty: true }), annotations: [] };
    if (part.type === 'refusal') return { type: 'refusal', refusal: string(part.refusal, MAX_TEXT_CHARS, code, { empty: true }) };
    throw invalid(code);
  });
  return { ...itemId(item, code), type: 'message', role: 'assistant', content,
    ...(item.status === undefined ? {} : { status: item.status }) };
}

function inputItems(input, names) {
  if (!Array.isArray(input) || !input.length || input.length > 256) throw invalid('INPUT_LIMIT');
  const ids = new Set(), pending = new Set();
  const normalized = input.map(item => {
    if (!object(item)) throw invalid('INVALID_INPUT');
    if (item.type === 'function_call') {
      const { item: call } = functionCall(item, names, ids, 'FORMAT'); pending.add(call.call_id); return call;
    }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !pending.has(item.call_id)) throw invalid('FORMAT');
      pending.delete(item.call_id);
      return { type: 'function_call_output', call_id: item.call_id,
        output: string(item.output, MAX_TOOL_OUTPUT_CHARS, 'INPUT_LIMIT', { empty: true }) };
    }
    if (item.type === 'reasoning') return reasoning(item, 'INVALID_INPUT');
    if (item.type !== undefined && item.type !== 'message') throw invalid('INVALID_INPUT');
    if (!['user', 'assistant'].includes(item.role)) throw invalid('INVALID_INPUT');
    if (typeof item.content === 'string') return { role: item.role, content: string(item.content, MAX_TEXT_CHARS, 'INPUT_LIMIT') };
    if (item.role === 'assistant') return assistantMessage(item, 'INVALID_INPUT');
    if (!Array.isArray(item.content) || !item.content.length || item.content.length > 64) throw invalid('INVALID_INPUT');
    return { role: 'user', content: item.content.map(part => {
      if (!object(part) || part.type !== 'input_text') throw invalid('INVALID_INPUT');
      return { type: 'input_text', text: string(part.text, MAX_TEXT_CHARS, 'INPUT_LIMIT') };
    }) };
  });
  if (pending.size) throw invalid('FORMAT');
  jsonLength(normalized, MAX_CONTEXT_CHARS, 'INPUT_LIMIT');
  return { normalized, ids };
}

function normalize(raw, model, names, requestedChoice, previousIds) {
  if (!object(raw)) throw invalid('FORMAT');
  if (raw.error || ['failed', 'cancelled'].includes(raw.status)) throw failure('UPSTREAM_ERROR', '模型服务暂时出错，本次操作已停止。',
    raw.status !== 'cancelled' && ['server_error', 'rate_limit_exceeded'].includes(raw.error?.code));
  if (raw.model != null && raw.model !== model) throw failure('MODEL_MISMATCH', '模型与配置不一致，本次操作已停止。');
  if (!['completed', 'incomplete'].includes(raw.status) || !Array.isArray(raw.output) || raw.output.length > 128) throw invalid('FORMAT');
  const calls = [], parts = [], ids = new Set(previousIds); let refused = false;
  const output = raw.output.map(item => {
    if (!object(item)) throw invalid('FORMAT');
    if (item.type === 'reasoning') return reasoning(item, 'FORMAT');
    if (item.type === 'function_call') {
      if (raw.status !== 'completed') throw invalid('RESPONSE_INCOMPLETE');
      const normalized = functionCall(item, names, ids, 'FORMAT');
      if (requestedChoice === 'none' || (object(requestedChoice) && requestedChoice.name !== normalized.call.name)) throw invalid('FORMAT');
      calls.push(normalized.call); if (calls.length > 16) throw invalid('RESPONSE_LIMIT');
      return normalized.item;
    }
    if (item.type !== 'message') throw invalid('FORMAT');
    const message = assistantMessage(item, 'FORMAT');
    for (const part of message.content) {
      if (part.type === 'output_text') parts.push(part.text);
      if (part.type === 'refusal') refused = true;
    }
    return message;
  });
  if (object(requestedChoice) && !calls.length) throw invalid('FORMAT');
  let text = parts.join('\n').trim();
  if (text.length > MAX_TEXT_CHARS) throw invalid('RESPONSE_LIMIT');
  if (!text && !calls.length) throw failure(refused ? 'REFUSAL' : 'EMPTY_RESPONSE', refused
    ? '模型未能处理这项请求，请调整任务后重试。' : '模型没有生成有效回复，本次操作已停止。');
  if (raw.status === 'incomplete' && text) {
    const marker = '\n\n（回复未完整生成。）';
    text = text.slice(0, MAX_TEXT_CHARS - marker.length).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + marker;
  }
  jsonLength(output, MAX_CONTEXT_CHARS, 'RESPONSE_LIMIT');
  const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { output, text, calls, model, usage: { inputTokens: numeric(raw.usage?.input_tokens),
    outputTokens: numeric(raw.usage?.output_tokens), totalTokens: numeric(raw.usage?.total_tokens) } };
}

function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }
async function readJson(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BODY_BYTES) { cancelBody(response.body); throw invalid('RESPONSE_LIMIT'); }
  const reader = response.body?.getReader();
  if (!reader) throw invalid('FORMAT');
  const chunks = []; let bytes = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalid('FORMAT');
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw invalid('RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw invalid('FORMAT'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

/** Stateless Responses function protocol; execution belongs to the repository tool layer. */
export class AgentResponsesClient {
  #url; #key; #model; #prompt; #fetch; #timeout; #maxOutputTokens; #reasoningEffort;

  constructor({ baseUrl, apiKey, model = 'gpt-6-astra', systemPrompt = DEFAULT_PROMPT, fetchImpl = globalThis.fetch,
    timeoutMs = 180000, maxOutputTokens = 8192, reasoningEffort = 'low' } = {}) {
    this.#url = endpoint(baseUrl);
    if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(apiKey)
      || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)
      || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000
      || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16000
      || !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw invalid('CONFIG');
    this.#prompt = string(systemPrompt, 16000, 'CONFIG');
    this.#key = apiKey; this.#model = model; this.#fetch = fetchImpl; this.#timeout = timeoutMs;
    this.#maxOutputTokens = maxOutputTokens; this.#reasoningEffort = reasoningEffort;
  }

  async respond(input, { tools = [], signal, toolChoice } = {}) {
    const { normalized: definitions, names } = toolDefinitions(tools);
    const selected = choice(toolChoice, names);
    const { normalized, ids } = inputItems(input, names);
    jsonLength({ instructions: this.#prompt, input: normalized, tools: definitions }, MAX_CONTEXT_CHARS, 'INPUT_LIMIT');
    if (signal?.aborted) throw failure('CANCELLED', '本次代码任务请求已取消。');
    const controller = new AbortController(); let rejectAborted;
    const interrupted = new Promise((_, reject) => { rejectAborted = reject; });
    const abort = error => { rejectAborted(error); controller.abort(error); };
    const callerAbort = () => abort(failure('CANCELLED', '本次代码任务请求已取消。'));
    signal?.addEventListener('abort', callerAbort, { once: true });
    const timer = setTimeout(() => abort(failure('TIMEOUT', '模型处理超时，本次操作已停止。', true)), this.#timeout);
    try {
      const request = async () => {
        const response = await this.#fetch(this.#url, { method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.#key}` },
          body: JSON.stringify({ model: this.#model, instructions: this.#prompt, input: normalized, tools: definitions,
            tool_choice: selected, parallel_tool_calls: false, include: ['reasoning.encrypted_content'],
            store: false, stream: false, max_output_tokens: this.#maxOutputTokens, reasoning: { effort: this.#reasoningEffort } }),
        });
        if (controller.signal.aborted) { cancelBody(response?.body); throw controller.signal.reason; }
        if (response?.redirected || response?.type === 'opaqueredirect' || response?.status >= 300 && response.status < 400) {
          cancelBody(response?.body); throw failure('REDIRECT', '模型接口发生重定向，请联系管理员。');
        }
        if (!response?.ok) {
          cancelBody(response?.body);
          if ([401, 403].includes(response?.status)) throw failure('AUTH', '模型服务鉴权失败，请联系管理员。');
          if (response?.status === 429) throw failure('RATE_LIMIT', '模型服务达到频率或额度限制，请稍后重试。', true);
          throw failure('UPSTREAM_ERROR', '模型服务暂时不可用，本次操作已停止。', RETRYABLE_HTTP_STATUS.has(response?.status));
        }
        return normalize(await readJson(response, controller.signal), this.#model, names, selected, ids);
      };
      return await Promise.race([request(), interrupted]);
    } catch (caught) {
      if (caught instanceof AgentModelClientError) throw caught;
      if (controller.signal.aborted && controller.signal.reason instanceof AgentModelClientError) throw controller.signal.reason;
      throw failure('NETWORK', '暂时无法连接模型服务，本次操作已停止。', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', callerAbort); }
  }
}
