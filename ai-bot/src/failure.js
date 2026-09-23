const MODEL_MESSAGES = Object.freeze({
  TIMEOUT: 'AI 回复超时，请把问题拆短后重试。',
  EMPTY_RESPONSE: 'AI 本次没有生成可发送的内容，请重试；生成代码时可先要求简短版本。',
  AUTH: 'AI 服务鉴权失败，请联系管理员检查服务配置。',
  RATE_LIMIT: 'AI 请求已达到服务频率限制，请稍后再试。',
  NETWORK: '暂时无法连接 AI 服务，请稍后重试。',
  UPSTREAM_ERROR: 'AI 服务暂时出错，本次未生成回复，请稍后重试。',
  MODEL_MISMATCH: 'AI 服务返回的模型与配置不一致，请联系管理员检查。',
  FORMAT: 'AI 服务返回了无法读取的内容，请稍后重试。',
  RESPONSE_LIMIT: 'AI 返回的内容过长，请要求更简短的回复或分段生成。',
  REFUSAL: 'AI 未能处理这个请求，请调整问题内容后重试。',
  INPUT_LIMIT: '对话内容过长，请发送 /重置 清空上下文，或缩短本条消息后重试。',
  INVALID_INPUT: '这条消息的格式无法处理，请重新发送文字内容。',
  REDIRECT: 'AI 服务地址发生了变化，请联系管理员检查配置。',
  CONFIG: 'AI 服务配置需要检查，请联系管理员。',
  CANCELLED: '本次回复已取消。',
  UNKNOWN: 'AI 暂时无法回复，请稍后再试。',
});
const CODES = new Set([...Object.keys(MODEL_MESSAGES),
  'KOOK_INVALID_INPUT', 'KOOK_RESPONSE_TOO_LARGE', 'KOOK_INVALID_RESPONSE', 'KOOK_ABORTED',
  'KOOK_RATE_LIMITED', 'KOOK_REJECTED', 'KOOK_TIMEOUT', 'KOOK_NETWORK',
  'KOOK_ASSET_REJECTED', 'KOOK_ASSET_INVALID_RESPONSE', 'KOOK_ASSET_RESPONSE_TOO_LARGE',
  'KOOK_ASSET_NETWORK', 'KOOK_ASSET_TIMEOUT']);

/** Never pass arbitrary upstream error codes or messages into logs or health data. */
export function sanitizeFailureCode(value) {
  return typeof value === 'string' && CODES.has(value) ? value : 'UNKNOWN';
}

export function sanitizeDurationMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 86_400_000) : 0;
}

export function modelFailureMessage(code) {
  return MODEL_MESSAGES[sanitizeFailureCode(code)] || MODEL_MESSAGES.UNKNOWN;
}
