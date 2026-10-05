import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { importProfile } from './protocol.mjs';
const path=process.argv[2];
if (!path) { console.error('用法：node src/import-profile.js HAR文件路径'); process.exit(1); }
try {
  const profile=importProfile(JSON.parse(await readFile(path,'utf8')));
  await mkdir('data',{recursive:true});
  await writeFile('data/profile.json',JSON.stringify(profile),{mode:0o600});
  console.log('已导入个人资料、语言和分类；未保存旧举报、Cookie 或令牌。');
} catch { console.error('无法导入个人资料，请检查 HAR。'); process.exitCode=1; }
