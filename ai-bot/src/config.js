import path from 'node:path';

function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error('数值配置超出允许范围。');
  return number;
}

export function loadConfig(env = process.env) {
  const token = env.KOOK_TOKEN?.trim();
  const apiKey = env.OPENAI_API_KEY?.trim();
  const channelId = env.KOOK_CHANNEL_ID?.trim();
  const model = env.OPENAI_MODEL?.trim() || 'gpt-6-astra';
  const reasoningEffort = env.REASONING_EFFORT?.trim() || 'low';
  if (!token || !/^\S{1,512}$/.test(token)) throw new Error('请配置 KOOK_TOKEN。');
  if (!apiKey || !/^\S{1,512}$/.test(apiKey)) throw new Error('请配置 OPENAI_API_KEY。');
  if (!/^\d{5,30}$/.test(channelId || '')) throw new Error('请配置真实 KOOK 文字频道 ID。');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) throw new Error('模型名称格式不正确。');
  if (!['low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('推理强度配置不正确。');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('健康检查只允许监听本机地址。');
  return {
    token, apiKey, channelId, model, host, reasoningEffort,
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    port: integer(env.PORT, 18999, 1024, 65535),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    timeoutMs: integer(env.MODEL_TIMEOUT_SECONDS, 180, 5, 180) * 1000,
    maxOutputTokens: integer(env.MAX_OUTPUT_TOKENS, 8192, 128, 8192),
    systemPrompt: `你是 KOOK 文字频道中的 AI 助手，当前模型为 ${model}。默认用简体中文，准确、友好、简洁地回答，并根据用户要求调整详略。你收到的是当前发言者的独立文本对话。回复在文字频道内公开显示，普通文字优先使用短段落和简单列表。生成 SVG 时提供完整、自包含的静态 SVG 代码，使用明确的 viewBox 和合理画布大小；机器人会自动把安全完整的 SVG 渲染成图片显示。不要使用外部图片、脚本或远程资源。其他长代码将作为文件发送。没有网页浏览、用户文件读取或执行外部操作的工具；不要声称已经执行外部操作。`,
  };
}
