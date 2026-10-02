import { AuthRequiredError, UserError, UnavailableError } from './util.js';

const MAX_RESPONSE = 8 * 1024 * 1024;
const UNAVAILABLE = '汽水音乐接口尚未配置或暂不可用。';
const NO_STREAM = '汽水音乐未提供完整可播放音源，可能需要登录、会员或当前地区没有播放权限。';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, maximum) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new UserError('汽水音乐请求数量无效。');
  return result;
};
const responseError = () => new UserError('汽水音乐接口返回的数据无效，请稍后重试。');

// IDs must stay strings: official 19-digit identifiers exceed Number precision.
export function qishuiId(input) {
  return typeof input === 'string' && /^[1-9]\d{0,18}$/.test(input.trim()) ? input.trim() : null;
}

function bridgeBase(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\s\\%]/.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password || url.search || url.hash) return null;
    const rawPath = value.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i)?.[1] || '/';
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(rawPath)) return null;
    url.pathname = url.pathname.replace(/\/$/, '');
    return url;
  } catch { return null; }
}

function safeImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return '';
}

function text(value, maximum = 160) { return typeof value === 'string' ? value.slice(0, maximum) : ''; }
function track(value) {
  if (!object(value) || !qishuiId(value.id) || typeof value.name !== 'string' || !value.name.trim() || typeof value.artists !== 'string'
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) throw responseError();
  return { id: qishuiId(value.id), name: text(value.name), artists: text(value.artists) || '未知歌手',
    durationMs: value.durationMs, cover: safeImage(value.cover), album: text(value.album), source: 'qishui' };
}
function tracks(value, limit) {
  if (!Array.isArray(value) || value.length > limit) throw responseError();
  return value.map(track);
}
function playlistInfo(value) {
  if (!object(value) || !qishuiId(value.id) || typeof value.name !== 'string') throw responseError();
  const count = (number) => Number.isSafeInteger(number) && number >= 0 ? number : 0;
  return { id: qishuiId(value.id), name: text(value.name), cover: safeImage(value.cover), trackCount: count(value.trackCount),
    playCount: count(value.playCount), description: text(value.description, 2000), creator: text(value.creator), source: 'qishui' };
}

/** Media is served by the trusted bridge through an unguessable, expiring capability path. */
export function validateQishuiMediaUrl(value, configuredBase) {
  const base = bridgeBase(configuredBase);
  try {
    if (!base || typeof value !== 'string' || value.length > 2200 || /[\s\\%]/.test(value)) throw new Error();
    const url = new URL(value);
    const prefix = `${base.pathname.replace(/\/$/, '')}/media/`;
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)
        || !/^[A-Za-z0-9_-]{32,128}(?:\.(?:mp3|m4a|aac|ogg|flac|wav))?$/.test(url.pathname.slice(prefix.length))) throw new Error();
    // Reject paths that URL parsing would normalize into an allowed capability.
    if (value !== url.href) throw new Error();
    return url.href;
  } catch { throw new UnavailableError(NO_STREAM); }
}

export class QishuiMusic {
  constructor(config, { fetchImpl = fetch, timeoutMs = 20000, streamTimeoutMs = 65000 } = {}) {
    this.base = bridgeBase(config.qishuiApiUrl);
    this.token = typeof config.qishuiApiToken === 'string' && /^[\x21-\x7e]{1,4096}$/.test(config.qishuiApiToken) ? config.qishuiApiToken : '';
    this.configured = Boolean(this.base && this.token);
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.streamTimeoutMs = streamTimeoutMs;
    this.closed = false; this.pending = new Set();
  }
  async init() { /* Missing optional configuration must not interrupt other providers. */ }
  async call(endpoint, params = {}, { method = 'GET', timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) throw new UserError('汽水音乐接口已关闭。');
    if (!this.configured) throw new UserError(UNAVAILABLE);
    const url = new URL(this.base.href);
    url.pathname = `${this.base.pathname.replace(/\/$/, '')}/${endpoint}`;
    if (method === 'GET') url.search = new URLSearchParams(params).toString();
    const controller = new AbortController(); this.pending.add(controller);
    let timer, reader;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new UserError(this.closed ? '汽水音乐接口已关闭。' : '汽水音乐请求超时，请稍后重试。')), { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    const request = async () => {
      const response = await this.fetch(url, { method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(params) } : {}) });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw new AuthRequiredError('汽水音乐账号登录已失效，请重新扫码登录。');
        if (response.status === 429) throw new UserError('汽水音乐操作过于频繁，请稍后重试。');
        if (response.status === 422) throw new UnavailableError(NO_STREAM);
        throw new UserError('汽水音乐请求失败，请稍后重试。');
      }
      if (!/^(?:application\/json|[^;]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
          || Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) {
        void response.body?.cancel().catch(() => {}); throw responseError();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, content = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE) throw responseError();
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
      let result;
      try { result = JSON.parse(content); } catch { throw responseError(); }
      if (!object(result)) throw responseError();
      return result;
    };
    try { return await Promise.race([request(), cancelled]); }
    catch (error) { if (error instanceof UserError) throw error; throw new UserError('汽水音乐请求失败，请稍后重试。'); }
    finally { clearTimeout(timer); this.pending.delete(controller); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
  async search(query, limit = 8) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) throw new UserError('请输入 1-200 字的歌曲名称。');
    limit = bounded(limit, 8, 100);
    return tracks((await this.call('search', { q: query.trim(), limit })).tracks, limit);
  }
  async resolve(input) {
    if (typeof input !== 'string') throw new UserError('汽水音乐歌曲 ID 或歌名无效。');
    const id = qishuiId(input);
    if (id) {
      const result = track((await this.call('track', { id })).track);
      if (result.id !== id) throw responseError();
      return result;
    }
    if (/^\d+$/.test(input.trim()) || /https?:\/\//i.test(input)) throw new UserError('请使用有效的汽水音乐歌曲 ID 或已识别的官方分享链接。');
    const found = await this.search(input, 1);
    if (!found.length) throw new UserError('汽水音乐没有找到该歌曲。');
    return found[0];
  }
  async playlistDetails(input, { offset = 0, limit = 50 } = {}) {
    const id = qishuiId(input); limit = bounded(limit, 50, 100);
    if (!id || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new UserError('汽水音乐歌单或分页位置无效。');
    const data = await this.call('playlist', { id, offset, limit });
    if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > 100000 || data.offset !== offset || data.limit !== limit
        || typeof data.hasMore !== 'boolean') throw responseError();
    const playlist = playlistInfo(data.playlist), page = tracks(data.tracks, limit);
    if (playlist.id !== id || page.length > Math.max(0, data.total - offset)
        || data.hasMore !== (offset + limit < data.total)) throw responseError();
    return { playlist, tracks: page, total: data.total, offset, limit, hasMore: data.hasMore,
      ...(data.partial === true ? { partial: true, notice: text(data.notice, 300),
        reportedTotal: Number.isSafeInteger(data.reportedTotal) && data.reportedTotal >= data.total ? data.reportedTotal : data.total } : {}) };
  }
  async playlist(input, limit = 100) {
    limit = bounded(limit, 100, 500); const result = [];
    for (let offset = 0; offset < limit; offset += 100) {
      const page = await this.playlistDetails(input, { offset, limit: Math.min(100, limit - offset) });
      result.push(...page.tracks);
      if (!page.hasMore) break;
    }
    return result;
  }
  async discover(category = 'hot') {
    if (!['hot', 'charts', 'acg', 'mine'].includes(category)) throw new UserError('汽水音乐歌单分类无效。');
    const data = await this.call('discover', { category });
    if (!Array.isArray(data.playlists) || data.playlists.length > 100) throw responseError();
    return data.playlists.map(playlistInfo);
  }
  async hot(limit = 30) {
    limit = bounded(limit, 30, 500); const data = await this.call('hot', { limit });
    return { mode: 'hot', name: text(data.name) || '汽水音乐热歌', tracks: tracks(data.tracks, limit) };
  }
  async hotLibrary({ offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError('热歌库分页参数无效。');
    const data = await this.call('library', { offset, limit });
    if (data.enabled === false) return { enabled: false, tracks: [], total: 0, offset, limit, hasMore: false };
    if (data.enabled !== true || !object(data.counts) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 5000
      || data.offset !== offset || data.limit !== limit || typeof data.hasMore !== 'boolean' || !Array.isArray(data.tracks) || data.tracks.length > limit) throw responseError();
    const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 5000 ? value : 0;
    const assessment = value => {
      if (!object(value) || !['prefer','keep','downrank','exclude'].includes(value.decision)) return null;
      return { decision: value.decision, version: ['original','cover','dj','live','instrumental'].includes(value.version) ? value.version : 'unknown',
        trend: ['rising','steady','revival'].includes(value.trend) ? value.trend : 'unknown', reason: text(value.reason,100),
        confidence: typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : 0,
        reviewedAt: timestamp(value.reviewedAt), model: text(value.model,80) };
    };
    const ai = object(data.ai) ? { enabled: data.ai.enabled === true, model: text(data.ai.model,80),
      status: ['disabled','pending','running','ready','partial','fallback'].includes(data.ai.status) ? data.ai.status : 'fallback',
      lastRunAt: timestamp(data.ai.lastRunAt), lastSuccessAt: timestamp(data.ai.lastSuccessAt), lastError: text(data.ai.lastError,300),
      reviewed: count(data.ai.reviewed), ruleOnly: count(data.ai.ruleOnly), excluded: count(data.ai.excluded) } : undefined;
    return { enabled: true, collecting: data.collecting === true, lastRunAt: timestamp(data.lastRunAt), lastSuccessAt: timestamp(data.lastSuccessAt),
      lastError: text(data.lastError, 300), nextRunAt: timestamp(data.nextRunAt), timezone: 'Asia/Shanghai', times: ['09:00','21:00'],
      counts: Object.fromEntries(['total','active','archived','blocked'].map(key => [key,count(data.counts[key])])),
      policy: { archiveDays: 14, deleteDays: 45 }, total: data.total, offset, limit, hasMore: data.hasMore,
      ...(ai ? { ai } : {}),
      tracks: data.tracks.map(value => ({ ...track(value), score: typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : 0,
        ruleScore: typeof value.ruleScore === 'number' && Number.isFinite(value.ruleScore) ? value.ruleScore : value.score,
        ai: assessment(value.ai),
        scoreDelta: typeof value.scoreDelta === 'number' && Number.isFinite(value.scoreDelta) ? value.scoreDelta : null,
        firstSeenAt: timestamp(value.firstSeenAt), lastSeenAt: timestamp(value.lastSeenAt), sourceCount: count(value.sourceCount),
        status: ['active','archived','blocked'].includes(value.status) ? value.status : 'active' })) };
  }
  async account() {
    if (!this.configured) return { loggedIn: false, unavailable: true, status: 'unavailable' };
    const data = await this.call('account');
    if (typeof data.loggedIn !== 'boolean') throw responseError();
    return { loggedIn: data.loggedIn, ...(data.loggedIn ? { id: text(data.id, 80), name: text(data.name), avatar: safeImage(data.avatar) } : {}),
      expired: data.expired === true, status: data.loggedIn ? 'logged_in' : data.expired ? 'expired' : 'logged_out' };
  }
  async lyrics(input) {
    const id = qishuiId(typeof input === 'object' ? input?.id : input);
    if (!id) throw new UserError('汽水音乐歌曲 ID 无效。');
    const data = await this.call('lyrics', { id });
    return { lyric: text(data.lyric, 200000), translation: text(data.translation, 200000) };
  }
  async stream(input) {
    const id = qishuiId(input?.id);
    if (!id || !Number.isSafeInteger(input?.durationMs) || input.durationMs <= 0) throw new UnavailableError(NO_STREAM);
    const data = await this.call('stream', { id }, { method: 'POST', timeoutMs: this.streamTimeoutMs });
    if (data.fullTrack !== true || data.encrypted !== false || data.preview === true || !Number.isSafeInteger(data.durationMs)
        || data.durationMs <= 0 || Math.abs(data.durationMs - input.durationMs) > 2000) throw new UnavailableError(NO_STREAM);
    return validateQishuiMediaUrl(data.url, this.base.href);
  }
  qrCreate() { throw new UserError('汽水音乐暂不支持在此页面扫码登录。'); }
  qrStatus() { throw new UserError('汽水音乐暂不支持在此页面查询扫码状态。'); }
  logout() { throw new UserError('汽水音乐暂不支持在此页面管理登录。'); }
  close() { this.closed = true; for (const controller of this.pending) controller.abort(); }
}
