import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchReceipts } from './mail-match.js';

const script = fileURLToPath(new URL('../mail/gmail_reader.py', import.meta.url));
export function createGmailReader({ address, password, python = '/usr/bin/python3', spawnImpl = spawn } = {}) {
  if (!/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(address || '') || !/^[a-z]{16}$/i.test((password || '').replace(/\s/g, '')))
    throw Error('Invalid Gmail configuration');
  const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', GMAIL_ADDRESS: address,
    GMAIL_APP_PASSWORD: password.replace(/\s/g, ''), ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  return ({ sinceMs, signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('cancelled')); return; }
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
        if (result.error) { finish(result.error === 'auth_failed' ? 'auth_failed' : 'mail_unavailable'); return; }
        if (code !== 0 || !Array.isArray(result.messages) || result.messages.length > 50 || typeof result.truncated !== 'boolean') throw Error();
        finish(null, result);
      } catch { finish('mail_invalid_response'); }
    });
    child.stdin.end(JSON.stringify({ sinceMs, limit: 50 }));
  });
}

export class GmailMonitor {
  constructor({ reader, bot, mailbox, now = Date.now, intervalMs = 60000 }) {
    Object.assign(this, { reader, bot, mailbox, now, intervalMs });
    this.controller = new AbortController(); this.running = null; this.timer = null;
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
      const candidates = this.bot.mailCandidates();
      const earliest = candidates.length ? Math.min(...candidates.map(record => record.at)) : this.now();
      const { messages, truncated } = await this.reader({ sinceMs: earliest - 60000, signal: this.controller.signal });
      if (this.controller.signal.aborted) return;
      Object.assign(this.state, { connected: true, lastCheckedAt: this.now(), lastError: null, truncated });
      for (const record of candidates) {
        const receipt = matchReceipts(messages, record, { mailbox: this.mailbox, now: this.now() });
        if (receipt && await this.bot.confirmMail(record, receipt)) this.state.confirmed++;
      }
    } catch (error) {
      if (!this.controller.signal.aborted) Object.assign(this.state, { connected: false, lastCheckedAt: this.now(),
        lastError: ['auth_failed', 'mail_timeout'].includes(error.message) ? error.message : 'mail_unavailable' });
    }
  }
  async close() { clearTimeout(this.timer); this.controller.abort(); await this.running; }
}
