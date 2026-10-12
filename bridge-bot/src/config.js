import path from 'node:path';
import { normalizeRepositories } from './repositories.js';

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 18997);
  const repositories = normalizeRepositories(env.GITHUB_REPOSITORIES ?? env.GITHUB_REPOSITORY);
  let repositoryTokens = Object.freeze({});
  if (env.GITHUB_REPOSITORY_TOKENS?.trim()) {
    let raw;
    try { raw = JSON.parse(env.GITHUB_REPOSITORY_TOKENS); } catch { throw new Error('Invalid repository tokens'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid repository tokens');
    const map = {};
    for (const [key, value] of Object.entries(raw)) {
      const canonical = repositories.find(item => item.toLowerCase() === key.toLowerCase());
      if (!canonical || Object.hasOwn(map, canonical) || typeof value !== 'string' || !/^\S{1,512}$/.test(value)) throw new Error('Invalid repository tokens');
      map[canonical] = value;
    }
    repositoryTokens = Object.freeze(map);
  }
  const repository = repositories[0], secret = env.GITHUB_WEBHOOK_SECRET?.trim();
  const token = env.KOOK_TOKEN?.trim(), channelId = env.KOOK_CHANNEL_ID?.trim();
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local listener');
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('Webhook secret must have 32-256 ASCII characters');
  if (typeof token !== 'string' || !/^\S{1,512}$/.test(token) || !/^\d{5,30}$/.test(channelId || '')) throw new Error('Invalid KOOK configuration');
  return { host, port, repository, repositories, repositoryTokens, secret, token, channelId, dataDir: path.resolve(env.DATA_DIR || './data') };
}
