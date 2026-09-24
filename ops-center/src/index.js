import { loadConfig } from './config.js';
import { StateStore } from './storage.js';
import { OpsEngine } from './engine.js';
import { OpsServer } from './server.js';
import { probeMonitor } from './probes.js';
import { createKookSender } from './kook.js';
import { OpsQueryBot } from './kook-query.js';
import { ReportScheduler } from './report-scheduler.js';

const config = await loadConfig();
const store = await new StateStore({ dataDir: config.dataDir }).init();
const send = config.token ? createKookSender({ token: config.token, channelIds: config.channelIds, publicUrl: config.publicUrl }) : null;
const engine = new OpsEngine({ config, store, probe: probeMonitor, send });
const reports = new ReportScheduler({ store, getSnapshot: () => engine.snapshot(), send });
engine.reportStatus = () => reports.snapshot();
const query = config.token && config.queryEnabled ? new OpsQueryBot({ token: config.token, channelIds: config.channelIds,
  getSnapshot: () => engine.snapshot(), sendReply: send, logger: () => {} }) : null;
if (query) engine.queryBotStatus = () => query.status();
const server = new OpsServer({ config, engine });
await server.start(); engine.start(); if (query) await query.start();
await reports.start();
console.log(JSON.stringify({ event: 'ops_started', port: config.port, hosts: config.hosts.length, monitors: config.monitors.length }));
let closing = false;
async function close() {
  if (closing) return; closing = true; const timer = setTimeout(() => process.exit(1), 20000);
  await Promise.allSettled([query?.close(), server.close(), (async () => { await reports.close(); await engine.close(); })()]); clearTimeout(timer); process.exit(0);
}
process.once('SIGTERM', close); process.once('SIGINT', close);
