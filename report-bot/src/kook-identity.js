const API = 'https://www.kookapp.cn/api/v3/user/view';
const ID = /^\d{5,30}$/;
const RESPONSE_LIMIT = 32 * 1024;
const CACHE_LIMIT = 256;
const CACHE_TTL = 5 * 60_000;

/** Button events can omit user_info and the guild; derive the guild from the allowlisted channel. */
export function createButtonAuthorResolver({ token, channelIds, fetchImpl = fetch, now = Date.now } = {}) {
  const author = createAuthorResolver({ token, fetchImpl, now, timeoutMs: 3500 });
  const allowed = new Set(channelIds), channels = new Map();
  return async ({ channelId, userId, guildId, signal } = {}) => {
    if (!allowed.has(channelId) || !ID.test(userId || '') || signal?.aborted) return null;
    let guild = ID.test(guildId || '') ? guildId : channels.get(channelId);
    if (!guild) {
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(), 3500);
      try {
        const response = await fetchImpl('https://www.kookapp.cn/api/v3/channel/view?target_id=' + channelId,
          { headers: { Authorization: `Bot ${token.trim()}` }, redirect: 'error', signal: combined });
        if (!response.ok || response.redirected) { cancelBody(response.body); return null; }
        const data = await readJson(response, combined);
        if (data?.code !== 0 || data.data?.id !== channelId || !ID.test(data.data?.guild_id || '')) return null;
        guild = data.data.guild_id; channels.set(channelId, guild);
      } catch { return null; }
      finally { clearTimeout(timer); controller.abort(); }
    }
    if (signal?.aborted) return null;
    return author({ userId, guildId: guild });
  };
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Closed body. */ }
}

async function readJson(response, signal) {
  if (Number(response.headers?.get('content-length')) > RESPONSE_LIMIT) {
    cancelBody(response.body); throw new Error('response_limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = []; let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) { cancel(); throw new Error('response_limit'); }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new Error('cancelled');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    try { reader.releaseLock(); } catch { /* A cancellation can still be pending. */ }
  }
}

/** Resolves omitted event bot flags without trusting unknown users or logging identities. */
export function createAuthorResolver({ token, fetchImpl = fetch, now = Date.now, timeoutMs = 5000,
  maxCacheEntries = CACHE_LIMIT } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > CACHE_LIMIT) {
    throw new Error('Invalid KOOK identity configuration');
  }
  const cache = new Map(), pending = new Map();
  const remember = (key, value, ttl) => {
    cache.delete(key);
    cache.set(key, { value, expires: now() + ttl });
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  };
  async function lookup(userId, guildId) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    const request = async () => {
      const url = new URL(API);
      url.searchParams.set('user_id', userId); url.searchParams.set('guild_id', guildId);
      const response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bot ${token.trim()}` }, signal: controller.signal });
      if (controller.signal.aborted) { cancelBody(response?.body); return null; }
      if (!response?.ok || response.redirected) { cancelBody(response?.body); return null; }
      const raw = await readJson(response, controller.signal);
      if (raw?.code !== 0 || raw.data?.id !== userId || typeof raw.data?.bot !== 'boolean') return null;
      return Object.freeze({ id: userId, bot: raw.data.bot });
    };
    try { return await Promise.race([request().catch(() => null), timeout]); }
    finally { clearTimeout(timer); }
  }
  return async ({ userId, guildId } = {}) => {
    if (typeof userId !== 'string' || !ID.test(userId)
      || typeof guildId !== 'string' || !ID.test(guildId)) return null;
    const key = `${guildId}:${userId}`, time = now(), existing = cache.get(key);
    if (existing && existing.expires > time) {
      cache.delete(key); cache.set(key, existing);
      return existing.value ? { ...existing.value } : null;
    }
    if (existing) cache.delete(key);
    if (pending.has(key)) {
      const value = await pending.get(key); return value ? { ...value } : null;
    }
    const task = lookup(userId, guildId).then(value => {
      // Cache verified identities only: a transient lookup failure must not block a fresh request.
      if (value) remember(key, value, CACHE_TTL);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    const value = await task;
    return value ? { ...value } : null;
  };
}
