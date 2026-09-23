const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sources = '<option value="netease">网易云音乐</option><option value="qq">QQ音乐</option>';
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const actions = { hot: '追加热歌并播放', playlist: '追加歌单并播放', pause: '暂停播放', resume: '恢复播放', volume: '调整音量' };
const stamp = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未执行';

export function createRoomSettings({ root, api, getContext, drawIcons, onLockChange }) {
  let active = false, botId = '', generation = 0, saving = false, loading = false, features = null, tab = 'radio', editing = null;
  root.innerHTML = `<div class="feature-heading"><div><h2>每个频道，都有自己的节奏</h2><p id="room-target">设置仅应用于当前机器人。</p></div><button class="secondary" id="room-reload"><i data-lucide="refresh-cw"></i>重新读取</button></div>
    <div class="segmented feature-tabs" role="tablist" aria-label="房间设置"><button data-room-tab="radio" role="tab" aria-selected="true" class="active">自动电台</button><button data-room-tab="schedules" role="tab" aria-selected="false">定时计划</button><button data-room-tab="rules" role="tab" aria-selected="false">点歌规则</button></div>
    <p id="room-feedback" class="feature-note" role="status"></p><div id="room-content"></div>`;
  const content = root.querySelector('#room-content'), feedback = root.querySelector('#room-feedback');
  const field = (name) => root.querySelector(`[name="${name}"]`);
  const number = (name) => Number(field(name).value);
  function targetLabel() { root.querySelector('#room-target').textContent = `当前机器人：${getContext().name} · 设置独立保存`; }
  function setTab(value) {
    if (saving) return;
    tab = value; editing = null;
    root.querySelectorAll('[data-room-tab]').forEach((button) => { button.classList.toggle('active', button.dataset.roomTab === tab); button.setAttribute('aria-selected', String(button.dataset.roomTab === tab)); });
    feedback.textContent = ''; render();
  }
  function render() {
    if (!active) return;
    targetLabel();
    if (loading) { content.innerHTML = '<p class="feature-note">正在读取当前房间设置…</p>'; return; }
    if (!features) { content.innerHTML = '<p class="feature-note">设置暂不可用，请点击重新读取。</p>'; return; }
    if (tab === 'radio') renderRadio();
    else if (tab === 'rules') renderRules();
    else renderSchedules();
    drawIcons();
  }
  function renderRadio() {
    const r = features.radio;
    content.innerHTML = `<form id="radio-form" class="feature-card feature-form"><label class="feature-toggle"><span><strong>自动续播</strong><small>待播歌曲不足时自动补充，暂停后保持暂停。</small></span><input name="enabled" type="checkbox" class="switch" role="switch"></label><div class="feature-form-grid"><label>音乐来源<select name="source">${sources}<option value="mixed">双平台轮流补充</option></select></label><label>选曲方式<select name="strategy"><option value="hot">热歌榜</option><option value="acg">ACG 歌单</option><option value="playlist">指定歌单</option></select></label><label class="full-field" id="radio-playlist-field">歌单链接或 ID<input name="playlistId" maxlength="2000" placeholder="粘贴歌单链接，或填写对应平台歌单 ID"></label><label>待播不超过多少首时补歌<input name="lowWatermark" type="number" min="0" max="20" required></label><label>每次补充数量<input name="batchSize" type="number" min="1" max="50" required></label><label>近期歌曲去重范围<input name="avoidRecent" type="number" min="0" max="200" required></label></div><p class="feature-note">所有补歌受 500 首队列上限限制。去重范围覆盖近期自动补入歌曲与可用的播放历史。QQ 音乐需账号可用；指定歌单支持完整链接或分享短链接。请先为机器人连接语音频道。</p>${r.suspended ? '<p class="feature-error">自动电台暂已挂起；手动恢复播放，或启用后重新保存此设置可继续。</p>' : ''}<p class="feature-note">最近补歌：${escape(stamp(r.lastRunAt))}</p>${r.lastError ? `<p class="feature-error">${escape(r.lastError)}</p>` : ''}<button type="submit" class="primary">保存自动电台</button></form>`;
    for (const name of ['source', 'strategy', 'playlistId', 'lowWatermark', 'batchSize', 'avoidRecent']) field(name).value = r[name] ?? ({ source: 'netease', strategy: 'hot', lowWatermark: 2, batchSize: 10, avoidRecent: 50 }[name] ?? '');
    field('enabled').checked = Boolean(r.enabled);
    const sync = () => { const custom = field('strategy').value === 'playlist'; root.querySelector('#radio-playlist-field').hidden = !custom; field('playlistId').required = custom; if (custom && field('source').value === 'mixed') field('source').value = 'netease'; field('source').querySelector('[value="mixed"]').disabled = custom; };
    field('strategy').onchange = sync; sync();
    root.querySelector('#radio-form').onsubmit = (event) => { event.preventDefault(); void save('radio', { enabled: field('enabled').checked, source: field('source').value, strategy: field('strategy').value, playlistId: field('playlistId').value.trim(), lowWatermark: number('lowWatermark'), batchSize: number('batchSize'), avoidRecent: number('avoidRecent') }); };
  }
  function renderRules() {
    const r = features.rules;
    content.innerHTML = `<form id="rules-form" class="feature-card feature-form"><label class="feature-toggle"><span><strong>启用 KOOK 点歌规则</strong><small>约束频道中的文字指令；网页仍按现有公开控制方式运行。</small></span><input name="enabled" type="checkbox" class="switch" role="switch"></label><div class="feature-form-grid"><label>每人最多同时点多少首<input name="perUserLimit" type="number" min="1" max="500" required></label><label>切歌所需票数<input name="voteThreshold" type="number" min="1" max="100" required></label><label class="full-field">房间管理员 KOOK 用户 ID<input name="managerIds" maxlength="2000" placeholder="多个用户 ID 用逗号分隔"></label></div><label class="feature-check"><input name="preventDuplicates" type="checkbox">阻止重复加入当前歌曲与待播歌曲</label><label class="feature-check"><input name="voteSkip" type="checkbox">普通成员通过 /切歌 投票，管理员可直接切歌</label><p class="feature-note">每人额度包含当前与待播歌曲。开启规则后，暂停、音量、清空等管理指令仅限管理员；投票只统计当前语音频道的成员，实际票数取配置票数与频道真人数中的较小值，同一人每首一票。新歌开始后票数清零。</p><p class="feature-note">当前投票：${Number(features.votes?.count) || 0} / ${Number(features.votes?.required) || r.voteThreshold || 2}</p><button type="submit" class="primary">保存点歌规则</button></form>`;
    ['enabled', 'preventDuplicates', 'voteSkip'].forEach((name) => { field(name).checked = Boolean(r[name]); });
    field('perUserLimit').value = r.perUserLimit ?? 5; field('voteThreshold').value = r.voteThreshold ?? 2; field('managerIds').value = (r.managerIds || []).join(', ');
    root.querySelector('#rules-form').onsubmit = (event) => {
      event.preventDefault(); const ids = field('managerIds').value.split(/[,，\s]+/).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) { feedback.textContent = '管理员 ID 必须为数字，多个 ID 用逗号分隔。'; return; }
      void save('rules', { enabled: field('enabled').checked, perUserLimit: number('perUserLimit'), voteThreshold: number('voteThreshold'), preventDuplicates: field('preventDuplicates').checked, voteSkip: field('voteSkip').checked, managerIds: ids });
    };
  }
  function renderSchedules() {
    const list = features.schedules || [];
    content.innerHTML = `<div class="feature-heading"><p>按指定时区每周执行；计划对当前机器人的已选频道生效。</p><button class="secondary" id="schedule-add" ${list.length >= 20 ? 'disabled' : ''}><i data-lucide="plus"></i>添加计划</button></div><div id="schedule-editor"></div><div class="schedule-list">${list.map((item) => `<article class="feature-card schedule-card"><div><h3>${escape(item.name)} <span class="tag ${item.enabled ? 'mint' : ''}">${item.enabled ? '已启用' : '已停用'}</span></h3><p><strong>${escape(item.time)}</strong> · ${escape(item.timeZone)} · ${item.days?.length === 7 ? '每天' : (item.days || []).map((day) => `周${weekdays[day]}`).join('、')}</p><p>${escape(actions[item.action] || item.action)}${item.action === 'volume' ? ` · ${item.volume}%` : ['hot','playlist'].includes(item.action) ? ` · ${item.source === 'qq' ? 'QQ音乐' : '网易云音乐'}` : ''}</p><p class="feature-note">最近执行：${escape(stamp(item.lastRunAt))}</p>${item.lastError ? `<p class="feature-error">${escape(item.lastError)}</p>` : ''}</div><div class="feature-actions"><button class="secondary" data-schedule-toggle="${escape(item.id)}">${item.enabled ? '停用' : '启用'}</button><button class="quiet-button" data-schedule-edit="${escape(item.id)}">编辑</button><button class="quiet-button danger" data-schedule-delete="${escape(item.id)}">删除</button></div></article>`).join('') || '<div class="empty-state"><strong>还没有定时计划</strong><p>例如每晚 20:00 加入热歌榜，23:00 将音量调低。</p></div>'}</div>`;
    root.querySelector('#schedule-add').onclick = () => { editing = ''; renderScheduleEditor(); };
    if (editing !== null) renderScheduleEditor();
  }
  function renderScheduleEditor() {
    const item = features.schedules.find((entry) => entry.id === editing) || { name: '', enabled: true, days: [0,1,2,3,4,5,6], time: '20:00', timeZone: 'Asia/Shanghai', action: 'hot', source: 'netease', playlistId: '', volume: 30 };
    const host = root.querySelector('#schedule-editor');
    host.innerHTML = `<form id="schedule-form" class="feature-card feature-form"><h3>${editing ? '编辑计划' : '新建计划'}</h3><div class="feature-form-grid"><label>计划名称<input name="name" maxlength="60" placeholder="例如：晚间电台" required></label><label>执行时间<input name="time" type="time" required></label><label>时区<input name="timeZone" list="time-zone-options" required><datalist id="time-zone-options"><option value="Asia/Shanghai">北京时间</option><option value="America/Caracas">委内瑞拉时间</option><option value="UTC">世界协调时</option></datalist></label><label>执行操作<select name="action">${Object.entries(actions).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label id="schedule-source">音乐来源<select name="source">${sources}</select></label><label id="schedule-volume">音量百分比<input name="volume" type="number" min="0" max="100"></label><label id="schedule-playlist" class="full-field">歌单链接或 ID<input name="playlistId" maxlength="2000"></label></div><fieldset class="weekdays"><legend>重复日期</legend>${weekdays.map((day,index) => `<label><input type="checkbox" name="day" value="${index}" ${item.days.includes(index) ? 'checked' : ''}><span>周${day}</span></label>`).join('')}</fieldset><label class="feature-check"><input name="enabled" type="checkbox" ${item.enabled ? 'checked' : ''}>保存后启用</label><p class="feature-note">Asia/Shanghai 是北京时间。也可输入有效的 IANA 时区名称。歌单或热歌追加到队尾并恢复播放，保留原队列顺序；暂停与恢复按已有进度执行。</p><div class="feature-actions"><button class="primary" type="submit">保存计划</button><button class="secondary" type="button" id="schedule-cancel">取消</button></div></form>`;
    for (const name of ['name','time','timeZone','action','source','playlistId','volume']) field(name).value = item[name] ?? '';
    const sync = () => { const action = field('action').value; root.querySelector('#schedule-source').hidden = !['hot','playlist'].includes(action); root.querySelector('#schedule-volume').hidden = action !== 'volume'; root.querySelector('#schedule-playlist').hidden = action !== 'playlist'; field('playlistId').required = action === 'playlist'; };
    field('action').onchange = sync; sync();
    root.querySelector('#schedule-cancel').onclick = () => { editing = null; host.innerHTML = ''; };
    root.querySelector('#schedule-form').onsubmit = (event) => {
      event.preventDefault(); const days = [...root.querySelectorAll('[name="day"]:checked')].map((el) => Number(el.value));
      if (!days.length) { feedback.textContent = '请至少选择一天。'; return; }
      const timeZone = field('timeZone').value.trim();
      try { new Intl.DateTimeFormat('zh-CN', { timeZone }).format(); } catch { feedback.textContent = '时区无效，可使用 Asia/Shanghai（北京时间）。'; return; }
      const draft = { id: editing || crypto.randomUUID(), name: field('name').value.trim(), enabled: field('enabled').checked, days, time: field('time').value, timeZone, action: field('action').value, source: field('source').value, playlistId: field('playlistId').value.trim(), volume: number('volume') };
      const next = features.schedules.map(cleanSchedule); const index = next.findIndex((entry) => entry.id === editing);
      if (index < 0) next.push(draft); else next[index] = draft;
      void save('schedules', next);
    };
  }
  function cleanSchedule(item) { const { id, name, enabled, days, time, timeZone, action, source, playlistId, volume } = item; return { id, name, enabled, days, time, timeZone, action, source, playlistId, volume }; }
  async function save(section, value) {
    const context = getContext();
    if (saving || loading || !features || botId !== context.id || !context.available) { feedback.textContent = '机器人状态已变化，请重新读取后再保存。'; return; }
    const captured = botId, epoch = generation; saving = true; let saved = false; onLockChange();
    const controls = [...root.querySelectorAll('input, select, button')].map((el) => [el, el.disabled]);
    feedback.textContent = '正在保存…'; controls.forEach(([el]) => { el.disabled = true; });
    try {
      const result = await api('/features', { botId: captured, section, value });
      if (captured !== getContext().id || epoch !== generation) return;
      features = result.features; editing = null; saved = true; feedback.textContent = '已保存，仅应用于当前机器人。';
    } catch (error) { if (captured === getContext().id && epoch === generation) feedback.textContent = `保存失败：${error.message}。请检查后重试。`; }
    finally { saving = false; onLockChange(); if (epoch === generation) { controls.forEach(([el, disabled]) => { if (el.isConnected) el.disabled = disabled; }); if (saved) render(); } }
  }
  async function load() {
    if (!active || saving) return;
    const context = getContext(), epoch = ++generation; botId = context.id; loading = true; features = null; editing = null; feedback.textContent = ''; render();
    try {
      const result = await api(`/features?${new URLSearchParams({ botId })}`);
      if (epoch !== generation || botId !== getContext().id) return;
      features = result.features;
    } catch (error) { if (epoch === generation) feedback.textContent = error.message || '设置读取失败。'; }
    finally { if (epoch === generation) { loading = false; render(); } }
  }
  root.querySelector('#room-reload').onclick = () => void load();
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button || button.disabled || saving) return;
    if (button.dataset.roomTab) setTab(button.dataset.roomTab);
    if (button.dataset.scheduleEdit) { editing = button.dataset.scheduleEdit; renderScheduleEditor(); }
    if (button.dataset.scheduleToggle) void save('schedules', features.schedules.map((entry) => ({ ...cleanSchedule(entry), enabled: entry.id === button.dataset.scheduleToggle ? !entry.enabled : entry.enabled })));
    if (button.dataset.scheduleDelete) { const id = button.dataset.scheduleDelete; if (window.confirm('删除这条定时计划？')) void save('schedules', features.schedules.filter((entry) => entry.id !== id).map(cleanSchedule)); }
  });
  return { isWorking: () => saving, targetChanged() { if (active) void load(); }, setActive(value) { if (active === value) return; active = value; if (value) void load(); else { generation++; loading = false; } } };
}
