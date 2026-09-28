import { UserError, musicId } from './util.js';
import { qqId } from './qq-music.js';
import { qishuiId } from './qishui-music.js';
import { musicSource } from './music-sources.js';

// The synchronous parser never follows links. Async expansion is opt-in.
export const MUSIC_LINK_HOSTS = Object.freeze({
  netease: Object.freeze(['music.163.com', 'y.music.163.com']),
  qq: Object.freeze(['y.qq.com', 'i.y.qq.com']),
  qishui: Object.freeze(['music.douyin.com']),
});
const shortHosts = new Set(['163cn.tv', '163cn.com', 'c3.y.qq.com', 'c5.y.qq.com', 'c6.y.qq.com', 'c.y.qq.com']);
const numeric = /^[1-9]\d{0,17}$/;
const qqNumeric = /^[1-9]\d{0,18}$/;
const qqSong = /^(?:[1-9]\d{0,18}|[A-Za-z0-9]{14})$/;
const invalidLink = () => new UserError('暂未识别这条链接，请粘贴 QQ 音乐、网易云或汽水音乐的官方完整歌曲／歌单链接。');
const shortLink = () => Object.assign(new UserError('分享短链接需要展开后识别，请稍后重试或复制官方完整链接。'), { code: 'MUSIC_SHORT_LINK' });

function oneId(values, pattern) {
  if (!values.length || values.some((value) => !pattern.test(value)) || new Set(values).size !== 1) throw invalidLink();
  return values[0];
}

function neteaseLink(url) {
  let route = url;
  if (url.hash.startsWith('#/')) {
    if (!/^\/(?:m\/)?$/.test(url.pathname)) throw invalidLink();
    route = new URL(url.hash.slice(1), url.origin);
    if (route.origin !== url.origin || route.hash) throw invalidLink();
  }
  const match = route.pathname.match(/^\/(?:m\/)?(song|playlist)\/?$/);
  if (!match) throw invalidLink();
  const ids = route.searchParams.getAll('id');
  if (route !== url) ids.push(...url.searchParams.getAll('id'));
  const id = oneId(ids, numeric);
  if (musicId(id, match[1]) !== id) throw invalidLink();
  return { source: 'netease', kind: match[1], id, input: id, isLink: true };
}

function qqLink(url) {
  if (/^\/n\/ryqq(?:_v2)?\/songDetail\/?$/i.test(url.pathname) && !url.search) throw invalidLink();
  // Official desktop/mobile routes. Whole-route matches avoid interpreting a
  // redirect or an unrelated path containing words such as "song" as a song.
  const path = url.pathname;
  const prefix = '(?:(?:n/(?:ryqq|ryqq_v2|yqq)/)|(?:n2/m/share/details/))?';
  const song = path.match(new RegExp(`^/${prefix}(?:songDetail|song)(?:/([A-Za-z0-9]+))?(?:\\.html)?/?$`, 'i'))
    || path.match(/^\/v8\/playsong\.html?$/i);
  const playlist = path.match(new RegExp(`^/${prefix}(?:playlist|taoge|playsquare|songlist)(?:/([1-9]\\d*)|/index)?(?:\\.html)?/?$`, 'i'));
  const chart = path.match(new RegExp(`^/${prefix}(?:toplist|top)(?:/([1-9]\\d*))?(?:\\.html)?/?$`, 'i'));
  if (!song && !playlist && !chart) {
    if (/^\/(?:base\/fcgi-bin\/u|n\/m\/detail)\b/.test(path) || url.searchParams.has('ADTAG') && path === '/') throw shortLink();
    throw invalidLink();
  }
  const kind = song ? 'song' : 'playlist';
  const accepted = song ? ['songmid', 'songid'] : chart ? ['topid'] : ['disstid', 'id'];
  const reserved = ['songmid', 'songid', 'topid', 'disstid', 'id'];
  if (reserved.some((key) => !accepted.includes(key) && url.searchParams.has(key))) throw invalidLink();
  const ids = accepted.flatMap((key) => url.searchParams.getAll(key));
  const pathId = (song || playlist || chart)[1];
  if (pathId) ids.push(pathId);
  const id = (chart ? 'top:' : '') + oneId(ids, song ? qqSong : chart ? /^[1-9]\d{0,5}$/ : qqNumeric);
  if (qqId(id, kind) !== id) throw invalidLink();
  return { source: 'qq', kind, id, input: id, isLink: true };
}

function qishuiLink(url) {
  // Only verified official full share routes are accepted. Arbitrary redirects,
  // download pages and embedded track_id strings never become provider input.
  const route = url.pathname.match(/^\/qishui\/share\/(track|playlist)\/?$/);
  if (!route || url.hash) throw invalidLink();
  const parameter = route[1] === 'track' ? 'track_id' : 'playlist_id';
  if (['track_id', 'playlist_id', 'id'].some((key) => key !== parameter && url.searchParams.has(key))) throw invalidLink();
  const id = oneId(url.searchParams.getAll(parameter), /^[1-9]\d{0,18}$/);
  return { source: 'qishui', kind: route[1] === 'track' ? 'song' : 'playlist', id, input: id, isLink: true };
}

/** Classify user input without network access or retaining share credentials. */
export function musicInputUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000) throw new UserError('请输入歌名、ID 或完整链接，分享文本最多 2000 字。');
  const value = input.trim();
  const urls = value.match(/[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s<>"“”‘’「」『』【】，。；！？、）》）]+/g) || [];
  if ((value.match(/[A-Za-z][A-Za-z\d+.-]*:\/\//g) || []).length > 1) throw new UserError('一次只能识别一个链接，请分别粘贴。');
  if (urls.length) {
    const raw = urls[0].replace(/[，。；！？、）》】,.!?;）\]]+$/u, '');
    if (!/^https?:\/\//i.test(raw) || raw.includes('\\')) throw invalidLink();
    let url; try { url = new URL(raw); } catch { throw invalidLink(); }
    if (url.username || url.password || url.port || /[\u0000-\u0020\u007f]/.test(raw)) throw invalidLink();
    return url;
  }
  return null;
}

export function parseMusicInput(input, { source = 'netease', kind, hosts = MUSIC_LINK_HOSTS } = {}) {
  const selected = musicSource(source);
  if (kind !== undefined && !['song', 'playlist'].includes(kind)) throw new UserError('请选择歌曲或歌单。');
  const url = musicInputUrl(input), value = input.trim();
  if (url) {
    if (shortHosts.has(url.hostname)) throw shortLink();
    if (hosts.netease?.includes(url.hostname) && MUSIC_LINK_HOSTS.netease.includes(url.hostname)) return neteaseLink(url);
    if (hosts.qq?.includes(url.hostname) && MUSIC_LINK_HOSTS.qq.includes(url.hostname)) return qqLink(url);
    if (hosts.qishui?.includes(url.hostname) && MUSIC_LINK_HOSTS.qishui.includes(url.hostname)) return qishuiLink(url);
    throw invalidLink();
  }
  // URL-like values must never silently turn into a search against a provider.
  if (/(?:[A-Za-z][A-Za-z\d+.-]*:(?!\s)|(?:^|\s)\/\/|(?:music\.163\.com|(?:^|\.)y\.qq\.com|163cn\.tv|(?:music|qishui)\.douyin\.com)(?:\/|\b))/i.test(value)) {
    if (!(selected === 'qq' && /^top:[1-9]\d{0,5}$/.test(value))) throw invalidLink();
  }
  const inputKind = kind || (selected === 'qq' && /^top:/.test(value) ? 'playlist' : 'song');
  const id = selected === 'qq' ? qqId(value, inputKind) : selected === 'qishui' ? qishuiId(value) : musicId(value, inputKind);
  if (id) return { source: selected, kind: inputKind, id, input: id, isLink: false };
  if (/^\d+$/.test(value)) throw new UserError('歌曲或歌单 ID 无效，请重新复制完整 ID。');
  if (inputKind === 'playlist') throw new UserError('请输入有效的歌单 ID 或完整歌单链接。');
  if (value.length > 200) throw new UserError('请输入 1-200 字的歌名或歌手。');
  return { source: selected, kind: 'search', query: value, input: value, isLink: false };
}
