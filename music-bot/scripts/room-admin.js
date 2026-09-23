import path from 'node:path';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RoomAccess } from '../src/room-access.js';

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node scripts/room-admin.js --base-url https://你的域名 --output /私有目录/admin-entry.txt [--data-dir ./data]');
    console.log('请先停止机器人服务，生成或轮换后再启动。输出文件包含专属管理链接，应仅由站点管理员读取。');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--base-url', '--output', '--data-dir'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || options[args[index]]) throw new Error('参数无效，请使用 --help 查看用法。');
    options[args[index]] = args[index + 1];
  }
  if (!options['--base-url']) throw new Error('需要 --base-url 指定控制台 HTTPS 地址。');
  let url; try { url = new URL(options['--base-url']); } catch { throw new Error('控制台地址无效。'); }
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('请使用不带凭据、参数或片段的 HTTPS 控制台地址；仅本机预览允许 HTTP。');
  const directory = path.resolve(options['--data-dir'] || process.env.DATA_DIR || 'data');
  const output = path.resolve(options['--output'] || path.join(directory, 'admin-entry.txt'));
  const publicRoot = path.resolve('web');
  if (output === publicRoot || output.startsWith(publicRoot + path.sep)) throw new Error('管理链接不能输出到 web 静态文件目录。');
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const access = await new RoomAccess({ dataDir: directory }).init();
    const token = await access.rotateAdminLink();
    url.pathname = '/rooms';
    url.hash = new URLSearchParams({ admin: token }).toString();
    await handle.writeFile(url.href + '\n'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, output);
    console.log(`专属管理链接已写入私有文件：${output}`);
    console.log('请启动或重启机器人服务以加载新授权。原管理链接及旧站点管理员会话将失效；新链接可用于多个设备。');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
