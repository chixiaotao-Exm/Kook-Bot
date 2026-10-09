import { readFile,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importProfile } from './protocol.mjs';
import { parseReporters,formatReporter } from './reporters.js';
const files=process.argv.slice(2);
if (!files.length) { console.error('用法：npm run import-profile -- HAR文件路径 [更多HAR文件路径]'); process.exit(1); }
try {
  const target=path.resolve(process.env.REPORTERS_FILE||path.join(process.env.DATA_DIR||'data','reporters.txt'));
  const profilePath=path.resolve(process.env.DATA_DIR||'data','profile.json');
  let existing='';
  try { existing=await readFile(target,'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const imported=[];
  for(const file of files)imported.push(importProfile(JSON.parse(await readFile(file,'utf8'))));
  let defaults, newProfile=false;
  try { defaults=JSON.parse(await readFile(profilePath,'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; defaults=imported[0]; newProfile=true; }
  const settings={email:process.env.PUBG_REPORTER_EMAIL?.trim()||defaults.email,
    language:process.env.PUBG_REPORTER_LANGUAGE?.trim()||defaults.language||'english'};
  const added=imported.map(formatReporter);
  const text=existing+(existing&&!existing.endsWith('\n')?'\n':'')+added.join('\n')+'\n';
  const reporters=parseReporters(text,settings);
  if(newProfile){
    await mkdir(path.dirname(profilePath),{recursive:true,mode:0o700});
    await writeFile(profilePath,JSON.stringify(defaults),{mode:0o600,flag:'wx'});
  }
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await writeFile(target,text,{mode:0o600});
  console.log(`已导入举报人 TXT，共 ${reporters.length} 个不同账号；未保存旧举报、Cookie 或令牌。`);
} catch { console.error('无法导入个人资料，请检查 HAR、TXT 格式或同一账号的资料冲突。'); process.exitCode=1; }
