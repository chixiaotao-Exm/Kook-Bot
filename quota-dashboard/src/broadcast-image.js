import { createHash } from 'node:crypto';
import { quotaBattery } from './quota-battery.js';

const WIDTH = 1800;
const MARGIN = 48;
const GAP = 28;
const CARD_WIDTH = (WIDTH - MARGIN * 2 - GAP) / 2;
const CARD_SCALE = CARD_WIDTH / 916;
const MAX_ACCOUNTS = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLORS = { normal: '#76e8c1', warning: '#ffce76', low: '#ff8eaa', unknown: '#c5d4eb' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value >= 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function clean(value, max = 80) {
  return String(value ?? '')
    .replace(/(?:admin-[a-f\d]{16,}|(?:sk|sk-proj)-[\w-]{12,}|\b1\/[A-Za-z\d+/=]+\/[A-Za-z\d+/=]+|bearer\s+\S+)/gi, '[已隐藏]')
    .replace(/(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏]')
    .replace(/https?:\/\/[^\s]+/gi, '[链接]')
    .replace(/\((?:met|rol|chn|emj)\)/gi, '').replace(/@(?:everyone|here|全体成员)/gi, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function dateText(value, timeZone) {
  if (value === null || value === undefined || value === '') return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function amount(value, unit = 'USD') {
  if (!finite(value)) return '未知';
  if (unit === 'tokens') return `${compact(value)} Token`;
  if (unit === 'requests') return `${number(value)} 次`;
  const digits = Math.abs(value) > 0 && Math.abs(value) < .01 ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const formatted = Math.abs(value) > 0 && Math.abs(value) < .000001 ? '<0.000001' : new Intl.NumberFormat('zh-CN', digits).format(Math.abs(value));
  return `${value < 0 ? '−' : ''}${unit === 'USD' ? '$' : ''}${formatted}${unit === 'USD' ? '' : ` ${clean(unit, 8)}`}`;
}

function number(value) { return positive(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value) : '未知'; }
function compact(value) {
  if (!positive(value)) return '未知';
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: divisor === 1 ? 0 : 1 }).format(value / divisor)}${({ 1e3: 'K', 1e6: 'M', 1e9: 'B' })[divisor] || ''}`;
}
function windowKey(metric) {
  if (metric?.windowMinutes === 300 || /(?:5h|five-hour)/i.test(metric?.key || '')) return '5h';
  if (metric?.windowMinutes === 10080 || /(?:7d|seven-day)/i.test(metric?.key || '')) return '7d';
  return '';
}
function freshness(value) { return value === 'stale' ? '旧值' : value === 'unknown' ? '时间未知' : ''; }
function metricData(metric, timeZone) {
  const label = `${metric?.scope === 'local' ? '本站 ' : ''}${windowKey(metric) || clean(metric?.label || metric?.key || '额度', 16)}`;
  const battery = metric?.kind === 'percent' ? quotaBattery(metric) : null;
  const result = { label, freshness: freshness(metric?.freshness), reset: dateText(metric?.resetAt, timeZone), battery };
  if (metric?.kind === 'percent') result.value = battery ? `剩余 ${battery.remainingText}%` : '额度未知';
  else if (finite(metric?.value)) result.value = amount(metric.value, metric.unit);
  else if (finite(metric?.remaining)) result.value = `剩余 ${amount(metric.remaining, metric.unit)}`;
  else if (positive(metric?.used)) result.value = `已用 ${amount(metric.used, metric.unit)}`;
  else if (positive(metric?.limit)) result.value = `总额 ${amount(metric.limit, metric.unit)}`;
  else result.value = '额度未知';
  return result;
}

function accountData(account, timeZone) {
  const candidates = (Array.isArray(account?.metrics) ? account.metrics : []).filter(metric => metric && typeof metric === 'object'
    && !String(metric.key || '').startsWith('grok-product-') && !['newapi-used', 'newapi-requests'].includes(metric.key));
  const rank = metric => windowKey(metric) === '5h' ? 0 : windowKey(metric) === '7d' ? 1 : metric?.scope === 'local' ? 3 : 2;
  const metrics = [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  const windows = ['5h', '7d'].map(key => Array.isArray(account?.windowStats) ? account.windowStats.find(item => item?.key === key) : null).filter(Boolean);
  const old = [account, ...metrics, ...windows].filter(item => item?.freshness === 'stale');
  const dates = old.map(item => item.observedAt).filter(value => value && Number.isFinite(new Date(value).getTime())).sort((a, b) => new Date(a) - new Date(b));
  let problem = account?.error ? '查询异常' : account?.status === 'error' ? '账号异常' : ['disabled', 'inactive'].includes(account?.status) ? '账号停用' : account?.status === 'rate_limited' ? '限流' : '';
  return {
    name: clean(account?.name || '未命名账号', 70) || '未命名账号',
    plan: lines(clean(account?.planLabel, 30) || '版本未知', 26, 390, 1)[0],
    enabled: account?.schedulable === true ? true : account?.schedulable === false ? false : null,
    problem,
    stale: old.length ? `旧采样 ${dateText(dates[0], timeZone)}` : '',
    metrics: metrics.length ? metrics.map(metric => metricData(metric, timeZone)) : [{ label: '平台额度', value: '额度未知', battery: null, reset: '未知', freshness: '' }],
    extraMetrics: Math.max(0, candidates.length - metrics.length),
    windows: windows.map(window => ({ label: `本站 ${window.periodKind === 'quota' ? '' : '近'}${window.key}${window.complete !== true ? '（未完成）' : ''}${freshness(window.freshness) ? `（${freshness(window.freshness)}）` : ''}`,
      value: `${number(window.requests)} 次 · ${compact(window.tokens)} Token · 扣费 ${positive(window.userCost) ? amount(window.userCost, window.currency) : '未知'}` })),
  };
}

function dashboardHost(value) {
  if (typeof value !== 'string' || value.length > 1000) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return clean(url.host, 64);
  } catch { return ''; }
}

function normalize(snapshot, options) {
  const timeZone = options.timeZone ?? 'Asia/Shanghai';
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('时区格式不正确');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); } catch { throw new Error('时区不存在'); }
  const all = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  return {
    title: all.length && all.every(account => account?.platform === 'openai') ? 'OpenAI 额度播报' : 'Sub2API 额度播报',
    accountCount: all.length,
    truncatedCount: Math.max(0, all.length - MAX_ACCOUNTS),
    enabledCount: all.filter(account => account?.schedulable === true).length,
    issueCount: all.filter(account => account?.error || ['error', 'disabled', 'inactive', 'rate_limited'].includes(account?.status)).length,
    updatedAt: dateText(snapshot?.updatedAt || snapshot?.checkedAt, timeZone),
    zoneLabel: timeZone === 'Asia/Shanghai' ? '北京时间' : clean(timeZone, 80),
    stale: Boolean(snapshot?.lastError || snapshot?.stale),
    dashboardHost: dashboardHost(options.dashboardUrl),
    accounts: all.slice(0, MAX_ACCOUNTS).map(account => accountData(account, timeZone)),
  };
}

// Estimate rendered width conservatively so CJK names never cross a card edge.
function textWidth(value, size) { return [...value].reduce((width, c) => width + (/[\x20-\x7e]/.test(c) ? .62 : 1) * size, 0); }
function lines(value, size, maxWidth, maxLines = 2) {
  const result = [''];
  for (const c of value) {
    let current = result.length - 1;
    if (textWidth(result[current] + c, size) > maxWidth) {
      if (result.length >= maxLines) { result[current] = result[current].slice(0, -1) + '…'; break; }
      result.push(''); current++;
    }
    result[current] += c;
  }
  return result;
}

const text = (x, y, value, size = 26, color = '#c0d2eb', weight = 400, more = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" ${more}>${xml(value)}</text>`;
function batterySvg(battery, x, y, width) {
  const color = COLORS[battery.level];
  const cellWidth = (width - 28 - 9 * 6) / 10;
  return `<rect x="${x}" y="${y}" width="${width}" height="58" rx="13" fill="#091829" fill-opacity=".5" stroke="${color}" stroke-width="2"/>
    <rect x="${x + width}" y="${y + 18}" width="9" height="23" rx="3" fill="${color}"/>
    ${Array.from({ length: 10 }, (_, i) => `<rect x="${x + 14 + i * (cellWidth + 6)}" y="${y + 12}" width="${cellWidth}" height="34" rx="5" fill="${i < battery.filled ? color : '#bedcff'}" fill-opacity="${i < battery.filled ? '.94' : '.1'}"/>${i < battery.filled ? `<rect x="${x + 14 + i * (cellWidth + 6)}" y="${y + 12}" width="${cellWidth}" height="15" rx="5" fill="url(#cellShine)"/>` : ''}`).join('')}`;
}

function accountLayout(account) {
  const nameLines = lines(account.name, 34, 850);
  const topExtra = (nameLines.length - 1) * 43;
  const staleExtra = account.stale ? 35 : 0;
  const windowLines = account.windows.length;
  const height = 341 + topExtra + staleExtra + (windowLines ? 25 + windowLines * 67 : 0) + (account.extraMetrics ? 34 : 0);
  return { nameLines, topExtra, staleExtra, windowLines, height };
}

function accountSvg(account, index, height = accountLayout(account).height) {
  const { nameLines, topExtra, staleExtra, windowLines } = accountLayout(account);
  let svg = `<g data-account-card="${index}" data-card-height="${height}"><rect x="0" y="8" width="916" height="${height}" rx="29" fill="#071024" fill-opacity=".22"/>
    <rect width="916" height="${height}" rx="29" fill="url(#glass${index % 2})" stroke="#b7d9ff" stroke-opacity=".29" stroke-width="1.5"/>
    <path d="M 29 1 H 887" stroke="#e0f1ff" stroke-opacity=".45" stroke-width="1.5"/>
    ${nameLines.map((line, n) => text(30, 53 + n * 43, line, 34, '#f4f8ff', 600)).join('')}`;
  const metaY = 98 + topExtra;
  const planWidth = Math.min(540, textWidth(account.plan, 26) + 27);
  const scheduling = account.enabled === true ? '开启' : account.enabled === false ? '关闭' : '状态未知';
  const statusColor = account.enabled === true ? '#76e8c1' : '#bac8df';
  svg += `<rect x="30" y="${metaY - 27}" width="${planWidth}" height="38" rx="9" fill="#bca5ff" fill-opacity=".1" stroke="#d5c4ff" stroke-opacity=".25"/>`
    + text(43, metaY, account.plan, 26, '#d9cbff', 500)
    + `<circle cx="${planWidth + 59}" cy="${metaY - 9}" r="5" fill="${statusColor}"/>`
    + text(planWidth + 73, metaY, scheduling, 26, statusColor);
  if (account.problem) svg += text(878, metaY, account.problem, 26, account.problem === '限流' ? COLORS.warning : COLORS.low, 400, 'text-anchor="end"');
  if (account.stale) svg += text(30, metaY + 39, account.stale, 26, COLORS.warning);
  const quotaY = metaY + 53 + staleExtra;
  const columnWidth = account.metrics.length === 1 ? 842 : 412;
  for (let i = 0; i < account.metrics.length; i++) {
    const metric = account.metrics[i];
    const x = 30 + i * 454;
    const color = metric.battery ? COLORS[metric.battery.level] : COLORS.unknown;
    svg += text(x, quotaY, `${metric.label}${metric.freshness ? ` · ${metric.freshness}` : ''}`, 26, '#c0d2eb');
    if (metric.battery) {
      svg += text(x, quotaY + 49, metric.value, 39, color, 600)
        + batterySvg(metric.battery, x, quotaY + 71, Math.min(392, columnWidth - 18))
        + text(x, quotaY + 165, metric.reset === '未知' ? '重置时间未知' : `重置 ${metric.reset}`, 26, '#b9cbe5');
      if (account.metrics.length === 1) {
        if (metric.battery.level === 'low') svg += text(x + 470, quotaY + 91, '剩余额度偏低', 29, color, 500);
        svg += text(x + 470, quotaY + 132, `已用 ${metric.battery.usedText}%`, 27, '#aabeDA');
      } else if (metric.battery.used > 100) svg += text(x + 392, quotaY, `已用 ${metric.battery.usedText}%`, 24, color, 400, 'text-anchor="end"');
    } else {
      const valueLines = lines(metric.value, 34, columnWidth, 2);
      svg += valueLines.map((line, n) => text(x, quotaY + 53 + n * 44, line, 34, color, 500)).join('')
        + text(x, quotaY + 165, metric.reset === '未知' ? '未提供重置时间' : `重置 ${metric.reset}`, 26, '#a9bdd9');
    }
  }
  let usageY = quotaY + 204;
  if (windowLines) {
    svg += `<path d="M 30 ${usageY - 14} H 886" stroke="#bcd8fb" stroke-opacity=".17"/>`;
    for (const window of account.windows) {
      svg += text(30, usageY + 17, window.label, 25, '#a9c2e4', 500)
        + text(30, usageY + 49, lines(window.value, 26, 856, 1)[0], 26, '#d0def1');
      usageY += 67;
    }
  }
  if (account.extraMetrics) svg += text(30, height - 22, `另 ${account.extraMetrics} 项额度见看板`, 25, '#a9bdd9');
  return { svg: svg + '</g>', height };
}

function posterSvg(data) {
  const accounts = data.accounts;
  let y = data.stale ? 247 : 207;
  let bodies = '';
  for (let start = 0; start < accounts.length; start += 2) {
    const row = accounts.slice(start, start + 2);
    const rowHeight = Math.max(...row.map(account => accountLayout(account).height));
    for (const [column, account] of row.entries()) {
      const x = MARGIN + column * (CARD_WIDTH + GAP);
      const rendered = accountSvg(account, start + column, rowHeight);
      bodies += `<g transform="translate(${x} ${y}) scale(${CARD_SCALE})">${rendered.svg}</g>`;
    }
    y += Math.ceil(rowHeight * CARD_SCALE) + GAP;
  }
  if (!accounts.length) { bodies += text(60, y + 62, data.stale ? '账号读取失败，暂无可用快照' : '暂无账号数据', 32, '#d2e0f3'); y += 150; }
  const footerHeight = data.truncatedCount ? 170 : 130;
  const height = y + footerHeight;
  const footer = `${text(MARGIN, y + 25, `更新 ${data.updatedAt} · ${data.zoneLabel}`, 28, '#bdcfe8')}
    ${text(MARGIN, y + 65, '电池显示剩余额度 · 未知 ≠ 0 · 旧值仅参考', 27, '#a9bdda')}
    ${text(MARGIN, y + 105, data.dashboardHost || '更多详情请打开额度看板', 27, '#9ecbff')}
    ${data.truncatedCount ? text(MARGIN, y + 145, `另 ${data.truncatedCount} 个账号见看板`, 27, COLORS.warning) : ''}
    ${text(WIDTH - MARGIN, y + 105, '完整总览', 27, '#d1def2', 500, 'text-anchor="end"')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#102239"/><stop offset=".48" stop-color="#1d2f53"/><stop offset="1" stop-color="#102139"/></linearGradient>
      <radialGradient id="orbCyan"><stop stop-color="#7bdddf" stop-opacity=".32"/><stop offset=".56" stop-color="#409fbf" stop-opacity=".19"/><stop offset="1" stop-color="#409fbf" stop-opacity="0"/></radialGradient>
      <radialGradient id="orbPurple"><stop stop-color="#c6adff" stop-opacity=".29"/><stop offset=".5" stop-color="#8b78dc" stop-opacity=".18"/><stop offset="1" stop-color="#8b78dc" stop-opacity="0"/></radialGradient>
      <linearGradient id="glass0" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#43678b" stop-opacity=".56"/><stop offset=".6" stop-color="#284568" stop-opacity=".76"/><stop offset="1" stop-color="#203652" stop-opacity=".82"/></linearGradient>
      <linearGradient id="glass1" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#436083" stop-opacity=".58"/><stop offset=".6" stop-color="#324765" stop-opacity=".75"/><stop offset="1" stop-color="#293955" stop-opacity=".8"/></linearGradient>
      <linearGradient id="cellShine" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ffffff" stop-opacity=".43"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#background)"/>
    <circle cx="100" cy="450" r="730" fill="url(#orbCyan)"/>
    <circle cx="1730" cy="${Math.min(height - 200, 1600)}" r="820" fill="url(#orbPurple)"/>
    <circle cx="400" cy="${height - 80}" r="590" fill="url(#orbCyan)"/>
    <rect x="1" y="1" width="${WIDTH - 2}" height="${height - 2}" rx="30" fill="none" stroke="#b4d8ff" stroke-opacity=".25" stroke-width="2"/>
    <g font-family="Noto Sans CJK SC,Noto Sans SC,Microsoft YaHei,sans-serif">
      ${text(MARGIN, 86, data.title, 53, '#f2f7ff', 600)}
      <rect x="${WIDTH - MARGIN - 206}" y="39" width="206" height="58" rx="14" fill="#b7dcff" fill-opacity=".07" stroke="#b9daff" stroke-opacity=".25"/>
      ${text(WIDTH - MARGIN - 103, 79, '完整额度快照', 28, '#d0e3fb', 500, 'text-anchor="middle"')}
      ${text(MARGIN, 145, `${data.accountCount} 个账号`, 30, '#b6d9f4', 500)}
      ${text(265, 145, `开启 ${data.enabledCount}`, 30, COLORS.normal, 500)}
      ${text(470, 145, `异常 ${data.issueCount}`, 30, data.issueCount ? COLORS.low : '#bdcde4', 500)}
      ${data.stale ? text(MARGIN, 192, '更新未完成，以下为上次快照', 29, COLORS.warning) : ''}
      ${bodies}${footer}
    </g>
  </svg>`;
  return { svg: Buffer.from(svg), width: WIDTH, height };
}

async function sharpPng(svg) {
  const { default: sharp } = await import('sharp');
  const render = () => sharp(svg, { limitInputPixels: MAX_IMAGE_PIXELS });
  const pngOptions = { compressionLevel: 9, adaptiveFiltering: true };
  const fullColor = await render().png(pngOptions).toBuffer();
  if (fullColor.length <= MAX_IMAGE_BYTES) return fullColor;
  // Large reports stay one image; palette reduction retains the original dimensions.
  return render().png({ ...pngOptions, palette: true, colours: 256, effort: 10, dither: .25 }).toBuffer();
}

function aborted(signal) { if (signal?.aborted) throw new Error('图片生成已取消'); }

/** Raster-only report renderer. It never reads URLs, credential fields or remote fonts. */
export class BroadcastImageRenderer {
  constructor({ renderPng = sharpPng, now = Date.now, ttlMs = 10 * 60_000, maxGroups = 4, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.renderPng = renderPng;
    this.now = now;
    this.ttlMs = Math.max(1, Math.min(10 * 60_000, Number(ttlMs) || 10 * 60_000));
    this.maxGroups = Math.max(1, Math.min(4, Math.floor(Number(maxGroups) || 4)));
    this.maxBytes = Math.max(1024, Math.min(32 * 1024 * 1024, Number(maxBytes) || 32 * 1024 * 1024));
    this.cache = new Map();
    this.pending = new Map();
    this.serial = Promise.resolve();
  }

  prune() {
    const now = this.now();
    for (const [key, group] of this.cache) if (group.expiresAt <= now) this.cache.delete(key);
    let bytes = [...this.cache.values()].reduce((total, group) => total + group.bytes, 0);
    while (this.cache.size > this.maxGroups || bytes > this.maxBytes) {
      const key = this.cache.keys().next().value;
      bytes -= this.cache.get(key).bytes; this.cache.delete(key);
    }
  }

  getImage(id) {
    if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id)) return null;
    this.prune();
    for (const group of this.cache.values()) {
      const image = group.result.images.find(item => item.id === id);
      if (image) return image;
    }
    return null;
  }

  async render(snapshot, { signal, ...options } = {}) {
    aborted(signal);
    // The cache identity is derived solely from sanitized display data.
    const data = normalize(snapshot, options);
    const key = hash(JSON.stringify(data));
    this.prune();
    if (this.cache.has(key)) return this.cache.get(key).result;
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 4) throw new Error('图片生成繁忙，请稍后重试');
      pending = this.serial.then(async () => {
        const { svg, width, height } = posterSvg(data);
        if (width * height > MAX_IMAGE_PIXELS) throw new Error('播报图片尺寸超出限制');
        let buffer;
        try { buffer = await this.renderPng(svg, { width, height }); }
        catch { throw new Error('播报图片生成失败'); }
        if (!Buffer.isBuffer(buffer) || buffer.length <= PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.length > MAX_IMAGE_BYTES) throw new Error('播报图片格式或大小不符合限制');
        const images = [{ id: hash(buffer), buffer, mimeType: 'image/png', width, height,
          alt: `${data.title} · 完整总览 · 更新 ${data.updatedAt}` }];
        const result = { images, generatedAt: new Date(this.now()).toISOString(), accountCount: data.accountCount, truncatedCount: data.truncatedCount };
        const bytes = images.reduce((total, image) => total + image.buffer.length, 0);
        if (bytes <= this.maxBytes) {
          this.cache.set(key, { result, bytes, expiresAt: this.now() + this.ttlMs });
          this.prune();
        }
        return result;
      });
      this.pending.set(key, pending);
      this.serial = pending.catch(() => {});
      pending.finally(() => this.pending.delete(key)).catch(() => {});
    }
    const result = await pending;
    aborted(signal);
    return result;
  }
}
