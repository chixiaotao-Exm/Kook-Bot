const API_BASE = 'https://www.kookapp.cn/api/v3/';
const GATEWAY_DOMAINS = ['kookapp.cn', 'kookapp.com', 'kaiheila.cn', 'kaiheila.com'];

class GatewayFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function boundedJson(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new GatewayFailure('api_response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayFailure('api_invalid_response');
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new GatewayFailure('api_response_too_large');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Outbound KOOK gateway. No credentials, gateway URLs, or events are logged. */
export class KookGateway {
  constructor({ token, onEvent, fetchImpl = fetch, Socket = globalThis.WebSocket,
    logger = console, random = Math.random, now = Date.now, setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout, apiTimeoutMs = 10000, handshakeTimeoutMs = 6000,
    heartbeatMs = 30000, heartbeatJitterMs = 5000, pongTimeoutMs = 6000,
    pingRetryBaseMs = 2000, reconnectBaseMs = 2000, resumeBaseMs = 8000, reconnectMaxMs = 60000,
    eventTimeoutMs = 45000, sequenceGapMs = 10000, maxFrameBytes = 512 * 1024, maxBufferedEvents = 100,
    maxBufferedBytes = 4 * 1024 * 1024 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('KOOK token is required');
    if (typeof onEvent !== 'function') throw new Error('KOOK event handler is required');
    if (typeof Socket !== 'function') throw new Error('WebSocket requires Node.js 22 or newer');
    this.token = token.trim(); this.onEvent = onEvent; this.fetch = fetchImpl;
    this.Socket = Socket; this.logger = logger; this.random = random; this.now = now;
    this.setTimeout = setTimeoutImpl; this.clearTimeout = clearTimeoutImpl;
    Object.assign(this, { apiTimeoutMs, handshakeTimeoutMs, heartbeatMs, heartbeatJitterMs,
      pongTimeoutMs, pingRetryBaseMs, reconnectBaseMs, resumeBaseMs, reconnectMaxMs, eventTimeoutMs, sequenceGapMs,
      maxFrameBytes, maxBufferedEvents, maxBufferedBytes });
    this.running = false; this.connected = false; this.botId = '';
    this.session = ''; this.gatewayUrl = ''; this.sn = 0; this.observedSn = 0; this.pending = new Map();
    this.pendingBytes = 0; this.sequenceEpoch = 0; this.runEpoch = 0;
    this.timers = new Map(); this.attempt = 0; this.resumeAttempts = 0;
    this.connectionAttempts = 0; this.lastError = null; this.processing = null;
    this.lastPongAt = null;
  }

  snapshot() {
    return { running: this.running, connected: this.connected, botId: this.botId || null,
      lastEventSn: this.sn, pendingEvents: this.pending.size,
      connectionAttempts: this.connectionAttempts, lastError: this.lastError,
      lastPongAt: this.lastPongAt };
  }

  async start() {
    if (this.running) return;
    this.running = true; this.runEpoch++; this.attempt = 0; this.resumeAttempts = 0;
    return this.connect();
  }

  close() {
    this.running = false; this.connected = false; this.runEpoch++;
    this.apiController?.abort(); this.clearTimers(); this.detachSocket();
    this.resetSession();
  }

  log(code, details = {}) {
    // Never pass Error objects to a logger: fetch/WebSocket errors may contain URLs.
    try {
      if (typeof this.logger === 'function') this.logger(code, details);
      else this.logger?.info?.(code, details);
    } catch { /* Logging cannot interrupt connection recovery. */ }
  }

  later(name, fn, delay) {
    this.cancel(name);
    const timer = this.setTimeout(() => {
      if (this.timers.get(name) !== timer) return;
      this.timers.delete(name); fn();
    }, Math.max(0, delay));
    timer?.unref?.(); this.timers.set(name, timer);
    return timer;
  }
  cancel(name) {
    const timer = this.timers.get(name);
    if (timer !== undefined) this.clearTimeout(timer);
    this.timers.delete(name);
  }
  clearTimers() { for (const name of this.timers.keys()) this.cancel(name); }

  async request(endpoint) {
    const controller = new AbortController(); this.apiController = controller;
    const timeout = this.setTimeout(() => controller.abort(), this.apiTimeoutMs);
    timeout?.unref?.();
    try {
      const response = await this.fetch(new URL(endpoint, API_BASE), {
        method: 'GET', headers: { Authorization: `Bot ${this.token}` },
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayFailure(response.status === 429 ? 'api_rate_limited' : 'api_rejected');
      }
      const body = await boundedJson(response, 64 * 1024);
      if (body?.code !== 0 || !body.data || typeof body.data !== 'object') throw new GatewayFailure('api_rejected');
      return body.data;
    } finally {
      this.clearTimeout(timeout);
      if (this.apiController === controller) this.apiController = null;
    }
  }

  async connect() {
    const run = this.runEpoch;
    if (!this.running || this.connecting === run || this.socket) return;
    this.connecting = run; this.connectionAttempts++;
    try {
      if (!this.botId) {
        const identity = await this.request('user/me');
        if (!this.running || this.runEpoch !== run) return;
        if (typeof identity.id !== 'string' || !/^\d{1,30}$/.test(identity.id)) throw new GatewayFailure('api_invalid_identity');
        this.botId = identity.id;
      }
      const resume = Boolean(this.session && this.gatewayUrl && this.resumeAttempts < 2);
      if (!resume) {
        this.resetSession();
        const data = await this.request('gateway/index?compress=0');
        if (!this.running || this.runEpoch !== run) return;
        this.gatewayUrl = data.url;
      }
      const url = new URL(this.gatewayUrl);
      if (url.protocol !== 'wss:' || url.username || url.password || url.hash ||
          !GATEWAY_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        throw new GatewayFailure('invalid_gateway');
      }
      if (resume) {
        this.resumeAttempts++;
        url.searchParams.set('resume', '1'); url.searchParams.set('sn', String(this.sn));
        url.searchParams.set('session_id', this.session);
      }
      const socket = new this.Socket(url.toString()); this.socket = socket;
      const listeners = {
        open: () => {
          if (this.socket !== socket) return;
          this.later('hello', () => this.fail('hello_timeout'), this.handshakeTimeoutMs);
        },
        message: event => {
          if (this.running && this.socket === socket) this.receive(event.data);
        },
        error: () => { if (this.socket === socket) this.fail('socket_error'); },
        close: () => { if (this.socket === socket) this.fail('socket_closed'); },
      };
      this.socketListeners = listeners;
      for (const [name, listener] of Object.entries(listeners)) socket.addEventListener(name, listener);
      this.later('hello', () => this.fail('connect_timeout'), this.handshakeTimeoutMs);
    } catch (error) {
      if (this.running && this.runEpoch === run) this.fail(error instanceof GatewayFailure ? error.code : 'connection_failed');
    } finally {
      if (this.connecting === run) this.connecting = null;
    }
  }

  detachSocket() {
    const socket = this.socket; this.socket = null;
    if (!socket) return;
    for (const [name, listener] of Object.entries(this.socketListeners || {})) socket.removeEventListener(name, listener);
    this.socketListeners = null;
    try { socket.close(); } catch { /* A failed handshake may already have closed. */ }
  }

  resetSession() {
    this.session = ''; this.gatewayUrl = ''; this.sn = 0; this.observedSn = 0;
    this.pending.clear(); this.pendingBytes = 0; this.sequenceEpoch++;
    this.processing?.controller.abort(); this.processing = null;
    this.cancel('event'); this.cancel('gap'); this.resumeAttempts = 0;
  }

  fail(code, fresh = false) {
    if (!this.running) return;
    this.lastError = code; this.connected = false;
    for (const name of ['hello', 'ping', 'pong', 'pingRetry', 'gap']) this.cancel(name);
    this.detachSocket();
    if (fresh) this.resetSession();
    if (this.timers.has('reconnect')) return;
    const canResume = this.session && this.gatewayUrl && this.resumeAttempts < 2;
    const delayMs = Math.min(this.reconnectMaxMs, canResume
      ? this.resumeBaseMs * 2 ** this.resumeAttempts
      : this.reconnectBaseMs * 2 ** Math.min(this.attempt, 8));
    this.attempt++;
    this.log('kook_gateway_reconnecting', { reason: code, delayMs });
    this.later('reconnect', () => { void this.connect(); }, delayMs);
  }

  receive(raw) {
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > this.maxFrameBytes) throw new GatewayFailure('invalid_frame');
      const packet = JSON.parse(raw);
      if (!packet || !Number.isInteger(packet.s)) throw new GatewayFailure('invalid_packet');
      switch (packet.s) {
        case 1:
          if (packet.d?.code !== 0 || typeof packet.d.session_id !== 'string' || !packet.d.session_id || packet.d.session_id.length > 512) {
            this.fail('hello_rejected', true); return;
          }
          this.session = packet.d.session_id; this.ready(); break;
        case 6:
          if (typeof packet.d?.session_id !== 'string' || !packet.d.session_id || packet.d.session_id.length > 512) throw new GatewayFailure('invalid_resume');
          this.session = packet.d.session_id; this.ready(); break;
        case 0:
          if (!this.session) throw new GatewayFailure('event_before_hello');
          this.enqueue(packet.sn, packet.d, Buffer.byteLength(raw)); break;
        case 3:
          if (!this.connected) return;
          this.lastPongAt = new Date(this.now()).toISOString();
          this.cancel('pong'); this.cancel('pingRetry'); this.pingRetries = 0; this.schedulePing(); break;
        case 5: this.fail('server_reconnect', true); break;
        default: break;
      }
    } catch (error) {
      this.fail(error instanceof GatewayFailure ? error.code : 'invalid_packet');
    }
  }

  ready() {
    this.cancel('hello'); this.cancel('reconnect');
    // A successful handshake does not prove that missing events were recovered.
    // Only an acknowledged event resets the consecutive resume budget.
    this.connected = true; this.attempt = 0;
    this.lastError = null; this.pingRetries = 0; this.schedulePing();
    this.watchGap();
    this.log('kook_gateway_connected');
  }
  schedulePing() {
    this.cancel('ping');
    const jitter = (this.random() * 2 - 1) * this.heartbeatJitterMs;
    this.later('ping', () => this.ping(), this.heartbeatMs + jitter);
  }
  ping() {
    if (!this.running || !this.connected || this.socket?.readyState !== 1) return;
    try { this.socket.send(JSON.stringify({ s: 2, sn: this.sn })); }
    catch { this.fail('ping_failed'); return; }
    this.later('pong', () => {
      if (this.pingRetries >= 2) { this.fail('heartbeat_timeout'); return; }
      const delay = this.pingRetryBaseMs * 2 ** this.pingRetries++;
      this.later('pingRetry', () => this.ping(), delay);
    }, this.pongTimeoutMs);
  }

  enqueue(sn, data, bytes) {
    if (!Number.isSafeInteger(sn) || sn < 1 || !data || typeof data !== 'object' || Array.isArray(data)) throw new GatewayFailure('invalid_event');
    this.observedSn = Math.max(this.observedSn, sn);
    if (sn <= this.sn || this.pending.has(sn)) return;
    const full = () => this.pending.size >= this.maxBufferedEvents || this.pendingBytes + bytes > this.maxBufferedBytes;
    if (sn === this.sn + 1 && bytes <= this.maxBufferedBytes && full()) {
      // Make room for the event that unblocks delivery. Evicted future events
      // remain covered by observedSn, so another gap requests their replay.
      for (const [futureSn, entry] of [...this.pending].sort((a, b) => b[0] - a[0])) {
        if (!full()) break;
        this.pending.delete(futureSn); this.pendingBytes -= entry.bytes;
      }
    }
    if (full()) throw new GatewayFailure('event_buffer_full');
    this.pending.set(sn, { data, bytes }); this.pendingBytes += bytes;
    this.deliverNext();
  }

  watchGap() {
    if (!this.running || !this.connected || this.processing || this.observedSn <= this.sn || this.pending.has(this.sn + 1)) {
      this.cancel('gap'); return;
    }
    // More out-of-order packets and healthy heartbeats must not extend this wait.
    if (this.timers.has('gap')) return;
    this.later('gap', () => this.fail('sequence_gap'), this.sequenceGapMs);
  }

  deliverNext() {
    this.watchGap();
    if (!this.running || this.processing || !this.pending.has(this.sn + 1)) return;
    const sn = this.sn + 1, epoch = this.sequenceEpoch;
    const entry = this.pending.get(sn), controller = new AbortController();
    const current = { controller, sn }; this.processing = current;
    let finish;
    const timeout = new Promise(resolve => { finish = resolve; });
    controller.signal.addEventListener('abort', () => finish(false), { once: true });
    this.later('event', () => { controller.abort(); finish(false); }, this.eventTimeoutMs);
    const handled = Promise.resolve().then(() => {
      if (controller.signal.aborted || !this.running || epoch !== this.sequenceEpoch) return;
      return this.onEvent(entry.data, { signal: controller.signal, botId: this.botId });
    })
      .then(() => true, () => false);
    // Handler errors/timeouts are consumed; consumers must handle their own user-facing errors.
    // This avoids infinite replays and duplicate replies when a side effect completed before rejection.
    void Promise.race([handled, timeout]).then(ok => {
      if (epoch !== this.sequenceEpoch || this.processing !== current) return;
      this.cancel('event'); this.processing = null;
      this.pending.delete(sn); this.pendingBytes -= entry.bytes; this.sn = sn; this.resumeAttempts = 0;
      if (!ok) this.log('kook_gateway_event_failed');
      this.deliverNext();
    });
  }
}
