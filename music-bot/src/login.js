import QRCode from 'qrcode';
import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { readConfig } from './config.js';
import { Music } from './music.js';
import { atomicJson, sleep } from './util.js';

async function login() {
  const config = readConfig(process.env, { requireToken: false });
  if (config.cookie) throw new Error('NETEASE_COOKIE 会覆盖扫码登录文件；请先清空该环境变量。');
  const music = new Music(config); await music.init();
  const body = await music.call('login_qr_key', { cookie: '' });
  const key = body.data?.unikey;
  if (!key) throw new Error('无法生成登录二维码，请稍后重试。');
  const result = await music.call('login_qr_create', { key, cookie: '' });
  console.log('请用网易云音乐手机 App 扫描下方二维码，并确认登录：');
  const fileIndex = process.argv.indexOf('--qr-file');
  if (fileIndex >= 0) {
    const file = process.argv[fileIndex + 1];
    if (!file || file.startsWith('--')) throw new Error('--qr-file 后面需要二维码图片路径。');
    await QRCode.toFile(file, result.data.qrurl, { type: 'png', width: 512, margin: 4 });
    if (process.platform !== 'win32') await chmod(file, 0o600);
    console.log(`二维码图片：${path.resolve(file)}`);
  } else {
    console.log(await QRCode.toString(result.data.qrurl, { type: 'terminal', small: true }));
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const state = await music.call('login_qr_check', { key, cookie: '' }, [800, 801, 802, 803]);
    if (state.code === 800) throw new Error('二维码已过期，请重新运行登录命令。');
    if (state.code === 803) {
      if (!state.cookie) throw new Error('登录成功但未收到 Cookie，请重试。');
      await atomicJson(path.join(config.dataDir, 'netease-cookie.json'), { cookie: state.cookie });
      console.log('登录已保存，机器人会在下一次网易云请求时读取，无需重启。'); return;
    }
  }
  throw new Error('等待扫码超时，请重新运行登录命令。');
}
login().then(() => process.exit(0)).catch((error) => { console.error(error.message); process.exit(1); });
