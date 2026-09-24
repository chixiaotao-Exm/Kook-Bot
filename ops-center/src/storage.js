import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class OpsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const emptyState = () => ({ version: 1, hosts: {}, monitors: {}, maintenance: {}, streaks: {}, incidents: [], commands: [], audit: [] });
export class StateStore {
  constructor({ dataDir, writeState, timeoutMs = 10000 } = {}) {
    this.file = path.join(dataDir, 'ops-state.json'); this.data = emptyState(); this.tail = Promise.resolve(); this.pending = 0; this.failed = false;
    this.timeoutMs = timeoutMs;
    this.writeState = writeState || (async value => {
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, this.file);
    });
  }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.file, 'utf8'); if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('State too large');
      const value = JSON.parse(raw);
      if (value.version !== 1 || !['hosts', 'monitors', 'maintenance', 'streaks'].every(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]))
        || !['incidents', 'commands', 'audit'].every(key => Array.isArray(value[key]))) throw new Error('Invalid ops state');
      this.data = value;
      for (const item of this.data.incidents) for (const key of ['notified', 'recoveryNotified']) if (item[key] === 'sending') item[key] = 'uncertain';
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Operations state cannot be loaded safely'); }
    return this;
  }
  async transaction(update) {
    if (this.failed) throw new OpsError('状态存储不可用，操作已停止。', 503);
    if (this.pending >= 32) throw new OpsError('操作较多，请稍后重试。', 503);
    this.pending++;
    const run = this.tail.catch(() => {}).then(async () => {
      if (this.failed) throw new OpsError('状态存储不可用，操作已停止。', 503);
      const draft = structuredClone(this.data), result = update(draft);
      if (result instanceof Promise) throw new Error('State updates must be synchronous');
      let timer;
      try {
        await Promise.race([this.writeState(draft), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Storage timeout')), this.timeoutMs); })]);
        this.data = draft; return result;
      } catch { this.failed = true; throw new OpsError('状态保存失败，操作已停止，请检查存储。', 503); }
      finally { clearTimeout(timer); }
    });
    this.tail = run; try { return await run; } finally { this.pending--; }
  }
  async close() { await this.tail.catch(() => {}); }
}
