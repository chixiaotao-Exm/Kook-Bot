import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaServer } from '../src/server.js';
import { KeyUsageError } from '../src/key-usage.js';

const KEY_A = 'sk-private_test_preset_alpha_1234';
const KEY_B = 'sk-private_test_preset_beta_5678';
const CUSTOM = 'sk-private_test_custom_9012';
async function fixture(t, { publicAccess = true, query } = {}) {
  const calls = [];
  const web = new QuotaServer({ port: 0, publicUrl: 'http://127.0.0.1/quota/', sub2apiUrl: 'http://127.0.0.1:8080', publicAccess,
    dashboard: { snapshot: () => ({ accounts: [] }) }, scheduler: { snapshot: () => ({ available: true, history: [], enabled: true }) },
    keyPresets: [{ id: 'yeluogpt', label: '叶落GPT', key: KEY_A }, { id: 'exiaomenggpt', label: '恶小梦GPT', key: KEY_B }],
    keyUsage: { async query(key) { calls.push(key); if (query) return query(key); return { keyHint: `sk-…${key.slice(-4)}`, totals: { requests: key === KEY_A ? 11 : 22 } }; } },
  });
  const address = await web.start(), base = `http://127.0.0.1:${address.port}`;
  t.after(() => web.close());
  async function request(route, body, headers = {}, prefix = '/quota/api') {
    const response = await fetch(base + prefix + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    for (const key of [KEY_A, KEY_B, CUSTOM]) assert.equal(text.includes(key), false, 'HTTP response must not expose a complete key');
    return { response, body: JSON.parse(text) };
  }
  return { request, calls, web, base };
}

test('anonymous visitors can list symbolic presets and query each key in isolation', async t => {
  const f = await fixture(t);
  const presets = await f.request('/key-presets');
  assert.equal(presets.response.status, 200);
  assert.deepEqual(presets.body, { presets: [{ id: 'yeluogpt', label: '叶落GPT' }, { id: 'exiaomenggpt', label: '恶小梦GPT' }] });
  const first = await f.request('/key-usage', { presetId: 'yeluogpt' });
  assert.equal(first.body.label, '叶落GPT'); assert.equal(first.body.totals.requests, 11);
  assert.equal(first.response.headers.get('cache-control'), 'no-store');
  const second = await f.request('/key-usage', { presetId: 'exiaomenggpt' });
  assert.equal(second.body.label, '恶小梦GPT'); assert.equal(second.body.keyHint, 'sk-…5678');
  const custom = await f.request('/key-usage', { key: ` ${CUSTOM} ` }, {}, '/api');
  assert.equal(custom.body.keyHint, 'sk-…9012'); assert.equal(Object.hasOwn(custom.body, 'label'), false);
  assert.deepEqual(f.calls, [KEY_A, KEY_B, CUSTOM]);
  assert.equal((await f.request('/report-config', { enabled: false })).response.status, 401);
  const session = await f.request('/session');
  assert.equal(session.body.canManage, false); assert.equal(session.body.authenticated, false);
});

test('key selectors, origin and URL parameters cannot redirect queries or obtain preset secrets', async t => {
  const f = await fixture(t);
  for (const body of [{}, { key: CUSTOM, presetId: 'yeluogpt' }, { presetId: '__proto__' }, { presetId: 0 },
    { key: CUSTOM, url: 'https://other.invalid' }, { key: CUSTOM, canManage: true }, { key: 'sk-short' }, { key: null }]) {
    assert.equal((await f.request('/key-usage', body)).response.status, 400);
  }
  assert.equal((await f.request('/key-usage?key=test', { key: CUSTOM })).response.status, 400);
  assert.equal((await f.request('/key-presets?reveal=true')).response.status, 400);
  assert.equal((await f.request('/key-usage')).response.status, 405);
  assert.equal((await f.request('/key-usage', { key: CUSTOM }, { Origin: 'https://other.invalid' })).response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('key failures are sanitized and concurrency errors carry Retry-After', async t => {
  let fail = new KeyUsageError('AUTH', 'API Key 无效、已停用或无查询权限。', 401);
  const f = await fixture(t, { query: () => { throw fail; } });
  let result = await f.request('/key-usage', { key: CUSTOM });
  assert.equal(result.response.status, 401); assert.equal(result.body.error.code, 'AUTH');
  fail = new Error(CUSTOM);
  result = await f.request('/key-usage', { key: CUSTOM });
  assert.equal(result.response.status, 500); assert.equal(typeof result.body.error, 'string');
  fail = new KeyUsageError('BUSY', '查询繁忙，请稍后重试。', 429);
  result = await f.request('/key-usage', { key: CUSTOM });
  assert.equal(result.response.status, 429); assert.equal(result.response.headers.get('retry-after'), '2');
});

test('private dashboard mode still requires administrator login for usage and presets', async t => {
  const f = await fixture(t, { publicAccess: false });
  assert.equal((await f.request('/key-presets')).response.status, 401);
  assert.equal((await f.request('/key-usage', { presetId: 'yeluogpt' })).response.status, 401);
  assert.equal(f.calls.length, 0);
});

test('query rate bound prevents a burst from reaching upstream', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 120; index++) assert.equal((await f.request('/key-usage', { key: CUSTOM })).response.status, 200);
  const result = await f.request('/key-usage', { key: CUSTOM });
  assert.equal(result.response.status, 429); assert.equal(result.body.error.code, 'BUSY');
  assert.equal(f.calls.length, 120);
});
