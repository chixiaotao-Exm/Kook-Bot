import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { UserError } from '../src/util.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RETRY_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_PLAYLISTS = 6;
const ARCHIVE_MS = 14 * DAY;
const DELETE_MS = 45 * DAY;
const BLOCK_MS = 7 * DAY;
const AI_TTL = 7 * DAY;
const AI_BATCH = 40;
const AI_MAX_REVIEW = 240;
const DECISIONS = new Set(['prefer', 'keep', 'downrank', 'exclude']);
const VERSIONS = new Set(['original', 'cover', 'dj', 'live', 'instrumental', 'unknown']);
const TRENDS = new Set(['rising', 'steady', 'revival', 'unknown']);
const ID = /^[1-9]\d{0,18}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const freshAI = () => ({ model: '', status: 'disabled', lastRunAt: null, lastSuccessAt: null, lastError: '', attempts: [] });
const freshState = () => ({ version: 1, entries: [], lastRunAt: null, lastSuccessAt: null, lastError: '',
  schedule: { slot: null, attempts: 0, outcome: null, retryAt: null }, runs: [], ai: freshAI() });

// Shanghai is UTC+8 year round. Arithmetic makes the scheduler independent of
// the Linux host timezone and avoids locale-dependent date string parsing.
function slots(now) {
  const localDay = Math.floor((now + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
  const morning = localDay + 9 * HOUR, evening = localDay + 21 * HOUR;
  if (now < morning) return { latest: morning - 12 * HOUR, next: morning };
  if (now < evening) return { latest: morning, next: evening };
  return { latest: evening, next: morning + DAY };
}

function validTrack(raw) {
  if (!plain(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string'
      || !raw.name.trim() || !Number.isSafeInteger(raw.durationMs) || raw.durationMs < 0 || raw.durationMs > DAY) return null;
  const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  // Only copy normalized public metadata, never opaque upstream fields or URLs
  // that might contain playable media, credentials, or provider diagnostics.
  let cover = '';
  try {
    const url = new URL(raw.cover);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
        && /(?:^|\.)(?:douyinpic\.com|byteimg\.com|pstatp\.com)$/.test(url.hostname) && url.href.length <= 2000) cover = url.href;
  } catch { /* Covers are optional. */ }
  return { id: raw.id, name: clean(raw.name, 160), artists: clean(raw.artists, 160) || '未知歌手',
    durationMs: raw.durationMs, album: clean(raw.album, 160), cover, source: 'qishui' };
}

function normalizeDecision(raw) {
  if (!plain(raw) || !DECISIONS.has(raw.decision) || !VERSIONS.has(raw.version) || !TRENDS.has(raw.trend)
      || typeof raw.reason !== 'string' || raw.reason.length > 100 || !Number.isFinite(raw.confidence)
      || raw.confidence < 0 || raw.confidence > 1) return null;
  const decision = raw.confidence < 0.65 ? 'keep' : raw.decision === 'exclude' && raw.confidence < 0.9 ? 'downrank' : raw.decision;
  return { decision, version: raw.version, trend: raw.trend, reason: raw.reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim(), confidence: raw.confidence };
}
function validEntryAI(ai) {
  return ai == null || (normalizeDecision(ai) !== null && timestamp(ai.reviewedAt) && typeof ai.model === 'string'
    && ai.model.length > 0 && ai.model.length <= 100 && typeof ai.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(ai.fingerprint));
}
function validAIState(ai) {
  return ai === undefined || (plain(ai) && typeof ai.model === 'string' && ai.model.length <= 100
    && ['disabled', 'pending', 'running', 'ready', 'partial', 'fallback'].includes(ai.status)
    && [ai.lastRunAt, ai.lastSuccessAt].every((at) => at === null || timestamp(at))
    && typeof ai.lastError === 'string' && ai.lastError.length <= 300 && Array.isArray(ai.attempts) && ai.attempts.length <= 32
    && ai.attempts.every((attempt) => plain(attempt) && timestamp(attempt.slot) && typeof attempt.model === 'string' && attempt.model.length <= 100));
}
function fingerprint(entry) {
  return createHash('sha256').update(JSON.stringify({ id: entry.id, name: entry.name, artists: entry.artists,
    album: entry.album, durationMs: entry.durationMs,
    sources: entry.sources.map(({ id, name }) => ({ id, name })).sort((left, right) => left.id.localeCompare(right.id)) })).digest('hex');
}
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('ai_cancelled'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('ai_cancelled');
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function validState(value) {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
      || !Array.isArray(value.runs) || value.runs.length > 20 || typeof value.lastError !== 'string'
      || value.lastError.length > 300 || ![value.lastRunAt, value.lastSuccessAt].every((item) => item === null || timestamp(item))
      || !validAIState(value.ai)) return false;
  const schedule = value.schedule;
  if (!plain(schedule) || !(schedule.slot === null || timestamp(schedule.slot))
      || !Number.isInteger(schedule.attempts) || schedule.attempts < 0 || schedule.attempts > 2
      || ![null, 'running', 'success', 'partial', 'failed'].includes(schedule.outcome)
      || !(schedule.retryAt === null || timestamp(schedule.retryAt))) return false;
  const seen = new Set();
  for (const item of value.entries) {
    if (!validTrack(item) || seen.has(item.id) || !timestamp(item.firstSeenAt) || !timestamp(item.lastSeenAt)
        || item.firstSeenAt > item.lastSeenAt || typeof item.archived !== 'boolean'
        || !Number.isInteger(item.sourceCount) || item.sourceCount < 1 || item.sourceCount > MAX_PLAYLISTS
        || !Number.isFinite(item.rankScore) || item.rankScore < 0 || item.rankScore > 100 || !validEntryAI(item.ai)) return false;
    if (!Array.isArray(item.sources) || item.sources.length !== item.sourceCount
        || new Set(item.sources.map((source) => source?.id)).size !== item.sourceCount
        || !item.sources.every((source) => plain(source) && typeof source.id === 'string' && ID.test(source.id)
          && typeof source.name === 'string' && source.name.length <= 160)
        || !Array.isArray(item.history) || item.history.length < 1 || item.history.length > 14
        || new Set(item.history.map((point) => point?.at)).size !== item.history.length
        || !item.history.every((point) => plain(point) && timestamp(point.at) && Number.isFinite(point.score) && point.score >= 0 && point.score <= 1000)) return false;
    const playback = item.playback;
    if (!plain(playback) || !Number.isInteger(playback.failures) || playback.failures < 0 || playback.failures > 2
        || ![playback.lastUnavailableAt, playback.blockedUntil].every((entry) => entry === null || timestamp(entry))) return false;
    seen.add(item.id);
  }
  return value.runs.every((run) => plain(run) && timestamp(run.startedAt) && timestamp(run.finishedAt)
    && ['success', 'partial', 'failed'].includes(run.status)
    && ['discoveredPlaylists', 'successfulPlaylists', 'failedPlaylists', 'seen', 'added', 'archived', 'deleted'].every((key) => Number.isSafeInteger(run[key]) && run[key] >= 0)
    && typeof run.error === 'string' && run.error.length <= 300);
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function entryStatus(entry, now) {
  if (entry.playback.blockedUntil && entry.playback.blockedUntil > now) return 'blocked';
  return entry.archived ? 'archived' : 'active';
}
function score(entry, now) {
  const recent = Math.max(0, 1 - Math.max(0, now - entry.lastSeenAt) / ARCHIVE_MS) * 50;
  return Math.round(entry.sourceCount * 100 + entry.rankScore + recent);
}
function ordered(entries, now) {
  return [...entries].sort((left, right) => score(right, now) - score(left, now)
    || right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));
}

/** Persistent metadata collector with optional bounded AI review. Never fetches audio. */
export class HotLibrary {
  constructor({ catalog, file, selector = null, now = Date.now, writeJson = atomicWrite, setTimer = setTimeout, clearTimer = clearTimeout,
    aiTimeoutMs = 180000, aiRequestTimeoutMs = 90000 } = {}) {
    if (!catalog || typeof file !== 'string' || !file) throw new TypeError('HotLibrary requires a catalog and state file');
    this.catalog = catalog; this.file = file; this.now = now; this.writeJson = writeJson;
    this.selector = selector;
    this.aiTimeoutMs = Math.max(1, Math.min(180000, Number(aiTimeoutMs) || 180000));
    this.aiRequestTimeoutMs = Math.max(1, Math.min(90000, Number(aiRequestTimeoutMs) || 90000));
    this.aiInflight = null; this.aiController = null;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.state = freshState(); this.tail = Promise.resolve(); this.initializing = null; this.inflight = null;
    this.storageError = ''; this.readOnly = false; this.closed = false; this.started = false; this.timer = null;
  }

  init() {
    this.initializing ??= (async () => {
      try {
        const info = await stat(this.file);
        // 5000 valid entries can exceed 24 MiB with six Chinese source names
        // and long CDN covers. Keep room for the bounded public metadata schema.
        if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('invalid file');
        const value = JSON.parse(await readFile(this.file, 'utf8'));
        if (!validState(value)) throw new Error('invalid state');
        // Drop any unrecognized fields on load, as on collection.
        value.entries = value.entries.map((entry) => ({ ...validTrack(entry), firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt, archived: entry.archived, sourceCount: entry.sourceCount,
          sources: entry.sources.map(({ id, name }) => ({ id, name })), history: entry.history.map(({ at, score }) => ({ at, score })),
          ai: entry.ai ? { ...normalizeDecision(entry.ai), reviewedAt: entry.ai.reviewedAt, model: entry.ai.model, fingerprint: entry.ai.fingerprint } : null,
          rankScore: entry.rankScore, playback: { failures: entry.playback.failures,
            lastUnavailableAt: entry.playback.lastUnavailableAt, blockedUntil: entry.playback.blockedUntil } }));
        value.ai = value.ai ? { model: value.ai.model, status: value.ai.status, lastRunAt: value.ai.lastRunAt,
          lastSuccessAt: value.ai.lastSuccessAt, lastError: value.ai.lastError,
          attempts: value.ai.attempts.map(({ slot, model }) => ({ slot, model })) } : freshAI();
        if (value.ai.status === 'running') {
          value.ai.status = 'fallback';
          value.ai.lastError = '上次智能筛选已中断，本时间段不重复请求，未审阅歌曲继续使用规则排序。';
        }
        this.state = value;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.readOnly = true;
          this.storageError = '热歌库文件无法读取或已损坏，已保留原文件，请检查后恢复。';
        }
      }
      return this;
    })();
    return this.initializing;
  }

  async mutate(update) {
    const pending = this.tail.then(async () => {
      if (this.readOnly) return false;
      const draft = structuredClone(this.state);
      if (update(draft) === false) return false;
      try {
        await this.writeJson(this.file, draft);
        this.state = draft;
        this.storageError = '';
        return true;
      } catch {
        this.readOnly = true;
        this.storageError = '热歌库保存失败，已暂停收集并保留上次数据，请检查存储空间及权限。';
        return false;
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  nextAt(now = this.now()) {
    if (this.closed || this.readOnly) return null;
    const times = slots(now), schedule = this.state.schedule;
    if (schedule.slot === null || schedule.slot < times.latest) return now;
    // A future stored slot (clock moved backwards) must not be replayed.
    if (schedule.slot > times.latest) return Math.max(times.next, schedule.slot + 12 * HOUR);
    if (schedule.outcome !== 'success' && schedule.attempts < 2 && schedule.retryAt !== null) return Math.min(times.next, Math.max(now, schedule.retryAt));
    return times.next;
  }

  arm() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.started || this.closed || this.readOnly || this.inflight) return;
    const at = this.nextAt();
    if (at === null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.collect().catch(() => {}).finally(() => this.arm());
    }, Math.max(1, Math.min(DAY, at - this.now())));
    this.timer?.unref?.();
  }

  async start() {
    await this.init();
    if (this.closed) return this.snapshot();
    this.started = true;
    await this.collect();
    await this.reviewAI();
    this.arm();
    return this.snapshot();
  }

  collect({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      await this.init();
      if (this.closed || this.readOnly) return;
      const started = this.now(), slot = slots(started).latest;
      if (!force && this.nextAt(started) > started) return;
      const claimed = await this.mutate((draft) => {
        const previous = draft.schedule;
        draft.lastRunAt = started;
        draft.schedule = { slot: previous.slot !== null && previous.slot > slot ? previous.slot : slot,
          attempts: previous.slot === slot ? Math.min(2, previous.attempts + 1) : 1,
          outcome: 'running', retryAt: started + RETRY_MS };
      });
      if (!claimed) return;
      let result;
      try { result = await this.gather(); }
      catch { result = { seen: new Map(), discovered: 0, successful: 0, failed: 0, complete: false }; }
      const finished = this.now();
      await this.mutate((draft) => {
        const previous = new Map(draft.entries.map((entry) => [entry.id, entry]));
        const run = { startedAt: started, finishedAt: finished, status: result.complete ? 'success' : result.seen.size ? 'partial' : 'failed',
          discoveredPlaylists: result.discovered, successfulPlaylists: result.successful, failedPlaylists: result.failed,
          seen: result.seen.size, added: 0, archived: 0, deleted: 0, error: '' };
        for (const [id, item] of result.seen) {
          const existing = previous.get(id);
          const currentSources = [...item.sources.entries()].map(([id, source]) => ({ id, name: source.name }));
          const sourceMap = new Map(currentSources.map((source) => [source.id, source]));
          if (!result.complete) for (const source of existing?.sources ?? []) if (!sourceMap.has(source.id)) sourceMap.set(source.id, source);
          const sourceLimit = result.complete ? MAX_PLAYLISTS : Math.max(existing?.sourceCount ?? 0, currentSources.length);
          const sources = [...sourceMap.values()].slice(0, sourceLimit);
          const rankScore = [...item.sources.values()].reduce((sum, source) => sum + source.rank, 0) / item.sources.size;
          const updated = { ...item.track, firstSeenAt: existing?.firstSeenAt ?? finished, lastSeenAt: finished, archived: false,
            sourceCount: sources.length, sources,
            rankScore: result.complete ? rankScore : Math.max(existing?.rankScore ?? 0, rankScore),
            ai: existing?.ai ?? null,
            playback: existing?.playback ?? { failures: 0, lastUnavailableAt: null, blockedUntil: null } };
          updated.history = [...(existing?.history ?? []).filter((point) => point.at !== slot), { at: slot, score: score(updated, finished) }]
            .sort((left, right) => right.at - left.at).slice(0, 14);
          previous.set(id, updated);
          if (!existing) run.added++;
        }
        if (result.complete) {
          for (const [id, entry] of previous) {
            const age = finished - entry.lastSeenAt;
            if (age >= DELETE_MS) { previous.delete(id); run.deleted++; }
            else if (age >= ARCHIVE_MS && !entry.archived) { entry.archived = true; run.archived++; }
          }
          draft.lastSuccessAt = finished;
        }
        // At the cap, partial results can fill free slots but cannot evict existing
        // library entries based on incomplete upstream information.
        if (!result.complete && previous.size > MAX_ENTRIES) {
          const original = new Set(draft.entries.map((entry) => entry.id));
          for (const entry of ordered([...previous.values()], finished).reverse()) {
            if (previous.size <= MAX_ENTRIES) break;
            if (!original.has(entry.id)) { previous.delete(entry.id); run.added--; }
          }
        }
        draft.entries = ordered([...previous.values()], finished).slice(0, MAX_ENTRIES);
        if (!result.complete) run.error = result.seen.size ? '部分歌单未完整读取，已更新可用曲目并保留旧库。' : '本次未获取到有效热歌，已保留上次曲库。';
        draft.lastError = run.error;
        draft.schedule.outcome = run.status;
        draft.schedule.retryAt = !result.complete && draft.schedule.attempts < 2 ? finished + RETRY_MS : null;
        draft.runs.unshift(run); draft.runs = draft.runs.slice(0, 20);
      });
      await this.reviewAI();
    })().catch(() => {
      // Unexpected provider or timer failures must not crash the audio service.
      this.storageError = '热歌收集暂时失败，已保留上次曲库。';
    }).finally(() => {
      this.inflight = null;
      this.arm();
    }).then(() => this.snapshot());
    return this.inflight;
  }

  async gather() {
    const discovery = await Promise.allSettled(['hot', 'charts'].map((category) => this.catalog.discover(category)));
    const lists = discovery.map((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
    let complete = discovery.every((result, index) => result.status === 'fulfilled' && lists[index].length > 0);
    const choices = [], ids = new Set();
    // Merge by rank across both searches, preserving their diversity.
    for (let rank = 0; rank < 20 && choices.length < MAX_PLAYLISTS; rank++) {
      for (const list of lists) {
        const choice = list[rank];
        if (!choice || typeof choice.id !== 'string' || !ID.test(choice.id) || ids.has(choice.id)) continue;
        ids.add(choice.id); choices.push(choice);
        if (choices.length === MAX_PLAYLISTS) break;
      }
    }
    const seen = new Map(); let cursor = 0, successful = 0, failed = 0;
    const worker = async () => {
      while (!this.closed && cursor < choices.length) {
        const index = cursor++, choice = choices[index];
        try {
          const data = await this.catalog.playlistSnapshot(choice.id);
          if (!plain(data) || !Array.isArray(data.tracks) || data.playlist?.id !== choice.id) throw new Error('invalid playlist');
          let usable = 0;
          const perPlaylist = new Set();
          for (const [position, raw] of data.tracks.slice(0, 500).entries()) {
            const track = validTrack(raw);
            if (!track || perPlaylist.has(track.id)) continue;
            usable++; perPlaylist.add(track.id);
            const entry = seen.get(track.id) ?? { track, sources: new Map() };
            entry.sources.set(choice.id, { rank: 50 / (index + 1) + 50 / (1 + position / 20),
              name: typeof choice.name === 'string' ? choice.name.slice(0, 160) : String(data.playlist.name || '').slice(0, 160) });
            seen.set(track.id, entry);
          }
          if (!usable) throw new Error('empty playlist');
          successful++;
          if (data.partial !== false && data.tracks.length < 500) complete = false;
        } catch { failed++; complete = false; }
      }
    };
    await Promise.all([worker(), worker()]);
    if (this.closed || !choices.length || !seen.size || successful !== choices.length) complete = false;
    return { seen, discovered: choices.length, successful, failed, complete };
  }

  aiSettings() {
    const model = typeof this.selector?.model === 'string' ? this.selector.model.slice(0, 100) : '';
    return { enabled: this.selector?.enabled === true && Boolean(model) && typeof this.selector?.classify === 'function', model };
  }

  effectiveAI(entry, now = this.now()) {
    const settings = this.aiSettings(), ai = entry.ai;
    if (!settings.enabled || !ai || ai.model !== settings.model || ai.reviewedAt > now
        || now - ai.reviewedAt >= AI_TTL || ai.fingerprint !== fingerprint(entry)) return null;
    return ai;
  }

  aiOrder(entries, now) {
    return entries.map((entry) => {
      const ai = this.effectiveAI(entry, now);
      return { entry, ai, score: score(entry, now) + (ai?.decision === 'prefer' ? 60 : ai?.decision === 'downrank' ? -120 : 0) };
    }).sort((left, right) => right.score - left.score || right.entry.lastSeenAt - left.entry.lastSeenAt || left.entry.id.localeCompare(right.entry.id));
  }

  aiSnapshot(active, now = this.now()) {
    const settings = this.aiSettings(), saved = this.state.ai;
    const reviewed = active.filter(({ ai }) => ai !== null).length;
    const ruleOnly = active.length - reviewed;
    const currentAttempt = saved.attempts.some((attempt) => attempt.slot === slots(now).latest && attempt.model === settings.model);
    let status = 'disabled';
    if (settings.enabled) {
      if (this.aiInflight) status = 'running';
      else if (this.readOnly) status = 'fallback';
      else if (!ruleOnly && (active.length || saved.lastRunAt !== null)) status = 'ready';
      else if (currentAttempt && saved.model === settings.model && ['partial', 'fallback'].includes(saved.status)) status = saved.status;
      else status = reviewed ? 'partial' : 'pending';
    }
    return { enabled: settings.enabled, model: settings.model || saved.model, status,
      lastRunAt: saved.model === settings.model ? saved.lastRunAt : null,
      lastSuccessAt: saved.model === settings.model ? saved.lastSuccessAt : null,
      lastError: this.selector?.configError ? '智能筛选配置无效，已停用模型并继续规则推荐。' : this.readOnly ? this.storageError : saved.model === settings.model ? saved.lastError : '',
      reviewed, ruleOnly, excluded: active.filter(({ ai }) => ai?.decision === 'exclude').length,
      preferred: active.filter(({ ai }) => ai?.decision === 'prefer').length,
      downranked: active.filter(({ ai }) => ai?.decision === 'downrank').length,
      maxPerRun: AI_MAX_REVIEW, reviewDays: 7 };
  }

  reviewAI({ force = false } = {}) {
    // force permits an immediate review, never a second paid review in the same
    // persisted slot/model. There is deliberately no automatic AI retry loop.
    void force;
    if (this.aiInflight) return this.aiInflight;
    this.aiInflight = (async () => {
      await this.init();
      const settings = this.aiSettings();
      if (this.closed || this.readOnly || !settings.enabled) return;
      const started = this.now(), slot = slots(started).latest;
      if (this.state.ai.attempts.some((attempt) => attempt.slot === slot && attempt.model === settings.model)) return;
      const candidates = ordered(this.state.entries.filter((entry) => entryStatus(entry, started) === 'active'
        && !this.effectiveAI(entry, started)), started).slice(0, AI_MAX_REVIEW);
      if (!candidates.length) return;
      const claimed = await this.mutate((draft) => {
        if (this.closed || draft.ai.attempts.some((attempt) => attempt.slot === slot && attempt.model === settings.model)) return false;
        const previous = draft.ai;
        draft.ai = { model: settings.model, status: 'running', lastRunAt: started,
          lastSuccessAt: previous.model === settings.model ? previous.lastSuccessAt : null, lastError: '',
          attempts: [...previous.attempts, { slot, model: settings.model }].slice(-32) };
      });
      if (!claimed) return;
      const controller = new AbortController(); this.aiController = controller;
      if (this.closed) controller.abort();
      const timer = setTimeout(() => controller.abort(), this.aiTimeoutMs);
      const batches = [];
      for (let index = 0; index < candidates.length; index += AI_BATCH) batches.push(candidates.slice(index, index + AI_BATCH));
      let cursor = 0, applied = 0, failed = 0;
      const worker = async () => {
        while (!controller.signal.aborted && !this.closed && cursor < batches.length) {
          const entries = batches[cursor++];
          const requests = new Map(entries.map((entry) => [entry.id, fingerprint(entry)]));
          const inputs = entries.map((entry) => ({ ...validTrack(entry), sourceCount: entry.sourceCount,
            sources: structuredClone(entry.sources), score: score(entry, started),
            firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt,
            scoreDelta: entry.history.length > 1 ? entry.history[0].score - entry.history[1].score : 0,
            history: structuredClone(entry.history) }));
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.aiRequestTimeoutMs)]);
          try {
            const response = await abortable(() => this.selector.classify(inputs, { signal }), signal);
            if (controller.signal.aborted || this.closed || !Array.isArray(response)) { failed++; continue; }
            const counts = new Map();
            for (const item of response) if (typeof item?.id === 'string') counts.set(item.id, (counts.get(item.id) || 0) + 1);
            const decisions = new Map();
            for (const item of response) {
              if (typeof item?.id !== 'string' || !requests.has(item.id) || counts.get(item.id) !== 1) continue;
              const result = normalizeDecision(item);
              if (result) decisions.set(item.id, result);
            }
            if (decisions.size < entries.length) failed++;
            if (!decisions.size) continue;
            const reviewedAt = this.now(); let batchApplied = 0;
            const saved = await this.mutate((draft) => {
              if (controller.signal.aborted || this.closed || !this.aiSettings().enabled || this.aiSettings().model !== settings.model) return false;
              for (const entry of draft.entries) {
                const decision = decisions.get(entry.id);
                if (!decision || entryStatus(entry, reviewedAt) !== 'active' || fingerprint(entry) !== requests.get(entry.id)) continue;
                entry.ai = { ...decision, reviewedAt, model: settings.model, fingerprint: requests.get(entry.id) };
                batchApplied++;
              }
              if (batchApplied) draft.ai.lastSuccessAt = reviewedAt;
            });
            if (saved) applied += batchApplied;
          } catch { failed++; }
        }
      };
      try { await Promise.all([worker(), worker()]); }
      finally { clearTimeout(timer); if (this.aiController === controller) this.aiController = null; }
      await this.mutate((draft) => {
        const remaining = draft.entries.some((entry) => entryStatus(entry, this.now()) === 'active' && !this.effectiveAI(entry));
        draft.ai.status = !applied && (failed || controller.signal.aborted) ? 'fallback' : remaining ? 'partial' : 'ready';
        draft.ai.lastError = this.closed ? '智能筛选已取消，未审阅歌曲继续使用规则排序。'
          : controller.signal.aborted ? '智能筛选达到时间上限，未审阅歌曲继续使用规则排序。'
          : failed ? '部分智能筛选请求失败，未审阅歌曲继续使用规则排序。' : '';
      });
    })().catch(async () => {
      // Provider errors are never propagated to playback or stored verbatim.
      await this.mutate((draft) => {
        draft.ai.status = 'fallback';
        draft.ai.lastError = '智能筛选暂不可用，继续使用规则排序。';
      });
    }).finally(() => { this.aiInflight = null; }).then(() => this.snapshot().ai);
    return this.aiInflight;
  }

  async recordPlayback(id, outcome) {
    if (typeof id !== 'string' || !ID.test(id) || !['success', 'unavailable'].includes(outcome)) return false;
    await this.init();
    if (this.closed || this.readOnly) return false;
    const now = this.now();
    return this.mutate((draft) => {
      const entry = draft.entries.find((track) => track.id === id);
      if (!entry) return false;
      const playback = entry.playback;
      if (outcome === 'success') {
        if (!playback.failures && !playback.blockedUntil) return false;
        entry.playback = { failures: 0, lastUnavailableAt: null, blockedUntil: null };
        return;
      }
      if (playback.blockedUntil) {
        if (playback.blockedUntil > now) return false;
        playback.failures = 0; playback.lastUnavailableAt = null; playback.blockedUntil = null;
      }
      if (playback.lastUnavailableAt && now - playback.lastUnavailableAt < HOUR) return false;
      playback.failures = Math.min(2, playback.failures + 1);
      playback.lastUnavailableAt = now;
      if (playback.failures >= 2) playback.blockedUntil = now + BLOCK_MS;
    });
  }

  hot(limit = 30) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new UserError('热歌库请求数量无效。');
    const now = this.now();
    return { mode: 'hot', name: '抖音热歌库', tracks: this.aiOrder(this.state.entries.filter((entry) => entryStatus(entry, now) === 'active'), now)
      .filter(({ ai }) => ai?.decision !== 'exclude').slice(0, limit).map(({ entry }) => validTrack(entry)) };
  }

  snapshot({ offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new UserError('热歌库分页参数无效。');
    const now = this.now(), entries = ordered(this.state.entries, now);
    const counts = { total: entries.length, active: 0, archived: 0, blocked: 0 };
    for (const entry of entries) counts[entryStatus(entry, now)]++;
    const activeEntries = this.aiOrder(entries.filter((entry) => entryStatus(entry, now) === 'active'), now);
    const next = this.nextAt(now);
    return { enabled: true, collecting: Boolean(this.inflight), lastRunAt: this.state.lastRunAt,
      lastSuccessAt: this.state.lastSuccessAt, lastError: this.storageError || this.state.lastError,
      nextRunAt: next, timezone: 'Asia/Shanghai', times: ['09:00', '21:00'],
      counts, policy: { archiveDays: 14, deleteDays: 45 }, ai: this.aiSnapshot(activeEntries, now),
      tracks: activeEntries.slice(offset, offset + limit).map(({ entry, ai, score: adjustedScore }) => ({ ...validTrack(entry), score: adjustedScore, ruleScore: score(entry, now),
        scoreDelta: entry.history.length > 1 ? entry.history[0].score - entry.history[1].score : 0,
        firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt, sourceCount: entry.sourceCount,
        sources: structuredClone(entry.sources), status: 'active', ai: ai ? { ...normalizeDecision(ai), reviewedAt: ai.reviewedAt, model: ai.model } : null })),
      total: activeEntries.length, offset, limit, hasMore: offset + limit < activeEntries.length, runs: structuredClone(this.state.runs) };
  }

  async close() {
    this.closed = true; this.started = false;
    this.aiController?.abort();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    await Promise.allSettled([this.inflight, this.aiInflight]);
    await this.tail;
  }
}
