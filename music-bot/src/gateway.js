import WebSocket from 'ws';
import { log } from './util.js';

export class SequenceBuffer {
  constructor(deliver) { this.deliver = deliver; this.reset(); }
  reset() { this.sn = 0; this.pending = new Map(); }
  push(sn, data) {
    if (!Number.isSafeInteger(sn) || sn <= this.sn) return;
    if (sn - this.sn > 1000 || this.pending.size >= 1000) throw new Error('Gateway sequence buffer overflow');
    this.pending.set(sn, data);
    while (this.pending.has(this.sn + 1)) {
      if (this.deliver(this.pending.get(this.sn + 1)) === false) throw new Error('Command inbox full');
      this.pending.delete(++this.sn);
    }
  }
}

export class Gateway {
  constructor(api, onEvent, { Socket = WebSocket } = {}) {
    this.api = api; this.Socket = Socket; this.sequence = new SequenceBuffer(onEvent);
    this.stopped = true; this.session = ''; this.url = ''; this.attempt = 0; this.timers = new Set();
  }
  later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer); return timer;
  }
  cancel(timer) { clearTimeout(timer); this.timers.delete(timer); }
  clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  start() { this.stopped = false; void this.connect(); }
  async connect() {
    if (this.stopped) return;
    try {
      const resume = Boolean(this.session && this.url && this.attempt <= 2);
      if (!resume) {
        this.session = ''; this.sequence.reset();
        this.url = (await this.api.request('gateway/index', { compress: 0 })).url;
      }
      if (this.stopped) return;
      const url = new URL(this.url);
      if (url.protocol !== 'wss:') throw new Error('Gateway must use TLS');
      if (resume) {
        url.searchParams.set('resume', '1'); url.searchParams.set('sn', this.sequence.sn);
        url.searchParams.set('session_id', this.session);
      }
      const socket = new this.Socket(url, { handshakeTimeout: 6000, maxPayload: 2 * 1024 * 1024 });
      this.socket = socket;
      let helloTimer;
      socket.on('open', () => { helloTimer = this.later(() => socket.terminate(), 6000); });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.clearTimers(); this.ready = false;
        if (!this.stopped) this.scheduleReconnect();
      });
      socket.on('message', (raw) => {
        if (this.stopped || this.socket !== socket) return;
        try {
          const packet = JSON.parse(raw.toString());
          switch (packet.s) {
            case 1:
              if (packet.d?.code !== 0) { this.session = ''; socket.terminate(); break; }
              this.cancel(helloTimer);
              this.session = packet.d.session_id || this.session;
              this.connected();
              break;
            case 0: this.sequence.push(packet.sn, packet.d); break;
            case 3:
              this.cancel(this.pongTimer); this.cancel(this.retryTimer);
              this.pingRetries = 0; this.schedulePing();
              break;
            case 5:
              this.session = ''; this.url = ''; this.sequence.reset(); socket.terminate();
              break;
            case 6:
              this.cancel(helloTimer);
              this.session = packet.d?.session_id || this.session;
              this.connected();
              break;
          }
        } catch {
          log('gateway_packet_error'); socket.terminate();
        }
      });
    } catch {
      if (!this.stopped) this.scheduleReconnect();
    }
  }
  connected() {
    this.attempt = 0; this.ready = true; this.pingRetries = 0;
    this.schedulePing(); log('gateway_connected');
  }
  schedulePing() {
    this.cancel(this.pingTimer);
    this.pingTimer = this.later(() => this.ping(), 25000 + Math.random() * 10000);
  }
  ping() {
    if (this.stopped || this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ s: 2, sn: this.sequence.sn }));
    this.cancel(this.pongTimer);
    this.pongTimer = this.later(() => {
      if ((this.pingRetries || 0) >= 2) { this.socket.terminate(); return; }
      this.retryTimer = this.later(() => this.ping(), 2000 * 2 ** this.pingRetries++);
    }, 6000);
  }
  scheduleReconnect() {
    const ms = Math.min(60000, 2000 * 2 ** this.attempt++);
    log('gateway_reconnecting', { delayMs: ms });
    this.later(() => { void this.connect(); }, ms);
  }
  stop() {
    this.stopped = true; this.ready = false; this.clearTimers(); this.socket?.terminate();
  }
}
