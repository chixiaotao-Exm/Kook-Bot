import { mkdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHANNEL_ID, draftContent, normalizeNickname, validId, validMessageId, validDraftId, RESULT_MESSAGES } from './domain.js';
import { batchKind } from './report-results.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('Invalid state file structure; startup stopped to prevent duplicate submissions.'); };
const map = () => Object.create(null);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Only this exact historical template is eligible for migration. Never submit
// translated content using a confirmation card that showed the old wording.
function legacyDraftContent(player) {
  return {
    subject: `请求核查玩家 ${player} 的游戏行为`,
    description: `PUBG 客服团队您好：\n\n我希望请求核查以下玩家是否存在违规行为。\n被举报玩家昵称：${player}\n游戏平台：Steam PC\n\n请根据可用的对局记录及反作弊检测信息核实，并依据核查结果处理。本次举报不预先断定对方存在作弊行为。\n\n本次仅提供玩家昵称，未提供具体对局时间或作弊证据。如需补充资料，请通过我的联系邮箱告知。\n\n谢谢。`
  };
}

function restoreReceipt(input, output) {
  if (input.mailRef !== undefined) {
    if (typeof input.mailRef !== 'string' || !/^KOOK-[a-f0-9]{32}$/.test(input.mailRef)) fail();
    output.mailRef = input.mailRef;
  }
  if (input.mail !== undefined) {
    const mail = input.mail;
    if (!record(mail) || output.kind !== 'success' || typeof mail.messageId !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(mail.messageId)
      || typeof mail.ticketId !== 'string' || !/^\d{3,20}$/.test(mail.ticketId) || !timestamp(mail.receivedAt)
      || !['pending', 'attempted'].includes(mail.notification)) fail();
    output.mail = { messageId: mail.messageId, ticketId: mail.ticketId, receivedAt: mail.receivedAt, notification: mail.notification };
  }
}

function entries(value) {
  if (!record(value)) fail();
  return Object.entries(value);
}

/** Rebuild only known fields into null-prototype maps; disk data cannot supply prototypes or payloads. */
export function validateStore(value) {
  if (!record(value) || (value.version !== undefined && ![1, 2].includes(value.version))) fail();
  const data = { version: 2, seen: map(), drafts: map(), reports: map(), attempts: [], previews: [],
    rate: { globalAt: null, users: map() } };
  for (const [id, at] of entries(value.seen)) {
    if (!validMessageId(id) || !timestamp(at)) fail();
    data.seen[id] = at;
  }
  for (const [id, input] of entries(value.drafts)) {
    if (!validDraftId(id) || !record(input) || !validId(input.author)
      || (input.expires !== null && !timestamp(input.expires))
      || (input.channelId !== undefined && input.channelId !== CHANNEL_ID)
      || (input.guildId !== undefined && input.guildId !== null && !validId(input.guildId))
      || (input.cardId !== undefined && !validMessageId(input.cardId))
      || (input.editing !== undefined && typeof input.editing !== 'boolean')) fail();
    let player;
    try { player = normalizeNickname(input.player); } catch { fail(); }
    if (player !== input.player) fail();
    if (typeof input.raw !== 'string' || input.raw.length > 150 || /[\u0000-\u001f\u007f]/.test(input.raw)) fail();
    const content = draftContent(player);
    const legacy = legacyDraftContent(player);
    const isLegacy = input.subject === legacy.subject && input.description === legacy.description;
    if (!isLegacy && (input.subject !== content.subject || input.description !== content.description)) fail();
    const hasReporterSnapshot = input.reporterSnapshot !== undefined || input.reporterCount !== undefined;
    if (hasReporterSnapshot && (!hash(input.reporterSnapshot) || !Number.isSafeInteger(input.reporterCount) || input.reporterCount < 1)) fail();
    // Validate every field before discarding an old preview. Reports and attempt
    // history below are retained, so migration cannot re-enable prior attempts.
    if (isLegacy) continue;
    data.drafts[id] = { player, raw: input.raw, author: input.author, channelId: CHANNEL_ID,
      // Migrate old deadlines: saved previews remain actionable until handled or cancelled.
      guildId: input.guildId ?? null, expires: null, ...content,
      ...(input.cardId === undefined ? {} : { cardId: input.cardId }), editing: input.editing === true };
    if (hasReporterSnapshot) {
      Object.assign(data.drafts[id], { reporterSnapshot: input.reporterSnapshot, reporterCount: input.reporterCount });
    }
  }
  for (const [key, input] of entries(value.reports)) {
    if (!/^[a-z0-9_-]{3,32}$/.test(key) || !record(input) || !timestamp(input.at)
      || !Object.hasOwn(RESULT_MESSAGES, input.kind) || (input.author !== undefined && !validId(input.author))) fail();
    if (input.results !== undefined || input.batchId !== undefined || input.finished !== undefined) {
      if (!validDraftId(input.batchId) || typeof input.finished !== 'boolean' || !validId(input.author)
        || !Array.isArray(input.results) || !input.results.length) fail();
      let player; try { player = normalizeNickname(input.player); } catch { fail(); }
      if (player !== input.player || player.toLowerCase() !== key) fail();
      const ids = new Set();
      const results = input.results.map(item => {
        if (!record(item) || !hash(item.reporterId) || !hash(item.mailboxHash) || ids.has(item.reporterId)
          || !timestamp(item.at) || !Object.hasOwn(RESULT_MESSAGES, item.kind)) fail();
        ids.add(item.reporterId);
        const kind = item.kind === 'pending' ? 'unknown' : item.kind;
        const result = { reporterId: item.reporterId, mailboxHash: item.mailboxHash, at: item.at, kind, message: RESULT_MESSAGES[kind] };
        restoreReceipt(item, result);
        return result;
      });
      const kind = batchKind(results);
      // A restarted batch is terminal: pending attempts become unknown, unstarted accounts remain not sent.
      data.reports[key] = { at: input.at, author: input.author, player, batchId: input.batchId,
        finished: true, kind, message: RESULT_MESSAGES[kind], results };
      continue;
    }
    const kind = input.kind === 'pending' ? 'unknown' : input.kind;
    data.reports[key] = { at: input.at, kind, message: RESULT_MESSAGES[kind],
      ...(input.author === undefined ? {} : { author: input.author }) };
    if (input.player !== undefined) {
      let player; try { player = normalizeNickname(input.player); } catch { fail(); }
      if (player !== input.player || player.toLowerCase() !== key) fail();
      data.reports[key].player = player;
    }
    restoreReceipt(input, data.reports[key]);
  }
  // Older snapshots had no attempt ledger. Reconstruct recent submission history.
  const attempts = value.attempts ?? Object.values(data.reports).map(item => ({ at: item.at, author: item.author ?? null }));
  if (!Array.isArray(attempts)) fail();
  for (const item of attempts) {
    if (!record(item) || !timestamp(item.at) || (item.author !== null && !validId(item.author))) fail();
    data.attempts.push({ at: item.at, author: item.author });
  }
  const previews = value.previews ?? [];
  if (!Array.isArray(previews) || !previews.every(timestamp)) fail();
  data.previews = [...previews];
  if (value.rate !== undefined) {
    if (!record(value.rate) || (value.rate.globalAt !== null && !timestamp(value.rate.globalAt))) fail();
    data.rate.globalAt = value.rate.globalAt;
    for (const [id, at] of entries(value.rate.users)) {
      if (!validId(id) || !timestamp(at)) fail();
      data.rate.users[id] = at;
    }
  }
  return data;
}

/** Atomic snapshots are fsynced before acknowledgement. An uncertain write permanently fails closed. */
export async function openStore(path) {
  let value;
  try {
    const info = await stat(path);
    if (!info.isFile()) fail();
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('State file is corrupt or unreadable; startup stopped to prevent duplicate submissions.');
    value = { seen: {}, drafts: {}, reports: {} };
  }
  const data = validateStore(value);
  let tail = Promise.resolve(), failed = false;
  return {
    data,
    save() {
      // Capture before queuing: later mutations must not change the meaning of this durability barrier.
      let content;
      try {
        // Validate without replacing live state: pending must remain pending until the submitter returns.
        validateStore(data);
        content = JSON.stringify(data);
      } catch {
        failed = true;
        return Promise.reject(new Error('Failed to save state; no new tasks will be accepted.'));
      }
      const task = tail.then(async () => {
        if (failed) throw new Error('Failed to save state; no new tasks will be accepted.');
        const temporary = `${path}.${randomUUID()}.tmp`;
        let file;
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          file = await open(temporary, 'wx', 0o600);
          await file.writeFile(content); await file.sync(); await file.close(); file = null;
          await rename(temporary, path);
          // Linux deployment requires rename durability too. Windows cannot open directories this way.
          if (process.platform !== 'win32') {
            const directory = await open(dirname(path), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } catch {
          failed = true;
          throw new Error('Failed to save state; no new tasks will be accepted.');
        } finally {
          await file?.close().catch(() => {});
          await unlink(temporary).catch(() => {});
        }
      });
      tail = task.catch(() => {});
      return task;
    }
  };
}
