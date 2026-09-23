import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.js';
import { Kook } from './kook.js';
import { Music } from './music.js';

async function doctor() {
  const config = readConfig();
  const ffmpeg = spawnSync(config.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (ffmpeg.status !== 0 || !ffmpeg.stdout.includes('libopus')) throw new Error('FFmpeg 不可用或缺少 libopus 编码器。');
  console.log('通过：FFmpeg / libopus');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const probe = path.join(config.dataDir, `.doctor-${process.pid}`);
  await writeFile(probe, 'ok', { mode: 0o600 }); await unlink(probe);
  console.log('通过：数据目录可写');
  const api = new Kook(config.token); await api.request('user/me'); await api.request('gateway/index', { compress: 0 });
  console.log('通过：KOOK Token / 网关地址获取');
  const music = new Music(config); await music.init();
  if (await music.cookie()) {
    const account = await music.call('user_account');
    if (!account.profile?.userId) throw new Error('网易云登录已失效，请重新扫码。');
    console.log(`通过：网易云登录有效（${account.profile.nickname}）`);
  } else {
    console.log('提示：网易云当前未登录。');
  }
  const songs = await music.search('音乐', 1);
  if (!songs.length) throw new Error('网易云搜索无结果。');
  console.log('通过：网易云搜索');
  if (process.argv.includes('--song')) {
    const input = process.argv[process.argv.indexOf('--song') + 1];
    if (!input) throw new Error('--song 后面需要歌曲 ID。');
    await music.stream(await music.resolve(input));
    console.log('通过：指定歌曲的完整音源获取');
  }
  console.log('诊断完成。语音权限和出站 UDP 需要进入 KOOK 语音频道后实际点歌验收。');
}
doctor().then(() => process.exit(0)).catch((error) => { console.error(`诊断失败：${error.message}`); process.exit(1); });
