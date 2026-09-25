import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBroadcastCards, validateBroadcastCards } from './broadcast-cards.js';
import { quotaBattery } from './quota-battery.js';

const MAX_TIMES = 96;
const MAX_HISTORY = 20;
const MAX_LEDGER = 2048;
const DEFAULT_MAX_LENGTH = 4800;
const PLATFORM_NAMES = {
  openai: 'OpenAI', anthropic: 'Claude', claude: 'Claude',
  deepseek: 'DeepSeek', grok: 'Grok', gemini: 'Gemini',
};

function cleanText(value, length = 100) {
  return String(value ?? '')
    .replace(/(?:admin-[a-f\d]{16,}|(?:sk|sk-proj)-[\w-]{12,}|\b1\/[A-Za-z\d+/=]+\/[A-Za-z\d+/=]+|bearer\s+\S+)/gi, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏]')
    .replace(/https?:\/\/[^\s]+/gi, '[链接]')
    .replace(/\((?:met|rol|chn|emj)\)/gi, '')
    .replace(/@(?:everyone|here|全体成员)/gi, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, length);
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : null;
}

function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('时区格式不正确');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
  catch { throw new Error('时区不存在，请使用 Asia/Shanghai 等时区名称'); }
  return timeZone;
}

function dateValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatTime(value, timeZone) {
  const date = dateValue(value);
  if (!date) return '未知';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function publicDashboardUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.href.slice(0, 300);
  } catch { return ''; }
}

function costText(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知';
  const formatted = value > 0 && value < 0.000001 ? '<0.000001'
    : new Intl.NumberFormat('zh-CN', value > 0 && value < 0.01
      ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return `${currency === 'USD' || !currency ? '$' : ''}${formatted}${currency && currency !== 'USD' ? ` ${cleanText(currency, 8)}` : ''}`;
}

function compactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  const suffix = ({ 1000: 'K', 1000000: 'M', 1000000000: 'B' })[divisor] || '';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: divisor === 1 ? 0 : 1 }).format(value / divisor)}${suffix}`;
}

function shortTime(value, timeZone) {
  const formatted = formatTime(value, timeZone);
  return formatted === '未知' ? formatted : formatted.slice(5).replace('-', '/');
}

function freshnessText(value) {
  return value === 'stale' ? '（旧）' : value === 'unknown' ? '（时间未知）' : '';
}

function quotaProgress(metric) {
  const battery = quotaBattery(metric);
  return battery ? { label: `已用${battery.usedText}% · 剩余${battery.remainingText}%${battery.level === 'low' ? ' · 电量低' : ''}`, bar: battery.text } : null;
}

function metricText(metric, timeZone) {
  let label = cleanText(metric?.label || metric?.key || '额度', 36)
    .replace(/^小鸡毛·/, '').replace(/^本站设置的/, '').replace(/5 小时/g, '5h').replace(/7 天/g, '7d')
    .replace(/额度窗口/g, '').replace(/每周额度/, '7d').replace(/窗口剩余/, '窗口');
  if (metric?.key === 'newapi-wallet') label = '计价额';
  if (metric?.scope === 'local') label = `本站${label}`;
  const usedPercent = formatNumber(metric?.usedPercent);
  const remainingPercent = formatNumber(metric?.remainingPercent);
  const productShare = String(metric?.key || '').startsWith('grok-product-');
  const reset = metric?.resetAt && dateValue(metric.resetAt) ? ` · 重置${shortTime(metric.resetAt, timeZone)}` : '';
  let value = '';
  if (productShare) value = usedPercent === null ? '未知' : `占总额度${usedPercent}%（非独立额度）`;
  else if (metric?.kind === 'percent') {
    const progress = quotaProgress(metric);
    if (progress) return `${label} ${progress.label}${freshnessText(metric?.freshness)}\n  ${progress.bar}${reset}`;
    value = '未知';
  } else {
    const amount = number => {
      if (typeof number !== 'number' || !Number.isFinite(number)) return null;
      if (/^[A-Z]{3}$/.test(metric?.unit || '')) return `${number < 0 ? '−' : ''}${costText(Math.abs(number), metric.unit)}`;
      const unit = ({ requests: '次', tokens: ' Token' })[metric?.unit] || cleanText(metric?.unit, 12);
      return `${metric?.unit === 'tokens' ? compactNumber(number) : formatNumber(number)}${unit}`;
    };
    const remaining = amount(metric?.remaining), current = amount(metric?.value), used = amount(metric?.used), limit = amount(metric?.limit);
    if (current !== null) value = current;
    else if (remaining !== null) value = `剩余${remaining}`;
    else if (used !== null) value = `已用${used}${limit !== null ? `/${limit}` : ''}`;
    else if (limit !== null) value = `总额${limit}`;
    else if (remainingPercent !== null) value = `剩余${remainingPercent}%`;
    else if (usedPercent !== null) value = `已用${usedPercent}%`;
    // Local spending caps are independent operator limits, never upstream balances.
    if (metric?.scope === 'local' && remaining !== null && used !== null) value += `（已用${used}${limit !== null ? `/${limit}` : ''}）`;
  }
  return `${label} ${value || '未知'}${freshnessText(metric?.freshness)}${reset}`;
}

function windowText(window) {
  const label = window.key === '5h' ? '5h' : '7d';
  const period = window.periodKind === 'quota' ? label : `近${label}`;
  const suffix = `${window.complete !== true ? '（未完成）' : ''}${freshnessText(window.freshness)}`;
  if (window.complete === true && [window.requests, window.tokens, window.accountCost, window.userCost].every(value => value === 0)) {
    return `${period}${suffix} 无用量`;
  }
  if ([window.requests, window.tokens, window.accountCost, window.userCost].every(value => typeof value !== 'number' || !Number.isFinite(value))) {
    return `${period}${suffix} 用量未知`;
  }
  return `${period}${suffix} ${formatNumber(window.requests) ?? '未知'}次 · ${compactNumber(window.tokens)} Token`
    + ` · A${costText(window.accountCost, window.currency)} U${costText(window.userCost, window.currency)}`
    + (typeof window.estimatedTotalCost === 'number' && Number.isFinite(window.estimatedTotalCost) && window.estimatedTotalCost >= 0
      ? ` · 估${costText(window.estimatedTotalCost, window.currency)}` : '');
}

function resetCreditText(credits) {
  if (!credits || typeof credits !== 'object') return '';
  const count = formatNumber(credits.availableCount);
  const cached = formatNumber(credits.cachedCount);
  const history = count === null && cached !== null ? `（历史${cached}次）` : '';
  return `\n  重置卡${count === null ? '未知' : `${count}次`}${history}${freshnessText(credits.freshness)}`;
}

function oldSampleText(account, metrics, windows, timeZone) {
  const old = [...metrics, ...windows].filter(item => item?.freshness === 'stale').map(item => item.observedAt);
  if (account?.freshness === 'stale' && !old.length) old.push(account.observedAt);
  if (account?.resetCredits?.freshness === 'stale') old.push(account.resetCredits.checkedAt);
  if (!old.length) return '';
  const dates = old.map(dateValue).filter(Boolean).sort((a, b) => a - b);
  return `\n  旧采样 ${shortTime(dates[0], timeZone)}${dates.length && dates.length < old.length ? ' · 部分时间未知' : ''}`;
}

/** Produce plain text only. Raw credentials, provider response bodies and notes are never used. */
export function buildSummary(snapshot, { timeZone = 'Asia/Shanghai', maxLength = DEFAULT_MAX_LENGTH, dashboardUrl = '' } = {}) {
  timeZone = validTimeZone(timeZone);
  maxLength = Number.isFinite(maxLength) ? Math.max(600, Math.min(12000, Math.floor(maxLength))) : DEFAULT_MAX_LENGTH;
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const groups = new Map();
  for (const account of accounts) {
    const key = cleanText(account?.platform || '其他', 30).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  const dashboard = publicDashboardUrl(dashboardUrl);
  const hasWindowStats = accounts.some(account => Array.isArray(account?.windowStats) && account.windowStats.some(window => ['5h', '7d'].includes(window?.key)));
  const footer = `\n\n━━━━━━━━━━━━━━━━\n🕒 更新 ${shortTime(snapshot?.updatedAt || snapshot?.checkedAt, timeZone)}（${timeZone === 'Asia/Shanghai' ? '北京时间' : timeZone}）\n${hasWindowStats ? 'A账号费/U用户费，估为估算；估算不代表上游余额。' : ''}ℹ️ 未知≠0，旧值仅参考。${dashboard ? `\n🔗 详情：${dashboard}` : ''}`;
  const enabledCount = accounts.filter(account => account?.schedulable === true).length;
  const disabledCount = accounts.filter(account => account?.schedulable === false).length;
  const issueCount = accounts.filter(account => account?.error || ['error', 'disabled', 'inactive', 'rate_limited'].includes(account?.status)).length;
  let text = `✨ Sub2API 额度播报\n📊 账号额度 · ${accounts.length} 个账号\n✅ 开启 ${enabledCount} · ⚪ 关闭 ${disabledCount} · ⚠ 异常 ${issueCount}\n电池显示剩余额度`;
  if (snapshot?.lastError || snapshot?.stale) text += accounts.length ? '\n本次更新未完成，以下为上次快照。' : '\n账号列表读取失败，暂无可用快照。';
  let included = 0;
  let truncated = false;
  for (const [platform, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const heading = `\n\n【${PLATFORM_NAMES[platform] || cleanText(platform, 30)} · ${items.length} 个】`;
    let groupIncluded = false;
    for (const account of items) {
      const scheduling = account?.schedulable === true ? '开启' : account?.schedulable === false ? '关闭' : '调度未知';
      const problem = account?.error ? ' · 查询异常' : account?.status === 'error' ? ' · 账号异常' : ['disabled', 'inactive'].includes(account?.status) ? ' · 账号停用' : '';
      const allMetrics = Array.isArray(account?.metrics) ? account.metrics : [];
      const isSecondary = metric => String(metric?.key || '').startsWith('grok-product-') || ['newapi-used', 'newapi-requests'].includes(metric?.key);
      const metrics = allMetrics.filter(metric => !isSecondary(metric)).slice(0, 8);
      const windows = ['5h', '7d'].map(key => Array.isArray(account?.windowStats) ? account.windowStats.find(window => window?.key === key) : null).filter(Boolean);
      const name = cleanText(account?.name || `账号 ${account?.id ?? ''}`, 70);
      const plan = cleanText(account?.planLabel, 36);
      const planText = plan && plan !== '版本未知' ? ` · ${plan}` : plan === '版本未知' ? ' · 版本未知' : '';
      const body = `\n▸ ${name}${planText} · ${scheduling}${problem}`
        + `\n  ${metrics.length ? metrics.map(metric => metricText(metric, timeZone)).join('\n  ') : '额度未知'}`
        + (allMetrics.length > metrics.length ? `\n  另${allMetrics.length - metrics.length}项见看板` : '')
        + (windows.length ? `\n  ${windows.map(windowText).join('\n  ')}` : '')
        + resetCreditText(account?.resetCredits)
        + oldSampleText(account, metrics, windows, timeZone);
      const part = (groupIncluded ? '' : heading) + body;
      if (text.length + part.length + footer.length + 70 > maxLength) {
        truncated = true;
        continue;
      }
      text += part;
      groupIncluded = true;
      included += 1;
    }
  }
  if (!accounts.length) text += '\n暂无账号数据。';
  if (truncated) text += `\n\n篇幅限制，另有 ${accounts.length - included} 个账号请在看板查看。`;
  return text + footer;
}

class DeliveryError extends Error {
  constructor(message, { code, delivery = 'uncertain', status } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.delivery = delivery;
    if (status !== undefined) this.status = status;
  }
}

function errorMessage(error) {
  if (error?.code === 'SEND_TIMEOUT' || error?.code === 'KOOK_SEND_TIMEOUT') return '发送超时，送达状态待确认；本时段不自动重发。';
  if (String(error?.code || '').startsWith('KOOK_UPLOAD_')) return 'KOOK 图片上传失败，本时段未发送。';
  if (error?.code === 'IMAGE_RENDER' || error?.code === 'INVALID_IMAGES') return '播报图片生成失败，本时段未发送。';
  if (error?.code === 'KOOK_HTTP') return `KOOK 请求失败（HTTP ${Number(error.status) || 0}）。`;
  if (error?.code === 'KOOK_API') return `KOOK 返回错误（代码 ${Number(error.status) || 0}）。`;
  if (error?.code === 'KOOK_RESPONSE') return 'KOOK 未返回可确认的消息编号，送达状态待确认。';
  if (error?.code === 'SNAPSHOT_ERROR') return '读取缓存额度失败，本时段未发送。';
  if (error?.code === 'SEND_CANCELLED') return '播报已关闭或配置已变更，本时段未发送。';
  if (error?.code === 'STORAGE_ERROR') return '播报状态保存失败，已停止本次发送。';
  return '发送连接异常，送达状态待确认；本时段不自动重发。';
}

function splitText(text, limit = 1400) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    // Do not split the UTF-16 pair of an emoji.
    if (/^[\uDC00-\uDFFF]$/.test(rest[end])) end -= 1;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

async function limitedJson(response) {
  if (Number(response.headers?.get?.('content-length')) > 65536) throw new Error('response too large');
  let value = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 65536) { await reader.cancel(); throw new Error('response too large'); }
        value += decoder.decode(chunk, { stream: true });
      }
      value += decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    value = await response.text();
    if (Buffer.byteLength(value) > 65536) throw new Error('response too large');
  }
  return JSON.parse(value);
}

/** Returns send(text, {signal}) and always targets the fixed official KOOK API. */
export function createKookSender({ token, channelId, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('KOOK Token 未配置或格式不正确');
  if (typeof channelId !== 'string' || !/^\d{5,30}$/.test(channelId)) throw new Error('KOOK 文字频道 ID 格式不正确');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持发送请求');
  return async function send(text, { signal, cards } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
      throw new DeliveryError('播报文本长度不正确', { code: 'INVALID_MESSAGE', delivery: 'not_sent' });
    }
    if (cards !== undefined) {
      try { validateBroadcastCards(cards); }
      catch { throw new DeliveryError('播报卡片格式不正确', { code: 'INVALID_MESSAGE', delivery: 'not_sent' }); }
    }
    const content = JSON.stringify(cards || [{
      type: 'card', theme: 'secondary', size: 'lg',
      modules: splitText(text).map(part => ({ type: 'section', text: { type: 'plain-text', content: part } })),
    }]);
    if (content.length > 8000) throw new DeliveryError('播报卡片长度超过限制', { code: 'INVALID_MESSAGE', delivery: 'not_sent' });
    let response;
    try {
      response = await fetchImpl('https://www.kookapp.cn/api/v3/message/create', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bot ${token.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 10, target_id: channelId, content }),
      });
    } catch {
      throw new DeliveryError('KOOK 网络连接异常', { code: 'KOOK_NETWORK' });
    }
    if (!response.ok) {
      throw new DeliveryError('KOOK HTTP 请求失败', {
        code: 'KOOK_HTTP', status: response.status,
        delivery: response.status >= 400 && response.status < 500 ? 'rejected' : 'uncertain',
      });
    }
    let payload;
    try { payload = await limitedJson(response); }
    catch { throw new DeliveryError('KOOK 响应无法确认', { code: 'KOOK_RESPONSE' }); }
    if (typeof payload?.code !== 'number') throw new DeliveryError('KOOK 响应无法确认', { code: 'KOOK_RESPONSE' });
    if (payload.code !== 0) throw new DeliveryError('KOOK 接口返回错误', { code: 'KOOK_API', status: payload.code, delivery: 'rejected' });
    const messageId = payload.data?.msg_id;
    if (typeof messageId !== 'string' || !/^[\w-]{1,128}$/.test(messageId)) {
      throw new DeliveryError('KOOK 未返回消息编号', { code: 'KOOK_RESPONSE' });
    }
    return { messageId };
  };
}

function clockParts(timestamp, timeZone) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const date = `${fields.year}-${fields.month}-${fields.day}`;
  const time = `${fields.hour}:${fields.minute}`;
  return { date, time, slot: `${timeZone}|${date}|${time}` };
}

function normalizeConfig(value, fallbackTimeZone = 'Asia/Shanghai') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('播报配置格式不正确');
  if (typeof value.enabled !== 'boolean') throw new Error('请选择是否启用固定时间播报');
  if (!Array.isArray(value.times) || value.times.length > MAX_TIMES || value.times.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error(`每日播报时间须为 HH:mm，最多 ${MAX_TIMES} 个`);
  }
  const times = [...new Set(value.times)].sort();
  if (value.enabled && !times.length) throw new Error('请先设置至少一个每日播报时间');
  return { enabled: value.enabled, times, timeZone: validTimeZone(value.timeZone ?? fallbackTimeZone) };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function safeRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.slot !== 'string' || record.slot.length > 130) return null;
  const statuses = ['dispatching', 'sent', 'failed', 'uncertain', 'cancelled'];
  if (!statuses.includes(record.status) || !dateValue(record.at)) return null;
  const result = { slot: cleanText(record.slot, 130), at: new Date(record.at).toISOString(), status: record.status };
  if (typeof record.messageId === 'string' && /^[\w-]{1,128}$/.test(record.messageId)) result.messageId = record.messageId;
  if (typeof record.error === 'string') result.error = cleanText(record.error, 180);
  return result;
}

/** One fixed-time dispatch per local date/time, with a durable ledger before sending. */
export class BroadcastScheduler {
  constructor({ dataDir, getSnapshot, send, imageRenderer, beforeBroadcast, beforeBroadcastTimeoutMs = 135000, now = Date.now, dashboardUrl = '', timeZone = 'Asia/Shanghai', pollIntervalMs = 15000, sendTimeoutMs = 15000, snapshotTimeoutMs = 5000, writeState = atomicJson } = {}) {
    if (!dataDir || typeof getSnapshot !== 'function') throw new Error('播报服务缺少数据目录或额度读取方法');
    this.file = join(dataDir, 'broadcast.json');
    this.dataDir = dataDir;
    this.getSnapshot = getSnapshot;
    this.send = typeof send === 'function' ? send : null;
    this.imageRenderer = imageRenderer;
    this.beforeBroadcast = beforeBroadcast;
    this.beforeBroadcastTimeoutMs = beforeBroadcastTimeoutMs;
    this.now = now;
    this.dashboardUrl = dashboardUrl;
    this.pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.sendTimeoutMs = Math.max(1, sendTimeoutMs);
    this.snapshotTimeoutMs = Math.max(1, snapshotTimeoutMs);
    this.writeState = writeState;
    this.state = { version: 1, config: { enabled: false, times: [], timeZone: validTimeZone(timeZone) }, ledger: [], history: [] };
    this.closed = false;
    this.initialized = false;
    this.storageError = null;
    this.generation = 0;
    this.blockedSlot = null;
    this.operations = Promise.resolve();
    this.flight = null;
    this.timer = null;
    this.abortController = null;
  }

  async init() {
    if (this.initialized) return this.snapshot();
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.ledger) || !Array.isArray(saved.history)) throw new Error('invalid broadcast state');
      const config = normalizeConfig(saved.config);
      const recovered = item => item.status === 'dispatching' ? { ...item, status: 'uncertain', error: '上次发送未完成确认；本时段不自动重发。' } : item;
      this.state = { version: 1, config, ledger: saved.ledger.map(safeRecord).filter(Boolean).slice(-MAX_LEDGER).map(recovered), history: saved.history.map(safeRecord).filter(Boolean).slice(-MAX_HISTORY).map(recovered) };
      if (!this.send) this.state.config.enabled = false;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.storageError = '播报配置文件无法读取，已停用播报；原文件未改动。';
      }
    }
    this.blockedSlot = clockParts(this.now(), this.state.config.timeZone).slot;
    this.initialized = true;
    return this.snapshot();
  }

  snapshot() {
    const history = this.state.history.map(item => ({ ...item }));
    const lastSent = [...history].reverse().find(item => item.status === 'sent');
    const last = history.at(-1);
    return {
      ...this.state.config, times: [...this.state.config.times], available: Boolean(this.send),
      lastSentAt: lastSent?.at || null, lastError: last && ['failed', 'uncertain'].includes(last.status) ? last.error || '最近一次播报未确认成功。' : null,
      history: history.reverse(), storageError: this.storageError,
    };
  }

  enqueue(operation) {
    const promise = this.operations.then(operation);
    this.operations = promise.catch(() => {});
    return promise;
  }

  async persist(next) {
    if (this.storageError) throw new DeliveryError('播报文件不可写', { code: 'STORAGE_ERROR', delivery: 'not_sent' });
    try { await this.writeState(this.file, next); }
    catch {
      this.storageError = '播报状态保存失败，已暂停发送；请检查磁盘和文件权限。';
      throw new DeliveryError('播报状态保存失败', { code: 'STORAGE_ERROR', delivery: 'not_sent' });
    }
    this.state = next;
  }

  async configure(value, { authorize = () => {} } = {}) {
    return this.enqueue(async () => {
      authorize();
      if (!this.initialized || this.closed) throw new Error('播报服务尚未启动或已经关闭');
      const config = normalizeConfig(value, this.state.config.timeZone);
      if (config.enabled && !this.send) throw new Error('请先配置 KOOK 机器人和文字频道，才能启用播报');
      const next = { ...this.state, config };
      authorize();
      await this.persist(next);
      this.generation += 1;
      this.blockedSlot = clockParts(this.now(), config.timeZone).slot;
      return this.snapshot();
    });
  }

  async preview() {
    const snapshot = await this.getSnapshot();
    const images = this.imageRenderer ? await this.imageRenderer.render(snapshot, { timeZone: this.state.config.timeZone, dashboardUrl: this.dashboardUrl }) : null;
    return {
      text: buildSummary(snapshot, { timeZone: this.state.config.timeZone, dashboardUrl: this.dashboardUrl }),
      cards: buildBroadcastCards(snapshot, { timeZone: this.state.config.timeZone, dashboardUrl: this.dashboardUrl }),
      generatedAt: new Date(this.now()).toISOString(),
      accountCount: Array.isArray(snapshot?.accounts) ? snapshot.accounts.length : 0,
      ...(images ? { format: 'image', images: images.images.map(({ id, width, height, alt }) => ({ url: `./api/report-images/${id}.png`, width, height, alt })), truncatedCount: images.truncatedCount || 0 } : {}),
    };
  }

  previewImage(id) { return this.imageRenderer?.getImage(id) || null; }

  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async reserve() {
    return this.enqueue(async () => {
      if (!this.initialized || this.closed || this.storageError || !this.send || !this.state.config.enabled) return null;
      const current = clockParts(this.now(), this.state.config.timeZone);
      if (!this.state.config.times.includes(current.time) || current.slot === this.blockedSlot || this.state.ledger.some(item => item.slot === current.slot)) return null;
      const entry = { slot: current.slot, at: new Date(this.now()).toISOString(), status: 'dispatching' };
      const next = { ...this.state, ledger: [...this.state.ledger, entry].slice(-MAX_LEDGER), history: [...this.state.history, entry].slice(-MAX_HISTORY) };
      await this.persist(next);
      return { ...entry, generation: this.generation, timeZone: this.state.config.timeZone };
    });
  }

  active(reservation) {
    return !this.closed && !this.storageError && this.state.config.enabled && this.generation === reservation.generation;
  }

  async finish(reservation, outcome) {
    return this.enqueue(async () => {
      const entry = { slot: reservation.slot, at: new Date(this.now()).toISOString(), ...outcome };
      const replace = items => items.map(item => item.slot === reservation.slot ? entry : item);
      // A persisted dispatching entry remains enough to prevent duplicates if this write fails.
      await this.persist({ ...this.state, ledger: replace(this.state.ledger), history: replace(this.state.history) });
    });
  }

  async bounded(operation, timeoutMs, controller, code) {
    let timer;
    let onAbort;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeliveryError(code === 'SNAPSHOT_ERROR' ? '读取缓存超时' : '发送超时', { code, delivery: code === 'SNAPSHOT_ERROR' ? 'not_sent' : 'uncertain' }));
        controller.abort();
      }, timeoutMs);
    });
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new DeliveryError('操作已中断', {
        code: code === 'SNAPSHOT_ERROR' ? 'SEND_CANCELLED' : 'SEND_INTERRUPTED',
        delivery: code === 'SNAPSHOT_ERROR' ? 'not_sent' : 'uncertain',
      }));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), timeout, cancelled]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  }

  tick() {
    if (this.flight) return this.flight;
    this.flight = this.dispatch().finally(() => { this.flight = null; });
    return this.flight;
  }

  async dispatch() {
    const reservation = await this.reserve();
    if (!reservation) return false;
    const controller = new AbortController();
    this.abortController = controller;
    let outcome;
    try {
      if (!this.active(reservation)) throw new DeliveryError('配置已变更', { code: 'SEND_CANCELLED', delivery: 'not_sent' });
      if (this.beforeBroadcast) await this.bounded(() => this.beforeBroadcast({ signal: controller.signal }), this.beforeBroadcastTimeoutMs, controller, 'SNAPSHOT_ERROR');
      let cached;
      try {
        cached = await this.bounded(() => this.getSnapshot(), this.snapshotTimeoutMs, controller, 'SNAPSHOT_ERROR');
      } catch {
        if (!this.active(reservation)) throw new DeliveryError('配置已变更', { code: 'SEND_CANCELLED', delivery: 'not_sent' });
        throw new DeliveryError('读取缓存额度失败', { code: 'SNAPSHOT_ERROR', delivery: 'not_sent' });
      }
      if (!this.active(reservation) || controller.signal.aborted) throw new DeliveryError('配置已变更', { code: 'SEND_CANCELLED', delivery: 'not_sent' });
      const text = buildSummary(cached, { timeZone: reservation.timeZone, dashboardUrl: this.dashboardUrl });
      const cards = buildBroadcastCards(cached, { timeZone: reservation.timeZone, dashboardUrl: this.dashboardUrl });
      const result = await this.bounded(() => {
        if (!this.active(reservation) || controller.signal.aborted) throw new DeliveryError('配置已变更', { code: 'SEND_CANCELLED', delivery: 'not_sent' });
        return (async () => {
          let rendered = null;
          try { rendered = this.imageRenderer ? await this.imageRenderer.render(cached, { timeZone: reservation.timeZone, dashboardUrl: this.dashboardUrl, signal: controller.signal }) : null; }
          catch { throw new DeliveryError('播报图片生成失败', { code: 'IMAGE_RENDER', delivery: 'not_sent' }); }
          if (!this.active(reservation) || controller.signal.aborted) throw new DeliveryError('配置已变更', { code: 'SEND_CANCELLED', delivery: 'not_sent' });
          return this.send(text, { signal: controller.signal, slot: reservation.slot, scheduledAt: reservation.at, cards, ...(rendered ? { images: rendered.images } : {}) });
        })();
      }, this.sendTimeoutMs, controller, 'SEND_TIMEOUT');
      if (!result?.messageId || typeof result.messageId !== 'string' || !/^[\w-]{1,128}$/.test(result.messageId)) throw new DeliveryError('未取得消息编号', { code: 'KOOK_RESPONSE' });
      outcome = { status: 'sent', messageId: result.messageId };
    } catch (error) {
      outcome = { status: error.code === 'SEND_CANCELLED' ? 'cancelled' : ['not_sent', 'rejected'].includes(error.delivery) ? 'failed' : 'uncertain', error: errorMessage(error) };
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
    await this.finish(reservation, outcome);
    return outcome.status === 'sent';
  }

  async close() {
    this.closed = true;
    this.generation += 1;
    clearInterval(this.timer);
    this.timer = null;
    this.abortController?.abort();
    // Do not wait for uncooperative remote calls; the pre-dispatch ledger is already durable.
    await this.operations;
  }
}
