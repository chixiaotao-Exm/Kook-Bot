import http from 'node:http';
import { loadConfig } from './config.js';
import { loadMenu } from './menu-assets.js';
import { MenuBot } from './menu-bot.js';
import { createMenuSender } from './kook-menu.js';
import { createTextSender } from './kook-text.js';

const config = loadConfig(), menu = await loadMenu(config.assetDir);
const sendMenu = createMenuSender({ token: config.token, channelIds: config.channelIds, pages: menu.pages });
const sendText = createTextSender({ token: config.token, channelIds: config.channelIds });
const bot = await new MenuBot({ token: config.token, channelIds: config.channelIds, pageCount: menu.pages.length,
  sendMenu, sendText, dataDir: config.dataDir, logger: entry => console.log(JSON.stringify(entry)) }).init();
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404); response.end(); return; }
  const value = bot.status(), connected = value.connected === true || value.gateway?.connected === true;
  const ok = value.enabled === true && connected;
  response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ ok, pages: menu.pages.length, gateway: { connected }, chat: { enabled: value.enabled }, bot: value }));
});
server.headersTimeout = 5000; server.requestTimeout = 10000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 20000);
  server.closeAllConnections();
  await Promise.allSettled([bot.close(), new Promise(resolve => server.close(resolve))]);
  clearTimeout(timer); process.exit(0);
}
process.once('SIGTERM', close); process.once('SIGINT', close);
await bot.start();
console.log(JSON.stringify({ event: 'menu_started', pages: menu.pages.length, channels: config.channelIds.length }));
