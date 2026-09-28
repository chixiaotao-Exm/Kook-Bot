import { UserError, UnavailableError } from '../src/util.js';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_TRACKS = 500;
const MAX_PAGES = 5;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEB_PARAMS = { aid: '386088', device_platform: 'web', channel: 'pc_web' };
const ENDPOINTS = Object.freeze({
  search: 'https://api.qishui.com/luna/search/track',
  playlists: 'https://api.qishui.com/luna/search/playlist',
  playlist: 'https://api.qishui.com/luna/pc/playlist/detail',
  track: 'https://beta-luna.douyin.com/luna/h5/seo_track',
});
const IMAGE_HOSTS = ['douyinpic.com', 'byteimg.com', 'pstatp.com'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new UserError('汽水音乐目录数据无效，请稍后重试。');
const text = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function identifier(value, upstream = false) {
  if (upstream && Number.isSafeInteger(value) && value > 0) value = String(value);
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value.trim()) ? value.trim() : null;
}
function requireId(value) {
  const id = identifier(value);
  if (!id) throw new UserError('汽水音乐 ID 无效，请使用字符串形式的数字 ID。');
  return id;
}
function bounded(value, fallback, maximum) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new UserError('汽水音乐请求数量无效。');
  return value;
}
function queryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new UserError('请输入 1-200 字的歌曲名称。');
  return value.trim();
}

function safeImage(value) {
  let candidate = '';
  if (typeof value === 'string') candidate = value;
  else if (isObject(value)) {
    // The official cover object supplies a CDN prefix and a relative object key.
    if (Array.isArray(value.urls) && typeof value.urls[0] === 'string') {
      const key = typeof value.uri === 'string' ? value.uri : '';
      if (key && (!/^[A-Za-z0-9_./-]+$/.test(key) || key.split('/').includes('..'))) return '';
      candidate = `${value.urls[0]}${key}`;
    } else candidate = typeof value.url === 'string' ? value.url : '';
  }
  if (!candidate || candidate.length > 2000 || /[\s\\]/.test(candidate)) return '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || !IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return '';
    return url.href;
  } catch { return ''; }
}

function normalizeTrack(value) {
  const id = identifier(value?.id, true), name = text(value?.name);
  const durationMs = value?.duration ?? value?.duration_ms;
  if (!isObject(value) || !id || !name || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86400000
      || !Array.isArray(value.artists)) throw invalid();
  const artists = value.artists.map((artist) => text(artist?.name) || text(artist?.simple_display_name)).filter(Boolean).join(' / ');
  return { id, name, artists: artists.slice(0, 160) || '未知歌手', durationMs,
    cover: safeImage(value.album?.url_cover ?? value.album?.cover_url), album: text(value.album?.name), source: 'qishui' };
}
function normalizePlaylist(value) {
  const id = identifier(value?.id, true), name = text(value?.title) || text(value?.name);
  if (!isObject(value) || !id || !name) throw invalid();
  return { id, name, cover: safeImage(value.url_cover ?? value.cover_url),
    trackCount: count(value.count_tracks ?? value.track_count), playCount: count(value.stats?.count_play),
    description: text(value.desc ?? value.description, 2000), creator: text(value.owner?.nickname), source: 'qishui' };
}
function searchEntities(data, key) {
  if (!Array.isArray(data.result_groups)) throw invalid();
  const entities = [];
  for (const group of data.result_groups) {
    if (!Array.isArray(group?.data)) throw invalid();
    for (const row of group.data) if (row?.entity?.[key]) entities.push(row.entity[key]);
  }
  return entities;
}
function distinctValid(values, normalize, maximum) {
  const result = [], seen = new Set();
  for (const value of values) {
    let item;
    try { item = normalize(value); } catch { continue; }
    if (seen.has(item.id)) continue;
    result.push(item); seen.add(item.id);
    if (result.length >= maximum) break;
  }
  return result;
}
function lyricText(value) {
  const content = typeof value === 'string' ? value : value?.content;
  if (typeof content !== 'string') return '';
  if (content.length > 200000) throw invalid();
  if (!/^\[\d+,\d+\]/m.test(content)) return content;
  // The web SEO endpoint returns decoded KRC syllable timing; clients consume LRC.
  return content.split(/\r?\n/).map((line) => line.replace(/^\[(\d+),\d+\]/, (_all, milliseconds) => {
    const value = Number(milliseconds);
    if (!Number.isSafeInteger(value)) throw invalid();
    return `[${String(Math.floor(value / 60000)).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(Math.floor(value / 10) % 100).padStart(2, '0')}]`;
  }).replace(/<\d+,\d+,\d+>/g, '')).join('\n');
}

/** Anonymous official metadata only. This class never returns audio URLs or cookies. */
export class QishuiCatalog {
  constructor({ fetchImpl = fetch, timeoutMs = 20000, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.now = now;
    this.closed = false; this.pending = new Set(); this.cache = new Map();
  }
  async request(endpoint, params = {}) {
    if (this.closed) throw new UserError('汽水音乐目录已关闭。');
    if (!Object.hasOwn(ENDPOINTS, endpoint)) throw new UserError('汽水音乐目录接口无效。');
    const url = new URL(ENDPOINTS[endpoint]);
    url.search = new URLSearchParams({ ...(endpoint === 'track' ? { device_platform: 'web' } : WEB_PARAMS), ...params }).toString();
    const controller = new AbortController(); this.pending.add(controller);
    let timer, reader;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new UserError(this.closed ? '汽水音乐目录已关闭。' : '汽水音乐目录请求超时，请稍后重试。')), { once: true });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    const operation = async () => {
      const response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { 'User-Agent': BROWSER_UA } });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw invalid(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new UserError(response.status === 429 ? '汽水音乐查询过于频繁，请稍后重试。' : '汽水音乐目录请求失败，请稍后重试。');
      }
      if (!/^(?:application\/json|[^;]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
          || Number(response.headers.get('content-length')) > MAX_BODY || !response.body) {
        void response.body?.cancel().catch(() => {}); throw invalid();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, content = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) throw invalid();
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
      let result;
      try { result = JSON.parse(content); } catch { throw invalid(); }
      if (!isObject(result)) throw invalid();
      const code = result.status_info?.status_code ?? result.status_code;
      if (code !== undefined && code !== 0 && code !== '0') throw new UserError('汽水音乐目录暂不可用，请稍后重试。');
      return result;
    };
    try { return await Promise.race([operation(), cancelled]); }
    catch (error) { if (error instanceof UserError) throw error; throw new UserError('汽水音乐目录请求失败，请稍后重试。'); }
    finally { clearTimeout(timer); this.pending.delete(controller); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
  getCached(key) {
    if (this.closed) throw new UserError('汽水音乐目录已关闭。');
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.cache.delete(key); return null; }
    return structuredClone(entry.value);
  }
  putCached(key, value) {
    this.cache.delete(key);
    while (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { value: structuredClone(value), expires: this.now() + 60000 });
    return value;
  }
  async search(query, limit = 8) {
    query = queryText(query); limit = bounded(limit, 8, 100);
    const data = await this.request('search', { q: query, cursor: '0', count: String(limit) });
    return distinctValid(searchEntities(data, 'track'), normalizeTrack, limit);
  }
  async seo(input) {
    const id = requireId(input), cached = this.getCached(`track:${id}`);
    if (cached) return cached;
    const data = await this.request('track', { track_id: id });
    const track = normalizeTrack(data.seo_track?.track);
    if (track.id !== id) throw invalid();
    return this.putCached(`track:${id}`, { track, lyrics: { lyric: lyricText(data.lyric), translation: lyricText(data.translation_lyric) } });
  }
  async track(input) { return (await this.seo(input)).track; }
  async lyrics(input) { return (await this.seo(isObject(input) ? input.id : input)).lyrics; }
  async playlistSnapshot(input) {
    const id = requireId(input), cached = this.getCached(`playlist:${id}`);
    if (cached) return cached;
    let cursor = '0', playlist, reportedTotal = 0, incomplete = false;
    const tracks = [], seen = new Set(), cursors = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      cursors.add(cursor);
      const data = await this.request('playlist', { playlist_id: id, cursor, cnt: '100' });
      const info = normalizePlaylist(data.playlist);
      if (info.id !== id || !Array.isArray(data.media_resources)) throw invalid();
      playlist ??= info; reportedTotal = Math.max(reportedTotal, info.trackCount);
      let added = 0;
      for (const row of data.media_resources) {
        const raw = row?.entity?.track_wrapper?.track ?? row?.entity?.track;
        if (!raw) continue;
        let track;
        try { track = normalizeTrack(raw); } catch { continue; }
        if (seen.has(track.id)) continue;
        tracks.push(track); seen.add(track.id); added++;
        if (tracks.length >= MAX_TRACKS) break;
      }
      const next = data.next_cursor;
      const hasNext = typeof next === 'string' && /^[\x21-\x7e]{1,512}$/.test(next) && next !== '0';
      // This endpoint can return the whole playlist while still supplying next_cursor.
      if (reportedTotal > 0 && tracks.length >= reportedTotal) break;
      if (!added || tracks.length >= MAX_TRACKS || page === MAX_PAGES - 1 || !hasNext || cursors.has(next)) {
        incomplete = hasNext || tracks.length >= MAX_TRACKS;
        break;
      }
      cursor = next;
    }
    const partial = reportedTotal > tracks.length || incomplete;
    return this.putCached(`playlist:${id}`, { playlist, tracks, reportedTotal, partial,
      ...(partial ? { notice: `${reportedTotal ? `此歌单标注 ${reportedTotal} 首，` : '此歌单尚未确认完整曲目，'}当前已读取 ${tracks.length} 首（最多 500 首），仅展示已读取歌曲。` } : {}) });
  }
  async playlistDetails(input, { offset = 0, limit = 50 } = {}) {
    requireId(input); limit = bounded(limit, 50, 100);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new UserError('汽水音乐歌单分页位置无效。');
    const data = await this.playlistSnapshot(input), total = data.tracks.length;
    return { playlist: data.playlist, tracks: data.tracks.slice(offset, offset + limit), total, offset, limit,
      hasMore: offset + limit < total, reportedTotal: data.reportedTotal, partial: data.partial, ...(data.notice ? { notice: data.notice } : {}) };
  }
  async playlist(input, limit = 100) {
    requireId(input); limit = bounded(limit, 100, MAX_TRACKS);
    return (await this.playlistSnapshot(input)).tracks.slice(0, limit);
  }
  async discover(category = 'hot') {
    if (category === 'mine') throw new UnavailableError('汽水音乐暂不支持读取我的歌单。');
    if (!['hot', 'charts', 'acg'].includes(category)) throw new UserError('汽水音乐歌单分类无效。');
    const query = { hot: '热歌', charts: '排行榜', acg: '动漫 ACG' }[category];
    const data = await this.request('playlists', { q: query, cursor: '0', count: '20' });
    return distinctValid(searchEntities(data, 'playlist'), normalizePlaylist, 20);
  }
  async hot(limit = 30) {
    limit = bounded(limit, 30, MAX_TRACKS);
    const choices = await this.discover('hot');
    for (const choice of choices.slice(0, 3)) {
      const tracks = await this.playlist(choice.id, limit);
      if (tracks.length) return { mode: 'hot', name: choice.name, tracks };
    }
    throw new UnavailableError('汽水音乐暂未找到可读取的热门歌单。');
  }
  close() { this.closed = true; this.cache.clear(); for (const controller of this.pending) controller.abort(); }
}
