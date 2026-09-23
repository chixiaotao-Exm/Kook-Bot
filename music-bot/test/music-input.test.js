import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMusicInput, MUSIC_LINK_HOSTS } from '../src/music-input.js';
import { UserError } from '../src/util.js';

test('complete song/playlist/chart links override the selected source and kind hint', () => {
  const matrix = [
    ['https://music.163.com/song?id=123&userid=777', 'netease', 'song', '123'],
    ['https://music.163.com/#/song?id=123', 'netease', 'song', '123'],
    ['https://y.music.163.com/m/song?id=123', 'netease', 'song', '123'],
    ['https://music.163.com/playlist?id=456', 'netease', 'playlist', '456'],
    ['http://music.163.com/#/playlist?id=456&creatorId=99', 'netease', 'playlist', '456'],
    ['https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV', 'qq', 'song', '0039MnYb0qxYhV'],
    ['https://y.qq.com/n/ryqq_v2/songDetail/0039MnYb0qxYhV', 'qq', 'song', '0039MnYb0qxYhV'],
    ['https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html', 'qq', 'song', '0039MnYb0qxYhV'],
    ['https://i.y.qq.com/v8/playsong.html?songid=123', 'qq', 'song', '123'],
    ['https://i.y.qq.com/n2/m/share/details/song.html?songmid=0039MnYb0qxYhV', 'qq', 'song', '0039MnYb0qxYhV'],
    ['https://y.qq.com/n/ryqq/playlist/456', 'qq', 'playlist', '456'],
    ['https://y.qq.com/n/ryqq_v2/playlist/456', 'qq', 'playlist', '456'],
    ['https://y.qq.com/n/yqq/playsquare/456.html', 'qq', 'playlist', '456'],
    ['https://i.y.qq.com/n2/m/share/details/taoge.html?id=456', 'qq', 'playlist', '456'],
    ['https://i.y.qq.com/n2/m/share/details/taoge/index.html?disstid=456', 'qq', 'playlist', '456'],
    ['https://y.qq.com/songlist?disstid=456', 'qq', 'playlist', '456'],
    ['https://y.qq.com/n/ryqq/toplist/26', 'qq', 'playlist', 'top:26'],
    ['https://y.qq.com/n/ryqq_v2/toplist/26', 'qq', 'playlist', 'top:26'],
    ['https://y.qq.com/n/yqq/toplist.html?topid=26', 'qq', 'playlist', 'top:26'],
  ];
  for (const [url, source, kind, id] of matrix) {
    assert.deepEqual(parseMusicInput(url, { source: source === 'qq' ? 'netease' : 'qq', kind: 'playlist' }),
      { source, kind, id, input: id, isLink: true }, url);
  }
});

test('share text extracts one complete link and discards surrounding text and tracking fields', () => {
  const result = parseMusicInput('分享陈奕迅的单曲《十年》 https://music.163.com/#/song?id=123&userid=private-share-token。 （来自网易云音乐）', { source: 'qq' });
  assert.equal(result.source, 'netease'); assert.equal(result.input, '123');
  assert.ok(!JSON.stringify(result).includes('private-share-token'));
  assert.equal(parseMusicInput('分享歌单：https://y.qq.com/playlist/456，').id, '456');
  assert.equal(parseMusicInput('分享歌单：https://y.qq.com/playlist/456，快来听听').id, '456');
  assert.equal(parseMusicInput('「https://y.qq.com/playlist/456」').id, '456');
  assert.throws(() => parseMusicInput('https://music.163.com/song?id=1 https://y.qq.com/playlist/2'), /一次/);
  assert.throws(() => parseMusicInput('https://music.163.com/song?id=1，https://y.qq.com/playlist/2'), /一次/);
});

test('plain IDs use the selected platform, playlist hint and keywords remain distinguishable', () => {
  for (const source of ['netease', 'qq']) {
    assert.deepEqual(parseMusicInput('123', { source }), { source, kind: 'song', id: '123', input: '123', isLink: false });
    assert.equal(parseMusicInput('123', { source, kind: 'playlist' }).kind, 'playlist');
    assert.deepEqual(parseMusicInput('葡萄成熟时', { source }), { source, kind: 'search', query: '葡萄成熟时', input: '葡萄成熟时', isLink: false });
  }
  assert.equal(parseMusicInput('0039MnYb0qxYhV', { source: 'qq' }).kind, 'song');
  assert.equal(parseMusicInput('ACG: Piano Memories').kind, 'search');
  assert.equal(parseMusicInput('top:26', { source: 'qq' }).kind, 'playlist');
  assert.equal(parseMusicInput('top:26', { source: 'qq', kind: 'playlist' }).id, 'top:26');
  assert.throws(() => parseMusicInput('top:26', { source: 'netease' }), UserError);
  assert.throws(() => parseMusicInput('hello', { kind: 'playlist' }), /歌单 ID/);
  assert.throws(() => parseMusicInput('0'), /ID 无效/);
  assert.throws(() => parseMusicInput('1234567890123456789'), /ID 无效/);
});

test('only exact official hosts, HTTP links, ordinary ports and recognized route boundaries are accepted', () => {
  const invalid = [
    'https://127.0.0.1/song?id=1', 'https://[::1]/song?id=1', 'https://music.163.com.evil.invalid/song?id=1',
    'https://evil-music.163.com/song?id=1', 'https://y.qq.com.evil.invalid/song?songid=1',
    'https://user:secret@music.163.com/song?id=1', 'https://music.163.com:8787/song?id=1',
    'ftp://music.163.com/song?id=1', 'file:///song?id=1', 'https://music.163.com\\@example.org/song?id=1',
    'https://music.163.com/redirect/song?id=1', 'https://music.163.com/playlist/song?id=1',
    'https://music.163.com/redirect#/song?id=1', 'https://music.163.com/#//example.org/song?id=1',
    'https://y.qq.com/redirect-song?songid=1', 'https://y.qq.com/arbitrary/song/123',
    'https://y.qq.com/n/ryqq_v20/playlist/123', 'https://y.qq.com/n/unrecognized/songDetail/0039MnYb0qxYhV',
    'https://y.qq.com/notplaylist?id=1', 'https://y.qq.com/playlist/123/redirect',
    'https://y.qq.com/playlist?id=0', 'https://music.163.com/song?id=1234567890123456789',
    'https://y.qq.com/song?songid=12345678901234567890', 'https://y.qq.com/toplist/1234567',
    'https://y.qq.com/song?songmid=abc', 'https://music.163.com/song', 'https://%',
    'music.163.com/song?id=1', 'javascript:alert(1)', '//y.qq.com/song?songid=1',
  ];
  for (const input of invalid) assert.throws(() => parseMusicInput(input), UserError, input);
});

test('conflicting or invalid path/query IDs cannot be silently interpreted', () => {
  for (const input of [
    'https://music.163.com/song?id=1&id=2', 'https://music.163.com/song?id=1&id=',
    'https://music.163.com/?id=2#/song?id=1', 'https://y.qq.com/song/123?songid=456',
    'https://y.qq.com/song?songid=123&songmid=0039MnYb0qxYhV',
    'https://y.qq.com/song?songid=123&disstid=456', 'https://y.qq.com/playlist/123?id=456',
    'https://y.qq.com/playlist?id=123&disstid=456', 'https://y.qq.com/toplist/26?topid=27',
  ]) assert.throws(() => parseMusicInput(input), UserError, input);
  assert.equal(parseMusicInput('https://y.qq.com/playlist/123?id=123').id, '123');
});

test('short links are explicitly rejected without fetching redirects; host configuration can narrow the allowlist', () => {
  for (const url of ['https://163cn.tv/a1B2', 'https://c3.y.qq.com/base/fcgi-bin/u?__=abc', 'https://c5.y.qq.com/base/fcgi-bin/u?__=abc', 'https://c6.y.qq.com/base/fcgi-bin/u?__=abc', 'https://y.qq.com/base/fcgi-bin/u?__=abc']) {
    assert.throws(() => parseMusicInput(url), /短链接/);
  }
  assert.throws(() => parseMusicInput('https://y.qq.com/playlist/1', { hosts: { netease: MUSIC_LINK_HOSTS.netease, qq: [] } }), UserError);
  assert.throws(() => parseMusicInput('https://localhost/song?id=1', { hosts: { netease: ['localhost'], qq: [] } }), UserError);
  assert.throws(() => parseMusicInput('x'.repeat(2001)), /2000/);
  assert.throws(() => parseMusicInput('x'.repeat(201)), /200/);
  assert.throws(() => parseMusicInput('hello', { source: 'invalid' }), UserError);
  assert.throws(() => parseMusicInput('hello', { kind: 'invalid' }), UserError);
});
