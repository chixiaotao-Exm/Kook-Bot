import { loadConfig } from './config.js';
import { BridgeServer } from './server.js';
import { NotificationQueue } from './queue.js';
import { createRepositoryRouter } from './routing.js';

const config = loadConfig();
const log = entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
const router = createRepositoryRouter({ token: config.token, repositoryTokens: config.repositoryTokens, channelId: config.channelId, repositories: config.repositories });
const queue = await new NotificationQueue({ dataDir: config.dataDir, send: router.send, validate: router.validate }).init();
const server = new BridgeServer({ host: config.host, port: config.port, repositories: config.repositories, secret: config.secret, queue, logger: log });
await server.start(); queue.start();
log({ event: 'bridge_started', port: config.port });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 20000);
  await Promise.allSettled([server.close(), queue.close()]); clearTimeout(timer); process.exit(0);
}
process.once('SIGTERM', close); process.once('SIGINT', close);
