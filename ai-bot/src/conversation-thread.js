import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicJson } from './storage.js';

const MESSAGE_ID = /^(?=.{16,100}$)[a-f0-9]+(?:-[a-f0-9]+)*$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SECRET = /(?:\bsk-[A-Za-z0-9_-]{12,}|\badmin-[a-f0-9]{16,}|\b\d{1,4}\/[A-Za-z0-9+/=]{4,}\/[A-Za-z0-9+/=]{10,}|\bauthorization\s*:\s*bearer\s+\S{8,})/gi;
const scrub = text => text.replace(SECRET, '[已隐藏密钥]');
const clipped = (text, size) => text.toWellFormed().slice(0, size).replace(/[\uD800-\uDBFF]$/, '');
const validText = (value, maximum) => typeof value === 'string' && value.trim() && value.length <= maximum && value.isWellFormed();

/** One explicit topic, shared by both identities. Only newTopic clears it. */
export class ConversationThread {
  #file; #write; #state = null; #ready = false; #operations = Promise.resolve();
  constructor({ dataDir, writeState = atomicJson }) { this.#file = path.join(dataDir, 'conversation-thread.json'); this.#write = writeState; }
  async init() {
    try {
      const raw = await readFile(this.#file, 'utf8');
      if (raw.length > 200000) throw Error('THREAD_STORAGE');
      const saved = JSON.parse(raw), value = saved.thread;
      if (saved.version !== 1) throw Error('THREAD_STORAGE');
      if (value !== null) {
        if (!value || !UUID.test(value.id || '')
          || value.anchorMessageId !== null && (typeof value.anchorMessageId !== 'string' || !MESSAGE_ID.test(value.anchorMessageId))
          || !validText(value.topic, 2000) || !['discussion', 'code'].includes(value.mode)
          || !Array.isArray(value.messages) || value.messages.length > 16
          || value.messages.some(item => !['user', 'assistant'].includes(item?.role) || !validText(item.content, 6000)
            || item.speaker !== undefined && (typeof item.speaker !== 'string' || item.speaker.length > 32))
          || value.messages.reduce((sum, item) => sum + item.content.length, 0) > 24000
          || !Array.isArray(value.seen) || value.seen.length > 256 || value.seen.some(id => !MESSAGE_ID.test(id))) throw Error('THREAD_STORAGE');
        this.#state = { id: value.id, anchorMessageId: value.anchorMessageId, topic: scrub(value.topic), mode: value.mode,
          messages: value.messages.map(item => ({ role: item.role, content: scrub(item.content), ...(item.speaker ? { speaker: scrub(item.speaker) } : {}) })), seen: [...value.seen] };
        if (JSON.stringify(this.#state) !== JSON.stringify(value)) await this.#write(this.#file, { version: 1, thread: this.#state });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('THREAD_STORAGE'); }
    this.#ready = true; return this;
  }
  context() { return this.#state ? structuredClone(this.#state) : null; }
  snapshot() { return { enabled: this.#ready, threadId: this.#state?.id || null, anchorMessageId: this.#state?.anchorMessageId || null,
    mode: this.#state?.mode || null, historyMessages: this.#state?.messages.length || 0 }; }
  #enqueue(work) { const operation = this.#operations.then(work); this.#operations = operation.catch(() => {}); return operation; }
  async #save(next) {
    if (!this.#ready) throw Error('THREAD_STORAGE');
    await this.#write(this.#file, { version: 1, thread: next }); this.#state = next;
    return this.context();
  }
  #trim(messages) {
    while (messages.length > 16 || messages.reduce((sum, item) => sum + item.content.length, 0) > 24000) messages.shift();
  }
  accept({ text, receiptId, replyMessageId = receiptId, mode = 'discussion' }) {
    return this.#enqueue(async () => {
      if (!validText(text, 2000) || !MESSAGE_ID.test(receiptId || '') || !MESSAGE_ID.test(replyMessageId || '')
        || !['discussion', 'code'].includes(mode)) throw Error('INVALID_THREAD_INPUT');
      if (this.#state?.seen.includes(receiptId)) return this.context();
      const next = this.context() || { id: randomUUID(), anchorMessageId: replyMessageId, topic: scrub(text.trim()), mode, messages: [], seen: [] };
      // A channel migration keeps the topic but waits for a new human message to quote.
      if (next.anchorMessageId === null) next.anchorMessageId = replyMessageId;
      next.messages.push({ role: 'user', content: scrub(text.trim()) }); next.seen.push(receiptId); next.seen = next.seen.slice(-256);
      this.#trim(next.messages); return this.#save(next);
    });
  }
  setMode(mode) {
    return this.#enqueue(async () => {
      if (!['discussion', 'code'].includes(mode)) throw Error('INVALID_THREAD_INPUT');
      const next = this.context(); if (!next) return null;
      next.mode = mode; return this.#save(next);
    });
  }
  recordAssistant({ threadId, content, speaker }) {
    return this.#enqueue(async () => {
      const next = this.context();
      if (!next || next.id !== threadId || !validText(content, 100000)) return;
      const item = { role: 'assistant', content: clipped(scrub(content), 6000) };
      if (validText(speaker, 32)) item.speaker = scrub(speaker);
      next.messages.push(item); this.#trim(next.messages); await this.#save(next);
    });
  }
  reset() { return this.#enqueue(() => this.#save(null)); }
}
