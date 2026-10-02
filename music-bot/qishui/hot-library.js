import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UserError } from '../src/util.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RETRY_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_PLAYLISTS = 6;
const ARCHIVE_MS = 14 * DAY;
const DELETE_MS = 45 * DAY;
const BLOCK_MS = 7 * DAY;
const ID = /^[1-9]\d{0,18}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const freshState = () => ({ version: 1, entries: [], lastRunAt: null, lastSuccessAt: null, lastError: '',
  schedule: { slot: null, attempts: 0, outcome: null, retryAt: null }, runs: [] });

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

function validState(value) {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
      || !Array.isArray(value.runs) || value.runs.length > 20 || typeof value.lastError !== 'string'
      || value.lastError.length > 300 || ![value.lastRunAt, value.lastSuccessAt].every((item) => item === null || timestamp(item))) return false;
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
        || !Number.isFinite(item.rankScore) || item.rankScore < 0 || item.rankScore > 100) return false;
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

/** Persistent public metadata collector. It never fetches audio or calls an LLM. */
export class HotLibrary {
  constructor({ catalog, file, now = Date.now, writeJson = atomicWrite, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!catalog || typeof file !== 'string' || !file) throw new TypeError('HotLibrary requires a catalog and state file');
    this.catalog = catalog; this.file = file; this.now = now; this.writeJson = writeJson;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.state = freshState(); this.tail = Promise.resolve(); this.initializing = null; this.inflight = null;
    this.storageError = ''; this.readOnly = false; this.closed = false; this.started = false; this.timer = null;
  }

  init() {
    this.initializing ??= (async () => {
      try {
        const info = await stat(this.file);
        if (!info.isFile() || info.size > 24 * 1024 * 1024) throw new Error('invalid file');
        const value = JSON.parse(await readFile(this.file, 'utf8'));
        if (!validState(value)) throw new Error('invalid state');
        // Drop any unrecognized fields on load, as on collection.
        value.entries = value.entries.map((entry) => ({ ...validTrack(entry), firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt, archived: entry.archived, sourceCount: entry.sourceCount,
          sources: entry.sources.map(({ id, name }) => ({ id, name })), history: entry.history.map(({ at, score }) => ({ at, score })),
          rankScore: entry.rankScore, playback: { failures: entry.playback.failures,
            lastUnavailableAt: entry.playback.lastUnavailableAt, blockedUntil: entry.playback.blockedUntil } }));
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
    const result = await this.collect();
    this.arm();
    return result;
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
    return { mode: 'hot', name: '抖音热歌库', tracks: ordered(this.state.entries.filter((entry) => entryStatus(entry, now) === 'active'), now)
      .slice(0, limit).map((entry) => validTrack(entry)) };
  }

  snapshot({ offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new UserError('热歌库分页参数无效。');
    const now = this.now(), entries = ordered(this.state.entries, now);
    const counts = { total: entries.length, active: 0, archived: 0, blocked: 0 };
    for (const entry of entries) counts[entryStatus(entry, now)]++;
    const activeEntries = entries.filter((entry) => entryStatus(entry, now) === 'active');
    const next = this.nextAt(now);
    return { enabled: true, collecting: Boolean(this.inflight), lastRunAt: this.state.lastRunAt,
      lastSuccessAt: this.state.lastSuccessAt, lastError: this.storageError || this.state.lastError,
      nextRunAt: next, timezone: 'Asia/Shanghai', times: ['09:00', '21:00'],
      counts, policy: { archiveDays: 14, deleteDays: 45 },
      tracks: activeEntries.slice(offset, offset + limit).map((entry) => ({ ...validTrack(entry), score: score(entry, now),
        scoreDelta: entry.history.length > 1 ? entry.history[0].score - entry.history[1].score : 0,
        firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt, sourceCount: entry.sourceCount,
        sources: structuredClone(entry.sources), status: 'active' })),
      total: activeEntries.length, offset, limit, hasMore: offset + limit < activeEntries.length, runs: structuredClone(this.state.runs) };
  }

  async close() {
    this.closed = true; this.started = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    await this.inflight;
    await this.tail;
  }
}
