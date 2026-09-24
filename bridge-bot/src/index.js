import { loadConfig } from './config.js';
import { BridgeServer } from './server.js';
import { NotificationQueue } from './queue.js';
import { validNotification } from './events.js';
import { createKookSender } from './kook.js';

const config = loadConfig();
const log = entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
const send = createKookSender({ token: config.token, channelId: config.channelId, repository: config.repository });
const queue = await new NotificationQueue({ dataDir: config.dataDir, send,
  validate: value => validNotification(value, config.repository) }).init();
const server = new BridgeServer({ host: config.host, port: config.port, repository: config.repository, secret: config.secret, queue, logger: log });
await server.start(); queue.start();
log({ event: 'bridge_started', port: config.port });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 20000);
  await Promise.allSettled([server.close(), queue.close()]); clearTimeout(timer); process.exit(0);
}
process.once('SIGTERM', close); process.once('SIGINT', close);
