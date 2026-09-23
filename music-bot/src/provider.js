import { Worker } from 'node:worker_threads';

const methods = ['cloudsearch', 'song_detail', 'song_url_v1', 'lyric', 'playlist_detail', 'playlist_track_all', 'login_qr_key', 'login_qr_create', 'login_qr_check', 'user_account', 'top_playlist', 'toplist', 'user_playlist', 'playmode_intelligence_list'];

// Keep upstream console output and stalled requests outside the bot process.
export function createProvider() {
  let worker; let sequence = 0;
  const pending = new Map();
  const fail = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Provider unavailable')); }
    pending.clear();
  };
  const close = () => {
    const previous = worker; worker = null; fail();
    if (previous) void previous.terminate();
  };
  const start = () => {
    const instance = new Worker(new URL('./provider-worker.js', import.meta.url), { stdout: true, stderr: true });
    worker = instance;
    instance.stdout.resume(); instance.stderr.resume();
    instance.on('error', () => { if (worker === instance) close(); });
    instance.on('exit', () => { if (worker === instance) { worker = null; fail(); } });
    instance.on('message', ({ id, ok, body }) => {
      const item = pending.get(id); if (!item) return;
      pending.delete(id); clearTimeout(item.timer);
      if (ok) item.resolve({ body }); else item.reject(new Error('Provider request failed'));
    });
  };
  const sdk = { close };
  for (const name of methods) sdk[name] = (params) => new Promise((resolve, reject) => {
    if (!worker) start();
    const id = ++sequence;
    const timer = setTimeout(close, 18000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, name, params });
  });
  return sdk;
}
