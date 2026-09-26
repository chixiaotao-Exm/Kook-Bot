import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadConfig(env = process.env) {
  const token = env.KOOK_TOKEN?.trim(), channelIds = [...new Set((env.KOOK_CHANNEL_IDS || '').split(',').map(value => value.trim()).filter(Boolean))];
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token)) throw new Error('Invalid KOOK configuration');
  if (!channelIds.length || channelIds.length > 20 || channelIds.some(value => !/^\d{5,30}$/.test(value))) throw new Error('Invalid menu channel configuration');
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 18995);
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local listener');
  return { token, channelIds, host, port, dataDir: path.resolve(env.DATA_DIR || './data'),
    assetDir: path.resolve(env.MENU_ASSET_DIR || fileURLToPath(new URL('../assets/', import.meta.url))) };
}
