import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const declarations = source.slice(source.indexOf('  const escapeHtml ='), source.indexOf('  // Pure display projections'));
const badge = source.match(/^  const badge = .*;$/m)?.[0];
const reportSource = source.slice(source.indexOf('  function reportsHtml('), source.indexOf('  function render()'));
assert.ok(declarations && badge && reportSource);
const context = vm.createContext({ Intl, Date });
vm.runInContext(`${declarations}\n${badge}\n${reportSource}\nglobalThis.reportView = reportsHtml;`, context);
const render = value => context.reportView(value);
const reports = () => ({ enabled: true, intervalMinutes: 30,
  nextRunAt: '2026-09-24T16:30:00.000Z', lastRunAt: '2026-09-24T16:00:00.000Z',
  channels: { infra: { status: 'sent', slotAt: '2026-09-24T16:00:00.000Z', messageId: 'private-message-id' },
    web: { status: 'sent', slotAt: '2026-09-24T16:00:00.000Z' } }, lastError: null });

test('report summary displays the actual next and latest runs in Beijing time for both channels', () => {
  const html = render(reports());
  assert.match(html, /每30分钟自动播报/);
  assert.match(html, /下次播报<\/span><strong>09\/25 00:30 · 北京时间/);
  assert.match(html, /最近播报<\/span><strong>09\/25 00:00 · 北京时间/);
  assert.match(html, /基础设施播报/); assert.match(html, /网站接口播报/);
  assert.equal((html.match(/已送达/g) || []).length, 2);
  assert.doesNotMatch(html, /private-message-id|<button|<input/);
});

test('pending, sending, skipped and uncertain deliveries never appear as successful', () => {
  const labels = { pending: '待播报', sending: '发送中', skipped: '已跳过', uncertain: '送达待确认' };
  for (const [status, label] of Object.entries(labels)) {
    const value = reports(); value.channels.infra.status = value.channels.web.status = status;
    const html = render(value); assert.ok(html.includes(label)); assert.doesNotMatch(html, /已送达/);
    if (status === 'uncertain') assert.match(html, /请核对对应 KOOK 频道/);
  }
});

test('disabled or unavailable schedules do not invent a next run or a successful report', () => {
  const html = render({ enabled: false, nextRunAt: null, lastRunAt: null, channels: {} });
  assert.match(html, /未开启/); assert.match(html, /尚未播报/);
  assert.doesNotMatch(html, /下次播报|已送达|每30分钟/);
  assert.equal(render(undefined), ''); assert.equal(render(null), '');
});

test('untrusted report errors and malformed dates cannot become active markup', () => {
  const value = reports(); value.lastError = '<img src=x onerror="bad()"> & failed';
  value.nextRunAt = '<script>bad()</script>'; value.channels.web.status = '<svg onload=bad()>';
  value.channels.infra.attemptedAt = '\"><img src=x onerror=bad()>';
  const html = render(value);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; failed/);
  assert.doesNotMatch(html, /<img|<script|<svg|private-message-id/);
  assert.match(html, /等待排期/); assert.match(html, /待确认/);
});
