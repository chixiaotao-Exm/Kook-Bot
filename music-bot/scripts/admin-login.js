import path from 'node:path';
import { open } from 'node:fs/promises';
import { RoomAccess } from '../src/room-access.js';

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node scripts/admin-login.js --username 管理员用户名 --password-file /私有目录/password.txt [--data-dir ./data]');
    console.log('请先停止机器人服务。密码文件只包含密码；不要把密码放在命令行参数中。');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--username', '--password-file', '--data-dir'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || options[args[index]]) throw new Error('参数无效，请使用 --help 查看用法。');
    options[args[index]] = args[index + 1];
  }
  if (!options['--username'] || !options['--password-file']) throw new Error('需要 --username 和 --password-file 参数。');
  const directory = path.resolve(options['--data-dir'] || process.env.DATA_DIR || 'data');
  let handle, password;
  try {
    handle = await open(path.resolve(options['--password-file']), 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024) throw new Error('密码文件应只包含密码，且不能超过 1024 字节。');
    password = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
  } finally { await handle?.close(); }
  const access = await new RoomAccess({ dataDir: directory }).init();
  const result = await access.setAdminLogin(options['--username'], password);
  password = undefined;
  console.log(`管理员账号登录已配置，用户名：${result.username}`);
  console.log('请启动机器人服务。专属管理链接已停用；再次重置密码会撤销旧站点管理员授权。');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
