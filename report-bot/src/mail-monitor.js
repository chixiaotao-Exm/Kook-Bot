import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReceiptMatcher } from './mail-match.js';

const script = fileURLToPath(new URL('../mail/gmail_reader.py', import.meta.url));
const validCursor = value => typeof value === 'string' && /^[1-9]\d{0,19}:[1-9]\d{0,19}$/.test(value);
const validPage = value => value && Array.isArray(value.messages) && value.messages.length <= 50
  && typeof value.truncated === 'boolean' && (value.nextCursor == null || validCursor(value.nextCursor))
  && (value.skipped === undefined || typeof value.skipped === 'boolean');
function advances(previous, next) {
  if (!validCursor(next)) return false;
  if (!previous) return true;
  const [validity, uid] = previous.split(':'), [nextValidity, nextUid] = next.split(':');
  return validity === nextValidity && BigInt(nextUid) < BigInt(uid);
}
export function createGmailReader({ address, password, python = '/usr/bin/python3', spawnImpl = spawn } = {}) {
  if (!/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(address || '') || !/^[a-z]{16}$/i.test((password || '').replace(/\s/g, '')))
    throw Error('Invalid Gmail configuration');
  const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', GMAIL_ADDRESS: address,
    GMAIL_APP_PASSWORD: password.replace(/\s/g, ''), ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  return ({ sinceMs, signal, cursor } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('cancelled')); return; }
    if (cursor != null && !validCursor(cursor)) { reject(Error('mail_invalid_cursor')); return; }
    let child, timer, settled = false, size = 0; const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child?.kill('SIGKILL'); reject(Error(error)); } else resolve(value);
    };
    const abort = () => finish('cancelled');
    try { child = spawnImpl(python, ['-u', script], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { finish('mail_unavailable'); return; }
    timer = setTimeout(() => finish('mail_timeout'), 55000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish('mail_unavailable')); child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Never relay a library exception containing mailbox credentials.
    child.stdout.on('data', bytes => {
      size += bytes.length; if (size > 16 * 1024 * 1024) { finish('mail_response_too_large'); return; } chunks.push(bytes);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error) { finish(['auth_failed', 'mailbox_changed'].includes(result.error) ? result.error : 'mail_unavailable'); return; }
        if (code !== 0 || !validPage(result) || (result.nextCursor && !advances(cursor, result.nextCursor))) throw Error();
        finish(null, result);
      } catch { finish('mail_invalid_response'); }
    });
    child.stdin.end(JSON.stringify({ sinceMs, limit: 50, ...(cursor ? { cursor } : {}) }));
  });
}

export class GmailMonitor {
  constructor({ reader, bot, mailbox, now = Date.now, intervalMs = 60000, pagesPerCheck = 4 }) {
    if (!Number.isSafeInteger(pagesPerCheck) || pagesPerCheck < 1) throw Error('Invalid mail page budget');
    Object.assign(this, { reader, bot, mailbox, now, intervalMs, pagesPerCheck });
    this.controller = new AbortController(); this.running = null; this.timer = null;
    this.scan = null;
    this.state = { enabled: true, connected: false, lastCheckedAt: null, lastError: null, confirmed: 0, truncated: false };
  }
  status() { return { ...this.state }; }
  start() {
    const next = async () => {
      await this.check();
      if (!this.controller.signal.aborted) { this.timer = setTimeout(next, this.intervalMs); this.timer.unref?.(); }
    };
    void next();
  }
  check() {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; }); return this.running;
  }
  async run() {
    try {
      await this.bot.flushMailNotifications();
      if (!this.scan) {
        const candidates = this.bot.mailCandidates();
        const earliest = candidates.reduce((value, record) => Math.min(value, record.at), this.now());
        this.scan = { candidates, sinceMs: earliest - 60000, cursor: undefined, skipped: false,
          matchers: candidates.map(record => createReceiptMatcher(record, { mailbox: this.mailbox, now: this.now() })) };
      }
      const scan = this.scan;
      // Each child reads at most 50 messages. Keep only matching metadata between pages/checks.
      for (let pageNumber = 0; pageNumber < this.pagesPerCheck; pageNumber++) {
        const page = await this.reader({ sinceMs: scan.sinceMs, cursor: scan.cursor, signal: this.controller.signal });
        if (this.controller.signal.aborted) return;
        if (!validPage(page) || (page.nextCursor && !advances(scan.cursor, page.nextCursor))) throw Error('mail_invalid_response');
        scan.skipped ||= page.skipped === true || (page.truncated && !page.nextCursor);
        for (const matcher of scan.matchers) matcher.add(page.messages);
        Object.assign(this.state, { connected: true, lastCheckedAt: this.now(), lastError: null,
          truncated: scan.skipped || Boolean(page.nextCursor) });
        if (page.nextCursor && scan.candidates.length) { scan.cursor = page.nextCursor; continue; }
        this.scan = null;
        // Wait for the full scan: an older page can contain a conflicting ticket/reference.
        for (const [index, record] of scan.candidates.entries()) {
          if (this.controller.signal.aborted) return;
          const receipt = scan.matchers[index].result();
          if (receipt && await this.bot.confirmMail(record, receipt)) this.state.confirmed++;
        }
        return;
      }
    } catch (error) {
      this.scan = null;
      if (!this.controller.signal.aborted) Object.assign(this.state, { connected: false, lastCheckedAt: this.now(),
        lastError: ['auth_failed', 'mail_timeout'].includes(error.message) ? error.message : 'mail_unavailable' });
    }
  }
  async close() { clearTimeout(this.timer); this.controller.abort(); await this.running; this.scan = null; }
}
