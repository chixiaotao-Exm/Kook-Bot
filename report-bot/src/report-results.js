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
  return `Accounts in this batch: ${record.results.length}. Each account submits at most once.\n`
    + `Success ${counts.success} · Not sent ${counts.not_sent} · Verification required ${counts.verification} · Submission attempted ${counts.unknown}`
    + (counts.pending ? ` · Processing ${counts.pending}` : '')
    + (received ? `\nConfirmed by email: ${received}.` : '')
    + (counts.unknown ? '\nSubmission attempted: a complete response was not received. The submission will not be repeated.' : '')
    + '\nSuccess means the request was received by PUBG support. It does not confirm a violation or a ban.';
}

export const reportEntries = record => record.results || [record];
