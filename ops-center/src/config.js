import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configuredChannels } from './channels.js';

const ID = /^[a-z][a-z0-9_-]{0,39}$/;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function id(value) { requireValue(typeof value === 'string' && ID.test(value), 'Invalid identifier'); return value; }
function label(value) { requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 100, 'Invalid label'); return value.trim(); }
function unique(items) { requireValue(new Set(items.map(item => item.id)).size === items.length, 'Duplicate identifier'); return items; }
export function validateConfig(raw, env = process.env) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid configuration');
  const publicUrl = new URL(env.PUBLIC_URL || 'https://example.com/ops/');
  requireValue(['http:', 'https:'].includes(publicUrl.protocol) && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash && publicUrl.pathname.endsWith('/'), 'Invalid public URL');
  const sub2apiUrl = new URL(env.SUB2API_URL || 'http://127.0.0.1:8080/');
  requireValue(['http:', 'https:'].includes(sub2apiUrl.protocol) && !sub2apiUrl.username && !sub2apiUrl.password, 'Invalid administrator origin');
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 18996);
  requireValue(['127.0.0.1', '::1'].includes(host) && Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid listener');
  requireValue(Array.isArray(raw.hosts) && raw.hosts.length <= 20 && Array.isArray(raw.monitors) && raw.monitors.length <= 40, 'Invalid target lists');
  const hosts = unique(raw.hosts.map(value => {
    requireValue(typeof value.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value.token), 'Invalid agent token');
    requireValue(Array.isArray(value.services) && value.services.length <= 30, 'Invalid service list');
    requireValue(value.repairBindings===undefined||Array.isArray(value.repairBindings), 'Invalid repair bindings');
    return { id: id(value.id), name: label(value.name), token: value.token, services: unique(value.services.map(service => {
      requireValue(typeof service.unit === 'string' && /^[a-zA-Z0-9_-]+\.service$/.test(service.unit), 'Invalid systemd unit');
      requireValue(['running', 'stopped'].includes(service.expected) && typeof service.restartAllowed === 'boolean', 'Invalid service policy');
      requireValue(!(service.expected === 'stopped' && service.restartAllowed), 'Stopped services cannot be restarted');
      requireValue(service.autoRepair === undefined || typeof service.autoRepair === 'boolean', 'Invalid automatic repair policy');
      requireValue(!service.autoRepair || service.expected === 'running' && service.restartAllowed, 'Automatic repair requires a restartable running service');
      return { id: id(service.id), name: label(service.name), unit: service.unit, expected: service.expected, restartAllowed: service.restartAllowed, autoRepair: service.autoRepair === true };
    })), repairBindings: (value.repairBindings || []).map(binding => ({ probeId: id(binding.probeId), serviceId: id(binding.serviceId) })) };
  }));
  for (const item of hosts) {
    requireValue(item.repairBindings.length <= 30 && new Set(item.repairBindings.map(binding => binding.probeId)).size === item.repairBindings.length, 'Invalid repair bindings');
    for (const binding of item.repairBindings) requireValue(item.services.some(service => service.id === binding.serviceId && service.autoRepair), 'Repair binding requires an automatically repairable service');
  }
  requireValue(new Set(hosts.map(value => value.token)).size === hosts.length, 'Agent tokens must be distinct');
  const localHostId=raw.localHostId===undefined?null:id(raw.localHostId);
  requireValue(localHostId===null||hosts.some(host=>host.id===localHostId),'Invalid local host');
  const monitors = unique(raw.monitors.map(value => {
    const url = new URL(value.url);
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search, 'Monitor URL cannot contain credentials or query parameters');
    requireValue(Number.isInteger(value.expectedStatus ?? 200) && (value.expectedStatus ?? 200) >= 200 && (value.expectedStatus ?? 200) < 600, 'Invalid expected status');
    requireValue(value.jsonPath === undefined || typeof value.jsonPath === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(value.jsonPath), 'Invalid JSON assertion');
    requireValue(value.jsonEquals === undefined || ['string', 'number', 'boolean'].includes(typeof value.jsonEquals) && String(value.jsonEquals).length <= 100, 'Invalid JSON expectation');
    let repairTarget;
    if (value.repairTarget !== undefined) {
      const target = value.repairTarget;
      requireValue(target && typeof target === 'object' && hosts.some(host => host.id === target.hostId && host.services.some(service => service.id === target.serviceId && service.autoRepair)), 'Invalid monitor repair target');
      requireValue(localHostId!==null&&target.hostId===localHostId,'Monitor repair target must belong to the local host');
      requireValue(['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname), 'Automatic monitor repair requires a local health endpoint');
      repairTarget = { hostId: target.hostId, serviceId: target.serviceId };
    }
    return { id: id(value.id), name: label(value.name), url: url.href, expectedStatus: value.expectedStatus ?? 200,
      ...(repairTarget ? { repairTarget } : {}),
      ...(value.jsonPath ? { jsonPath: value.jsonPath, jsonEquals: value.jsonEquals } : {}) };
  }));
  const token = env.KOOK_TOKEN?.trim() || '';
  requireValue(!token || /^\S{1,512}$/.test(token), 'Invalid KOOK token');
  const channelIds = configuredChannels({ infra: env.KOOK_INFRA_CHANNEL_ID ?? '', web: env.KOOK_WEB_CHANNEL_ID ?? '' }, { required: Boolean(token) });
  return { host, port, publicUrl: publicUrl.href, sub2apiUrl: sub2apiUrl.href, hosts, monitors, token, localHostId,
    publicManagement: env.PUBLIC_MANAGEMENT === 'true',
    channelIds,
    dataDir: path.resolve(env.DATA_DIR || './data'), queryEnabled: env.KOOK_QUERY_ENABLED !== 'false',
    intervalMs: 60000, hostStaleMs: 120000, monitorStaleMs: 150000 };
}
export async function loadConfig(env = process.env) {
  return validateConfig(JSON.parse(await readFile(env.OPS_CONFIG_FILE || './config.json', 'utf8')), env);
}
