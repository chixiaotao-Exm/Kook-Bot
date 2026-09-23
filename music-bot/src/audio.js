import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { UserError } from './util.js';

export function audioArgs(media, voice, volume, offset = 0, { pcm = false } = {}) {
  const number = (value, min, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid KOOK voice parameters');
    return n;
  };
  if (!isIP(voice.ip)) throw new Error('Invalid KOOK media IP');
  const ip = isIP(voice.ip) === 6 ? `[${voice.ip}]` : voice.ip;
  const port = number(voice.port, 1, 65535);
  const rtcp = voice.rtcp_mux ? port : number(voice.rtcp_port, 1, 65535);
  const bitrate = number(voice.bitrate, 6000, 512000);
  const ssrc = number(voice.audio_ssrc, 0, 4294967295);
  const pt = number(voice.audio_pt, 0, 127);
  const output = `[select=a:f=rtp:ssrc=${ssrc}:payload_type=${pt}]rtp://${ip}:${port}?rtcpport=${rtcp}&pkt_size=1200`;
  // The async wrapper keeps FFmpeg from treating pipe:3 as interactive stdin.
  const input = pcm ? ['-f', 'f32le', '-ar', '48000', '-ac', '2', '-probesize', '32', '-analyzeduration', '0', '-re', '-i', 'async:pipe:3'] : [
    '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '15000000',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
    '-re', ...(offset > 0 ? ['-ss', offset.toFixed(3)] : []), '-i', media];
  return ['-hide_banner', '-loglevel', 'error', ...input, '-stdin',
    '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', String(bitrate),
    '-vbr', 'off', '-ac', '2', '-ar', '48000', '-af', `volume@kookvolume=${volume / 100}`,
    '-progress', 'pipe:1', '-nostats', '-f', 'tee', output];
}

export class Audio {
  constructor(executable, { spawnImpl = spawn, volumeTimeoutMs = 3000 } = {}) {
    Object.assign(this, { executable, spawn: spawnImpl, volumeTimeoutMs });
  }
  start(media, voice, volume, offset, onEnd) {
    return this.startProcess(audioArgs(media, voice, volume, offset), offset, onEnd);
  }
  startPcm(voice, volume, onEnd) {
    return this.startProcess(audioArgs('', voice, volume, 0, { pcm: true }), 0, onEnd, true);
  }
  startProcess(args, offset, onEnd, pcm = false) {
    const child = this.spawn(this.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe', ...(pcm ? ['pipe'] : [])], windowsHide: true, shell: false,
    });
    let remainder = ''; let intentional = false; let settled = false;
    let stderrRemainder = ''; let pendingVolume = null; let volumeFailure = null;
    let volumeTail = Promise.resolve();
    const handle = { child, seconds: offset, paused: false, lastProgress: Date.now() };
    if (pcm) {
      handle.input = child.stdio[3];
      handle.input.on('error', () => child.kill('SIGTERM'));
    }
    let finish;
    const closed = new Promise((resolve) => { finish = resolve; });
    const completeVolume = (error) => {
      const pending = pendingVolume; pendingVolume = null;
      if (!pending) return;
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve();
    };
    const disableVolume = (error) => {
      volumeFailure ||= error;
      completeVolume(volumeFailure);
    };
    const done = (error) => {
      if (settled) return;
      settled = true; clearInterval(watchdog); finish();
      disableVolume(new UserError('音频进程已结束，无法调整音量。'));
      if (!intentional) onEnd(error);
    };
    child.stdout.on('data', (chunk) => {
      remainder += chunk.toString();
      const lines = remainder.split('\n'); remainder = lines.pop().slice(-2000);
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const seconds = Number(line.slice(12)) / 1e6;
          if (Number.isFinite(seconds)) { handle.seconds = offset + seconds; handle.lastProgress = Date.now(); }
        }
      }
    });
    // Parse only command acknowledgements; never expose signed media URLs from stderr.
    child.stderr.on('data', (chunk) => {
      stderrRemainder += chunk.toString();
      const lines = stderrRemainder.split('\n'); stderrRemainder = lines.pop().slice(-2000);
      for (const line of lines) {
        const reply = /Command reply for stream \d+: ret:(-?\d+)\b/.exec(line);
        if (reply && pendingVolume) completeVolume(reply[1] === '0' ? null : new UserError('当前音频不支持实时音量调整。'));
      }
    });
    child.stdin.on('error', () => disableVolume(new UserError('音量控制连接已关闭，当前播放会继续。')));
    child.once('error', () => done(new UserError('FFmpeg 启动失败，请运行 npm run doctor 检查。')));
    child.once('close', (code) => done(code === 0 ? null : new UserError('音频推流失败，请检查音源、FFmpeg 和出站 UDP 网络。')));
    const watchdog = setInterval(() => {
      if (!handle.paused && Date.now() - handle.lastProgress > 45000) child.kill('SIGKILL');
    }, 5000);
    handle.stop = async () => {
      intentional = true;
      disableVolume(new UserError('音频正在停止，无法调整音量。'));
      if (!settled) {
        if (handle.paused) child.kill('SIGCONT');
        if (pcm && !handle.input.destroyed) {
          if (!handle.input.writableEnded) handle.input.end();
        } else child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        await closed; clearTimeout(timer);
      }
    };
    handle.pause = () => {
      if (process.platform === 'win32') throw new UserError('暂停功能需要 Linux 系统。');
      if (!child.kill('SIGSTOP')) throw new UserError('暂停失败，音频进程已结束。');
      handle.paused = true;
    };
    handle.resume = () => {
      if (!child.kill('SIGCONT')) throw new UserError('继续播放失败，音频进程已结束。');
      handle.paused = false; handle.lastProgress = Date.now();
    };
    handle.setVolume = (value) => {
      const update = volumeTail.then(() => {
        if (!Number.isInteger(value) || value < 0 || value > 100) throw new UserError('音量范围为 0-100。');
        if (volumeFailure) throw volumeFailure;
        if (intentional || settled || child.stdin.destroyed || !child.stdin.writable) throw new UserError('音频进程已结束，无法调整音量。');
        if (handle.paused) throw new UserError('暂停时无法实时调整音量。');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            // A late acknowledgement has no request ID, so this channel cannot be reused.
            disableVolume(new UserError('音量调整超时，当前播放会继续；音量已保存，语音重连后生效。'));
          }, this.volumeTimeoutMs);
          pendingVolume = { resolve, reject, timer };
          try {
            child.stdin.write(`cvolume@kookvolume -1 volume ${(value / 100).toFixed(2)}\n`, (error) => {
              if (error) disableVolume(new UserError('音量控制发送失败，当前播放会继续。'));
            });
          } catch {
            disableVolume(new UserError('音量控制发送失败，当前播放会继续。'));
          }
        });
      });
      volumeTail = update.catch(() => {});
      return update;
    };
    return handle;
  }
}
