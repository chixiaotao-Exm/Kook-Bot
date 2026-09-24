import { buildScheduledSummary } from './report-summary.js';

export const REPORT_INTERVAL_MS = 30 * 60000;
const WINDOW_MS = 2 * 60000;
const CATEGORIES = ['infra', 'web'];
const STATES = new Set(['pending', 'sending', 'sent', 'uncertain', 'skipped']);
const iso = value => new Date(value).toISOString();
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const aligned = value => Number.isFinite(time(value)) && time(value) >= 0 && time(value) % REPORT_INTERVAL_MS === 0 && value === iso(time(value));
const slotAt = now => Math.floor(now / REPORT_INTERVAL_MS) * REPORT_INTERVAL_MS;
const initialState = now => ({ intervalMinutes: 30, nextRunAt: iso(slotAt(now) + REPORT_INTERVAL_MS), lastRunAt: null, channels: {} });
function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.intervalMinutes === 30 && aligned(value.nextRunAt)
    && (value.lastRunAt === null || aligned(value.lastRunAt) && time(value.nextRunAt) > time(value.lastRunAt))
    && value.channels && typeof value.channels === 'object' && !Array.isArray(value.channels)
    && Object.keys(value.channels).length === (value.lastRunAt === null ? 0 : 2)
    && Object.entries(value.channels).every(([category, entry]) => CATEGORIES.includes(category) && entry && typeof entry === 'object' && !Array.isArray(entry)
      && entry.slotAt === value.lastRunAt && STATES.has(entry.status));
}

/** Half-hour slots survive process restarts. Ambiguous sends are never repeated. */
export class ReportScheduler {
  constructor({ store, getSnapshot, send, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, deliveryTimeoutMs = 12000 }) {
    if (!store || typeof store.transaction !== 'function' || typeof getSnapshot !== 'function'
      || send != null && typeof send !== 'function' || !Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 15000) throw new Error('Invalid report scheduler configuration');
    Object.assign(this, { store, getSnapshot, send, now, deliveryTimeoutMs });
    this.setTimeout = setTimeoutImpl; this.clearTimeout = clearTimeoutImpl; this.running = false; this.closed = false;
    this.timer = null; this.inFlight = null; this.controller = new AbortController(); this.lastError = null;
  }
  snapshot() {
    const saved = this.store.data.reports;
    return { enabled: Boolean(this.send) && this.running && !this.closed && !this.store.failed, intervalMinutes: 30,
      nextRunAt: saved?.nextRunAt || null, lastRunAt: saved?.lastRunAt || null,
      channels: structuredClone(saved?.channels || {}),
      lastError: this.lastError || (Object.values(saved?.channels || {}).some(entry => entry.status === 'uncertain') ? '最近自动播报有消息未确认送达。' : null) };
  }
  async start() {
    if (this.running || this.closed || !this.send) return;
    this.running = true;
    try {
      await this.store.transaction(draft => {
        if (draft.reports === undefined) draft.reports = initialState(this.now());
        if (!validState(draft.reports)) throw new Error('Invalid saved report schedule');
        for (const entry of Object.values(draft.reports.channels)) if (entry.status === 'sending') entry.status = 'uncertain';
      });
      if (this.closed) return;
      await this.run(); this.arm();
    } catch { this.running = false; this.lastError = '自动播报状态无法恢复，请检查运维服务。'; }
  }
  arm() {
    this.clearTimeout(this.timer); this.timer = null;
    if (this.store.failed) { this.running = false; this.lastError = '状态存储不可用，自动播报已暂停。'; return; }
    if (!this.running || this.closed) return;
    const next = time(this.store.data.reports?.nextRunAt);
    const delay = this.lastError ? 60000 : Math.min(60000, Math.max(1, Number.isFinite(next) ? next - this.now() : 60000));
    this.timer = this.setTimeout(() => { this.timer = null; void this.run().finally(() => this.arm()); }, delay);
  }
  async run() {
    if (this.store.failed) { this.running = false; this.lastError = '状态存储不可用，自动播报已暂停。'; this.clearTimeout(this.timer); this.timer = null; return; }
    if (!this.running || this.closed || !this.send) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.cycle().catch(() => { this.lastError = '自动播报状态保存失败，已暂停本次发送。'; })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async cycle() {
    const now = this.now(), saved = this.store.data.reports;
    if (!validState(saved)) throw new Error('Invalid report state');
    if (time(saved.nextRunAt) > now && !Object.values(saved.channels).some(entry => entry.status === 'pending')) return;
    await this.store.transaction(draft => {
      if (this.closed) return;
      const report = draft.reports, current = this.now(), slot = slotAt(current);
      if (time(report.nextRunAt) <= current) {
        report.nextRunAt = iso(slot + REPORT_INTERVAL_MS);
        if (!report.lastRunAt || slot > time(report.lastRunAt)) {
          if (current - slot <= WINDOW_MS) {
            report.lastRunAt = iso(slot);
            report.channels = Object.fromEntries(CATEGORIES.map(category => [category, { slotAt: iso(slot), status: 'pending' }]));
          }
        }
      }
      for (const entry of Object.values(report.channels)) {
        if (entry.status === 'pending' && (current < time(entry.slotAt) || current - time(entry.slotAt) > WINDOW_MS)) entry.status = 'skipped';
      }
    });
    const results = await Promise.allSettled(CATEGORIES.map(category => this.deliver(category)));
    if (results.some(result => result.status === 'rejected')) this.lastError = '自动播报结果保存失败，请检查状态存储。';
    else this.lastError = null;
  }
  async deliver(category) {
    if (this.closed || this.store.data.reports.channels[category]?.status !== 'pending') return;
    const claimed = await this.store.transaction(draft => {
      const entry = draft.reports.channels[category];
      if (this.closed || entry?.status !== 'pending') return null;
      const now = this.now(), slot = time(entry.slotAt);
      if (now < slot || now - slot > WINDOW_MS) { entry.status = 'skipped'; return null; }
      entry.status = 'sending'; entry.attemptedAt = iso(now); return { slotAt: entry.slotAt };
    });
    if (!claimed) return;
    if (this.closed || this.now() < time(claimed.slotAt) || this.now() - time(claimed.slotAt) > WINDOW_MS) {
      await this.finish(category, claimed.slotAt, 'skipped'); return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    let timer, onAbort, status = 'uncertain', messageId;
    try {
      const snapshot = this.getSnapshot();
      const message = buildScheduledSummary(snapshot, category, this.now());
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('Report cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { reject(new Error('Report timeout')); controller.abort(); }, this.deliveryTimeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('Report cancelled');
        return this.send(message, { signal });
      }), interrupted]);
      if (typeof result?.messageId !== 'string' || !/^[a-f0-9-]{16,100}$/i.test(result.messageId)) throw new Error('Report delivery unknown');
      status = 'sent'; messageId = result.messageId;
    } catch { /* A possible send cannot safely be retried. The next slot is independent. */ }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); controller.abort(); }
    await this.finish(category, claimed.slotAt, status, messageId);
  }
  async finish(category, slot, status, messageId) {
    await this.store.transaction(draft => {
      const entry = draft.reports.channels[category];
      if (entry?.slotAt !== slot || entry.status !== 'sending') return;
      entry.status = status; entry.finishedAt = iso(this.now()); if (messageId) entry.messageId = messageId;
    });
  }
  async close() {
    this.closed = true; this.running = false; this.clearTimeout(this.timer); this.timer = null; this.controller.abort();
    await this.inFlight;
  }
}
