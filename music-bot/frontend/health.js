const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
const statuses = { playing:'正在播放', paused:'已暂停', ready:'进度已保留', idle:'空闲', recovering:'正在恢复', starting:'正在启动', error:'异常', stopped:'已停止' };
export function createHealth({ root, api, drawIcons, onAccount }) {
  let active = false, generation = 0, pending = false, timer, data = null;
  root.innerHTML = '<div class="feature-heading"><div><h2>故障与账号提示</h2><p>查看连接、账号与最近事件，及时发现播放异常。</p></div><button class="secondary" id="health-refresh"><i data-lucide="refresh-cw"></i>重新检查账号</button></div><p id="health-feedback" class="feature-note" role="status"></p><p id="health-storage-error" class="feature-error" role="status" hidden></p><div id="health-summary" class="health-summary"></div><div id="health-accounts" class="health-accounts"></div><div class="section-heading"><h2>机器人诊断</h2></div><div id="health-bots" class="health-bots"></div><div class="section-heading"><h2>最近事件</h2></div><div id="health-events" class="health-events"></div><p id="health-limits" class="feature-note"></p>';
  function render() {
    if (!data || !active) return;
    const summary = data.summary || {};
    root.querySelector('#health-storage-error').hidden = !data.storageError;
    root.querySelector('#health-storage-error').textContent = data.storageError ? `诊断记录保存异常：${data.storageError}` : '';
    root.querySelector('#health-summary').innerHTML = [['bots','机器人'], ['online','在线'], ['connected','语音连接'], ['issues','待关注']].map(([key,label]) => `<div><span>${label}</span><strong>${Number(summary[key]) || 0}</strong></div>`).join('');
    root.querySelector('#health-accounts').innerHTML = ['netease', 'qq'].map((source) => {
      const account = data.accounts?.[source] || {}, issue = account.error || account.status === 'expired';
      return `<article class="feature-card"><h3>${source === 'qq' ? 'QQ音乐' : '网易云音乐'} <span class="tag ${account.loggedIn ? 'mint' : ''}">${account.error ? '检查失败' : account.loggedIn ? '已登录' : account.status === 'expired' ? '登录失效' : account.checkedAt ? '未登录' : '待检查'}</span></h3><p class="${issue ? 'feature-error' : ''}">${escape(account.error || (account.loggedIn ? '音乐账号可用。' : '可前往账号与设置扫码登录。'))}</p><p class="feature-note">检查时间：${escape(stamp(account.checkedAt))}</p>${!account.loggedIn ? '<button class="quiet-button" data-health-account>前往账号与设置</button>' : ''}</article>`;
    }).join('');
    root.querySelector('#health-bots').innerHTML = (data.bots || []).map((bot) => `<article class="feature-card"><h3>${escape(bot.name)} <span class="tag">${escape(statuses[bot.status] || bot.status || '未知')}</span></h3><p>${bot.online ? '机器人在线' : '机器人未连接'} · ${bot.connected ? '语音已连接' : '语音未连接'}</p>${bot.trackName ? `<p>${escape(bot.trackName)} · ${bot.source === 'qq' ? 'QQ音乐' : '网易云音乐'}</p>` : ''}<p class="${bot.issue ? 'feature-error' : 'feature-note'}">${escape(bot.issue || '暂未发现连接异常。')}</p></article>`).join('') || '<p class="feature-note">暂无机器人状态。</p>';
    root.querySelector('#health-events').innerHTML = (data.events || []).map((event) => `<article class="health-event ${['error','warning','warn'].includes(event.level) ? 'has-issue' : ''}"><time>${escape(stamp(event.time))}</time><div><strong>${escape(event.botName || '系统')}</strong><p>${escape(event.message)}</p></div></article>`).join('') || '<p class="feature-note">暂无事件记录。</p>';
    root.querySelector('#health-limits').textContent = data.limitations || '连接与播放进度不能证明频道内实际有声音。此页不自动重启或更换音源。';
    drawIcons();
  }
  async function refresh(accounts = false) {
    if (!active || pending) return;
    const request = generation; pending = true; root.querySelector('#health-refresh').disabled = true;
    root.querySelector('#health-feedback').textContent = accounts ? '正在检查账号与连接…' : '正在更新诊断…';
    try {
      const result = await api(`/health${accounts ? '?refresh=1' : ''}`);
      if (!active || request !== generation) return;
      data = result; render(); root.querySelector('#health-feedback').textContent = `更新于 ${stamp(data.generatedAt)} · 每 15 秒刷新事件`;
    } catch (error) { if (active && request === generation) root.querySelector('#health-feedback').textContent = `更新失败：${error.message}。${data ? '保留上次结果。' : ''}`; }
    finally { if (request === generation) { pending = false; root.querySelector('#health-refresh').disabled = false; clearTimeout(timer); if (active) timer = setTimeout(() => void refresh(), 15000); } }
  }
  root.querySelector('#health-refresh').onclick = () => void refresh(true);
  root.addEventListener('click', (event) => { if (event.target.closest('[data-health-account]')) onAccount(); });
  return { setActive(value) { if (value === active) return; active = value; generation++; pending = false; root.querySelector('#health-refresh').disabled = false; clearTimeout(timer); if (value) { render(); void refresh(); } } };
}
