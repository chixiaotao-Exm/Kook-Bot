import { pathToFileURL } from 'node:url';
import { loadDuetConfig } from './duet-config.js';
import { ModelResponsesClient } from './model-client.js';

const LIMIT = 32 * 1024;
const ID = /^\d{5,30}$/;
const checkError = () => new Error('互聊机器人身份或文字频道访问检查失败。');
function cancelBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

async function boundedJson(response, signal) {
  if (Number(response.headers?.get('content-length')) > LIMIT) { cancelBody(response.body); throw checkError(); }
  const reader = response.body?.getReader();
  if (!reader) throw checkError();
  let bytes = 0; const chunks = [];
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw checkError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw checkError();
      if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > LIMIT) throw checkError();
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw checkError(); }
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    try { reader.releaseLock(); } catch {}
  }
}

export async function doctorDuet(config, { testModel = false, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!config || !Array.isArray(config.tokens) || config.tokens.length !== 2
    || config.tokens.some(token => typeof token !== 'string' || !/^\S{1,512}$/.test(token))
    || config.tokens[0] === config.tokens[1] || typeof config.channelId !== 'string' || !ID.test(config.channelId)
    || !Array.isArray(config.models) || config.models.length !== 2
    || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw checkError();
  const clients = config.models.map((model, index) => new ModelResponsesClient({ baseUrl: config.baseUrl, apiKey: config.apiKey,
    model, fetchImpl, timeoutMs: config.modelTimeoutMs, maxOutputTokens: Math.min(config.maxOutputTokens, 256),
    reasoningEffort: config.reasoningEffort, systemPrompt: config.systemPrompts[index] }));

  async function kook(token, endpoint) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(checkError()); controller.abort(); }, timeoutMs); });
    try {
      const request = async () => {
        const response = await fetchImpl(`https://www.kookapp.cn/api/v3/${endpoint}`, {
          method: 'GET', headers: { Authorization: `Bot ${token}` }, redirect: 'error', signal: controller.signal,
        });
        if (controller.signal.aborted || !response?.ok || response.redirected) { cancelBody(response?.body); throw checkError(); }
        const raw = await boundedJson(response, controller.signal);
        if (raw?.code !== 0 || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) throw checkError();
        return raw.data;
      };
      return await Promise.race([request(), timeout]);
    } catch { throw checkError(); }
    finally { clearTimeout(timer); }
  }

  const inspected = await Promise.all(config.tokens.map(async token => {
    const [identity, channel] = await Promise.all([kook(token, 'user/me'), kook(token, `channel/view?target_id=${config.channelId}`)]);
    if (typeof identity.id !== 'string' || !ID.test(identity.id) || identity.bot === false
      || channel.type !== 1 || String(channel.id) !== config.channelId) throw checkError();
    return { identity, channel };
  }));
  if (inspected[0].identity.id === inspected[1].identity.id) throw new Error('两个 Token 对应同一个机器人，请使用两个不同的机器人。');
  const display = (value, fallback) => typeof value === 'string' && ![...config.tokens, config.apiKey].some(secret => value.includes(secret))
    ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) || fallback : fallback;
  const bots = inspected.map(({ identity }, index) => ({ botId: identity.id,
    botName: display(identity.username, config.labels[index]), label: config.labels[index], model: config.models[index], channelAccessible: true }));
  if (testModel) {
    // This opt-in probe is the only billable work performed by this command.
    for (let index = 0; index < 2; index++) {
      const generated = await clients[index].generate([{ role: 'user', content: '这是部署连通性检查，请只回复：连接成功' }]);
      bots[index].modelConnected = Boolean(generated.text);
      bots[index].modelReported = generated.model;
      bots[index].usage = generated.usage;
    }
  }
  return { bots, channelId: config.channelId, channelName: display(inspected[0].channel.name, '互聊文字频道'),
    channelAccessible: true, models: [...config.models] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await doctorDuet(loadDuetConfig(), { testModel: process.argv.includes('--test-model') }))); }
  catch { console.error('互聊检查失败，请核对两个机器人 Token、文字频道权限和模型私密配置。'); process.exitCode = 1; }
}
