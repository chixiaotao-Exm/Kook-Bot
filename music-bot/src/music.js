import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { UserError, UnavailableError, musicId, validateMediaUrl, withTimeout } from './util.js';
import { createProvider } from './provider.js';

export function normalizeSong(song) {
  return {
    id: String(song.id), name: String(song.name || '未知歌曲').slice(0, 160),
    artists: (song.ar || song.artists || []).map((a) => a.name).join(' / ').slice(0, 160) || '未知歌手',
    durationMs: Number(song.dt || song.duration || 0),
    cover: safeImage(song.al?.picUrl || song.album?.picUrl || ''),
    album: String(song.al?.name || song.album?.name || '').slice(0, 160),
  };
}

export function safeImage(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && /(^|\.)music\.126\.net$/.test(url.hostname)) {
      url.protocol = 'https:'; return url.href;
    }
  } catch {}
  return '';
}

export function normalizePlaylist(p) {
  return { id: String(p.id), name: String(p.name || '').slice(0, 160), cover: safeImage(p.coverImgUrl),
    trackCount: Number(p.trackCount || 0), playCount: Number(p.playCount || 0),
    description: String(p.description || p.updateFrequency || '').slice(0, 200) };
}

export class Music {
  constructor(config, sdk) { this.config = config; this.sdk = sdk; }
  async init() {
    if (this.sdk) return;
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.sdk = createProvider();
  }
  async cookie() {
    if (this.config.cookie) return this.config.cookie;
    try { return JSON.parse(await readFile(path.join(this.config.dataDir, 'netease-cookie.json'), 'utf8')).cookie || ''; }
    catch (error) { if (error.code === 'ENOENT') return ''; throw new UserError('网易云登录文件损坏，请重新扫码登录。'); }
  }
  async call(name, params = {}, accepted = [200]) {
    try {
      const result = await withTimeout(this.sdk[name]({
        cookie: await this.cookie(), timeout: 12000, ...params, unblock: 'false',
      }), 20000);
      const body = result.body;
      if (!body || !accepted.includes(Number(body.code))) throw new Error('Provider response');
      return body;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError('网易云请求失败，请检查网络或重新扫码登录。');
    }
  }
  async search(keywords, limit = 8) {
    const body = await this.call('cloudsearch', { keywords: keywords.slice(0, 200), type: 1, limit });
    return (body.result?.songs || []).map(normalizeSong);
  }
  async resolve(input) {
    const id = musicId(input);
    if (id) {
      const body = await this.call('song_detail', { ids: id });
      if (!body.songs?.length) throw new UserError('未找到该歌曲。');
      return normalizeSong(body.songs[0]);
    }
    if (/https?:\/\//i.test(input)) throw new UserError('请使用网易云歌曲完整链接、歌曲 ID 或歌名；暂不支持短链接。');
    const songs = await this.search(input, 1);
    if (!songs.length) throw new UserError('没有搜索到歌曲。');
    return songs[0];
  }
  async playlist(input, limit) {
    const id = musicId(input, 'playlist');
    if (!id) throw new UserError('请提供网易云歌单 ID 或完整歌单链接。');
    const body = await this.call('playlist_track_all', { id, limit });
    return (body.songs || []).map(normalizeSong);
  }
  async playlistDetails(input, { offset = 0, limit = 50 } = {}) {
    const id = musicId(String(input), 'playlist');
    if (!id) throw new UserError('请提供有效的网易云歌单 ID。');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new UserError('歌单分页位置无效，每页可读取 1-100 首歌曲。');
    }
    const detail = (await this.call('playlist_detail', { id })).playlist;
    if (!detail || !Array.isArray(detail.trackIds)) throw new UserError('歌单详情暂不可用，请稍后重试。');
    const ids = detail.trackIds.map((item) => String(item?.id ?? ''));
    if (ids.some((songId) => !/^[1-9]\d{0,17}$/.test(songId))) throw new UserError('歌单歌曲列表暂不可用，请稍后重试。');
    const page = ids.slice(offset, offset + limit);
    let tracks = [];
    if (page.length) {
      const body = await this.call('song_detail', { ids: page.join(',') });
      if (!Array.isArray(body.songs)) throw new UserError('歌单歌曲详情暂不可用，请稍后重试。');
      const songs = new Map(body.songs.filter((song) => song && page.includes(String(song.id)))
        .map((song) => [String(song.id), normalizeSong(song)]));
      tracks = page.map((songId) => songs.get(songId)).filter(Boolean);
    }
    return { playlist: { ...normalizePlaylist(detail), id,
      description: String(detail.description || '').slice(0, 2000),
      creator: String(detail.creator?.nickname || '').slice(0, 160), trackCount: ids.length },
    tracks, total: ids.length, offset, limit, hasMore: offset + limit < ids.length };
  }
  async account() {
    if (!(await this.cookie())) return { loggedIn: false };
    const body = await this.call('user_account');
    const p = body.profile;
    return p?.userId ? { loggedIn: true, id: String(p.userId), name: p.nickname, avatar: safeImage(p.avatarUrl) } : { loggedIn: false, expired: true };
  }
  async discover(category = 'hot') {
    if (category === 'charts') return ((await this.call('toplist')).list || []).slice(0, 20).map(normalizePlaylist);
    if (category === 'mine') {
      const account = await this.account();
      if (!account.loggedIn) throw new UserError('请先登录网易云音乐。');
      return ((await this.call('user_playlist', { uid: account.id, limit: 50 })).playlist || []).map(normalizePlaylist);
    }
    return ((await this.call('top_playlist', { order: 'hot', cat: category === 'acg' ? 'ACG' : '全部', limit: 12 })).playlists || []).map(normalizePlaylist);
  }
  async hot(limit = 30) {
    const lists = await this.discover('charts');
    const chart = lists.find((p) => p.name === '热歌榜') || lists.find((p) => /热歌|飙升/.test(p.name));
    if (!chart) throw new UserError('暂时无法获取热歌榜，请稍后再试。');
    return { mode: 'hot', name: chart.name, tracks: await this.playlist(chart.id, limit) };
  }
  async heart({ playlistId, songId, limit = 20 } = {}) {
    try {
      if (!(await this.account()).loggedIn) throw new UserError('尚未登录');
      const own = playlistId ? null : (await this.discover('mine'))[0];
      const pid = playlistId || own?.id;
      if (!pid || !musicId(pid, 'playlist')) throw new UserError('没有可用歌单');
      const seed = songId || (await this.playlist(pid, 1))[0]?.id;
      if (!seed) throw new UserError('没有种子歌曲');
      const body = await this.call('playmode_intelligence_list', { id: seed, pid, count: Math.min(limit, 30) });
      const tracks = (body.data || []).map((x) => x.songInfo || x).filter((x) => x.id && x.name).map(normalizeSong).slice(0, limit);
      if (!tracks.length) throw new UserError('心动模式无结果');
      return { mode: 'heart', name: '心动模式', tracks };
    } catch {
      return { ...(await this.hot(limit)), notice: '心动模式当前不可用，已切换为网易云热歌榜。' };
    }
  }
  async stream(track) {
    const body = await this.call('song_url_v1', { id: track.id, level: 'standard' });
    const item = body.data?.find((entry) => String(entry.id) === track.id);
    if (!item?.url) throw new UnavailableError('这首歌暂无可播放音源，可能需要登录、会员或购买。');
    if (item.freeTrialInfo && item.freeTrialInfo !== 'null') throw new UnavailableError('网易云仅返回试听片段，已跳过；请使用有完整播放权限的账号。');
    return validateMediaUrl(item.url);
  }
  async lyrics(track) {
    const id = musicId(String(typeof track === 'object' ? track?.id || '' : track || ''));
    if (!id) throw new UserError('网易云歌曲 ID 无效。');
    const body = await this.call('lyric', { id });
    return { lyric: body.lrc?.lyric || '', translation: body.tlyric?.lyric || '',
      ...(body.nolyric || body.uncollected ? { notice: '这首歌暂未提供歌词，可能是纯音乐。' } : {}) };
  }
  close() { this.sdk?.close?.(); }
}
