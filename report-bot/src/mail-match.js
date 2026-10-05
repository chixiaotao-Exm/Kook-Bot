const RECEIPT_WINDOW_MS = 48 * 60 * 60_000;
const REPORT_KINDS = new Set(['pending', 'success', 'unknown', 'verification']);
const NICKNAME = /^[A-Za-z0-9_-]{3,32}$/;
const MAIL_REF = /^KOOK-[a-f0-9]{32}$/;
const MAX_BODY_LENGTH = 256 * 1024;
const DEFAULT_SENDERS = ['support@pubg.com', 'support@pubgsupport.zendesk.com'];

function address(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(normalized) ? normalized : null;
}

function integerTime(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,16}$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function headerDomain(segment, property) {
  const expression = new RegExp(`(?:^|\\s)header\\.${property}\\s*=\\s*"?([^\\s";()]+)"?`, 'ig');
  const values = [...segment.matchAll(expression)].map(match => match[1].toLowerCase());
  // Duplicate properties are ambiguous; do not select the favorable one.
  if (values.length !== 1) return null;
  if (property === 'i') return values[0].includes('@') ? values[0].split('@').at(-1) : null;
  return values[0];
}

function authenticated(values, senderDomain) {
  if (typeof values === 'string') values = [values];
  if (!Array.isArray(values) || values.length > 20) return false;
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 16_384) return false;
    // Permit RFC header folding, but never a second header injected on a new line.
    if (/\r?\n(?![ \t])/.test(value) || /\r(?!\n)/.test(value)) return false;
    const header = value.replace(/\r?\n[ \t]+/g, ' ').trim();
    if (!/^mx\.google\.com(?:\s+\d+)?\s*;/i.test(header)) continue;
    // Gmail prepends its own result. A later claimed Google result cannot override it.
    let depth = 0;
    let clean = '';
    for (let index = 0; index < header.length; index++) {
      const character = header[index];
      if (depth && character === '\\') { index++; continue; }
      if (character === '(') { if (++depth > 10) return false; clean += ' '; }
      else if (character === ')') { if (--depth < 0) return false; }
      else if (!depth) clean += character;
    }
    if (depth) return false;
    return clean.split(';').slice(1).some(segment => {
      const result = segment.trim();
      if (/^dmarc\s*=\s*pass(?:\s|\(|$)/i.test(result)) return headerDomain(result, 'from') === senderDomain;
      if (!/^dkim\s*=\s*pass(?:\s|\(|$)/i.test(result)) return false;
      return headerDomain(result, 'd') === senderDomain || headerDomain(result, 'i') === senderDomain;
    });
  }
  return false;
}

function tokenPresent(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'i').test(text);
}

function referencePresent(text, reference) {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${reference}(?![A-Za-z0-9_-])`).test(text);
}

function unquotedPrefix(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  for (const line of lines) {
    if (/^\s*(?:On .{0,200}wrote:|Begin forwarded message:|-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}|在.{1,200}写道[:：])/i.test(line)) break;
    if (!/^\s*>/.test(line)) result.push(line);
  }
  return result.join('\n').slice(0, 4_000);
}

function receiptInfo(subject, body) {
  const prefix = unquotedPrefix(body);
  // A later resolution/rejection is not a new-ticket receipt, even if it quotes an acknowledgement.
  if (/\b(?:request|ticket|report)\b[^\n.!?]{0,100}\b(?:closed|solved|resolved|rejected|declined|failed|not\s+(?:received|submitted|created))\b/i.test(`${subject}\n${prefix}`)
      || /(?:请求|工单|举报)[^\n。！？]{0,50}(?:已关闭|已解决|已拒绝|提交失败|未收到|未提交|无法受理)/.test(`${subject}\n${prefix}`)) return null;
  const start = '(?:^|[.!?。！？]\\s*|\\n[ \\t]*)';
  const number = '(?:\\s*(?:[（(]\\s*#?(\\d{3,20})\\s*[)）]|#(\\d{3,20})(?!\\d)))?';
  const patterns = [
    new RegExp(`${start}your\\s+(?:request|ticket)${number}\\s+has\\s+been\\s+received\\b`, 'gim'),
    new RegExp(`${start}we\\s+(?:have\\s+)?(?:successfully\\s+)?received\\s+your\\s+(?:request|ticket)${number}(?![A-Za-z])`, 'gim'),
    new RegExp(`${start}(?:我们)?(?:已经|已)?收到(?:了)?(?:您|你)的(?:请求|工单)${number}`, 'gm'),
    new RegExp(`${start}(?:(?:您|你)的)?(?:请求|工单)${number}(?:已经|已)(?:成功)?(?:被)?收到`, 'gm'),
    new RegExp(`${start}我们已经正常接收了您的咨询内容`, 'gm'),
    new RegExp(`${start}我们感谢您的举报，并确保将其转达至适当的团队以进行进一步调查`, 'gm')
  ];
  const matches = patterns.flatMap(pattern => [...prefix.matchAll(pattern)]);
  const tickets = new Set(matches.flatMap(match => match.slice(1).filter(Boolean)));
  for (const match of subject.matchAll(/(?:^|[^A-Za-z0-9_])#\s*(\d{3,20})(?!\d)/g)) tickets.add(match[1]);
  return { acknowledged: matches.length > 0, tickets };
}

function validatedMessage(message, { recipient, allowedSenders, at, now, legacy }) {
  if (!message) return null;
  if (typeof message.id !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(message.id)) return null;
  const receivedAt = integerTime(message.internalDate);
  if (!receivedAt || receivedAt < at - (legacy ? 0 : 60_000) || receivedAt > at + RECEIPT_WINDOW_MS || receivedAt > now + 60_000) return null;
  const sender = address(message.fromAddress);
  if (!sender || !allowedSenders.some(value => address(value) === sender)) return null;
  if (!Array.isArray(message.toAddresses) || !message.toAddresses.some(value => address(value) === recipient)) return null;
  // PUBG's exact hosted address authenticates as Zendesk's organizational domain.
  // This does not authorize other Zendesk addresses or arbitrary parent-domain matches.
  const authenticationDomain = sender === 'support@pubgsupport.zendesk.com' ? 'zendesk.com' : sender.split('@')[1];
  if (!authenticated(message.authenticationResults, authenticationDomain)) return null;
  if (typeof message.subject !== 'string' || message.subject.length > 4_096 || typeof message.bodyText !== 'string' || message.bodyText.length > MAX_BODY_LENGTH) return null;
  const receipt = receiptInfo(message.subject, message.bodyText);
  return receipt ? { ...receipt, message, receivedAt } : null;
}

/** Correlate authenticated acknowledgement/detail emails using a unique official ticket. */
export function matchReceipts(messages, record, { mailbox, allowedSenders = DEFAULT_SENDERS, now = Date.now() } = {}) {
  if (!Array.isArray(messages) || messages.length > 50 || !record || !REPORT_KINDS.has(record.kind) || !NICKNAME.test(record.player ?? '')) return null;
  const at = integerTime(record.at);
  const currentTime = integerTime(now);
  const recipient = address(mailbox);
  const legacy = record.mailRef === undefined || record.mailRef === null;
  if (!at || !currentTime || !recipient || !Array.isArray(allowedSenders) || (!legacy && (typeof record.mailRef !== 'string' || !MAIL_REF.test(record.mailRef)))) return null;
  const trusted = messages.map(message => validatedMessage(message, { recipient, allowedSenders, at, now: currentTime, legacy })).filter(Boolean);
  const correlated = trusted.filter(({ message }) => {
    if (legacy) return tokenPresent(message.subject, record.player);
    const text = `${message.subject}\n${message.bodyText}`;
    return referencePresent(text, record.mailRef) && tokenPresent(text, record.player);
  });
  if (correlated.some(item => item.tickets.size > 1)) return null;
  const tickets = new Set(correlated.flatMap(item => [...item.tickets]));
  if (tickets.size !== 1) return null;
  const [ticketId] = tickets;
  const acknowledgements = trusted.filter(item => item.acknowledged && item.tickets.size === 1 && item.tickets.has(ticketId));
  if (!acknowledgements.length) return null;
  // Prefer the earliest authenticated receipt. A later unrelated reply cannot become the proof.
  const acknowledgement = acknowledgements.sort((a, b) => a.receivedAt - b.receivedAt)[0];
  const detail = correlated.filter(item => item.tickets.has(ticketId)).sort((a, b) => a.receivedAt - b.receivedAt)[0];
  return { messageId: acknowledgement.message.id, ticketId, receivedAt: Math.max(acknowledgement.receivedAt, detail.receivedAt) };
}

/** Match one message when the acknowledgement and correlation are in the same email. */
export function matchReceipt(message, record, options) {
  return matchReceipts([message], record, options);
}
