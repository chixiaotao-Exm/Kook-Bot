'use strict';

window.createOpsPanel = function(root = document, options = {}) {
  const $ = selector => root.querySelector(selector);
  const $$ = selector => [...root.querySelectorAll(selector)];
  let active = true, navigationGeneration = 0;
  const hidden = () => document.hidden || !active;
  const state = { authenticated: false, canManage: false, publicManagement: false, csrf: '', user: null, data: null, epoch: 0, view: 'overview',
    loading: false, failed: false, poll: null, aging: null, snapshotController: null, controllers: new Set(),
    mutation: null, restart: null, uncertainRestarts: new Map(), toastTimer: null };
  const clock = { wall: Date.now(), tick: performance.now() };
  const views = {
    overview: ['概览', '运行概览', '随时掌握基础设施与业务运行状态。'],
    hosts: ['服务器', '服务器资源', '查看实时资源、运行进程与维护状态。'],
    web: ['网站与接口', '网站与接口', '跟踪可达性、响应延迟与证书有效期。'],
    bots: ['机器人', '机器人总管', '消息在线、语音连接与播放状态集中查看。'],
    events: ['事件记录', '事件与操作', '核对异常恢复、通知和服务重启结果。'],
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
  const list = value => Array.isArray(value) ? value : [];
  const text = (value, fallback = '', maximum = 300) => typeof value === 'string' && value ? value.slice(0, maximum) : fallback;
  const time = value => typeof value === 'string' && value ? Date.parse(value) : NaN;
  const stamp = value => Number.isFinite(time(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '时间未知';

  // Pure display projections are also exercised by offline UI regressions.
  function currentTime() {
    const tick = performance.now(); clock.wall = Math.max(Date.now(), clock.wall + Math.max(0, tick - clock.tick)); clock.tick = tick;
    return clock.wall;
  }
  function observedFresh(value, maximumAge, now) {
    const age = now - time(value);
    return Number.isFinite(age) && age >= -60000 && age <= maximumAge;
  }
  function hostState(host, now = currentTime()) {
    const fresh = observedFresh(host.observedAt, 120000, now) && observedFresh(host.lastSeenAt, 120000, now);
    if (!fresh) return { state: 'unknown', label: '待确认', tone: '', fresh: false };
    if (host.maintenance === true || host.state === 'maintenance') return { state: 'maintenance', label: '维护中', tone: 'maintenance', fresh: true };
    if (host.state === 'up') return { state: 'up', label: '在线', tone: 'good', fresh: true };
    if (host.state === 'down') return { state: 'down', label: '异常', tone: 'bad', fresh: true };
    return { state: 'unknown', label: '待确认', tone: '', fresh: true };
  }
  function monitorState(monitor, now = currentTime()) {
    const fresh = observedFresh(monitor.checkedAt, 150000, now);
    if (!fresh) return { state: 'unknown', label: '待确认', tone: '', fresh: false };
    if (monitor.maintenance === true || monitor.state === 'maintenance') return { state: 'maintenance', label: '维护中', tone: 'maintenance', fresh: true };
    if (monitor.state === 'up') return { state: 'up', label: '正常', tone: 'good', fresh: true };
    if (monitor.state === 'down') return { state: 'down', label: '异常', tone: 'bad', fresh: true };
    return { state: 'unknown', label: '待确认', tone: '', fresh: true };
  }
  function botState(bot, host, now = currentTime()) {
    const parent = hostState(host, now);
    if (!parent.fresh || parent.state === 'unknown') return { state: 'unknown', label: '待确认', tone: '', fresh: false };
    if (bot.state === 'stopped') return { state: 'stopped', label: '计划停用', tone: '', fresh: true };
    if (bot.state === 'online' && bot.health === 'degraded') return { state: 'degraded', label: '异常', tone: 'bad', fresh: true };
    if (bot.state === 'online' && bot.health === 'unknown') return { state: 'unknown', label: '待确认', tone: '', fresh: true };
    if (bot.state === 'online') return { state: 'online', label: '在线', tone: 'good', fresh: true };
    if (bot.state === 'offline') return { state: 'offline', label: '离线', tone: 'bad', fresh: true };
    return { state: 'unknown', label: '待确认', tone: '', fresh: true };
  }
  function serviceState(service, host, now = currentTime()) {
    const parent = hostState(host, now);
    if (!parent.fresh || parent.state === 'unknown') return { label: '待确认', tone: '' };
    if (service.expected === 'stopped') return service.activeState === 'active'
      ? { label: '计划停用 · 仍运行', tone: 'warn' } : { label: '计划停用', tone: '' };
    return service.ok === true ? { label: '运行中', tone: 'good' }
      : ['failed', 'inactive'].includes(service.activeState) ? { label: '异常', tone: 'bad' } : { label: '待确认', tone: '' };
  }
  function monitorLink(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      url.search = ''; url.hash = '';
      return { href: url.href, label: url.host + url.pathname };
    } catch { return null; }
  }
  function sparkline(history, field, ceiling = 100) {
    const entries = list(history).slice(-32), values = entries.map(point => point?.[field]);
    if (!values.some(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return '<svg class="sparkline" viewBox="0 0 180 30" aria-label="暂无趋势数据"><path class="baseline" d="M0 27H180"/></svg>';
    const paths = []; let segment = [];
    values.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { if (segment.length) paths.push(segment.join(' ')); segment = []; return; }
      const x = values.length === 1 ? 90 : index / (values.length - 1) * 180, y = 27 - Math.min(ceiling, value) / ceiling * 23;
      segment.push(`${segment.length ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
    });
    if (segment.length) paths.push(segment.join(' '));
    return `<svg class="sparkline" viewBox="0 0 180 30" role="img" aria-label="最近资源用量趋势"><path class="baseline" d="M0 27H180"/><path d="${paths.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  // End pure display projections.

  const badge = value => `<span class="badge ${value.tone}">${escapeHtml(value.label)}</span>`;
  const empty = (title, subtitle = '') => `<div class="empty"><span class="empty-icon" aria-hidden="true">◇</span><strong>${escapeHtml(title)}</strong>${escapeHtml(subtitle)}</div>`;
  function toast(message, error = false) {
    clearTimeout(state.toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
  }
  function pausePolling() {
    clearTimeout(state.poll); clearTimeout(state.aging); state.poll = null; state.aging = null;
    state.snapshotController?.abort(); state.snapshotController = null; state.loading = false;
  }
  function loseSession(message = '') {
    state.epoch++; state.authenticated = false; state.canManage = false; state.csrf = ''; state.user = null; state.data = null; state.restart = null; state.mutation = null;
    pausePolling(); for (const controller of state.controllers) controller.abort(); state.controllers.clear();
    if ($('#restart-dialog').open) $('#restart-dialog').close();
    $('#boot-view').hidden = true; $('#app-view').hidden = true; $('#login-view').hidden = false;
    $('#login-password').value = ''; $('#login-submit').disabled = false;
    $('#login-error').textContent = message; $('#login-error').hidden = !message;
    options.onSession?.(false, null, { publicManagement: state.publicManagement });
  }
  async function api(route, { method = 'GET', body, signal, timeoutMs = 12000, csrf = state.csrf, epoch = state.epoch } = {}) {
    const controller = new AbortController(); state.controllers.add(controller);
    const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(`${options.apiBase || './api/'}${route}`, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let data;
      try { data = await response.json(); }
      catch {
        if (![400, 401, 403].includes(response.status)) throw Error('服务器响应无效。');
        data = { error: '登录状态已失效，请重新登录。' };
      }
      if (controller.signal.aborted || epoch !== state.epoch) throw Object.assign(Error('请求已取消'), { name: 'AbortError' });
      if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || '操作未完成，请稍后重试。';
        const error = Object.assign(Error(String(message).slice(0, 300)), { status: response.status });
        if ([400, 401, 403].includes(response.status) && route !== 'logout') loseSession(error.message);
        throw error;
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch) throw Object.assign(Error('请求已取消'), { name: 'AbortError' });
      if (Number.isInteger(error.status)) throw error;
      throw Error('服务暂时不可用，请稍后重试。');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); state.controllers.delete(controller); }
  }
  function beginSession(result) {
    if (!(result?.authenticated === true || result?.publicManagement === true && result?.canManage === true) || typeof result.csrf !== 'string' || !result.csrf) throw Error('登录状态无法确认，请重新登录。');
    state.authenticated = result.authenticated === true; state.publicManagement = result.publicManagement === true; state.canManage = true; state.csrf = result.csrf; state.user = result.user || null;
    $('#boot-view').hidden = true; $('#login-view').hidden = true; $('#app-view').hidden = false;
    $('#user-name').textContent = state.publicManagement ? '访客模式' : text(result.user?.email || result.user?.name, '管理员', 254);
    options.onSession?.(state.authenticated, result.user, { publicManagement: state.publicManagement });
    showView(state.view); void loadSnapshot();
  }
  function schedulePoll() {
    clearTimeout(state.poll); state.poll = null;
    if (state.canManage && !hidden()) state.poll = setTimeout(() => void loadSnapshot(), 15000);
  }
  function scheduleAging() {
    clearTimeout(state.aging); state.aging = null;
    if (!state.canManage || hidden() || !state.data) return;
    const now = currentTime(); let delay = 5000;
    for (const host of state.data.hosts) for (const observed of [host.observedAt, host.lastSeenAt]) { const expires = time(observed) + 120001; if (expires > now) delay = Math.min(delay, expires - now); }
    for (const monitor of state.data.monitors) { const expires = time(monitor.checkedAt) + 150001; if (expires > now) delay = Math.min(delay, expires - now); }
    state.aging = setTimeout(() => { render(); scheduleAging(); }, Math.max(1, delay));
  }
  async function loadSnapshot() {
    if (!state.canManage || hidden() || state.loading) return;
    clearTimeout(state.poll); state.poll = null;
    const epoch = state.epoch, controller = new AbortController(); state.snapshotController = controller; state.loading = true;
    $('#refresh').disabled = true;
    try {
      const result = await api('snapshot', { signal: controller.signal, epoch });
      if (epoch !== state.epoch || controller.signal.aborted || state.snapshotController !== controller) return;
      if (!result || !Array.isArray(result.hosts) || !Array.isArray(result.monitors) || !Array.isArray(result.incidents) || !Array.isArray(result.commands)) throw Error('状态数据暂不可用。');
      state.data = result; state.failed = false; $('#connection-error').hidden = true;
      for (const [key, requestId] of state.uncertainRestarts) {
        const confirmed = result.commands.find(command => `${command.hostId}:${command.serviceId}` === key && command.requestId === requestId);
        if (confirmed && ['succeeded', 'failed'].includes(confirmed.status)) state.uncertainRestarts.delete(key);
      }
      render(); scheduleAging();
    } catch (error) {
      if (epoch !== state.epoch || controller.signal.aborted) return;
      state.failed = true; $('#connection-error').textContent = state.data ? '暂时无法读取最新状态，显示最近记录。' : '暂时无法连接监控服务，请刷新重试。';
      $('#connection-error').hidden = false; render(); scheduleAging();
    } finally {
      if (state.snapshotController === controller) { state.snapshotController = null; state.loading = false; $('#refresh').disabled = false; schedulePoll(); }
    }
  }
  function showView(view) {
    if (!Object.hasOwn(views, view)) return;
    navigationGeneration++;
    state.view = view; const [name, title, description] = views[view];
    $('#breadcrumb-name').textContent = name; $('#page-title').textContent = title; $('#page-description').textContent = description;
    $$('.view').forEach(node => { node.hidden = node.id !== `view-${view}`; });
    $$('.nav-item').forEach(node => { node.classList.toggle('active', node.dataset.view === view); if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    if (state.data) render();
  }
  function resource(label, value, history, field) {
    const known = typeof value === 'number' && Number.isFinite(value) && value >= 0, percent = known ? Math.max(0, Math.min(100, value)) : 0;
    return `<div class="resource${percent >= 85 ? ' high' : ''}"><div><span>${label}</span><strong>${number(value, 1)}<small>${known ? '%' : ''}</small></strong></div><div class="meter" aria-hidden="true"><i style="width:${percent}%"></i></div>${sparkline(history, field)}</div>`;
  }
  function metrics(host, compact = false) {
    const values = host.metrics || {};
    return `<div class="metrics-grid">${resource('CPU', values.cpuPercent, host.history, 'cpuPercent')}${resource('内存', values.memoryPercent, host.history, 'memoryPercent')}${resource('磁盘', values.diskPercent, compact ? [] : host.history, 'diskPercent')}</div>`;
  }
  function canRestart(host, service) {
    const commands = list(state.data?.commands).filter(command => command.hostId === host.id && command.serviceId === service.id)
      .sort((a, b) => (time(b.createdAt) || 0) - (time(a.createdAt) || 0));
    return state.canManage && !state.mutation && service.restartAllowed === true && service.expected === 'running'
      && ['up', 'down', 'maintenance'].includes(hostState(host).state)
      && !state.uncertainRestarts.has(`${host.id}:${service.id}`)
      && !commands.some(command => ['pending', 'dispatched'].includes(command.status)) && commands[0]?.status !== 'unknown';
  }
  function maintenanceButton(kind, value) {
    return `<button type="button" class="maintenance-button${value.maintenance ? ' on' : ''}" data-maintenance-kind="${kind}" data-target-id="${escapeHtml(value.id)}" aria-pressed="${value.maintenance === true}"${state.mutation ? ' disabled' : ''}>${value.maintenance ? '结束维护' : '设为维护'}</button>`;
  }
  function hostHtml(host, compact = false) {
    const status = hostState(host), heading = `<div class="card-heading"><div><h3>${escapeHtml(text(host.name, host.id))}</h3><p>${status.fresh ? '最近采样 ' : '采样待更新 · '}${escapeHtml(stamp(host.observedAt || host.lastSeenAt))}</p></div>${badge(status)}</div>`;
    if (compact) return `<div class="mini-host">${heading}${metrics(host, true)}</div>`;
    const uptime = host.metrics?.uptimeSeconds, uptimeLabel = typeof uptime === 'number' && uptime >= 0 ? uptime >= 86400 ? `${number(uptime / 86400, 1)} 天` : `${number(uptime / 3600, 1)} 小时` : '—';
    const services = list(host.services).map(service => `<div class="service-row"><div><strong>${escapeHtml(text(service.name, service.id))}</strong><small>PID ${number(service.pid)} · 重启 ${number(service.restarts)} 次${service.expected === 'stopped' ? ' · 计划停用' : ''}${service.autoRepair === true && service.expected === 'running' ? ' · 自动修复' : ''}</small></div>${badge(serviceState(service, host))}<button type="button" class="button secondary small" data-restart-host="${escapeHtml(host.id)}" data-restart-service="${escapeHtml(service.id)}"${canRestart(host, service) ? '' : ' disabled'}>${state.uncertainRestarts.has(`${host.id}:${service.id}`) ? '待确认' : '重启'}</button></div>`).join('');
    return `<article class="glass host-card">${heading}${metrics(host)}<div class="host-detail"><span>运行时间 ${uptimeLabel}</span><span>1 分钟负载 ${number(host.metrics?.load1, 2)}</span></div><div class="service-list">${services || empty('暂无服务记录')}</div><div class="card-footer"><span>${host.maintenance ? '维护期间按维护策略处理告警' : '正常监控中'}</span>${maintenanceButton('host', host)}</div></article>`;
  }
  function monitorHtml(monitor, compact = false) {
    const status = monitorState(monitor);
    if (compact) return `<div class="compact-monitor"><strong>${escapeHtml(text(monitor.name, monitor.id))}</strong><small>${number(monitor.latencyMs)} ms</small>${badge(status)}</div>`;
    const link = monitorLink(monitor.url), points = list(monitor.history).slice(-36);
    const history = points.length ? points.map(point => `<i class="${point.ok === true ? 'good' : point.ok === false ? 'bad' : ''}" title="${escapeHtml(`${stamp(point.at)} · ${point.ok === true ? '正常' : point.ok === false ? '异常' : '未知'} · ${number(point.latencyMs)} ms`)}"></i>`).join('') : '<i></i>';
    return `<article class="glass monitor-card"><div class="card-heading"><div><h3>${escapeHtml(text(monitor.name, monitor.id))}</h3>${link ? `<a class="monitor-url" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a>` : '<span class="monitor-url">地址未提供</span>'}</div>${badge(status)}</div><dl class="monitor-numbers"><div><dt>响应时间</dt><dd>${number(monitor.latencyMs)}<small>ms</small></dd></div><div><dt>HTTP 状态</dt><dd>${number(monitor.httpStatus)}</dd></div><div class="${typeof monitor.tlsDays === 'number' && monitor.tlsDays <= 14 ? 'warning' : ''}"><dt>TLS 剩余</dt><dd>${typeof monitor.tlsDays === 'number' && Number.isFinite(monitor.tlsDays) ? monitor.tlsDays < 0 ? '已过期' : number(monitor.tlsDays) : '—'}<small>${typeof monitor.tlsDays === 'number' && monitor.tlsDays >= 0 ? '天' : ''}</small></dd></div></dl><div class="uptime-bars" aria-label="最近监控状态">${history}</div><div class="history-label"><span>最近 ${points.length} 次检查</span><span>${escapeHtml(stamp(monitor.checkedAt))}</span></div>${monitor.error ? `<p class="monitor-error">${escapeHtml(text(monitor.error))}</p>` : ''}<div class="card-footer"><span>${status.fresh ? '状态已更新' : '旧记录 · 等待检查'}</span>${maintenanceButton('monitor', monitor)}</div></article>`;
  }
  function botHtml(bot, host) {
    const status = botState(bot, host);
    const playback = !status.fresh || status.state === 'unknown' ? '待确认' : status.state === 'degraded' ? '播放异常'
      : bot.playing === true ? '♫ 正在播放' : bot.playing === false ? '当前未播放' : '未提供';
    const transport = ['connected', 'disconnected'].includes(bot.transport) ? `<div><dt>语音连接</dt><dd>${!status.fresh ? '待确认' : bot.transport === 'connected' ? '已连接' : '已断开'}</dd></div>` : '';
    const seconds = bot.uptimeSeconds, runtimeKnown = status.fresh && ['online','offline','degraded'].includes(status.state);
    const total = runtimeKnown && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 1e12 ? Math.floor(seconds) : null;
    const days = Math.floor(total / 86400), hours = Math.floor(total / 3600) % 24, minutes = Math.floor(total / 60) % 60;
    const duration = total === null ? status.fresh ? '待确认' : '待确认（样本过期）'
      : `${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${minutes || days || hours ? `${minutes} 分` : `${total} 秒`}`;
    const started = time(bot.startedAt), startedLabel = runtimeKnown && Number.isFinite(started) && started >= 0 && started <= currentTime() + 60000 ? stamp(bot.startedAt) : '待确认';
    const runtime = bot.kind === 'music' ? `<div><dt>运行时长（采样）</dt><dd>${escapeHtml(duration)}</dd></div><div><dt>本次启动</dt><dd>${escapeHtml(startedLabel)}</dd></div>` : '';
    return `<article class="glass bot-card"><div class="card-heading"><div class="bot-identity"><span class="bot-icon" aria-hidden="true">✦</span><div><h3>${escapeHtml(text(bot.name, bot.id))}</h3><p>${escapeHtml(text(bot.kind, '机器人'))}</p></div></div>${badge(status)}</div><dl class="bot-meta"><div><dt>所在服务器</dt><dd>${escapeHtml(text(host.name, host.id))}</dd></div><div><dt>频道</dt><dd>${escapeHtml(text(bot.channelName, '未提供'))}</dd></div><div><dt>播放状态</dt><dd>${playback}</dd></div>${transport}${runtime}<div><dt>最近观测</dt><dd>${escapeHtml(stamp(host.observedAt || host.lastSeenAt))}</dd></div></dl>${bot.lastError ? `<p class="bot-error">${escapeHtml(text(bot.lastError))}</p>` : ''}</article>`;
  }
  function incidentHtml(item, compact = false) {
    const resolved = item.state === 'resolved';
    const notified = item.notified === true || item.notified === 'sent' ? '已通知' : item.notified === 'uncertain' ? '通知待确认'
      : item.notified === 'sending' ? '通知发送中' : item.notified === 'pending' ? '待通知' : item.notified === false ? '未通知' : '';
    return `<article class="${compact ? 'attention-item' : `timeline-item${resolved ? ' resolved' : ''}`}"><h3>${escapeHtml(text(item.title, '状态事件'))}${compact ? '' : `<span class="event-category">${item.category === 'infra' ? '基础设施' : item.category === 'web' ? '网站接口' : '事件'}</span>`}</h3><p>${escapeHtml(stamp(resolved ? item.resolvedAt : item.openedAt))} · ${resolved ? '已恢复' : '待处理'}${notified ? ` · ${notified}` : ''}</p></article>`;
  }
  function commandHtml(command) {
    const map = { pending: ['排队中', 'warn'], dispatched: ['已下发', 'warn'], succeeded: ['成功', 'good'], failed: ['失败', 'bad'], unknown: ['结果待确认', 'warn'] };
    const [label, tone] = command.origin === 'auto' && command.status === 'succeeded' ? ['重启已执行', '']
      : Object.hasOwn(map, command.status) ? map[command.status] : ['待确认', ''];
    const host = state.data.hosts.find(item => item.id === command.hostId), service = list(host?.services).find(item => item.id === command.serviceId);
    return `<article class="command-item"><div><strong>${escapeHtml(text(host?.name, command.hostId))} / ${escapeHtml(text(service?.name, command.serviceId))}</strong>${badge({ label, tone })}</div>${command.message ? `<p>${escapeHtml(text(command.message))}</p>` : ''}${command.origin === 'auto' && command.reason ? `<p>${escapeHtml(text(command.reason))}</p>` : ''}<small>${command.origin === 'auto' ? '自动修复' : '手动重启'} · ${escapeHtml(stamp(command.createdAt))}</small></article>`;
  }
  function repairPhase(phase) {
    const labels = { idle: ['监测中', ''], queued: ['等待重启', 'warn'], restarting: ['重启中', 'warn'],
      verifying: ['复核中', 'warn'], recovered: ['已恢复', 'good'], failed: ['修复失败', 'bad'],
      blocked: ['已受限', 'warn'], unknown: ['待确认', 'warn'], maintenance: ['维护中', 'maintenance'] };
    const [label, tone] = Object.hasOwn(labels, phase) ? labels[phase] : ['待确认', 'warn'];
    return { label, tone };
  }
  function repairOverviewHtml(repair) {
    if (!repair || typeof repair !== 'object' || Array.isArray(repair)) return '';
    const items = list(repair.states).filter(item => item && typeof item === 'object');
    const active = items.filter(item => ['queued', 'restarting', 'verifying'].includes(item.phase)).length;
    const attention = items.filter(item => !['idle', 'queued', 'restarting', 'verifying', 'recovered', 'maintenance'].includes(item.phase)).length;
    const policy = repair.policy;
    const validPolicy = policy && [policy.failureThreshold, policy.recoveryThreshold, policy.cooldownMs, policy.maxAttemptsPerHour]
      .every(value => Number.isInteger(value) && value > 0);
    return `<div class="notification-row"><span>自动修复</span>${badge({ label: repair.enabled === true ? '已开启' : '未开启', tone: repair.enabled === true ? 'good' : '' })}</div><div class="notification-row"><span>修复状态</span><strong>${active} 项处理中 · ${attention} 项待确认</strong></div>${repair.enabled === true && validPolicy ? `<p class="notification-note">连续 ${number(policy.failureThreshold)} 次异常后重启，连续 ${number(policy.recoveryThreshold)} 次正常后确认恢复。间隔至少 ${number(Math.ceil(policy.cooldownMs / 60000))} 分钟，每小时最多 ${number(policy.maxAttemptsPerHour)} 次。</p>` : ''}`;
  }
  function repairLogHtml(repair) {
    if (!repair || typeof repair !== 'object' || Array.isArray(repair)) return '';
    const target = item => {
      const host = state.data.hosts.find(host => host.id === item.hostId), service = list(host?.services).find(service => service.id === item.serviceId);
      return `${text(host?.name, item.hostId)} / ${text(service?.name, item.serviceId)}`;
    };
    const states = list(repair.states).filter(item => item && typeof item === 'object' && !['idle', 'recovered'].includes(item.phase));
    const statusRows = states.slice(0, 8).map(item => `<article class="command-item"><div><strong>${escapeHtml(target(item))}</strong>${badge(repairPhase(item.phase))}</div>${item.message || item.reason ? `<p>${escapeHtml(text(item.message || item.reason))}</p>` : ''}${Number.isFinite(time(item.nextAttemptAt)) ? `<small>下次可尝试 ${escapeHtml(stamp(item.nextAttemptAt))}</small>` : ''}</article>`).join('');
    const events = list(repair.events).filter(item => item && typeof item === 'object')
      .slice().sort((a, b) => (time(b.at) || 0) - (time(a.at) || 0));
    const notifications = { pending: '待通知', sending: '通知发送中', sent: '已通知', uncertain: '通知待确认' };
    const eventRows = events.slice(0, 8).map(item => `<article class="command-item"><div><strong>${escapeHtml(target(item))}</strong>${badge(repairPhase(item.phase))}</div><p>${escapeHtml(text(item.title, '自动修复事件'))}${item.message ? ` · ${escapeHtml(text(item.message))}` : ''}</p><small>${escapeHtml(stamp(item.at))} · ${Object.hasOwn(notifications, item.notification) ? notifications[item.notification] : '通知待确认'}</small></article>`).join('');
    return `<section class="repair-block"><h3>自动修复 · 当前状态</h3>${statusRows || '<p class="notification-note">暂无进行中或受限的修复。</p>'}${states.length > 8 ? `<p class="notification-note">另有 ${states.length - 8} 项，请查看服务状态。</p>` : ''}<h3>最近修复记录</h3>${eventRows || '<p class="notification-note">尚无修复记录。</p>'}</section><h3 class="repair-command-heading">重启操作</h3>`;
  }
  function reportsHtml(reports) {
    if (!reports || typeof reports !== 'object' || Array.isArray(reports)) return '';
    const enabled = reports.enabled === true;
    const reportTime = value => Number.isFinite(time(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) + ' · 北京时间' : null;
    const next = reportTime(reports.nextRunAt), last = reportTime(reports.lastRunAt);
    const statuses = { sent: ['已送达', 'good'], sending: ['发送中', 'warn'], uncertain: ['送达待确认', 'warn'], pending: ['待播报', ''], skipped: ['已跳过', ''] };
    const channels = [['infra', '基础设施播报'], ['web', '网站接口播报']].map(([key, name]) => {
      const result = reports.channels?.[key]; if (!result || typeof result !== 'object') return '';
      const [label, tone] = Object.hasOwn(statuses, result.status) ? statuses[result.status] : ['待确认', ''];
      const observed = reportTime(result.attemptedAt || result.slotAt);
      return `<div class="notification-row"><span>${name}</span><strong${observed ? ` title="${escapeHtml(observed)}"` : ''}>${badge({ label, tone })}</strong></div>`;
    }).join('');
    const uncertain = ['infra', 'web'].some(key => reports.channels?.[key]?.status === 'uncertain');
    return `<div class="notification-row"><span>定时播报</span><strong>${enabled ? '每30分钟自动播报' : '未开启'}</strong></div>${enabled ? `<div class="notification-row"><span>下次播报</span><strong>${escapeHtml(next || '等待排期')}</strong></div>` : ''}<div class="notification-row"><span>最近播报</span><strong>${escapeHtml(last || '尚未播报')}</strong></div>${channels}${reports.lastError ? `<p class="notification-note" role="status">${escapeHtml(text(reports.lastError))}</p>` : uncertain ? '<p class="notification-note" role="status">部分频道送达未确认，请核对对应 KOOK 频道。</p>' : ''}`;
  }
  function render() {
    if (!state.canManage) return;
    const data = state.data;
    $('#connection-dot').classList.toggle('warning', state.failed || !data);
    $('#connection-label').textContent = state.failed ? '同步中断' : data ? '监控已连接' : '等待采样';
    $('#sync-state').textContent = state.failed ? '正在显示最近记录' : data ? '状态已同步' : '等待采样';
    $('#updated-at').textContent = data?.updatedAt ? `更新于 ${stamp(data.updatedAt)} · 北京时间` : '尚未更新';
    if (!data) { $('#overview-stats').innerHTML = empty('等待第一份运行数据'); return; }
    const hosts = data.hosts, monitors = data.monitors, bots = hosts.flatMap(host => list(host.bots).map(bot => ({ bot, host })));
    const open = data.incidents.filter(item => item.state === 'open'), onlineHosts = hosts.filter(host => hostState(host).state === 'up').length,
      upMonitors = monitors.filter(monitor => monitorState(monitor).state === 'up').length, onlineBots = bots.filter(({ bot, host }) => botState(bot, host).state === 'online').length;
    const statistics = [['服务器', onlineHosts, hosts.length, '◈', `${hosts.filter(host => hostState(host).state === 'maintenance').length} 台维护中`],
      ['网站与接口', upMonitors, monitors.length, '◎', '状态随最近采样更新'], ['机器人', onlineBots, bots.length, '✦', `${bots.filter(({ bot, host }) => botState(bot, host).state === 'stopped').length} 个计划停用`],
      ['未恢复事件', open.length, null, '≋', open.length ? '请查看需要关注的目标' : '当前没有未恢复事件']];
    $('#overview-stats').innerHTML = statistics.map(([label, value, total, symbol, note]) => `<div class="glass stat"><div class="stat-head"><span>${label}</span><span class="stat-symbol" aria-hidden="true">${symbol}</span></div><strong class="stat-value">${value}${total !== null ? `<small>/ ${total}</small>` : ''}</strong><p>${escapeHtml(note)}</p></div>`).join('');
    $('#overview-hosts').innerHTML = hosts.slice(0, 4).map(host => hostHtml(host, true)).join('') || empty('尚未接入服务器');
    $('#attention-count').textContent = `${open.length} 项`;
    $('#overview-attention').innerHTML = open.slice(0, 5).map(item => incidentHtml(item, true)).join('') || empty('暂时没有未恢复事件', '状态过期的目标仍需等待新采样确认。');
    $('#overview-monitors').innerHTML = monitors.slice(0, 5).map(monitor => monitorHtml(monitor, true)).join('') || empty('尚未配置监控目标');
    const notification = data.notification || {};
    $('#notification-status').innerHTML = `<div class="notification-row"><span>通知服务</span>${badge({ label: notification.enabled === true ? '已开启' : '未开启', tone: notification.enabled === true ? 'good' : '' })}</div><div class="notification-row"><span>播报机器人</span><strong>${escapeHtml(text(notification.botName, '思维2'))}</strong></div><div class="notification-row"><span>基础设施频道</span><strong>${escapeHtml(text(notification.infraChannel, '未配置'))}</strong></div><div class="notification-row"><span>网站接口频道</span><strong>${escapeHtml(text(notification.webChannel, '未配置'))}</strong></div><div class="notification-row"><span>查询机器人</span>${badge({ label: data.queryBot?.connected === true ? '在线' : '未连接', tone: data.queryBot?.connected === true ? 'good' : '' })}</div>${repairOverviewHtml(data.autoRepair)}${reportsHtml(data.reports)}${notification.lastError ? `<p class="notification-note">${escapeHtml(text(notification.lastError))}</p>` : ''}`;
    $('#host-count').textContent = `${hosts.length} 台`; $('#host-list').innerHTML = hosts.map(host => hostHtml(host)).join('') || empty('尚未接入服务器');
    $('#monitor-count').textContent = `${monitors.length} 个`; $('#monitor-list').innerHTML = monitors.map(monitor => monitorHtml(monitor)).join('') || empty('尚未配置监控目标');
    $('#bot-count').textContent = `${bots.length} 个`; $('#bot-list').innerHTML = bots.map(({ bot, host }) => botHtml(bot, host)).join('') || empty('尚未收到机器人状态');
    $('#nav-incidents').hidden = !open.length; $('#nav-incidents').textContent = String(open.length);
    const selected = data.incidents.filter(item => $('#event-filter').value === 'all' || item.state === $('#event-filter').value).slice().sort((a, b) => (time(b.openedAt) || 0) - (time(a.openedAt) || 0));
    $('#incident-list').innerHTML = selected.slice(0, 100).map(item => incidentHtml(item)).join('') || empty('暂无匹配事件');
    $('#command-list').innerHTML = repairLogHtml(data.autoRepair) + (data.commands.slice().sort((a, b) => (time(b.createdAt) || 0) - (time(a.createdAt) || 0)).slice(0, 30).map(commandHtml).join('') || empty('尚无操作记录'));
  }
  async function changeMaintenance(kind, id) {
    if (!state.canManage || state.mutation || !['host', 'monitor'].includes(kind)) return;
    const target = state.data?.[kind === 'host' ? 'hosts' : 'monitors'].find(item => item.id === id); if (!target) return;
    const epoch = state.epoch; state.mutation = `maintenance:${id}`; render();
    try { const result = await api('maintenance', { method: 'POST', body: { kind, id, enabled: !target.maintenance }, epoch });
      if (epoch !== state.epoch) return;
      if (result?.updated !== true) throw Error('维护设置结果未确认，请刷新状态。');
      toast(target.maintenance ? '已请求结束维护。' : '已请求开启维护。'); await loadSnapshot();
    } catch (error) { if (epoch === state.epoch) toast(error.name === 'AbortError' ? '操作结果未确认，请刷新状态。' : error.message || '维护设置未完成。', true); }
    finally { if (epoch === state.epoch) { state.mutation = null; render(); } }
  }
  function openRestart(hostId, serviceId) {
    const host = state.data?.hosts.find(item => item.id === hostId), service = list(host?.services).find(item => item.id === serviceId);
    if (!host || !service || !canRestart(host, service)) return;
    state.restart = { hostId, serviceId, requestId: crypto.randomUUID(), pending: false, submitted: false };
    $('#restart-description').textContent = `确认重启“${text(service.name, service.id)}”？`;
    $('#restart-target').textContent = `${text(host.name, host.id)} / ${text(service.name, service.id)}`;
    $('#restart-error').hidden = true; $('#restart-confirm').disabled = false; $('#restart-confirm').textContent = '确认重启'; $('#restart-cancel').disabled = false;
    $('#restart-dialog').showModal();
  }
  async function submitRestart() {
    const selected = state.restart; if (!selected || selected.pending || selected.submitted || !state.canManage) return;
    const host = state.data?.hosts.find(item => item.id === selected.hostId), service = list(host?.services).find(item => item.id === selected.serviceId);
    if (!host || !service || !canRestart(host, service)) { $('#restart-error').textContent = '服务状态已变化，请关闭后刷新。'; $('#restart-error').hidden = false; return; }
    const epoch = state.epoch, navigation = navigationGeneration; selected.pending = true; selected.submitted = true; state.mutation = `restart:${selected.hostId}:${selected.serviceId}`;
    $('#restart-confirm').disabled = true; $('#restart-confirm').textContent = '正在提交…'; $('#restart-cancel').disabled = true; render();
    try {
      const result = await api('commands', { method: 'POST', body: { hostId: selected.hostId, serviceId: selected.serviceId, action: 'restart', requestId: selected.requestId }, epoch });
      if (epoch !== state.epoch) return;
      if (!result?.command || !['pending', 'dispatched', 'succeeded', 'failed', 'unknown'].includes(result.command.status)) throw Error('未取得可确认的命令记录。');
      state.data.commands = [result.command, ...state.data.commands.filter(command => command.id !== result.command.id)];
      if (result.command.status === 'unknown') state.uncertainRestarts.set(`${selected.hostId}:${selected.serviceId}`, selected.requestId);
      $('#restart-dialog').close(); state.restart = null;
      if (active && navigation === navigationGeneration) {
        showView('events'); options.onView?.('events');
        toast(result.command.status === 'succeeded' ? '服务重启成功。' : result.command.status === 'failed' ? '重启失败，请查看操作记录。' : '请求已记录，请查看执行结果。', result.command.status === 'failed');
      }
      await loadSnapshot();
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.uncertainRestarts.set(`${selected.hostId}:${selected.serviceId}`, selected.requestId);
      $('#restart-error').textContent = '提交结果未确认，请先刷新并核对操作记录。不会自动重复发送。'; $('#restart-error').hidden = false;
      $('#restart-confirm').textContent = '结果待确认';
    } finally { if (epoch === state.epoch) { selected.pending = false; state.mutation = null; $('#restart-cancel').disabled = false; render(); } }
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.view) { showView(button.dataset.view); options.onView?.(button.dataset.view); }
    if (button.dataset.maintenanceKind) void changeMaintenance(button.dataset.maintenanceKind, button.dataset.targetId);
    if (button.dataset.restartHost) openRestart(button.dataset.restartHost, button.dataset.restartService);
  });
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const epoch = state.epoch, email = $('#login-email').value.trim(), password = $('#login-password').value;
    $('#login-submit').disabled = true; $('#login-error').hidden = true;
    try {
      if (!state.csrf) { const session = await api('session', { epoch }); if (epoch !== state.epoch) return; state.csrf = session.csrf || ''; }
      const result = await api('login', { method: 'POST', body: { email, password }, epoch });
      if (epoch !== state.epoch) return; $('#login-password').value = ''; beginSession(result);
    } catch (error) { if (epoch === state.epoch) { $('#login-error').textContent = error.name === 'AbortError' ? '登录超时，请重试。' : error.message || '登录失败。'; $('#login-error').hidden = false; } }
    finally { $('#login-submit').disabled = false; }
  });
  $('#logout').addEventListener('click', async () => {
    const csrf = state.csrf; loseSession(); const epoch = state.epoch;
    try { await api('logout', { method: 'POST', body: {}, csrf, epoch }); }
    catch { if (epoch === state.epoch) { $('#login-error').textContent = '本机已退出显示；服务器会话退出未确认，请重试登录后退出。'; $('#login-error').hidden = false; } }
  });
  $('#refresh').addEventListener('click', () => void loadSnapshot());
  $('#event-filter').addEventListener('change', render);
  $('#restart-form').addEventListener('submit', event => { event.preventDefault(); void submitRestart(); });
  $('#restart-cancel').addEventListener('click', () => { if (!state.restart?.pending) { $('#restart-dialog').close(); state.restart = null; } });
  $('#restart-dialog').addEventListener('cancel', event => { if (state.restart?.pending) event.preventDefault(); else state.restart = null; });
  document.addEventListener('visibilitychange', () => { if (hidden()) pausePolling(); else if (state.canManage) { render(); scheduleAging(); void loadSnapshot(); } });
  window.addEventListener('pagehide', () => { pausePolling(); for (const controller of state.controllers) controller.abort(); });
  const bootEpoch = state.epoch;
  api('session', { epoch: bootEpoch }).then(result => {
    if (bootEpoch !== state.epoch) return;
    if (result.authenticated || result.publicManagement && result.canManage) beginSession(result);
    else { loseSession(); state.csrf = typeof result.csrf === 'string' ? result.csrf : ''; }
  }).catch(error => { if (bootEpoch === state.epoch) loseSession(error.message || '无法连接运维中心，请稍后重试。'); });
  return {
    show(view) { active = true; showView(view); if (state.canManage) { render(); scheduleAging(); void loadSnapshot(); } },
    hide() { active = false; navigationGeneration++; pausePolling(); if ($('#restart-dialog').open) $('#restart-dialog').close(); state.restart = null; },
    clear() { loseSession(); },
    async refreshSession() {
      const epoch = state.epoch, result = await api('session', { epoch });
      if (epoch !== state.epoch) return;
      if (result.authenticated || result.publicManagement && result.canManage) beginSession(result);
      else { loseSession(); state.csrf = result.csrf || ''; }
    },
  };
};
if (!window.__OPS_EMBED_ONLY__) window.createOpsPanel();
