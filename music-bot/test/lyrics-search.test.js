import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, normalizeLyrics } from '../src/lyrics.js';
import { MusicSources } from '../src/music-sources.js';
import { Music } from '../src/music.js';
import { UserError } from '../src/util.js';

test('LRC parsing sorts multiple timestamps, offsets, fractional seconds and translations', () => {
  const result = normalizeLyrics({ lyric: '[ar:Artist]\n[offset:500]\n[00:02.50][00:04.500]再次\n[00:01.5]Hello &amp; world\n[00:01.500]第二行\n[00:61.00]Invalid',
    translation: '[offset:500]\n[00:01.500]你好\n[00:02.500]再见' });
  assert.deepEqual(result.lines, [
    { time: 1, text: 'Hello & world\n第二行', translation: '你好' },
    { time: 2, text: '再次', translation: '再见' }, { time: 4, text: '再次' },
  ]); assert.equal(result.available, true);
  assert.deepEqual(parseLrc('[offset:-1000]\n[00:01.01]early').lines, [{ time: 2.01, text: 'early' }]);
  assert.deepEqual(parseLrc('[01:02:03.004]long').lines, [{ time: 3723.004, text: 'long' }]);
});

test('unsynced, missing, malformed and large lyrics are bounded and safe plain text', () => {
  assert.deepEqual(normalizeLyrics({ lyric: '[ti:Title]\nhello\nworld' }), { lines: [], plain: 'hello\nworld', available: true });
  assert.equal(normalizeLyrics({}).available, false);
  assert.equal(normalizeLyrics({ lyric: '[ar:Artist]\n[offset:abc]' }).available, false);
  assert.equal(normalizeLyrics({ lyric: '[99:99]broken' }).available, false);
  assert.deepEqual(parseLrc('[00:01]hello<script>nothing()</script>').lines, [{ time: 1, text: 'hellonothing()' }]);
  const many = parseLrc(Array.from({ length: 5000 }, (_, i) => `[${String(i % 60).padStart(2, '0')}:01]${'x'.repeat(40)}`).join('\n'));
  assert.ok(many.lines.length <= 60); assert.ok(many.lines.every((line) => line.text.length <= 2000));
});

test('joint search keeps platform identities, order and healthy results when one provider fails', async () => {
  const calls = [];
  const music = new MusicSources({}, {
    netease: { async search(query, limit) { calls.push(['netease', query, limit]); return [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }]; } },
    qq: { async search(query, limit) { calls.push(['qq', query, limit]); return [{ id: '1', name: 'Other version' }]; } },
  });
  let result = await music.searchAll(' hello ', 20);
  assert.deepEqual(result.tracks.map((song) => [song.source, song.id]), [['netease', '1'], ['qq', '1'], ['netease', '2']]);
  assert.deepEqual(calls, [['netease', 'hello', 20], ['qq', 'hello', 20]]);
  music.providers.qq.search = async () => { throw new UserError('QQ 音乐暂不可用'); };
  result = await music.searchAll('hello'); assert.equal(result.tracks.length, 2); assert.match(result.results.qq.error, /QQ/);
  music.providers.netease.search = async () => { throw new Error('secret diagnostic'); };
  result = await music.searchAll('hello'); assert.equal(result.tracks.length, 0); assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(music.searchAll('')); await assert.rejects(music.searchAll('a', 101));
});

test('NetEase lyric endpoint and source router preserve requested song identity', async () => {
  const calls = [];
  const netease = new Music({ cookie: '', dataDir: 'nonexistent-test-lyrics' }, { async lyric(params) { calls.push(params); return { body: { code: 200, lrc: { lyric: '[00:01]hello' }, tlyric: { lyric: '[00:01]你好' } } }; } });
  const music = new MusicSources({}, { netease, qq: { async lyrics(track) { assert.equal(track.mid, '0039MnYb0qxYhV'); return { lyric: 'QQ lyrics' }; } } });
  const result = await music.lyrics('123', 'netease');
  assert.equal(calls[0].id, '123'); assert.equal(calls[0].unblock, 'false'); assert.equal(result.source, 'netease'); assert.equal(result.id, '123');
  assert.deepEqual(result.lines, [{ time: 1, text: 'hello', translation: '你好' }]);
  const qq = await music.lyrics({ source: 'qq', id: '456', mid: '0039MnYb0qxYhV' });
  assert.equal(qq.id, '456'); assert.equal(qq.source, 'qq'); assert.equal(qq.plain, 'QQ lyrics');
  await assert.rejects(music.lyrics('invalid', 'netease'));
});
