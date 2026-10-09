import { setTimeout as sleep } from 'node:timers/promises';
import { browserAvailable, createBrowserSubmitter, validBrowserUrl } from './browser.js';

export function browserConfiguration(env = process.env) {
  const pooled = Boolean(env.REPORT_BROWSER_URLS?.trim());
  const baseUrls = pooled ? env.REPORT_BROWSER_URLS.split(',').map(value => value.trim())
    : env.REPORT_BROWSER_URL?.trim() ? [env.REPORT_BROWSER_URL.trim()] : [];
  if (baseUrls.length > 4 || baseUrls.some(value => !validBrowserUrl(value)) || new Set(baseUrls).size !== baseUrls.length)
    throw Error('Invalid browser worker URLs');
  const raw = env.REPORT_CONCURRENCY?.trim() || '1';
  if (!/^[1-4]$/.test(raw)) throw Error('REPORT_CONCURRENCY must be between 1 and 4');
  const concurrency = Number(raw);
  if (baseUrls.length && concurrency > baseUrls.length) throw Error('Not enough independent browser workers');
  return { baseUrls, concurrency, pooled };
}

/** Each worker owns a separate loopback adapter; cookies, browser and SID never cross workers. */
export function createBrowserPool({ baseUrls, token, enabled, fetchImpl = fetch,
  readyTimeoutMs = 30000, probeTimeoutMs = 2000, pollIntervalMs = 250, submitOptions = {} } = {}) {
  if (!Array.isArray(baseUrls) || !baseUrls.length || baseUrls.length > 4 || baseUrls.some(value => !validBrowserUrl(value))
    || new Set(baseUrls).size !== baseUrls.length || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
    || typeof enabled !== 'boolean') throw Error('Invalid browser pool configuration');
  for (const timeout of [readyTimeoutMs, probeTimeoutMs, pollIntervalMs])
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('Invalid browser pool timeout');
  const endpoints = [...baseUrls], busy = new Set();
  const endpoint = index => {
    if (!Number.isInteger(index) || index < 0 || index >= endpoints.length) throw Error('Invalid browser worker');
    return endpoints[index];
  };
  return {
    size: endpoints.length,
    async ready(workerIndex, { signal } = {}) {
      const baseUrl = endpoint(workerIndex);
      if (busy.has(workerIndex) || !enabled) return false;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), readyTimeoutMs);
      const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        while (!active.aborted) {
          try { if (await browserAvailable(baseUrl, { signal: active, fetchImpl, timeoutMs: probeTimeoutMs })) return true; }
          catch { /* Probe only: an unavailable slot never consumes an account or replays a POST. */ }
          await sleep(pollIntervalMs, undefined, { signal: active });
        }
      } catch { /* Cancellation leaves the slot unclaimed. */ }
      finally { clearTimeout(timer); controller.abort(); }
      return false;
    },
    async submit(draft, { profile, workerIndex, signal } = {}) {
      const baseUrl = endpoint(workerIndex);
      if (busy.has(workerIndex)) return { kind: 'not_sent' };
      busy.add(workerIndex);
      try {
        return await createBrowserSubmitter(profile, enabled, { ...submitOptions, baseUrl, token, fetchImpl })(draft, { signal });
      } finally { busy.delete(workerIndex); }
    }
  };
}
