import { safeOpsText } from './kook.js';

const HALF_HOUR = 30 * 60000;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  ? `${Number(value.toFixed(1))}%` : null;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const name = (value, fallback) => safeOpsText(typeof value?.name === 'string' && value.name.trim() ? value.name
  : typeof value?.id === 'string' && value.id ? value.id : fallback, 48) || fallback;
const rows = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
function fresh(value, now, ttl) {
  const time = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && now - time >= -60000 && now - time <= ttl;
}
function slotLabel(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Math.floor(now / HALF_HOUR) * HALF_HOUR))
    .map(part => [part.type, part.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} 北京时间`;
}
function pack(prefix, items) {
  const result = []; let line = prefix;
  for (const item of items) {
    const next = `${line}${line === prefix ? '' : '；'}${item}`;
    if (next.length > 480 && line !== prefix) { result.push(line); line = prefix + item; }
    else line = next;
  }
  if (line !== prefix) result.push(line);
  return result.map(line => safeOpsText(line));
}

function repairSummary(value, category, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inScope = item => category === 'infra' || item.category === 'web';
  const recovered = new Set(rows(value.events).filter(item => inScope(item) && item.phase === 'recovered'
    && Number.isFinite(Date.parse(item.at)) && now - Date.parse(item.at) >= 0 && now - Date.parse(item.at) <= HALF_HOUR)
    .map(item => typeof item.id === 'string' && item.id ? item.id : `${item.hostId}:${item.serviceId}:${item.at}`)).size;
  const states = [...new Map(rows(value.states).filter(inScope).map(item => [`${item.hostId}:${item.serviceId}`, item])).values()];
  const pending = states.filter(item => !['idle', 'recovered', 'maintenance', 'blocked'].includes(item.phase)).length;
  const blocked = states.filter(item => item.phase === 'blocked').length;
  return { line: `自动修复：${value.enabled === true ? '已开启' : '未开启'} · 最近30分钟恢复${recovered}次 / 待确认${pending} / 受限${blocked}`,
    attention: pending > 0 || blocked > 0 };
}

/** Snapshot-only half-hour report. It never refreshes data, executes commands or sends messages. */
export function buildScheduledSummary(snapshot, category, now = Date.now()) {
  if (!['infra', 'web'].includes(category) || typeof now !== 'number' || !Number.isFinite(now) || now < 0 || now >= 8640000000000000) {
    throw new Error('定时汇总参数无效。');
  }
  let warning = false, danger = false, maintenanceSeen = false;
  const sections = [], packedSections = [];
  if (category === 'infra') {
    const hosts = rows(snapshot?.hosts);
    for (const host of hosts) {
      const current = fresh(host.observedAt, now, 120000) && fresh(host.lastSeenAt, now, 120000);
      const maintenance = host.maintenance === true || host.state === 'maintenance'; maintenanceSeen ||= maintenance;
      const metrics = ['cpuPercent', 'memoryPercent', 'diskPercent'].map(key => current ? percent(host.metrics?.[key]) : null);
      const incomplete = !current || metrics.some(value => value === null) || !['up', 'down', 'maintenance'].includes(host.state);
      warning ||= incomplete; danger ||= current && host.state === 'down' && !maintenance;
      const state = maintenance ? `维护中${current ? '' : ' · 采样待确认'}` : incomplete ? '待确认' : host.state === 'down' ? '异常' : '正常';
      const items = [`${state} · CPU ${metrics[0] ?? '待确认'} · 内存 ${metrics[1] ?? '待确认'} · 磁盘 ${metrics[2] ?? '待确认'}`];
      const services = rows(host.services), bots = [...rows(host.bots)];
      for (const service of services.filter(item => item.expected === 'stopped')) {
        if (!bots.some(bot => bot.id === `planned:${service.id}` || bot.id === service.id || bot.name === service.name)) {
          bots.push({ id: `planned:${service.id}`, name: service.name, state: service.activeState === 'inactive' ? 'stopped'
            : service.activeState === 'active' ? 'online' : 'unknown' });
        }
      }
      if (!bots.length) { items.push('机器人：暂无记录'); warning = true; }
      for (const bot of bots) {
        const planned = typeof bot.id === 'string' && bot.id.startsWith('planned:')
          || services.some(service => service.expected === 'stopped' && (service.id === bot.id || service.name === bot.name));
        const known = ['online', 'offline', 'stopped'].includes(bot.state);
        let state;
        if (!current || !known) { state = planned ? '计划停用 · 待确认' : '待确认'; warning = true; }
        else if (planned && bot.state === 'stopped') state = '计划停用';
        else if (planned) { state = `计划停用 · ${bot.state === 'online' ? '仍在线' : '状态待确认'}`; warning = true; }
        else if (bot.health === 'degraded') { state = `异常${bot.lastError ? ` · ${safeOpsText(bot.lastError, 100)}` : ''}`; danger ||= !maintenance; }
        else if (bot.health === 'unknown') { state = '业务状态待确认'; warning = true; }
        else if (bot.state === 'online') state = bot.playing === true ? '在线 · 播放中' : '在线';
        else if (bot.state === 'offline') { state = '离线'; danger ||= !maintenance; }
        else { state = '已停止'; warning = true; }
        items.push(`${name(bot, '机器人')}：${state}`);
      }
      const prefix = `${name(host, '服务器')}｜`;
      sections.push(safeOpsText(prefix + items[0]), ...items.slice(1).map(item => safeOpsText(`↳ ${item}`)));
      packedSections.push(...pack(prefix, items));
    }
    if (!hosts.length) { sections.push('尚无服务器与机器人采集记录，状态待确认。'); warning = true; }
  } else {
    const monitors = rows(snapshot?.monitors), items = [];
    for (const monitor of monitors) {
      const current = fresh(monitor.checkedAt, now, 150000);
      const maintenance = monitor.maintenance === true || monitor.state === 'maintenance'; maintenanceSeen ||= maintenance;
      const known = ['up', 'down', 'maintenance'].includes(monitor.state);
      warning ||= !current || !known; danger ||= current && monitor.state === 'down' && !maintenance;
      const state = maintenance ? `维护中${current ? '' : ' · 采样待确认'}` : !current || !known ? '待确认' : monitor.state === 'down' ? '异常' : '正常';
      const latency = current ? nonnegative(monitor.latencyMs) : null;
      const status = current && Number.isInteger(monitor.httpStatus) && monitor.httpStatus >= 100 && monitor.httpStatus <= 599 ? monitor.httpStatus : null;
      const http = typeof monitor.url === 'string' && /^http:\/\//i.test(monitor.url);
      const tlsDays = current ? nonnegative(monitor.tlsDays) : null;
      warning ||= current && (latency === null || status === null || !http && (tlsDays === null || tlsDays <= 14));
      items.push(`${name(monitor, '网站／接口')}：${state} · HTTP ${status ?? '待确认'} · ${latency === null ? '延迟待确认' : `${Math.round(latency)}ms`}
        · ${http ? 'HTTP，无证书' : tlsDays === null ? '证书待确认' : `证书余 ${Math.floor(tlsDays)} 天`}`);
    }
    sections.push(...items.map(item => safeOpsText(item)));
    packedSections.push(...pack('', sections));
    if (!monitors.length) { sections.push('尚无网站与接口检查记录，状态待确认。'); warning = true; }
  }
  // Keep the usual inventory scannable: one host/bot/site per line. Pack only
  // larger inventories so the sender's twelve-section cap need not omit them.
  const repair = repairSummary(snapshot?.autoRepair, category, now);
  warning ||= repair?.attention === true;
  const displaySections = sections.length > (repair ? 11 : 12) ? packedSections : sections;
  const lines = repair ? [repair.line] : [];
  let displayed = 0;
  for (const section of displaySections) {
    // Leave room for the sender's card structure and public console address,
    // including JSON escaping. Typical two-host/nine-bot reports fit in full.
    if (lines.length >= 12 || JSON.stringify([...lines, section]).length > 5200) break;
    lines.push(section); displayed++;
  }
  if (displayed < displaySections.length) {
    if (lines.length === 12) lines.pop();
    lines.push('内容较多，其余记录请打开运维中心查看。'); warning = true;
  }
  return { category, title: `${category === 'infra' ? '服务器与机器人' : '网站与接口'}半小时汇总 · ${slotLabel(now)}`,
    theme: danger ? 'danger' : warning ? 'warning' : maintenanceSeen ? 'info' : 'success', lines };
}
