import test from 'node:test';
import assert from 'node:assert/strict';
import { Music } from '../src/music.js';
import { readConfig } from '../src/config.js';
import { UnavailableError } from '../src/util.js';

test('live NetEase search, song detail and stream entitlement response', {
  skip: !process.env.TEST_NETEASE_LIVE, timeout: 60000,
}, async (t) => {
  const music = new Music(readConfig({}, { requireToken: false }));
  await music.init(); t.after(() => music.close());
  const songs = await music.search('陈奕迅', 2);
  assert.ok(songs.length > 0); assert.ok(songs[0].id);
  const track = await music.resolve(songs[0].id);
  assert.equal(track.id, songs[0].id);
  try { assert.ok((await music.stream(track)).startsWith('http')); }
  catch (error) { assert.ok(error instanceof UnavailableError, error.message); }
});
