/** A batch's individual results remain authoritative, including mixed outcomes. */
export function batchKind(results) {
  if (results.some(item => item.kind === 'pending')) return 'pending';
  if (results.every(item => item.kind === 'success')) return 'success';
  if (results.every(item => item.kind === 'not_sent')) return 'not_sent';
  if (results.some(item => item.kind === 'unknown')) return 'unknown';
  if (results.some(item => item.kind === 'verification')) return 'verification';
  return 'unknown';
}

export function batchSummary(record) {
  const counts = { success: 0, not_sent: 0, verification: 0, unknown: 0, pending: 0 };
  for (const result of record.results) counts[result.kind]++;
  const received = record.results.filter(item => item.mail).length;
  return `本次账号数：${record.results.length}，每个账号最多提交一次。\n`
    + `成功 ${counts.success} · 未发送 ${counts.not_sent} · 需验证 ${counts.verification} · 结果未知 ${counts.unknown}`
    + (counts.pending ? ` · 处理中 ${counts.pending}` : '')
    + (received ? `\n邮箱已确认 ${received} 次。` : '')
    + '\n成功表示官方已接收请求，不代表已判定违规或封禁。';
}

export const reportEntries = record => record.results || [record];
