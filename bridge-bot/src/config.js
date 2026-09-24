import path from 'node:path';

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 18997);
  const repository = env.GITHUB_REPOSITORY?.trim(), secret = env.GITHUB_WEBHOOK_SECRET?.trim();
  const token = env.KOOK_TOKEN?.trim(), channelId = env.KOOK_CHANNEL_ID?.trim();
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local listener');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid repository');
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('Webhook secret must have 32-256 ASCII characters');
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token) || !/^\d{5,30}$/.test(channelId || '')) throw new Error('Invalid KOOK configuration');
  return { host, port, repository, secret, token, channelId, dataDir: path.resolve(env.DATA_DIR || './data') };
}
