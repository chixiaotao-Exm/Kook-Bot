const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const integer = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const stamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
};
const duration = (ms) => { const seconds = integer(Number(ms) / 1000); return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''; };

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
      <div class="hot-library-timing"><span>上次成功 <strong>${stamp(data.lastSuccessAt)}</strong></span><span>下次采集 <strong>${stamp(data.nextRunAt)}</strong></span><span>北京时间 ${(data.times || ['09:00', '21:00']).map(escape).join(' / ')}</span></div>
      <p class="feature-note hot-library-policy">${integer(data.policy?.archiveDays || 14)} 天未在采集歌单再次出现停用，${integer(data.policy?.deleteDays || 45)} 天清理。</p>
      <div class="hot-library-columns" aria-hidden="true"><span>歌曲</span><span>推荐分</span><span>来源数</span><span>最近收录 · 北京时间</span></div>
      <ol class="hot-library-tracks" start="${offset + 1}">${rows.map((track, index) => `<li class="hot-library-track"><div class="hot-library-song"><span class="hot-library-rank">${offset + index + 1}</span><div><strong>${escape(track.name || '未命名歌曲')}</strong><span>${escape([track.artists, duration(track.durationMs)].filter(Boolean).join(' · '))}</span></div></div><span class="hot-library-metric"><small>推荐分</small>${integer(track.score)}</span><span class="hot-library-metric"><small>来源</small>${integer(track.sourceCount)}</span><span class="hot-library-seen"><small>最近收录</small>${stamp(track.lastSeenAt)}</span></li>`).join('')}</ol>
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
