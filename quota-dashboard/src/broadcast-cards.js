// KOOK Card Message schema: https://developer.kookapp.cn/doc/cardmessage
// /api/v3/message/create limits the entire JSON content string to 8,000 characters.
import { quotaBattery } from './quota-battery.js';
const MAX_CONTENT = 8000;
const MAX_BYTES = 18000;
const MAX_MODULES = 50;
const safeNumber = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => safeNumber(value) && value >= 0;
const plain = content => ({ type: 'plain-text', content });
const styled = content => ({ type: 'kmarkdown', content });
const context = content => ({ type: 'context', elements: [typeof content === 'string' ? plain(content) : content] });
const header = content => ({ type: 'header', text: plain(content) });
const COLOR_THEMES = ['success', 'warning', 'danger', 'info', 'purple', 'secondary', 'tips'];

// Only this limited KOOK font syntax is generated. Neutralize user-controlled
// Markdown punctuation inside a color span; names remain ordinary header text.
function color(value, theme) {
  if (!COLOR_THEMES.includes(theme)) throw new Error('无效的颜色主题');
  const neutral = clean(value, 1000).replace(/[()\\`*_~]/g, character => ({ '(': '（', ')': '）', '\\': '＼', '`': '｀', '*': '＊', '_': '＿', '~': '～' })[character]);
  return `(font)${neutral}(font)[${theme}]`;
}

// The sender accepts generated font spans, never general-purpose KMarkdown.
function colorPlain(content) {
  let cursor = 0, result = '', count = 0;
  const tokens = /\(font\)([^()\\`*_~\r\n]+)\(font\)\[(success|warning|danger|info|purple|secondary|tips)\]/g;
  for (const token of content.matchAll(tokens)) {
    const separator = content.slice(cursor, token.index);
    if (!/^[\s·：:]*$/.test(separator)) return null;
    result += separator + token[1]; cursor = token.index + token[0].length; count++;
  }
  const suffix = content.slice(cursor);
  return count && /^[\s·：:]*$/.test(suffix) ? result + suffix : null;
}

function clean(value, max = 70) {
  return String(value ?? '')
    .replace(/(?:admin-[a-f\d]{16,}|(?:sk|sk-proj)-[\w-]{12,}|\b1\/[A-Za-z\d+/=]+\/[A-Za-z\d+/=]+|bearer\s+\S+)/gi, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏]')
    .replace(/https?:\/\/[^\s]+/gi, '[链接]')
    .replace(/\((?:met|rol|chn|emj)\)/gi, '')
    .replace(/@(?:everyone|here|全体成员)/gi, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function dashboardLink(value) {
  if (typeof value !== 'string' || value.length > 1000) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.href.length <= 300 ? url.href : '';
  } catch { return ''; }
}

function number(value, maximumFractionDigits = 2) {
  return nonnegative(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value) : '未知';
}

function compact(value) {
  if (!nonnegative(value)) return '未知';
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return `${number(value / divisor, divisor === 1 ? 0 : 1)}${({ 1e3: 'K', 1e6: 'M', 1e9: 'B' })[divisor] || ''}`;
}

function amount(value, unit = 'USD') {
  if (!safeNumber(value)) return '未知';
  if (/^[A-Z]{3}$/.test(unit)) {
    const absolute = Math.abs(value);
    const digits = absolute > 0 && absolute < .01 ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const formatted = absolute > 0 && absolute < .000001 ? '<0.000001' : new Intl.NumberFormat('zh-CN', digits).format(absolute);
    return `${value < 0 ? '−' : ''}${unit === 'USD' ? '$' : ''}${formatted}${unit === 'USD' ? '' : ` ${unit}`}`;
  }
  if (value < 0) return '未知';
  return `${unit === 'tokens' ? compact(value) : number(value)}${({ requests: ' 次', tokens: ' Token' })[unit] || clean(unit, 10)}`;
}

function shortTime(value, timeZone) {
  if (value === null || value === undefined || value === '') return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function metricWindow(metric) {
  if (metric?.windowMinutes === 300 || /(?:5h|five-hour)/i.test(metric?.key || '')) return '5h';
  if (metric?.windowMinutes === 10080 || /(?:7d|seven-day)/i.test(metric?.key || '')) return '7d';
  return '';
}

function metricLabel(metric) {
  if (metric?.key === 'newapi-wallet') return '计价额';
  const label = metricWindow(metric) || clean(metric?.label || metric?.key || '额度', 24)
    .replace(/^小鸡毛·/, '').replace(/^本站设置的/, '').replace(/5 小时/g, '5h').replace(/7 天/g, '7d')
    .replace(/额度窗口/g, '').replace(/每周额度/, '7d').replace(/窗口剩余/, '窗口');
  return `${metric?.scope === 'local' ? '本站' : ''}${label}`;
}

function quotaField(metric, timeZone) {
  const label = metricLabel(metric);
  const freshness = metric?.freshness === 'stale' ? '（旧）' : metric?.freshness === 'unknown' ? '（时间未知）' : '';
  const reset = shortTime(metric?.resetAt, timeZone);
  const resetText = reset === '未知' ? '' : `\n重置 ${reset}`;
  if (metric?.kind === 'percent') {
    const battery = quotaBattery(metric);
    if (!battery) return plain(`${label} 未知${freshness}${resetText}`);
    const theme = battery.level === 'low' ? 'danger' : battery.level === 'warning' ? 'warning' : 'success';
    return styled(color(`${label} 剩余 ${battery.remainingText}%${freshness}${battery.level === 'low' ? ' · 电量低' : ''}${battery.used > 100 ? ` · 已用 ${battery.usedText}%` : ''}`, theme)
      + `\n${color(battery.text, theme)}${reset === '未知' ? '' : `\n${color(`重置 ${reset}`, 'tips')}`}`);
  }
  let value = '未知';
  if (safeNumber(metric?.value)) value = amount(metric.value, metric.unit);
  else if (safeNumber(metric?.remaining)) value = `剩余 ${amount(metric.remaining, metric.unit)}`;
  else if (nonnegative(metric?.used)) value = `已用 ${amount(metric.used, metric.unit)}${nonnegative(metric?.limit) ? ` / ${amount(metric.limit, metric.unit)}` : ''}`;
  else if (nonnegative(metric?.limit)) value = `总额 ${amount(metric.limit, metric.unit)}`;
  return styled(`${color(`${label}${freshness}`, 'info')}\n${color(value, 'info')}${reset === '未知' ? '' : `\n${color(`重置 ${reset}`, 'tips')}`}`);
}

function primaryMetrics(account) {
  const items = (Array.isArray(account?.metrics) ? account.metrics : [])
    .filter(item => item && typeof item === 'object' && !String(item.key || '').startsWith('grok-product-') && !['newapi-used', 'newapi-requests'].includes(item.key));
  // Stable selection keeps the two actual quota windows side by side.
  return [...items].sort((a, b) => {
    const rank = item => metricWindow(item) === '5h' ? 0 : metricWindow(item) === '7d' ? 1 : item.scope === 'local' ? 3 : 2;
    return rank(a) - rank(b);
  }).slice(0, 2);
}

function windowLine(window) {
  const label = `${window.periodKind === 'quota' ? '' : '近'}${window.key}`;
  const note = `${window.complete !== true ? '（未完成）' : ''}${window.freshness === 'stale' ? '（旧）' : window.freshness === 'unknown' ? '（时间未知）' : ''}`;
  return `${color(`本站 ${label}${note}`, window.freshness === 'stale' ? 'warning' : 'info')}：${color(`${number(window.requests, 0)} 次`, 'info')} · ${color(`${compact(window.tokens)} Token`, 'purple')} · ${color(`扣费 ${nonnegative(window.userCost) ? amount(window.userCost, window.currency) : '未知'}`, 'secondary')}`;
}

function accountModules(account, timeZone) {
  const selected = primaryMetrics(account);
  const windows = ['5h', '7d'].map(key => Array.isArray(account?.windowStats) ? account.windowStats.find(item => item?.key === key) : null).filter(Boolean);
  const scheduling = account?.schedulable === true ? '开启' : account?.schedulable === false ? '关闭' : '调度未知';
  const meta = [color(clean(account?.planLabel, 30) || '版本未知', 'purple'), color(scheduling, account?.schedulable === true ? 'success' : 'secondary')];
  if (account?.error) meta.push(color('查询异常', 'danger'));
  else if (account?.status === 'error') meta.push(color('账号异常', 'danger'));
  else if (['disabled', 'inactive'].includes(account?.status)) meta.push(color('账号停用', 'secondary'));
  else if (account?.status === 'rate_limited') meta.push(color('限流', 'warning'));
  const stale = [account, ...selected, ...windows].filter(item => item?.freshness === 'stale');
  if (stale.length) {
    const dates = stale.map(item => item.observedAt).filter(value => value && Number.isFinite(new Date(value).getTime())).sort((a, b) => new Date(a) - new Date(b));
    meta.push(color(`旧采样 ${shortTime(dates[0], timeZone)}`, 'warning'));
  }
  const fields = selected.length ? selected.map(item => quotaField(item, timeZone)) : [plain('额度未知')];
  return [
    { type: 'divider' },
    header(clean(account?.name || `账号 ${account?.id ?? ''}`, 70) || '未命名账号'),
    context(styled(meta.join(' · '))),
    { type: 'section', text: { type: 'paragraph', cols: fields.length, fields } },
    ...(windows.length ? [context(styled(windows.map(windowLine).join('\n')))] : []),
  ];
}

function withinBudget(cards) {
  const serialized = JSON.stringify(cards);
  return cards.reduce((sum, card) => sum + card.modules.length, 0) <= MAX_MODULES
    && serialized.length <= MAX_CONTENT && Buffer.byteLength(serialized, 'utf8') <= MAX_BYTES;
}

/** Build a read-only native card using only whitelisted display fields. */
export function buildBroadcastCards(snapshot, { timeZone = 'Asia/Shanghai', dashboardUrl = '' } = {}) {
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('时区格式不正确');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
  catch { throw new Error('时区不存在，请使用 Asia/Shanghai 等时区名称'); }
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const openaiOnly = accounts.length && accounts.every(account => account?.platform === 'openai');
  const enabled = accounts.filter(account => account?.schedulable === true).length;
  const disabled = accounts.filter(account => account?.schedulable === false).length;
  const issues = accounts.filter(account => account?.error || ['error', 'disabled', 'inactive', 'rate_limited'].includes(account?.status)).length;
  const modules = [header(`${openaiOnly ? 'OpenAI' : 'Sub2API'} 额度播报`), context(styled(`${color(`${accounts.length} 个账号`, 'info')} · ${color(`开启 ${enabled}`, 'success')} · ${color(`关闭 ${disabled}`, 'secondary')} · ${color(`异常 ${issues}`, issues ? 'danger' : 'tips')}`))];
  if (snapshot?.lastError || snapshot?.stale) modules.push(context(accounts.length ? '更新未完成，以下为上次快照。' : '账号列表读取失败，暂无可用快照。'));
  if (!accounts.length) modules.push({ type: 'section', text: plain('暂无账号数据') });
  const url = dashboardLink(dashboardUrl);
  const footer = [
    { type: 'divider' },
    context(`更新 ${shortTime(snapshot?.updatedAt || snapshot?.checkedAt, timeZone)}（${timeZone === 'Asia/Shanghai' ? '北京时间' : clean(timeZone, 80)}）\n电池显示剩余额度 · 未知≠0 · 旧值仅参考`),
    ...(url ? [{ type: 'action-group', elements: [{ type: 'button', theme: 'info', value: url, click: 'link', text: plain('打开额度看板') }] }] : []),
  ];
  const card = content => [{ type: 'card', theme: 'info', size: 'lg', modules: content }];
  let included = 0;
  for (const account of accounts) {
    const next = accountModules(account, timeZone);
    const notice = included + 1 < accounts.length ? [context(`另有 ${accounts.length - included - 1} 个账号，请在看板查看。`)] : [];
    if (!withinBudget(card([...modules, ...next, ...notice, ...footer]))) break;
    modules.push(...next);
    included += 1;
  }
  if (included < accounts.length) modules.push(context(`另有 ${accounts.length - included} 个账号，请在看板查看。`));
  const cards = card([...modules, ...footer]);
  validateBroadcastCards(cards);
  return cards;
}

/** Strict internal sender boundary. Returns true or throws a fixed safe error. */
export function validateBroadcastCards(cards) {
  const fail = () => { throw new Error('KOOK 卡片格式不符合安全限制'); };
  const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const text = (value, max = 2000, allowColor = true) => shape(value, ['type', 'content']) && (value.type === 'plain-text' || allowColor && value.type === 'kmarkdown')
    && typeof value.content === 'string' && value.content.length > 0 && value.content.length <= max
    && (value.type === 'plain-text' || colorPlain(value.content) !== null)
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.content)
    && !/(?:admin-[a-f\d]{16,}|(?:sk|sk-proj)-[\w-]{12,}|\b1\/[A-Za-z\d+/=]+\/[A-Za-z\d+/=]+|bearer\s+\S+|https?:\/\/|@(?:everyone|here|全体成员)|\((?:met|rol|chn|emj)\)|(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=])/i.test(value.content);
  if (!Array.isArray(cards) || !cards.length || cards.length > 5) fail();
  for (const card of cards) {
    if (!shape(card, ['type', 'theme', 'size', 'modules']) || card.type !== 'card'
      || card.theme !== 'info' || card.size !== 'lg' || !Array.isArray(card.modules) || !card.modules.length) fail();
    for (const module of card.modules) {
      if (module?.type === 'header') {
        if (!shape(module, ['type', 'text']) || !text(module.text, 100, false)) fail();
      } else if (module?.type === 'context') {
        if (!shape(module, ['type', 'elements']) || !Array.isArray(module.elements) || !module.elements.length || module.elements.length > 10 || !module.elements.every(item => text(item))) fail();
      } else if (module?.type === 'divider') {
        if (!shape(module, ['type'])) fail();
      } else if (module?.type === 'section') {
        if (!shape(module, ['type', 'text'])) fail();
        const body = module.text;
        if (!text(body) && !(shape(body, ['type', 'cols', 'fields']) && body.type === 'paragraph'
          && Number.isInteger(body.cols) && body.cols >= 1 && body.cols <= 3
          && Array.isArray(body.fields) && body.fields.length >= 1 && body.fields.length <= 50 && body.fields.every(item => text(item)))) fail();
      } else if (module?.type === 'action-group') {
        if (!shape(module, ['type', 'elements']) || !Array.isArray(module.elements) || !module.elements.length || module.elements.length > 4) fail();
        for (const item of module.elements) {
          if (!shape(item, ['type', 'theme', 'value', 'click', 'text']) || item.type !== 'button'
            || item.theme !== 'info' || item.click !== 'link' || !item.value || dashboardLink(item.value) !== item.value || !text(item.text, 100, false)) fail();
        }
      } else fail();
    }
  }
  if (!withinBudget(cards)) fail();
  return true;
}
