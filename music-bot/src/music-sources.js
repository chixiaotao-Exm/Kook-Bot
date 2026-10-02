import { Music } from './music.js';
import { QQMusic } from './qq-music.js';
import { QishuiMusic } from './qishui-music.js';
import { UserError } from './util.js';
import { normalizeLyrics } from './lyrics.js';

export const SOURCE_NAMES = Object.freeze({ netease: '网易云音乐', qq: 'QQ音乐', qishui: '汽水音乐' });
export function sourceDescriptor(id, enabled = true) {
  return { id, name: SOURCE_NAMES[id], enabled,
    capabilities: { search: true, play: true, playlist: true, discover: true, lyrics: true,
      login: id !== 'qishui', heart: id === 'netease', mine: id !== 'qishui' } };
}

export function musicSource(value) {
  const source = value ?? 'netease';
  if (typeof source !== 'string' || !Object.hasOwn(SOURCE_NAMES, source)) throw new UserError('音乐平台无效，请选择网易云音乐、QQ 音乐或汽水音乐。');
  return source;
}
export function validTrack(track) {
  if (!track || typeof track.id !== 'string' || typeof track.name !== 'string' || typeof track.artists !== 'string') return false;
  if ((track.source ?? 'netease') === 'netease') return /^[1-9]\d{0,17}$/.test(track.id);
  if (track.source === 'qishui') return /^[1-9]\d{0,18}$/.test(track.id);
  return track.source === 'qq' && /^[A-Za-z0-9]{1,40}$/.test(track.id);
}
const tag = (item, source) => ({ ...item, source });
export class MusicSources {
  constructor(config, providers) {
    if (providers) this.providers = providers;
    else {
      this.providers = { netease: new Music(config), qq: new QQMusic(config) };
      const qishui = new QishuiMusic(config);
      if (qishui.configured) this.providers.qishui = qishui;
    }
  }
  sources() { return Object.keys(SOURCE_NAMES).map((id) => sourceDescriptor(id, Boolean(this.providers[id]) && this.providers[id].configured !== false)); }
  async init() { await Promise.all(Object.values(this.providers).map((provider) => provider.init?.())); }
  forSource(value) {
    const source = musicSource(value), provider = this.providers[source];
    if (!provider || provider.configured === false) throw new UserError('该音乐平台暂不可用。');
    return provider;
  }
  async search(query, limit = 8, source = 'netease') { return (await this.forSource(source).search(query, limit)).map((t) => tag(t, source)); }
  async parseInput(input, options = {}) {
    const { parseMusicInputAsync } = await import('./short-links.js');
    return parseMusicInputAsync(input, options);
  }
  async searchAll(query, limit = 20) {
    const input = String(query || '').trim();
    if (!input || input.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError('请输入 1-200 字的歌名或歌手，每个平台最多查询 100 首。');
    const sources = this.sources().filter((item) => item.enabled).map((item) => item.id);
    const settled = await Promise.allSettled(sources.map((source) => this.search(input, limit, source)));
    const results = Object.fromEntries(sources.map((source, index) => {
      const result = settled[index];
      return [source, result.status === 'fulfilled' ? { tracks: result.value } : { tracks: [],
        error: result.reason instanceof UserError ? result.reason.message : `${SOURCE_NAMES[source]}搜索暂不可用，请稍后重试。`,
        ...(result.reason?.code === 'QQ_RATE_LIMIT' ? { retryAfterSeconds: result.reason.retryAfterSeconds } : {}) }];
    }));
    const tracks = [];
    for (let i = 0; i < Math.max(...sources.map((source) => results[source].tracks.length)); i++) {
      for (const source of sources) if (results[source].tracks[i]) tracks.push(results[source].tracks[i]);
    }
    return { tracks, results };
  }
  async lyrics(trackOrId, source) {
    const selected = musicSource(source ?? trackOrId?.source ?? 'netease');
    const id = String(typeof trackOrId === 'object' ? trackOrId?.id || trackOrId?.mid || '' : trackOrId || '');
    const provider = this.forSource(selected);
    const raw = provider.lyrics ? await provider.lyrics(trackOrId) : {};
    return { source: selected, id, ...normalizeLyrics(raw) };
  }
  async resolve(input, source = 'netease') { return tag(await this.forSource(source).resolve(input), source); }
  async playlist(input, limit, source = 'netease') { return (await this.forSource(source).playlist(input, limit)).map((t) => tag(t, source)); }
  async playlistDetails(input, page, source = 'netease') {
    const details = await this.forSource(source).playlistDetails(input, page);
    return { ...details, playlist: tag(details.playlist, source), tracks: details.tracks.map((t) => tag(t, source)) };
  }
  async discover(category, source = 'netease') {
    if (source === 'qishui' && category === 'mine') throw new UserError('汽水音乐暂不支持“我的收藏”，请使用推荐歌单或热歌。');
    return (await this.forSource(source).discover(category)).map((p) => tag(p, source));
  }
  async account(source = 'netease') { return { ...await this.forSource(source).account(), source }; }
  async hotLibrary(page) {
    const provider = this.providers.qishui;
    return provider?.configured !== false && provider?.hotLibrary ? provider.hotLibrary(page) : { enabled: false, tracks: [], total: 0, ...page, hasMore: false };
  }
  async hot(limit, source = 'netease') {
    const result = await this.forSource(source).hot(limit);
    return { ...result, tracks: result.tracks.map((t) => tag(t, source)) };
  }
  async heart(options, source = 'netease') {
    if (musicSource(source) === 'qq') throw new UserError('QQ 音乐请使用“我的收藏”或“热歌榜”。');
    if (source === 'qishui') throw new UserError('汽水音乐暂不支持心动模式，请使用热歌或推荐歌单。');
    const result = await this.forSource(source).heart(options);
    return { ...result, tracks: result.tracks.map((t) => tag(t, source)) };
  }
  stream(track) { return this.forSource(track.source).stream(track); }
  close() { for (const provider of Object.values(this.providers)) provider.close?.(); }
}
