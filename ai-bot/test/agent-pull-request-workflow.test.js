import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the actual inline workflow script with a mocked GitHub API. No
// candidate checkout, real GitHub write, or report-content evaluation occurs.
const workflow = (await readFile(new URL('../../.github/workflows/agent-pull-request.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = workflow.split('          script: |\n')[1].trimEnd().split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', source);
const jobId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const branch = `kook-agent/task-${jobId}`, directory = `.kook-agent/reports/${jobId}`;
const metadata = { jobId, branch, repository: 'chixiaotao-Exm/Kook-Bot' };

function fixture(files, { existing = false, errors = {} } = {}) {
  const reads = [], writes = [], notices = [];
  const context = { repo: { owner: 'chixiaotao-Exm', repo: 'Kook-Bot' }, ref: `refs/heads/${branch}`, sha: 'a'.repeat(40) };
  const github = { rest: { repos: { getContent: async options => {
    reads.push(options);
    if (errors[options.path]) throw Object.assign(new Error('API error'), { status: errors[options.path] });
    if (!Object.hasOwn(files, options.path)) throw Object.assign(new Error('Missing'), { status: 404 });
    return { data: { encoding: 'base64', content: Buffer.from(files[options.path]).toString('base64') } };
  } }, pulls: { list: async () => ({ data: existing ? [{ number: 1 }] : [] }), create: async options => {
    writes.push(options); return { data: { html_url: 'https://github.com/chixiaotao-Exm/Kook-Bot/pull/42' } };
  } } } };
  return { context, reads, writes, notices, run: () => execute(github, context, { notice: url => notices.push(url) }) };
}

test('opens a draft from the current task archive without reading an unrelated legacy report', async () => {
  const f = fixture({ [`${directory}/report.json`]: JSON.stringify(metadata), [`${directory}/report.md`]: '当前任务的报告',
    '.kook-agent/report.json': JSON.stringify({ ...metadata, jobId: 'another-job' }) });
  await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].draft, true);
  assert.equal(f.writes[0].body, '当前任务的报告'); assert.equal(f.writes[0].head, branch);
  assert.deepEqual(f.reads.map(item => item.path), [`${directory}/report.json`, `${directory}/report.md`]);
  assert.ok(f.reads.every(item => item.ref === f.context.sha));
});

test('legacy publishers still open drafts when metadata belongs to this exact task', async () => {
  const f = fixture({ '.kook-agent/report.json': JSON.stringify(metadata), '.kook-agent/report.md': 'legacy body' });
  await f.run(); assert.equal(f.writes[0].body, 'legacy body');
});

test('full Unicode review metadata fits while the PR body keeps its smaller independent limit', async () => {
  const full = JSON.stringify({ ...metadata, review: { summary: '😀'.repeat(4000),
    findings: Array.from({ length: 30 }, () => ({ description: '😀'.repeat(1600), solution: '😀'.repeat(1600) })) } });
  assert.ok(Buffer.from(full).toString('base64').length > 200000);
  const f = fixture({ [`${directory}/report.json`]: full, [`${directory}/report.md`]: 'bounded summary' });
  await f.run(); assert.equal(f.writes[0].body, 'bounded summary');
});

test('wrong-task reports and real API failures never fall through to another report', async () => {
  for (const prefix of [directory, '.kook-agent']) {
    const f = fixture({ [`${prefix}/report.json`]: JSON.stringify({ ...metadata, jobId: 'wrong-job' }),
      [`${prefix}/report.md`]: 'wrong body' });
    await assert.rejects(f.run(), /does not match/); assert.equal(f.writes.length, 0);
  }
  const f = fixture({ '.kook-agent/report.json': JSON.stringify(metadata), '.kook-agent/report.md': 'legacy' },
    { errors: { [`${directory}/report.json`]: 403 } });
  await assert.rejects(f.run(), error => error.status === 403);
  assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0);
});

test('existing pull requests are left in place without reading reports or creating duplicates', async () => {
  const f = fixture({}, { existing: true }); await f.run();
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('oversized bodies and missing current-task markdown cannot create a misleading PR', async () => {
  const large = fixture({ [`${directory}/report.json`]: JSON.stringify(metadata), [`${directory}/report.md`]: 'x'.repeat(30001) });
  await assert.rejects(large.run(), /oversized/); assert.equal(large.writes.length, 0);
  const missing = fixture({ [`${directory}/report.json`]: JSON.stringify(metadata),
    '.kook-agent/report.json': JSON.stringify(metadata), '.kook-agent/report.md': 'stale' });
  await assert.rejects(missing.run(), error => error.status === 404); assert.equal(missing.writes.length, 0);
});
