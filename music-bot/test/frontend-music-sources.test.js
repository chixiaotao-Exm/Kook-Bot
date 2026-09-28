import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSources, normalizeSource, sourceName, sourceDescriptors, sourceSupports } from '../frontend/music-sources.js';
import { createSmartLinks } from '../frontend/smart-links.js';
import { musicRoomLink } from '../frontend/room-links.js';
import { parseMusicInput } from '../src/music-input.js';

test('Qishui stays disabled without server configuration and unsupported account controls remain unavailable', () => {
  assert.equal(normalizeSource('qishui'), 'qishui');
  assert.equal(sourceName('qishui'), '汽水音乐');
  assert.equal(sourceSupports(defaultSources(), 'qishui', 'play'), false);
  assert.equal(sourceSupports(sourceDescriptors([{ id: 'netease', enabled: true }]), 'qishui', 'play'), false);
  const available = sourceDescriptors([{ id: 'qishui', enabled: true, capabilities: { search: true, play: true, lyrics: true, login: false, heart: false, mine: false } }]);
  for (const capability of ['search', 'play', 'lyrics']) assert.equal(sourceSupports(available, 'qishui', capability), true);
  for (const capability of ['login', 'heart', 'mine']) assert.equal(sourceSupports(available, 'qishui', capability), false);
  assert.equal(sourceDescriptors([{ id: 'qishui', enabled: 'true' }]).find((item) => item.id === 'qishui').enabled, false);
});

test('Qishui catalog handoffs preserve 19-digit IDs and playlist/song kind for guest room previews', () => {
  for (const kind of ['song', 'playlist']) {
    const id = '7353812732872132619';
    const target = new URL(musicRoomLink({ origin: 'https://music.example', botId: 'second', source: 'qishui', input: id, kind }));
    assert.equal(target.pathname, '/room/second');
    const parsed = parseMusicInput(target.searchParams.get('q'), { source: target.searchParams.get('source') });
    assert.deepEqual([parsed.source, parsed.kind, parsed.id], ['qishui', kind, id]);
  }
});

test('Qishui smart-link previews can add a playlist without invoking QQ or NetEase login', async () => {
  const events = new Map(), attributes = new Map(), added = [];
  const container = { innerHTML: '', hidden: true, dataset: {}, setAttribute: (key, value) => attributes.set(key, value), addEventListener: (key, value) => events.set(key, value) };
  const input = { value: 'https://music.douyin.com/qishui/share/playlist?playlist_id=7353812732872132619', addEventListener() {} };
  const context = { source: 'netease', jointSearch: false, botId: 'second', botName: '测试机器人', available: true, hasChannel: true, voiceChannelId: 'v1', channelName: '语音', capacity: 5, maxQueue: 500 };
  const links = createSmartLinks({ input, container, getContext: () => context, drawIcons() {}, onShow() {}, onSearch() { assert.fail('A Qishui URL must stay a preview'); }, onLockChange() {}, isLocked: () => false,
    api: async () => ({ source: 'qishui', kind: 'playlist', isLink: true, input: '7353812732872132619', total: 20, playlist: { name: '汽水歌单' }, tracks: [{ name: '歌曲', artists: '歌手' }] }),
    onAccountCheck() { assert.fail('Qishui must not use another provider login'); }, onLogin() { assert.fail('Qishui must not expose a fake QR login'); },
    onAdd: async (record, amount) => { added.push({ record, amount }); return { added: amount }; }, onChannel() { assert.fail('Already has a channel'); },
  });
  links.submit(); await new Promise(setImmediate);
  assert.equal(container.dataset.smartSource, 'qishui');
  assert.match(container.innerHTML, /汽水音乐/);
  assert.match(container.innerHTML, /加入 5 首/);
  events.get('click')({ target: { closest: () => ({ id: 'smart-link-add', disabled: false }) } });
  await new Promise(setImmediate);
  assert.equal(added.length, 1);
  assert.equal(added[0].record.source, 'qishui');
  assert.equal(added[0].record.botId, 'second');
  assert.equal(added[0].record.expectedVoiceChannelId, 'v1');
  assert.equal(added[0].amount, 5);
});

test('Qishui login failures in smart previews never offer a QQ QR login', async () => {
  const container = { innerHTML: '', dataset: {}, setAttribute() {}, addEventListener() {} };
  const input = { value: 'https://music.douyin.com/qishui/share/track?track_id=7353812732872132619', addEventListener() {} };
  const links = createSmartLinks({ input, container, getContext: () => ({ source: 'qq', capacity: 5 }), drawIcons() {}, onShow() {}, onLockChange() {}, isLocked: () => false,
    api: async () => { throw new Error('汽水音乐登录失效'); },
  });
  links.submit(); await new Promise(setImmediate);
  assert.match(container.innerHTML, /汽水音乐登录失效/);
  assert.doesNotMatch(container.innerHTML, /id="smart-link-login"/);
});
