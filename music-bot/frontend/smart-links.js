const sourceNames = { netease: '网易云音乐', qq: 'QQ音乐' };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<i data-lucide="${name}"></i>`;
const linkLike = (value) => /https?:\/\/|(?:music\.163\.com|y\.qq\.com|c\.y\.qq\.com|163cn\.tv|163cn\.cn|url\.cn|qqmusic\.qq\.com)\//i.test(value);
function effectiveSource(record) {
  if (record?.data?.source) return record.data.source;
  const raw = record?.raw || '';
  const link = raw.match(/https?:\/\/[^\s<>"“”]+/i)?.[0];
  if (link) {
    try {
      const host = new URL(link).hostname;
      if (['music.163.com', 'y.music.163.com'].includes(host)) return 'netease';
      if (['y.qq.com', 'i.y.qq.com'].includes(host)) return 'qq';
    } catch { /* Invalid links must not inherit the manually selected source. */ }
    return null;
  }
  return linkLike(raw) ? null : record?.manualSource;
}

/** Read-only link previews remain separate from the explicit queue mutation. */
export function createSmartLinks({ input, container, api, getContext, drawIcons, onSearch, onShow,
  onAdd, onAccountCheck, onLogin, onChannel, onLockChange, isLocked }) {
  let generation = 0, timer, record = null, phase = '', error = '', feedback = '', hint = '', rendered = '';
  let active = true, working = false;

  function target() {
    const context = getContext();
    return { ...context, capacity: Math.max(0, Number(context.capacity) || 0) };
  }
  function current(recordToCheck = record) {
    return Boolean(recordToCheck && record === recordToCheck && recordToCheck.botId === target().botId && recordToCheck.raw === input.value.trim());
  }
  function lock(value) { working = value; onLockChange(); render(); }
  function image(src) {
    try { const parsed = new URL(src); return ['https:', 'http:'].includes(parsed.protocol) ? `<img src="${escape(parsed.href)}" alt="" referrerpolicy="no-referrer">` : ''; } catch { return ''; }
  }
  function render() {
    container.hidden = !active || !phase;
    container.setAttribute('aria-busy', String(phase === 'loading' || working));
    if (!phase) { rendered = ''; container.innerHTML = ''; return; }
    const context = target(), data = record?.data, total = data?.kind === 'playlist' ? Math.max(0, Number(data.total) || 0) : 1;
    const amount = Math.min(total, context.capacity), item = data?.track || data?.playlist;
    container.dataset.smartKind = data?.kind || '';
    container.dataset.smartSource = data?.source || '';
    container.dataset.smartBot = record?.botId || '';
    let body;
    if (phase === 'loading') {
      body = `<div class="smart-message">${icon('loader-circle')}<div><strong>正在识别音乐链接</strong><p>读取平台与曲目，准备加入预览…</p></div></div>`;
    } else if (phase === 'error') {
      const source = effectiveSource(record);
      const needsQQLogin = /登录|login|credential|账号.*(?:失效|过期)/i.test(error) && (source === 'qq' || source !== 'netease' && /QQ\s*音乐/i.test(error));
      body = `<div class="smart-message is-error">${icon('music-2')}<div><strong>暂时无法读取</strong><p id="smart-link-feedback" role="status">${escape(error)}</p><div class="smart-error-actions"><button id="smart-link-retry" class="secondary" type="button" ${isLocked() ? 'disabled' : ''}>${icon('refresh-cw')}重试</button>${needsQQLogin ? '<button id="smart-link-login" class="quiet-button" type="button">登录 QQ 音乐</button>' : ''}</div></div></div>`;
    } else if (data) {
      const isPlaylist = data.kind === 'playlist', linked = data.isLink;
      const sourceLabel = sourceNames[data.source] || sourceNames.netease;
      const tracks = Array.isArray(data.tracks) ? data.tracks.slice(0, 5) : [];
      const available = current() && context.available && !isLocked() && !working;
      const success = phase === 'success';
      const detail = isPlaylist ? `${total} 首歌曲${item?.creator ? ` · ${item.creator}` : ''}` : [item?.artists, item?.album].filter(Boolean).join(' · ');
      const capacityNote = context.restrictedReason || (!context.available ? '正在等待机器人就绪' : !context.hasChannel ? '请先选择语音频道，再加入音乐' : !context.capacity ? `队列已满（${context.maxQueue} 首），请先腾出位置` : !total ? '这张歌单暂无可加入的歌曲' : isPlaylist && amount < total ? `歌单共 ${total} 首，当前可加入 ${amount} 首` : `队列还可加入 ${context.capacity} 首`);
      body = `<div class="smart-preview-heading"><span class="smart-eyebrow">${icon('sparkles')}添加预览</span><span class="smart-source-note">${linked ? '链接已自动选择' : '使用手动选择的平台'} <span class="source-badge ${escape(data.source)}">${escape(sourceLabel)}</span></span></div>
        <div class="smart-item"><div class="smart-cover">${icon(isPlaylist ? 'list-music' : 'music-2')}${item?.cover ? image(item.cover) : ''}</div><div class="smart-item-info"><span class="smart-kind">${isPlaylist ? '歌单' : '歌曲'}</span><h2>${escape(item?.name || (isPlaylist ? '音乐歌单' : '音乐歌曲'))}</h2><p>${escape(detail)}</p></div></div>
        ${isPlaylist && tracks.length ? `<div class="smart-sample"><span>歌单曲目预览</span><ol>${tracks.map((track) => `<li><strong>${escape(track.name)}</strong><span>${escape(track.artists)}</span></li>`).join('')}</ol>${total > tracks.length ? `<p>还有 ${total - tracks.length} 首，按歌单顺序加入</p>` : ''}</div>` : ''}
        <div class="smart-destination"><span>${icon('bot')}<strong>${escape(context.botName)}</strong></span><span>${icon('radio')}<strong>${escape(context.channelName || '尚未选择频道')}</strong></span><p id="smart-link-capacity">${escape(capacityNote)}</p></div>
        <div class="smart-submit-row"><p id="smart-link-feedback" class="${error ? 'is-error' : ''}" role="status">${escape(feedback || error || '点击下方按钮后加入，不会打断当前播放。')}</p><div>${success ? '<button id="smart-link-continue" type="button" class="secondary">继续添加</button>' : phase === 'uncertain' || phase === 'review' ? `<button id="smart-link-retry" type="button" class="secondary" ${available ? '' : 'disabled'}>${icon('refresh-cw')}${phase === 'uncertain' ? '检查后重新预览' : '重新预览'}</button>` : !context.hasChannel && context.available ? `<button id="smart-link-channel" type="button" class="primary" ${available ? '' : 'disabled'}>${icon('radio')}选择语音频道</button>` : `<button id="smart-link-add" type="button" class="primary" ${available && amount > 0 ? '' : 'disabled'}>${icon(working ? 'loader-circle' : 'list-plus')}${working ? phase === 'submitting' ? '正在加入…' : '检查登录状态…' : isPlaylist ? `加入 ${amount} 首` : '加入队列'}</button>`}</div></div>`;
    } else body = '';
    if (body !== rendered) { rendered = body; container.innerHTML = body; drawIcons(); }
  }
  function clear({ clearInput = false } = {}) {
    generation++; clearTimeout(timer); record = null; phase = ''; error = ''; feedback = ''; hint = '';
    if (clearInput) input.value = '';
    render();
  }
  async function resolve({ show = true } = {}) {
    if (working) return;
    const raw = input.value.trim();
    if (!raw) { clear(); return; }
    const context = target(), request = ++generation;
    if (context.jointSearch && /^\d+$/.test(raw)) { phase = 'error'; error = '纯数字 ID 请先选择 QQ 音乐或网易云音乐。'; record = { raw, botId: context.botId }; onShow(); render(); return; }
    clearTimeout(timer); phase = 'loading'; error = ''; feedback = '';
    record = { raw, botId: context.botId, manualSource: context.source, hint };
    const captured = record;
    if (show) onShow(); render();
    try {
      const data = await api(`/resolve?${new URLSearchParams({ input: raw, source: context.source, ...(hint ? { kind: hint } : {}) })}`);
      if (request !== generation || !current(captured)) return;
      if (data.kind === 'search') { clear(); onSearch(raw); return; }
      if (!['song', 'playlist'].includes(data.kind) || !['netease', 'qq'].includes(data.source)) throw new Error('暂时无法识别这条音乐链接。');
      captured.data = data; phase = 'ready'; render();
    } catch (caught) {
      if (request !== generation || !current(captured)) return;
      error = caught.message || '网络暂时不可用，请稍后重试。'; phase = 'error'; render();
    }
  }
  function changed() {
    if (working) return;
    clear();
    if (linkLike(input.value.trim())) {
      phase = 'loading'; render(); timer = setTimeout(() => { void resolve(); }, 500);
    }
  }
  function submit() {
    if (working || isLocked()) return;
    const raw = input.value.trim();
    if (!raw) return;
    if (linkLike(raw) || /^\d+$/.test(raw) || hint) { if (phase !== 'success') void resolve(); return; }
    clear(); onSearch(raw);
  }
  async function login() {
    if (working || isLocked()) return;
    const captured = record;
    try {
      await onLogin(() => {
        if (current(captured)) { onShow(); void resolve(); }
      });
    } catch (caught) { error = caught.message || '暂时无法登录 QQ 音乐。'; render(); }
  }
  async function add() {
    if (working || isLocked() || phase !== 'ready' || !current() || !record.data) return;
    const captured = record;
    const expectedVoiceChannelId = target().voiceChannelId;
    const requestedAmount = captured.data.kind === 'playlist' ? Math.min(Math.max(0, Number(captured.data.total) || 0), target().capacity) : 1;
    if (!target().hasChannel) { onChannel(); return; }
    if (!target().available || target().capacity < 1) { render(); return; }
    let submitted = false;
    const checkChannel = () => { if (!expectedVoiceChannelId || target().voiceChannelId !== expectedVoiceChannelId) throw new Error('机器人频道已变化，请重新预览后再加入。'); };
    error = ''; feedback = ''; lock(true);
    try {
      if (captured.data.source === 'qq') {
        const account = await onAccountCheck('qq');
        if (!current(captured)) return;
        checkChannel();
        if (!account?.loggedIn) {
          feedback = 'QQ 音乐需要先扫码登录。登录后返回这里，再点击加入。';
          lock(false); await login(); return;
        }
      }
      if (!current(captured)) return;
      checkChannel();
      const context = target();
      if (!context.available || !context.hasChannel || context.capacity < 1) { render(); return; }
      const amount = Math.min(requestedAmount, context.capacity);
      if (!amount) return;
      phase = 'submitting'; render();
      submitted = true;
      const result = await onAdd({ ...captured.data, botId: captured.botId, expectedVoiceChannelId }, amount);
      if (!current(captured)) return;
      const added = Number.isInteger(result?.added) ? result.added : captured.data.kind === 'song' ? 1 : 0;
      phase = 'success'; feedback = `已为 ${context.botName} 加入 ${added} 首${captured.data.kind === 'playlist' && added < amount ? '，部分歌曲暂不可用' : ''}`;
    } catch (caught) {
      if (current(captured)) {
        const uncertain = submitted && (!Number.isInteger(caught.status) || caught.status >= 500);
        phase = /频道已变化/.test(caught.message) ? 'review' : uncertain ? 'uncertain' : 'ready';
        error = phase === 'uncertain' ? `未能确认本次加入结果。请先检查 ${target().botName} 的队列再重试，避免重复加入。` : caught.message || '加入失败，请稍后重试。';
      }
    } finally { lock(false); }
  }
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'smart-link-add') void add();
    if (button.id === 'smart-link-retry') void resolve();
    if (button.id === 'smart-link-login') void login();
    if (button.id === 'smart-link-channel') onChannel();
    if (button.id === 'smart-link-continue') { clear({ clearInput: true }); input.focus(); }
  });
  input.addEventListener('input', changed);
  return {
    submit, render, isWorking: () => working,
    setActive(value) { active = value; render(); },
    sourceChanged() { if (phase && phase !== 'success') void resolve({ show: false }); },
    targetChanged() { if (phase) void resolve({ show: false }); },
    acceptImport(value) { if (working) return; input.value = value; hint = 'playlist'; void resolve(); },
  };
}
