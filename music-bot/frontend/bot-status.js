const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<i data-lucide="${name}"></i>`;
const seconds = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const duration = (value) => `${Math.floor(seconds(value) / 60)}:${String(Math.floor(seconds(value)) % 60).padStart(2, '0')}`;
const time = (value) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function gateway(bot) {
  const status = { starting: ['正在启动', 'pending'], stopping: ['正在停止', 'pending'], error: ['连接失败', 'error'], failed: ['连接失败', 'error'], removed: ['已移除', 'muted'] }[bot.status];
  return status || (bot.online ? ['在线', 'online'] : ['重连中', 'pending']);
}
function playerAvailable(bot, player) {
  return Boolean(player && !player.disabled && player.status !== 'unavailable' && !['starting', 'stopping', 'error', 'failed', 'removed'].includes(bot.status));
}

export function createBotStatus({ api, drawIcons, onControl, onManage, onChanged = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const records = new Map(), catalogs = new Map(), pendingCatalogs = new Map();
  const busy = new Set(), feedback = new Map(), revisions = new Map(), reads = new Map(), volumeDrafts = new Map();
  const partMarkup = new WeakMap();
  let bots = [], active = false, generation = 0, timer, inFlight = false, rerun = false;
  let listLoaded = false, listError = '', updatedAt = 0;

  function schedule(delay = 5000) {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => { void refresh(); }, delay);
  }
  function setActive(value) {
    if (active === value) return;
    active = value; generation++; clearTimeout(timer);
    if (!active) volumeDrafts.clear();
    if (active) { render(); void refresh(); }
  }
  function valid(epoch) { return active && generation === epoch; }
  function actionable(id) {
    const bot = bots.find((item) => item.id === id), record = records.get(id);
    return Boolean(bot && !listError && record && !record.error && playerAvailable(bot, record.player));
  }
  function controls(id) {
    return `<div class="status-controls" data-status-part="controls">
      <div class="status-transport" aria-label="播放控制"><button class="secondary" data-status-action="previous" title="播放上一首">${icon('skip-back')}<span>上一首</span></button><button class="secondary status-toggle" data-status-toggle data-status-action="resume">${icon('play')}<span>播放</span></button><button class="secondary" data-status-action="skip" title="播放下一首">${icon('skip-forward')}<span>下一首</span></button></div>
      <label class="status-volume">${icon('volume-2')}<span>音量</span><input type="range" min="0" max="100" step="1" data-status-volume="${escape(id)}" aria-label="机器人音量"><output data-status-volume-output>0%</output></label>
      <div class="status-shortcuts"><span class="status-caption">快捷歌单</span><div><button class="secondary" data-status-hot="qq">${icon('flame')}QQ音乐热歌榜</button><button class="secondary" data-status-hot="netease">${icon('flame')}网易云热歌榜</button></div><p>整榜追加，最多补至 500 首；当前播放继续。</p></div>
      <p class="status-control-hint" data-status-control-hint hidden></p>
      <div class="status-feedback" aria-live="polite" aria-atomic="true"><p data-status-feedback></p><button class="quiet-button" data-status-login hidden>去账号与设置登录${icon('arrow-right')}</button></div>
    </div>`;
  }
  function updateControls(node, bot) {
    const id = bot.id, player = records.get(id)?.player;
    const unavailable = !actionable(id), pending = busy.has(id), context = player?.context;
    const permissions = records.get(id)?.permissions;
    const allowed = permissions ? permissions.control === true : true;
    const disabled = unavailable || pending || !context || !allowed;
    const playing = ['playing', 'recovering'].includes(player?.status);
    const toggle = node.querySelector('[data-status-toggle]'), action = playing ? 'pause' : 'resume';
    if (toggle.dataset.statusAction !== action) {
      toggle.dataset.statusAction = action;
      toggle.innerHTML = `${icon(playing ? 'pause' : 'play')}<span>${playing ? '暂停' : '播放'}</span>`;
    }
    toggle.title = playing ? '暂停播放' : player?.current ? '继续播放' : '开始播放';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.disabled = disabled || (!player?.current && !player?.queue?.length);
    const previous = node.querySelector('[data-status-action="previous"]');
    previous.disabled = disabled || !player?.canPrevious;
    previous.title = player?.canPrevious ? '播放上一首' : player?.historyCount ? '队列已满，先腾出位置再返回上一首' : '还没有播放过的上一首';
    node.querySelector('[data-status-action="skip"]').disabled = disabled || (!player?.current && !player?.queue?.length);
    for (const button of node.querySelectorAll('[data-status-hot]')) button.disabled = disabled || Number(player?.capacity) < 1 || permissions && !permissions.manageSite;
    const slider = node.querySelector('[data-status-volume]');
    slider.disabled = disabled;
    const volume = volumeDrafts.get(id)?.value ?? Math.min(100, seconds(player?.volume));
    slider.value = volume; slider.setAttribute('aria-valuetext', `${volume}%`);
    node.querySelector('[data-status-volume-output]').textContent = `${volume}%`;
    const hint = node.querySelector('[data-status-control-hint]');
    hint.textContent = !allowed ? '公开浏览状态；进入专属房间点歌，DJ 或房主可操作播放。' : unavailable ? '状态暂不可用，更新成功后即可操作。' : !context ? '请先点击下方“控制此机器人”选择频道。' : Number(player.capacity) < 1 ? '队列已满，播放后可继续添加热歌。' : '';
    hint.hidden = !hint.textContent;
    const message = feedback.get(id), box = node.querySelector('.status-feedback');
    box.classList.toggle('error', Boolean(message?.error));
    node.querySelector('[data-status-feedback]').textContent = pending ? message?.pending || '正在处理…' : message?.text || '';
    node.querySelector('[data-status-login]').hidden = pending || !message?.login;
    node.classList.toggle('is-busy', pending);
    node.setAttribute('aria-busy', String(pending));
  }
  function locationText(id, context) {
    if (!context) return { channel: '尚未选择频道', guild: '' };
    const catalog = catalogs.get(id);
    const guild = catalog?.guilds?.find((item) => item.id === context.guildId);
    const channel = guild?.channels?.find((item) => item.id === context.voiceChannelId);
    return { channel: channel?.name || `频道 ${context.voiceChannelId}`, guild: guild?.name || `服务器 ${context.guildId}` };
  }
  function card(bot) {
    const record = records.get(bot.id), player = record?.player;
    const stale = Boolean(listError || record?.error), unavailable = !playerAvailable(bot, player);
    const [gatewayLabel, gatewayTone] = gateway(bot), context = player?.context || bot.context;
    const room = locationText(bot.id, context), song = player?.current;
    const playback = unavailable ? '状态暂不可用' : ({ playing: '正在播放', paused: '已暂停', recovering: '正在恢复', ready: '进度已保留', idle: '空闲待播' })[player.status] || '状态未知';
    const voice = unavailable ? '状态未知' : player.connected ? '已连接' : '未连接';
    const total = seconds(song?.durationMs) / 1000, elapsed = seconds(player?.seconds);
    const note = record?.error ? `${player ? '更新失败，显示上次状态' : '状态读取失败'}：${record.error}` : listError ? '列表更新失败，显示上次状态' : '';
    const catalog = catalogs.get(bot.id);
    return `<article class="status-card${stale ? ' is-stale' : ''}" data-status-bot="${escape(bot.id)}" data-playback-status="${escape(unavailable ? 'unavailable' : player.status)}">
      <div class="status-card-heading"><span class="bot-avatar">${icon('bot')}</span><div><h2>${escape(bot.name || bot.username || '音乐机器人')}</h2><span>${bot.managed === false ? '默认机器人' : '独立音乐房'}</span></div><span class="status-pill ${gatewayTone}"><b></b>${escape(gatewayLabel)}</span></div>
      <div class="status-connections"><span>${icon('activity')}机器人连接 <strong>${escape(gatewayLabel)}</strong></span><span>${icon('radio-tower')}语音连接 <strong>${voice}</strong></span></div>
      <div class="status-room"><span class="status-caption">${!unavailable && player.connected ? '所在频道' : '已选频道'}</span><strong>${icon('radio')}${escape(room.channel)}</strong>${room.guild ? `<span>${escape(room.guild)}</span>` : ''}</div>
      <div class="status-track"><div class="status-track-heading"><span class="status-playback${player?.status === 'playing' ? ' playing' : ''}">${icon(player?.status === 'playing' ? 'audio-lines' : player?.status === 'paused' ? 'pause' : 'music-2')}${playback}</span>${song ? `<span class="source-badge ${song.source === 'qq' ? 'qq' : 'netease'}">${song.source === 'qq' ? 'QQ音乐' : '网易云'}</span>` : ''}</div><h3>${escape(song?.name || (unavailable ? '暂时无法读取歌曲' : '等待下一首好歌'))}</h3><p>${escape(song?.artists || (unavailable ? '稍后会自动重试' : '可以前往控制台点歌'))}</p>${song ? `<div class="status-progress"><progress value="${Math.min(elapsed, Math.max(1, total))}" max="${Math.max(1, total)}" aria-label="${escape(song.name)}播放进度"></progress><span>${duration(elapsed)} / ${duration(total)}</span></div>` : '<div class="status-track-placeholder"></div>'}</div>
      <dl class="status-facts"><div><dt>待播队列</dt><dd>${unavailable ? '—' : `${Array.isArray(player.queue) ? player.queue.length : 0} 首`}</dd></div><div><dt>音量</dt><dd>${unavailable ? '—' : `${Math.min(100, seconds(player.volume))}%`}</dd></div><div><dt>频道常驻</dt><dd>${unavailable ? '—' : player.stayConnected ? '已开启' : '未开启'}</dd></div></dl>
      ${controls(bot.id)}
      <div class="status-card-notes">${note ? `<p class="status-card-note error">${escape(note)}</p>` : ''}${bot.error ? `<p class="status-card-note error">${escape(bot.error)}</p>` : ''}${player?.recoveryError && player.recoveryError !== bot.error ? `<p class="status-card-note error">${escape(player.recoveryError)}</p>` : ''}${context && catalog?.error ? '<p class="status-card-note">频道名称暂时无法更新，保留已知名称或 ID。</p>' : ''}</div>
      <div class="status-card-footer"><span>${record?.updatedAt ? `${stale ? '上次状态' : '更新于'} ${time(record.updatedAt)}` : record?.error ? '等待重试' : '正在读取状态'}</span><button class="secondary" data-control-bot="${escape(bot.id)}">控制此机器人${icon('arrow-right')}</button></div>
    </article>`;
  }
  function render() {
    if (!active) return;
    const fresh = bots.filter((bot) => { const record = records.get(bot.id); return record && !record.error && playerAvailable(bot, record.player); });
    const incomplete = fresh.length < bots.length;
    $('status-total').textContent = listLoaded ? bots.length : '—';
    $('status-online').textContent = listLoaded ? bots.filter((bot) => gateway(bot)[1] === 'online').length : '—';
    for (const [id, predicate] of [['status-connected', (player) => player.connected], ['status-playing', (player) => player.status === 'playing']]) {
      const value = fresh.filter((bot) => predicate(records.get(bot.id).player)).length;
      $(id).textContent = !listLoaded || (incomplete && !fresh.length) ? '—' : `${value}${incomplete ? '+' : ''}`;
    }
    $('status-updated').textContent = listError ? '刷新失败 · 当前为上次读取的数据' : inFlight ? '正在更新机器人状态…' : updatedAt ? `最近更新 ${time(updatedAt)} · 每 5 秒自动刷新${incomplete ? ' · 部分状态暂不可用' : ''}` : '正在读取机器人状态…';
    $('status-page-error').hidden = !listError;
    $('status-page-error').textContent = listError ? `暂时无法更新机器人列表：${listError}。可点击刷新重试。` : '';
    $('refresh-bot-status').disabled = inFlight;
    $('bot-status-grid').setAttribute('aria-busy', String(inFlight));
    const grid = $('bot-status-grid'), ids = new Set(bots.map((bot) => bot.id));
    for (const node of [...grid.children]) if (!ids.has(node.dataset.statusBot)) node.remove();
    if (!bots.length) grid.innerHTML = `<div class="empty-state">${icon('bot')}<strong>${listLoaded ? '还没有机器人' : listError ? '暂时无法读取机器人' : '正在读取机器人…'}</strong>${listLoaded ? '<span>在机器人管理中添加你的音乐机器人。</span>' : ''}</div>`;
    for (const [index, bot] of bots.entries()) {
      const template = document.createElement('template'); template.innerHTML = card(bot);
      const next = template.content.firstElementChild;
      let node = grid.querySelector(`[data-status-bot="${CSS.escape(bot.id)}"]`);
      if (!node) { node = next; grid.insertBefore(node, grid.children[index] || null); }
      else {
        node.className = next.className; node.dataset.playbackStatus = next.dataset.playbackStatus;
        // Keep controls and their focused slider/button nodes across every poll.
        for (const part of next.children) {
          const name = part.classList[0];
          if (name === 'status-controls') continue;
          const current = node.querySelector(`:scope > .${name}`);
          if (name === 'status-card-footer') current.firstElementChild.textContent = part.firstElementChild.textContent;
          else if (partMarkup.get(current) !== part.innerHTML) { current.innerHTML = part.innerHTML; partMarkup.set(current, part.innerHTML); }
        }
        if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
      }
      updateControls(node, bot);
    }
    drawIcons();
  }
  async function loadCatalog(bot, player) {
    const context = player?.context || bot.context;
    if (!active || !context || !['ready', undefined].includes(bot.status) || player?.disabled) return;
    const signature = JSON.stringify([bot.guildIds, context.guildId, context.voiceChannelId]);
    const cached = catalogs.get(bot.id);
    if (cached?.signature === signature && cached.expires > Date.now()) return;
    // At most one directory request per bot, including across page visits.
    // If the room changes during a request, its latest signature is checked below.
    if (pendingCatalogs.has(bot.id)) return;
    const pending = { signature };
    pendingCatalogs.set(bot.id, pending);
    try {
      const result = await api(`/catalog?${new URLSearchParams({ botId: bot.id })}`);
      if (!bots.some((item) => item.id === bot.id)) return;
      catalogs.set(bot.id, { signature, guilds: Array.isArray(result.guilds) ? result.guilds : [], expires: Date.now() + 300000 });
    } catch {
      if (!bots.some((item) => item.id === bot.id)) return;
      catalogs.set(bot.id, { ...cached, signature, error: true, expires: Date.now() + 30000 });
    } finally {
      if (pendingCatalogs.get(bot.id) === pending) pendingCatalogs.delete(bot.id);
      if (active) {
        // Names are reusable after leaving and returning, but only the current
        // visible page is rendered; playback polling never waits for this work.
        render();
        const currentBot = bots.find((item) => item.id === bot.id);
        if (currentBot) void loadCatalog(currentBot, records.get(bot.id)?.player);
      }
    }
  }
  async function loadState(id, { epoch = generation, mutation = false } = {}) {
    if (busy.has(id) && !mutation) return null;
    const revision = revisions.get(id) || 0, request = (reads.get(id) || 0) + 1;
    reads.set(id, request);
    const current = () => (mutation || valid(epoch)) && bots.some((bot) => bot.id === id) &&
      reads.get(id) === request && (revisions.get(id) || 0) === revision;
    try {
      const result = await api(`/state?${new URLSearchParams({ botId: id })}`);
      if (!current()) return null;
      if (!result.player || (result.botId && result.botId !== id)) throw new Error('服务器返回了无效的机器人状态');
      records.set(id, { player: result.player, permissions: result.permissions, updatedAt: Date.now(), error: '' });
      render();
      void loadCatalog(bots.find((bot) => bot.id === id), result.player);
      return result;
    } catch (error) {
      if (current()) { records.set(id, { ...records.get(id), error: error.message || '网络连接失败' }); render(); }
      throw error;
    }
  }
  async function mutate(id, { action, value, source }) {
    if (!active || busy.has(id) || !actionable(id)) return;
    const permission = records.get(id)?.permissions;
    if (permission && !(source ? permission.manageSite : permission.control)) return;
    const player = records.get(id).player;
    if (!player.context) return;
    busy.add(id); revisions.set(id, (revisions.get(id) || 0) + 1);
    feedback.set(id, { pending: source ? `正在加入${source === 'qq' ? 'QQ音乐' : '网易云'}热歌…` : action === 'volume' ? `正在设置音量 ${value}%…` : '正在处理播放操作…' });
    render();
    let attempted = false;
    try {
      if (source === 'qq') {
        const account = await api('/account?source=qq');
        if (!account.loggedIn) {
          feedback.set(id, { text: 'QQ音乐尚未登录或登录已失效，请登录后再加入热歌。', error: true, login: true });
          return;
        }
      }
      attempted = true;
      const result = source ? await api('/hot', { botId: id, source, full: true }) : await api('/control', { botId: id, action, ...(value === undefined ? {} : { value }) });
      const message = source ? (Number.isInteger(result.added) ? `${source === 'qq' ? 'QQ音乐' : '网易云'}热歌已加入 ${result.added} 首。` : result.notice || '热歌已加入队列。') :
        ({ previous: '已切换上一首。', skip: '已切换下一首。', pause: '已暂停，进度已保留。', resume: '已请求继续播放。', volume: `音量已设置为 ${value}%。` })[action];
      feedback.set(id, { text: message });
    } catch (error) {
      const message = error.message || '操作失败，请稍后重试。';
      feedback.set(id, { text: message, error: true, login: source === 'qq' && /登录|凭证|账号|cookie/i.test(message) });
    } finally {
      if (attempted) {
        // An earlier poll may finish after this mutation; its revision is rejected.
        try { await loadState(id, { mutation: true }); }
        catch { /* The card keeps its last values and disables controls until refreshed. */ }
        try { await onChanged(id); } catch { /* A separate dock refresh must not mask this result. */ }
      }
      busy.delete(id); volumeDrafts.delete(id); render();
    }
  }
  async function refresh() {
    if (!active) return;
    if (inFlight) { rerun = true; return; }
    clearTimeout(timer); inFlight = true; rerun = false;
    const epoch = generation;
    render();
    try {
      const result = await api('/bots');
      if (!valid(epoch)) return;
      if (!Array.isArray(result.bots)) throw new Error('服务器返回了无效的机器人列表');
      bots = result.bots; listLoaded = true; listError = '';
      const ids = new Set(bots.map((bot) => bot.id));
      for (const id of records.keys()) if (!ids.has(id)) records.delete(id);
      for (const id of catalogs.keys()) if (!ids.has(id)) catalogs.delete(id);
      render();
      await Promise.allSettled(bots.map((bot) => loadState(bot.id, { epoch })));
      if (valid(epoch)) updatedAt = Date.now();
    } catch (error) {
      if (valid(epoch)) listError = error.message || '网络连接失败';
    } finally {
      inFlight = false;
      if (active) { render(); schedule(rerun || epoch !== generation ? 0 : 5000); }
    }
  }
  $('refresh-bot-status').onclick = () => { void refresh(); };
  $('status-manage-bots').onclick = onManage;
  const grid = $('bot-status-grid');
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-control-bot]');
    if (button) { void onControl(button.dataset.controlBot); return; }
    const control = event.target.closest('[data-status-action], [data-status-hot], [data-status-login]');
    if (!control || control.disabled) return;
    const id = control.closest('[data-status-bot]')?.dataset.statusBot;
    if (control.hasAttribute('data-status-login')) { onManage(); return; }
    if (id) void mutate(id, { action: control.dataset.statusAction, source: control.dataset.statusHot });
  });
  function draftVolume(input) {
    const id = input.dataset.statusVolume;
    if (input.disabled || busy.has(id) || !active) return null;
    let draft = volumeDrafts.get(id);
    if (!draft) { draft = { value: Number(input.value), dirty: false }; volumeDrafts.set(id, draft); }
    return draft;
  }
  function commitVolume(id) {
    const draft = volumeDrafts.get(id);
    if (!draft || busy.has(id) || draft.pointer !== undefined || draft.keyboard) return;
    if (!draft.dirty || !active || !actionable(id) || Number(records.get(id)?.player.volume) === draft.value) {
      volumeDrafts.delete(id); render(); return;
    }
    void mutate(id, { action: 'volume', value: draft.value });
  }
  grid.addEventListener('pointerdown', (event) => {
    const input = event.target.closest('[data-status-volume]');
    if (!input) return;
    const draft = draftVolume(input); if (draft) draft.pointer = event.pointerId;
  });
  grid.addEventListener('input', (event) => {
    const input = event.target.closest('[data-status-volume]');
    if (!input) return;
    const draft = draftVolume(input); if (!draft) return;
    draft.value = Number(input.value); draft.dirty = true;
    input.setAttribute('aria-valuetext', `${draft.value}%`);
    input.closest('.status-volume').querySelector('output').textContent = `${draft.value}%`;
  });
  grid.addEventListener('change', (event) => {
    const input = event.target.closest('[data-status-volume]'); if (!input) return;
    const draft = draftVolume(input); if (!draft) return;
    draft.value = Number(input.value); draft.dirty = true; commitVolume(input.dataset.statusVolume);
  });
  const volumeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  grid.addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-status-volume]'); if (!input || !volumeKeys.has(event.key)) return;
    const draft = draftVolume(input); if (draft) draft.keyboard = true;
  });
  grid.addEventListener('keyup', (event) => {
    const input = event.target.closest('[data-status-volume]'); if (!input || !volumeKeys.has(event.key)) return;
    const draft = volumeDrafts.get(input.dataset.statusVolume); if (draft) draft.keyboard = false;
    commitVolume(input.dataset.statusVolume);
  });
  grid.addEventListener('focusout', (event) => {
    const input = event.target.closest('[data-status-volume]'); if (!input) return;
    const draft = volumeDrafts.get(input.dataset.statusVolume); if (draft) draft.keyboard = false;
    commitVolume(input.dataset.statusVolume);
  });
  window.addEventListener('pointerup', (event) => {
    for (const [id, draft] of volumeDrafts) if (draft.pointer === event.pointerId) {
      delete draft.pointer;
      // Native ranges may emit change after pointerup; deduplication uses the same draft.
      setTimeout(() => commitVolume(id), 0);
    }
  });
  window.addEventListener('pointercancel', (event) => {
    for (const [id, draft] of volumeDrafts) if (draft.pointer === event.pointerId) volumeDrafts.delete(id);
    render();
  });
  return { setActive };
}
