import test from 'node:test';
import assert from 'node:assert/strict';
import { QishuiCatalog } from '../qishui/catalog.js';
import { UserError, UnavailableError } from '../src/util.js';

const id = '7145679509738489867';
const playlistId = '7200303561195061287';
const rawTrack = (trackId = id) => ({ id: trackId, name: '屋顶', duration: 312999,
  artists: [{ name: '宿涵' }, { name: '周杰伦' }],
  album: { name: '中国好声音', url_cover: { urls: ['https://p3-luna.douyinpic.com/img/'], uri: 'tos-cn-v-2774c002/cover123' } },
  preview: { url: 'https://never-return.test/preview.mp3' }, vid: 'not-public' });
const rawPlaylist = (trackCount = 1) => ({ id: playlistId, title: '热门歌曲', count_tracks: trackCount,
  url_cover: 'https://p3-luna.douyinpic.com/img/cover', desc: '热门歌单介绍', owner: { nickname: '歌单用户', secret: true },
  stats: { count_collected: 500, count_visible: 999 } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const searchData = (values, kind = 'track') => ({ result_groups: [{ data: values.map((value) => ({ entity: { [kind]: value } })) }] });
const playlistData = (values, count = values.length, next = '0') => ({ playlist: rawPlaylist(count),
  media_resources: values.map((value) => ({ entity: { track_wrapper: { track: value } } })), next_cursor: next });
function fixture(reply, settings = {}) {
  const calls = [];
  const catalog = new QishuiCatalog({ fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return typeof reply === 'function' ? reply(new URL(url), options) : json(reply);
  }, ...settings });
  return { catalog, calls };
}

test('anonymous official search preserves exact identifiers and returns metadata only', async () => {
  const { catalog, calls } = fixture(searchData([rawTrack()]));
  const [track] = await catalog.search('周杰伦', 1);
  assert.deepEqual(track, { id, name: '屋顶', artists: '宿涵 / 周杰伦', durationMs: 312999,
    cover: 'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/cover123', album: '中国好声音', source: 'qishui' });
  assert.equal(calls[0].url.origin, 'https://api.qishui.com');
  assert.equal(calls[0].url.pathname, '/luna/search/track');
  assert.equal(calls[0].url.searchParams.get('q'), '周杰伦');
  assert.equal(calls[0].url.searchParams.get('aid'), '386088');
  assert.equal(calls[0].url.searchParams.get('cursor'), '0');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['User-Agent']);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(track).includes('preview'), false);
  assert.equal(JSON.stringify(track).includes('not-public'), false);
});

test('invalid input IDs, queries, quantities, and offsets do not trigger requests', async () => {
  const { catalog, calls } = fixture({});
  for (const value of [Number(id), 123, '0', '0123', '1'.repeat(20), 'https://evil.test', null]) {
    await assert.rejects(catalog.track(value), UserError);
    await assert.rejects(catalog.playlist(value), UserError);
    await assert.rejects(catalog.lyrics(value), UserError);
  }
  for (const action of [() => catalog.search(''), () => catalog.search('x'.repeat(201)), () => catalog.search('x', 101),
    () => catalog.playlist(playlistId, 501), () => catalog.playlistDetails(playlistId, { offset: -1 }),
    () => catalog.playlistDetails(playlistId, { offset: 100001 }), () => catalog.playlistDetails(playlistId, { limit: 101 }),
    () => catalog.discover('__proto__'), () => catalog.request('https://evil.test')]) await assert.rejects(action(), UserError);
  assert.equal(calls.length, 0);
});

test('invalid upstream entries are omitted, safe number IDs accepted, unsafe numbers never rounded', async () => {
  const tracks = [rawTrack(Number(id)), rawTrack('0123'), { ...rawTrack('20'), duration: '300000' },
    { ...rawTrack('21'), duration: -1 }, { ...rawTrack('22'), artists: '歌手' }, rawTrack(), rawTrack(), rawTrack(100)];
  const result = await fixture(searchData(tracks)).catalog.search('歌', 3);
  assert.deepEqual(result.map((track) => track.id), [id, '100']);
  await assert.rejects(fixture({ seo_track: { track: rawTrack(Number(id)) } }).catalog.track(id), /数据无效/);
  await assert.rejects(fixture({ seo_track: { track: rawTrack('100') } }).catalog.track(id), /数据无效/);
});

test('cover metadata only admits known HTTPS image hosts without credentials', async () => {
  for (const cover of ['http://p3-luna.douyinpic.com/a', 'https://p3-luna.douyinpic.com.evil.test/a',
    'https://user:password@p3-luna.douyinpic.com/a', 'https://p3-luna.douyinpic.com:444/a', 'https://127.0.0.1/a',
    { urls: ['https://p3-luna.douyinpic.com/img/'], uri: '../secret' }]) {
    const raw = rawTrack(); raw.album.url_cover = cover;
    assert.equal((await fixture(searchData([raw])).catalog.search('歌'))[0].cover, '');
  }
});

test('track and lyrics share a metadata-only cache and KRC is converted to LRC', async () => {
  const { catalog, calls } = fixture({ seo_track: { track: rawTrack() }, lyric: { type: 'krc', content: '[17310,2970]<0,230,0>念<230,220,0>旧\n[60001,200]<0,200,0>好' },
    track_player: { cookie: 'must-not-cache', video_model: 'secret-media' } });
  const track = await catalog.track(id);
  assert.equal(track.id, id);
  assert.deepEqual(await catalog.lyrics(track), { lyric: '[00:17.31]念旧\n[01:00.00]好', translation: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, 'beta-luna.douyin.com');
  assert.equal(calls[0].url.searchParams.get('track_id'), id);
  assert.equal(JSON.stringify([...catalog.cache.values()]).includes('secret-media'), false);
  track.name = 'mutated';
  assert.equal((await catalog.track(id)).name, '屋顶');
});

test('cached metadata expires at 60 seconds and has at most 128 entries', async () => {
  let now = 0;
  const { catalog, calls } = fixture((url) => json({ seo_track: { track: rawTrack(url.searchParams.get('track_id')) } }), { now: () => now });
  await catalog.track(id); now = 59999; await catalog.track(id); assert.equal(calls.length, 1);
  now = 60000; await catalog.track(id); assert.equal(calls.length, 2);
  for (let i = 1; i <= 129; i++) await catalog.track(String(i));
  assert.equal(catalog.cache.size, 128);
  assert.equal(catalog.cache.has(`track:${id}`), false);
});

test('official whole-playlist response is sliced locally despite a nonempty next_cursor', async () => {
  const all = Array.from({ length: 375 }, (_, index) => rawTrack(String(100000 + index)));
  const { catalog, calls } = fixture(playlistData(all, 375, '508'));
  const page = await catalog.playlistDetails(playlistId, { offset: 100, limit: 50 });
  assert.equal(page.total, 375); assert.equal(page.reportedTotal, 375); assert.equal(page.hasMore, true);
  assert.equal(page.partial, false); assert.equal(page.tracks.length, 50); assert.equal(page.tracks[0].id, '100100');
  assert.equal(page.playlist.playCount, 0);
  assert.equal((await catalog.playlist(playlistId, 500)).length, 375);
  assert.equal((await catalog.playlistDetails(playlistId, { offset: 375 })).hasMore, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('playlist_id'), playlistId);
});

test('genuinely paged playlist responses follow bounded cursor and deduplicate overlaps', async () => {
  const { catalog, calls } = fixture((url) => {
    const cursor = url.searchParams.get('cursor');
    if (cursor === '0') return json(playlistData([rawTrack('100'), rawTrack('101')], 4, 'next-2'));
    assert.equal(cursor, 'next-2');
    return json(playlistData([rawTrack('101'), rawTrack('102'), rawTrack('103')], 4));
  });
  const page = await catalog.playlistDetails(playlistId);
  assert.equal(page.total, 4); assert.equal(page.partial, false);
  assert.deepEqual(page.tracks.map((track) => track.id), ['100', '101', '102', '103']);
  assert.equal(calls.length, 2);
});

test('incomplete or repeated playlist pages disclose advertised count without inventing tracks', async () => {
  const { catalog, calls } = fixture(playlistData([rawTrack()], 300, 'same-cursor'));
  const page = await catalog.playlistDetails(playlistId, { offset: 0, limit: 50 });
  assert.equal(page.total, 1); assert.equal(page.reportedTotal, 300); assert.equal(page.hasMore, false);
  assert.equal(page.partial, true); assert.match(page.notice, /300.*1/); assert.equal(calls.length, 2);
  for (const malformed of [{ playlist: { ...rawPlaylist(), id: '100' }, media_resources: [] },
    { playlist: rawPlaylist(), media_resources: {} }]) await assert.rejects(fixture(malformed).catalog.playlistDetails(playlistId), /数据无效/);
});

test('playlist loading is bounded by 500 tracks and five provider requests', async () => {
  const all = Array.from({ length: 550 }, (_, index) => rawTrack(String(1000 + index)));
  const large = await fixture(playlistData(all, 550, 'next')).catalog.playlistDetails(playlistId);
  assert.equal(large.total, 500); assert.equal(large.partial, true);
  let sequence = 0;
  const { catalog, calls } = fixture(() => json(playlistData([rawTrack(String(++sequence))], 500, String(sequence))));
  const sparse = await catalog.playlistDetails(playlistId);
  assert.equal(calls.length, 5); assert.equal(sparse.total, 5); assert.equal(sparse.partial, true);
  const unknown = await fixture(playlistData(all, 0, 'next')).catalog.playlistDetails(playlistId);
  assert.equal(unknown.total, 500); assert.equal(unknown.partial, true); assert.match(unknown.notice, /尚未确认完整/);
});

test('discovery categories map to official playlist search and mine is explicitly unsupported', async () => {
  const playlist = { ...rawPlaylist(), title: '抖音热歌' };
  const { catalog, calls } = fixture(searchData([{ ...playlist, id: Number(playlistId) }, playlist, playlist], 'playlist'));
  for (const [category, keyword] of [['hot', '抖音热歌'], ['charts', '抖音热歌榜'], ['acg', '动漫 ACG']]) {
    const rows = await catalog.discover(category);
    assert.equal(rows.length, 1); assert.equal(rows[0].source, 'qishui');
    assert.equal(calls.at(-1).url.pathname, '/luna/search/playlist');
    assert.equal(calls.at(-1).url.searchParams.get('q'), keyword);
  }
  await assert.rejects(catalog.discover('mine'), UnavailableError);
  assert.equal(calls.length, 3);
});

test('Douyin discovery ranks matching titles and current hits before unrelated, nostalgic, and DJ lists', async () => {
  const choices = [
    { ...rawPlaylist(), id: '1', title: '旅行轻音乐', desc: '' },
    { ...rawPlaylist(), id: '2', title: '抖音热歌丨8090怀旧老歌' },
    { ...rawPlaylist(), id: '3', title: '抖音热歌丨车载DJ' },
    { ...rawPlaylist(), id: '4', title: '抖音热歌排行榜' },
    { ...rawPlaylist(), id: '5', title: '2027抖音爆款热歌' },
    { ...rawPlaylist(), id: '6', title: '2027抖音流行热歌' },
    { ...rawPlaylist(), id: '7', title: '流行歌单', desc: '抖音爆款热歌' },
  ];
  const { catalog, calls } = fixture(searchData(choices, 'playlist'), { now: () => Date.UTC(2027, 0, 2) });
  assert.deepEqual((await catalog.discover()).map((item) => item.id), ['5', '6', '4', '3', '2', '7', '1']);
  assert.equal(calls.length, 1);
  assert.deepEqual((await catalog.discover('acg')).map((item) => item.id), choices.map((item) => item.id));
  assert.equal(calls.length, 2);
});

test('missing Douyin matches fall back once to broad hot search and merge without duplicate playlists', async () => {
  const generic = { ...rawPlaylist(), id: '1', title: '热门歌曲' };
  const douyin = { ...rawPlaylist(), id: '2', title: '抖音热歌排行榜' };
  const { catalog, calls } = fixture((url) => json(searchData(url.searchParams.get('q') === '热歌' ? [generic, douyin] : [generic], 'playlist')));
  assert.deepEqual((await catalog.discover('charts')).map((item) => item.id), ['2', '1']);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get('q')), ['抖音热歌榜', '热歌']);
  const empty = fixture(searchData([], 'playlist'));
  await assert.rejects(empty.catalog.hot(), UnavailableError);
  assert.equal(empty.calls.length, 2);
});

test('fallback failure keeps initial usable candidates but preserves an error when none are available', async () => {
  for (const choices of [[], [rawPlaylist()]]) {
    const { catalog, calls } = fixture((url) => url.searchParams.get('q') === '热歌'
      ? json({}, 503) : json(searchData(choices, 'playlist')));
    if (choices.length) assert.equal((await catalog.discover()).length, 1);
    else await assert.rejects(catalog.discover(), /请求失败/);
    assert.equal(calls.length, 2);
  }
});

test('hot playlists use valid discovery results and return bounded normalized tracks', async () => {
  const { catalog, calls } = fixture((url) => json(url.pathname.endsWith('/search/playlist')
    ? searchData([{ id: Number(playlistId), title: 'unsafe' }, { ...rawPlaylist(2), title: '抖音热歌' }, { ...rawPlaylist(), id: '42', title: '抖音热歌备选' }], 'playlist')
    : playlistData([rawTrack(), rawTrack('100')], 2)));
  const hot = await catalog.hot(1);
  assert.deepEqual({ mode: hot.mode, name: hot.name, length: hot.tracks.length }, { mode: 'hot', name: '抖音热歌', length: 1 });
  assert.equal(calls.length, 2, 'a sufficient first playlist should not fetch other candidates');
});

test('hot top-ups survive one unavailable playlist and deduplicate up to the requested total', async () => {
  const { catalog, calls } = fixture((url) => {
    if (url.pathname.endsWith('/search/playlist')) return json(searchData(
      ['1', '2', '3', '4'].map((id) => ({ ...rawPlaylist(), id, title: `抖音热歌${id}` })), 'playlist'));
    const id = url.searchParams.get('playlist_id');
    if (id === '2') return json({}, 404);
    const values = id === '1' ? [rawTrack('100'), rawTrack('101')] : [rawTrack('101'), rawTrack('102'), rawTrack('103')];
    return json({ ...playlistData(values), playlist: { ...rawPlaylist(values.length), id } });
  });
  const hot = await catalog.hot(4);
  assert.deepEqual(hot.tracks.map((track) => track.id), ['100', '101', '102', '103']);
  assert.equal(hot.name, '抖音热歌精选');
  assert.deepEqual(calls.slice(1).map(({ url }) => url.searchParams.get('playlist_id')), ['1', '2', '3']);
});

test('hot top-ups cover first-candidate failures, preserve total failure reason, and cap at 500', async () => {
  const { catalog, calls } = fixture((url) => {
    if (url.pathname.endsWith('/search/playlist')) return json(searchData(
      ['1', '2', '3'].map((id) => ({ ...rawPlaylist(), id, title: '抖音热歌' })), 'playlist'));
    const id = url.searchParams.get('playlist_id');
    if (id === '1') return json({}, 503);
    const values = Array.from({ length: 300 }, (_, index) => rawTrack(String((id === '2' ? 1000 : 1200) + index)));
    return json({ ...playlistData(values), playlist: { ...rawPlaylist(values.length), id } });
  });
  assert.equal((await catalog.hot(500)).tracks.length, 500);
  assert.equal(calls.length, 4);
  await assert.rejects(catalog.hot(501), UserError);
  assert.equal(calls.length, 4);
  const failed = fixture((url) => url.pathname.endsWith('/search/playlist')
    ? json(searchData([{ ...rawPlaylist(), title: '抖音热歌' }], 'playlist')) : json({}, 429));
  await assert.rejects(failed.catalog.hot(), /过于频繁/);
});

test('upstream errors, redirects, and diagnostics never leak response contents', async () => {
  for (const response of [() => json({ status_info: { status_code: 403, message: 'secret diagnostic' } }),
    ...[302, 401, 429, 500].map((status) => () => new Response('secret response', { status, headers: { Location: 'https://evil.test' } })),
    () => { throw new Error('secret fetch diagnostic'); }]) {
    const { catalog, calls } = fixture(response);
    await assert.rejects(catalog.search('歌'), (error) => error instanceof UserError && !/secret|evil/.test(error.message));
    assert.equal(calls.length, 1);
  }
});

test('response body validation rejects excessive, malformed and wrong-type payloads', async () => {
  const responses = [() => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    () => json([]), () => new Response('invalid json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(8 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } }), { headers: { 'Content-Type': 'application/json' } })];
  for (const reply of responses) await assert.rejects(fixture(reply).catalog.search('歌'), /数据无效/);
});

test('timeouts and shutdown abort pending catalog work even when fetch ignores cancellation', async () => {
  let signal;
  const slow = new QishuiCatalog({ timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(slow.search('歌'), /超时/); assert.equal(signal.aborted, true); assert.equal(slow.pending.size, 0);
  const { catalog } = fixture(() => new Promise(() => {}));
  const pending = catalog.search('歌'); catalog.close();
  await assert.rejects(pending, /已关闭/); await assert.rejects(catalog.track(id), /已关闭/);
  assert.equal(catalog.pending.size, 0); assert.equal(catalog.cache.size, 0);
});
