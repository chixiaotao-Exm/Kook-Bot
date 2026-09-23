import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseMusicInputAsync, resolveShortLink, publicAddress, requestPinned } from '../src/short-links.js';

function fixture(responses, extra = {}) {
  const calls = [];
  return { calls, options: { lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }],
    requestImpl: async (url, options) => { calls.push({ url: url.href, ...options }); return responses[calls.length - 1]; }, ...extra } };
}

test('share resolver follows official relative redirects and overrides source/kind from the final URL', async () => {
  const { calls, options } = fixture([
    { status: 302, headers: { location: '/another' } },
    { status: 302, headers: { location: 'https://music.163.com/#/playlist?id=123&userid=private' } },
  ]);
  const result = await parseMusicInputAsync('分享歌单 https://163cn.tv/sample。', { source: 'qq', kind: 'song' }, options);
  assert.deepEqual(result, { source: 'netease', kind: 'playlist', id: '123', input: '123', isLink: true, resolvedShortLink: true });
  assert.equal(calls.length, 2); assert.equal(calls[1].url, 'https://163cn.tv/another');
  assert.equal(calls[0].address, '1.1.1.1'); assert.equal(calls[0].family, 4);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('complete links and keywords never cause a short-link network request', async () => {
  const options = { lookupImpl() { throw new Error('must not lookup'); }, requestImpl() { throw new Error('must not fetch'); } };
  assert.equal((await parseMusicInputAsync('https://y.qq.com/playlist/123', {}, options)).id, '123');
  assert.equal((await parseMusicInputAsync('夜曲', { source: 'qq' }, options)).kind, 'search');
  await assert.rejects(parseMusicInputAsync('https://url.cn/unknown', {}, options));
});

test('QQ official HTML redirects support meta refresh and a single explicit canonical URL without script execution', async () => {
  for (const body of ['<meta http-equiv="refresh" content="0;url=https://i.y.qq.com/v8/playsong.html?songid=123&amp;ADTAG=share">',
    '<script>window.location="https:\\/\\/y.qq.com\\/n\\/ryqq\\/playlist\\/456"</script>']) {
    const { options } = fixture([{ status: 200, headers: {}, body }]);
    const result = await parseMusicInputAsync('https://c6.y.qq.com/base/fcgi-bin/u?__=sample', {}, options);
    assert.equal(result.source, 'qq'); assert.ok(['123', '456'].includes(result.id));
  }
  const { options } = fixture([{ status: 200, body: '<a href="https://y.qq.com/playlist/1">one</a><a href="https://y.qq.com/playlist/2">two</a>' }]);
  await assert.rejects(parseMusicInputAsync('https://c.y.qq.com/base/fcgi-bin/u?__=sample', {}, options));
});

test('untrusted hops, nonstandard ports, credentials and private DNS addresses never reach a socket', async () => {
  const invalid = ['http://127.0.0.1/private', 'http://[::1]/private', 'https://evil.invalid/song/123', 'https://music.163.com.evil.invalid/song?id=123',
    'https://user:password@music.163.com/song?id=123', 'https://music.163.com:8787/song?id=123', 'file:///etc/passwd', 'https://music.163.com\\@evil.invalid/song?id=123'];
  for (const target of invalid) {
    const { options, calls } = fixture([{ status: 302, headers: { location: target } }]);
    await assert.rejects(resolveShortLink('https://163cn.tv/sample', options)); assert.equal(calls.length, 1, target);
  }
  for (const address of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(publicAddress(address), false, address);
    const { options, calls } = fixture([], { lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    await assert.rejects(resolveShortLink('https://163cn.tv/sample', options)); assert.equal(calls.length, 0);
  }
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2001:4860:4860::8888'), true);
  const { options, calls } = fixture([], { lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', options)); assert.equal(calls.length, 0);
});

test('short-link loops, large bodies, ambiguous input and total deadlines fail with bounded requests', async () => {
  const loop = fixture([{ status: 302, headers: { location: 'https://163cn.tv/sample' } }]);
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', loop.options)); assert.equal(loop.calls.length, 1);
  const large = fixture([{ status: 200, body: 'x'.repeat(256 * 1024 + 1) }]);
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', large.options));
  const steps = fixture(Array.from({ length: 8 }, (_, i) => ({ status: 302, headers: { location: '/step' + i } })));
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', steps.options)); assert.equal(steps.calls.length, 6);
  await assert.rejects(resolveShortLink('https://163cn.tv/one https://163cn.tv/two'), /一次/);
  await assert.rejects(resolveShortLink('x'.repeat(2001)), /2000/);
  const slow = fixture([], { timeoutMs: 10, lookupImpl: () => new Promise(() => {}) });
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', slow.options), /超时/);
  const aborted = fixture([], { timeoutMs: 10, requestImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await assert.rejects(resolveShortLink('https://163cn.tv/sample', aborted.options), /超时/);
});

test('HTTP transport pins DNS lookup and never forwards ambient credentials or cookies', async (t) => {
  const original = http.request; let options;
  t.after(() => { http.request = original; });
  http.request = (url, settings, callback) => {
    options = settings; assert.equal(url.hostname, '163cn.tv');
    const request = new EventEmitter(); request.end = () => {
      const response = new PassThrough(); response.statusCode = 302; response.headers = { location: 'https://music.163.com/song?id=1' };
      callback(response); response.end();
    }; return request;
  };
  await requestPinned(new URL('http://163cn.tv/sample'), { address: '8.8.8.8', family: 4 });
  options.lookup('163cn.tv', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  options.lookup('163cn.tv', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
  assert.equal(options.agent, false); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
});
