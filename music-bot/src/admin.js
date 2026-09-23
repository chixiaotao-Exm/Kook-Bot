import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { setPassword } from './web-auth.js';
import { readConfig } from './config.js';

const config = readConfig(process.env, { requireToken: false });
try {
  let exists = false;
  try { await access(path.join(config.dataDir, 'web-admin.json')); exists = true; } catch {}
  if (exists && !process.argv.includes('--reset')) throw new Error('密码已设置。如需重置，请使用 --reset。');
  const password = randomBytes(15).toString('base64url');
  await setPassword(config.dataDir, password);
  console.log(`控制台管理密码（仅显示一次）：${password}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
