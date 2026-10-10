import { readFile,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importProfile } from './protocol.mjs';
import { parseReporters,formatReporter } from './reporters.js';
const files=process.argv.slice(2);
if (!files.length) { console.error('Usage: npm run import-profile -- HAR_PATH [MORE_HAR_PATHS]'); process.exit(1); }
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
  console.log(`Imported ${reporters.length} distinct accounts into the reporter TXT file. Previous reports, cookies and tokens were not saved.`);
} catch { console.error('Could not import profiles. Check the HAR and TXT formats and any conflicting entries for the same account.'); process.exitCode=1; }
