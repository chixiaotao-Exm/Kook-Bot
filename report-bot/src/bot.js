import { randomUUID } from 'node:crypto';
import { CHANNEL_ID, DAY_MS, DRAFT_TTL_MS, normalizeNickname, draftContent, isAllowedMessage,
  validId, validMessageId, validEventTime, validAuthorMetadata, RESULT_MESSAGES } from './domain.js';
import { STORE_LIMITS } from './store.js';

const abortError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
const HELP = '发送昵称或只含昵称的截图，机器人移除完整的开头战队标签并生成举报预览。\n只有发起人可以确认、修改或取消自己的预览，15 分钟后到期。\n修改：点击「修改昵称」后发送新昵称，或重新发送「举报 正确昵称」。\n状态：发送「状态 昵称」。\n图片会发往配置的 PaddleOCR 云服务识别。\n每次确认最多提交一次；未知结果不会自动重试。';

// A late, uncancellable operation never gets to mutate state or release a second submission.
async function bounded(operation, signal, timeoutMs) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(abortError());
    combined.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (combined.aborted) throw abortError();
      return operation(combined);
    }), deadline]);
  } finally {
    clearTimeout(timer); combined.removeEventListener('abort', abort); controller.abort();
  }
}

export class ReportBot {
  constructor({ store, send, submit, ocr, enabled = false, now = Date.now, resolveAuthor, resolveButtonAuthor,
    timeouts = {} } = {}) {
    if (!store?.data || typeof store.save !== 'function' || typeof send !== 'function' || typeof submit !== 'function'
      || typeof now !== 'function' || typeof enabled !== 'boolean'
      || [ocr, resolveAuthor, resolveButtonAuthor].some(fn => fn != null && typeof fn !== 'function'))
      throw new Error('Invalid report bot configuration');
    Object.assign(this, { store, send, submit, ocr, enabled, now, resolveAuthor, resolveButtonAuthor });
    this.timeouts = { storage: 5000, identity: 8000, send: 10000, ocr: 85000, submit: 65000, ...timeouts };
    if (Object.values(this.timeouts).some(value => !Number.isInteger(value) || value < 1 || value > 90000))
      throw new Error('Invalid report bot timeouts');
    // Compatible with the initial in-memory store shape; disk stores are strictly validated by openStore.
    const state = store.data;
    for (const name of ['seen', 'drafts', 'reports']) state[name] = Object.assign(Object.create(null), state[name]);
    state.attempts ??= []; state.previews ??= [];
    state.rate ??= { globalAt: null, users: Object.create(null) };
    state.rate.users = Object.assign(Object.create(null), state.rate.users);
    this.queue = Promise.resolve(); this.pending = 0; this.active = 0; this.ready = true; this.closed = false;
    this.controller = new AbortController(); this.lastError = null;
    this.counts = { received: 0, previews: 0, attempts: 0, success: 0, rejected: 0, failures: 0 };
  }

  status() {
    return { ready: this.ready && !this.closed, enabled: this.enabled, pending: this.pending, active: this.active,
      lastError: this.lastError, ...this.counts };
  }

  async close() { this.closed = true; this.controller.abort(); await this.queue; }

  handle(event, { botId, signal } = {}) {
    if (!this.ready || this.closed || signal?.aborted || this.pending >= 8) return Promise.resolve();
    const input = this.parse(event, botId);
    if (!input) return Promise.resolve();
    this.pending++;
    const operationSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const task = this.queue.then(() => this.process(input, operationSignal));
    const settled = task.catch(() => { this.counts.failures++; if (this.ready) this.lastError = 'request_failed'; });
    this.queue = settled.finally(() => { this.pending--; });
    return this.queue;
  }

  parse(event, botId) {
    if (!validId(botId) || !validMessageId(event?.msg_id) || !validEventTime(event?.msg_timestamp, this.now())) return null;
    const body = event.type === 255 && event.extra?.type === 'message_btn_click' ? event.extra.body : null;
    if (body) {
      if (body.target_id !== CHANNEL_ID || !validId(body.user_id) || body.user_id === botId
        || !validMessageId(body.msg_id) || !validAuthorMetadata(body.user_info, body.user_id)
        || typeof body.value !== 'string') return null;
      const matched = /^report:(confirm|cancel|edit):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(body.value);
      if (!matched) return null;
      const draft = this.store.data.drafts[matched[2]];
      if (!this.matchesDraft(draft, body)) return null;
      return { event, kind: 'button', user: body.user_id, verify: body.user_info?.bot !== false,
        body, action: matched[1], id: matched[2] };
    }
    if (!isAllowedMessage(event, botId)) return null;
    return { event, kind: 'message', user: event.author_id, verify: event.extra?.author?.bot !== false };
  }

  matchesDraft(draft, body) {
    return draft && !draft.editing && draft.author === body.user_id && draft.channelId === CHANNEL_ID
      && draft.cardId === body.msg_id && draft.expires > this.now();
  }

  prune(now) {
    const state = this.store.data;
    for (const [id, at] of Object.entries(state.seen)) if (at <= now - DAY_MS) delete state.seen[id];
    for (const [id, draft] of Object.entries(state.drafts)) if (draft.expires <= now) delete state.drafts[id];
    for (const [id, at] of Object.entries(state.rate.users)) if (at <= now - 5 * 60_000) delete state.rate.users[id];
    state.attempts = state.attempts.filter(item => item.at > now - DAY_MS);
    state.previews = state.previews.filter(at => at > now - 60 * 60_000);
    for (const [key, record] of Object.entries(state.reports)) if (record.at <= now - 30 * DAY_MS) delete state.reports[key];
    // Never evict a still-protected target in order to admit more reports.
    const reports = Object.entries(state.reports).sort((a, b) => a[1].at - b[1].at);
    while (reports.length >= STORE_LIMITS.reports && reports[0][1].at <= now - DAY_MS) {
      delete state.reports[reports.shift()[0]];
    }
  }

  async persist() {
    if (!this.ready) return false;
    try {
      // Cancellation must not bypass or obscure the pre-submission durability barrier.
      await bounded(() => this.store.save(), undefined, this.timeouts.storage);
      return true;
    } catch {
      this.ready = false; this.lastError = 'storage_failed'; this.counts.failures++;
      return false;
    }
  }

  async reply(input, signal) {
    if (signal?.aborted || this.closed) return;
    return bounded(currentSignal => this.send({ channelId: CHANNEL_ID, ...input }, { signal: currentSignal }), signal, this.timeouts.send);
  }

  async process(input, signal) {
    if (!this.ready || this.closed || signal.aborted || !validEventTime(input.event.msg_timestamp, this.now())) return;
    this.prune(this.now());
    const state = this.store.data;
    if (Object.hasOwn(state.seen, input.event.msg_id)) return;
    if (Object.keys(state.seen).length >= STORE_LIMITS.seen) { this.counts.rejected++; return; }
    if (input.kind === 'button' && !this.matchesDraft(state.drafts[input.id], input.body)) return;
    if (input.verify) {
      const resolver = input.kind === 'button' ? this.resolveButtonAuthor : this.resolveAuthor;
      if (!resolver || (input.kind === 'message' && !validId(input.event.extra?.guild_id))) return;
      let author;
      try {
        author = await bounded(currentSignal => input.kind === 'button'
          ? resolver({ ...input.body, guild_id: state.drafts[input.id]?.guildId, signal: currentSignal }, input.event)
          : resolver(input.user, { ...input.event, signal: currentSignal }), signal, this.timeouts.identity);
      } catch { return; }
      if (author?.id !== input.user || author?.bot !== false || signal.aborted || this.closed) return;
    }
    if (!validEventTime(input.event.msg_timestamp, this.now())) return;
    state.seen[input.event.msg_id] = this.now();
    if (!await this.persist() || signal.aborted || this.closed) return;
    const now = this.now();
    // Own-card actions must work immediately after a preview is shown. The
    // single-use draft, receipt and daily submit budget still guard side effects.
    const interactive = input.kind === 'button';
    if (!interactive && ((state.rate.globalAt !== null && now < state.rate.globalAt + 1000)
      || (Object.hasOwn(state.rate.users, input.user) && now < state.rate.users[input.user] + 3000))) {
      this.counts.rejected++; return;
    }
    state.rate.globalAt = now; state.rate.users[input.user] = now;
    if (!await this.persist() || signal.aborted || this.closed) return;
    this.active++; this.counts.received++;
    try {
      if (input.kind === 'button') {
        const draft = state.drafts[input.id];
        if (!this.matchesDraft(draft, input.body)) return;
        if (input.action === 'confirm') return await this.confirm(input.id, signal);
        if (input.action === 'cancel') {
          delete state.drafts[input.id];
          if (await this.persist()) await this.reply({ text: '已取消，未提交举报。' }, signal);
        } else {
          draft.editing = true; delete draft.cardId;
          if (await this.persist()) await this.reply({ text: '请发送修改后的昵称或昵称截图，我会重新生成预览；旧预览已失效。' }, signal);
        }
        return;
      }
      await this.message(input.event, signal);
    } finally { this.active--; }
  }

  async message(event, signal) {
    const state = this.store.data, content = event.content.trim();
    if (event.type !== 2 && (content === '帮助' || content === '/帮助')) { await this.reply({ text: HELP }, signal); return; }
    if (event.type !== 2 && /^状态\s/.test(content)) {
      try {
        const player = normalizeNickname(content.replace(/^状态\s+/, ''));
        const record = state.reports[player.toLowerCase()];
        await this.reply({ text: record ? `${player}：${RESULT_MESSAGES[record.kind] ?? RESULT_MESSAGES.unknown}` : `${player}：没有提交记录。` }, signal);
      } catch { await this.reply({ text: '请发送「状态 玩家昵称」查询。' }, signal); }
      return;
    }
    if (event.type !== 2 && /^(?:取消|取消举报)$/.test(content)) {
      for (const [id, draft] of Object.entries(state.drafts)) if (draft.author === event.author_id) delete state.drafts[id];
      if (await this.persist()) await this.reply({ text: '已取消你的待确认预览，未提交举报。' }, signal);
      return;
    }
    let raw = content.replace(/^\/?举报\s+/, '');
    if (event.type !== 2) {
      try { normalizeNickname(raw); } catch (error) {
        if (/^\/?举报\s/.test(content) || /^[\[【［]/.test(content)
          || Object.values(state.drafts).some(item => item.author === event.author_id && item.editing))
          await this.reply({ text: error.message }, signal);
        return;
      }
    }
    if (state.previews.length >= 60) {
      this.counts.rejected++; await this.reply({ text: '本频道近一小时已处理 60 次预览，请稍后再试。' }, signal); return;
    }
    // Reserve the OCR/preview budget before external work and across process restarts.
    state.previews.push(this.now());
    if (!await this.persist() || signal.aborted || this.closed) return;
    if (event.type === 2) {
      if (!this.ocr) { await this.reply({ text: '图片识别尚未配置。请直接发送「举报 玩家昵称」。' }, signal); return; }
      try { raw = await bounded(currentSignal => this.ocr(event, { signal: currentSignal }), signal, this.timeouts.ocr); }
      catch { await this.reply({ text: '昵称图片识别失败，请发送「举报 正确昵称」手动填写。' }, signal); return; }
    }
    if (signal.aborted || this.closed) return;
    let player;
    try { player = normalizeNickname(raw); }
    catch (error) { await this.reply({ text: error.message }, signal); return; }
    for (const [id, draft] of Object.entries(state.drafts)) if (draft.author === event.author_id) delete state.drafts[id];
    if (Object.keys(state.drafts).length >= STORE_LIMITS.drafts) { this.counts.rejected++; return; }
    const id = randomUUID();
    const draft = { player, raw: raw.trim(), author: event.author_id, channelId: CHANNEL_ID,
      guildId: validId(event.extra?.guild_id) ? event.extra.guild_id : null,
      expires: this.now() + DRAFT_TTL_MS, ...draftContent(player) };
    state.drafts[id] = draft;
    if (!await this.persist() || signal.aborted || this.closed) return;
    const cardId = await this.reply({
      text: `${this.enabled ? '举报预览' : '预览模式 · 尚未开启真实提交'}\n识别原文：${draft.raw}\n举报昵称：${player}\n\n标题：${draft.subject}\n\n${draft.description}\n\n只有本次发起人可以确认。请先核对昵称；此预览 15 分钟后失效。`,
      buttons: [{ label: this.enabled ? '确认举报' : '确认预览', value: `report:confirm:${id}` },
        { label: '修改昵称', value: `report:edit:${id}` }, { label: '取消', value: `report:cancel:${id}` }]
    }, signal);
    if (signal.aborted || this.closed || !validMessageId(cardId)) return;
    draft.cardId = cardId;
    if (await this.persist()) this.counts.previews++;
  }

  async confirm(id, signal) {
    const state = this.store.data, draft = state.drafts[id];
    if (!draft || draft.editing || draft.expires <= this.now() || !draft.cardId || signal.aborted || this.closed || !this.ready) return;
    const key = draft.player.toLowerCase(), previous = state.reports[key];
    if (!this.enabled) {
      delete state.drafts[id];
      if (await this.persist()) await this.reply({ text: `${draft.player}：预览已确认，当前未开启真实提交，未发送举报。` }, signal);
      return;
    }
    if (previous && previous.kind !== 'not_sent' && this.now() - previous.at < DAY_MS) {
      await this.reply({ text: `${draft.player} 已有 24 小时内的提交记录：${RESULT_MESSAGES[previous.kind] ?? RESULT_MESSAGES.unknown} 不会重复发送。` }, signal); return;
    }
    this.prune(this.now());
    if (state.attempts.length >= 20 || state.attempts.filter(item => item.author === draft.author).length >= 5) {
      this.counts.rejected++;
      await this.reply({ text: '已达到提交上限：本频道每 24 小时最多 20 次，每位成员最多 5 次。请稍后再试。' }, signal); return;
    }
    if (!Object.hasOwn(state.reports, key) && Object.keys(state.reports).length >= STORE_LIMITS.reports) {
      this.counts.rejected++; await this.reply({ text: '提交记录容量已满，当前暂停提交，请联系管理员。' }, signal); return;
    }
    // Durable unknown/pending marker and attempt budget MUST precede any official network operation.
    delete state.drafts[id];
    const at = this.now();
    state.reports[key] = { at, author: draft.author, kind: 'pending', message: RESULT_MESSAGES.pending };
    state.attempts.push({ at, author: draft.author });
    if (!await this.persist()) return;
    let result;
    try {
      if (signal.aborted || this.closed) throw abortError();
      await this.reply({ text: `⏳ 正在处理 ${draft.player}，请勿重复操作。` }, signal);
    } catch {
      result = { kind: 'not_sent' };
    }
    if (!result && (signal.aborted || this.closed)) result = { kind: 'not_sent' };
    if (!result) {
      this.counts.attempts++;
      try { result = await bounded(currentSignal => this.submit({ ...draft }, { signal: currentSignal }), signal, this.timeouts.submit); }
      catch { result = { kind: 'unknown' }; }
    }
    // Never echo exception text, official HTML, requester identity, or unvalidated result messages.
    const kind = ['success', 'not_sent', 'verification', 'unknown'].includes(result?.kind) ? result.kind : 'unknown';
    state.reports[key] = { at, author: draft.author, kind, message: RESULT_MESSAGES[kind] };
    if (!await this.persist()) {
      // Disk retains the pre-POST pending marker. In memory it must also remain ambiguous.
      state.reports[key] = { at, author: draft.author, kind: 'unknown', message: RESULT_MESSAGES.unknown };
      return;
    }
    if (kind === 'success') this.counts.success++;
    const icon = kind === 'success' ? '✅' : kind === 'not_sent' ? 'ℹ️' : '⚠️';
    await this.reply({ text: `${icon} ${draft.player}\n${RESULT_MESSAGES[kind]}` }, signal);
  }
}
