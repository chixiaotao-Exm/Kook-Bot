import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HotLibrary } from '../qishui/hot-library.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const base = Date.parse('2026-10-02T02:00:00Z'); // 10:00 Beijing, latest slot 09:00.
const track = (id) => ({ id: String(id), name: `歌曲${id}`, artists: '歌手', durationMs: 200000,
  album: '专辑', cover: '', source: 'qishui' });
const playlist = (id, tracks, options = {}) => ({ playlist: { id: String(id), name: '抖音热歌' }, tracks,
  reportedTotal: tracks.length, partial: false, ...options });
function catalogFixture({ lists = { hot: ['10', '20'], charts: ['20', '30'] }, rows = { 10: [track(1), track(2)], 20: [track(2), track(3)], 30: [track(2), track(4)] } } = {}) {
  const calls = [];
  return { calls, lists, rows,
    async discover(category) { calls.push(`discover:${category}`); const list = this.lists[category]; if (list instanceof Error) throw list; return list.map((id) => ({ id })); },
    async playlistSnapshot(id) { calls.push(`playlist:${id}`); const values = this.rows[id]; if (values instanceof Error) throw values; return playlist(id, values); } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qishui-hot-library-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = options.now ?? base;
  const timers = new Map(); let timerId = 0;
  const file = path.join(directory, 'library.json');
  const catalog = options.catalog ?? catalogFixture();
  const settings = { catalog, file, now: () => clock, setTimer: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimer: (id) => timers.delete(id), ...options.settings };
  const library = new HotLibrary(settings);
  t.after(() => library.close());
  return { library, settings, catalog, timers, file, time: () => clock, advance: (ms) => { clock += ms; }, setTime: (now) => { clock = now; } };
}

test('first start collects public metadata, deduplicates IDs and scores distinct sources without accumulating refresh heat', async (t) => {
  const { library, catalog, file } = await fixture(t);
  const first = await library.start();
  assert.equal(first.collecting, false);
  assert.equal(first.total, 4); assert.equal(first.counts.active, 4);
  assert.equal(first.tracks[0].id, '2'); assert.equal(first.tracks[0].sourceCount, 3);
  assert.equal(first.lastSuccessAt, base);
  assert.deepEqual(catalog.calls, ['discover:hot', 'discover:charts', 'playlist:10', 'playlist:20', 'playlist:30']);
  const again = await library.collect({ force: true });
  assert.deepEqual(again.tracks, first.tracks);
  assert.equal(again.runs.length, 2);
  assert.equal(again.runs[0].added, 0);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.entries.length, 4);
  const shared = data.entries.find((entry) => entry.id === '2');
  assert.deepEqual(shared.sources.map((source) => source.id).sort(), ['10', '20', '30']);
  assert.equal(shared.sources.every((source) => source.name === '抖音热歌'), true);
  assert.equal(shared.history.length, 1, 'manual refresh in the same slot replaces the sample');
  assert.equal(data.schedule.slot, Date.parse('2026-10-02T01:00:00Z'));
  assert.equal(data.schedule.outcome, 'success');
  const tracks = library.hot(2).tracks;
  tracks[0].name = 'mutated';
  assert.equal(library.hot(2).tracks[0].name, '歌曲2');
  assert.equal('playback' in library.hot(2).tracks[0], false);
});

test('Shanghai slots use 09:00 and 21:00 independently of host timezone including date boundaries', async (t) => {
  const cases = [
    ['2026-10-01T23:59:00Z', '2026-10-01T13:00:00Z', '2026-10-02T01:00:00Z'],
    ['2026-10-02T01:00:00Z', '2026-10-02T01:00:00Z', '2026-10-02T13:00:00Z'],
    ['2026-10-02T12:59:00Z', '2026-10-02T01:00:00Z', '2026-10-02T13:00:00Z'],
    ['2026-10-02T13:00:00Z', '2026-10-02T13:00:00Z', '2026-10-03T01:00:00Z'],
    ['2026-12-31T23:00:00Z', '2026-12-31T13:00:00Z', '2027-01-01T01:00:00Z'],
  ];
  for (const [now, latest, next] of cases) {
    const { library, timers } = await fixture(t, { now: Date.parse(now) });
    const snapshot = await library.start();
    assert.equal(library.state.schedule.slot, Date.parse(latest));
    assert.equal(snapshot.nextRunAt, Date.parse(next));
    assert.equal([...timers.values()][0].ms, Date.parse(next) - Date.parse(now));
    assert.equal(snapshot.timezone, 'Asia/Shanghai');
    assert.deepEqual(snapshot.times, ['09:00', '21:00']);
  }
});

test('restart does not repeat a completed slot; downtime catches up only the latest slot', async (t) => {
  const { library, catalog, settings, advance } = await fixture(t);
  await library.start(); await library.close();
  const calls = catalog.calls.length;
  const restarted = new HotLibrary(settings); t.after(() => restarted.close());
  await restarted.start(); assert.equal(catalog.calls.length, calls);
  advance(3 * DAY);
  await restarted.collect();
  assert.equal(catalog.calls.length, calls + 5);
  assert.equal(restarted.snapshot().runs.length, 2);
  assert.equal(restarted.state.schedule.slot, base + 3 * DAY - HOUR);
});

test('failed slots retry once after thirty minutes, survive restart, and never loop within the same slot', async (t) => {
  const catalog = catalogFixture({ lists: { hot: new Error('secret cookie'), charts: new Error('secret token') } });
  const { library, settings, advance } = await fixture(t, { catalog });
  let state = await library.start();
  assert.equal(catalog.calls.length, 2); assert.equal(state.runs[0].status, 'failed');
  assert.equal(state.nextRunAt, base + HOUR / 2);
  assert.equal(JSON.stringify(state).includes('secret'), false);
  await library.close();
  const restarted = new HotLibrary(settings); t.after(() => restarted.close());
  await restarted.start(); assert.equal(catalog.calls.length, 2);
  advance(HOUR / 2 - 1); await restarted.collect(); assert.equal(catalog.calls.length, 2);
  advance(1); state = await restarted.collect(); assert.equal(catalog.calls.length, 4);
  assert.equal(state.nextRunAt, Date.parse('2026-10-02T13:00:00Z'));
  advance(HOUR); await restarted.collect(); assert.equal(catalog.calls.length, 4);
  advance(12 * HOUR); await restarted.collect(); assert.equal(catalog.calls.length, 6);
});

test('an interrupted persisted claim delays restart retry and repeated manual collection is coalesced', async (t) => {
  const { library, settings, file, catalog, advance } = await fixture(t);
  await library.init();
  let release;
  const original = catalog.playlistSnapshot.bind(catalog);
  catalog.playlistSnapshot = async (id) => { await new Promise((resolve) => { release = resolve; }); return original(id); };
  // Limit to one playlist so the controlled request has one release callback.
  catalog.lists = { hot: ['10'], charts: ['10'] };
  const first = library.collect({ force: true });
  const second = library.collect({ force: true });
  assert.equal(first, second);
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(release);
  const claimed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(claimed.schedule.outcome, 'running'); assert.equal(claimed.schedule.attempts, 1);
  const secondFile = `${file}.restart`;
  await writeFile(secondFile, JSON.stringify(claimed));
  const restarted = new HotLibrary({ ...settings, file: secondFile, catalog: catalogFixture() });
  t.after(() => restarted.close());
  await restarted.start(); assert.equal(restarted.catalog.calls.length, 0);
  release(); await first;
  advance(HOUR / 2); await restarted.collect(); assert.equal(restarted.catalog.calls.length, 5);
});

test('partial and failed scans preserve aging entries while complete scans archive after 14d and delete after 45d', async (t) => {
  const { library, catalog, advance } = await fixture(t);
  await library.collect();
  const initialSeen = library.snapshot().tracks.find((item) => item.id === '1').lastSeenAt;
  catalog.lists = { hot: ['20'], charts: ['20'] };
  advance(15 * DAY);
  catalog.rows['20'] = new Error('unavailable');
  const failed = await library.collect();
  assert.equal(failed.counts.active, 4); assert.equal(failed.counts.archived, 0);
  catalog.rows['20'] = [track(2)];
  catalog.lists.charts = new Error('failed search');
  const partial = await library.collect({ force: true });
  assert.equal(partial.runs[0].status, 'partial'); assert.equal(partial.counts.archived, 0);
  assert.equal(partial.tracks.find((item) => item.id === '1').lastSeenAt, initialSeen);
  catalog.lists.charts = ['20'];
  let complete = await library.collect({ force: true });
  assert.equal(complete.counts.archived, 3); assert.equal(complete.counts.active, 1);
  assert.equal(complete.total, 1); assert.equal(complete.tracks.every((entry) => entry.status === 'active'), true);
  assert.deepEqual(library.hot(10).tracks.map((item) => item.id), ['2']);
  advance(31 * DAY);
  complete = await library.collect();
  assert.equal(complete.total, 1); assert.equal(complete.runs[0].deleted, 3);
  assert.equal(complete.lastSuccessAt, base + 46 * DAY);
});

test('reappearing archived songs reactivate; partial sparse pages prevent cleanup but 500-track scope permits it', async (t) => {
  const { library, catalog, advance } = await fixture(t);
  await library.collect(); advance(15 * DAY);
  catalog.lists = { hot: ['10'], charts: ['10'] };
  catalog.playlistSnapshot = async (id) => playlist(id, [track(10)], { partial: true, reportedTotal: 100 });
  const partial = await library.collect();
  assert.equal(partial.runs[0].status, 'partial'); assert.equal(partial.counts.archived, 0);
  catalog.playlistSnapshot = async (id) => playlist(id, Array.from({ length: 500 }, (_, index) => track(1000 + index)), { partial: true, reportedTotal: 900 });
  const capped = await library.collect({ force: true });
  assert.equal(capped.runs[0].status, 'success'); assert.equal(capped.counts.archived, 4);
  catalog.playlistSnapshot = async (id) => playlist(id, [track(1)]);
  const returnOfSong = await library.collect({ force: true });
  assert.equal(returnOfSong.tracks.find((item) => item.id === '1').status, 'active');
});

test('two unavailable observations at least one hour apart block seven days; success and expiry restore playback', async (t) => {
  const { library, advance, settings } = await fixture(t);
  await library.collect();
  assert.equal(await library.recordPlayback('2', 'network'), false);
  assert.equal(await library.recordPlayback('2', 'unavailable'), true);
  assert.equal(await library.recordPlayback('2', 'unavailable'), false);
  advance(HOUR - 1); assert.equal(await library.recordPlayback('2', 'unavailable'), false);
  advance(1); assert.equal(await library.recordPlayback('2', 'unavailable'), true);
  assert.equal(library.snapshot().counts.blocked, 1);
  assert.equal(library.snapshot().total, 3);
  assert.equal(library.snapshot().tracks.some((item) => item.id === '2'), false);
  assert.equal(library.hot().tracks.some((item) => item.id === '2'), false);
  const reloaded = new HotLibrary(settings); await reloaded.init(); t.after(() => reloaded.close());
  assert.equal(reloaded.snapshot().counts.blocked, 1);
  assert.equal(await library.recordPlayback('2', 'unavailable'), false);
  advance(7 * DAY);
  assert.equal(library.snapshot().counts.blocked, 0);
  assert.equal(library.hot().tracks[0].id, '2');
  await library.recordPlayback('2', 'unavailable');
  assert.equal(library.snapshot().counts.blocked, 0, 'expiry clears old failure count before counting a new failure');
  advance(HOUR); await library.recordPlayback('2', 'unavailable');
  assert.equal(library.snapshot().counts.blocked, 1);
  await library.recordPlayback('2', 'success');
  assert.equal(library.snapshot().counts.blocked, 0);
  assert.equal(await library.recordPlayback('2', 'success'), false);
});

test('corrupt files remain byte-for-byte untouched and collection degrades without crashing', async (t) => {
  const { library, file, catalog, timers } = await fixture(t);
  const original = '{broken state';
  await writeFile(file, original);
  const state = await library.start();
  assert.equal(state.total, 0); assert.match(state.lastError, /保留原文件/);
  assert.equal(state.nextRunAt, null); assert.equal(timers.size, 0);
  await library.collect({ force: true });
  assert.equal(catalog.calls.length, 0);
  assert.deepEqual(library.hot().tracks, []);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('schema-invalid state also stays intact; persistence failures retain the previous in-memory library', async (t) => {
  const broken = await fixture(t);
  const original = JSON.stringify({ version: 1, entries: [] });
  await writeFile(broken.file, original);
  assert.match((await broken.library.start()).lastError, /保留原文件/);
  assert.equal(await readFile(broken.file, 'utf8'), original);
  const working = await fixture(t);
  await working.library.collect();
  working.library.writeJson = async () => { throw new Error('disk full secret'); };
  const snapshot = await working.library.collect({ force: true });
  assert.equal(snapshot.total, 4); assert.match(snapshot.lastError, /保存失败/);
  assert.equal(snapshot.lastError.includes('secret'), false);
  assert.equal(snapshot.nextRunAt, null);
});

test('playlist concurrency never exceeds two and both discovery lists contribute at most six playlists', async (t) => {
  let active = 0, maxActive = 0;
  const catalog = catalogFixture({ lists: { hot: ['10', '11', '12', '13'], charts: ['20', '21', '22', '23'] } });
  catalog.playlistSnapshot = async function (id) {
    this.calls.push(`playlist:${id}`); active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2)); active--;
    return playlist(id, [track(id)]);
  };
  const { library } = await fixture(t, { catalog });
  const snapshot = await library.collect();
  assert.equal(maxActive, 2); assert.equal(snapshot.total, 6);
  assert.deepEqual(catalog.calls.slice(2), ['playlist:10', 'playlist:20', 'playlist:11', 'playlist:21', 'playlist:12', 'playlist:22']);
});

test('concurrent playback changes are serialized with collection and closing prevents future network work', async (t) => {
  const { library, catalog, advance, file, timers } = await fixture(t);
  await library.start();
  await library.recordPlayback('2', 'unavailable'); advance(HOUR);
  await Promise.all([library.collect({ force: true }), library.recordPlayback('2', 'unavailable')]);
  assert.equal(library.snapshot().counts.blocked, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).entries.find((item) => item.id === '2').playback.failures, 2);
  await library.close(); assert.equal(timers.size, 0);
  const calls = catalog.calls.length;
  await library.collect({ force: true }); assert.equal(catalog.calls.length, calls);
});

test('only valid bounded metadata is stored, snapshots paginate, and run history stays bounded', async (t) => {
  const catalog = catalogFixture({ lists: { hot: ['10'], charts: ['10'] }, rows: { 10: [
    { ...track(1), cookie: 'private', url: 'https://media.test/token', cover: 'https://evil.test/private' },
    { ...track(2), id: 2 }, { ...track(3), durationMs: -1 }, track(4), track(4), track(5),
  ] } });
  const { library, file } = await fixture(t, { catalog });
  await library.collect();
  const page = library.snapshot({ offset: 1, limit: 1 });
  assert.equal(page.total, 3); assert.equal(page.tracks.length, 1); assert.equal(page.hasMore, true);
  const contents = await readFile(file, 'utf8');
  assert.equal(contents.includes('private'), false); assert.equal(contents.includes('media.test'), false);
  assert.throws(() => library.hot(501), /数量无效/);
  assert.throws(() => library.snapshot({ offset: -1 }), /分页参数/);
  for (let index = 0; index < 22; index++) await library.collect({ force: true });
  assert.equal(library.snapshot().runs.length, 20);
});

test('large successive scans cap the persistent library and partial scans never evict existing entries', async (t) => {
  let generation = 0;
  const catalog = catalogFixture({ lists: { hot: ['1', '2', '3'], charts: ['4', '5', '6'] } });
  catalog.playlistSnapshot = async (id) => playlist(id,
    Array.from({ length: 500 }, (_, index) => track(1 + generation * 10000 + Number(id) * 500 + index)));
  const { library } = await fixture(t, { catalog });
  await library.collect(); assert.equal(library.snapshot().total, 3000);
  generation++;
  await library.collect({ force: true }); assert.equal(library.snapshot().total, 5000);
  const existing = new Set(library.state.entries.map((entry) => entry.id));
  generation++; catalog.lists.charts = new Error('partial');
  await library.collect({ force: true });
  assert.deepEqual(new Set(library.state.entries.map((entry) => entry.id)), existing);
  assert.equal(library.snapshot().runs[0].added, 0);
});

test('heat history retains fourteen independent slots and reports changes relative to the previous slot', async (t) => {
  const { library, catalog, advance, settings } = await fixture(t);
  await library.collect();
  catalog.lists = { hot: ['10'], charts: ['10'] };
  advance(12 * HOUR); await library.collect();
  const lower = library.snapshot().tracks.find((entry) => entry.id === '2');
  assert.ok(lower.scoreDelta < 0);
  const expectedDelta = lower.scoreDelta;
  await library.collect({ force: true });
  assert.equal(library.snapshot().tracks.find((entry) => entry.id === '2').scoreDelta, expectedDelta);
  assert.equal(library.state.entries.find((entry) => entry.id === '2').history.length, 2);
  for (let i = 0; i < 15; i++) { advance(12 * HOUR); await library.collect(); }
  assert.equal(library.state.entries.find((entry) => entry.id === '2').history.length, 14);
  const reloaded = new HotLibrary(settings); await reloaded.init(); t.after(() => reloaded.close());
  assert.deepEqual(reloaded.state.entries.find((entry) => entry.id === '2').history,
    library.state.entries.find((entry) => entry.id === '2').history);
});

test('partial sources do not accumulate extra heat across retries', async (t) => {
  const catalog = catalogFixture({ lists: { hot: ['10'], charts: ['10'] }, rows: { 10: [track(1)], 20: [track(1)] } });
  const { library } = await fixture(t, { catalog });
  const initial = await library.collect();
  catalog.lists = { hot: ['20'], charts: new Error('temporary discovery failure') };
  const partial = await library.collect({ force: true });
  assert.equal(partial.tracks[0].sourceCount, 1);
  assert.equal(partial.tracks[0].score, initial.tracks[0].score);
  assert.equal(library.state.entries[0].history.length, 1);
});
