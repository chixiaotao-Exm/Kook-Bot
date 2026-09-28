import test from 'node:test';
import assert from 'node:assert/strict';
import { QishuiMusic, qishuiId, validateQishuiMediaUrl } from '../src/qishui-music.js';
import { UserError, UnavailableError } from '../src/util.js';

const config = { qishuiApiUrl: 'http://127.0.0.1:18997/internal/qishui', qishuiApiToken: 'test-bridge-secret' };
const identifier = '7412345678901234567';
const sample = { id: identifier, name: '测试歌曲', artists: '歌手', durationMs: 210000, album: '专辑', cover: 'https://img.example.test/cover.jpg' };
const mediaUrl = `${config.qishuiApiUrl}/media/${'a'.repeat(48)}.mp3`;
const media = { url: mediaUrl, durationMs: 210000, fullTrack: true, encrypted: false };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const fixture = (reply, settings = {}) => {
  const calls = [];
  const music = new QishuiMusic(config, { fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return typeof reply === 'function' ? reply(new URL(url), options) : json(reply);
  }, ...settings });
  return { music, calls };
};

test('汽水 IDs keep 19-digit precision and reject numbers, links and invalid IDs', () => {
  assert.equal(qishuiId(identifier), identifier);
  assert.equal(qishuiId(` ${identifier} `), identifier);
  for (const value of [Number(identifier), 123, '0', '0123', '1'.repeat(20), '123abc', 'https://music.douyin.com/song/123', null]) assert.equal(qishuiId(value), null);
});

test('optional absent or malformed bridge never blocks startup and reports unavailable', async () => {
  for (const input of [{}, { qishuiApiUrl: config.qishuiApiUrl }, { ...config, qishuiApiToken: 'x\ny' },
    ...['http://example.test/qishui', 'https://u:p@example.test/', 'https://example.test/?token=x', 'https://example.test/#x',
      'https://example.test/../qishui', 'https://example.test/%71ishui', 'https://example.test//qishui'].map((qishuiApiUrl) => ({ ...config, qishuiApiUrl }))]) {
    const music = new QishuiMusic(input, { fetchImpl: () => assert.fail('must not fetch without valid configuration') });
    await music.init();
    assert.equal(music.configured, false);
    assert.deepEqual(await music.account(), { loggedIn: false, unavailable: true, status: 'unavailable' });
    await assert.rejects(music.search('歌曲'), /尚未配置/);
  }
  for (const qishuiApiUrl of ['https://bridge.example.test', 'https://bridge.example.test/internal/qishui/', 'http://localhost:18997', 'http://[::1]:18997']) {
    assert.equal(new QishuiMusic({ ...config, qishuiApiUrl }).configured, true);
  }
});

test('search and detail requests preserve base path, auth and source normalization', async () => {
  const { music, calls } = fixture((url) => json(url.pathname.endsWith('/search') ? { tracks: [sample] } : { track: sample }));
  assert.deepEqual(await music.resolve('歌手 歌曲'), { ...sample, source: 'qishui' });
  assert.deepEqual(await music.resolve(identifier), { ...sample, source: 'qishui' });
  assert.equal(calls[0].url.pathname, '/internal/qishui/search');
  assert.equal(calls[0].url.searchParams.get('q'), '歌手 歌曲');
  assert.equal(calls[0].url.searchParams.get('limit'), '1');
  assert.equal(calls[1].url.searchParams.get('id'), identifier);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${config.qishuiApiToken}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].url.href.includes(config.qishuiApiToken), false);
  assert.equal(calls[0].options.signal.aborted, true);
});

test('invalid input cannot become provider search or unbounded pagination', async () => {
  const { music, calls } = fixture({ tracks: [] });
  for (const operation of [() => music.resolve(Number(identifier)), () => music.resolve('0'), () => music.resolve('1'.repeat(20)),
    () => music.resolve('https://evil.test/song/123'), () => music.search(''), () => music.search('x'.repeat(201)), () => music.search('x', 101),
    () => music.search('x', 0), () => music.playlist(identifier, 501), () => music.playlistDetails(identifier, { offset: -1 }),
    () => music.playlistDetails(identifier, { limit: 101 }), () => music.discover('arbitrary')]) await assert.rejects(operation(), UserError);
  assert.equal(calls.length, 0);
  await assert.rejects(music.resolve('没有这首歌'), /没有找到/);
});

test('untrusted or lossy bridge track metadata is rejected', async () => {
  for (const track of [{ ...sample, id: Number(identifier) }, { ...sample, durationMs: '210000' }, { ...sample, durationMs: -1 },
    { ...sample, artists: ['歌手'] }, { ...sample, name: '' }, { ...sample, id: '123' }]) {
    await assert.rejects(fixture({ track }).music.resolve(identifier), /数据无效/);
  }
  await assert.rejects(fixture({ tracks: [sample, sample] }).music.search('歌曲', 1), /数据无效/);
  const normalized = await fixture({ track: { ...sample, cover: 'javascript:alert(1)', extraCredential: 'secret' } }).music.resolve(identifier);
  assert.equal(normalized.cover, ''); assert.equal('extraCredential' in normalized, false);
});

test('playlist imports are bounded and paged by exact offset with stable string IDs', async () => {
  const { music, calls } = fixture((url) => {
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    return json({ playlist: { id: identifier, name: '歌单', trackCount: 250 },
      tracks: Array.from({ length: Math.min(limit, Math.max(0, 250 - offset)) }, (_, index) => ({ ...sample, id: String(100000 + offset + index) })),
      offset, limit, total: 250, hasMore: offset + limit < 250 });
  });
  const result = await music.playlist(identifier, 220);
  assert.equal(result.length, 220);
  assert.equal(result[219].id, '100219');
  assert.deepEqual(calls.map(({ url }) => [url.searchParams.get('offset'), url.searchParams.get('limit')]), [['0', '100'], ['100', '100'], ['200', '20']]);
  calls.length = 0;
  assert.equal((await music.playlist(identifier, 500)).length, 250);
  assert.equal(calls.length, 3);
});

test('inconsistent playlist pages fail safely instead of duplicating or inventing tracks', async () => {
  const good = { playlist: { id: identifier, name: '歌单' }, tracks: [sample], total: 1, offset: 0, limit: 50, hasMore: false };
  for (const change of [{ total: 0 }, { offset: 1 }, { limit: 25 }, { hasMore: true }, { playlist: { id: '12', name: '错误歌单' } }]) {
    await assert.rejects(fixture({ ...good, ...change }).music.playlistDetails(identifier), /数据无效/);
  }
});

test('discovery, hot songs, account and lyrics use the normalized provider contract', async () => {
  const { music } = fixture((url) => {
    const route = url.pathname.split('/').pop();
    return json({ discover: { playlists: [{ id: identifier, name: '热歌', trackCount: 1 }] }, hot: { mode: 'unexpected', name: '热歌', tracks: [sample] },
      account: { loggedIn: true, id: 'user-1', name: '用户', cookie: 'never-exposed', avatar: 'https://img.example.test/avatar.jpg' },
      lyrics: { lyric: '[00:00]歌词', translation: '' } }[route]);
  });
  assert.equal((await music.discover('hot'))[0].source, 'qishui');
  assert.equal((await music.hot()).mode, 'hot');
  const account = await music.account(); assert.equal(account.id, 'user-1'); assert.equal('cookie' in account, false);
  assert.deepEqual(await music.lyrics(sample), { lyric: '[00:00]歌词', translation: '' });
  for (const method of ['qrCreate', 'qrStatus', 'logout']) assert.throws(() => music[method](), /暂不支持/);
});

test('stream accepts only matching full unencrypted audio and sends ID without credentials in URL', async () => {
  const { music, calls } = fixture(media);
  assert.equal(await music.stream(sample), mediaUrl);
  assert.equal(calls[0].url.pathname, '/internal/qishui/stream');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: identifier });
  for (const candidate of [{ ...media, fullTrack: false }, { ...media, fullTrack: undefined }, { ...media, encrypted: true },
    { ...media, encrypted: undefined }, { ...media, preview: true }, { ...media, durationMs: 30000 }, { ...media, durationMs: '210000' },
    { ...media, durationMs: 0 }, { ...media, durationMs: 212001 }]) {
    await assert.rejects(fixture(candidate).music.stream(sample), UnavailableError);
  }
  assert.equal(await fixture({ ...media, durationMs: 208000 }).music.stream(sample), mediaUrl);
  await assert.rejects(music.stream({ ...sample, durationMs: 0 }), UnavailableError);
});

test('media capabilities cannot target arbitrary URLs, normalized paths or transmit API tokens', () => {
  assert.equal(validateQishuiMediaUrl(mediaUrl, config.qishuiApiUrl), mediaUrl);
  for (const value of ['file:///etc/passwd', mediaUrl.replace('127.0.0.1', 'evil.test'), mediaUrl.replace(':18997', ':18998'),
    mediaUrl.replace('/media/', '/private/'), mediaUrl.replace('/media/', '/a/../media/'), mediaUrl.replace('/media/', '/%6dedia/'),
    mediaUrl.replace('http://', 'http://user:pass@'), `${mediaUrl}?token=x`, `${mediaUrl}#fragment`,
    `${config.qishuiApiUrl}/media/123.mp3`, mediaUrl.replace('/media/', '/media//'), mediaUrl.replace('.mp3', '.m3u8')]) {
    assert.throws(() => validateQishuiMediaUrl(value, config.qishuiApiUrl), UnavailableError);
  }
});

test('upstream diagnostics and redirects never expose secret responses or trigger a second fetch', async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    const { music, calls } = fixture(() => new Response('secret upstream URL and credentials', { status,
      headers: { Location: 'https://evil.test', 'Content-Type': 'text/plain' } }));
    await assert.rejects(music.search('歌曲'), (error) => error instanceof UserError && !/secret|credentials|evil/.test(error.message));
    assert.equal(calls.length, 1);
  }
});

test('response limits cover content length, streaming bytes, invalid JSON and types', async () => {
  const malformed = [() => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(8 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } }), { headers: { 'Content-Type': 'application/json' } })];
  for (const response of malformed) await assert.rejects(fixture(response).music.search('歌曲'), /数据无效/);
});

test('timeouts abort stalled requests including fetch implementations that ignore abort', async () => {
  let signal;
  const music = new QishuiMusic(config, { timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(music.search('歌曲'), /超时/);
  assert.equal(signal.aborted, true); assert.equal(music.pending.size, 0);
});

test('closing the provider cancels pending work and prevents new requests', async () => {
  const music = new QishuiMusic(config, { fetchImpl: () => new Promise(() => {}) });
  const pending = music.search('歌曲'); music.close();
  await assert.rejects(pending, /已关闭/);
  await assert.rejects(music.search('歌曲'), /已关闭/);
  assert.equal(music.pending.size, 0);
});
