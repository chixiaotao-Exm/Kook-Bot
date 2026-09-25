import { createHash } from 'node:crypto';

const DEFAULT_REPOSITORY = 'chixiaotao-Exm/Kook-Bot';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const THEMES = new Set(['info', 'success', 'warning', 'danger', 'secondary']);
const PR_ACTIONS = new Set(['opened', 'reopened', 'closed', 'ready_for_review']);
const RESULTS = Object.freeze({ success: ['通过', 'success'], failure: ['失败', 'danger'], neutral: ['中性', 'secondary'],
  cancelled: ['已取消', 'warning'], skipped: ['已跳过', 'secondary'], timed_out: ['超时', 'danger'],
  action_required: ['需人工处理', 'warning'], startup_failure: ['启动失败', 'danger'], stale: ['已过期', 'warning'] });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, limit) => value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '').trim();
const repositoryName = value => typeof value === 'string' && value.length <= 201
  && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
  && !['.', '..'].includes(value.split('/')[1]) ? value : null;
const identifier = value => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  return /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : null;
};
const revision = value => typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : null;
const zero = value => /^0+$/.test(value);
const refName = value => typeof value === 'string' && value.length > 0 && value.length <= 250
  && !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('//')
  && !value.includes('@{') && !/[/.]$/.test(value) ? value : null;
const eventTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function safeText(value, limit = 500) {
  if (typeof value !== 'string') return '';
  return bounded(value.toWellFormed()
    .replace(/\((met|rol|chn)\)[\s\S]*?\(\1\)/gi, '[提及已省略]')
    .replace(/<@!?[^>]*>|<@&[^>]*>/g, '[提及已省略]')
    .replace(/@(?:all|here|everyone)\b/gi, '[群体提及已省略]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,}/g, '[密钥已隐藏]')
    .replace(/\b(?:sk-|admin-)[A-Za-z0-9_-]{8,}|\b\d{1,4}\/[A-Za-z0-9+/=]{4,}\/[A-Za-z0-9+/=]{8,}/g, '[密钥已隐藏]')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[密钥已隐藏]')
    .replace(/\b(password|passwd|pwd|token|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[已隐藏]')
    .replace(/\bpassword\s+(?:is\s+)?[^\s,;]+/gi, 'password [已隐藏]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>]+/g, '[链接已隐藏]')
    .replace(/[^\s<>()[\]{}"'@]+@[^\s<>()[\]{}"'@]+/g, '[邮箱已隐藏]')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' '), limit);
}
const firstLine = value => typeof value === 'string' ? value.split(/[\r\n\u2028\u2029]/, 1)[0] : '';
const keyFor = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function safeUrl(url, repository) {
  if (typeof url !== 'string' || url.length > 500) return false;
  const base = `https://github.com/${repository}`;
  if (url === base) return true;
  if (!url.startsWith(`${base}/`)) return false;
  return /^(?:pull\/[1-9]\d{0,19}|commit\/(?:[a-f0-9]{40}|[a-f0-9]{64})|compare\/(?:[a-f0-9]{40}|[a-f0-9]{64})\.\.\.(?:[a-f0-9]{40}|[a-f0-9]{64})|actions\/runs\/[1-9]\d{0,19})$/.test(url.slice(base.length + 1));
}

/** Validate restored queue entries as strictly as newly normalized notifications. */
export function validNotification(value, repository = DEFAULT_REPOSITORY) {
  if (!repositoryName(repository) || !object(value) || Object.keys(value).sort().join(',') !== 'key,kind,lines,theme,title,url'
    || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || !['push', 'pr', 'ci'].includes(value.kind)
    || !THEMES.has(value.theme) || !safeUrl(value.url, repository) || typeof value.title !== 'string'
    || !value.title || value.title.length > 100 || !value.title.isWellFormed() || safeText(value.title, 100) !== value.title
    || !Array.isArray(value.lines) || value.lines.length > 8) return false;
  return value.lines.every(line => typeof line === 'string' && line.length > 0 && line.length <= 500
    && line.isWellFormed() && safeText(line) === line);
}

/** Only fixed repository metadata is used; bodies, diffs, logs and supplied links are never forwarded. */
export function normalizeGithubEvent(eventName, payload, { repository = DEFAULT_REPOSITORY, deliveryId } = {}) {
  if (!repositoryName(repository) || !object(payload) || !object(payload.repository)
    || typeof payload.repository.full_name !== 'string' || payload.repository.full_name.toLowerCase() !== repository.toLowerCase()) return null;
  const base = `https://github.com/${repository}`, repoKey = repository.toLowerCase();
  const actor = safeText(payload.sender?.login, 100);
  let notification;
  if (eventName === 'push') {
    if (typeof payload.ref !== 'string' || !payload.ref.startsWith('refs/heads/') || typeof payload.deleted !== 'boolean') return null;
    const branch = refName(payload.ref.slice(11)), before = revision(payload.before), after = revision(payload.after);
    if (!branch || !before || !after || before.length !== after.length || !payload.deleted && zero(after)) return null;
    const commits = payload.commits ?? (payload.deleted ? [] : null);
    if (!Array.isArray(commits) || commits.length > 2048) return null;
    const size = payload.size === undefined ? commits.length : payload.size;
    if (!Number.isSafeInteger(size) || size < commits.length || size < 0) return null;
    const lines = [`分支：${safeText(branch, 250)}`, payload.deleted ? '该分支已删除。' : `提交：${size} 项`];
    if (actor) lines.push(`操作者：${actor}`);
    for (const commit of payload.deleted ? [] : commits.slice(0, 3)) {
      if (!object(commit) || !revision(commit.id) || typeof commit.message !== 'string') return null;
      const summary = safeText(firstLine(commit.message), 330) || '（无摘要）';
      const author = safeText(commit.author?.name || commit.author?.username, 80);
      lines.push(`${commit.id.slice(0, 8).toLowerCase()} ${summary}${author ? ` · ${author}` : ''}`);
    }
    notification = { key: keyFor(['push', repoKey, payload.ref, before, after, payload.deleted]), kind: 'push',
      title: safeText(`${payload.deleted ? '分支已删除' : '代码推送'}：${branch}`, 100), lines,
      theme: payload.deleted ? 'warning' : 'info', url: payload.deleted ? base : zero(before) ? `${base}/commit/${after}` : `${base}/compare/${before}...${after}` };
  } else if (eventName === 'pull_request') {
    if (!PR_ACTIONS.has(payload.action) || !object(payload.pull_request)) return null;
    const pr = payload.pull_request, number = identifier(pr.number ?? payload.number);
    if (!number || payload.number !== undefined && identifier(payload.number) !== number || typeof pr.title !== 'string'
      || pr.title.length > 10000 || payload.action === 'closed' && typeof pr.merged !== 'boolean'
      || pr.merged !== undefined && typeof pr.merged !== 'boolean' || !refName(pr.head?.ref) || !refName(pr.base?.ref)
      || pr.base?.repo?.full_name !== undefined && String(pr.base.repo.full_name).toLowerCase() !== repoKey) return null;
    const updated = eventTime(pr.updated_at), delivery = typeof deliveryId === 'string' && /^[a-f0-9-]{16,100}$/i.test(deliveryId) ? deliveryId : null;
    if (!updated && !delivery) return null;
    const merged = payload.action === 'closed' && pr.merged === true;
    const action = merged ? '已合并' : { opened: '新建', reopened: '重新打开', closed: '已关闭', ready_for_review: '等待审阅' }[payload.action];
    const title = safeText(firstLine(pr.title), 350) || '（无标题）';
    const lines = [title, `分支：${safeText(pr.head.ref, 220)} → ${safeText(pr.base.ref, 220)}`];
    if (actor) lines.push(`操作者：${actor}`);
    notification = { key: keyFor(['pr', repoKey, number, payload.action, merged, updated || delivery]), kind: 'pr',
      title: safeText(`PR #${number} · ${action}`, 100), lines, theme: merged ? 'success' : payload.action === 'closed' ? 'secondary' : 'info', url: `${base}/pull/${number}` };
  } else if (eventName === 'workflow_run') {
    const run = payload.workflow_run;
    if (payload.action !== 'completed' || !object(run) || run.status !== 'completed'
      || typeof run.conclusion !== 'string' || !Object.hasOwn(RESULTS, run.conclusion)) return null;
    const workflowId = identifier(run.workflow_id), runId = identifier(run.id), attempt = identifier(run.run_attempt), sha = revision(run.head_sha);
    if (!workflowId || !runId || !attempt || !sha || zero(sha) || typeof run.name !== 'string' || !run.name.trim()
      || run.name.length > 10000 || run.head_branch != null && !refName(run.head_branch)) return null;
    const [result, theme] = RESULTS[run.conclusion];
    notification = { key: keyFor(['ci', repoKey, runId, attempt]), kind: 'ci',
      title: safeText(`${safeText(run.name, 70)} · ${result}`, 100),
      lines: [`分支：${run.head_branch ? safeText(run.head_branch, 250) : '未提供'}`, `提交：${sha.slice(0, 8)}`, `运行次数：${attempt}`],
      theme, url: `${base}/actions/runs/${runId}` };
  } else return null;
  return validNotification(notification, repository) ? notification : null;
}
