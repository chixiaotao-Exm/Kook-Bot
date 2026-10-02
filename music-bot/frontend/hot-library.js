const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const integer = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const stamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
};
const duration = (ms) => { const seconds = integer(Number(ms) / 1000); return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''; };
const aiStates = {
  pending: '等待智能筛选，当前按规则推荐', running: '智能筛选中，未审阅歌曲按规则推荐',
  ready: '本轮智能筛选完成', partial: '部分歌曲已筛选，其余按规则推荐',
  fallback: '本轮未完整审阅，沿用已有有效结果与规则推荐', disabled: '智能筛选未启用，按规则推荐',
};
const aiDecisions = { prefer: 'AI 优先推荐', keep: 'AI 已审阅', downrank: 'AI 降低推荐', exclude: 'AI 排除' };
const aiVersions = { original: '原版倾向', cover: '翻唱倾向', dj: 'DJ 版本倾向', live: '现场版倾向', instrumental: '纯音乐倾向' };
const aiTrends = { rising: '热度上升倾向', steady: '热度稳定倾向', revival: '再次走热倾向' };
function aiSummary(ai) {
  if (!ai) return '';
  const enabled = ai.enabled === true, status = enabled ? ai.status : 'disabled';
  return `<div class="hot-library-ai${status === 'fallback' ? ' is-fallback' : ''}" role="status"><div class="hot-library-ai-heading"><strong>智能筛选</strong>${enabled && ai.model ? `<span>${escape(ai.model)}</span>` : ''}</div><p>${escape(aiStates[status] || '筛选状态暂不可确认，未审阅歌曲按规则推荐')}</p>${enabled ? `<div class="hot-library-ai-meta"><span>已审阅 ${integer(ai.reviewed)} 首</span><span>规则推荐 ${integer(ai.ruleOnly)} 首</span><span>AI 排除 ${integer(ai.excluded)} 首</span></div><div class="hot-library-ai-time">最近审核成功（北京时间） ${stamp(ai.lastSuccessAt)}</div>` : ''}${ai.lastError ? `<p class="hot-library-ai-error">${escape(ai.lastError)}</p>` : ''}</div>`;
}
function aiTrack(track, summary) {
  if (!summary) return '';
  const ai = track.ai;
  const age = Date.now() - Number(ai?.reviewedAt);
  if (!ai || !Object.hasOwn(aiDecisions, ai.decision) || !ai.reviewedAt || !Number.isFinite(age) || age < 0 || age > 7 * 86400000 || summary.enabled !== true) return '<div class="hot-library-ai-track"><span class="hot-library-ai-tag is-rule">规则推荐</span></div>';
  const confident = Number.isFinite(ai.confidence) && ai.confidence >= .65;
  const labels = confident ? [aiDecisions[ai.decision], Object.hasOwn(aiVersions, ai.version) && aiVersions[ai.version], Object.hasOwn(aiTrends, ai.trend) && aiTrends[ai.trend]].filter(Boolean) : ['信息不足 · 规则推荐'];
  return `<div class="hot-library-ai-track"><div class="hot-library-ai-tags">${labels.map((label, index) => `<span class="hot-library-ai-tag${!confident ? ' is-rule' : index === 0 && ai.decision === 'prefer' ? ' is-preferred' : ''}">${escape(label)}</span>`).join('')}</div>${ai.reason ? `<p>${escape(String(ai.reason).slice(0, 100))}</p>` : ''}</div>`;
}

export function createHotLibrary({ root, api, drawIcons }) {
  let active = false, generation = 0, loading = false, data = null, error = '', requestedOffset = 0;
  const limit = 50;
  function render() {
    if (!active) return;
    const counts = data?.counts || {}, offset = integer(data?.offset), total = integer(data?.total);
    const rows = data?.enabled ? data.tracks : [];
    const available = data?.enabled === true;
    root.setAttribute('aria-busy', String(loading));
    root.innerHTML = `<div class="hot-library-heading"><div><h3>抖音热歌库</h3><p>${data?.collecting ? '正在采集，当前展示已保存的歌曲。' : available ? '综合热门歌单重现频率与多个来源排序' : '汽水音乐热门歌曲'}</p></div><button type="button" class="secondary" data-library-refresh ${loading ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>${loading ? '读取中' : '刷新显示'}</button></div>
      ${error ? `<p class="feature-error" role="alert">${escape(error)}${data ? '；以下为上次读取的数据。' : ''}</p>` : ''}
      ${data?.lastError ? `<p class="feature-error" role="status">最近采集异常：${escape(data.lastError)}${available ? '；保留已入库歌曲。' : ''}</p>` : ''}
      ${!data ? `<p class="feature-note">${loading ? '正在读取热歌库…' : '热歌库暂时无法读取，请重试。'}</p>` : !available ? '<p class="feature-note">热歌库尚未启用。</p>' : `
      <dl class="hot-library-counts">${[['活跃', counts.active], ['库内总数', counts.total], ['已停用', counts.archived], ['已屏蔽', counts.blocked]].map(([label, value]) => `<div><dt>${label}</dt><dd>${integer(value)}</dd></div>`).join('')}</dl>
      ${aiSummary(data.ai)}
      <div class="hot-library-timing"><span>上次成功 <strong>${stamp(data.lastSuccessAt)}</strong></span><span>下次采集 <strong>${stamp(data.nextRunAt)}</strong></span><span>北京时间 ${(data.times || ['09:00', '21:00']).map(escape).join(' / ')}</span></div>
      <p class="feature-note hot-library-policy">${integer(data.policy?.archiveDays || 14)} 天未在采集歌单再次出现停用，${integer(data.policy?.deleteDays || 45)} 天清理。</p>
      <div class="hot-library-columns" aria-hidden="true"><span>歌曲</span><span>推荐分</span><span>来源数</span><span>最近收录 · 北京时间</span></div>
      <ol class="hot-library-tracks" start="${offset + 1}">${rows.map((track, index) => `<li class="hot-library-track"><div class="hot-library-song"><span class="hot-library-rank">${offset + index + 1}</span><div><strong>${escape(track.name || '未命名歌曲')}</strong><span>${escape([track.artists, duration(track.durationMs)].filter(Boolean).join(' · '))}</span>${aiTrack(track, data.ai)}</div></div><span class="hot-library-metric"><small>推荐分</small>${integer(track.score)}</span><span class="hot-library-metric"><small>来源</small>${integer(track.sourceCount)}</span><span class="hot-library-seen"><small>最近收录</small>${stamp(track.lastSeenAt)}</span></li>`).join('')}</ol>
      ${rows.length ? '' : `<p class="feature-note hot-library-empty">${data.lastSuccessAt ? '暂无活跃热歌。' : '等待首次采集。'}</p>`}
      <div class="hot-library-pager"><span>${rows.length ? `${offset + 1}–${offset + rows.length}` : '0'} / ${total} 首</span><div><button type="button" class="secondary" data-library-page="${Math.max(0, offset - limit)}" ${loading || offset === 0 ? 'disabled' : ''}>上一页</button><button type="button" class="secondary" data-library-page="${offset + limit}" ${loading || !data.hasMore || offset + limit > 5000 ? 'disabled' : ''}>下一页</button></div></div>`}`;
    drawIcons();
  }
  async function load(offset = 0) {
    if (!active || loading) return;
    const request = ++generation;
    requestedOffset = offset; loading = true; error = ''; render();
    try {
      const result = await api(`/hot-library?${new URLSearchParams({ offset, limit })}`);
      if (!active || request !== generation) return;
      if (typeof result?.enabled !== 'boolean' || result.enabled && !Array.isArray(result.tracks)) throw new Error('热歌库返回的数据格式不正确');
      data = result;
    } catch (failure) {
      if (!active || request !== generation) return;
      error = `读取失败：${failure.message || '网络连接异常，请稍后重试'}`;
    } finally {
      if (active && request === generation) { loading = false; render(); }
    }
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-library-refresh], [data-library-page]');
    if (!button || !root.contains(button) || button.disabled) return;
    void load(button.hasAttribute('data-library-page') ? integer(button.dataset.libraryPage) : error ? requestedOffset : integer(data?.offset));
  });
  return { setActive(value) {
    root.hidden = !value;
    if (active === value) return;
    active = value;
    if (value) { render(); void load(integer(data?.offset)); }
    else { generation++; loading = false; }
  } };
}
