import { sourceName, sourceIds } from './music-sources.js';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validTime = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8640000000000000;
const stamp = (value, fallback = '尚未检查') => validTime(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : fallback;
const statuses = { playing:'正在播放', paused:'已暂停', ready:'进度已保留', idle:'空闲', recovering:'正在恢复', starting:'正在启动', error:'异常', stopped:'已停止' };

export function cookieHealth(account = {}, { now = Date.now(), fetchFailed = false, checking = false } = {}) {
  const interval = Number.isFinite(account.checkIntervalMs) && account.checkIntervalMs > 0 ? account.checkIntervalMs : 300000;
  const sampled = validTime(account.checkedAt) && now - account.checkedAt >= -60000 && now - account.checkedAt <= interval + 35000;
  let status = account.cookieStatus || ({ logged_in: 'valid', expired: 'expired', logged_out: 'missing', error: 'unknown',
    checking: 'checking', unavailable: 'unavailable', unconfigured: 'unavailable' })[account.status];
  if (checking) status = 'checking';
  else if (fetchFailed) status = 'unknown';
  else if (status !== 'checking' && status !== 'unavailable' && (account.error || account.status === 'error' || account.stale === true || !sampled)) status = 'unknown';
  const labels = { valid: ['Cookie 有效', 'mint'], expired: ['Cookie 已失效', 'cookie-invalid'], missing: ['未登录', ''],
    checking: ['检测中', 'cookie-pending'], unknown: ['暂无法确认', 'cookie-pending'], unavailable: ['未配置', ''] };
  if (!Object.hasOwn(labels, status)) status = 'unknown';
  const [label, tone] = labels[status];
  return { status, label, tone, interval, stale: account.stale === true || validTime(account.checkedAt) && !sampled };
}

export function cookieTimingHtml(account = {}, options = {}) {
  const state = cookieHealth(account, options), now = options.now ?? Date.now();
  const next = state.status === 'unavailable' ? '—' : state.status === 'checking' ? '正在检测'
    : validTime(account.nextCheckAt) ? account.nextCheckAt <= now ? '等待后台检测' : stamp(account.nextCheckAt) : '等待后台排期';
  return `<dl class="cookie-check-times"><div><dt>最近检查</dt><dd>${escape(stamp(account.checkedAt))}</dd></div><div><dt>最近成功</dt><dd>${escape(stamp(account.lastSuccessAt, '尚无成功记录'))}</dd></div><div><dt>下次检测</dt><dd>${escape(next)}</dd></div></dl>`;
}

export function createHealth({ root, api, drawIcons, onAccount }) {
  let active = false, generation = 0, pending = false, timer, data = null, fetchFailed = false, checking = false;
  root.innerHTML = '<div class="feature-heading"><div><h2>故障与账号提示</h2><p>Cookie 后台每 5 分钟检测，页面读取最近结果。</p></div><button class="secondary" id="health-refresh"><i data-lucide="refresh-cw"></i>立即检测</button></div><p id="health-feedback" class="feature-note" role="status"></p><p id="health-storage-error" class="feature-error" role="status" hidden></p><div id="health-summary" class="health-summary"></div><div id="health-accounts" class="health-accounts"></div><div class="section-heading"><h2>机器人诊断</h2></div><div id="health-bots" class="health-bots"></div><div class="section-heading"><h2>最近事件</h2></div><div id="health-events" class="health-events"></div><p id="health-limits" class="feature-note"></p>';
  function render() {
    if (!data || !active) return;
    const summary = data.summary || {};
    root.querySelector('#health-storage-error').hidden = !data.storageError;
    root.querySelector('#health-storage-error').textContent = data.storageError ? `诊断记录保存异常：${data.storageError}` : '';
    root.querySelector('#health-summary').innerHTML = [['bots','机器人'], ['online','在线'], ['connected','语音连接'], ['issues','待关注']].map(([key,label]) => `<div><span>${label}</span><strong>${Number(summary[key]) || 0}</strong></div>`).join('');
    root.querySelector('#health-accounts').innerHTML = sourceIds.filter((source) => source !== 'qishui' || data.accounts?.[source]).map((source) => {
      const account = data.accounts?.[source] || {}, status = cookieHealth(account, { fetchFailed, checking });
      const message = fetchFailed ? '检测结果读取失败，暂无法确认 Cookie 状态。' : status.stale && status.status === 'unknown' ? '上次检测已过期，等待新结果。'
        : status.status === 'checking' ? '正在核对账号凭据。' : account.error || ({ valid: '上次检测通过。', expired: '登录失效，请重新登录。',
          missing: source === 'qishui' ? '请由管理员配置汽水音乐登录。' : '可前往账号与设置扫码登录。', unavailable: '此音乐源尚未配置。', unknown: '暂未取得可确认的检测结果。' })[status.status];
      return `<article class="feature-card"><h3>${sourceName(source)} <span class="tag ${status.tone}">${status.label}</span></h3><p class="${['expired','unknown'].includes(status.status) ? 'feature-error' : ''}">${escape(message)}</p>${cookieTimingHtml(account, { fetchFailed, checking })}${!['valid','checking'].includes(status.status) ? '<button class="quiet-button" data-health-account>前往账号与设置</button>' : ''}</article>`;
    }).join('');
    root.querySelector('#health-bots').innerHTML = (data.bots || []).map((bot) => `<article class="feature-card"><h3>${escape(bot.name)} <span class="tag">${escape(statuses[bot.status] || bot.status || '未知')}</span></h3><p>${bot.online ? '机器人在线' : '机器人未连接'} · ${bot.connected ? '语音已连接' : '语音未连接'}</p>${bot.trackName ? `<p>${escape(bot.trackName)} · ${sourceName(bot.source)}</p>` : ''}<p class="${bot.issue ? 'feature-error' : 'feature-note'}">${escape(bot.issue || '暂未发现连接异常。')}</p></article>`).join('') || '<p class="feature-note">暂无机器人状态。</p>';
    root.querySelector('#health-events').innerHTML = (data.events || []).map((event) => `<article class="health-event ${['error','warning','warn'].includes(event.level) ? 'has-issue' : ''}"><time>${escape(stamp(event.time))}</time><div><strong>${escape(event.botName || '系统')}</strong><p>${escape(event.message)}</p></div></article>`).join('') || '<p class="feature-note">暂无事件记录。</p>';
    root.querySelector('#health-limits').textContent = data.limitations || '连接与播放进度不能证明频道内实际有声音。此页不自动重启或更换音源。';
    drawIcons();
  }
  async function refresh(accounts = false) {
    if (!active || pending) return;
    const request = generation; pending = true; checking = accounts; root.querySelector('#health-refresh').disabled = true; render();
    root.querySelector('#health-feedback').textContent = accounts ? '正在检查账号与连接…' : '正在更新诊断…';
    try {
      const result = await api(`/health${accounts ? '?refresh=1' : ''}`);
      if (!active || request !== generation) return;
      data = result; fetchFailed = false; root.querySelector('#health-feedback').textContent = `更新于 ${stamp(data.generatedAt)} · 每 15 秒刷新事件`;
    } catch (error) { if (active && request === generation) { fetchFailed = true; root.querySelector('#health-feedback').textContent = `更新失败：${error.message}。${data ? '保留上次检查时间，状态待确认。' : ''}`; } }
    finally { if (request === generation) { pending = false; checking = false; render(); root.querySelector('#health-refresh').disabled = false; clearTimeout(timer); if (active) timer = setTimeout(() => void refresh(), 15000); } }
  }
  root.querySelector('#health-refresh').onclick = () => void refresh(true);
  root.addEventListener('click', (event) => { if (event.target.closest('[data-health-account]')) onAccount(); });
  return { setActive(value) { if (value === active) return; active = value; generation++; pending = false; checking = false; root.querySelector('#health-refresh').disabled = false; clearTimeout(timer); if (value) { render(); void refresh(); } } };
}
