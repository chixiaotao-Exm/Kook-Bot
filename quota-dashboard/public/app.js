'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const manageRequested = new URLSearchParams(location.search).get('manage') === '1';
  const initialInvitationId = new URLSearchParams(location.search).get('invite');
  const state = { authenticated: false, publicAccess: false, canManage: false, accounts: [], platform: 'all', filter: 'all', query: '', view: 'overview', snapshot: null, reportConfig: null, reportingLoaded: false, loading: false, refreshing: false, csrfToken: null };
  state.invitations = { enabled: false, publicInvites: false, canInvite: false };
  const invitation = { id: null, generation: 0, value: null, prepared: false, loading: false, sending: false, message: '', error: false };
  const invitationPrograms = new Set(['codex_referral_consumer', 'codex_referral_workspace']);
  const invitationCount = value => typeof value?.availableCount === 'number' && Number.isSafeInteger(value.availableCount) && value.availableCount >= 0 ? value.availableCount : null;
  const canInvite = () => state.invitations.enabled && state.invitations.canInvite && (state.invitations.publicInvites || state.authenticated);
  const canRead = () => state.publicAccess || state.authenticated;
  const isManaging = () => state.canManage && (!state.publicAccess || manageRequested);
  const providers = { openai: { name: 'OpenAI', icon: '◎' }, claude: { name: 'Claude', icon: '✳' }, anthropic: { name: 'Claude', icon: '✳' }, grok: { name: 'Grok', icon: '𝕏' }, deepseek: { name: 'DeepSeek', icon: 'D' }, gemini: { name: 'Gemini', icon: '✦' } };
  const expandedAccounts = new Set();
  let pollTimer;
  let toastTimer;
  const keyQuery = { epoch: 0, controller: null, presets: [], presetsLoaded: false, loadingPresets: false, activePreset: null };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const number = (value, maximumFractionDigits = 2) => finite(value) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits }) : '未知';
  const platformKey = account => {
    const key = String(account.platform || account.provider || 'other').trim().toLowerCase();
    return key === 'anthropic' ? 'claude' : key;
  };
  const platformInfo = account => providers[platformKey(account)] || { name: account.platformLabel || account.platform || account.provider || '其他平台', icon: String(account.platform || '?').slice(0, 1).toUpperCase() };
  const accountStale = account => Boolean(account.stale || account.freshness === 'stale');
  const accountPlan = account => ({ label: typeof account.planLabel === 'string' && account.planLabel.trim() ? account.planLabel.trim() : '版本未知', source: { upstream: '上游返回', type: '按账号类型识别' }[account.planSource] || '上游未提供版本' });
  const accountCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const comparePlatforms = (left, right) => {
    if (left === right) return 0;
    if (left === 'openai') return -1;
    if (right === 'openai') return 1;
    return accountCollator.compare(providers[left]?.name || left, providers[right]?.name || right)
      || accountCollator.compare(left, right);
  };
  const planRank = account => {
    const label = accountPlan(account).label.toLowerCase().replace(/[\s_-]+/g, '');
    if (label === 'pro5x') return 0;
    if (label === 'teampro') return 1;
    if (label === 'team') return 2;
    if (label === 'api计费' || /^(apikey|api_key|bedrock)$/i.test(account.type || '')) return 3;
    return 4;
  };
  const compareAccounts = (left, right) => comparePlatforms(platformKey(left), platformKey(right))
    || planRank(left) - planRank(right)
    || accountCollator.compare(accountPlan(left).label, accountPlan(right).label)
    || accountCollator.compare(String(left.name || ''), String(right.name || ''))
    || accountCollator.compare(String(left.id || ''), String(right.id || ''));
  const accountIssue = account => Boolean(account.error || ['error', 'disabled', 'inactive', 'rate_limited'].includes(account.status));
  const knownMetric = metric => finite(metric.usedPercent) || finite(metric.remainingPercent) || finite(metric.remaining) || finite(metric.value) || finite(metric.balance) || finite(metric.used) || finite(metric.limit) || finite(metric.total) || Boolean(metric.display && metric.display !== '未知');
  const accountKnown = account => (account.metrics || []).some(metric => metric.scope !== 'local' && knownMetric(metric));
  const quarterHourTimes = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`);
  const isQuarterHourly = times => Array.isArray(times) && times.length === 96 && [...times].sort().every((time, index) => time === quarterHourTimes[index]);
  const halfHourTimes = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
  const isHalfHourly = times => Array.isArray(times) && times.length === 48 && [...times].sort().every((time, index) => time === halfHourTimes[index]);
  const refreshIntervalMs = () => Number.isFinite(state.snapshot?.refreshIntervalMs) && state.snapshot.refreshIntervalMs >= 1000 && state.snapshot.refreshIntervalMs <= 2147483647 ? state.snapshot.refreshIntervalMs : 600000;

  function updateScheduleFields() {
    const form = $('#report-form');
    const quarterHourly = form.elements.cadence.value === 'quarter-hour';
    const halfHourly = form.elements.cadence.value === 'half-hour';
    $('#report-custom-times').hidden = quarterHourly || halfHourly;
    form.elements.times.disabled = quarterHourly || halfHourly;
    $('#report-schedule-summary').textContent = halfHourly ? '每30分钟（整点、30分）' : quarterHourly ? '每15分钟（整点、15、30、45分）' : '每天固定时间，最多 96 个。';
  }

  function formatTime(value, options = {}) {
    if (!value) return '尚未更新';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(date);
  }

  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
  }

  async function api(path, { method = 'GET', body, signal, timeoutMs = 45000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrfToken && method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response, data;
    try {
      response = await fetch(`./api/${path}`, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      data = await response.json().catch(() => ({}));
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    } catch (error) {
      throw new Error(path === 'key-usage' ? error.name === 'AbortError' ? '查询超时，请稍后重试。' : '暂时无法连接服务，请稍后重试。' : error.name === 'AbortError' ? '查询超时，保留最近一次结果，请稍后重试。' : '暂时无法连接服务，保留最近一次结果。');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
    if (data.csrf || data.csrfToken) state.csrfToken = data.csrf || data.csrfToken;
    if (response.status === 401 && path === 'session') return { ...data, authenticated: false };
    if (!response.ok) {
      if (response.status === 401 && path !== 'login' && path !== 'key-usage') {
        if (state.publicAccess) { state.authenticated = false; state.canManage = false; renderAccess(); }
        else showLogin();
      }
      const error = new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '') || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = data.error?.code || data.code;
      throw error;
    }
    return data;
  }

  function showLogin(message) {
    state.authenticated = false;
    clearTimeout(pollTimer);
    $('#boot-view').hidden = true;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-public-return').hidden = !state.publicAccess;
    if (message) { $('#login-error').textContent = message; $('#login-error').hidden = false; }
  }

  function renderAccess() {
    const managing = isManaging();
    $('#admin-label').hidden = !managing;
    $('#public-label').hidden = !state.publicAccess || managing;
    $('#logout').hidden = !managing;
    $('#mobile-logout').hidden = !managing;
    $('#report-form').hidden = !managing;
    $('#report-readonly').hidden = managing;
    $('#manage-reports').hidden = !state.publicAccess || managing;
    $('#public-report-return').hidden = !state.publicAccess || !managing;
    $('#access-note').textContent = state.publicAccess ? state.invitations.enabled && state.invitations.publicInvites ? '公开看板' : '只读看板' : '管理员';
    if ($('#invitation-dialog').open) renderInvitation();
  }

  async function showApp(session) {
    state.authenticated = Boolean(session.authenticated);
    if (typeof session.publicAccess === 'boolean') state.publicAccess = session.publicAccess;
    state.canManage = state.authenticated && session.canManage !== false;
    applyInvitationCapabilities(session.invitations);
    state.csrfToken = session.csrf || session.csrfToken || state.csrfToken;
    $('#admin-name').textContent = session.user?.username || session.user?.name || session.user?.email || '管理员';
    $('#boot-view').hidden = true;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    renderAccess();
    await loadStatus();
    if (initialInvitationId && state.accounts.some(account => String(account.id) === initialInvitationId)) void openInvitation(initialInvitationId);
    else if (state.publicAccess && manageRequested && isManaging()) await showView('reports');
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!canRead()) return;
    pollTimer = setTimeout(async () => {
      if (!document.hidden) {
        await loadStatus();
        if (state.view === 'reports') await loadReports({ quiet: true });
      }
      schedulePoll();
    }, state.refreshing ? 2500 : refreshIntervalMs());
  }

  function renderSummary() {
    const accounts = state.accounts;
    const cards = [
      { label: '账号', value: accounts.length },
      { label: '额度可读', value: accounts.filter(accountKnown).length },
      { label: '异常', value: accounts.filter(accountIssue).length, className: 'error' },
      { label: '旧数据', value: accounts.filter(accountStale).length, className: 'warning' }
    ];
    $('#summary').innerHTML = cards.map(card => `<div class="summary-card ${card.className || ''}"><span>${card.label}</span><strong class="summary-value">${card.value.toLocaleString('zh-CN')}</strong></div>`).join('');
    const platforms = [...new Set(accounts.map(platformKey))].sort(comparePlatforms);
    if (state.platform !== 'all' && !platforms.includes(state.platform)) state.platform = 'all';
    $('#platform-filters').innerHTML = [{ key: 'all', name: '全部', count: accounts.length }, ...platforms.map(key => ({ key, name: providers[key]?.name || accounts.find(account => platformKey(account) === key)?.platform || key, count: accounts.filter(account => platformKey(account) === key).length }))].map(item => `<button class="chip ${item.key === state.platform ? 'active' : ''}" data-platform="${escapeHtml(item.key)}" aria-pressed="${item.key === state.platform}">${escapeHtml(item.name)}<span>${item.count}</span></button>`).join('');
  }

  const compact = value => !finite(value) ? '未知' : Math.abs(Number(value)) >= 1e9 ? `${number(Number(value) / 1e9, 2)}B` : Math.abs(Number(value)) >= 1e6 ? `${number(Number(value) / 1e6, 2)}M` : Math.abs(Number(value)) >= 1e3 ? `${number(Number(value) / 1e3, 2)}K` : number(value, 0);
  const moneyNumber = value => !finite(value) ? '未知' : Number(value) !== 0 && Math.abs(Number(value)) < 0.01 ? (Number(value) < 0 ? '>−0.01' : '<0.01') : number(value, 2);
  const keyMoney = value => finite(value) ? `$${moneyNumber(value)}` : '未知';

  function resetKeyQuery({ clearInput = false } = {}) {
    keyQuery.epoch++;
    keyQuery.controller?.abort();
    keyQuery.controller = null;
    keyQuery.activePreset = null;
    $('#key-query-submit').disabled = false;
    $('#key-query-submit').textContent = '查询';
    $('#key-query-feedback').hidden = true;
    $('#key-query-feedback').textContent = '';
    $('#key-query-result').hidden = true;
    $('#key-query-result').replaceChildren();
    $('#key-query-empty').hidden = false;
    $('#key-query-form').setAttribute('aria-busy', 'false');
    if (clearInput) $('#key-query-input').value = '';
    renderKeyPresets();
  }

  function renderKeyPresets() {
    if (!keyQuery.presetsLoaded) return;
    $('#key-presets').innerHTML = keyQuery.presets.length ? `<span class="key-presets-label">快捷查询</span>${keyQuery.presets.map(preset => `<button class="button secondary key-preset ${keyQuery.activePreset === preset.id ? 'selected' : ''}" type="button" data-key-preset="${escapeHtml(preset.id)}" ${preset.configured === false ? 'disabled' : ''} aria-pressed="${keyQuery.activePreset === preset.id}">${escapeHtml(preset.label)}${preset.configured === false ? '<small>未配置</small>' : ''}</button>`).join('')}` : '<span class="subtle">暂无快捷查询</span>';
  }

  async function loadKeyPresets() {
    if (keyQuery.presetsLoaded || keyQuery.loadingPresets) return;
    keyQuery.loadingPresets = true;
    try {
      const result = await api('key-presets');
      keyQuery.presets = (result.presets || []).filter(item => item && typeof item.id === 'string' && typeof item.label === 'string');
      keyQuery.presetsLoaded = true;
      renderKeyPresets();
    } catch {
      $('#key-presets').innerHTML = '<span class="subtle">快捷查询暂不可用</span><button type="button" id="key-presets-retry" class="button text">重试</button>';
    } finally { keyQuery.loadingPresets = false; }
  }

  function keyUsageCard(stats, label, key) {
    const rows = [['请求', compact(stats.requests), number(stats.requests, 0)], ['Token', compact(stats.tokens), number(stats.tokens, 0)], ['实际扣费', keyMoney(stats.cost), finite(stats.cost) ? `$${number(stats.cost, 8)}` : '未知']];
    return `<article class="panel key-usage-card" data-key-period="${escapeHtml(key)}"><h3>${escapeHtml(label)}</h3><dl>${rows.map(([name, value, title]) => `<div><dt>${name}</dt><dd title="${escapeHtml(title)}">${escapeHtml(value)}</dd></div>`).join('')}</dl></article>`;
  }

  function renderKeyResult(result) {
    const quota = result.quota || {};
    const status = { active: ['可用', 'good'], expired: ['已过期', 'warning'], quota_exhausted: ['额度用尽', 'warning'], disabled: ['已停用', 'error'] }[result.status] || ['状态未知', 'neutral'];
    const scope = { key: 'Key 额度', account: '账户共享余额', subscription: '订阅额度', unknown: '额度' }[quota.scope] || '额度';
    const periods = Array.isArray(result.periods) ? result.periods : [];
    const totals = result.totals || {};
    const limits = Array.isArray(result.limits) ? result.limits : [];
    const remaining = quota.unlimited === true ? '不限额' : keyMoney(quota.remaining);
    const detailStats = [...periods, { key: 'total', label: '累计', ...totals }];
    const safeHint = /^sk-[….*•]+[A-Za-z0-9_-]{0,8}$/.test(result.keyHint || '') ? result.keyHint : '已隐藏';
    $('#key-query-result').innerHTML = `<div class="key-result-heading"><div><h2>${escapeHtml(result.label || 'API Key')}</h2><span class="key-hint">${escapeHtml(safeHint)}</span></div><div class="key-result-meta"><span class="pill ${status[1]}">${status[0]}</span><time>${escapeHtml(formatTime(result.queriedAt))}</time></div></div>
      <div class="panel key-quota-panel"><div><span>${scope} · 剩余</span><strong>${escapeHtml(remaining)}</strong>${quota.scope === 'account' ? '<small>多个 Key 共享</small>' : ''}</div><dl><div><dt>已用</dt><dd>${escapeHtml(keyMoney(quota.used))}</dd></div><div><dt>限额</dt><dd>${quota.unlimited === true ? '不限额' : escapeHtml(keyMoney(quota.limit))}</dd></div></dl></div>
      <div class="key-usage-grid">${periods.map(period => keyUsageCard(period, period.label || period.key, period.key)).join('')}${keyUsageCard(totals, '累计', 'total')}</div>
      ${limits.length ? `<div class="panel key-limits"><h3>窗口限额</h3><div class="key-limit-grid">${limits.map(limit => `<div class="key-limit"><strong>${escapeHtml(limit.window)}</strong><span>已用 ${escapeHtml(keyMoney(limit.used))} <small>/ ${escapeHtml(keyMoney(limit.limit))}</small></span><span class="subtle">剩余 ${escapeHtml(keyMoney(limit.remaining))}${limit.resetAt ? ` · ${escapeHtml(formatTime(limit.resetAt))} 重置` : ''}</span></div>`).join('')}</div></div>` : ''}
      <details class="key-result-details"><summary>详情 <span>北京时间 · USD</span></summary><div>${result.notice ? `<p>${escapeHtml(result.notice)}</p>` : ''}<p>近 7 天包含今天，按北京时间自然日统计。实际扣费为本站记录的费用。</p>${result.expiresAt ? `<p>有效期至 ${escapeHtml(formatTime(result.expiresAt, { year: 'numeric' }))}</p>` : ''}<div class="key-detail-stats">${detailStats.map(stats => `<dl><dt>${escapeHtml(stats.label || stats.key)}</dt><dd>输入 ${escapeHtml(number(stats.inputTokens, 0))} · 输出 ${escapeHtml(number(stats.outputTokens, 0))}</dd><dd>缓存读取 ${escapeHtml(number(stats.cacheReadTokens, 0))} · 写入 ${escapeHtml(number(stats.cacheCreationTokens, 0))}</dd><dd>标准费用 ${escapeHtml(keyMoney(stats.standardCost))}</dd></dl>`).join('')}</div></div></details>`;
    $('#key-query-result').hidden = false;
    $('#key-query-empty').hidden = true;
  }

  async function queryKeyUsage(presetId = null) {
    const apiKey = presetId ? null : $('#key-query-input').value.trim();
    resetKeyQuery({ clearInput: Boolean(presetId) });
    const feedback = $('#key-query-feedback');
    if (!presetId && !apiKey) { feedback.textContent = '请输入 API Key。'; feedback.className = 'feedback error'; feedback.hidden = false; $('#key-query-input').focus(); return; }
    const epoch = keyQuery.epoch;
    keyQuery.controller = new AbortController();
    keyQuery.activePreset = presetId;
    renderKeyPresets();
    $('#key-query-submit').disabled = true;
    $('#key-query-submit').textContent = '查询中…';
    $('#key-query-empty').hidden = true;
    $('#key-query-form').setAttribute('aria-busy', 'true');
    feedback.textContent = '正在查询用量…';
    feedback.className = 'feedback key-loading';
    feedback.hidden = false;
    try {
      const result = await api('key-usage', { method: 'POST', body: presetId ? { presetId } : { key: apiKey }, signal: keyQuery.controller.signal });
      if (epoch !== keyQuery.epoch) return;
      feedback.hidden = true;
      renderKeyResult(result);
    } catch (error) {
      if (epoch !== keyQuery.epoch) return;
      feedback.textContent = error.message;
      feedback.className = 'feedback error';
      feedback.hidden = false;
    } finally {
      if (epoch === keyQuery.epoch) {
        keyQuery.controller = null;
        $('#key-query-submit').disabled = false;
        $('#key-query-submit').textContent = '查询';
        $('#key-query-form').setAttribute('aria-busy', 'false');
      }
    }
  }
  const shortLabel = label => String(label || '额度').replace(/^小鸡毛·/, '').replace(/5\s*小时(?:额度窗口|额度|本站用量)?/g, '5h').replace(/7\s*天(?:额度窗口|额度|本站用量)?/g, '7d').replace('额度窗口的本站用量', '用量').replace('本站设置的', '').replace('钱包可用计价额度', '可用计价额度');
  function resetLabel(metric) {
    if (!metric.resetAt) return metric.resetText || '';
    const remaining = Date.parse(metric.resetAt) - Date.now();
    if (!Number.isFinite(remaining)) return formatTime(metric.resetAt);
    if (remaining <= 0) return '窗口已结束';
    const minutes = Math.ceil(remaining / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return `${days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`} 后重置`;
  }

  function resetDetailsHtml(metric) {
    const quotaWindow = metric.scope !== 'local' && [300, 10080].includes(metric.windowMinutes);
    const reset = resetLabel(metric);
    if (!quotaWindow) return reset ? `<span class="metric-details">${escapeHtml(reset)}</span>` : '';
    const timestamp = metric.resetAt ? Date.parse(metric.resetAt) : NaN;
    if (!Number.isFinite(timestamp)) return '<span class="metric-reset-time">下次重置：未提供</span>';
    const ended = timestamp <= Date.now();
    return `<span class="metric-reset-group"><span class="metric-reset-time">${ended ? '上次窗口结束' : '下次重置'}：<time datetime="${new Date(timestamp).toISOString()}">${escapeHtml(formatTime(metric.resetAt))}</time><small>北京时间</small></span><span class="metric-reset-countdown">${escapeHtml(reset)}</span></span>`;
  }

  function overviewBattery(metric) {
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const used = valid(metric.usedPercent) ? metric.usedPercent
      : valid(metric.remainingPercent) && metric.remainingPercent <= 100 ? 100 - metric.remainingPercent : null;
    if (used === null) return null;
    const remaining = Math.max(0, 100 - used);
    const filled = remaining === 0 ? 0 : remaining === 100 ? 10 : Math.max(1, Math.min(9, Math.round(remaining / 10)));
    const label = remaining > 0 && remaining < .01 ? '<0.01' : remaining < 100 && remaining > 99.99 ? '>99.99' : number(remaining, 2);
    return { remaining, filled, label, tone: remaining <= 30 ? 'low' : remaining <= 50 ? 'medium' : 'high', used };
  }

  function metricHtml(metric) {
    const label = escapeHtml(shortLabel(metric.label));
    const local = metric.scope === 'local';
    const tag = local ? '<span class="metric-tag">本站限额</span>' : metric.freshness === 'stale' ? '<span class="metric-tag old">旧</span>' : metric.freshness === 'unknown' ? '<span class="metric-tag">时间未知</span>' : '';
    const reset = resetLabel(metric);
    if (metric.kind === 'percent' && !String(metric.key || '').startsWith('grok-product-')) {
      const battery = overviewBattery(metric);
      const freshnessTag = local && metric.freshness === 'stale' ? '<span class="metric-tag old">旧</span>' : '';
      if (!battery) return `<div class="metric metric-window-unknown"><div class="metric-head"><span>${label}${tag}${freshnessTag}</span><span class="muted">未知</span></div>${resetDetailsHtml(metric)}</div>`;
      const stale = metric.freshness === 'stale' ? ' · 旧缓存' : metric.freshness === 'unknown' ? ' · 时间未知' : '';
      return `<div class="metric overview-charge${local ? ' local-metric' : ''}" data-charge="${battery.tone}"><div class="metric-head"><span class="metric-label">${label}${tag}${freshnessTag}</span><span class="metric-value overview-remaining" title="${escapeHtml(`已用 ${number(battery.used, 8)}% · 剩余 ${number(battery.remaining, 8)}%${stale}`)}">${escapeHtml(battery.label)}<small>% 剩余</small></span></div><div class="overview-battery" role="meter" aria-label="${label}剩余额度${stale}" aria-valuenow="${battery.remaining}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${escapeHtml(`剩余 ${battery.label}%${stale}`)}">${Array.from({ length: 10 }, (_, index) => `<span class="overview-battery-cell${index < battery.filled ? ' filled' : ''}" aria-hidden="true"></span>`).join('')}</div><div class="overview-charge-footer">${battery.tone === 'low' ? '<span class="overview-charge-status">电量低</span>' : ''}${resetDetailsHtml(metric)}</div></div>`;
    }
    if (!knownMetric(metric)) return `<div class="metric metric-unknown"><span>${label}</span><span class="muted">未知</span></div>`;
    if (metric.kind === 'balance' || finite(metric.balance)) {
      const balance = finite(metric.value) ? metric.value : finite(metric.balance) ? metric.balance : metric.remaining;
      const unit = metric.unit || metric.currency || '';
      return `<div class="metric balance"><div class="metric-head"><span class="metric-label">${label}${tag}</span></div><div class="balance-value" title="${escapeHtml(number(balance, 8))} ${escapeHtml(unit)}">${escapeHtml(moneyNumber(balance))}<small>${escapeHtml(unit)}</small></div>${String(metric.key).startsWith('newapi-') ? '<span class="balance-caption">账号共享 · 非现金</span>' : ''}${reset ? `<div class="metric-details">${escapeHtml(reset)}</div>` : ''}</div>`;
    }
    const total = metric.limit ?? metric.total;
    const percent = finite(metric.usedPercent) ? Number(metric.usedPercent) : finite(metric.used) && finite(total) && Number(total) > 0 ? Number(metric.used) / Number(total) * 100 : null;
    const unit = ({ requests: '次', tokens: 'Token' })[metric.unit] || metric.unit || '';
    const metricNumber = value => ['USD', 'CNY', 'EUR'].includes(metric.unit) ? escapeHtml(moneyNumber(value)) : compact(value);
    const main = metric.display ? escapeHtml(metric.display) : metric.kind === 'count' && finite(metric.remaining) ? `${metricNumber(metric.remaining)}<small>${escapeHtml(unit)}剩余</small>` : metric.kind === 'count' && finite(metric.used) ? `${metricNumber(metric.used)}<small>${escapeHtml(unit)}已用</small>` : percent !== null ? `${number(percent, 1)}<small>% 已用</small>` : finite(metric.remainingPercent) ? `${number(metric.remainingPercent, 1)}<small>% 剩余</small>` : finite(total) ? `${metricNumber(total)}<small>${escapeHtml(unit)}限额</small>` : '未知';
    return `<div class="metric ${local ? 'local-metric' : ''}"><div class="metric-head"><span class="metric-label">${label}${tag}</span><span class="metric-value">${main}</span></div>${reset ? `<div class="metric-details" title="${escapeHtml(formatTime(metric.resetAt))}">${escapeHtml(reset)}</div>` : ''}</div>`;
  }

  function windowStatsHtml(window, { matched = false } = {}) {
    const money = value => finite(value) ? `${window.currency === 'USD' || !window.currency ? '$' : `${escapeHtml(window.currency)} `}${escapeHtml(moneyNumber(value))}` : '未知';
    const fields = [
      { label: 'req', value: compact(window.requests), exact: number(window.requests, 0), title: '本站请求数' },
      { label: 'Token', value: compact(window.tokens), exact: number(window.tokens, 0), title: '本站 Token 用量' },
      { label: 'A', value: money(window.accountCost), exact: number(window.accountCost, 8), title: '账号费用，不是余额' },
      { label: 'U', value: money(window.userCost), exact: number(window.userCost, 8), title: '用户费用，不是余额' }
    ];
    return `<section class="window-stats ${window.complete === false ? 'window-stats-incomplete' : ''}" data-window-key="${escapeHtml(window.key || '')}">${window.freshness === 'stale' || window.freshness === 'unknown' ? `<span class="window-freshness ${window.freshness === 'stale' ? 'old' : ''}">本站用量 · ${window.freshness === 'stale' ? '旧缓存' : '时间未知'}</span>` : ''}${!matched ? `<div class="window-stats-heading"><span>${escapeHtml(shortLabel(window.label || '本站用量'))}</span>${window.periodKind === 'rolling' ? '<span class="metric-tag">滚动</span>' : ''}</div>` : ''}<dl class="window-stats-grid">${fields.map(field => `<div class="window-stat"><dt>${field.label}</dt><dd title="${escapeHtml(`${field.title}：${field.exact}`)}">${field.value}</dd></div>`).join('')}</dl>${finite(window.estimatedTotalCost) ? `<div class="cost-estimate" title="${escapeHtml(number(window.estimatedTotalCost, 8))}"><span>预计总费用 · 估算</span><strong>${money(window.estimatedTotalCost)}</strong></div>` : ''}${window.error || window.complete === false ? `<p class="window-stats-error" title="${escapeHtml(window.error || '统计尚不完整')}">用量未完整更新</p>` : ''}</section>`;
  }

  const creditLabels = { unknown: '未知', checking: '查询中', available: '可用', resetting: '重置中', success: '重置成功', no_credit: '无卡', failed: '检查失败' };
  function applyInvitationCapabilities(value) {
    state.invitations = { enabled: value?.enabled === true, publicInvites: value?.publicInvites === true, canInvite: value?.canInvite === true };
  }
  function invitationHtml(account) {
    const value = account.invitation;
    if (!value || typeof value !== 'object') return '';
    const count = invitationCount(value), enabled = state.invitations.enabled && value.supported === true;
    const label = value.supported === false ? '邀请未开放' : count === null ? '可邀请 <strong>未知</strong>' : `可邀请 <strong>${number(count, 0)}</strong> 人`;
    const note = value.freshness === 'stale' ? '上次记录' : value.programLabel || '邀请名额';
    return `<div class="account-invitations${count === 0 || !enabled ? ' unavailable' : ''}" data-account-invitations><div><span class="invitation-label">${label}</span><small>${escapeHtml(note)}</small></div><button class="button secondary" type="button" data-invite-account="${escapeHtml(account.id)}" ${enabled ? '' : 'disabled'}>${enabled ? count > 0 && value.shouldShow ? '邀请' : '查看' : '未开放'}</button></div>`;
  }
  function currentInvitationAccount() { return state.accounts.find(account => String(account.id) === invitation.id); }
  function invitationReady() {
    const value = invitation.value;
    return Boolean(canInvite() && currentInvitationAccount() && invitation.prepared && value?.supported === true &&
      value.shouldShow === true && invitationCount(value) > 0 && invitationPrograms.has(value.programId));
  }
  function renderInvitation() {
    if (!$('#invitation-dialog').open) return;
    const account = currentInvitationAccount(), value = invitation.value;
    const count = invitationCount(value), busy = invitation.loading || invitation.sending;
    $('#invitation-heading').textContent = value?.title || '发送邀请';
    $('#invitation-account-name').textContent = account?.name || '账号已不可用';
    $('#invitation-account-plan').textContent = account ? accountPlan(account).label : '';
    $('#invitation-program').textContent = value?.programLabel || '邀请名额';
    $('#invitation-count').textContent = invitation.loading ? '正在确认…' : count === null ? '名额未知' : `可邀请 ${number(count, 0)} 人`;
    $('#invitation-description').textContent = typeof value?.description === 'string' ? value.description : '';
    const rules = Array.isArray(value?.rules) ? value.rules.filter(item => typeof item === 'string') : [];
    $('#invitation-rules').innerHTML = rules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('');
    $('#invitation-rules').hidden = !rules.length;
    const message = account ? invitation.message : '账号已不可用，请关闭窗口后刷新页面。';
    $('#invitation-feedback').textContent = message;
    $('#invitation-feedback').hidden = !message;
    $('#invitation-feedback').className = `feedback${invitation.error || !account ? ' error' : ''}`;
    $('#invitation-login').hidden = !state.invitations.enabled || state.invitations.publicInvites || state.authenticated;
    $('#invitation-login').href = `?${new URLSearchParams({ manage: '1', invite: invitation.id || '' })}`;
    $('#invitation-email').disabled = busy || !invitationReady();
    $('#invitation-confirm-row').hidden = value?.requiresConfirmation !== true;
    $('#invitation-confirm').disabled = busy || !invitationReady();
    $('#invitation-confirm').required = value?.requiresConfirmation === true;
    $('#invitation-submit').disabled = busy || !invitationReady() || value?.requiresConfirmation === true && !$('#invitation-confirm').checked;
    $('#invitation-submit').textContent = invitation.sending ? '发送中…' : '发送邀请';
    $('#invitation-refresh').disabled = busy || !state.invitations.enabled;
    $('#invitation-refresh').textContent = invitation.loading ? '正在确认…' : '刷新名额';
    $('#invitation-close').disabled = invitation.sending;
    $('#invitation-dialog').setAttribute('aria-busy', String(busy));
  }
  function setAccountInvitation(id, value) {
    const account = state.accounts.find(item => String(item.id) === id);
    if (account) { account.invitation = value; renderAccounts(); }
  }
  async function refreshInvitation() {
    if (invitation.loading || invitation.sending || !invitation.id || !$('#invitation-dialog').open) return;
    const id = invitation.id, generation = ++invitation.generation;
    invitation.loading = true; invitation.prepared = false; invitation.message = ''; invitation.error = false;
    $('#invitation-confirm').checked = false; renderInvitation();
    const current = () => generation === invitation.generation && invitation.id === id && $('#invitation-dialog').open;
    try {
      // Refresh the browser's CSRF session and capability before an explicit check.
      const session = await api('session');
      if (!current()) return;
      state.authenticated = Boolean(session.authenticated); state.canManage = state.authenticated && session.canManage !== false;
      applyInvitationCapabilities(session.invitations); renderAccess();
      if (!canInvite()) throw new Error(state.invitations.publicInvites ? '邀请暂不可用，请稍后再试。' : '请先登录管理员账号，再发送邀请。');
      const result = await api(`invitations/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} });
      if (!current()) return;
      invitation.value = result.invitation; invitation.prepared = true; setAccountInvitation(id, result.invitation);
      if (!invitationReady()) invitation.message = invitationCount(result.invitation) === 0 ? '当前没有可用邀请名额。' : '当前账号暂不可邀请，请稍后刷新名额。';
    } catch (error) { if (current()) { invitation.message = error.message || '无法确认邀请名额，请稍后刷新。'; invitation.error = true; } }
    finally { if (current()) { invitation.loading = false; renderInvitation(); } }
  }
  async function openInvitation(id) {
    if (invitation.sending) return;
    const account = state.accounts.find(item => String(item.id) === id);
    if (!account?.invitation) return;
    Object.assign(invitation, { id, generation: invitation.generation + 1, value: account.invitation, prepared: false, loading: false, message: '', error: false });
    $('#invitation-form').reset();
    if (!$('#invitation-dialog').open) $('#invitation-dialog').showModal();
    renderInvitation(); await refreshInvitation();
  }
  async function sendInvitation() {
    const form = $('#invitation-form');
    if (invitation.loading || invitation.sending || !invitationReady() || !form.reportValidity()) return;
    const id = invitation.id, generation = invitation.generation;
    const email = $('#invitation-email').value.trim(), value = invitation.value;
    const confirmed = value.requiresConfirmation === true && $('#invitation-confirm').checked;
    if (value.requiresConfirmation === true && !confirmed) return;
    invitation.sending = true; invitation.message = ''; invitation.error = false; renderInvitation();
    try {
      const result = await api(`invitations/${encodeURIComponent(id)}/invite`, { method: 'POST',
        body: { email, programId: value.programId, confirmed, requestId: crypto.randomUUID() }, timeoutMs: 120000 });
      if (generation !== invitation.generation || invitation.id !== id) return;
      if (result.sent !== true) throw Object.assign(new Error('邀请结果未确认。'), { code: 'SEND_UNKNOWN' });
      if (result.invitation) { invitation.value = result.invitation; setAccountInvitation(id, result.invitation); }
      $('#invitation-email').value = '';
      invitation.message = result.refreshFailed || result.cachePersisted === false ? '邀请已发送；名额显示可能延迟，请刷新确认。' : '邀请已发送，请对方查看邮箱。';
    } catch (error) {
      if (generation !== invitation.generation || invitation.id !== id) return;
      invitation.error = true;
      const uncertain = error.code === 'SEND_UNKNOWN' || !Number.isInteger(error.status) || error.status >= 500;
      invitation.message = uncertain ? '发送结果未确认，请先检查收件邮箱；确认后手动刷新名额，不要重复发送。' : error.message || '邀请未发送，请刷新名额后重试。';
    } finally {
      if (generation === invitation.generation && invitation.id === id) { invitation.sending = false; invitation.prepared = false; renderInvitation(); }
    }
  }
  function resetCreditsHtml(credits, account) {
    if (!credits && !(platformKey(account) === 'openai' && /^(oauth|setup-token)$/i.test(account.type || ''))) return '';
    const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    // The reset-card snapshot and automatic checker are not timestamped together.
    // Display the snapshot count as a record; never attach an old "no_credit" status to it.
    const fromSnapshot = validCount(credits?.cachedCount);
    const count = fromSnapshot ? credits.cachedCount : validCount(credits?.availableCount) ? credits.availableCount : null;
    const expiries = (Array.isArray(credits?.expiresAt) ? credits.expiresAt : []).map(value => Date.parse(value)).filter(Number.isFinite);
    const future = expiries.filter(value => value > Date.now()).sort((a, b) => a - b);
    const allExpired = count > 0 && expiries.length >= count && future.length === 0;
    const known = count !== null && !allExpired;
    const queried = credits?.source === 'sub2api-active-quota' && credits?.checkedAt;
    const badge = allExpired ? '记录已到期' : known ? queried ? credits.freshness === 'stale' ? '上次查询' : '已查询' : '缓存记录' : '未提供';
    const note = allExpired ? `上次记录 ${number(count, 0)} 次` : future.length ? `最近到期 ${formatTime(new Date(future[0]).toISOString())}` : known ? queried ? `查询于 ${formatTime(credits.checkedAt)}` : '缓存时间未提供' : '尚未取得次数';
    return `<div class="account-reset reset-credit-panel ${known && count > 0 ? 'has-credits' : 'credits-muted'}" data-reset-credits><div class="reset-credit-label"><span class="reset-credit-icon" aria-hidden="true">↻</span><span>重置卡</span><span class="reset-credit-source">${badge}</span></div><strong class="reset-credit-count">${known ? `${number(count, 0)}<small>次</small>` : '<span>未知</span>'}</strong><span class="reset-credit-note">${escapeHtml(note)}</span></div>`;
  }

  function pointsHtml(account) {
    if (platformKey(account) !== 'openai' || !/^(oauth|setup-token)$/i.test(account.type || '')) return '';
    const points = account.points && typeof account.points === 'object' && !Array.isArray(account.points) ? account.points : {};
    const balance = typeof points.balance === 'number' && Number.isFinite(points.balance) && points.balance >= 0 ? points.balance : null;
    let label = '未知', unit = '', numeric = false;
    if (points.unlimited === true) label = '不限量';
    else if (points.hasCredits === false) { label = '0'; unit = '点'; numeric = true; }
    else if (points.hasCredits === true && balance !== null) {
      label = balance > 0 && balance < 0.0001 ? '<0.0001' : number(balance, 4); unit = '点'; numeric = true;
    } else if (points.hasCredits === true) label = '有可用点数';
    const hasTime = typeof points.observedAt === 'string' && Number.isFinite(Date.parse(points.observedAt));
    const stale = points.freshness === 'stale';
    const note = stale ? '旧数据' : !hasTime || points.freshness !== 'fresh' ? '时间未知' : '已更新';
    const source = points.source === 'sub2api-active-quota' ? '主动查询' : points.source === 'sub2api-cache' ? '上游缓存' : '未提供';
    const details = [`OpenAI Codex 点数：${label}${unit}`, `来源：${source}`, hasTime ? `采样：${formatTime(points.observedAt, { second: '2-digit' })}（北京时间）` : '采样时间未知',
      ...(stale ? ['旧数据，当前点数可能已变化。'] : []), ...(points.hasCredits === true && balance !== null && points.unlimited !== true ? [`原始余额：${balance}`] : [])].join('\n');
    return `<div class="account-points${stale ? ' stale' : ''}" data-account-points title="${escapeHtml(details)}"><span class="points-label">点数</span><strong class="points-value${numeric ? '' : ' points-text'}">${escapeHtml(label)}${unit ? `<small>${unit}</small>` : ''}</strong><span class="points-note">${note}</span></div>`;
  }

  function creditPanelsHtml(account) {
    const resets = resetCreditsHtml(account.resetCredits, account), points = pointsHtml(account);
    return points ? `<div class="account-credit-pair">${resets}${points}</div>` : resets;
  }

  function accountDetailsHtml(account, secondary) {
    const plan = accountPlan(account);
    const metrics = (account.metrics || []).map(metric => {
      const values = [['value', '数值'], ['balance', '余额'], ['remaining', '剩余'], ['used', '已用'], ['limit', '限额'], ['total', '总量'], ['usedPercent', '已用%'], ['remainingPercent', '剩余%']].filter(([key]) => finite(metric[key])).map(([key, label]) => `${label} ${number(metric[key], 8)}${key.endsWith('Percent') ? '' : metric.unit ? ` ${metric.unit}` : ''}`).join(' · ');
      return `<div class="detail-item"><strong>${escapeHtml(metric.label || '额度')}</strong><p>${escapeHtml(values || '未知')}</p>${metric.note ? `<p>${escapeHtml(metric.note)}</p>` : ''}<p>采样 ${escapeHtml(formatTime(metric.observedAt))}${metric.resetAt ? ` · 重置 ${escapeHtml(formatTime(metric.resetAt))}` : ''}${metric.validUntil ? ` · 有效期 ${escapeHtml(formatTime(metric.validUntil))}` : ''}</p></div>`;
    }).join('');
    const windows = (account.windowStats || []).map(window => `<div class="detail-item"><strong>${escapeHtml(window.label || '本站用量')}</strong><p>请求 ${number(window.requests, 0)} · Token ${number(window.tokens, 0)}</p><p>A ${number(window.accountCost, 8)} · U ${number(window.userCost, 8)} ${escapeHtml(window.currency || 'USD')}${finite(window.estimatedTotalCost) ? ` · 预计总费用 ${number(window.estimatedTotalCost, 8)}（估算）` : ''}</p><p>${escapeHtml(formatTime(window.periodStart))} — ${escapeHtml(formatTime(window.periodEnd))}${window.periodKind === 'rolling' ? ' · 滚动统计' : ''}</p><p>读取 ${escapeHtml(formatTime(window.observedAt))}${window.estimateObservedAt ? ` · 估算采样 ${escapeHtml(formatTime(window.estimateObservedAt))}` : ''}</p>${[window.note, window.estimateNote, window.error].filter(Boolean).map(note => `<p>${escapeHtml(note)}</p>`).join('')}</div>`).join('');
    const credits = account.resetCredits;
    const creditDetails = credits ? `<div class="detail-item"><strong>重置卡 · 记录详情</strong><p>快照记录 ${number(credits.cachedCount, 0)} 次</p>${credits.checkedAt ? `<p>${credits.source === 'sub2api-active-quota' ? '主动查询' : '自动检查记录'} ${escapeHtml(formatTime(credits.checkedAt))} · ${escapeHtml(creditLabels[credits.status] || '未知')}</p>` : ''}${(credits.expiresAt || []).filter(Boolean).map(time => `<p>到期 ${escapeHtml(formatTime(time))}</p>`).join('')}<p>${credits.source === 'sub2api-active-quota' ? '每30分钟主动查询；页面不执行重置。' : '卡片快照未提供查询时间；自动检查记录可能早于当前快照。页面仅展示次数，不执行重置。'}</p></div>` : '';
    return `<details class="account-details" data-account-details="${escapeHtml(account.id)}"${expandedAccounts.has(String(account.id)) ? ' open' : ''}><summary>详情${secondary.length ? `<span>${secondary.length} 项更多指标</span>` : ''}</summary><div class="account-details-body">${metrics}${windows}${creditDetails}<div class="detail-item"><strong>数据说明</strong><p>版本：${escapeHtml(plan.label)} · ${escapeHtml(plan.source)}</p><p>${escapeHtml(account.type || '未知类型')}${account.plan ? ` · ${escapeHtml(account.plan)}` : ''} · ${escapeHtml(account.sourceLabel || account.source || '上游接口')}</p><p>采样 ${escapeHtml(formatTime(account.observedAt || account.updatedAt))}</p>${[account.note, ...(account.notes || []), typeof account.error === 'object' ? account.error?.message : account.error].filter(Boolean).map(note => `<p>${escapeHtml(note)}</p>`).join('')}<p>A：账号费用；U：用户费用。两者都不是余额，预计总费用为估算。本站限额不代表上游余额。</p></div></div></details>`;
  }

  function accountHtml(account) {
    const provider = platformInfo(account), stale = accountStale(account), issue = accountIssue(account), known = accountKnown(account);
    const plan = accountPlan(account);
    const scheduling = account.schedulable === true ? ['enabled', '调度开启'] : account.schedulable === false ? ['disabled', '调度关闭'] : ['unknown', '调度未知'];
    const allMetrics = account.metrics || [], hasGrokBilling = allMetrics.some(metric => metric.key === 'grok-billing');
    const secondaryMetric = metric => String(metric.key).startsWith('grok-product-') || hasGrokBilling && String(metric.key).startsWith('grok-') && metric.key !== 'grok-billing' || ['newapi-used', 'newapi-requests'].includes(metric.key);
    const primary = allMetrics.filter(metric => !secondaryMetric(metric)), secondary = allMetrics.filter(secondaryMetric);
    const windows = Array.isArray(account.windowStats) ? account.windowStats : [];
    const primaryKeys = new Set(primary.map(metric => metric.key));
    const error = account.error && typeof account.error === 'object' ? account.error.message || '查询失败' : account.error;
    const notices = [stale ? '<span class="warning">旧缓存 · 非实时额度</span>' : '', account.quotaQuery?.message ? `<span class="warning">${escapeHtml(account.quotaQuery.message)}</span>` : '', issue ? `<span class="error" title="${escapeHtml(error || account.status)}">${escapeHtml(error ? String(error).slice(0, 52) + (String(error).length > 52 ? '…' : '') : '账号异常')}</span>` : ''].filter(Boolean).join('');
    const unknown = !known ? '<div class="unknown-block"><span>上游额度未知</span><small>未知 ≠ 0</small></div>' : !primary.length ? '<div class="unknown-block"><span>产品用量见详情</span></div>' : '';
    const metrics = primary.map(metric => `<div class="quota-window">${metricHtml(metric)}${windows.filter(window => window.metricKey && window.metricKey === metric.key).map(window => windowStatsHtml(window, { matched: true })).join('')}</div>`).join('') + windows.filter(window => !window.metricKey || !primaryKeys.has(window.metricKey)).map(window => `<div class="unmatched-window-stats">${windowStatsHtml(window)}</div>`).join('');
    return `<article class="account-card ${stale ? 'stale' : ''} ${issue ? 'has-error' : ''}" data-account-id="${escapeHtml(account.id)}"><div class="account-header"><span class="provider-icon ${escapeHtml(Object.hasOwn(providers, platformKey(account)) ? platformKey(account) : '')}">${escapeHtml(provider.icon)}</span><div class="account-title"><h3 title="${escapeHtml(account.name)}">${escapeHtml(account.name || `账号 ${account.id}`)}</h3><p class="account-meta"><span>${escapeHtml(provider.name)}</span><span class="account-plan${plan.label === '版本未知' ? ' unknown' : ''}" title="${escapeHtml(`${plan.label} · ${plan.source}`)}">${escapeHtml(plan.label)}</span><span class="account-id">#${escapeHtml(account.id)}</span></p></div><span class="account-scheduling ${scheduling[0]}" data-account-scheduling="${scheduling[0]}" title="Sub2API 参与调度状态，仅展示；开启不代表账号当前一定可用。"><span aria-hidden="true">●</span>${scheduling[1]}</span></div>${creditPanelsHtml(account)}${invitationHtml(account)}${notices ? `<div class="account-notices">${notices}</div>` : ''}<div class="metrics">${unknown}${metrics}</div>${accountDetailsHtml(account, secondary)}</article>`;
  }

  function renderAccounts() {
    $$('[data-account-details]').forEach(details => { const id = details.dataset.accountDetails; if (details.open) expandedAccounts.add(id); else expandedAccounts.delete(id); });
    const currentIds = new Set(state.accounts.map(account => String(account.id)));
    for (const id of expandedAccounts) if (!currentIds.has(id)) expandedAccounts.delete(id);
    const query = state.query.trim().toLowerCase();
    const accounts = state.accounts.filter(account => (state.platform === 'all' || platformKey(account) === state.platform) && (!query || [account.id, account.name, account.type, platformInfo(account).name].join(' ').toLowerCase().includes(query)) && (state.filter === 'all' || state.filter === 'issue' && accountIssue(account) || state.filter === 'stale' && accountStale(account) || state.filter === 'unknown' && !accountKnown(account))).sort(compareAccounts);
    $('#account-count').textContent = `${accounts.length} / ${state.accounts.length}`;
    $('#accounts').innerHTML = accounts.map(accountHtml).join('');
    $('#empty-state').hidden = accounts.length > 0;
    $('#accounts').hidden = accounts.length === 0;
  }

  function applyStatus(data) {
    state.snapshot = data;
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    state.refreshing = Boolean(data.refreshing);
    $('#refresh').disabled = state.refreshing;
    $('#refresh').classList.toggle('refreshing', state.refreshing);
    $('#refresh span:last-child').textContent = state.refreshing ? '查询中…' : '刷新数据';
    $('#refresh-state').textContent = state.refreshing ? '更新中' : data.lastError ? '部分更新失败' : '已同步';
    $('#update-dot').classList.toggle('warning', Boolean(data.lastError));
    $('#updated-at').textContent = (data.updatedAt || data.checkedAt) ? `更新 ${formatTime(data.updatedAt || data.checkedAt)} · 北京时间` : '尚无成功采集记录';
    $('#refresh-interval').textContent = `每${number(refreshIntervalMs() / 60000)}分钟自动刷新`;
    $('#connection-error').hidden = !data.lastError && !data.storageError;
    $('#connection-error').textContent = [data.lastError ? `同步提示：${typeof data.lastError === 'object' ? data.lastError.message || '部分账号更新失败' : data.lastError}` : '', data.storageError || ''].filter(Boolean).join(' ');
    const active = data.activeQuota, indicator = $('#active-quota-status');
    indicator.hidden = !active?.enabled;
    if (active?.enabled) {
      const guarded = (active.accounts || []).filter(account => account.status === 'skipped' && ['AUTO_RESET_ENABLED','AUTO_RESET_UNSAFE'].includes(account.code)).length;
      indicator.classList.toggle('has-warning', Boolean(active.lastError || guarded));
      indicator.textContent = `主动查询 · 每30分钟${active.running ? ' · 查询中…' : active.lastFinishedAt ? ` · 最近 ${formatTime(active.lastFinishedAt)} · 成功 ${number(active.successCount, 0)} 个` : ' · 等待首次查询'}${active.failedCount ? ` · 失败 ${number(active.failedCount, 0)} 个` : ''}${guarded ? ` · 自动用卡未关闭，跳过 ${guarded} 个` : ''}${active.lastError ? ` · ${active.lastError}` : ''}`;
    }
    renderSummary();
    renderAccounts();
    renderInvitation();
  }

  async function loadStatus() {
    if (state.loading || !canRead()) return;
    state.loading = true;
    try { applyStatus(await api('status')); }
    catch (error) {
      if (error.status !== 401 || state.publicAccess) {
        $('#connection-error').textContent = state.snapshot ? `${error.message} 显示上次结果。` : error.message;
        $('#connection-error').hidden = false;
        $('#refresh-state').textContent = '暂时无法读取最新状态';
        $('#update-dot').classList.add('warning');
      }
    } finally { state.loading = false; }
  }

  async function requestRefresh() {
    $('#refresh').disabled = true;
    $('#refresh').classList.add('refreshing');
    try {
      const result = await api('refresh', { method: 'POST', body: {} });
      if (Array.isArray(result.accounts)) applyStatus(result);
      else { state.refreshing = true; $('#refresh span:last-child').textContent = '查询中…'; await loadStatus(); }
      schedulePoll();
    } catch (error) {
      if (error.status !== 401 || state.publicAccess) toast(error.message);
      $('#refresh').disabled = false;
      $('#refresh').classList.remove('refreshing');
    }
  }

  function renderReportConfig(config) {
    state.reportConfig = config;
    const form = $('#report-form');
    form.elements.enabled.checked = Boolean(config.enabled);
    form.elements.times.value = (config.times || []).join(', ');
    form.elements.cadence.value = isHalfHourly(config.times) ? 'half-hour' : isQuarterHourly(config.times) ? 'quarter-hour' : 'custom';
    updateScheduleFields();
    const zone = config.timeZone || 'Asia/Shanghai';
    if (![...form.elements.timeZone.options].some(option => option.value === zone)) form.elements.timeZone.add(new Option(zone, zone));
    form.elements.timeZone.value = zone;
    $('#report-enabled-badge').textContent = config.enabled ? '已开启' : '未开启';
    $('#report-enabled-badge').className = `pill ${config.enabled ? 'good' : 'neutral'}`;
    const configured = Boolean(config.configured || config.botConfigured && config.channelId);
    $('#report-destination').classList.toggle('warning', !configured);
    $('#report-destination').innerHTML = configured ? `<strong>✓ ${escapeHtml(config.botName || 'KOOK 机器人')}</strong><span>文字频道 ${config.channelName ? `#${escapeHtml(config.channelName)} · ` : ''}<span class="channel-id">${escapeHtml(config.channelId || config.targetLabel || '已配置')}</span></span>` : '<strong>KOOK 播报目标待配置</strong><span>请配置机器人和文字频道。</span>';
    $('#report-system-error').hidden = !config.storageError && !config.lastError;
    $('#report-system-error').textContent = config.storageError || config.lastError || '';
    form.elements.enabled.disabled = !configured;
    const quarterHourly = isQuarterHourly(config.times);
    const halfHourly = isHalfHourly(config.times);
    $('#readonly-cadence').textContent = halfHourly ? '每 30 分钟' : quarterHourly ? '每 15 分钟' : '每天固定时间';
    $('#readonly-times').textContent = halfHourly ? '每小时 00、30 分' : quarterHourly ? '每小时 00、15、30、45 分' : (config.times || []).join('、') || '未设置';
    $('#readonly-timezone').textContent = zone === 'Asia/Shanghai' ? '北京时间 · Asia/Shanghai' : zone;
    renderAccess();
  }

  function renderReports(records) {
    const sorted = [...records].sort((a, b) => new Date(b.sentAt || b.createdAt || b.at || 0) - new Date(a.sentAt || a.createdAt || a.at || 0));
    $('#report-count').textContent = sorted.length ? `最近 ${sorted.length} 条` : '';
    $('#report-history').innerHTML = sorted.length ? sorted.map(record => {
      const success = record.status === 'sent' || record.status === 'success' || record.success === true;
      const labels = { sent: '已发送', success: '已发送', failed: '未发送', uncertain: '未确认', dispatching: '发送中', cancelled: '已取消' };
      const badge = success ? 'good' : record.status === 'uncertain' || record.status === 'dispatching' ? 'warning' : record.status === 'cancelled' ? 'neutral' : 'error';
      return `<div class="history-row"><time>${escapeHtml(formatTime(record.sentAt || record.createdAt || record.at, { second: '2-digit' }))}</time><span class="pill ${badge}">${labels[record.status] || (success ? '已发送' : '待确认')}</span><p>${escapeHtml(record.error?.message || record.error || record.message || record.summary || (success ? '额度汇总已发送至 KOOK' : record.status === 'dispatching' ? '正在发送本时段汇总' : '请查看最近一次播报结果'))}</p></div>`;
    }).join('') : '<div class="history-empty">暂无播报记录</div>';
  }

  function renderReportPreview(result) {
    const preview = $('#report-preview');
    if (result.format === 'image') {
      preview.classList.remove('has-cards'); preview.classList.add('has-images'); preview.replaceChildren();
      const images = Array.isArray(result.images) ? result.images.slice(0, 8) : [];
      const imageBase = new URL('./api/report-images/', location.href);
      const allowed = value => {
        try {
          const url = new URL(value, location.href);
          return url.origin === location.origin && !url.username && !url.password && !url.search && !url.hash
            && url.pathname.startsWith(imageBase.pathname) && /^[a-f0-9]{32,64}\.png$/.test(url.pathname.slice(imageBase.pathname.length)) ? url.href : null;
        } catch { return null; }
      };
      images.forEach((item, index) => {
        const url = typeof item?.url === 'string' && allowed(item.url); if (!url) return;
        const figure = document.createElement('figure'); figure.className = 'report-image-page';
        const caption = document.createElement('figcaption'); caption.textContent = images.length === 1 ? '高清总览 · 点击查看原图' : `第 ${index + 1} / ${images.length} 张 · 点击查看原图`;
        const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        const image = document.createElement('img'); image.src = url; image.alt = typeof item.alt === 'string' ? item.alt : `额度播报第 ${index + 1} 张`;
        image.loading = 'eager'; image.decoding = 'async';
        if (Number.isSafeInteger(item.width) && item.width > 0 && item.width <= 4096) image.width = item.width;
        if (Number.isSafeInteger(item.height) && item.height > 0 && item.height <= 8192) image.height = item.height;
        image.addEventListener('error', () => {
          link.hidden = true;
          const error = document.createElement('p'); error.className = 'report-image-error'; error.textContent = '图片已过期或加载失败，请点击上方“刷新预览”。'; figure.append(error);
        }, { once: true });
        link.append(image); figure.append(caption, link); preview.append(figure);
      });
      if (!preview.children.length) preview.textContent = '图片预览暂不可用，请刷新预览。';
      return;
    }
    preview.classList.remove('has-images');
    const displayText = value => ['plain-text', 'kmarkdown'].includes(value?.type) && typeof value.content === 'string' ? value.content : null;
    // Render only KOOK's fixed font-color tokens. All other markup stays literal text.
    const fontPattern = () => /\(font\)([^\r\n]*?)\(font\)\[(success|warning|danger|info|purple|secondary|tips)\]/g;
    const uncolored = (value, formatted) => formatted ? value.replace(fontPattern(), '$1') : value;
    const element = (tag, className, value) => {
      const node = document.createElement(tag);
      node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    const appendText = (node, value, formatted) => {
      if (!formatted) { node.textContent = value; return node; }
      let offset = 0;
      for (const token of value.matchAll(fontPattern())) {
        node.append(document.createTextNode(value.slice(offset, token.index)));
        node.append(element('span', `report-font-${token[2]}`, token[1]));
        offset = token.index + token[0].length;
      }
      node.append(document.createTextNode(value.slice(offset)));
      return node;
    };
    const contextTone = value => /^(?:🟢\s*)?开启(?:\s|$)/.test(value) ? 'success'
      : /^(?:🔴\s*)?(?:查询异常|账号异常|账号停用|异常)(?:\s|$)/.test(value) ? 'danger'
        : /^(?:🟡\s*)?(?:限流|旧采样|调度未知)(?:\s|$)/.test(value) ? 'warning'
          : /^(?:⚪\s*)?关闭(?:\s|$)/.test(value) ? 'secondary' : '';
    const safeLink = value => {
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
      } catch { return null; }
    };
    const cards = [];
    for (const card of (Array.isArray(result.cards) ? result.cards : []).slice(0, 5)) {
      if (card?.type !== 'card' || !Array.isArray(card.modules)) continue;
      const article = element('article', 'report-card');
      let headings = 0;
      for (const module of card.modules.slice(0, 50)) {
        if (!module || typeof module !== 'object') continue;
        if (module.type === 'header') {
          const text = displayText(module.text);
          if (text !== null) article.append(element('h3', headings++ ? 'report-card-account' : 'report-card-title', text));
        } else if (module.type === 'context') {
          const context = element('div', 'report-card-context');
          const accountMeta = article.lastElementChild?.classList.contains('report-card-account');
          for (const item of (Array.isArray(module.elements) ? module.elements : []).slice(0, 10)) {
            const text = displayText(item);
            if (text === null) continue;
            const formatted = item.type === 'kmarkdown';
            const line = element('p', `report-card-context-line${accountMeta && !text.includes('\n') ? ' report-card-badges' : ''}`);
            if (accountMeta && !text.includes('\n')) {
              for (const [index, fragment] of text.split(/\s+·\s+/).entries()) {
                const tone = index === 0 ? 'purple' : contextTone(uncolored(fragment, formatted));
                line.append(appendText(element('span', `report-card-badge${tone ? ` ${tone}` : ''}`), fragment, formatted));
              }
            } else appendText(line, text, formatted);
            context.append(line);
          }
          if (context.childElementCount) article.append(context);
        } else if (module.type === 'section') {
          const text = displayText(module.text);
          if (text !== null) article.append(appendText(element('p', 'report-card-section'), text, module.text.type === 'kmarkdown'));
          else if (module.text?.type === 'paragraph' && Array.isArray(module.text.fields)) {
            const fields = element('div', 'report-card-fields');
            fields.classList.toggle('single-column', module.text.cols === 1);
            for (const item of module.text.fields.slice(0, 10)) {
              const value = displayText(item);
              if (value === null) continue;
              const field = element('div', 'report-card-field');
              const formatted = item.type === 'kmarkdown';
              const originalLines = value.split('\n');
              const lines = originalLines.map(line => uncolored(line, formatted));
              const quotaToken = formatted ? [...originalLines[0].matchAll(fontPattern())].find(token => /剩余\s+[<>]?\d+(?:\.\d+)?%/.test(token[1])) : null;
              const nativeTone = quotaToken && ({ danger: 'low', warning: 'medium', success: 'high' })[quotaToken[2]];
              for (const [index, line] of lines.entries()) {
                const battery = /^(?:🔋|🪫) \[([■□]{10})\]▏$/.exec(line.trim());
                const remaining = /剩余\s+([<>]?\d+(?:\.\d+)?)%/.exec(lines[index - 1] || '');
                const percent = remaining ? Number(remaining[1].replace(/[<>]/g, '')) : NaN;
                if (battery && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
                  // The native color keeps full precision when a displayed percentage rounds to a boundary.
                  const tone = nativeTone || (percent <= 30 ? 'low' : percent <= 50 ? 'medium' : 'high');
                  field.classList.add(`charge-${tone}`);
                  const gauge = element('span', `report-card-bar report-battery ${tone}`);
                  gauge.setAttribute('role', 'img');
                  gauge.setAttribute('aria-label', `额度剩余 ${remaining[1]}%${tone === 'low' ? '，电量低' : ''}`);
                  for (const segment of battery[1]) gauge.append(element('span', `report-battery-segment${segment === '■' ? ' filled' : ''}`));
                  field.append(gauge);
                } else field.append(appendText(element('span', /^[■□]+$/.test(line.trim()) ? 'report-card-bar' : 'report-card-field-line'), originalLines[index], formatted));
              }
              fields.append(field);
            }
            if (fields.childElementCount) article.append(fields);
          }
        } else if (module.type === 'divider') article.append(element('hr', 'report-card-divider'));
        else if (module.type === 'action-group') {
          const actions = element('div', 'report-card-actions');
          for (const item of (Array.isArray(module.elements) ? module.elements : []).slice(0, 4)) {
            if (item?.type !== 'button' || item.click !== 'link') continue;
            const text = displayText(item.text), href = safeLink(item.value);
            if (text === null || !href) continue;
            const link = element('a', 'button secondary', text);
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            actions.append(link);
          }
          if (actions.childElementCount) article.append(actions);
        }
      }
      if (article.childElementCount) cards.push(article);
    }
    preview.classList.toggle('has-cards', Boolean(cards.length));
    if (cards.length) preview.replaceChildren(...cards);
    else preview.textContent = result.text || result.summary || '暂无可生成预览的额度数据。';
  }

  async function loadPreview() {
    const button = $('#preview-refresh');
    button.disabled = true;
    try { renderReportPreview(await api('report-preview')); }
    catch (error) { if (error.status !== 401 || state.publicAccess) renderReportPreview({ text: `预览暂不可用：${error.message}` }); }
    finally { button.disabled = false; }
  }

  async function loadReports({ quiet = false } = {}) {
    const jobs = [api('reports')];
    if (!quiet || !state.reportingLoaded || !isManaging()) jobs.push(api('report-config'));
    const results = await Promise.allSettled(jobs);
    if (results[0].status === 'fulfilled') renderReports(results[0].value.records || results[0].value.history || []);
    else if ((results[0].reason.status !== 401 || state.publicAccess) && !quiet) $('#report-history').textContent = results[0].reason.message;
    if (results[1]) {
      if (results[1].status === 'fulfilled') { renderReportConfig(results[1].value); state.reportingLoaded = true; }
      else if (results[1].reason.status !== 401 || state.publicAccess) { $('#report-system-error').textContent = results[1].reason.message; $('#report-system-error').hidden = false; }
    }
    if (!quiet) await loadPreview();
  }

  async function showView(view) {
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
    if (state.view === 'key-usage' && view !== 'key-usage') resetKeyQuery({ clearInput: true });
    state.view = view;
    $('#overview-view').hidden = view !== 'overview';
    $('#reports-view').hidden = view !== 'reports';
    $('#key-usage-view').hidden = view !== 'key-usage';
    $('#breadcrumb-title').textContent = view === 'reports' ? '定时播报' : view === 'key-usage' ? 'Key 用量' : '额度总览';
    $$('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
    if (view === 'reports') await loadReports();
    if (view === 'key-usage') await loadKeyPresets();
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button', form);
    button.disabled = true;
    button.textContent = '正在登录…';
    $('#login-error').hidden = true;
    try { await api('session'); const session = await api('login', { method: 'POST', body: { email: form.elements.email.value.trim(), password: form.elements.password.value } }); form.elements.password.value = ''; await showApp(session); }
    catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
    finally { button.disabled = false; button.textContent = '登录'; }
  });
  $('#existing-login').addEventListener('click', async () => {
    const button = $('#existing-login');
    button.disabled = true;
    $('#login-error').hidden = true;
    try {
      let token;
      try { token = localStorage.getItem('auth_token'); } catch { throw new Error('浏览器阻止读取已有登录，请使用邮箱密码登录。'); }
      if (!token) throw new Error('没有找到已有的 Sub2API 登录，请先在原站登录管理员账号，或使用上方邮箱密码。');
      await api('session');
      const session = await api('login', { method: 'POST', body: { token } });
      await showApp(session);
    } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
    finally { button.disabled = false; }
  });
  async function logout() {
    try { await api('logout', { method: 'POST', body: {} }); state.accounts = []; state.snapshot = null; state.reportingLoaded = false; state.csrfToken = null; if (state.publicAccess) location.assign('./'); else showLogin(); }
    catch (error) { if (error.status !== 401) toast(error.message); }
  }
  $('#logout').addEventListener('click', logout);
  $('#mobile-logout').addEventListener('click', logout);
  $('#refresh').addEventListener('click', requestRefresh);
  $('#accounts').addEventListener('click', event => {
    const button = event.target.closest('[data-invite-account]');
    if (button && !button.disabled) void openInvitation(button.dataset.inviteAccount);
  });
  $('#invitation-form').addEventListener('submit', event => { event.preventDefault(); void sendInvitation(); });
  $('#invitation-refresh').addEventListener('click', () => void refreshInvitation());
  $('#invitation-confirm').addEventListener('change', renderInvitation);
  $('#invitation-close').addEventListener('click', () => { if (!invitation.sending) $('#invitation-dialog').close(); });
  $('#invitation-dialog').addEventListener('cancel', event => { if (invitation.sending) event.preventDefault(); });
  $('#invitation-dialog').addEventListener('close', () => {
    invitation.generation++; invitation.id = null; invitation.value = null; invitation.prepared = false;
    invitation.loading = false; invitation.message = ''; $('#invitation-form').reset();
  });
  $('#platform-filters').addEventListener('click', event => { const button = event.target.closest('[data-platform]'); if (!button) return; state.platform = button.dataset.platform; renderSummary(); renderAccounts(); });
  $('#search').addEventListener('input', event => { state.query = event.target.value; renderAccounts(); });
  $('#status-filter').addEventListener('change', event => { state.filter = event.target.value; renderAccounts(); });
  $('#reset-filters').addEventListener('click', () => { state.platform = 'all'; state.query = ''; state.filter = 'all'; $('#search').value = ''; $('#status-filter').value = 'all'; renderSummary(); renderAccounts(); });
  $$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#preview-refresh').addEventListener('click', loadPreview);
  $('#key-query-form').addEventListener('submit', event => { event.preventDefault(); if (!$('#key-query-submit').disabled) queryKeyUsage(); });
  $('#key-query-input').addEventListener('input', () => resetKeyQuery());
  $('#key-query-clear').addEventListener('click', () => { resetKeyQuery({ clearInput: true }); $('#key-query-input').focus(); });
  $('#key-presets').addEventListener('click', event => { const button = event.target.closest('[data-key-preset]'); if (button && !button.disabled) queryKeyUsage(button.dataset.keyPreset); else if (event.target.closest('#key-presets-retry')) loadKeyPresets(); });
  $('#report-form [name=cadence]').addEventListener('change', updateScheduleFields);
  $('#report-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!isManaging()) { toast('播报计划仅供查看，请通过“管理播报”登录后修改。'); return; }
    const form = event.currentTarget;
    const feedback = $('#report-feedback');
    const times = form.elements.cadence.value === 'half-hour' ? [...halfHourTimes] : form.elements.cadence.value === 'quarter-hour' ? [...quarterHourTimes] : [...new Set(form.elements.times.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))];
    if (times.some(value => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) || form.elements.enabled.checked && !times.length || times.length > 96) { feedback.textContent = '开启播报时请输入 1 至 96 个有效时间，例如 09:00, 18:00。'; feedback.className = 'feedback error'; feedback.hidden = false; return; }
    $('#save-report').disabled = true;
    feedback.hidden = true;
    try { const result = await api('report-config', { method: 'POST', body: { enabled: form.elements.enabled.checked, times: times.sort(), timeZone: form.elements.timeZone.value } }); renderReportConfig(result); feedback.textContent = '计划已保存，下次生效。'; feedback.className = 'feedback'; feedback.hidden = false; }
    catch (error) { if (error.status !== 401 || state.publicAccess) { if (!isManaging()) toast('管理登录已过期，仍可公开查看额度与播报计划。'); else { feedback.textContent = error.message; feedback.className = 'feedback error'; feedback.hidden = false; } } }
    finally { $('#save-report').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && canRead()) { loadStatus(); schedulePoll(); } });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  window.addEventListener('pagehide', () => resetKeyQuery({ clearInput: true }));

  async function boot() {
    $('#boot-retry').hidden = true;
    try {
      const session = await api('session');
      state.publicAccess = Boolean(session.publicAccess);
      if (session.authenticated || state.publicAccess && !manageRequested) await showApp(session);
      else showLogin();
    }
    catch (error) {
      $('#boot-view').hidden = false;
      $('#boot-message').textContent = `暂时无法打开看板：${error.message}`;
      $('#boot-retry').hidden = false;
    }
  }
  $('#boot-retry').addEventListener('click', boot);
  boot();
})();
