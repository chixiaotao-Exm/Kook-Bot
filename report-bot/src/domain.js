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
    throw new Error('Provide one line containing a nickname. Edit multiple lines of recognized text manually.');
  // Only a complete leading clan tag is removed. Preserve case and ambiguous OCR characters.
  const value = raw.trim().replace(/^(?:\[[^\[\]]{1,40}\]|【[^【】]{1,40}】|［[^［］]{1,40}］)\s*/, '');
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(value))
    throw new Error('The nickname or clan tag is incomplete. Send "report CorrectNickname" to edit it. Letter case and O/0 or I/l/1 are never changed automatically.');
  return value;
}

// KOOK desktop uploads can arrive as type 10 image-only cards instead of type 2.
// Never choose one image from a gallery or treat arbitrary card text as a nickname.
export function cardImageUrl(content) {
  const invalid = () => { throw new Error('Send one image containing only a nickname, or send "report CorrectNickname".'); };
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
    subject: `Request to review player ${player}'s gameplay`,
    description: `Dear PUBG Support Team,\n\nI would like to request a review of the following player for possible rule violations.\nReported player's nickname: ${player}\nPlatform: Steam PC\n\nPlease review the available match records and anti-cheat information, and take any appropriate action based on your findings. This report does not assume that the player has cheated.\n\nOnly the player's nickname is provided. No specific match time or evidence of cheating is included. Please contact me at my email address if you need additional information.\n\nThank you.`
  };
}

export const RESULT_MESSAGES = Object.freeze({
  pending: 'Submitting. The result has not been confirmed.',
  success: 'PUBG Support has confirmed receipt of the request. This does not mean a violation or ban has been confirmed.',
  not_sent: 'The report has not been sent. Check the service configuration or official website, then create a new preview.',
  verification: 'Additional verification is required. Complete it on the official PUBG Support website. No automatic retry will be made.',
  unknown: 'Submission attempted without a complete response. The report will not be submitted again.'
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
