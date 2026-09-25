import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ID = /^[a-z][a-z0-9_-]{0,39}$/;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function id(value) { requireValue(typeof value === 'string' && ID.test(value), 'Invalid identifier'); return value; }
function label(value) { requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 100, 'Invalid label'); return value.trim(); }
function unique(items) { requireValue(new Set(items.map(item => item.id)).size === items.length, 'Duplicate identifier'); return items; }
export function validateConfig(raw, env = process.env) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid configuration');
  const publicUrl = new URL(env.PUBLIC_URL || 'https://api.chixiaotao.cn/ops/');
  requireValue(['http:', 'https:'].includes(publicUrl.protocol) && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash && publicUrl.pathname.endsWith('/'), 'Invalid public URL');
  const sub2apiUrl = new URL(env.SUB2API_URL || 'http://127.0.0.1:8080/');
  requireValue(['http:', 'https:'].includes(sub2apiUrl.protocol) && !sub2apiUrl.username && !sub2apiUrl.password, 'Invalid administrator origin');
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 18996);
  requireValue(['127.0.0.1', '::1'].includes(host) && Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid listener');
  requireValue(Array.isArray(raw.hosts) && raw.hosts.length <= 20 && Array.isArray(raw.monitors) && raw.monitors.length <= 40, 'Invalid target lists');
  const hosts = unique(raw.hosts.map(value => {
    requireValue(typeof value.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value.token), 'Invalid agent token');
    requireValue(Array.isArray(value.services) && value.services.length <= 30, 'Invalid service list');
    return { id: id(value.id), name: label(value.name), token: value.token, services: unique(value.services.map(service => {
      requireValue(typeof service.unit === 'string' && /^[a-zA-Z0-9_-]+\.service$/.test(service.unit), 'Invalid systemd unit');
      requireValue(['running', 'stopped'].includes(service.expected) && typeof service.restartAllowed === 'boolean', 'Invalid service policy');
      requireValue(!(service.expected === 'stopped' && service.restartAllowed), 'Stopped services cannot be restarted');
      return { id: id(service.id), name: label(service.name), unit: service.unit, expected: service.expected, restartAllowed: service.restartAllowed };
    })) };
  }));
  requireValue(new Set(hosts.map(value => value.token)).size === hosts.length, 'Agent tokens must be distinct');
  const monitors = unique(raw.monitors.map(value => {
    const url = new URL(value.url);
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search, 'Monitor URL cannot contain credentials or query parameters');
    requireValue(Number.isInteger(value.expectedStatus ?? 200) && (value.expectedStatus ?? 200) >= 200 && (value.expectedStatus ?? 200) < 600, 'Invalid expected status');
    requireValue(value.jsonPath === undefined || typeof value.jsonPath === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(value.jsonPath), 'Invalid JSON assertion');
    requireValue(value.jsonEquals === undefined || ['string', 'number', 'boolean'].includes(typeof value.jsonEquals) && String(value.jsonEquals).length <= 100, 'Invalid JSON expectation');
    return { id: id(value.id), name: label(value.name), url: url.href, expectedStatus: value.expectedStatus ?? 200,
      ...(value.jsonPath ? { jsonPath: value.jsonPath, jsonEquals: value.jsonEquals } : {}) };
  }));
  const token = env.KOOK_TOKEN?.trim() || '';
  requireValue(!token || /^\S{1,512}$/.test(token), 'Invalid KOOK token');
  return { host, port, publicUrl: publicUrl.href, sub2apiUrl: sub2apiUrl.href, hosts, monitors, token,
    publicManagement: env.PUBLIC_MANAGEMENT === 'true',
    channelIds: { infra: '4052889739856202', web: '7255160236021294' },
    dataDir: path.resolve(env.DATA_DIR || './data'), queryEnabled: env.KOOK_QUERY_ENABLED !== 'false',
    intervalMs: 60000, hostStaleMs: 120000, monitorStaleMs: 150000 };
}
export async function loadConfig(env = process.env) {
  return validateConfig(JSON.parse(await readFile(env.OPS_CONFIG_FILE || './config.json', 'utf8')), env);
}
