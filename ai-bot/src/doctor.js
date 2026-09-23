import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ModelResponsesClient } from './model-client.js';

export async function doctor(config, { testModel = false, fetchImpl = fetch } = {}) {
  async function kook(endpoint) {
    const response = await fetchImpl(`https://www.kookapp.cn/api/v3/${endpoint}`, {
      headers: { Authorization: `Bot ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('KOOK 接口连接失败。');
    const data = await response.json();
    if (data.code !== 0) throw new Error('KOOK Token 或频道权限检查失败。');
    return data.data;
  }
  const client = new ModelResponsesClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, reasoningEffort: config.reasoningEffort, systemPrompt: config.systemPrompt });
  const [identity, channel] = await Promise.all([kook('user/me'), kook(`channel/view?target_id=${config.channelId}`)]);
  if (channel.type !== 1 || String(channel.id) !== config.channelId) throw new Error('配置的频道不是可访问的文字频道。');
  const result = { botId: identity.id, botName: identity.username, channelId: channel.id, channelName: channel.name, model: config.model, channelAccessible: true };
  if (testModel) {
    const response = await client.generate([{ role: 'user', content: '这是部署连通性检查，请只回复：连接成功' }]);
    result.modelConnected = Boolean(response.text); result.modelReported = response.model; result.usage = response.usage;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await doctor(loadConfig(), { testModel: process.argv.includes('--test-model') }))); }
  catch { console.error('检查失败，请核对私密配置、文字频道权限和上游接口。'); process.exitCode = 1; }
}
