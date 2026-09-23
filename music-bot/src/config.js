import path from 'node:path';

export function readConfig(env = process.env, { requireToken = true } = {}) {
  const list = (name) => new Set((env[name] || '').split(',').map((s) => s.trim()).filter(Boolean));
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
    return value;
  };
  const config = {
    token: env.KOOK_TOKEN?.trim() || '',
    guilds: list('ALLOWED_GUILD_IDS'), textChannels: list('ALLOWED_TEXT_CHANNEL_IDS'),
    admins: list('ADMIN_USER_IDS'), prefix: env.COMMAND_PREFIX || '/',
    dataDir: path.resolve(env.DATA_DIR || './data'), ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    volume: integer('DEFAULT_VOLUME', 60, 0, 100),
    maxQueue: integer('MAX_QUEUE_SIZE', 100, 1, 500),
    idleMs: integer('IDLE_TIMEOUT_SECONDS', 300, 30, 3600) * 1000,
    cooldownMs: integer('COMMAND_COOLDOWN_SECONDS', 2, 1, 60) * 1000,
    cookie: env.NETEASE_COOKIE || '',
    qqPython: env.QQ_PYTHON_PATH || 'python3',
    stayConnected: env.STAY_CONNECTED === 'true',
    webEnabled: env.WEB_ENABLED === 'true',
    webHost: env.WEB_HOST || '127.0.0.1',
    webPort: integer('WEB_PORT', 8787, 1, 65535),
    webSecure: env.WEB_SECURE_COOKIE === 'true',
    webRequirePassword: env.WEB_REQUIRE_PASSWORD !== 'false',
  };
  if (requireToken && (!config.token || !config.guilds.size)) {
    throw new Error('请在 .env 中填写 KOOK_TOKEN 和 ALLOWED_GUILD_IDS。');
  }
  return config;
}
