import path from 'node:path';
import { readConfig } from './config.js';
import { Player } from './player.js';
import { WebConsole } from './web.js';
import { setPassword } from './web-auth.js';
import QRCode from 'qrcode';
import { UserError } from './util.js';
import { randomUUID } from 'node:crypto';
import { RoomFeatures } from './room-features.js';
import { Diagnostics } from './diagnostics.js';
import { parseMusicInput } from './music-input.js';
import { RoomAccess } from './room-access.js';
import { SocialRooms } from './social-rooms.js';
import { atomicJson } from './util.js';

const config = readConfig({ KOOK_TOKEN: 'preview', ALLOWED_GUILD_IDS: '10001', DATA_DIR: path.resolve('data/preview'), STAY_CONNECTED: 'true', MAX_QUEUE_SIZE: '500', WEB_PORT: process.env.PREVIEW_PORT || '8787', WEB_HOST: '127.0.0.1', WEB_REQUIRE_PASSWORD: process.env.PREVIEW_REQUIRE_PASSWORD || 'false' });
if (config.webRequirePassword) await setPassword(config.dataDir, 'Peach-Preview-2026');
const tracks = [
  { id: '66285', name: '葡萄成熟时', artists: '陈奕迅', durationMs: 279846, cover: 'https://p3.music.126.net/W9imJx0w_JeCGGs43dfjFg==/109951171529987110.jpg', album: 'U87' },
  { id: '65766', name: '富士山下', artists: '陈奕迅', durationMs: 258902, cover: 'https://p4.music.126.net/oSMs7RzJFx0TgWCqRC8XjA==/109951171844247587.jpg', album: "What's Going On...?" },
  { id: '65800', name: '最佳损友', artists: '陈奕迅', durationMs: 233560, cover: 'https://p3.music.126.net/3mi073axgjg-g-79ObwwEQ==/109951171836582062.jpg', album: 'Life Continues...' },
];
const playlists = ['今日热歌精选', '温柔粤语 · 细听岁月', '循环播放的心动旋律', '把故事唱给你听', '晚风里的音乐', '日落之前的温柔']
  .map((name, i) => ({ id: String(i + 1), name, cover: tracks[i % 3].cover, trackCount: 123,
    playCount: 368000 + i * 92600, description: '华语与粤语精选。', creator: '桃音音乐社区' }));
const qqTracks = [
  { id: '66285', name: '晴天', artists: '周杰伦', album: '叶惠美', durationMs: 269000, cover: tracks[0].cover },
  { id: '003qqPreview2', name: '稻香', artists: '周杰伦', album: '魔杰座', durationMs: 223000, cover: tracks[1].cover },
  { id: '004qqPreview3', name: '江南', artists: '林俊杰', album: '第二天堂', durationMs: 267000, cover: tracks[2].cover },
];
function previewProvider(source) {
  let loggedIn = source === 'netease', qr = null;
  const songs = (source === 'qq' ? qqTracks : tracks).map((track) => ({ ...track, source }));
  const entries = Array.from({ length: 123 }, (_, i) => ({ ...songs[i % songs.length], id: i < songs.length ? songs[i].id : source === 'qq' ? `qqPreview${i}` : String(1000000 + i) }));
  const lists = playlists.map((playlist, index) => ({ ...playlist, source, id: source === 'qq' && index === 0 ? 'top:26' : playlist.id, name: source === 'qq' ? `QQ · ${playlist.name}` : playlist.name, creator: source === 'qq' ? 'QQ音乐社区' : playlist.creator }));
  return {
    async search(query) { const matched = songs.filter((song) => `${song.name}${song.artists}`.includes(query)); return matched.length ? matched : songs; },
    async resolve(input) { return entries.find((track) => track.id === input) || songs[0]; },
    async stream() { return 'https://music.126.net/preview'; },
    async playlist(id, limit = entries.length) { return entries.slice(0, limit); },
    async playlistDetails(id, { offset = 0, limit = 50 } = {}) {
      return { playlist: lists.find((item) => item.id === id) || { ...lists[0], id }, tracks: entries.slice(offset, offset + limit), total: entries.length, offset, limit, hasMore: offset + limit < entries.length };
    },
    async account() { return { loggedIn, status: loggedIn ? 'logged_in' : 'logged_out', id: `preview-${source}`, name: source === 'qq' ? 'QQ音乐试听账号' : '桃音试听账号' }; },
    async discover() { return lists; },
    async hot(limit = 30) { return { mode: 'hot', name: source === 'qq' ? 'QQ热歌榜' : '热歌榜', tracks: entries.slice(0, limit) }; },
    async heart() { return { mode: 'heart', name: '心动模式', tracks: songs }; },
    async qrCreate(type) { qr = { polls: 0, type }; return { image: await QRCode.toDataURL(`https://example.invalid/preview-login/${source}/${type}`), expires: Date.now() + 180000 }; },
    async qrStatus() { if (!qr) return { status: 'expired' }; qr.polls++; if (qr.polls >= 2) { loggedIn = true; return { status: 'success' }; } return { status: 'scanned' }; },
    async logout() { loggedIn = false; qr = null; },
    async call(route) {
      if (route === 'login_qr_key') return { data: { unikey: 'preview-key' } };
      if (route === 'login_qr_create') return { data: { qrurl: 'https://example.invalid/preview-login/netease' } };
      return { code: 801 };
    },
  };
}
const providers = { netease: previewProvider('netease'), qq: previewProvider('qq') };
const music = {
  async parseInput(input, options) {
    if (input === 'https://163cn.tv/preview') return { ...parseMusicInput('https://music.163.com/playlist?id=1', options), resolvedShortLink: true };
    if (input === 'https://c6.y.qq.com/base/fcgi-bin/u?__=preview') return { ...parseMusicInput('https://y.qq.com/n/ryqq/toplist/26', options), resolvedShortLink: true };
    return parseMusicInput(input, options);
  },
  async searchAll(query, limit = 20) {
    const results = Object.fromEntries(await Promise.all(['netease', 'qq'].map(async (source) => [source, { tracks: await providers[source].search(query, limit) }])));
    return { results, tracks: [...results.netease.tracks, ...results.qq.tracks] };
  },
  async lyrics(id, source = 'netease') {
    return { id, source, available: true, plain: '', lines: [
      { time: 0, text: '音乐缓缓开始', translation: 'The music begins' },
      { time: 10, text: '把今天的故事唱给你听', translation: 'A song for today' },
      { time: 40, text: '晚风经过你的窗前', translation: 'The evening breeze passes by' },
      { time: 70, text: '下一段旋律还在继续', translation: 'The melody goes on' },
      { time: 100, text: '一起听到歌曲的结尾', translation: 'Stay until the song ends' },
    ] };
  },
  forSource(source = 'netease') { return providers[source]; },
  search(query, limit, source = 'netease') { return providers[source].search(query, limit); },
  resolve(input, source = 'netease') { return providers[source].resolve(input); },
  stream(track) { return providers[track.source || 'netease'].stream(track); },
  playlist(id, limit, source = 'netease') { return providers[source].playlist(id, limit); },
  playlistDetails(id, page, source = 'netease') { return providers[source].playlistDetails(id, page); },
  account(source = 'netease') { return providers[source].account(); },
  discover(category, source = 'netease') { return providers[source].discover(category); },
  hot(limit, source = 'netease') { return providers[source].hot(limit); },
  heart(options, source = 'netease') { return providers[source].heart(options); },
};
const api = {
  async request(route, params) {
    if (route === 'guild/view') return { id: '10001', name: '桃音音乐社区' };
    if (route === 'channel/list') return { items: params.type === 1 ? [{ id: '20002', name: '点歌台', type: 1 }] : [{ id: '20001', name: '一起听音乐', type: 2 }, { id: '20003', name: '深夜电台', type: 2 }], meta: { page_total: 1 } };
    if (route === 'channel/user-list') return [{ id: '91001', username: '晚风', bot: false }, { id: '91002', username: '小桃', bot: false }, { id: '91003', username: '音乐机器人', bot: true }];
    return {};
  }, async post() { return { ip: '127.0.0.1', port: 1, bitrate: 48000, audio_ssrc: 1111, audio_pt: 111, rtcp_mux: true }; },
};
const audio = { start(url, voice, volume, offset, onEnd) {
  const handle = { seconds: offset, paused: false, volume, async setVolume(value) { this.volume = value; }, async stop() { clearInterval(timer); }, pause() { this.paused = true; }, resume() { this.paused = false; } };
  const timer = setInterval(() => { if (!handle.paused) handle.seconds++; if (handle.seconds > 279) { clearInterval(timer); onEnd(null); } }, 1000);
  return handle;
} };
// Preview uses separate real Players with simulated transports, never KOOK tokens.
const runtimes = new Map();
function createRuntime(id, name, guildIds = ['10001']) {
  const botConfig = { ...config, guilds: new Set(guildIds), dataDir: path.join(config.dataDir, id) };
  const player = new Player(botConfig, api, music, audio, async () => {});
  const runtime = { id, name, config: botConfig, api, player, gateway: { ready: true }, self: { id, username: name }, status: 'ready', error: '', managed: id !== 'default' };
  runtimes.set(id, runtime); return runtime;
}
const manager = {
  get(id = 'default') { const bot = runtimes.get(id); if (!bot) throw new UserError('机器人不存在，请重新选择。'); return bot; },
  describe(bot) { return this.list().find((entry) => entry.id === bot.id); },
  list() { return [...runtimes.values()].map((bot) => ({ id: bot.id, name: bot.name, username: bot.self.username, online: bot.gateway.ready,
    status: bot.status, error: bot.error, managed: bot.managed, guildIds: [...bot.config.guilds], context: bot.player.context, playing: bot.player.snapshot().status === 'playing' })); },
  async withBot(id, fn) { return fn(this.get(id)); },
  async add({ name, token, guildIds }) {
    if (!String(token || '').trim()) throw new UserError('请输入机器人 Token。');
    const bot = createRuntime(`preview-${randomUUID()}`, name?.trim() || '新增预览机器人', guildIds?.length ? guildIds : ['10001']);
    await attachFeatures(bot);
    return this.list().find((item) => item.id === bot.id);
  },
  async remove(id) { if (id === 'default') throw new UserError('默认机器人不能移除。'); const bot = this.get(id); await bot.features?.close(); await bot.player.shutdown(); runtimes.delete(id); },
  async retry(id) { const bot = this.get(id); bot.status = 'ready'; bot.gateway.ready = true; return this.list().find((item) => item.id === id); },
  async shutdown() { await Promise.all([...runtimes.values()].map(async (bot) => { await bot.features?.close(); await bot.player.shutdown(); })); },
};
async function attachFeatures(bot) {
  // Per-run preview settings cannot turn themselves on from a previous test.
  bot.features = new RoomFeatures({ config: { ...bot.config, dataDir: path.join(config.dataDir, 'feature-runs', `${process.pid}-${bot.id}`) },
    player: bot.player, api: bot.api, music, selfId: bot.id });
  await bot.features.init();
}
const first = createRuntime('default', '桃音音乐机器人');
const second = createRuntime('preview-two', '深夜音乐机器人');
await first.player.add({ guildId: '10001', voiceChannelId: '20001', textChannelId: '20002' }, tracks);
first.player.stream.seconds = 42;
await second.player.add({ guildId: '10001', voiceChannelId: '20003', textChannelId: '20002' }, [tracks[1], tracks[2]]);
second.player.stream.seconds = 86;
await second.player.control('volume', 35);
await second.player.control('pause');
await attachFeatures(first); await attachFeatures(second);
const diagnostics = new Diagnostics({ ...config, dataDir: path.join(config.dataDir, 'feature-runs', String(process.pid)) }, manager, music);
await diagnostics.init(); diagnostics.start();
let access, rooms;
if (process.env.PREVIEW_SOCIAL === 'true') {
  const socialConfig = { ...config, dataDir: path.join(config.dataDir, 'social-runs', String(process.pid)) };
  access = new RoomAccess({ dataDir: socialConfig.dataDir }); await access.init();
  if (process.env.PREVIEW_ADMIN_PASSWORD) {
    await access.setAdminLogin(process.env.PREVIEW_ADMIN_USERNAME || 'preview-admin', process.env.PREVIEW_ADMIN_PASSWORD);
  } else {
    const token = await access.rotateAdminLink();
    await atomicJson(path.join(socialConfig.dataDir, 'preview-admin.json'), { token });
  }
  rooms = new SocialRooms({ config: socialConfig, manager, music, access }); await rooms.init(); rooms.start();
}
const web = new WebConsole({ config, music, manager, diagnostics, access, rooms, preview: true });
await web.start();
console.log(`Preview: http://127.0.0.1:${config.webPort} | ${config.webRequirePassword ? 'Password: Peach-Preview-2026' : 'Open access'}`);
async function stop() { await web.close(); await rooms?.close(); await diagnostics.close(); await manager.shutdown(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
