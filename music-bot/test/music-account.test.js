import test from 'node:test';
import assert from 'node:assert/strict';
import { Music } from '../src/music.js';
import { UserError } from '../src/util.js';

test('NetEase account distinguishes absent credentials, rejected session and failed network checks', async () => {
  let cookie = '', calls = 0, response = { body: { code: 200, profile: null } }, failure;
  const music = new Music({}, { async user_account(params) {
    calls++; assert.equal(params.cookie, cookie);
    if (failure) throw failure;
    return response;
  } });
  music.cookie = async () => cookie;

  assert.deepEqual(await music.account(), { loggedIn: false });
  assert.equal(calls, 0, 'No account check is needed before the user signs in');

  cookie = 'private-test-session';
  assert.deepEqual(await music.account(), { loggedIn: false, expired: true });
  assert.equal(calls, 1);

  failure = new Error('private-test-session network failure');
  await assert.rejects(music.account(), (error) => error instanceof UserError && !error.message.includes(cookie));
  failure = null; response = { body: { code: 503 } };
  await assert.rejects(music.account(), UserError, 'An upstream error must not be called an expired login');

  response = { body: { code: 200, profile: { userId: 123, nickname: 'User', avatarUrl: '' } } };
  assert.deepEqual(await music.account(), { loggedIn: true, id: '123', name: 'User', avatar: '' });
});
