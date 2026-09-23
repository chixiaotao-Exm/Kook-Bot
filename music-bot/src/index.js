import { readConfig } from './config.js';
import { MusicSources } from './music-sources.js';
import { BotManager } from './bot-manager.js';
import { log } from './util.js';
import { WebConsole } from './web.js';
import { Diagnostics } from './diagnostics.js';
import { RoomAccess } from './room-access.js';
import { SocialRooms } from './social-rooms.js';

let manager, music, web, diagnostics, access, rooms, shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  try { await web?.close(); await rooms?.close(); await diagnostics?.close(); await manager?.shutdown(); } catch { exitCode = 1; log('shutdown_failed'); }
  music?.close();
  clearTimeout(deadline); process.exit(exitCode);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.on('unhandledRejection', () => { log('unhandled_rejection'); void shutdown(1); });
process.on('uncaughtException', () => { log('uncaught_exception'); void shutdown(1); });

async function main() {
  const config = readConfig();
  music = new MusicSources(config); await music.init();
  manager = new BotManager(config, music); await manager.init();
  access = new RoomAccess({ dataDir: config.dataDir }); await access.init();
  rooms = new SocialRooms({ config, manager, music, access }); await rooms.init(); rooms.start();
  diagnostics = new Diagnostics(config, manager, music); await diagnostics.init(); diagnostics.start();
  if (config.webEnabled) {
    web = new WebConsole({ config, music, manager, diagnostics, access, rooms });
    await web.start();
  }
}
main().catch(() => { log('startup_failed'); void shutdown(1); });
