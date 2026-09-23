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
  const accountLoad = { enabled: null, records: new Map(), checkedAt: null, receivedAt: null, failed: false, error: '', timer: null, controller: null, epoch: 0 };
  const ACCOUNT_LOAD_INTERVAL_MS = 10000;
  const trend = { days: 7, accountId: 'all', metric: 'requests', data: null, key: '', loading: false, error: '', epoch: 0, controller: null, timer: null, receivedAt: null, selectedDate: null, accountOptions: '' };
  const trendMetrics = { requests: { label: '请求', title: '请求数', unit: '次' }, tokens: { label: 'Token', title: 'Token 用量', unit: 'Token' },
    accountCost: { label: 'A 费用', title: '账号计费', unit: 'USD' }, userCost: { label: 'U 费用', title: '用户扣费', unit: 'USD' } };
  const healthView = { query: '', filter: 'all' };
  const healthLabels = { healthy: '正常', limited: '限流中', temporary: '暂不可用', expired: '已到期', error: '异常', disabled: '已关闭', paused: '暂停调度', unknown: '待确认' };
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
  const accountIssue = account => Boolean(account.error || ['error', 'disabled', 'inactive', 'rate_limited'].includes(account.status) ||
    ['limited', 'temporary', 'expired', 'error'].includes(account.health?.state));
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
    pauseAccountLoad();
    pauseTrends();
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
    void refreshAccountLoad();
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

  function beijingDay(now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const trendKey = () => `${trend.days}:${trend.accountId}:${beijingDay()}`;
  const trendValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const trendCost = metric => metric === 'accountCost' || metric === 'userCost';
  function trendFormat(value, metric, exact = false) {
    if (!trendValue(value)) return '未知';
    if (trendCost(metric)) return `$${exact ? value > 0 && value < 0.000001 ? '<0.000001' : number(value, 6) : moneyNumber(value)}`;
    return exact ? number(value, 0) : compact(value);
  }
  function trendInterval() { return Number.isFinite(trend.data?.refreshIntervalMs) && trend.data.refreshIntervalMs >= 60000 && trend.data.refreshIntervalMs <= 3600000 ? trend.data.refreshIntervalMs : 300000; }
  function pauseTrends() {
    clearTimeout(trend.timer); trend.timer = null; trend.epoch++;
    const controller = trend.controller; trend.controller = null; controller?.abort(); trend.loading = false;
  }
  function scheduleTrends() {
    clearTimeout(trend.timer); trend.timer = null;
    if (state.view === 'trends' && !document.hidden && canRead() && !$('#app-view').hidden) {
      const age = trend.receivedAt === null ? 0 : Math.max(0, performance.now() - trend.receivedAt);
      const now = Date.now(), midnight = Date.parse(`${beijingDay(now)}T00:00:00+08:00`) + 86400000;
      const delay = trend.error ? trendInterval() : Math.max(1000, trendInterval() - age);
      trend.timer = setTimeout(() => { void loadTrends({ force: true }); }, Math.min(delay, Math.max(1, midnight - now)));
    }
  }
  function syncTrendAccounts() {
    const accounts = [...state.accounts].sort(compareAccounts);
    const options = '<option value="all">全站（含历史账号）</option>' + accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name || `账号 ${account.id}`)} · #${escapeHtml(account.id)}</option>`).join('');
    if (options !== trend.accountOptions) { $('#trend-account').innerHTML = options; trend.accountOptions = options; }
    if (trend.accountId !== 'all' && !accounts.some(account => String(account.id) === trend.accountId)) {
      pauseTrends(); trend.accountId = 'all'; trend.data = null; trend.key = ''; trend.receivedAt = null;
      if (state.view === 'trends') void loadTrends();
    }
    $('#trend-account').value = trend.accountId;
  }
  async function loadTrends({ force = false } = {}) {
    if (state.view !== 'trends' || document.hidden || !canRead()) return;
    const key = trendKey();
    if (trend.loading && trend.key === key && !force) return;
    if (!force && trend.data && trend.key === key && !trend.error && performance.now() - trend.receivedAt < trendInterval()) { renderTrends(); scheduleTrends(); return; }
    pauseTrends();
    if (trend.key !== key) { trend.data = null; trend.receivedAt = null; }
    trend.key = key; trend.loading = true; trend.error = '';
    const controller = new AbortController(), epoch = trend.epoch;
    const days = trend.days, accountId = trend.accountId;
    trend.controller = controller; renderTrends();
    try {
      const result = await api(`usage-trends?${new URLSearchParams({ days: String(days), accountId })}`, { signal: controller.signal });
      if (epoch !== trend.epoch || controller.signal.aborted || key !== trendKey()) return;
      if (result.days !== days || String(result.accountId) !== accountId || result.timeZone !== 'Asia/Shanghai' || !Array.isArray(result.rows)) throw new Error('趋势数据与当前筛选不匹配，请刷新重试。');
      const rows = [...new Map(result.rows.filter(row => row && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)).map(row => [row.date, row])).values()].sort((left, right) => left.date.localeCompare(right.date));
      trend.data = { ...result, rows }; trend.receivedAt = performance.now();
      if (!rows.some(row => row.date === trend.selectedDate)) trend.selectedDate = rows.at(-1)?.date || null;
    } catch (error) {
      if (epoch === trend.epoch && !controller.signal.aborted) trend.error = error.message || '趋势暂不可用，请稍后重试。';
    } finally {
      if (epoch === trend.epoch) {
        trend.loading = false; trend.controller = null;
        if (key !== trendKey()) void loadTrends();
        else { renderTrends(); scheduleTrends(); }
      }
    }
  }
  function renderTrends() {
    if (state.view !== 'trends') return;
    syncTrendAccounts();
    $('#trend-refresh').disabled = trend.loading;
    $('#trend-refresh').textContent = trend.loading ? '读取中…' : '刷新趋势';
    $$('[data-trend-days]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.trendDays) === trend.days)));
    $$('[data-trend-metric]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.trendMetric === trend.metric)));
    const data = trend.data, metric = trendMetrics[trend.metric];
    $('#trend-period').textContent = data ? `${data.startDate} — ${data.endDate} · 北京时间` : `近 ${trend.days} 天 · 北京时间 · 含今日`;
    const notices = [trend.error ? `${trend.error}${data ? ' 保留上次结果。' : ''}` : '', data?.stale ? '含旧数据。' : '', data && !data.complete ? '部分日期未取得完整数据。' : '', typeof data?.lastError === 'string' ? data.lastError : ''].filter(Boolean);
    $('#trend-feedback').hidden = !notices.length; $('#trend-feedback').textContent = notices.join(' ');
    $('#trend-summary').innerHTML = Object.entries(trendMetrics).map(([key, value]) => `<div class="trend-total" title="${escapeHtml(trendCost(key) ? `${value.title}，USD；不是余额。` : value.title)}"><span>${value.label}</span><strong>${escapeHtml(trendFormat(data?.totals?.[key], key))}</strong>${data && !data.complete ? '<small>不完整</small>' : ''}</div>`).join('');
    $('#trend-chart-title').textContent = `每日${metric.title}`;
    const today = beijingDay();
    $('#trend-updated').textContent = data?.checkedAt ? `更新 ${formatTime(data.checkedAt)}${data.endDate === today ? ' · 今日未结束' : ''} · 图中空缺表示未知` : trend.loading ? '正在读取每日用量…' : '尚无成功读取记录';
    const rows = data?.rows || [];
    $('#trend-row-count').textContent = `${rows.length} 天`;
    $('#trend-table-body').innerHTML = rows.length ? [...rows].reverse().map(row => `<tr data-trend-row="${row.date}"><th scope="row"><button type="button" data-trend-select="${row.date}">${row.date.slice(5).replace('-', '/')}</button>${row.date === today ? '<small class="trend-row-today" title="今日未结束">今日</small>' : ''}${row.stale ? '<small class="trend-row-warning">旧</small>' : row.error ? '<small class="trend-row-warning">缺</small>' : ''}</th>${Object.keys(trendMetrics).map(key => `<td title="${escapeHtml(`${trendMetrics[key].title}：${trendFormat(row[key], key, true)}${trendCost(key) ? ' USD' : ''}${row.error ? ` · ${row.error}` : ''}`)}">${escapeHtml(trendFormat(row[key], key))}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="5" class="trend-empty">暂无每日明细</td></tr>';
    renderTrendChart(rows);
    selectTrendDay(trend.selectedDate);
  }
  function renderTrendChart(rows) {
    const host = $('#trend-chart'), values = rows.map(row => trendValue(row[trend.metric]) ? row[trend.metric] : null);
    if (!rows.length || !values.some(value => value !== null)) {
      host.innerHTML = `<div class="trend-chart-empty">${trend.loading ? '正在读取趋势…' : '暂无可绘制的用量数据'}</div>`; return;
    }
    const peak = Math.max(...values.filter(value => value !== null));
    const maximum = trendCost(trend.metric) ? peak || 1 : Math.max(4, Math.ceil(peak / 4) * 4);
    const point = (value, index) => ({ x: rows.length === 1 ? 500 : 20 + index / (rows.length - 1) * 960, y: 196 - value / maximum * 184 });
    const segments = []; let segment = [];
    values.forEach((value, index) => { if (value === null) { if (segment.length) segments.push(segment); segment = []; } else segment.push(point(value, index)); });
    if (segment.length) segments.push(segment);
    const paths = segments.map(points => {
      const line = points.map((item, index) => `${index ? 'L' : 'M'}${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(' ');
      return `<path d="${line} L${points.at(-1).x},196 L${points[0].x},196 Z" fill="url(#trend-area-fill)"/><path d="${line}" class="trend-line"/>`;
    }).join('');
    const axis = Array.from({ length: 5 }, (_, index) => maximum * (4 - index) / 4);
    const labels = [...new Set(Array.from({ length: Math.min(5, rows.length) }, (_, index) => Math.round(index * (rows.length - 1) / Math.max(1, Math.min(5, rows.length) - 1))))];
    host.dataset.metric = trend.metric;
    host.innerHTML = `<div class="trend-y-axis">${axis.map(value => `<span title="${escapeHtml(String(value))}">${escapeHtml(trendCost(trend.metric) ? `$${value > 0 && value < 0.0001 ? '<0.0001' : value >= 1000 ? compact(value) : number(value, 4)}` : compact(value))}</span>`).join('')}</div><div class="trend-plot-area"><div class="trend-plot"><svg viewBox="0 0 1000 208" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="trend-area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--trend-color)" stop-opacity=".24"/><stop offset="1" stop-color="var(--trend-color)" stop-opacity=".015"/></linearGradient></defs>${axis.map((_, index) => `<line x1="0" x2="1000" y1="${12 + index * 46}" y2="${12 + index * 46}" class="trend-grid-line"/>`).join('')}${paths}</svg>${rows.map((row, index) => {
      const position = point(values[index] || 0, index), label = `${row.date}，${trendMetrics[trend.metric].title} ${trendFormat(values[index], trend.metric, true)}${row.stale ? '，旧数据' : ''}`;
      return `<button type="button" class="trend-hit${values[index] === null ? ' missing' : ''}${row.stale ? ' stale' : ''}" data-trend-day="${row.date}" style="left:${position.x / 10}%;width:${Math.min(14, 100 / rows.length)}%" aria-label="${escapeHtml(label)}"><span class="trend-dot" style="top:${position.y}px"></span></button>`;
    }).join('')}</div><div class="trend-x-axis">${labels.map(index => `<span>${rows[index].date.slice(5).replace('-', '/')}</span>`).join('')}</div></div>`;
  }
  function selectTrendDay(date, focus = false) {
    const rows = trend.data?.rows || [], index = rows.findIndex(row => row.date === date), row = rows[index];
    trend.selectedDate = row?.date || null;
    $$('[data-trend-day]').forEach(button => { const selected = button.dataset.trendDay === trend.selectedDate; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    $$('[data-trend-row]').forEach(item => item.classList.toggle('selected', item.dataset.trendRow === trend.selectedDate));
    $('#trend-selection').textContent = row ? `${row.date} · ${trendMetrics[trend.metric].label} ${trendFormat(row[trend.metric], trend.metric, true)}${row.stale ? ' · 旧数据' : row.error ? ' · 未完整更新' : ''}` : '选择日期查看用量';
    $('#trend-previous').disabled = index <= 0; $('#trend-next').disabled = index < 0 || index >= rows.length - 1;
    if (focus && row) $(`[data-trend-day="${row.date}"]`)?.focus();
  }
  function stepTrendDay(step, focus = false) {
    const rows = trend.data?.rows || [], index = rows.findIndex(row => row.date === trend.selectedDate);
    if (rows.length) selectTrendDay(rows[Math.max(0, Math.min(rows.length - 1, index + step))].date, focus);
  }

  function accountHealth(account) {
    const health = account.health || {}, known = Object.hasOwn(healthLabels, health.state);
    const fresh = health.freshness === 'fresh' && typeof health.observedAt === 'string' && Number.isFinite(Date.parse(health.observedAt));
    const status = known ? health.state : 'unknown';
    const category = !fresh || status === 'unknown' ? 'unknown' : status === 'healthy' ? 'healthy' : ['disabled', 'paused'].includes(status) ? 'paused' : 'attention';
    return { ...health, state: status, label: known ? healthLabels[status] : '待确认', category, fresh };
  }
  function accountHealthHtml(account) {
    if (!account.health) return '';
    const health = accountHealth(account), label = health.fresh ? health.label : '待确认';
    return `<button type="button" class="account-health-link" data-health-account="${escapeHtml(account.id)}" data-health-tone="${health.category}" title="${escapeHtml(health.fresh ? health.reason || label : '状态记录待更新')}" aria-label="查看 ${escapeHtml(account.name || account.id)} 的账号健康">${label}</button>`;
  }
  function renderHealth() {
    if (state.view !== 'health') return;
    const categories = { healthy: '正常', attention: '需关注', paused: '关闭 / 暂停', unknown: '待确认' };
    const items = state.accounts.map(account => ({ account, health: accountHealth(account) }));
    $('#health-summary').innerHTML = Object.entries(categories).map(([key, label]) => `<div class="health-total" data-health-tone="${key}"><span>${label}</span><strong>${items.filter(item => item.health.category === key).length}</strong></div>`).join('');
    const query = healthView.query.trim().toLowerCase(), categoryOrder = { attention: 0, unknown: 1, paused: 2, healthy: 3 }, statusOrder = ['error', 'expired', 'limited', 'temporary', 'unknown', 'paused', 'disabled', 'healthy'];
    const selected = items.filter(({ account, health }) => (healthView.filter === 'all' || health.category === healthView.filter) && (!query || [account.id, account.name, accountPlan(account).label, platformInfo(account).name].join(' ').toLowerCase().includes(query)))
      .sort((left, right) => categoryOrder[left.health.category] - categoryOrder[right.health.category] || statusOrder.indexOf(left.health.state) - statusOrder.indexOf(right.health.state) || compareAccounts(left.account, right.account));
    $('#health-count').textContent = `${selected.length} / ${items.length}`;
    $('#health-refresh').disabled = state.refreshing; $('#health-refresh').textContent = state.refreshing ? '更新中…' : '刷新数据';
    $('#health-updated').textContent = state.snapshot?.updatedAt ? `账号记录更新于 ${formatTime(state.snapshot.updatedAt)} · 异常优先` : '等待账号状态记录';
    $('#health-list').innerHTML = selected.length ? selected.map(({ account, health }) => {
      const reason = typeof health.reason === 'string' ? health.reason : '等待新的账号状态观测。';
      const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? formatTime(value) : '未知';
      const issues = Array.isArray(health.issues) ? health.issues.filter(issue => issue && typeof issue.label === 'string') : [];
      return `<article class="health-row" data-health-id="${escapeHtml(account.id)}" data-health-tone="${health.category}"><div class="health-row-heading"><div><h2>${escapeHtml(account.name || `账号 ${account.id}`)}</h2><p>${escapeHtml(platformInfo(account).name)} · ${escapeHtml(accountPlan(account).label)} · #${escapeHtml(account.id)}</p></div><span class="health-state">${health.fresh ? health.label : '待确认'}</span></div><p class="health-reason">${escapeHtml(health.fresh ? reason : `上次记录：${health.label}。${health.freshness === 'stale' ? '旧数据，等待刷新确认。' : '采样时间未知，等待刷新确认。'}`)}</p>${issues.length ? `<div class="health-issues">${issues.map(issue => `<span title="${escapeHtml(issue.until ? `记录时间：${stamp(issue.until)}` : '')}">${escapeHtml(issue.label)}</span>`).join('')}</div>` : ''}<dl class="health-times"><div><dt>最近使用</dt><dd>${escapeHtml(stamp(health.lastUsedAt))}</dd></div><div><dt>预计恢复</dt><dd>${health.recoverAt ? escapeHtml(stamp(health.recoverAt)) : '—'}</dd></div><div><dt>配置到期</dt><dd>${escapeHtml(stamp(health.expiresAt))}</dd></div></dl><div class="health-row-footer"><span>采样 ${escapeHtml(stamp(health.observedAt))}${health.freshness === 'stale' ? ' · 旧数据' : ''}</span><button class="button text" type="button" data-quota-account="${escapeHtml(account.id)}">查看额度 →</button></div></article>`;
    }).join('') : '<div class="health-empty">没有匹配的账号</div>';
  }
  async function showAccountHealth(id) {
    const account = state.accounts.find(item => String(item.id) === id);
    healthView.filter = 'all'; healthView.query = account?.name || id;
    $('#health-filter').value = 'all'; $('#health-search').value = healthView.query;
    await showView('health'); $(`[data-health-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function showAccountQuota(id) {
    state.platform = 'all'; state.filter = 'all'; state.query = ''; $('#search').value = ''; $('#status-filter').value = 'all';
    renderSummary(); renderAccounts(); await showView('overview');
    const card = $(`[data-account-id="${CSS.escape(id)}"]`);
    if (card) { const details = $('details', card); if (details) { details.open = true; expandedAccounts.add(id); } card.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  function canReadAccountLoad() { return canRead() && !document.hidden && !$('#app-view').hidden; }
  function pauseAccountLoad() {
    clearTimeout(accountLoad.timer); accountLoad.timer = null; accountLoad.epoch++;
    const controller = accountLoad.controller; accountLoad.controller = null; controller?.abort();
  }
  function scheduleAccountLoad() {
    clearTimeout(accountLoad.timer); accountLoad.timer = null;
    if (canReadAccountLoad()) accountLoad.timer = setTimeout(() => { void refreshAccountLoad(); }, ACCOUNT_LOAD_INTERVAL_MS);
  }
  async function refreshAccountLoad() {
    if (!canReadAccountLoad() || accountLoad.controller) return;
    clearTimeout(accountLoad.timer); accountLoad.timer = null;
    const controller = new AbortController(), epoch = accountLoad.epoch;
    accountLoad.controller = controller;
    renderAccountLoads();
    const current = () => accountLoad.controller === controller && accountLoad.epoch === epoch;
    try {
      const result = await api('account-load', { signal: controller.signal, timeoutMs: 9000 });
      if (!current()) return;
      if (typeof result.enabled !== 'boolean' || result.enabled && !Array.isArray(result.accounts)) throw new Error('负载数据暂不可用。');
      accountLoad.enabled = result.enabled;
      const records = new Map((result.enabled ? result.accounts : []).filter(record => record && ['string', 'number'].includes(typeof record.id)).map(record => [String(record.id), record]));
      if (result.enabled && result.lastError) {
        for (const [id, previous] of accountLoad.records) if (!records.has(id)) records.set(id, previous);
      }
      accountLoad.records = records;
      accountLoad.checkedAt = result.checkedAt || null; accountLoad.receivedAt = performance.now();
      accountLoad.failed = Boolean(result.lastError);
      accountLoad.error = typeof result.lastError === 'string' ? result.lastError : result.lastError?.message || '';
      renderAccountLoads();
    } catch (error) {
      if (current() && !controller.signal.aborted) {
        accountLoad.failed = true; accountLoad.error = error.message || '负载数据暂不可用。';
        renderAccountLoads();
      }
    } finally {
      if (current()) { accountLoad.controller = null; scheduleAccountLoad(); }
    }
  }
  function accountLoadHtml(account) {
    return `<div class="account-load" data-account-load="${escapeHtml(account.id)}" hidden><span class="account-load-label">并发</span><strong data-load-value>未知 / 未知</strong><span class="account-load-track" data-load-bar role="progressbar" aria-label="账号并发负载" aria-valuemin="0" aria-valuemax="100"><i></i></span><span class="account-load-status" data-load-status>未知</span></div>`;
  }
  function renderAccountLoads() {
    const show = accountLoad.enabled === true || accountLoad.enabled === null && accountLoad.failed;
    const oldRead = accountLoad.receivedAt !== null && performance.now() - accountLoad.receivedAt > 3 * ACCOUNT_LOAD_INTERVAL_MS;
    const hint = $('#account-load-hint');
    hint.hidden = !show;
    hint.textContent = `负载每10秒更新${accountLoad.failed ? ' · 暂不可用' : oldRead ? ' · 旧数据' : ''}`;
    hint.title = [accountLoad.checkedAt ? `最近检查：${formatTime(accountLoad.checkedAt, { second: '2-digit' })}（北京时间）` : '检查时间未知', accountLoad.error].filter(Boolean).join('\n');
    for (const node of $$('[data-account-load]')) {
      node.hidden = !show;
      if (!show) continue;
      const record = accountLoad.records.get(node.dataset.accountLoad);
      const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      const used = validCount(record?.current) ? record.current : null;
      const limit = validCount(record?.limit) && record.limit > 0 ? record.limit : null;
      const known = used !== null && limit !== null;
      const percent = known ? used / limit * 100 : null;
      const hasTime = typeof record?.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt));
      const sampleAge = hasTime ? Date.now() - Date.parse(record.observedAt) : null;
      const stale = Boolean(record && (accountLoad.failed || oldRead || record.freshness === 'stale' || hasTime && sampleAge > 3 * ACCOUNT_LOAD_INTERVAL_MS));
      const fresh = record?.freshness === 'fresh' && hasTime && sampleAge >= -3 * ACCOUNT_LOAD_INTERVAL_MS && !stale;
      const level = !known ? 'unknown' : used === 0 ? 'idle' : percent >= 100 ? 'full' : percent >= 80 ? 'busy' : 'normal';
      const labels = { unknown: '未知', idle: '空闲', normal: '正常', busy: '繁忙', full: '满载' };
      const label = accountLoad.failed && !record ? '暂不可用' : stale ? '旧数据' : !known ? '未知' : !fresh ? '时间未知' : labels[level];
      const tone = stale ? 'stale' : fresh && known ? level : 'unknown';
      $('[data-load-value]', node).textContent = `${used === null ? '未知' : number(used, 0)} / ${limit === null ? '未知' : number(limit, 0)}`;
      $('[data-load-status]', node).textContent = label;
      node.dataset.loadState = tone;
      const bar = $('[data-load-bar]', node), width = known ? Math.min(100, Math.max(0, percent)) : 0;
      $('i', bar).style.width = `${width}%`;
      if (known) bar.setAttribute('aria-valuenow', String(width)); else bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-valuetext', `${label}，当前并发${used === null ? '未知' : used}，上限${limit === null ? '未知' : limit}`);
      node.title = ['上限为 Sub2API 配置的并发上限，不是上游套餐限额。',
        hasTime ? `采样：${formatTime(record.observedAt, { second: '2-digit' })}（北京时间）` : '采样时间未知。',
        stale ? '显示上次记录，当前负载尚未确认。' : !fresh ? '尚未取得可确认的新样本。' : known ? `负载：${number(percent, 1)}%` : '缺少有效并发数或上限；未知不代表空闲或无限制。',
        accountLoad.error].filter(Boolean).join('\n');
    }
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
    const notices = [stale ? '<span class="warning">旧缓存 · 非实时额度</span>' : '', account.quotaQuery?.message ? `<span class="warning">${escapeHtml(account.quotaQuery.message)}</span>` : '', issue ? `<span class="error" title="${escapeHtml(error || account.health?.reason || account.status)}">${escapeHtml(error ? String(error).slice(0, 52) + (String(error).length > 52 ? '…' : '') : healthLabels[account.health?.state] || '账号异常')}</span>` : ''].filter(Boolean).join('');
    const unknown = !known ? '<div class="unknown-block"><span>上游额度未知</span><small>未知 ≠ 0</small></div>' : !primary.length ? '<div class="unknown-block"><span>产品用量见详情</span></div>' : '';
    const metrics = primary.map(metric => `<div class="quota-window">${metricHtml(metric)}${windows.filter(window => window.metricKey && window.metricKey === metric.key).map(window => windowStatsHtml(window, { matched: true })).join('')}</div>`).join('') + windows.filter(window => !window.metricKey || !primaryKeys.has(window.metricKey)).map(window => `<div class="unmatched-window-stats">${windowStatsHtml(window)}</div>`).join('');
    return `<article class="account-card ${stale ? 'stale' : ''} ${issue ? 'has-error' : ''}" data-account-id="${escapeHtml(account.id)}"><div class="account-header"><span class="provider-icon ${escapeHtml(Object.hasOwn(providers, platformKey(account)) ? platformKey(account) : '')}">${escapeHtml(provider.icon)}</span><div class="account-title"><h3 title="${escapeHtml(account.name)}">${escapeHtml(account.name || `账号 ${account.id}`)}</h3><p class="account-meta"><span>${escapeHtml(provider.name)}</span><span class="account-plan${plan.label === '版本未知' ? ' unknown' : ''}" title="${escapeHtml(`${plan.label} · ${plan.source}`)}">${escapeHtml(plan.label)}</span><span class="account-id">#${escapeHtml(account.id)}</span>${accountHealthHtml(account)}</p></div><span class="account-scheduling ${scheduling[0]}" data-account-scheduling="${scheduling[0]}" title="Sub2API 参与调度状态，仅展示；开启不代表账号当前一定可用。"><span aria-hidden="true">●</span>${scheduling[1]}</span></div>${accountLoadHtml(account)}${creditPanelsHtml(account)}${invitationHtml(account)}${notices ? `<div class="account-notices">${notices}</div>` : ''}<div class="metrics">${unknown}${metrics}</div>${accountDetailsHtml(account, secondary)}</article>`;
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
    renderAccountLoads();
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
    syncTrendAccounts(); renderHealth();
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
    if (state.view === 'trends' && view !== 'trends') pauseTrends();
    state.view = view;
    $('#overview-view').hidden = view !== 'overview';
    $('#reports-view').hidden = view !== 'reports';
    $('#key-usage-view').hidden = view !== 'key-usage';
    $('#trends-view').hidden = view !== 'trends';
    $('#health-view').hidden = view !== 'health';
    $('#breadcrumb-title').textContent = ({ overview: '额度总览', reports: '定时播报', 'key-usage': 'Key 用量', trends: '每日趋势', health: '账号健康' })[view] || '额度总览';
    $$('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
    if (view === 'reports') await loadReports();
    if (view === 'key-usage') await loadKeyPresets();
    if (view === 'health') renderHealth();
    if (view === 'trends') { syncTrendAccounts(); await loadTrends(); }
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
    const health = event.target.closest('[data-health-account]');
    if (health) void showAccountHealth(health.dataset.healthAccount);
  });
  $$('[data-trend-days]').forEach(button => button.addEventListener('click', () => {
    const days = Number(button.dataset.trendDays); if (![7, 30].includes(days) || days === trend.days) return;
    trend.days = days; void loadTrends();
  }));
  $('#trend-account').addEventListener('change', event => { trend.accountId = event.target.value || 'all'; void loadTrends(); });
  $('#trend-metrics').addEventListener('click', event => {
    const button = event.target.closest('[data-trend-metric]');
    if (button && Object.hasOwn(trendMetrics, button.dataset.trendMetric)) { trend.metric = button.dataset.trendMetric; renderTrends(); }
  });
  $('#trend-refresh').addEventListener('click', () => void loadTrends({ force: true }));
  $('#trend-chart').addEventListener('pointerover', event => { const point = event.target.closest('[data-trend-day]'); if (point) selectTrendDay(point.dataset.trendDay); });
  $('#trend-chart').addEventListener('focusin', event => { const point = event.target.closest('[data-trend-day]'); if (point) selectTrendDay(point.dataset.trendDay); });
  $('#trend-chart').addEventListener('click', event => { const point = event.target.closest('[data-trend-day]'); if (point) selectTrendDay(point.dataset.trendDay); });
  $('#trend-chart').addEventListener('keydown', event => {
    if (!event.target.closest('[data-trend-day]') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); stepTrendDay(event.key === 'ArrowLeft' ? -1 : 1, true);
  });
  $('#trend-table-body').addEventListener('click', event => { const button = event.target.closest('[data-trend-select]'); if (button) selectTrendDay(button.dataset.trendSelect); });
  $('#trend-previous').addEventListener('click', () => stepTrendDay(-1));
  $('#trend-next').addEventListener('click', () => stepTrendDay(1));
  $('#health-search').addEventListener('input', event => { healthView.query = event.target.value; renderHealth(); });
  $('#health-filter').addEventListener('change', event => { healthView.filter = event.target.value; renderHealth(); });
  $('#health-refresh').addEventListener('click', requestRefresh);
  $('#health-list').addEventListener('click', event => { const button = event.target.closest('[data-quota-account]'); if (button) void showAccountQuota(button.dataset.quotaAccount); });
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseAccountLoad(); pauseTrends(); }
    else if (canRead()) { loadStatus(); schedulePoll(); void refreshAccountLoad(); if (state.view === 'trends') void loadTrends(); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  window.addEventListener('pagehide', () => { resetKeyQuery({ clearInput: true }); pauseAccountLoad(); pauseTrends(); });

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
