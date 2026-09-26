import { randomBytes } from 'node:crypto';

const PREFIX = 'menu-page:';
const CALLBACK = /^menu-page:([a-f0-9]{32}):([1-9]\d{0,3})$/u;
const TITLE = '中文菜单 · 菜品搜索';
const MAX_SESSIONS = 500;
const TTL_MS = 24 * 60 * 60 * 1000;

function reply(result, sessionId) {
  const buttons = [];
  if (sessionId) {
    if (result.page > 1) buttons.push({ label: '上一页', value: `${PREFIX}${sessionId}:${result.page - 1}` });
    if (result.page < result.pageCount) buttons.push({ label: '下一页', value: `${PREFIX}${sessionId}:${result.page + 1}` });
  }
  // Manual page commands remain supported by the search engine. Cards use buttons.
  const text = result.text.replace(/\n查看下一页：搜索[^\n]+ 第\d+页$/u, '');
  return { text, title: TITLE, buttons, ...(sessionId ? { sessionId } : {}) };
}

/** Bounded, short-lived page state. Queries never appear in button callbacks. */
export function createSearchPages({ search, now = Date.now, ttlMs = TTL_MS, maxSessions = MAX_SESSIONS } = {}) {
  if (typeof search !== 'function') throw new TypeError('search must be a function');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > TTL_MS) throw new TypeError('invalid page TTL');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS) throw new TypeError('invalid page capacity');
  const sessions = new Map();
  function prune() {
    const time = now();
    for (const [id, session] of sessions) if (session.expiresAt <= time) sessions.delete(id);
  }
  function locate(value, { channelId, messageId } = {}) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
    const match = CALLBACK.exec(value);
    if (!match) return { error: 'invalid' };
    prune();
    const session = sessions.get(match[1]);
    if (!session) return { error: 'expired' };
    const page = Number(match[2]);
    if (!session.messageId || session.channelId !== channelId || session.messageId !== messageId
      || page < 1 || page > session.pageCount) return { error: 'invalid' };
    return { session, sessionId: match[1], page };
  }
  return {
    create(text, { channelId, guildId } = {}) {
      const result = search(text);
      if (!result) return null;
      if (result.pageCount <= 1 || !result.items?.length) return reply(result);
      if (typeof channelId !== 'string' || !channelId || (guildId !== undefined && (typeof guildId !== 'string' || !guildId))) {
        throw new TypeError('channelId and optional guildId must be nonempty strings');
      }
      prune();
      while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      const sessionId = randomBytes(16).toString('hex');
      sessions.set(sessionId, { query: result.query, channelId, guildId: guildId ?? null, pageCount: result.pageCount,
        messageId: null, expiresAt: now() + ttlMs });
      return reply(result, sessionId);
    },
    bind(sessionId, messageId) {
      prune();
      const session = sessions.get(sessionId);
      if (!session || typeof messageId !== 'string' || !messageId || (session.messageId && session.messageId !== messageId)) return false;
      session.messageId = messageId;
      return true;
    },
    context(value, context) {
      const found = locate(value, context);
      return found?.session ? { guildId: found.session.guildId } : null;
    },
    resolve(value, context) {
      const found = locate(value, context);
      if (!found || found.error) return found;
      const result = search(`搜索${found.session.query} 第${found.page}页`);
      if (!result?.items?.length || result.pageCount !== found.session.pageCount || result.page !== found.page) {
        sessions.delete(found.sessionId);
        return { error: 'expired' };
      }
      return reply(result, found.sessionId);
    },
    status() {
      prune();
      return { sessions: sessions.size, maxSessions, ttlMs };
    },
  };
}
