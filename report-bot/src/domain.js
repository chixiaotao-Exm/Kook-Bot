// The entry point requires a private channel setting; the zero ID is inert in library tests.
export const CHANNEL_ID = process.env.KOOK_CHANNEL_ID?.trim() || '0000000000000000';
export const DAY_MS = 24 * 60 * 60_000;
export const MAX_EVENT_AGE_MS = 5 * 60_000;
export const validId = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
export const validMessageId = value => typeof value === 'string' && /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i.test(value);
export const validDraftId = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const validEventTime = (value, now) => Number.isSafeInteger(value) && value >= now - MAX_EVENT_AGE_MS && value <= now + 60_000;

export function normalizeNickname(raw) {
  if (typeof raw !== 'string' || raw.length > 150 || /[\r\n\u0000-\u001f\u007f]/.test(raw))
    throw new Error('请只提供一行昵称；多行识别结果需要手动修改。');
  // Only a complete leading clan tag is removed. Preserve case and ambiguous OCR characters.
  const value = raw.trim().replace(/^(?:\[[^\[\]]{1,40}\]|【[^【】]{1,40}】|［[^［］]{1,40}］)\s*/, '');
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(value))
    throw new Error('昵称或战队标签不完整。请发送「举报 正确昵称」修改；大小写及 O/0、I/l/1 不会自动替换。');
  return value;
}

// KOOK desktop uploads can arrive as type 10 image-only cards instead of type 2.
// Never choose one image from a gallery or treat arbitrary card text as a nickname.
export function cardImageUrl(content) {
  const invalid = () => { throw new Error('请一次发送一张只含昵称的图片，或发送「举报 正确昵称」。'); };
  if (typeof content !== 'string' || content.length > 4096) return invalid();
  let cards;
  try { cards = JSON.parse(content); } catch { return invalid(); }
  if (!Array.isArray(cards) || cards.length !== 1) return invalid();
  const card = cards[0];
  if (!card || (card.type !== undefined && card.type !== 'card') || !Array.isArray(card.modules) || card.modules.length !== 1) return invalid();
  const module = card.modules[0];
  if (!module || !['container', 'image-group'].includes(module.type) || !Array.isArray(module.elements) || module.elements.length !== 1) return invalid();
  const image = module.elements[0];
  if (image?.type !== 'image' || typeof image.src !== 'string' || !image.src.trim() || image.src.length > 2048) return invalid();
  return image.src;
}

export function draftContent(player) {
  return {
    subject: `请求核查玩家 ${player} 的游戏行为`,
    description: `PUBG 客服团队您好：\n\n我希望请求核查以下玩家是否存在违规行为。\n被举报玩家昵称：${player}\n游戏平台：Steam PC\n\n请根据可用的对局记录及反作弊检测信息核实，并依据核查结果处理。本次举报不预先断定对方存在作弊行为。\n\n本次仅提供玩家昵称，未提供具体对局时间或作弊证据。如需补充资料，请通过我的联系邮箱告知。\n\n谢谢。`
  };
}

export const RESULT_MESSAGES = Object.freeze({
  pending: '正在提交，结果尚未确认。',
  success: '官方已确认请求提交成功；不代表已判定违规或封禁。',
  not_sent: '尚未发送举报。请检查服务配置或官方页面后重新生成预览。',
  verification: '官方要求额外验证，请前往 PUBG 官方客服完成验证；不会自动重试。',
  unknown: '已尝试提交，未取得完整响应；不会重复提交。'
});

// Missing bot metadata requires a separate official identity lookup. Explicit conflicts never fall back.
export function validAuthorMetadata(author, userId) {
  return author === undefined || (author !== null && typeof author === 'object' && !Array.isArray(author)
    && (author.id === undefined || author.id === userId)
    && (author.bot === undefined || author.bot === false));
}

export function isAllowedMessage(event, botId) {
  return event?.channel_type === 'GROUP' && event.target_id === CHANNEL_ID && [1, 2, 9, 10].includes(event.type)
    && validId(event.author_id) && validId(botId) && event.author_id !== botId
    && validAuthorMetadata(event.extra?.author, event.author_id)
    && validMessageId(event.msg_id) && typeof event.content === 'string' && event.content.length <= 4096;
}
