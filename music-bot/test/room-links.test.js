import test from 'node:test';
import assert from 'node:assert/strict';
import { musicRoomLink } from '../frontend/room-links.js';
import { parseMusicInput } from '../src/music-input.js';

test('catalog handoffs retain song, playlist and chart identity through the room link parser', () => {
  for (const [source, kind, input] of [
    ['netease', 'playlist', '123'], ['qq', 'playlist', '123'], ['qq', 'playlist', 'top:26'],
    ['netease', 'song', '123'], ['qq', 'song', '123'], ['qq', 'song', '0039MnYb0qxYhV'],
  ]) {
    const target = new URL(musicRoomLink({ origin: 'https://console.example', botId: 'second', input, source, kind }));
    assert.equal(target.origin, 'https://console.example'); assert.equal(target.pathname, '/room/second');
    const query = target.searchParams.get('q');
    assert.match(query, /^https:\/\//, 'Room preview must recognize the handoff as a link rather than a keyword');
    const parsed = parseMusicInput(query, { source: target.searchParams.get('source') });
    assert.deepEqual([parsed.source, parsed.kind, parsed.id], [source, kind, input]);
  }
});

test('room links preserve existing shared links and plain room navigation', () => {
  const input = 'https://y.qq.com/n/ryqq/playlist/123';
  const target = new URL(musicRoomLink({ origin: 'https://console.example', botId: 'default', input, source: 'netease' }));
  assert.equal(target.searchParams.get('q'), input);
  assert.equal(parseMusicInput(target.searchParams.get('q'), { source: 'netease' }).kind, 'playlist');
  assert.equal(musicRoomLink({ origin: 'https://console.example', botId: 'default' }), 'https://console.example/room/default');
});
