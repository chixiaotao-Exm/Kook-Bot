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
  KOOK_RENDER_FAILED: '图片渲染失败，请尝试生成更简单的静态 SVG。',
  KOOK_RENDER_TIMEOUT: '图片渲染超时，请尝试减少复杂滤镜或图形。',
  KOOK_ASSET_REJECTED: 'KOOK 未接受这次图片或文件上传，请稍后再试。',
  KOOK_ASSET_NETWORK: '图片或文件上传时连接中断，请稍后再试。',
  KOOK_ASSET_TIMEOUT: '图片或文件上传超时，请稍后再试。',
  KOOK_RATE_LIMITED: 'KOOK 消息发送频率已受限，请稍后再试。',
  KOOK_REJECTED: 'KOOK 拒绝了这次回复，请联系管理员检查频道权限。',
  KOOK_TIMEOUT: '回复发送超时，送达状态暂时无法确认。',
  KOOK_NETWORK: '回复发送时连接中断，送达状态暂时无法确认。',
  CHECKS_FAILED: '实际检查尚未通过，代码工作区已保留。',
  REVIEW_FAILED: '独立复核尚未通过，代码工作区已保留。',
  PUBLISH_UNKNOWN: '分支发布或 PR 状态尚未确认，未重复执行发布。',
  BUDGET: '本次任务已达到迭代上限，已有代码和检查报告已保留。',
  BROKER_FAILED: '代码执行工具暂不可用，当前任务未确认完成。',
  CAPACITY: '代码任务名额已满，请管理员整理已有任务后重试。',
  GIT_FAILED: '仓库操作未成功，请检查代码执行服务后重试。',
  STORAGE: '任务状态保存失败，已暂停后续操作。',
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
