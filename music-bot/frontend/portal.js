import { createIcons, Headphones, UserRound, Radio, ArrowLeft, ArrowRight, QrCode, SlidersHorizontal, Disc3, SkipBack, SkipForward, Pause, Play, Volume2, Search, Users, Copy, X, Music2, ListMusic, RefreshCw, Shuffle, ListX } from 'lucide';
import { createSessionApi } from './session.js';
import { takeAccessToken } from './access.js';
import { sourceName, normalizeSource, defaultSources, sourceDescriptors, sourceSupports } from './music-sources.js';
const accessToken = takeAccessToken();
const icons = { Headphones, UserRound, Radio, ArrowLeft, ArrowRight, QrCode, SlidersHorizontal, Disc3, SkipBack, SkipForward, Pause, Play, Volume2, Search, Users, Copy, X, Music2, ListMusic, RefreshCw, Shuffle, ListX };
const $ = (id) => document.getElementById(id);
const draw = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const icon = (name) => `<i data-lucide="${name}"></i>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const duration = (value) => { const n = Math.max(0, Number(value) || 0); return `${Math.floor(n / 60)}:${String(Math.floor(n) % 60).padStart(2, '0')}`; };
const clock = (value) => new Date(value).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
const date = (value) => new Date(value).toLocaleString('zh-CN', { hour12:false });
const badge = (source) => `<span class="source-badge ${normalizeSource(source)}">${sourceName(source)}</span>`;
const roleName = (role) => ({ guest:'访客', member:'网页成员', dj:'DJ', owner:'房主', siteAdmin:'站长' })[role] || '网页成员';
const cleanPath = decodeURIComponent(location.pathname).match(/^\/room\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/?$/);
const botId = cleanPath?.[1] || '';
const roomPath = (id) => `/room/${encodeURIComponent(id)}`;
let csrf = '', actor = null, room = null, busy = false, pollTimer, heartbeatTimer, toastTimer, searchTimer, requestSerial = 0, refreshSerial = 0;
let source = 'netease', lastSource = 'netease', tab = 'queue', searchItems = [], preview = null, renderedQueue = '', renderedMembers = '', searchStatus = '', lastHeartbeat = 0;
let availableSources = defaultSources();
let accessTail = Promise.resolve();
let manageableBotIds = [];
let catalog = null, catalogPending = null, catalogAttempt = 0;
const editingRanges = new Set();
const api = createSessionApi({ getCsrf: () => csrf, setCsrf: (value) => { csrf = value; }, requiresPassword: () => false,
  onUnauthorized: () => message('会话已失效，请刷新页面后重试。', true) });
function message(text, error = false) { $('portal-message').textContent = text; $('portal-message').classList.toggle('error', error); $('portal-message').hidden = !text; }
function toast(text) { $('portal-toast').textContent = text; $('portal-toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('portal-toast').hidden = true; }, 4500); }
function can(permission) { return room?.permissions?.[permission] === true; }
function paintIdentity() {
  $('identity-button').querySelector('span').textContent = actor?.name || '设置昵称';
  const targetBotId = botId || manageableBotIds[0];
  const consolePath = `/admin/console${targetBotId ? `?botId=${encodeURIComponent(targetBotId)}` : ''}`;
  $('console-link').hidden = !actor?.siteAdmin && !(botId ? can('control') : manageableBotIds.length);
  $('console-link').textContent = actor?.siteAdmin ? '管理控制台' : '房间控制台';
  $('console-link').href = consolePath;
  $('admin-link').textContent = actor?.siteAdmin ? '账号设置' : '管理员登录';
  $('admin-link').href = `/admin?${new URLSearchParams({returnTo: consolePath})}`;
}
function lock(value) {
  busy = value; document.body.classList.toggle('working', value);
  $('identity-button').disabled = value;
  for (const el of document.querySelectorAll('#room-search-form input,#room-search-form button,[data-request],[data-withdraw],[data-control],#room-volume,#room-progress,#room-loop,#create-invite,[data-revoke],[data-revoke-invite]')) el.disabled = value;
  renderSources();
  if (!value && room) renderRoom();
}
async function mutate(task) {
  if (busy) return;
  refreshSerial++; lock(true);
  try { const result = await task(); await refreshRoom(); return result; }
  catch (error) { toast(error.message || '操作失败，请稍后重试。'); await refreshRoom().catch(() => {}); }
  finally { lock(false); }
}
function openIdentity() { $('nickname').value = actor?.name || ''; $('identity-error').textContent = ''; $('leave-identity').hidden = !actor?.id; $('identity-dialog').showModal(); $('nickname').focus(); }
function online(value) { return value ? '机器人在线' : '等待连接'; }
function lobbyRoom(item) {
  const profile = item.profile || {}, p = item.player || {}, song = p.current || item.current;
  const webCount = item.members?.webCount ?? item.webCount, voiceCount = item.members?.voiceCount ?? item.voiceCount;
  const theme = ['bamboo','blossom','night'].includes(profile.theme) ? profile.theme : 'bamboo';
  return `<a class="room-card theme-${theme}" href="${roomPath(item.botId || item.id)}"><div class="room-cover room-card-cover"><div class="room-card-top"><span class="room-emblem">${icon('radio')}</span><span class="pill">${online(item.online)}</span></div></div><h2>${esc(profile.title || item.name || '音乐房间')}</h2><p class="room-card-description">${esc(profile.description || '把喜欢的音乐放进这里，和朋友一起听。')}</p><div class="room-card-song">${icon('music-2')}<span>${esc(song?.name || item.trackName || '等待下一首好歌')}</span></div><div class="room-card-bottom"><span>${Number.isFinite(webCount) ? `${webCount} 位网页成员` : '进入查看成员'}${Number.isFinite(voiceCount) ? ` · ${voiceCount} 位语音听众` : ''}</span><strong>进入房间${icon('arrow-right')}</strong></div></a>`;
}
async function refreshLobby() {
  try { const data = await api('/rooms'); manageableBotIds = (data.rooms || []).filter((item) => item.permissions?.control).map((item) => item.botId || item.id); paintIdentity(); $('room-cards').innerHTML = data.rooms?.length ? data.rooms.map(lobbyRoom).join('') : '<div class="empty">暂时没有音乐房间，稍后再来看看。</div>'; $('lobby-updated').textContent = `更新于 ${clock(Date.now())} · 房间列表自动刷新`; draw(); }
  catch (error) { message(`暂时无法更新房间列表：${error.message}`, true); }
}
async function refreshRoom() {
  if (!botId) return;
  const serial = ++refreshSerial;
  const result = await api(`/room?${new URLSearchParams({ botId })}`);
  if (serial !== refreshSerial) return;
  if (result.botId !== botId) throw new Error('房间数据不匹配，请刷新重试。');
  room = result; if ('actor' in room) actor = room.actor; renderRoom(); paintIdentity(); void loadCatalog();
}
function renderListeningLocation() {
  const context = room?.player?.context;
  const guild = catalog?.guilds?.find((item)=>item.id===context?.guildId);
  const channel = guild?.channels?.find((item)=>item.id===context?.voiceChannelId);
  const label = room?.channel?.name || room?.voiceChannelName || channel?.name || context?.voiceChannelId;
  $('listen-location').querySelector('span').textContent = label ? `请进入 KOOK「${label}」语音频道听音。网页用于点歌和控制。` : '机器人尚未选择语音频道，请联系房主。';
}
async function loadCatalog() {
  if (!botId || !room?.player?.context || catalogPending || Date.now()-catalogAttempt<60000) return;
  catalogAttempt=Date.now();
  catalogPending=api(`/catalog?${new URLSearchParams({botId})}`).then((result)=>{catalog=result;renderListeningLocation();}).catch(()=>{}).finally(()=>{catalogPending=null;});
  await catalogPending;
}
function renderRoom() {
  if (!room) return;
  const p = room.player || {}, current = p.current, profile = room.profile || {};
  $('room-title').textContent = profile.title || room.name;
  document.title = `${profile.title || room.name} · 桃音`;
  $('room-bot-name').textContent = room.name || 'MUSIC ROOM'; $('room-description').textContent = profile.description || '把喜欢的歌带来，和朋友一起听。';
  $('room-hero').className = `room-hero theme-${['bamboo','blossom','night'].includes(profile.theme) ? profile.theme : 'bamboo'}`;
  $('room-online').textContent = online(room.online); $('room-role').textContent = actor?.siteAdmin ? '站长' : roleName(room.role);
  $('room-playback').textContent = ({playing:'正在播放',paused:'已暂停',idle:'空闲待播',ready:'进度已保留',recovering:'正在恢复'})[p.status] || '暂不可用';
  $('room-current-title').textContent = current?.name || '等待下一首好歌'; $('room-current-artist').textContent = current?.artists || '';
  $('room-source').textContent = current ? sourceName(current.source) : ''; $('room-source').className = `source-badge ${normalizeSource(current?.source)}`; $('room-source').hidden = !current;
  $('room-requester').textContent = current?.requester?.name ? `${current.requester.name} 点的歌${current.mine ? ' · 你的点歌' : ''}` : '';
  const img = $('room-current-cover');
  if (current?.cover && /^https?:\/\//i.test(current.cover)) { if (img.dataset.source !== current.cover) { img.dataset.source = current.cover; img.src = current.cover; img.hidden = false; } }
  else { img.hidden = true; img.removeAttribute('src'); delete img.dataset.source; }
  const total = (Number(current?.durationMs) || 0) / 1000;
  if (!editingRanges.has('room-progress') && !busy) { $('room-progress').max = Math.max(total,1); $('room-progress').value = Math.min(Number(p.seconds)||0,Math.max(total,1)); $('room-time').textContent = `${duration(p.seconds)} / ${duration(total)}`; }
  renderListeningLocation();
  $('edit-room').hidden = !can('manageRoom'); $('owner-panel').hidden = !can('manageRoom') && !can('manageRoles'); $('manage-room-roles').hidden = !can('manageRoles');
  $('room-settings-link').hidden = !can('manageRoom'); $('room-settings-link').href = `/admin/console?botId=${encodeURIComponent(botId)}&view=room`;
  $('dj-console').href = `/admin/console?botId=${encodeURIComponent(botId)}`;
  $('dj-console').hidden = !can('control');
  $('dj-controls').hidden = false;
  const playbackAllowed = can('playbackControl'), queued = Number(p.queueCount ?? room.queue?.length) || 0;
  $('playback-hint').textContent = !actor?.name ? '设置昵称后即可控制播放。' : !playbackAllowed ? '当前身份暂时不能控制播放。' : !p.context ? '房主连接语音频道后即可控制播放。' : '操作会同步到整个房间，请和朋友一起安排播放。';
  $('playback-identity').hidden = Boolean(actor?.name);
  const playing = ['playing','recovering'].includes(p.status), action = playing ? 'pause' : 'resume';
  $('room-play-toggle').dataset.control = action; $('room-play-toggle').innerHTML = `${icon(playing ? 'pause' : 'play')}${playing ? '暂停' : '播放'}`;
  for (const button of document.querySelectorAll('[data-control]')) { const action = button.dataset.control; button.disabled = busy || !playbackAllowed || !p.context || (action === 'previous' ? !p.canPrevious : action === 'clear' ? !queued : action === 'shuffle' ? queued < 2 : !current && !queued); }
  $('room-volume').disabled = busy || !playbackAllowed || !p.context;
  $('room-progress').disabled = busy || !playbackAllowed || !p.context || !current || total <= 0;
  $('room-loop').disabled = busy || !playbackAllowed || !p.context;
  if (!busy) $('room-loop').value = p.mode || 'off';
  if (!editingRanges.has('room-volume') && !busy) { $('room-volume').value = p.volume ?? 0; $('room-volume-value').textContent = `${p.volume ?? 0}%`; }
  $('request-hint').textContent = !actor?.name ? '设置一个昵称，即可在这个房间点歌。' : !can('request') ? '当前身份暂时不能点歌。' : !p.context ? '房主连接语音频道后即可加入歌曲。' : `以「${actor.name}」点歌 · ${room.role === 'member' ? '未验证网页成员' : roleName(room.role)} · ${p.capacity ?? 0} 个空位`;
  $('room-queue-count').textContent = room.queue?.length || 0;
  for (const button of document.querySelectorAll('[data-request]')) { button.textContent = actor?.name ? button.dataset.requestLabel || '加入队列' : '设置昵称'; button.disabled = busy || Boolean(actor?.name && (!can('request') || !p.context || p.capacity < 1)); }
  renderQueue(); renderMembers();
  if (!can('manageRoom') && $('profile-dialog').open) $('profile-dialog').close();
  if (!can('manageRoles') && $('roles-dialog').open) $('roles-dialog').close();
  draw();
}
function entry(item) {
  const track = item.track || item;
  const waiting = item.waitSeconds === null || item.waitSeconds === undefined ? item.waitNotice || '等待时间暂不能估计' : `预计 ${duration(item.waitSeconds)} 后播放${item.waitNotice ? ` · ${item.waitNotice}` : ''}`;
  const withdraw = item.mine && can('withdrawOwn');
  return `<article class="queue-entry" data-entry="${esc(item.entryId)}"><span class="queue-position">${item.position || ''}</span><div class="track-info"><strong>${esc(track.name)}</strong><p>${badge(track.source)}${esc(track.artists)}</p><p>${esc(item.requester?.name || '系统')} 点歌${item.mine ? ' · 我' : ''}</p><span class="queue-wait">前面 ${Number(item.ahead) || 0} 首 · ${esc(waiting)}</span></div>${withdraw ? `<button class="secondary" data-withdraw="${esc(item.entryId)}" ${busy ? 'disabled' : ''}>撤回</button>` : ''}</article>`;
}
function renderQueue() {
  if (!room) return;
  document.querySelectorAll('[data-tab]').forEach((button) => button.setAttribute('aria-selected',String(button.dataset.tab === tab)));
  const list = tab === 'mine' ? room.mine || [] : room.queue || [];
  const markup = tab === 'events' ? (room.events?.length ? room.events.map((event) => `<article class="room-event"><time>${esc(clock(event.time))}</time><p>${event.actorName ? `<strong>${esc(event.actorName)}</strong> · ` : ''}${esc(event.message)}</p></article>`).join('') : '<div class="empty">这里会记录大家点歌和房间的动态。</div>') : list.length ? list.map(entry).join('') : `<div class="empty">${tab === 'mine' ? '你还没有待播歌曲。搜一首想听的歌吧。' : '队列空着，等你带来第一首。'}</div>`;
  if (markup !== renderedQueue) { renderedQueue = markup; $('queue-content').innerHTML = markup; }
}
function renderMembers() {
  const members = room.members || {};
  $('web-count').textContent = members.webCount ?? members.web?.length ?? 0;
  $('voice-count').textContent = members.voiceCount ?? (members.voiceLoading ? '…' : '未知');
  const signature = JSON.stringify(members);
  if (signature === renderedMembers) return; renderedMembers = signature;
  $('web-members').innerHTML = members.web?.length ? members.web.map((member) => `<div class="member"><span class="member-avatar">${esc(member.name?.slice(0,1) || '友')}</span><span class="member-name">${esc(member.name || '访客')}${member.isSelf ? ' · 我' : ''}</span><small>${member.role === 'guest' ? '未设置昵称' : roleName(member.role)}</small></div>`).join('') : '<p class="muted">正在更新网页在线成员。</p>';
  $('voice-members').innerHTML = members.voice?.length ? members.voice.map((member) => `<div class="member"><span class="member-avatar">${esc(member.name?.slice(0,1) || '听')}</span><span class="member-name">${esc(member.name)}</span>${member.bot ? '<small>机器人</small>' : ''}</div>`).join('') : `<p class="muted">${members.voiceLoading ? '正在读取语音频道成员…' : members.voiceCount === 0 ? '暂时没有语音频道成员。' : '语音频道成员暂时未知。'}</p>`;
  $('voice-notice').textContent = members.voiceLoading ? members.voiceStale ? '正在更新语音成员，暂显示上次结果。' : '正在读取 KOOK 语音成员。' : members.voiceError || (members.voiceStale ? '语音成员信息暂未更新，显示上次状态。' : members.voiceCheckedAt ? `语音成员更新于 ${clock(members.voiceCheckedAt)}` : '');
}
async function heartbeat() {
  if (!botId || !actor?.id || document.hidden || Date.now() - lastHeartbeat < 18000) return;
  lastHeartbeat = Date.now();
  try { await api('/room/heartbeat', { botId }); } catch { /* The next presence heartbeat retries without affecting audio. */ }
}
function renderSources() {
  document.querySelectorAll('[data-source]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.source === source));
    button.disabled = busy || (button.dataset.source !== 'all' && !sourceSupports(availableSources, button.dataset.source, 'search'));
  });
}
async function loadSources() {
  try { availableSources = sourceDescriptors((await api('/sources')).sources); }
  catch { /* Keep the optional bridge disabled when source discovery fails. */ }
  renderSources();
}
function searchLock() { $('room-search-form').querySelectorAll('input,button').forEach((el) => { el.disabled = busy; }); renderSources(); }
function requestButton(index, label='加入队列') { return `<button class="secondary" data-request="${index}" data-request-label="${esc(label)}" ${busy || actor?.name && (!can('request') || !room?.player?.context || room.player.capacity < 1) ? 'disabled' : ''}>${actor?.name ? label : '设置昵称'}</button>`; }
async function search({ automatic = false } = {}) {
  if (busy) return;
  const input = $('room-query').value.trim(); if (!input) return;
  clearTimeout(searchTimer); const serial = ++requestSerial, selectedSource = source;
  preview = null; searchItems = []; searchStatus = input; $('room-search-results').innerHTML = '<div class="empty">正在寻找这段旋律…</div>';
  const link = /https?:\/\//i.test(input), numeric = /^\d+$/.test(input);
  try {
    if (source === 'all' && numeric) throw new Error('纯数字 ID 请先选择一个音乐来源。');
    if (!link && source !== 'all' && !sourceSupports(availableSources, source, 'search')) throw new Error('这个音乐来源暂不可用，请选择其他来源。');
    if (link || numeric) {
      const result = await api(`/resolve?${new URLSearchParams({ input, source: source === 'all' ? lastSource : source })}`);
      if (serial !== requestSerial || input !== $('room-query').value.trim()) return;
      if (!['song','playlist'].includes(result.kind)) throw new Error('这条内容没有识别为歌曲或歌单。');
      preview = { ...result, expectedVoiceChannelId: room?.player?.context?.voiceChannelId };
      const item = result.track || result.playlist, total = result.kind === 'playlist' ? Number(result.total)||0 : 1;
      $('room-search-results').innerHTML = `<div class="link-preview">${badge(result.source)}<h3>${esc(item?.name || '音乐歌单')}</h3><p>${esc(item?.artists || item?.creator || '')}${result.kind === 'playlist' ? ` · ${total} 首歌曲` : ''}</p><p>加入「${esc(room?.profile?.title || room?.name)}」；实际数量受你的点歌额度与队列容量限制。</p>${requestButton('preview',result.kind === 'playlist' ? '加入歌单' : '加入这首歌')}<p class="muted">点击后才加入，不打断正在播放的歌曲。</p></div>`;
    } else {
      const result = await api(source === 'all' ? `/search-all?${new URLSearchParams({ q:input })}` : `/search?${new URLSearchParams({ q:input, source })}`);
      if (serial !== requestSerial || selectedSource !== source || input !== $('room-query').value.trim()) return;
      const groups = source === 'all' ? result.groups || [] : [{ source, tracks: result.tracks || [] }];
      $('room-search-results').innerHTML = groups.map((group) => `<section class="search-results-group"><h3>${badge(group.source)} ${group.tracks.length} 首</h3>${group.error ? `<p class="error">${esc(group.error)}</p>` : ''}${group.tracks.map((track) => { const index = searchItems.push({ ...track,source:group.source })-1; return `<article class="search-track"><div class="track-info"><strong>${esc(track.name)}</strong><p>${esc(track.artists)}${track.album ? ` · ${esc(track.album)}` : ''}</p></div>${requestButton(index)}</article>`; }).join('') || (!group.error ? '<div class="empty">没有找到匹配的歌曲，换个关键词试试。</div>' : '')}</section>`).join('');
    }
  } catch (error) { if (serial === requestSerial) $('room-search-results').innerHTML = `<div class="empty error">${esc(error.message || '读取失败，请稍后重试。')}</div>`; }
  draw();
}
async function requestMusic(index) {
  if (busy) return;
  if (!actor?.name) return openIdentity();
  if (!can('request')) return toast('当前身份不能点歌，请刷新房间状态。');
  if (!room.player.context) return toast('房主连接语音频道后即可点歌。');
  const item = index === 'preview' ? preview : searchItems[Number(index)]; if (!item) return;
  if (searchStatus !== $('room-query').value.trim()) return toast('搜索内容已变化，请重新搜索后加入。');
  const channel = item.expectedVoiceChannelId || room.player.context.voiceChannelId;
  if (channel !== room.player.context.voiceChannelId) return toast('房间频道已变化，请重新预览。');
  const data = index === 'preview' ? { input:item.input,source:item.source,kind:item.kind,...(item.kind === 'playlist' ? {maxItems:Math.max(1,Math.min(Number(item.total)||1,room.player.capacity||1,500))} : {}) }
    : { input:String(item.mid || item.id),source:item.source,kind:'song' };
  await mutate(async () => { const result = await api('/room/request',{botId,...data,expectedVoiceChannelId:channel}); toast(result.notice || `已加入 ${result.added || 0} 首歌曲`); });
}
async function controlPlayback(action, value) {
  if (busy) return;
  if (!actor?.name) return openIdentity();
  if (!can('playbackControl')) return toast('当前身份不能控制播放，请刷新房间状态。');
  const expectedVoiceChannelId = room?.player?.context?.voiceChannelId;
  if (!expectedVoiceChannelId) return toast('房主连接语音频道后即可控制播放。');
  if (action === 'clear' && !window.confirm('清空这个房间所有人的待播歌曲？当前歌曲会继续播放。已开启的自动电台之后可能补歌。')) return;
  await mutate(async () => {
    const result = await api('/room/control', { botId, action, ...(value === undefined ? {} : { value }), expectedVoiceChannelId });
    if (action === 'clear') toast('已清空待播，当前歌曲继续播放；自动电台仍按原设置运行。');
    else if (action === 'shuffle') toast('已随机排列待播歌曲。');
    else if (result.message) toast(result.message);
  });
}
async function loadRoles() {
  if (!can('manageRoles')) throw new Error('当前身份不能管理房间成员。');
  const data = await api(`/room/roles?${new URLSearchParams({botId})}`);
  if (!can('manageRoles') || !$('roles-dialog').open) return;
  $('role-members').innerHTML = data.members?.length ? data.members.map((member) => `<div class="role-entry"><div>${esc(member.name)}<small>${roleName(member.siteAdmin ? 'siteAdmin' : member.role)}${member.expired ? ' · 身份已失效' : ''}</small></div>${member.id !== actor?.id && !member.siteAdmin && (member.role === 'dj' || can('manageSite')) ? `<button class="secondary" data-revoke="${esc(member.id)}">撤销权限</button>` : ''}</div>`).join('') : '<p class="muted">尚未授权其他成员。</p>';
  $('role-invites').innerHTML = data.invites?.length ? data.invites.map((invite) => `<div class="role-entry"><div>${roleName(invite.role)} 邀请<small>${invite.expires <= Date.now() ? '已过期' : `有效至 ${esc(date(invite.expires))}`}</small></div><button class="secondary" data-revoke-invite="${esc(invite.id)}">撤销邀请</button></div>`).join('') : '<p class="muted">暂无待接受邀请。</p>';
}
async function copy(value, success) {
  try { await navigator.clipboard.writeText(value); toast(success); }
  catch { toast('浏览器未允许自动复制，请选中链接手动复制。'); }
}
$('identity-button').onclick = openIdentity;
$('playback-identity').onclick = openIdentity;
$('leave-identity').onclick = async () => {
  if (!window.confirm('退出后，这个浏览器会成为新访客，“我的点歌”不再关联旧身份。管理员可重新登录；DJ 和房主需要新的邀请。只退出管理员登录请前往账号设置。确定退出此身份？')) return;
  $('leave-identity').disabled = true;
  try { await api('/logout', {}); location.replace(botId ? roomPath(botId) : '/'); }
  catch (error) { $('identity-error').textContent = error.message; $('leave-identity').disabled = false; }
};
$('identity-form').onsubmit = async (event) => {
  event.preventDefault(); if (busy) return;
  const button = event.submitter; button.disabled = true; $('identity-error').textContent = '';
  try { const result = await api('/identity/profile',{name:$('nickname').value.trim()}); const session = await api('/session'); actor = session.actor || result.actor; csrf = session.csrf; paintIdentity(); $('identity-dialog').close(); if (botId) { lastHeartbeat=0; await heartbeat(); await refreshRoom(); } toast('昵称已保存，欢迎来听歌。'); }
  catch (error) { $('identity-error').textContent = error.message; } finally { button.disabled = false; }
};
$('room-search-form').onsubmit = (event) => { event.preventDefault(); void search(); };
$('room-query').oninput = () => { clearTimeout(searchTimer); requestSerial++; preview=null; searchItems=[]; $('room-search-results').innerHTML=''; if (/https?:\/\//i.test($('room-query').value)) searchTimer=setTimeout(()=>void search({automatic:true}),500); };
document.addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.hasAttribute('data-close')) button.closest('dialog').close();
  if (button.dataset.source) { source=button.dataset.source;if(source!=='all')lastSource=source;requestSerial++;renderSources();if($('room-query').value.trim())void search(); }
  if (button.dataset.tab) { tab=button.dataset.tab;renderedQueue='';renderQueue(); }
  if (button.hasAttribute('data-request')) void requestMusic(button.dataset.request);
  if (button.dataset.withdraw && can('withdrawOwn')) void mutate(async()=>{await api('/room/withdraw',{botId,entryId:button.dataset.withdraw});toast('已撤回这首待播歌曲。');});
  if (button.dataset.control) void controlPlayback(button.dataset.control);
  if (button.dataset.revoke && can('manageRoles')) void mutate(async()=>{await api('/room/revoke',{botId,targetId:button.dataset.revoke});await loadRoles();toast('权限已撤销。');});
  if (button.dataset.revokeInvite && can('manageRoles')) void mutate(async()=>{await api('/room/revoke-invite',{botId,inviteId:button.dataset.revokeInvite});await loadRoles();toast('邀请已撤销。');});
});
for (const id of ['room-volume','room-progress']) {
  const input = $(id);
  input.onpointerdown = () => { editingRanges.add(id); };
  input.onpointerup = () => { setTimeout(() => { editingRanges.delete(id); if (!busy) renderRoom(); },0); };
  input.onpointercancel = () => { editingRanges.delete(id); renderRoom(); };
  input.onblur = () => { editingRanges.delete(id); if (!busy) renderRoom(); };
  input.oninput = () => {
    editingRanges.add(id);
    if (id === 'room-volume') $('room-volume-value').textContent = `${input.value}%`;
    else $('room-time').textContent = `${duration(input.value)} / ${duration(input.max)}`;
  };
  input.onchange = () => { const value = Number(input.value); editingRanges.delete(id); void controlPlayback(id === 'room-volume' ? 'volume' : 'seek', value); };
}
$('room-loop').onchange = () => { void controlPlayback('loop', $('room-loop').value); };
$('share-room').onclick = async () => {
  $('share-feedback').textContent=''; $('share-room').disabled=true;
  try { const result=await api(`/room/share?${new URLSearchParams({botId})}`);const url=new URL(result.url,location.origin);if(url.origin!==location.origin||url.hash)throw new Error('分享地址不正确，请稍后重试。');$('share-url').value=url.href;$('share-qr').src=result.qr;$('share-dialog').showModal(); }
  catch(error){toast(error.message);}finally{$('share-room').disabled=false;}
};
$('copy-share').onclick=()=>void copy($('share-url').value,'房间链接已复制。');
function renderProfilePreview(){const form=$('room-profile-form');$('profile-preview').className=`profile-preview theme-${form.elements.theme.value}`;$('profile-preview-title').textContent=form.elements.title.value.trim()||'你的音乐房间';$('profile-preview-description').textContent=form.elements.description.value.trim()||'把喜欢的歌带来，和朋友一起听。';}
$('room-profile-form').addEventListener('input',renderProfilePreview);
$('room-profile-form').addEventListener('change',renderProfilePreview);
$('edit-room').onclick=()=>{if(!can('manageRoom'))return;const form=$('room-profile-form');for(const key of ['title','description','theme'])form.elements[key].value=room.profile?.[key]|| (key==='theme'?'bamboo':'');$('profile-error').textContent='';renderProfilePreview();$('profile-dialog').showModal();};
$('room-profile-form').onsubmit=async(event)=>{
  event.preventDefault();if(!can('manageRoom')||busy)return;event.submitter.disabled=true;const form=event.currentTarget;
  try{await api('/room/profile',{botId,title:form.elements.title.value.trim(),description:form.elements.description.value.trim(),theme:form.elements.theme.value});$('profile-dialog').close();await refreshRoom();toast('房间外观已保存。');}
  catch(error){$('profile-error').textContent=error.message;}finally{event.submitter.disabled=false;}
};
$('manage-room-roles').onclick=async()=>{if(!can('manageRoles'))return;$('roles-feedback').textContent='';$('invite-owner-option').hidden=!can('manageSite');$('invite-owner-option').disabled=!can('manageSite');$('invite-role').value='dj';$('roles-dialog').showModal();try{await loadRoles();}catch(error){$('roles-feedback').textContent=error.message;}};
$('create-invite').onclick=async()=>{if(busy||!can('manageRoles'))return;$('create-invite').disabled=true;$('new-invite').hidden=true;try{const data=await api('/room/invite',{botId,role:$('invite-role').value});if(!$('roles-dialog').open||!can('manageRoles'))return;const url=new URL(roomPath(botId),location.origin);url.hash=new URLSearchParams({invite:data.token}).toString();$('invite-url').value=url.href;$('invite-expiry').textContent=`有效至 ${date(data.expires)}。只交给你希望授权的人。`;$('new-invite').hidden=false;await loadRoles();}catch(error){$('roles-feedback').textContent=error.message;}finally{$('create-invite').disabled=false;}};
$('copy-invite').onclick=()=>void copy($('invite-url').value,'邀请链接已复制。');
$('roles-dialog').addEventListener('close',()=>{$('invite-url').value='';$('new-invite').hidden=true;});
document.addEventListener('error',(event)=>{if(event.target instanceof HTMLImageElement)event.target.hidden=true;},true);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(botId){void refreshRoom().catch((e)=>message(e.message,true));void heartbeat();}else void refreshLobby();}});
async function redeem(token) {
  const task = accessTail.then(async () => {
    const redeemed=await api('/access/redeem',{token});const fresh=await api('/session');csrf=fresh.csrf;actor=fresh.actor||redeemed.actor;
    if(redeemed.botId&&redeemed.botId!==botId){location.replace(roomPath(redeemed.botId));return;}
    paintIdentity();if(botId)await refreshRoom();else await refreshLobby();
    toast(redeemed.siteAdmin||actor?.siteAdmin?'管理身份已验证。':'房间权限已接受。');
  });
  accessTail=task.catch(()=>{});return task;
}
window.addEventListener('hashchange',()=>{const token=takeAccessToken();if(token)void redeem(token).catch((error)=>message(`链接未能验证：${error.message}。管理员请使用右上角登录入口。`,true));});
async function poll() {clearTimeout(pollTimer);if(!document.hidden&&!busy){if(botId)await refreshRoom().catch((e)=>message(`房间更新暂时失败：${e.message}`,true));else await refreshLobby();}pollTimer=setTimeout(poll,botId?4000:10000);}
async function start() {
  const session=await api('/session');csrf=session.csrf;actor=session.actor;
  await loadSources();
  if(accessToken){try{await redeem(accessToken);}catch(error){message(`链接未能验证：${error.message}。管理员请使用右上角登录入口。`,true);}}
  paintIdentity();$('lobby').hidden=Boolean(botId);$('room').hidden=!botId;
  if(botId){await refreshRoom();await heartbeat();heartbeatTimer=setInterval(()=>void heartbeat(),20000);}else await refreshLobby();
  const initialQuery = new URLSearchParams(location.search);
  if (botId && initialQuery.get('q')) { source = normalizeSource(initialQuery.get('source'));lastSource=source;renderSources();$('room-query').value=initialQuery.get('q').slice(0,2000);void search(); }
  pollTimer=setTimeout(poll,botId?4000:10000);draw();
}
draw();void start().catch((error)=>message(error.message||'暂时无法进入房间，请刷新重试。',true));
window.addEventListener('pagehide',()=>{clearTimeout(pollTimer);clearTimeout(searchTimer);clearInterval(heartbeatTimer);});
