import { randomUUID } from 'node:crypto';
import { CHANNEL_ID, DAY_MS, normalizeNickname, cardImageUrl, draftContent, isAllowedMessage,
  validId, validMessageId, validEventTime, validAuthorMetadata, RESULT_MESSAGES } from './domain.js';
import { reporterId, mailboxHash, reportersSnapshot } from './reporters.js';
import { batchKind, batchSummary, reportEntries } from './report-results.js';

const abortError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
const HELP = 'Send "report PlayerName", a nickname, or a screenshot containing only the nickname. The bot removes a complete leading clan tag and creates a report preview.\nOnly the requester can confirm, edit, or cancel their preview. Previews do not expire.\nEdit: click "Edit nickname" and send the corrected nickname, or send "report CorrectNickname".\nStatus: send "status PlayerName".\nCancel your pending previews: send "cancel". Show these instructions: send "help".\nImages are sent to the configured PaddleOCR cloud service for recognition.\nEach account in the TXT file can submit at most once per batch. If a complete response is not received, the result is "Submission attempted" and is not retried automatically.';

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
    timeouts = {}, mailEnabled = false, getReporters, receiptMailbox, concurrency = 1, prepareWorker } = {}) {
    if (!store?.data || typeof store.save !== 'function' || typeof send !== 'function' || typeof submit !== 'function'
      || typeof now !== 'function' || typeof enabled !== 'boolean'
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10
      || [ocr, resolveAuthor, resolveButtonAuthor, getReporters, prepareWorker].some(fn => fn != null && typeof fn !== 'function'))
      throw new Error('Invalid report bot configuration');
    Object.assign(this, { store, send, submit, ocr, enabled, now, resolveAuthor, resolveButtonAuthor, mailEnabled, getReporters,
      concurrency, prepareWorker });
    this.receiptMailboxHash = receiptMailbox ? mailboxHash(receiptMailbox) : null;
    this.reporterCount = null;
    this.timeouts = { storage: 5000, identity: 8000, send: 10000, ocr: 85000, submit: 65000, worker: 35000, ...timeouts };
    if (Object.values(this.timeouts).some(value => !Number.isInteger(value) || value < 1 || value > 120000))
      throw new Error('Invalid report bot timeouts');
    // Compatible with the initial in-memory store shape; disk stores are strictly validated by openStore.
    const state = store.data;
    for (const name of ['seen', 'drafts', 'reports']) state[name] = Object.assign(Object.create(null), state[name]);
    state.attempts ??= []; state.previews ??= [];
    state.rate ??= { globalAt: null, users: Object.create(null) };
    state.rate.users = Object.assign(Object.create(null), state.rate.users);
    this.queue = Promise.resolve(); this.pending = 0; this.active = 0; this.inFlight = 0; this.ready = true; this.closed = false;
    this.controller = new AbortController(); this.lastError = null;
    this.counts = { received: 0, previews: 0, attempts: 0, success: 0, rejected: 0, failures: 0 };
  }

  status() {
    return { ready: this.ready && !this.closed, enabled: this.enabled, pending: this.pending, active: this.active,
      lastError: this.lastError, reporterCount: this.reporterCount, concurrency: this.concurrency, inFlight: this.inFlight, ...this.counts };
  }

  async close() { this.closed = true; this.controller.abort(); await this.queue; }

  mailCandidates() {
    if (!this.mailEnabled || !this.ready || this.closed) return [];
    return Object.entries(this.store.data.reports).filter(([, parent]) => !parent.results || parent.finished)
      .flatMap(([key, parent]) => reportEntries(parent)
      .filter(record => ['success', 'unknown', 'verification'].includes(record.kind) && !record.mail
        && record.at >= this.now() - 2 * DAY_MS
        && (!record.mailboxHash || !this.receiptMailboxHash || record.mailboxHash === this.receiptMailboxHash))
      .map(record => ({ ...record, key, player: parent.player || key,
        ...(parent.batchId ? { batchId: parent.batchId } : {}) })));
  }

  confirmMail(candidate, receipt) {
    const task = this.queue.then(async () => {
      if (!this.mailEnabled || !this.ready || this.closed) return false;
      const parent = this.store.data.reports[candidate.key];
      if (!parent || parent.batchId !== candidate.batchId || (parent.results && !parent.finished)) return false;
      const index = parent.results?.findIndex(item => item.reporterId === candidate.reporterId);
      const record = parent.results ? parent.results[index] : parent;
      if (!record || record.at !== candidate.at || record.mailRef !== candidate.mailRef || record.mail
        || !['success', 'unknown', 'verification'].includes(record.kind)) return false;
      if (Object.values(this.store.data.reports).flatMap(reportEntries)
        .some(item => item.mail?.messageId === receipt.messageId || item.mail?.ticketId === receipt.ticketId)) return false;
      const previous = { ...record };
      const previousKind = parent.kind, previousMessage = parent.message;
      Object.assign(record, { kind: 'success', message: RESULT_MESSAGES.success, mail: { ...receipt, notification: 'pending' } });
      if (parent.results && parent.finished) { parent.kind = batchKind(parent.results); parent.message = RESULT_MESSAGES[parent.kind]; }
      if (!await this.persist()) {
        if (parent.results) { parent.results[index] = previous; parent.kind = previousKind; parent.message = previousMessage; }
        else this.store.data.reports[candidate.key] = previous;
        return false;
      }
      await this.notifyMail(candidate.key, record, parent.results ? index + 1 : null);
      return true;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  flushMailNotifications() {
    const task = this.queue.then(async () => {
      for (const [key, parent] of Object.entries(this.store.data.reports)) {
        if (!this.mailEnabled || !this.ready || this.closed) return;
        for (const [index, record] of reportEntries(parent).entries()) {
          if (record.mail?.notification === 'pending') await this.notifyMail(key, record, parent.results ? index + 1 : null);
        }
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async notifyMail(key, record, index = null) {
    // Persist the attempt before sending: a delivery timeout must not duplicate a notification.
    record.mail.notification = 'attempted';
    if (!await this.persist() || this.closed) return;
    const player = this.store.data.reports[key]?.player || key;
    await this.reply({ text: `✅ Submission confirmed by email\nPlayer: ${player}${index ? `\nAccount number in this batch: ${index}` : ''}\nPUBG ticket: #${record.mail.ticketId}\nThe official email confirms receipt of the request. It does not confirm a violation or a ban.` }, this.controller.signal).catch(() => {});
  }

  handle(event, { botId, signal, receivedAt = this.now() } = {}) {
    if (!this.ready || this.closed || signal?.aborted) return Promise.resolve();
    const input = this.parse(event, botId, receivedAt);
    if (!input) return Promise.resolve();
    this.pending++;
    const operationSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const task = this.queue.then(() => this.process(input, operationSignal));
    const settled = task.catch(() => { this.counts.failures++; if (this.ready) this.lastError = 'request_failed'; });
    this.queue = settled.finally(() => { this.pending--; });
    return this.queue;
  }

  parse(event, botId, receivedAt = this.now()) {
    if (!validId(botId) || !validMessageId(event?.msg_id) || !validEventTime(event?.msg_timestamp, receivedAt)) return null;
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
      && draft.cardId === body.msg_id;
  }

  prune(now) {
    const state = this.store.data;
    for (const [id, at] of Object.entries(state.seen)) if (at <= now - DAY_MS) delete state.seen[id];
    state.attempts = state.attempts.filter(item => item.at > now - DAY_MS);
    // Discard obsolete rate/quota bookkeeping from older deployments.
    state.previews = []; state.rate = { globalAt: null, users: Object.create(null) };
    for (const [key, record] of Object.entries(state.reports)) if (record.at <= now - 30 * DAY_MS) delete state.reports[key];
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
    if (!this.ready || this.closed || signal.aborted) return;
    this.prune(this.now());
    const state = this.store.data;
    if (Object.hasOwn(state.seen, input.event.msg_id)) return;
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
    state.seen[input.event.msg_id] = this.now();
    if (!await this.persist() || signal.aborted || this.closed) return;
    this.active++; this.counts.received++;
    try {
      if (input.kind === 'button') {
        const draft = state.drafts[input.id];
        if (!this.matchesDraft(draft, input.body)) return;
        if (input.action === 'confirm') return await this.confirm(input.id, signal);
        if (input.action === 'cancel') {
          delete state.drafts[input.id];
          if (await this.persist()) await this.reply({ text: 'Cancelled. No report was submitted.' }, signal);
        } else {
          draft.editing = true; delete draft.cardId;
          if (await this.persist()) await this.reply({ text: 'Send the corrected nickname or a screenshot of it to create a new preview. The previous preview is no longer valid.' }, signal);
        }
        return;
      }
      await this.message(input.event, signal);
    } finally { this.active--; }
  }

  async message(event, signal) {
    if (event.type === 10) {
      try {
        event = { ...event, type: 2, content: cardImageUrl(event.content) };
      } catch (error) { await this.reply({ text: error.message }, signal); return; }
    }
    const state = this.store.data, content = event.content.trim();
    if (event.type !== 2 && /^\/?(?:help|帮助)$/i.test(content)) { await this.reply({ text: HELP }, signal); return; }
    if (event.type !== 2 && /^\/?(?:status|状态)\s/i.test(content)) {
      try {
        const player = normalizeNickname(content.replace(/^\/?(?:status|状态)\s+/i, ''));
        const record = state.reports[player.toLowerCase()];
        if (record?.results) { await this.reply({ text: `${player}\n${batchSummary(record)}` }, signal); return; }
        const receipt = record?.mail ? `\nConfirmed by email. PUBG ticket #${record.mail.ticketId}.` : '';
        await this.reply({ text: record ? `${player}: ${RESULT_MESSAGES[record.kind] ?? RESULT_MESSAGES.unknown}${receipt}` : `${player}: No submission record.` }, signal);
      } catch { await this.reply({ text: 'Send "status PlayerName" to check a submission.' }, signal); }
      return;
    }
    if (event.type !== 2 && /^\/?(?:cancel|取消|取消举报)$/i.test(content)) {
      for (const [id, draft] of Object.entries(state.drafts)) if (draft.author === event.author_id) delete state.drafts[id];
      if (await this.persist()) await this.reply({ text: 'Your pending previews have been cancelled. No report was submitted.' }, signal);
      return;
    }
    let raw = content.replace(/^\/?(?:report|举报)\s+/i, '');
    if (event.type !== 2) {
      try { normalizeNickname(raw); } catch (error) {
        if (/^\/?(?:report|举报)\s/i.test(content) || /^[\[【［]/.test(content)
          || Object.values(state.drafts).some(item => item.author === event.author_id && item.editing))
          await this.reply({ text: error.message }, signal);
        return;
      }
    }
    if (event.type === 2) {
      if (!this.ocr) { await this.reply({ text: 'Image recognition is not configured. Send "report PlayerName" instead.' }, signal); return; }
      try { raw = await bounded(currentSignal => this.ocr(event, { signal: currentSignal }), signal, this.timeouts.ocr); }
      catch { await this.reply({ text: 'Nickname image recognition failed. Enter the nickname manually with "report CorrectNickname".' }, signal); return; }
    }
    if (signal.aborted || this.closed) return;
    let player;
    try { player = normalizeNickname(raw); }
    catch (error) { await this.reply({ text: error.message }, signal); return; }
    let accountInfo = {};
    if (this.getReporters) {
      let profiles;
      try { profiles = await this.readReporters(signal); }
      catch { await this.reply({ text: 'A valid reporter account list could not be read. Ask an administrator to check the TXT file, then create a new preview.' }, signal); return; }
      accountInfo = { reporterSnapshot: reportersSnapshot(profiles), reporterCount: profiles.length };
    }
    const editing = Object.entries(state.drafts).find(([, draft]) => draft.author === event.author_id && draft.editing);
    if (editing) delete state.drafts[editing[0]];
    const id = randomUUID();
    const draft = { player, raw: raw.trim(), author: event.author_id, channelId: CHANNEL_ID,
      guildId: validId(event.extra?.guild_id) ? event.extra.guild_id : null,
      expires: null, ...draftContent(player), ...accountInfo };
    state.drafts[id] = draft;
    if (!await this.persist() || signal.aborted || this.closed) return;
    const cardId = await this.reply({
      text: `${this.enabled ? 'Report preview' : 'Preview mode · Live submission is disabled'}\nOriginal text: ${draft.raw}\nReported nickname: ${player}`
        + (draft.reporterCount ? `\nReporter accounts: ${draft.reporterCount}\nPlanned submissions after confirmation: ${draft.reporterCount}, once per account.` : '')
        + `\n\nSubject: ${draft.subject}\n\n${draft.description}\n\nOnly the requester can confirm this preview. Check the nickname first.`,
      buttons: [{ label: this.enabled ? 'Confirm report' : 'Confirm preview', value: `report:confirm:${id}` },
        { label: 'Edit nickname', value: `report:edit:${id}` }, { label: 'Cancel', value: `report:cancel:${id}` }]
    }, signal);
    if (signal.aborted || this.closed || !validMessageId(cardId)) return;
    draft.cardId = cardId;
    if (await this.persist()) this.counts.previews++;
  }

  async confirm(id, signal) {
    const state = this.store.data, draft = state.drafts[id];
    if (!draft || draft.editing || !draft.cardId || signal.aborted || this.closed || !this.ready) return;
    if (this.getReporters) return this.confirmBatch(id, draft, signal);
    if (draft.reporterSnapshot) return; // A saved batch preview must never fall back to a single identity.
    const key = draft.player.toLowerCase();
    if (!this.enabled) {
      delete state.drafts[id];
      if (await this.persist()) await this.reply({ text: `${draft.player}: Preview confirmed. Live submission is disabled. No report was sent.` }, signal);
      return;
    }
    this.prune(this.now());
    // Persist the pending marker and attempt history before official network operations.
    delete state.drafts[id];
    const at = this.now();
    const mailInfo = this.mailEnabled ? { player: draft.player, mailRef: 'KOOK-' + randomUUID().replaceAll('-', '') } : {};
    state.reports[key] = { at, author: draft.author, kind: 'pending', message: RESULT_MESSAGES.pending, ...mailInfo };
    state.attempts.push({ at, author: draft.author });
    if (!await this.persist()) return;
    let result;
    try {
      if (signal.aborted || this.closed) throw abortError();
      await this.reply({ text: `⏳ Processing ${draft.player}. Please do not repeat the action.` }, signal);
    } catch {
      result = { kind: 'not_sent' };
    }
    if (!result && (signal.aborted || this.closed)) result = { kind: 'not_sent' };
    if (!result) {
      this.counts.attempts++; this.inFlight++;
      try { result = await bounded(currentSignal => this.submit({ ...draft,
        ...(mailInfo.mailRef ? { subject: `${draft.subject} [${mailInfo.mailRef}]` } : {})
      }, { signal: currentSignal }), signal, this.timeouts.submit); }
      catch { result = { kind: 'unknown' }; }
      finally { this.inFlight--; }
    }
    // Never echo exception text, official HTML, requester identity, or unvalidated result messages.
    const kind = ['success', 'not_sent', 'verification', 'unknown'].includes(result?.kind) ? result.kind : 'unknown';
    state.reports[key] = { at, author: draft.author, kind, message: RESULT_MESSAGES[kind], ...mailInfo };
    if (!await this.persist()) {
      // Disk retains the pre-POST pending marker. In memory it must also remain ambiguous.
      state.reports[key] = { at, author: draft.author, kind: 'unknown', message: RESULT_MESSAGES.unknown, ...mailInfo };
      return;
    }
    if (kind === 'success') this.counts.success++;
    const icon = kind === 'success' ? '✅' : kind === 'not_sent' ? 'ℹ️' : '⚠️';
    const mailNote = this.mailEnabled && kind !== 'not_sent' ? '\nOfficial receipts in Gmail will be checked automatically. A confirmation will be posted in this channel.' : '';
    await this.reply({ text: `${icon} ${draft.player}\n${RESULT_MESSAGES[kind]}${mailNote}` }, signal);
  }

  async readReporters(signal) {
    const profiles = await bounded(() => this.getReporters(), signal, this.timeouts.storage);
    if (!Array.isArray(profiles) || !profiles.length) throw Error('Invalid reporter list');
    this.reporterCount = profiles.length;
    return profiles;
  }

  async confirmBatch(id, draft, signal) {
    let profiles;
    try { profiles = await this.readReporters(signal); }
    catch { await this.reply({ text: 'A valid reporter account list could not be read. Nothing was submitted. Ask an administrator to check the TXT file.' }, signal); return; }
    if (profiles.length !== draft.reporterCount || reportersSnapshot(profiles) !== draft.reporterSnapshot) {
      delete this.store.data.drafts[id];
      if (await this.persist()) await this.reply({ text: 'The reporter account list has changed. Nothing was submitted. Send the nickname again and confirm the updated account count.' }, signal);
      return;
    }
    delete this.store.data.drafts[id];
    if (!this.enabled) {
      if (await this.persist()) await this.reply({ text: `${draft.player}: Preview confirmed for ${profiles.length} accounts. Live submission is disabled. No report was sent.` }, signal);
      return;
    }
    const key = draft.player.toLowerCase(), at = this.now();
    const record = { at, author: draft.author, player: draft.player, batchId: randomUUID(), finished: false,
      kind: 'pending', message: RESULT_MESSAGES.pending,
      results: profiles.map(profile => ({ reporterId: reporterId(profile), mailboxHash: mailboxHash(profile.email),
        at, kind: 'not_sent', message: RESULT_MESSAGES.not_sent })) };
    this.store.data.reports[key] = record;
    if (!await this.persist()) return;
    let announced = false;
    try { announced = Boolean(await this.reply({ text: `⏳ Processing ${draft.player} with ${profiles.length} accounts and up to ${this.concurrency} concurrent submissions. Please do not repeat the action.` }, signal)); }
    catch { /* If delivery is uncertain, keep all accounts as not sent. */ }
    let nextIndex = 0;
    const canStart = () => announced && !signal.aborted && !this.closed && this.ready && nextIndex < profiles.length;
    const worker = async workerIndex => {
      while (canStart()) {
        if (this.prepareWorker) {
          try {
            if (await bounded(currentSignal => this.prepareWorker(workerIndex, { signal: currentSignal }),
              signal, this.timeouts.worker) !== true) return;
          } catch { return; }
        }
        // Claim only after the isolated transport is available. Failed workers
        // leave every unclaimed identity for the remaining healthy workers.
        if (!canStart()) return;
        const index = nextIndex++, profile = profiles[index], item = record.results[index];
        Object.assign(item, { at: this.now(), kind: 'pending', message: RESULT_MESSAGES.pending,
          ...(this.mailEnabled ? { mailRef: 'KOOK-' + randomUUID().replaceAll('-', '') } : {}) });
        this.store.data.attempts.push({ at: item.at, author: draft.author });
        if (!await this.persist()) return;
        let result;
        // Another worker may have failed its durability barrier while this one
        // was waiting. No new submission may start after that shared failure.
        if (signal.aborted || this.closed || !this.ready) result = { kind: 'not_sent' };
        else {
          this.counts.attempts++; this.inFlight++;
          try {
            result = await bounded(currentSignal => {
              if (!this.ready || this.closed || currentSignal.aborted) return { kind: 'not_sent' };
              return this.submit({ ...draft,
                ...(item.mailRef ? { subject: `${draft.subject} [${item.mailRef}]` } : {})
              }, { signal: currentSignal, profile, workerIndex });
            }, signal, this.timeouts.submit);
          } catch { result = { kind: 'unknown' }; }
          finally { this.inFlight--; }
        }
        item.kind = ['success', 'not_sent', 'verification', 'unknown'].includes(result?.kind) ? result.kind : 'unknown';
        item.message = RESULT_MESSAGES[item.kind];
        if (!await this.persist()) { item.kind = 'unknown'; item.message = RESULT_MESSAGES.unknown; return; }
        if (item.kind === 'success') this.counts.success++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, profiles.length) }, (_, index) => worker(index)));
    // Mail reconciliation starts only after all workers and their durable
    // result writes have finished. No identity is retried within this batch.
    record.finished = true; record.kind = batchKind(record.results); record.message = RESULT_MESSAGES[record.kind];
    if (!await this.persist()) return;
    const mailCount = record.results.filter(item => item.mailRef && item.kind !== 'not_sent'
      && (!this.receiptMailboxHash || item.mailboxHash === this.receiptMailboxHash)).length;
    await this.reply({ text: `${draft.player}\n${batchSummary(record)}`
      + (mailCount ? `\nThis batch has finished. Official Gmail receipts will be checked for all ${mailCount} submission attempts. No submissions will be repeated.` : '') }, signal);
  }
}
