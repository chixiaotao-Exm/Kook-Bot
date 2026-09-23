import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.js';

export class Dashboard {
  constructor({ client, dataDir, providers = [], hiddenPlatforms = [], now = Date.now, refreshMs = 600000 }) {
    Object.assign(this, { client, providers, now, refreshMs });
    this.hiddenPlatforms = new Set(hiddenPlatforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean));
    this.file = path.join(dataDir, 'snapshot.json'); this.data = { accounts: [], updatedAt: null };
    this.lastError = ''; this.storageError = ''; this.pending = null; this.lastAttempt = null; this.closed = false;
  }
  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > 10000 || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt)) ||
          !saved.accounts.every((account) => account && typeof account.id === 'string' && typeof account.name === 'string' && Array.isArray(account.metrics) && account.metrics.every((metric) => metric && typeof metric === 'object'))) throw new Error('Invalid snapshot');
      this.data = { accounts: saved.accounts, updatedAt: saved.updatedAt };
      for (const provider of this.providers) provider.seed?.(saved.accounts);
    } catch (error) { if (error.code !== 'ENOENT') this.storageError = '上次额度快照无法读取；等待本次安全读取后更新。'; }
    return this;
  }
  snapshot() {
    const stale = Boolean(this.lastError || !this.data.updatedAt || this.now() - Date.parse(this.data.updatedAt) > this.refreshMs * 3);
    const accounts = this.data.accounts.filter((account) => !this.hiddenPlatforms.has(String(account.platform || '').toLowerCase())).map((account) => {
      const metrics = account.metrics.map((metric) => ({ ...metric, freshness: stale || metric.resetAt && Date.parse(metric.resetAt) <= this.now() || metric.validUntil && Date.parse(metric.validUntil) <= this.now() || metric.observedAt && this.now() - Date.parse(metric.observedAt) > (metric.source === 'sub2api-active-quota' ? 35 * 60000 : 900000) ? 'stale' : metric.freshness }));
      const freshness = stale || metrics.some((metric) => metric.freshness === 'stale') ? 'stale' : account.freshness;
      const windowStats = (account.windowStats || []).map((window) => {
        const aged = stale || window.observedAt && this.now() - Date.parse(window.observedAt) > 900000;
        const windowFreshness = aged ? 'stale' : window.observedAt ? 'fresh' : 'unknown';
        const metric = metrics.find((item) => item.key === window.metricKey);
        const estimateValid = windowFreshness === 'fresh' && window.complete && metric?.freshness === 'fresh';
        return { ...window, freshness: windowFreshness, ...(estimateValid ? {} : { estimatedTotalCost: null, estimateObservedAt: null, estimateNote: '缺少有效的同期额度观测，暂无可靠估算。' }) };
      });
      let resetCredits = account.resetCredits ? { ...account.resetCredits } : null;
      if (resetCredits) {
        const expiries = Array.isArray(resetCredits.expiresAt) ? resetCredits.expiresAt : [];
        const valid = expiries.filter((value) => Date.parse(value) > this.now());
        const expired = resetCredits.cachedCount > 0 && expiries.length > 0 && valid.length === 0;
        if (expired) resetCredits.availableCount = null;
        else if (Number.isFinite(resetCredits.availableCount) && resetCredits.availableCount > 0 && expiries.length > 0) resetCredits.availableCount = Math.min(resetCredits.availableCount, valid.length);
        if (stale || expired || resetCredits.checkedAt && this.now() - Date.parse(resetCredits.checkedAt) > (resetCredits.source === 'sub2api-active-quota' ? 35 * 60000 : 900000)) resetCredits.freshness = 'stale';
      }
      return { ...account, metrics, freshness, windowStats, resetCredits };
    });
    const known = (account) => account.metrics.some((metric) => metric.scope !== 'local' &&
      ['value', 'used', 'remaining', 'limit', 'usedPercent', 'remainingPercent'].some((field) => typeof metric[field] === 'number' && Number.isFinite(metric[field])));
    return { accounts, updatedAt: this.data.updatedAt, refreshIntervalMs: this.refreshMs, refreshing: Boolean(this.pending), lastError: this.lastError, storageError: this.storageError, stale,
      summary: { total: accounts.length, available: accounts.filter(known).length, unknown: accounts.filter((a) => !known(a)).length,
        stale: accounts.filter((a) => a.freshness === 'stale').length, errors: accounts.filter((a) => a.error || ['error', 'inactive', 'disabled'].includes(a.status)).length },
      notice: '读取 sub2api 已保存的额度快照；看板刷新时间不等于上游额度观测时间。' };
  }
  async refresh({ force = false } = {}) {
    if (this.closed) return this.snapshot();
    if (this.pending) return this.pending;
    if (this.lastAttempt !== null && this.now() - this.lastAttempt < (force ? 15000 : this.refreshMs)) return this.snapshot();
    this.lastAttempt = this.now();
    const task = (async () => {
      try {
        const result = await this.client.refresh();
        for (const provider of this.providers) result.accounts = await provider.enrich(result.accounts);
        if (this.closed) return;
        this.data = { accounts: result.accounts, updatedAt: result.checkedAt }; this.lastError = '';
        try { await atomicJson(this.file, { version: 1, ...this.data }); this.storageError = ''; }
        catch { this.storageError = '当前额度已读取，但本地快照保存失败。'; }
      } catch (error) {
        if (!this.closed) this.lastError = error.code === 'UNAUTHORIZED' || error.code === 'AUTH' ? 'sub2api 管理员 API Key 无效，请更新服务端配置。' : '本次读取 sub2api 失败，暂时保留上次快照。';
      }
    })();
    this.pending = task;
    try { await task; } finally { if (this.pending === task) this.pending = null; }
    return this.snapshot();
  }
  async refreshAfterQuotaQuery() {
    if (this.pending) await this.pending;
    if (this.closed) return this.snapshot();
    this.lastAttempt = null;
    await this.refresh({ force: true });
    return this.snapshot();
  }
  start() { if (this.timer || this.closed) return; this.timer = setInterval(() => void this.refresh(), this.refreshMs); this.timer.unref?.(); }
  close() { this.closed = true; clearInterval(this.timer); }
}
