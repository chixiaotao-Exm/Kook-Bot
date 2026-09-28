import { createIcons, Headphones, LockKeyhole, Eye, EyeOff, ArrowLeft, ArrowRight, AudioLines, Disc3, SlidersHorizontal, Bot, LogOut, ChevronRight, ChevronDown, Sparkles, Expand, Minimize, Radio, Search, Heart, Flame, ListPlus, Shuffle, ListX, Music2, RefreshCw, UserRound, QrCode, RadioTower, Repeat2, Repeat1, Activity, ExternalLink, Play, Pause, SkipBack, SkipForward, Volume2, X, Plus, Trash2, ArrowUp, ListMusic, LoaderCircle, History, Clock3 } from 'lucide';
import { initBackground } from './background.js';
import { createBotStatus } from './bot-status.js';
import { createSmartLinks } from './smart-links.js';
import { createSessionApi } from './session.js';
import { createRoomSettings } from './room-settings.js';
import { createLyrics } from './lyrics.js';
import { createHealth } from './health.js';
import { takeAccessToken } from './access.js';
import { musicRoomLink } from './room-links.js';
import { sourceNames, sourceIds, normalizeSource, sourceName, defaultSources, sourceDescriptors, sourceSupports } from './music-sources.js';
const accessToken = takeAccessToken();
const initialLocation = new URLSearchParams(location.search);

const icons = { Headphones, LockKeyhole, Eye, EyeOff, ArrowLeft, ArrowRight, AudioLines, Disc3, SlidersHorizontal, Bot, LogOut, ChevronRight, ChevronDown, Sparkles, Expand, Minimize, Radio, Search, Heart, Flame, ListPlus, Shuffle, ListX, Music2, RefreshCw, UserRound, QrCode, RadioTower, Repeat2, Repeat1, Activity, ExternalLink, Play, Pause, SkipBack, SkipForward, Volume2, X, Plus, Trash2, ArrowUp, ListMusic, LoaderCircle, History, Clock3 };
const $ = (id) => document.getElementById(id);
const drawIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const icon = (name) => `<i data-lucide="${name}"></i>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = (seconds) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`;
const count = (value) => value >= 100000000 ? `${(value / 100000000).toFixed(1)}亿` : value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value);
const coverUrl = (value, size = 320) => { if (!value) return ''; const url = new URL(value, location.origin); if (url.hostname.endsWith('.music.126.net')) url.searchParams.set('param', `${size}y${size}`); return url.href; };
const empty = (message, action = '') => `<div class="empty-state">${icon('list-music')}<strong>${escape(message)}</strong>${action}</div>`;
const sourceId = (item) => normalizeSource(item?.source);
const sourceBadge = (source) => `<span class="source-badge ${normalizeSource(source)}">${normalizeSource(source) === 'netease' ? '网易云' : sourceName(source)}</span>`;
const sourceRoute = (route, source, params = {}) => `${route}?${new URLSearchParams({ ...params, source })}`;
let currentSource = normalizeSource(localStorage.getItem('music-source'));
let jointSearch = false;
let availableSources = defaultSources();
const sourceBrowsing = Object.fromEntries(sourceIds.map((id) => [id, { category: 'hot', scroll: 0 }]));
const accounts = {}, accountRequests = Object.fromEntries(sourceIds.map((id) => [id, 0]));
let searchRequest = 0, qrRequest = 0, qrSource = 'netease', qrType = 'qq', importSource = 'netease', pendingLoginAction = null;
let accountGate = false;
let selectedBotId = initialLocation.get('botId') || localStorage.getItem('selected-bot') || 'default', defaultBotId = 'default', bots = [], botsSignature = '';
let accessControlled = false, actor = null, roles = {};
let botGeneration = 0, stateRequest = 0, catalogRequest = 0, pollBot = '', channelDialogBot = '', importBot = '';
let csrf = '', currentView = 'player', state, guilds = [], searchTracks = [], playlists = [], queueSignature = '', activitySignature = '';
let busy = false, polling = false, pollTimer, toastTimer, qrTimer, currentCategory = 'hot', immersive = false, scene;
let activePlaylist = null, playlistTracks = [], playlistTotal = 0, playlistOffset = 0, playlistHasMore = false;
let playlistLoading = false, playlistError = '', playlistRequest = 0, discoverRequest = 0, discoverScroll = 0;
let selected = {};
let passwordRequired = true;
let smartLinks = null;
const sessionApi = createSessionApi({ getCsrf: () => csrf, setCsrf: (value) => { csrf = value; }, requiresPassword: () => passwordRequired, onUnauthorized: showLogin });
const roomSettings = createRoomSettings({ root: $('view-room'), api, drawIcons, onLockChange: syncBotLock,
  getSources: () => availableSources,
  getContext: () => ({ id: selectedBotId, name: state?.bot?.name || '当前机器人', available: botAvailable() && permission('manageRoom') }) });
const lyricsPage = createLyrics({ root: $('view-lyrics'), api, drawIcons });
const healthPage = createHealth({ root: $('view-health'), api, drawIcons, onAccount: () => view('account') });
const statusPage = createBotStatus({ api, drawIcons,
  getSources: () => availableSources,
  onManage: () => view('account'),
  onChanged: async (id) => {
    if (id !== selectedBotId) return;
    // Reject a dock poll that began before this card's playback change.
    stateRequest++; polling = false;
    await refresh();
  },
  onControl: async (id) => {
    if (botLocked()) return toast('请先完成当前操作，再切换机器人。');
    try {
      await loadBots();
      if (!bots.some((bot) => bot.id === id)) return toast('这个机器人已移除，请刷新状态页。', true);
      await switchBot(id);
      if (selectedBotId === id && currentView === 'status') view('player');
    } catch (error) { toast(error.message || '无法切换机器人，请稍后重试。', true); }
  },
});
function savedChannel(botId) { try { return JSON.parse(sessionStorage.getItem(`channel:${botId}`) || (botId === 'default' ? sessionStorage.getItem('channel') : '') || '{}'); } catch { return {}; } }
selected = savedChannel(selectedBotId);
let motion = localStorage.getItem('motion') !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
document.body.classList.toggle('motion-enabled', motion);
try {
  scene = initBackground($('scene'), (progress) => {
    $('scene-progress').querySelector('span').style.width = `${Math.max(0, progress) * 100}%`;
    if (progress >= 1 || progress < 0) $('scene-progress').classList.add('done');
    if (progress < 0) toast('背景图片加载失败，可刷新重试。', true);
  });
  scene.setEnabled(motion);
} catch { $('scene-progress').classList.add('done'); }

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').hidden = false; $('toast').classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
async function api(route, data, retry = true) {
  if (accessControlled && data !== undefined && !['/login','/logout','/access/redeem','/identity/profile'].includes(route)) {
    const id = data.botId || selectedBotId;
    const required = ['/play','/playlist','/heart','/hot'].includes(route) || route.startsWith('/bots/') || route.startsWith('/account/') ? 'manageSite'
      : route === '/features' || route === '/settings' || route === '/channel' || route === '/control' && data.action === 'stop' ? 'manageRoom' : route === '/control' ? 'control' : null;
    if (required && !permission(required,id)) { const error = new Error(required === 'manageSite' ? '请到专属房间点歌；账号与机器人由站长管理。' : '当前身份没有这个房间的操作权限。'); error.status = 403; throw error; }
  }
  return sessionApi(route, data, retry);
}
function permission(name, id = selectedBotId) {
  if (!accessControlled) return true;
  if (state?.botId === id && state.permissions) return state.permissions[name] === true;
  if (actor?.siteAdmin) return true;
  const role = roles[id] || 'guest';
  return name === 'control' ? ['dj','owner'].includes(role) : ['manageRoom','manageRoles'].includes(name) ? role === 'owner' : false;
}
function goRoom(input, source = currentSource, kind = 'song') {
  location.assign(musicRoomLink({ origin: location.origin, botId: selectedBotId, input, source, kind }));
}
function applyPermissions() {
  if (!accessControlled) return;
  const control = permission('control'), owner = permission('manageRoom'), admin = permission('manageSite');
  $('access-notice').hidden = admin;
  $('access-title').textContent = owner ? '当前房间管理权限' : control ? '当前房间 DJ 权限' : '公开浏览控制台';
  $('access-description').textContent = owner ? '你可管理当前房间的播放、频道、电台、定时与规则。点歌和成员授权在专属房间完成。' : control ? '你可控制当前房间的播放与队列。点歌和“我的点歌”在专属房间完成。' : '进入专属房间设置昵称，即可参与点歌。管理员可从侧栏登录，DJ 和房主通过房间邀请获取权限。';
  $('admin-account-link').querySelector('span').textContent = admin ? '管理员账号' : '管理员登录';
  $('admin-account-link').href = `/admin?${new URLSearchParams({returnTo:location.pathname+location.search})}`;
  if (accessControlled) $('logout').querySelector('span').textContent = admin ? '退出管理' : '退出此身份';
  $('open-room-link').href = `/room/${encodeURIComponent(selectedBotId)}`;
  $('site-account-controls').hidden = !admin; $('add-bot-button').hidden = !admin;
  document.querySelectorAll('[data-retry-bot],[data-remove-bot]').forEach((button)=>{button.hidden=!admin;});
  document.querySelector('[data-view="room"]').hidden = !owner;
  document.querySelectorAll('[data-category="mine"]').forEach((button)=>{button.hidden=!admin || !sourceSupports(availableSources, currentSource, 'mine');});
  for (const id of ['play-pause','skip-button','recover-button','volume','seek','loop-button','loop-select','shuffle-queue','clear-queue']) if (!control) $(id).disabled = true;
  for (const id of ['channel-button','stay-toggle','leave-button']) if (!owner) $(id).disabled = true;
  document.querySelectorAll('[data-remove],[data-move]').forEach((button)=>{if(!control)button.disabled=true;});
  for (const id of ['heart-button','hot-button','import-button']) $(id).hidden = !admin;
  syncSourceCapabilities();
  if (!admin) { $('playlist-add').textContent = '到房间点歌'; }
}
async function run(task, { rethrow = false } = {}) {
  if (busy) { if (rethrow) throw new Error('上一项操作仍在处理中。'); return toast('上一项操作仍在处理中。'); }
  busy = true; document.body.classList.add('working'); syncBotLock();
  try { const result = await task(); await refresh(); return result; }
  catch (error) { if (rethrow) throw error; toast(error.message || '网络连接失败，请稍后重试。', true); }
  finally { busy = false; document.body.classList.remove('working'); syncBotLock(); }
}
function botLocked() { return busy || roomSettings.isWorking() || accountGate || Boolean(smartLinks?.isWorking()) || Boolean(pendingLoginAction) || Boolean(document.querySelector('dialog[open]')); }
function syncBotLock() {
  $('bot-select').disabled = !bots.length || botLocked();
  $('channel-button').disabled = !botAvailable() || busy || Boolean(smartLinks?.isWorking());
  $('search-input').disabled = botLocked(); $('search-form').querySelector('button').disabled = botLocked();
  document.querySelectorAll('[data-music-source]').forEach((button) => { button.disabled = botLocked() || (button.dataset.musicSource !== 'all' && !availableSources.find((source) => source.id === button.dataset.musicSource)?.enabled); });
  smartLinks?.render();
  applyPermissions();
  syncSourceCapabilities();
}
function syncSourceCapabilities() {
  const admin = permission('manageSite');
  $('heart-button').hidden = !admin || !sourceSupports(availableSources, currentSource, currentSource === 'qq' ? 'mine' : 'heart');
  document.querySelectorAll('[data-category="mine"]').forEach((button) => { button.hidden = !admin || !sourceSupports(availableSources, currentSource, 'mine'); });
}
function botAvailable() { return state?.botId === selectedBotId && !state.loading && (!state.bot.status || state.bot.status === 'ready'); }
function checkBot(botId) {
  if (botId !== selectedBotId || !bots.some((bot) => bot.id === botId)) throw new Error('当前机器人已切换，请重新操作。');
  if (!botAvailable()) throw new Error('当前机器人暂不可用，请在机器人管理中查看或重试。');
}
function botApi(route, data, botId) { checkBot(botId); return api(route, { ...data, botId }); }
function botStatus(bot) { return ({ starting: '正在启动', error: '连接失败', stopping: '正在停止' })[bot.status] || (bot.online ? '在线' : '重连中'); }
function roomSummary(bot) {
  if (!bot.context) return '尚未选择频道';
  const channel = bot.id === selectedBotId ? guilds.find((g) => g.id === bot.context.guildId)?.channels.find((c) => c.id === bot.context.voiceChannelId) : null;
  return channel?.name || `频道 ${bot.context.voiceChannelId}`;
}
function renderBots() {
  const signature = JSON.stringify(bots);
  if (signature !== botsSignature) {
    botsSignature = signature;
    $('bot-select').innerHTML = bots.map((bot) => `<option value="${escape(bot.id)}">${escape(bot.name || bot.username || '音乐机器人')} · ${escape(botStatus(bot))}</option>`).join('');
    $('bot-list').innerHTML = bots.map((bot) => `<article class="bot-card${bot.id === selectedBotId ? ' selected' : ''}" data-bot-card="${escape(bot.id)}"><div class="bot-card-heading"><span class="bot-avatar">${icon('bot')}</span><div class="bot-card-info"><strong>${escape(bot.name || bot.username || '音乐机器人')}</strong><span>${escape(botStatus(bot))}${bot.managed === false || bot.id === defaultBotId ? ' · 默认机器人' : ''}</span></div>${bot.id === selectedBotId ? '<span class="tag mint">当前控制</span>' : `<button class="secondary" data-select-bot="${escape(bot.id)}">切换</button>`}</div><p class="bot-room">${escape(roomSummary(bot))}${bot.playing ? ' · 正在播放' : ''}</p>${bot.error ? `<p class="bot-card-error">${escape(bot.error)}</p>` : ''}<div class="bot-card-actions">${bot.status === 'error' ? `<button class="secondary" data-retry-bot="${escape(bot.id)}">${icon('refresh-cw')}重新连接</button>` : ''}${bot.managed !== false && bot.id !== defaultBotId ? `<button class="quiet-button danger" data-remove-bot="${escape(bot.id)}">${icon('trash-2')}移除</button>` : ''}</div></article>`).join('');
  }
  $('bot-select').value = selectedBotId;
  const active = bots.find((bot) => bot.id === selectedBotId);
  $('bot-channel-summary').textContent = active ? `${botStatus(active)} · ${roomSummary(active)}` : '正在读取机器人';
  $('settings-bot-name').textContent = active ? `当前控制：${active.name || active.username}` : '当前机器人';
  syncBotLock(); drawIcons();
}
function resetBotDisplay() {
  guilds = []; queueSignature = ''; activitySignature = ''; selected = savedChannel(selectedBotId);
  const bot = bots.find((item) => item.id === selectedBotId) || { name: '音乐机器人', online: false };
  state = { botId: selectedBotId, bot, loading: true, activity: [], uptime: 0, player: { current: null, queue: [], status: 'idle', context: null, seconds: 0, volume: 0, capacity: 0, maxQueue: 500, mode: 'off' } };
  $('guild-select').innerHTML = ''; $('voice-select').innerHTML = ''; $('text-select').innerHTML = '';
  renderState();
}
async function switchBot(id, force = false) {
  if (!bots.some((bot) => bot.id === id)) return;
  if (!force && botLocked()) { $('bot-select').value = selectedBotId; return; }
  selectedBotId = id; localStorage.setItem('selected-bot', id); botGeneration++; stateRequest++; catalogRequest++; polling = false;
  botsSignature = ''; resetBotDisplay(); renderBots();
  roomSettings.targetChanged();
  smartLinks?.targetChanged();
  await refresh();
  if (selectedBotId === id) void loadCatalog().catch((error) => { if (selectedBotId === id && botAvailable()) toast(error.message, true); });
}
async function loadBots({ reconcile = true } = {}) {
  const result = await api('/bots'); bots = result.bots; defaultBotId = result.defaultBotId || 'default';
  if (!bots.some((bot) => bot.id === selectedBotId)) {
    selectedBotId = bots.some((bot) => bot.id === defaultBotId) ? defaultBotId : bots[0]?.id;
    if (selectedBotId && reconcile) return switchBot(selectedBotId, true);
    localStorage.setItem('selected-bot', selectedBotId || 'default'); selected = savedChannel(selectedBotId);
  }
  renderBots();
}
function showLogin() { clearTimeout(pollTimer); statusPage.setActive(false); roomSettings.setActive(false); lyricsPage.setActive(false); healthPage.setActive(false); $('app').hidden = true; $('login').hidden = false; csrf = ''; }
async function enter() {
  $('login').hidden = true; $('app').hidden = false;
  $('logout').hidden = !passwordRequired && !accessControlled;
  if (accessControlled) $('logout').querySelector('span').textContent = '退出此身份';
  await loadBots({ reconcile: false });
  resetBotDisplay();
  await refresh();
  loadCatalog().catch((e) => toast(e.message, true));
  void loadSources(); if (permission('manageSite')) void loadAccounts();
  statusPage.setActive(currentView === 'status' && !document.hidden);
  if (initialLocation.get('view') === 'room' && permission('manageRoom')) view('room');
  schedulePoll(); drawIcons();
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(async () => { if (!$('app').hidden) { await refresh(); schedulePoll(); } }, document.hidden ? 7000 : 1500); }
async function refresh() {
  if ((polling && pollBot === selectedBotId) || !csrf) return;
  polling = true; const botId = selectedBotId, generation = botGeneration, request = ++stateRequest; pollBot = botId;
  try {
    const result = await api(`/state?${new URLSearchParams({ botId })}`);
    if (botId !== selectedBotId || generation !== botGeneration || request !== stateRequest) return;
    if (result.bots) bots = result.bots;
    state = { ...result, botId: result.botId || botId }; renderBots(); renderState();
  }
  catch {
    if (botId !== selectedBotId || generation !== botGeneration || request !== stateRequest) return;
    $('bot-state').textContent = '连接中断'; $('bot-dot').classList.add('offline');
    state.loading = true; renderState();
    try { await loadBots(); } catch { /* Retain the last list while offline. */ }
  }
  finally { if (request === stateRequest) { polling = false; pollBot = ''; } }
}
function setImage(id, src, size = id === 'current-cover' ? 320 : 100) {
  const img = $(id);
  if (!src) { img.hidden = true; img.removeAttribute('src'); delete img.dataset.url; return; }
  if (img.dataset.url !== src) {
    img.dataset.url = src; img.referrerPolicy = 'no-referrer'; img.hidden = true;
    img.onload = () => { img.hidden = false; if (id === 'current-cover') $('album-art').classList.add('has-cover'); };
    img.src = coverUrl(src, size);
  } else if (img.complete && img.naturalWidth) img.hidden = false;
}
function renderState() {
  const p = state.player, song = p.current, available = botAvailable();
  lyricsPage.update(state);
  $('status-dock-bot').textContent = `当前控制：${state.bot.name || '音乐机器人'}`;
  $('bot-name').textContent = state.bot.name; $('bot-state').textContent = state.loading ? '正在读取' : botStatus(state.bot);
  $('bot-error').hidden = available; $('bot-error').textContent = state.loading ? '正在读取当前机器人的播放状态…' : state.bot.error || `当前机器人${botStatus(state.bot)}，请在“管理机器人”中查看。`;
  $('bot-dot').classList.toggle('offline', !state.bot.online); $('preview-tag').hidden = !state.preview;
  $('play-status').textContent = !available ? (state.loading ? '正在读取' : '机器人未就绪') : ({ playing: '正在播放', paused: '已暂停', idle: '准备播放', recovering: '正在恢复播放', ready: '进度已保留' })[p.status] || '准备播放';
  $('recover-button').hidden = !p.canResume || p.status === 'playing' || p.status === 'recovering';
  $('recover-position').textContent = duration(p.seconds);
  $('recovery-note').hidden = !p.recoveryError;
  $('recovery-note').textContent = p.recoveryError ? `${p.recoveryError} 进度保留在 ${duration(p.seconds)}。` : '';
  document.body.classList.toggle('playing', available && p.status === 'playing');
  $('current-title').textContent = song?.name || '今天，想听什么？'; $('current-artist').textContent = song?.artists || '桃音电台';
  $('current-album').textContent = song?.album || ''; $('dock-title').textContent = song?.name || '桃音电台';
  $('current-source').innerHTML = song ? sourceBadge(sourceId(song)) : '';
  $('dock-source').innerHTML = song ? sourceBadge(sourceId(song)) : '';
  $('dock-artist').textContent = song?.artists || (p.connected ? '频道已连接' : '等待点歌');
  setImage('current-cover', song?.cover); setImage('dock-cover', song?.cover); $('album-art').classList.toggle('has-cover', Boolean(song?.cover && $('current-cover').complete && $('current-cover').naturalWidth));
  $('residency-tag').textContent = p.stayConnected ? '常驻频道' : '空闲自动离开';
  $('residency-tag').classList.toggle('mint', p.stayConnected);
  $('loop-tag').textContent = ({ off: '顺序播放', one: '单曲循环', all: '队列循环' })[p.mode];
  $('stay-toggle').checked = p.stayConnected; $('loop-select').value = p.mode;
  const playing = p.status === 'playing';
  const symbol = playing ? 'pause' : 'play';
  if ($('play-pause').dataset.symbol !== symbol) { $('play-pause').innerHTML = icon(symbol); $('play-pause').dataset.symbol = symbol; }
  $('play-pause').setAttribute('aria-label', playing ? '暂停' : '播放'); $('play-pause').title = playing ? '暂停' : '播放';
  $('play-pause').disabled = !available || (!song && !p.queue.length);
  $('skip-button').disabled = !available || (!song && !p.queue.length);
  $('loop-button').classList.toggle('active', p.mode !== 'off');
  if ($('loop-button').dataset.mode !== p.mode) { $('loop-button').innerHTML = icon(p.mode === 'one' ? 'repeat-1' : 'repeat-2'); $('loop-button').dataset.mode = p.mode; }
  $('loop-button').title = ({ off: '顺序播放', one: '单曲循环', all: '队列循环' })[p.mode];
  const total = (song?.durationMs || 0) / 1000;
  if (document.activeElement !== $('seek')) { $('seek').max = Math.max(1, Math.floor(total - 1)); $('seek').value = p.seconds; }
  $('seek').disabled = !available || !song || p.status === 'idle'; $('elapsed').textContent = duration(p.seconds); $('duration').textContent = duration(total);
  if (document.activeElement !== $('volume')) { $('volume').value = p.volume; $('volume-number').textContent = p.volume; }
  $('volume').disabled = !available || !p.context; $('loop-button').disabled = !available || !p.context; $('loop-select').disabled = !available || !p.context;
  $('leave-button').disabled = !available || !p.context; $('queue-count').textContent = `${p.queue.length} 首待播`; $('queue-badge').textContent = p.queue.length;
  $('shuffle-queue').disabled = !available || p.queue.length < 2; $('clear-queue').disabled = !available || !p.queue.length;
  $('playlist-add').disabled = !available || !activePlaylist || p.capacity < 1;
  for (const id of ['channel-button', 'heart-button', 'hot-button', 'import-button', 'recover-button', 'stay-toggle']) $(id).disabled = !available;
  $('channel-button').disabled = !available || busy || Boolean(smartLinks?.isWorking());
  $('playlist-add').title = p.capacity < 1 ? `队列已满（${p.maxQueue} 首）` : '加入播放队列';
  $('uptime').textContent = state.uptime >= 3600 ? `${Math.floor(state.uptime / 3600)} 小时 ${Math.floor(state.uptime % 3600 / 60)} 分钟` : `${Math.floor(state.uptime / 60)} 分钟`;
  const nextSignature = JSON.stringify(p.queue);
  if (nextSignature !== queueSignature) { queueSignature = nextSignature; renderQueue(); }
  const a = JSON.stringify(state.activity);
  if (a !== activitySignature) {
    activitySignature = a;
    $('activity-list').innerHTML = state.activity.length ? state.activity.map((x) => `<div class="activity-entry"><time>${new Date(x.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span>${escape(x.message)}</span></div>`).join('') : '<p class="muted">暂无操作记录</p>';
  }
  document.querySelectorAll('[data-add], [data-playlist], [data-remove], [data-move]').forEach((button) => { button.disabled = !available || (button.hasAttribute('data-move') && button.dataset.move === '1'); });
  updateChannelLabel(); smartLinks?.render(); applyPermissions(); drawIcons();
}
function thumb(track) { return `<span class="track-thumb fallback">${icon('music-2')}${track.cover ? `<img src="${escape(coverUrl(track.cover, 80))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`; }
function trackRow(track, index, queue = false) {
  const source = sourceId(track), unavailable = !botAvailable() ? 'disabled' : '';
  return `<div class="track-row" data-track-source="${source}"><span class="track-index">${String(index + 1).padStart(2, '0')}</span>${thumb(track)}<div style="min-width:0"><div class="track-title" title="${escape(track.name)}">${escape(track.name)}</div><div class="track-artist">${escape(track.artists)}</div></div><span class="track-source">${sourceBadge(source)}</span><span class="track-duration">${duration(track.durationMs / 1000)}</span><div class="track-actions">${queue ? `<button class="icon-button move-up" data-move="${index + 1}" title="上移" aria-label="上移 ${escape(track.name)}" ${index === 0 ? 'disabled' : unavailable}>${icon('arrow-up')}</button><button class="icon-button remove" data-remove="${index + 1}" title="移除" aria-label="移除 ${escape(track.name)}" ${unavailable}>${icon('x')}</button>` : `<button class="icon-button" data-add="${escape(track.id)}" data-item-source="${source}" title="加入队列" aria-label="加入队列 ${escape(track.name)}" ${unavailable}>${icon('plus')}</button>`}</div></div>`;
}
function renderQueue() {
  const queue = state.player.queue;
  $('queue-list').innerHTML = queue.length ? queue.map((t, i) => trackRow(t, i, true)).join('') : empty('还没有待播歌曲', `<button class="secondary" data-discover>发现歌单 ${icon('arrow-right')}</button>`);
}
function view(name, { restoreDiscover = false, skipScrollCapture = false } = {}) {
  if (roomSettings.isWorking() && name !== currentView) return toast('正在保存房间设置，请稍候。');
  if (name === 'room' && !permission('manageRoom')) return toast('房间设置需要房主权限。');
  if (currentView === 'discover' && !skipScrollCapture) sourceBrowsing[currentSource].scroll = window.scrollY;
  currentView = name;
  if (name !== 'playlist') { playlistRequest++; playlistLoading = false; }
  if (name !== 'search') searchRequest++;
  if (name !== 'discover') discoverRequest++;
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view-${name}`; });
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === name || (name === 'search' && el.dataset.view === 'player') || (name === 'playlist' && el.dataset.view === 'discover')));
  $('page-title').textContent = ({ player: '正在播放', discover: '发现歌单', playlist: '歌单详情', search: '搜索结果', account: '账号与设置', status: '机器人状态', room: '房间设置', lyrics: '歌词', health: '故障中心' })[name];
  $('view-heading').textContent = ({ player: '音乐控制台', discover: '发现歌单', playlist: '歌单详情', search: '搜索音乐', account: '账号与设置', status: '机器人状态', room: '房间设置', lyrics: '此刻的歌词', health: '故障中心' })[name];
  $('search-form').hidden = ['playlist','account','status','room','lyrics','health'].includes(name);
  $('source-picker').hidden = ['account','status','room','lyrics','health'].includes(name);
  smartLinks?.setActive(name === 'player' || name === 'search');
  $('bot-picker-bar').hidden = name === 'status' || name === 'health';
  $('channel-button').hidden = name === 'status' || name === 'health';
  document.body.classList.toggle('status-overview', name === 'status');
  statusPage.setActive(name === 'status' && !document.hidden && Boolean(csrf));
  roomSettings.setActive(name === 'room');
  lyricsPage.setActive(name === 'lyrics' && !document.hidden);
  healthPage.setActive(name === 'health' && !document.hidden);
  if (name === 'discover') {
    if (jointSearch) { jointSearch = false; renderSources(); }
    if (restoreDiscover && playlists.length) renderDiscover();
    else loadDiscover(currentCategory, restoreDiscover ? discoverScroll : null);
  }
  if (name === 'account' && permission('manageSite')) void loadAccounts();
  window.scrollTo({ top: restoreDiscover ? discoverScroll : 0, behavior: 'instant' });
}
function renderDiscover() {
  $('playlist-grid').innerHTML = playlists.length ? playlists.map((p) => `<article class="playlist-item"><div class="playlist-cover"><button class="playlist-open" data-open-playlist="${escape(p.id)}" data-item-source="${sourceId(p)}" title="查看歌单" aria-label="查看歌单 ${escape(p.name)}">${p.cover ? `<img src="${escape(coverUrl(p.cover, 480))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</button><small>${count(p.playCount)} 次播放</small><button class="playlist-play" data-playlist="${escape(p.id)}" data-item-source="${sourceId(p)}" title="播放歌单" aria-label="播放歌单 ${escape(p.name)}">${icon('play')}</button></div><h3><button class="playlist-name" data-open-playlist="${escape(p.id)}" data-item-source="${sourceId(p)}" title="查看歌单">${escape(p.name)}</button></h3><span>${p.trackCount} 首歌曲</span> ${sourceBadge(sourceId(p))}</article>`).join('') : empty('暂时没有歌单');
  drawIcons();
}
async function loadDiscover(category, restoreScroll = null) {
  if (category === 'mine' && (!permission('manageSite') || !sourceSupports(availableSources, currentSource, 'mine'))) { category = 'hot'; }
  const request = ++discoverRequest, source = currentSource;
  currentCategory = category;
  sourceBrowsing[source].category = category;
  document.querySelectorAll('[data-category]').forEach((b) => { b.classList.toggle('active', b.dataset.category === category); b.setAttribute('aria-selected', String(b.dataset.category === category)); });
  $('playlist-grid').innerHTML = '<div class="skeleton-row"></div>'.repeat(6);
  try {
    const data = await api(sourceRoute('/discover', source, { category }));
    if (request !== discoverRequest || currentCategory !== category || currentSource !== source || currentView !== 'discover') return;
    playlists = data.playlists.map((p) => ({ ...p, source: p.source || source })); renderDiscover();
    if (restoreScroll !== null) window.scrollTo({ top: restoreScroll, behavior: 'instant' });
  } catch (error) { if (request === discoverRequest && currentSource === source && currentView === 'discover') { $('playlist-grid').innerHTML = empty(error.message); drawIcons(); } }
}
function renderPlaylistHeader() {
  const p = activePlaylist;
  $('playlist-detail-name').textContent = p?.name || '歌单';
  $('playlist-detail-source').innerHTML = p ? sourceBadge(sourceId(p)) : '';
  setImage('playlist-detail-cover', p?.cover, 320);
  $('playlist-detail-meta').textContent = [p?.creator, `${playlistTotal} 首歌曲`, p?.playCount ? `${count(p.playCount)} 次播放` : ''].filter(Boolean).join(' · ');
  $('playlist-description').textContent = p?.description || '';
  $('playlist-description-wrap').hidden = !p?.description;
  $('playlist-add').disabled = !botAvailable() || !p || (state?.player.capacity ?? 0) < 1;
}
function renderPlaylistStatus() {
  $('playlist-track-count').textContent = `${playlistTracks.length} / ${playlistTotal} 首`;
  $('playlist-tracks').setAttribute('aria-busy', String(playlistLoading));
  $('playlist-detail-error').hidden = !playlistError;
  $('playlist-detail-error').textContent = playlistError;
  $('playlist-availability-note').hidden = playlistLoading || Boolean(playlistError) || playlistHasMore || playlistTracks.length >= playlistTotal;
  $('playlist-more').hidden = !playlistLoading && !playlistHasMore && !playlistError;
  $('playlist-more').disabled = playlistLoading;
  $('playlist-more').innerHTML = `${icon(playlistLoading ? 'loader-circle' : playlistError ? 'refresh-cw' : 'chevron-down')}<span>${playlistLoading ? '正在加载' : playlistError ? '重新加载' : '加载更多'}</span>`;
  drawIcons();
}
function openPlaylist(id, source = currentSource) {
  discoverScroll = window.scrollY;
  activePlaylist = { ...playlists.find((p) => p.id === id && sourceId(p) === source), id, source };
  playlistTracks = []; playlistOffset = 0; playlistTotal = activePlaylist.trackCount || 0;
  playlistHasMore = false; playlistError = ''; playlistLoading = false; playlistRequest++;
  $('playlist-description-wrap').open = false;
  view('playlist'); renderPlaylistHeader();
  $('playlist-tracks').innerHTML = '<div class="skeleton-row"></div>'.repeat(5);
  void loadPlaylistPage();
}
async function loadPlaylistPage() {
  if (playlistLoading || !activePlaylist || currentView !== 'playlist') return;
  const id = activePlaylist.id, source = sourceId(activePlaylist), request = ++playlistRequest;
  playlistLoading = true; playlistError = ''; renderPlaylistStatus();
  try {
    const data = await api(sourceRoute('/playlist', source, { id, offset: playlistOffset, limit: 50 }));
    if (request !== playlistRequest || currentView !== 'playlist' || currentSource !== source) return;
    activePlaylist = { ...data.playlist, source: data.playlist.source || source }; playlistTotal = data.total;
    playlistTracks.push(...data.tracks.map((t) => ({ ...t, source: t.source || source }))); playlistOffset = data.offset + data.limit; playlistHasMore = data.hasMore;
    renderPlaylistHeader();
    $('playlist-tracks').innerHTML = playlistTracks.length ? playlistTracks.map((t, i) => trackRow(t, i)).join('') : empty(playlistTotal ? '暂无可查看的歌曲信息' : '这张歌单还没有歌曲');
  } catch (error) {
    if (request !== playlistRequest || currentView !== 'playlist') return;
    playlistError = error.message;
    if (!playlistTracks.length) $('playlist-tracks').innerHTML = empty('暂时无法读取歌单');
  } finally {
    if (request === playlistRequest && currentView === 'playlist') { playlistLoading = false; renderPlaylistStatus(); }
  }
}
function importPlaylist(id, showPlayer = true, source = currentSource, botId = selectedBotId) {
  if (!permission('manageSite')) return goRoom(id,source,'playlist');
  requireAccount(source, () => withContext((ctx) => run(async () => {
    const result = await botApi('/playlist', { ...ctx, id, source }, botId);
    toast(Number.isInteger(result.added) ? `已加入 ${result.added} 首歌曲` : '歌单已加入队列');
    if (showPlayer) view('player');
  }), botId));
}
async function loadCatalog() {
  const botId = selectedBotId, request = ++catalogRequest, generation = botGeneration;
  const result = await api(`/catalog?${new URLSearchParams({ botId })}`);
  if (botId !== selectedBotId || request !== catalogRequest || generation !== botGeneration) return;
  guilds = result.guilds;
  $('guild-select').innerHTML = guilds.map((g) => `<option value="${escape(g.id)}">${escape(g.name)}</option>`).join('');
  const active = state?.player.context || selected;
  if (guilds.some((g) => g.id === active.guildId)) $('guild-select').value = active.guildId;
  updateChannelSelects(); updateChannelLabel(); botsSignature = ''; renderBots(); smartLinks?.render();
}
function updateChannelSelects() {
  const guild = guilds.find((g) => g.id === $('guild-select').value); const channels = guild?.channels || [];
  const active = state?.player.context || selected;
  $('voice-select').innerHTML = channels.filter((c) => c.type === 2).map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
  $('text-select').innerHTML = channels.map((c) => `<option value="${escape(c.id)}">${escape(c.name)}${c.type === 2 ? ' · 频道聊天' : ''}</option>`).join('');
  if (channels.some((c) => c.id === active.voiceChannelId)) $('voice-select').value = active.voiceChannelId;
  $('text-select').value = active.textChannelId || $('voice-select').value;
}
function updateChannelLabel() {
  const ctx = state?.player.context;
  const guild = guilds.find((g) => g.id === ctx?.guildId);
  const channel = guild?.channels.find((c) => c.id === ctx?.voiceChannelId);
  $('channel-name').textContent = ctx ? channel?.name || '频道已选择' : '选择语音频道';
}
function withContext(task, botId = selectedBotId) {
  try { checkBot(botId); } catch (error) { toast(error.message, true); return; }
  if (state?.player.context) return task({ botId });
  openChannel(); toast('请先连接一个语音频道。');
}
function control(action, value, botId = selectedBotId) { return run(async () => { await botApi('/control', { action, value }, botId); }); }
function renderSources() {
  $('source-picker').innerHTML = availableSources.map((source) => `<button type="button" data-music-source="${source.id}" aria-pressed="${!jointSearch && source.id === currentSource}" ${source.enabled ? '' : 'disabled'}><span class="source-dot ${source.id}"></span>${escape(source.name)}</button>`).join('') + `<button type="button" data-music-source="all" aria-pressed="${jointSearch}">${icon('search')}联合搜索</button>`;
  $('search-input').placeholder = '搜索歌名，或粘贴歌曲 / 歌单链接';
  $('heart-button').innerHTML = `${icon('heart')}${currentSource === 'qq' ? '我的收藏' : '心动模式'}`;
  syncBotLock(); drawIcons();
}
async function loadSources() {
  try {
    const result = await api('/sources');
    availableSources = sourceDescriptors(result.sources);
    if (!availableSources.some((source) => source.id === currentSource && source.enabled)) {
      const fallback = availableSources.find((source) => source.enabled)?.id;
      if (fallback) switchSource(fallback);
    }
  } catch { /* Existing NetEase access remains usable while source discovery retries. */ }
  renderSources();
}
function switchSource(source) {
  if (botLocked()) return;
  if (source === 'all') {
    if (jointSearch) return;
    jointSearch = true; searchRequest++; renderSources(); smartLinks?.sourceChanged();
    if (['discover','playlist'].includes(currentView)) view('player');
    if (currentView === 'search' && $('smart-link-preview').hidden) void searchSongs($('search-input').value.trim());
    return;
  }
  const wasJoint = jointSearch; jointSearch = false;
  if (source === currentSource && wasJoint) { renderSources(); smartLinks?.sourceChanged(); if (currentView === 'search' && $('smart-link-preview').hidden) void searchSongs($('search-input').value.trim()); return; }
  if (source === currentSource || !availableSources.some((item) => item.id === source && item.enabled)) return;
  sourceBrowsing[currentSource].scroll = currentView === 'discover' ? window.scrollY : discoverScroll;
  currentSource = source; localStorage.setItem('music-source', source);
  currentCategory = sourceBrowsing[source].category; discoverScroll = sourceBrowsing[source].scroll;
  searchRequest++; discoverRequest++; playlistRequest++; playlistLoading = false;
  playlists = []; activePlaylist = null; playlistTracks = [];
  renderSources();
  smartLinks?.sourceChanged();
  if (currentView === 'search' && !$('smart-link-preview').hidden) return;
  if (currentView === 'search') void searchSongs($('search-input').value.trim());
  else if (currentView === 'discover' || currentView === 'playlist') view('discover', { restoreDiscover: true, skipScrollCapture: true });
}
function accountIds(source) {
  if (source === 'qishui') return { name: 'qishui-account-name', status: 'qishui-account-status', avatar: 'qishui-account-avatar', error: 'qishui-account-error' };
  return source === 'qq' ? { name: 'qq-account-name', status: 'qq-account-status', avatar: 'qq-account-avatar', login: 'qq-qr-button', logout: 'qq-logout', error: 'qq-account-error' }
    : { name: 'account-name', status: 'account-status', avatar: 'account-avatar', login: 'qr-button', logout: 'netease-logout', error: 'netease-account-error' };
}
async function loadAccount(source = 'netease') {
  const ids = accountIds(source), request = ++accountRequests[source];
  try {
    const account = await api(sourceRoute('/account', source));
    if (request !== accountRequests[source]) return accounts[source];
    accounts[source] = account;
    const expired = account.status === 'expired';
    $(ids.name).textContent = account.loggedIn ? account.name || sourceNames[source] : sourceNames[source];
    $(ids.status).textContent = account.loggedIn ? '已登录' : expired ? '登录失效' : account.status === 'unconfigured' || account.enabled === false ? '未配置' : '未登录';
    $(ids.status).classList.toggle('account-expired', expired);
    if (ids.logout) $(ids.logout).hidden = !account.loggedIn;
    if (ids.login) $(ids.login).querySelector('span').textContent = account.loggedIn ? '更换账号' : expired ? '重新登录' : '扫码登录';
    $(ids.error).hidden = true;
    setImage(ids.avatar, account.avatar);
    return account;
  } catch (error) {
    if (request === accountRequests[source]) {
      $(ids.name).textContent = sourceNames[source];
      $(ids.status).textContent = source === 'qishui' && !sourceSupports(availableSources, source, 'play') ? '未配置' : '状态读取失败';
      $(ids.error).textContent = error.message || '登录状态读取失败，请刷新重试。'; $(ids.error).hidden = false;
    }
    throw error;
  }
}
async function loadAccounts() { await Promise.allSettled(sourceIds.map((source) => loadAccount(source))); }
async function requireAccount(source, task) {
  if (source !== 'qq') return task();
  if (accountGate || pendingLoginAction) return toast('请先完成当前QQ音乐登录操作。');
  accountGate = true;
  syncBotLock();
  try {
    const account = await loadAccount(source);
    if (account?.loggedIn) return task();
    pendingLoginAction = { source, task }; syncBotLock();
    await showQR(source);
  } catch (error) { toast(error.message || 'QQ音乐账号暂不可用。', true); }
  finally { accountGate = false; syncBotLock(); }
}
function addTrack(id, source) {
  if (!permission('manageSite')) return goRoom(id,source);
  const botId = selectedBotId;
  return requireAccount(source, () => withContext((ctx) => run(async () => {
    await botApi('/play', { ...ctx, input: id, source }, botId); toast('已加入播放队列');
  }), botId));
}
async function searchSongs(query) {
  const source = currentSource, joined = jointSearch;
  if (joined && /^\d+$/.test(query)) return toast('纯数字 ID 请先选择 QQ 音乐或网易云音乐。');
  view('search'); const request = ++searchRequest;
  $('search-results').innerHTML = '<div class="skeleton-row"></div>'.repeat(6); $('search-count').textContent = '搜索中';
  try {
    const result = await api(joined ? `/search-all?${new URLSearchParams({ q: query })}` : sourceRoute('/search', source, { q: query }));
    if (request !== searchRequest || source !== currentSource || joined !== jointSearch || currentView !== 'search') return;
    searchTracks = result.tracks.map((track) => ({ ...track, source: track.source || source }));
    $('search-count').textContent = `${searchTracks.length} 首歌曲`;
    $('search-results').innerHTML = joined ? (result.groups || []).map((group) => `<section class="search-group"><h3>${sourceBadge(group.source)}<span>${group.tracks.length} 首</span></h3>${group.error ? `<p class="feature-error" role="status">${escape(group.error)}</p>` : ''}${group.tracks.length ? group.tracks.map((track,index) => trackRow({ ...track, source: group.source }, index)).join('') : group.error ? '' : empty('没有找到匹配的歌曲')}</section>`).join('') : searchTracks.length ? searchTracks.map((track, index) => trackRow(track, index)).join('') : empty('没有找到匹配的歌曲'); drawIcons();
  } catch (error) {
    if (request !== searchRequest || source !== currentSource || joined !== jointSearch || currentView !== 'search') return;
    $('search-count').textContent = ''; $('search-results').innerHTML = empty(error.message); drawIcons();
  }
}
function confirmAction(title, message, task) {
  $('confirm-title').textContent = title; $('confirm-message').textContent = message;
  $('confirm-yes').onclick = () => { $('confirm-dialog').close(); task(); };
  $('confirm-dialog').showModal();
  syncBotLock();
}
async function showQR(source = qrSource, type = qrType) {
  if (!['netease', 'qq'].includes(source)) return toast('这个音乐来源不支持在控制台扫码登录。', true);
  qrSource = source; qrType = type;
  const request = ++qrRequest;
  clearTimeout(qrTimer); if (!$('qr-dialog').open) $('qr-dialog').showModal();
  syncBotLock();
  $('qr-title').textContent = `登录${sourceNames[source]}`;
  $('qr-type-tabs').hidden = source !== 'qq';
  document.querySelectorAll('[data-qr-type]').forEach((button) => { button.classList.toggle('active', button.dataset.qrType === type); button.setAttribute('aria-selected', String(button.dataset.qrType === type)); });
  $('qr-content').innerHTML = icon('loader-circle'); $('qr-status').textContent = '正在生成二维码';
  try {
    const data = await api('/account/qr', { source, ...(source === 'qq' ? { type } : {}) });
    if (request !== qrRequest || !$('qr-dialog').open) return;
    $('qr-content').innerHTML = `<img src="${escape(data.image)}" alt="${sourceNames[source]}登录二维码">`;
    $('qr-status').textContent = qrInstruction(source, type); pollQR(request, source, type, Number(data.expires) || Date.now() + 180000);
  } catch (error) { if (request === qrRequest && $('qr-dialog').open) { $('qr-status').textContent = error.message; $('qr-content').innerHTML = icon('qr-code'); } }
  drawIcons();
}
function qrInstruction(source, type) { return source === 'netease' ? '使用网易云音乐 App 扫码' : type === 'wx' ? '使用微信扫码确认' : '使用手机QQ扫码确认'; }
function pollQR(request, source, type, expires, failures = 0) {
  qrTimer = setTimeout(async () => {
    if (!$('qr-dialog').open || request !== qrRequest) return;
    if (Date.now() > expires) { $('qr-status').textContent = '二维码已过期，请刷新'; return; }
    try {
      const result = await api(sourceRoute('/account/qr', source));
      if (!$('qr-dialog').open || request !== qrRequest) return;
      $('qr-status').textContent = ({ waiting: qrInstruction(source, type), scanned: '已扫码，请在手机上确认', success: '登录成功', expired: '二维码已过期，请刷新', rejected: '已取消授权，请重新扫码' })[result.status] || '等待扫码';
      if (result.status === 'success') {
        const account = await loadAccount(source);
        if (!account?.loggedIn) throw new Error('正在确认账号登录状态，请稍后。');
        if (request !== qrRequest || !$('qr-dialog').open) return;
        const pending = pendingLoginAction?.source === source ? pendingLoginAction : null;
        pendingLoginAction = null; toast(`${sourceNames[source]}登录成功`); $('qr-dialog').close();
        if (pending) await pending.task();
      } else if (!['expired', 'rejected', 'none'].includes(result.status)) pollQR(request, source, type, expires);
    } catch (error) {
      if (request === qrRequest && $('qr-dialog').open) {
        const transient = !error.status || error.status >= 500 || error.status === 429;
        const retry = transient && Date.now() < expires;
        $('qr-status').textContent = retry ? `连接暂时失败，稍后自动重试：${error.message}` : error.message;
        if (retry) pollQR(request, source, type, expires, failures + 1);
      }
    }
  }, Math.min(12000, 2800 * (1 + failures)));
}
function setMotion(value) {
  motion = value; localStorage.setItem('motion', value ? 'on' : 'off'); scene?.setEnabled(value);
  $('settings-motion').checked = value; $('motion-toggle').setAttribute('aria-pressed', String(value)); $('motion-toggle').classList.toggle('active', value); document.body.classList.toggle('motion-enabled', value);
}
function openChannel() {
  if (busy || smartLinks?.isWorking()) return toast('请先完成当前加入操作，再切换频道。');
  if (!botAvailable()) return toast('当前机器人暂不可用，请先查看机器人管理。', true);
  channelDialogBot = selectedBotId; $('channel-dialog').showModal(); syncBotLock();
  if (!guilds.length) loadCatalog().catch((error) => toast(error.message, true));
}
function removeBot(botId) {
  const bot = bots.find((item) => item.id === botId);
  if (!bot || botId === defaultBotId || bot.managed === false) return;
  confirmAction(`移除 ${bot.name || bot.username}`, '该机器人将停止播放并离开频道，其队列和进度将被删除。其他机器人的播放不受影响。', () => run(async () => {
    await api('/bots/remove', { botId }); await loadBots(); toast('机器人已移除');
  }));
}
smartLinks = createSmartLinks({
  input: $('search-input'), container: $('smart-link-preview'), api, drawIcons,
  getContext: () => {
    const context = state?.player.context;
    const channel = guilds.find((guild) => guild.id === context?.guildId)?.channels.find((room) => room.id === context?.voiceChannelId);
    return { source: currentSource, jointSearch, botId: selectedBotId, botName: state?.bot.name || bots.find((bot) => bot.id === selectedBotId)?.name || '音乐机器人',
      available: botAvailable() && permission('manageSite'), restrictedReason: !permission('manageSite') ? '请点击上方“进入点歌房”，使用你的网页身份点歌。' : '', hasChannel: Boolean(context), voiceChannelId: context?.voiceChannelId, channelName: channel?.name || (context ? `频道 ${context.voiceChannelId}` : ''),
      capacity: state?.player.capacity || 0, maxQueue: state?.player.maxQueue || 500 };
  },
  isLocked: () => busy || accountGate || Boolean(pendingLoginAction) || Boolean(document.querySelector('dialog[open]')),
  onLockChange: syncBotLock,
  onSearch: (query) => { void searchSongs(query); },
  onShow: () => { if (currentView !== 'player') view('player'); },
  onChannel: openChannel,
  onAccountCheck: loadAccount,
  onLogin: async (resumePreview) => {
    if (accountGate || pendingLoginAction || busy) throw new Error('请先完成当前操作。');
    pendingLoginAction = { source: 'qq', task: resumePreview }; syncBotLock();
    try { await showQR('qq', 'qq'); }
    catch (error) { pendingLoginAction = null; syncBotLock(); throw error; }
  },
  onAdd: (record, maxItems) => run(async () => {
    checkBot(record.botId);
    if (!state.player.context) throw new Error('请先选择一个语音频道。');
    return record.kind === 'playlist'
      ? botApi('/playlist', { id: record.input, source: record.source, maxItems, expectedVoiceChannelId: record.expectedVoiceChannelId }, record.botId)
      : botApi('/play', { input: record.input, source: record.source, expectedVoiceChannelId: record.expectedVoiceChannelId }, record.botId);
  }, { rethrow: true }),
});

$('bot-select').onchange = () => { void switchBot($('bot-select').value); };
$('manage-bots').onclick = () => { view('account'); $('bot-list').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
$('add-bot-button').onclick = () => { $('add-bot-error').textContent = ''; $('add-bot-dialog').showModal(); syncBotLock(); };
$('add-bot-form').onsubmit = (event) => {
  event.preventDefault();
  const data = { name: $('new-bot-name').value.trim(), token: $('new-bot-token').value.trim(), guildIds: $('new-bot-guilds').value.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean) };
  if (!data.token) return;
  void run(async () => {
    $('add-bot-submit').disabled = true; $('add-bot-error').textContent = '';
    try {
      const result = await api('/bots/add', data); $('new-bot-token').value = ''; $('add-bot-form').reset(); $('add-bot-dialog').close();
      await loadBots(); const id = result.bot?.id || result.id;
      if (id && bots.some((bot) => bot.id === id)) await switchBot(id, true);
      const added = bots.find((bot) => bot.id === id);
      toast(added?.status === 'error' ? '机器人已保存，但连接未成功，请查看错误后重试。' : '机器人已添加，请为它选择语音频道。', added?.status === 'error');
    } catch (error) { $('add-bot-error').textContent = error.message; throw error; }
    finally { $('add-bot-submit').disabled = false; }
  });
};
$('add-bot-dialog').addEventListener('close', () => { $('new-bot-token').value = ''; });
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', syncBotLock));
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
  try { const result = await api('/login', { password: $('password').value }); csrf = result.csrf; $('password').value = ''; await enter(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('show-password').onclick = () => { const reveal = $('password').type === 'password'; $('password').type = reveal ? 'text' : 'password'; $('show-password').innerHTML = icon(reveal ? 'eye-off' : 'eye'); drawIcons(); };
$('logout').onclick = () => {
  if (accessControlled && actor?.siteAdmin) return run(async () => { const result = await api('/admin/logout', {}); csrf=result.csrf||''; actor=result.actor||null; location.replace('/'); });
  if (accessControlled && !window.confirm('退出后，这个浏览器会成为新访客，“我的点歌”不再关联旧身份。管理员可重新登录；DJ 和房主需要新的邀请。确定退出此身份？')) return;
  return run(async () => { await api('/logout', {}); if (accessControlled) { csrf=''; location.replace('/'); } else showLogin(); });
};
document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => view(b.dataset.view); });
$('search-form').onsubmit = (event) => {
  event.preventDefault(); smartLinks.submit();
};
document.addEventListener('click', (event) => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-close')) b.closest('dialog').close();
  if (b.hasAttribute('data-discover')) view('discover');
  if (b.dataset.musicSource) switchSource(b.dataset.musicSource);
  if (b.dataset.category) loadDiscover(b.dataset.category);
  if (b.dataset.openPlaylist) openPlaylist(b.dataset.openPlaylist, b.dataset.itemSource || 'netease');
  if (b.dataset.add) void addTrack(b.dataset.add, b.dataset.itemSource || 'netease');
  if (b.dataset.remove) control('remove', Number(b.dataset.remove));
  if (b.dataset.move) control('move', { from: Number(b.dataset.move), to: Number(b.dataset.move) - 1 });
  if (b.dataset.playlist) importPlaylist(b.dataset.playlist, true, b.dataset.itemSource || 'netease');
  if (b.dataset.qrType) void showQR(qrSource, b.dataset.qrType);
  if (b.dataset.selectBot) void switchBot(b.dataset.selectBot);
  if (b.dataset.removeBot) removeBot(b.dataset.removeBot);
  if (b.dataset.retryBot) { const botId = b.dataset.retryBot; void run(async () => { await api('/bots/retry', { botId }); await loadBots(); toast('已尝试重新连接，请查看机器人状态。'); }); }
});
$('playlist-back').onclick = () => {
  const id = activePlaylist?.id;
  view('discover', { restoreDiscover: true });
  document.querySelector(`[data-open-playlist="${CSS.escape(id || '')}"]`)?.focus({ preventScroll: true });
};
$('playlist-more').onclick = () => { void loadPlaylistPage(); };
$('playlist-add').onclick = () => { if (activePlaylist) importPlaylist(activePlaylist.id, false, sourceId(activePlaylist)); };
$('channel-button').onclick = openChannel;
$('guild-select').onchange = updateChannelSelects;
$('voice-select').onchange = () => { $('text-select').value = $('voice-select').value; };
$('channel-form').onsubmit = (event) => { event.preventDefault(); const botId = channelDialogBot; const channel = { guildId: $('guild-select').value, voiceChannelId: $('voice-select').value, textChannelId: $('text-select').value }; run(async () => {
  await botApi('/channel', channel, botId); selected = channel; sessionStorage.setItem(`channel:${botId}`, JSON.stringify(selected)); $('channel-dialog').close(); toast('频道已连接');
}); };
$('heart-button').onclick = () => {
  if (!sourceSupports(availableSources, currentSource, currentSource === 'qq' ? 'mine' : 'heart')) return;
  if (currentSource === 'qq') { currentCategory = 'mine'; view('discover'); return; }
  const source = currentSource, botId = selectedBotId;
  withContext((ctx) => run(async () => { const result = await botApi('/heart', { ...ctx, source }, botId); toast(result.notice); }), botId);
};
$('hot-button').onclick = () => { const source = currentSource, botId = selectedBotId; requireAccount(source, () => withContext((ctx) => run(async () => { const result = await botApi('/hot', { ...ctx, source }, botId); toast(result.notice); }), botId)); };
$('import-button').onclick = () => {
  importSource = currentSource; importBot = selectedBotId; $('import-title').textContent = '导入音乐歌单';
  $('playlist-input').placeholder = `粘贴 QQ / 网易云 / 汽水完整链接，或${sourceNames[importSource]}歌单 ID`;
  $('import-source-note').textContent = `完整链接自动识别平台；纯数字 ID 使用${sourceNames[importSource]}。`;
  $('import-dialog').showModal(); syncBotLock();
};
$('import-form').onsubmit = (event) => {
  event.preventDefault(); const id = $('playlist-input').value.trim(); if (!id || busy) return;
  if (importBot !== selectedBotId) { $('import-dialog').close(); return toast('当前机器人已切换，请重新打开导入歌单。', true); }
  $('import-dialog').close(); smartLinks.acceptImport(id);
};
$('play-pause').onclick = () => control(state?.player.status === 'playing' ? 'pause' : 'resume');
$('recover-button').onclick = () => control('resume');
$('skip-button').onclick = () => control('skip');
$('loop-button').onclick = () => { const modes = ['off', 'all', 'one']; control('loop', modes[(modes.indexOf(state.player.mode) + 1) % 3]); };
$('loop-select').onchange = () => control('loop', $('loop-select').value);
$('volume').oninput = () => { $('volume-number').textContent = $('volume').value; };
$('volume').onchange = () => control('volume', Number($('volume').value));
$('seek').oninput = () => { $('elapsed').textContent = duration(Number($('seek').value)); };
$('seek').onchange = () => control('seek', Number($('seek').value));
$('shuffle-queue').onclick = () => control('shuffle');
$('clear-queue').onclick = () => { const botId = selectedBotId; confirmAction('清空待播队列', '当前播放的歌曲会继续。', () => control('clear', undefined, botId)); };
$('leave-button').onclick = () => { const botId = selectedBotId; confirmAction('停止并离开频道', '当前播放和待播队列将被清空。', () => control('stop', undefined, botId)); };
$('stay-toggle').onchange = () => { const botId = selectedBotId, stayConnected = $('stay-toggle').checked; run(async () => { const result = await botApi('/settings', { stayConnected }, botId); if (result.ok) toast('常驻设置已保存'); }); };
$('qr-button').onclick = () => { pendingLoginAction = null; void showQR('netease', 'qq'); };
$('qq-qr-button').onclick = () => { pendingLoginAction = null; void showQR('qq', 'qq'); };
$('renew-qr').onclick = () => { void showQR(qrSource, qrType); };
$('refresh-account').onclick = () => run(loadAccounts);
for (const source of ['netease', 'qq']) $(accountIds(source).logout).onclick = () => confirmAction(`退出${sourceNames[source]}账号`, '后续需要重新扫码登录。', () => run(async () => {
  accountRequests[source]++; await api('/account/logout', { source }); await loadAccount(source);
}));
$('qr-dialog').addEventListener('close', () => { if (!$('qr-dialog').open) { clearTimeout(qrTimer); qrRequest++; pendingLoginAction = null; syncBotLock(); } });
$('motion-toggle').onclick = () => setMotion(!motion); $('settings-motion').onchange = () => setMotion($('settings-motion').checked);
$('immersive-toggle').onclick = () => { immersive = !immersive; document.body.classList.toggle('scene-only', immersive); scene?.setImmersive(immersive); $('immersive-toggle').innerHTML = icon(immersive ? 'minimize' : 'expand'); drawIcons(); };
document.addEventListener('visibilitychange', () => {
  statusPage.setActive(currentView === 'status' && !document.hidden && Boolean(csrf));
  lyricsPage.setActive(currentView === 'lyrics' && !document.hidden && Boolean(csrf));
  healthPage.setActive(currentView === 'health' && !document.hidden && Boolean(csrf));
  if (!document.hidden && csrf) refresh();
});
let accessRenewal = Promise.resolve();
window.addEventListener('hashchange', () => {
  const token = takeAccessToken(); if (!token) return;
  accessRenewal = accessRenewal.catch(()=>{}).then(async()=>{
    await api('/access/redeem',{token});const result=await api('/session');csrf=result.csrf;actor=result.actor||null;roles=result.roles||{};accessControlled=result.accessControlled===true;
    stateRequest++;polling=false;await refresh();renderBots();if(permission('manageSite'))void loadAccounts();toast('管理身份已验证。');
  }).catch((error)=>toast(`链接未能验证：${error.message}。管理员请从侧栏登录。`,true));
});
document.addEventListener('error', (event) => { if (event.target instanceof HTMLImageElement) event.target.hidden = true; }, true);
setMotion(motion); renderSources(); drawIcons();
api('/session').then(async (result) => {
  accessControlled = result.accessControlled === true; actor = result.actor || null; roles = result.roles || {};
  passwordRequired = result.passwordRequired !== false;
  if (result.authenticated) { csrf = result.csrf;
    if (accessToken) {
      try { await api('/access/redeem', {token:accessToken}); const updated=await api('/session');csrf=updated.csrf;actor=updated.actor||null;roles=updated.roles||{}; }
      catch(error){toast(`链接未能验证：${error.message}。管理员请从侧栏登录。`,true);}
    }
    await enter();
  } else showLogin();
}).catch(() => { $('login').hidden = true; $('app').hidden = false; $('logout').hidden = true; toast('无法连接控制台服务，请刷新重试。', true); });
