import { spawn } from 'node:child_process';
import { Audio } from './audio.js';
import { UserError } from './util.js';

const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 8;
const FRAME_MS = 20;
const FRAME_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS / 1000;
const MAX_BUFFER_BYTES = FRAME_BYTES * 8;
const SILENCE = Buffer.alloc(FRAME_BYTES);

export class PersistentAudio {
  constructor(executable, { audio = new Audio(executable), spawnImpl = spawn } = {}) {
    Object.assign(this, { executable, audio, spawn: spawnImpl });
    this.sender = null; this.source = null; this.ready = false; this.volume = null;
    this.connecting = null; this.pumpTimer = null; this.blocked = false;
    this.nextFrameAt = 0;
    this.pendingStops = new Set();
  }
  get connected() { return Boolean(this.ready && this.sender && !this.sender.input.destroyed); }
  async connect(voice, volume) {
    if (this.connected) { if (this.volume !== volume) await this.setVolume(volume); return; }
    if (this.connecting) return this.connecting;
    const connecting = this.openTransport(voice, volume);
    this.connecting = connecting;
    try { await connecting; } finally { if (this.connecting === connecting) this.connecting = null; }
  }
  async openTransport(voice, volume) {
    let sender;
    sender = this.audio.startPcm(voice, volume, () => this.transportFailed(sender));
    this.sender = sender; this.volume = volume; this.ready = false; this.blocked = false;
    this.nextFrameAt = performance.now();
    sender.input.on('drain', () => {
      if (this.sender !== sender || !this.blocked) return;
      this.blocked = false; this.nextFrameAt = performance.now() + FRAME_MS; this.schedulePump();
    });
    this.pump();
    const deadline = Date.now() + 8000;
    while (this.sender === sender && sender.seconds <= 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.sender !== sender || sender.seconds <= 0) {
      if (this.sender === sender) await this.disconnect();
      throw new UserError('持续语音推流启动失败，请检查 FFmpeg 和语音网络。');
    }
    this.ready = true;
  }
  transportFailed(sender) {
    if (this.sender !== sender) return;
    this.sender = null; this.ready = false; this.blocked = false;
    clearTimeout(this.pumpTimer); this.pumpTimer = null;
    this.source?.finish(new UserError('语音推流连接中断，正在保留当前进度。'));
    void this.trackStop(sender.stop());
  }
  trackStop(promise) {
    this.pendingStops.add(promise);
    void promise.then(() => this.pendingStops.delete(promise), () => this.pendingStops.delete(promise));
    return promise;
  }
  schedulePump() {
    clearTimeout(this.pumpTimer);
    if (this.sender && !this.blocked) this.pumpTimer = setTimeout(() => this.pump(), Math.max(1, this.nextFrameAt - performance.now()));
  }
  pump() {
    this.pumpTimer = null;
    const sender = this.sender;
    if (!sender || this.blocked) return;
    let frame = SILENCE; let consumed = 0;
    const source = this.source;
    if (source && !source.paused && !source.done) {
      const data = source.readFrame();
      if (data?.length) {
        consumed = data.length;
        frame = data.length === FRAME_BYTES ? data : Buffer.concat([data, SILENCE.subarray(data.length)]);
      } else if (source.outputEnded) source.finish(null);
    }
    try {
      this.blocked = !sender.input.write(frame);
      if (consumed && source && !source.done) {
        source.seconds += consumed / (SAMPLE_RATE * BYTES_PER_SAMPLE);
        source.lastProgress = Date.now();
      }
    } catch { this.transportFailed(sender); return; }
    this.nextFrameAt += FRAME_MS;
    if (this.nextFrameAt <= performance.now()) this.nextFrameAt = performance.now() + FRAME_MS;
    this.schedulePump();
  }
  async setVolume(value) {
    const sender = this.sender;
    if (!this.connected) throw new UserError('语音推流连接尚未就绪。');
    if (this.volume === value) return;
    await sender.setVolume(value);
    if (this.sender !== sender) throw new UserError('语音推流连接已更换，请重试音量调整。');
    this.volume = value;
  }
  start(media, voice, volume, offset, onEnd) {
    if (!this.connected) throw new UserError('请先连接语音推流。');
    if (this.source) throw new UserError('上一首歌曲尚未停止。');
    const child = this.spawn(this.executable, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '15000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
      ...(offset > 0 ? ['-ss', offset.toFixed(3)] : []), '-i', media,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    let exited = false; let stopPromise = null; let close;
    const closed = new Promise((resolve) => { close = resolve; });
    const source = { child, seconds: offset, paused: false, done: false, outputEnded: false, lastProgress: Date.now(), chunks: [], bufferedBytes: 0 };
    source.readFrame = () => {
      if (!source.bufferedBytes || (source.bufferedBytes < FRAME_BYTES && !source.outputEnded)) return null;
      const size = Math.min(FRAME_BYTES, source.bufferedBytes); const frame = Buffer.allocUnsafe(size);
      let copied = 0;
      while (copied < size) {
        const chunk = source.chunks[0]; const count = Math.min(size - copied, chunk.length);
        chunk.copy(frame, copied, 0, count); copied += count;
        if (count === chunk.length) source.chunks.shift(); else source.chunks[0] = chunk.subarray(count);
      }
      source.bufferedBytes -= size;
      if (!source.paused && !source.outputEnded && source.bufferedBytes < MAX_BUFFER_BYTES / 2) child.stdout.resume();
      return frame;
    };
    const stopDecoder = () => {
      if (stopPromise) return stopPromise;
      stopPromise = this.trackStop((async () => {
        child.stdout.destroy();
        if (exited) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        await closed; clearTimeout(timer);
      })());
      return stopPromise;
    };
    source.finish = (error) => {
      if (source.done) return;
      source.done = true; clearInterval(watchdog);
      if (this.source === source) this.source = null;
      if (error) void stopDecoder();
      onEnd(error);
    };
    source.stop = async () => {
      source.done = true; clearInterval(watchdog);
      if (this.source === source) this.source = null;
      source.chunks = []; source.bufferedBytes = 0;
      await stopDecoder();
    };
    source.pause = () => {
      if (source.done) throw new UserError('歌曲已结束，无法暂停。');
      source.paused = true; child.stdout.pause();
    };
    source.resume = () => {
      if (source.done) throw new UserError('歌曲已结束，无法继续。');
      source.paused = false; source.lastProgress = Date.now();
      if (source.bufferedBytes < MAX_BUFFER_BYTES) child.stdout.resume();
    };
    source.setVolume = (value) => {
      if (source.done) return Promise.reject(new UserError('歌曲已结束，无法调整音量。'));
      return this.setVolume(value);
    };
    child.stderr.resume();
    // ChildProcess may resume stdout on exit; a data handler retains every final PCM byte.
    child.stdout.on('data', (chunk) => {
      if (source.done) return;
      source.chunks.push(chunk); source.bufferedBytes += chunk.length;
      if (source.paused || source.bufferedBytes >= MAX_BUFFER_BYTES) child.stdout.pause();
    });
    child.stdout.once('end', () => { source.outputEnded = true; });
    child.once('error', () => source.finish(new UserError('音频解码启动失败，请检查 FFmpeg。')));
    child.once('exit', (code) => {
      if (code !== 0 && !source.done) source.finish(new UserError('音源读取失败，正在保留当前进度。'));
    });
    child.once('close', () => { exited = true; close(); });
    const watchdog = setInterval(() => {
      if (!source.paused && !source.done && Date.now() - source.lastProgress > 45000) {
        source.finish(new UserError('音源读取超时，正在保留当前进度。'));
      }
    }, 5000);
    this.source = source;
    return source;
  }
  async disconnect() {
    const sender = this.sender; this.sender = null; this.ready = false; this.blocked = false;
    clearTimeout(this.pumpTimer); this.pumpTimer = null;
    await this.source?.stop();
    if (sender) await sender.stop();
    await Promise.all([...this.pendingStops]);
  }
}
