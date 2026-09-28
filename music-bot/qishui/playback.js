import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const fail = code => Object.assign(new Error(code), { code });
const ID = /^[1-9]\d{0,18}$/;
// Adapted from guowenye/qishui-api (MIT), src/audioDecryptor.js.
// Decodes the per-track key provided with this account's authorized playback response.
export function audioKey(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw fail('media_key_invalid');
  const input = Buffer.from(value, 'base64');
  if (input.length < 3) throw fail('media_key_invalid');
  const padding = (input[0] ^ input[1] ^ input[2]) - 48;
  if (padding < 0 || input.length < padding + 2) throw fail('media_key_invalid');
  const key = input.subarray(1, input.length - padding), previous = Buffer.concat([Buffer.from([250, 85]), key]);
  const decoded = Buffer.alloc(key.length);
  for (let i = 0; i < key.length; i++) {
    let bits = 0, index = i; while (index) { bits += index & 1; index >>>= 1; }
    let number = (key[i] ^ previous[i]) - bits - 21;
    while (number < 0) number += 255;
    decoded[i] = number;
  }
  const skip = parseInt(String.fromCharCode(decoded[0]), 36);
  const end = 1 + input.length - padding - 2 - skip;
  const result = decoded.subarray(1, end).toString('utf8');
  if (!Number.isInteger(skip) || end < 1 || end > decoded.length || !/^[a-f0-9]{32}$/i.test(result)) throw fail('media_key_invalid');
  return result;
}

export function mediaVariant(payload) {
  const duration = payload?.track?.duration;
  let model;
  try { model = typeof payload?.track_player?.video_model === 'string' ? JSON.parse(payload.track_player.video_model) : null; } catch {}
  const streamMs = Math.round(Number(model?.video_duration) * 1000);
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 3600_000 || !Number.isSafeInteger(streamMs)
    || Math.abs(duration - streamMs) > 2000 || !Array.isArray(model.video_list)) throw fail('not_full_track');
  const options = model.video_list.filter(item => item.video_meta?.codec_type === 'aac' && ['higher','medium'].includes(item.video_meta?.quality)
    && Number.isSafeInteger(item.video_meta.size) && item.video_meta.size > 0 && item.video_meta.size <= 30 * 1024 * 1024);
  options.sort((a,b) => Number(b.video_meta.quality === 'higher') - Number(a.video_meta.quality === 'higher'));
  const selected = options[0]; if (!selected) throw fail('media_unavailable');
  let url; try { url = new URL(selected.main_url); } catch { throw fail('media_unavailable'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !/^[a-z0-9-]+\.douyinvod\.com$/i.test(url.hostname)) throw fail('media_unavailable');
  const key = selected.encrypt_info?.encrypt === true ? audioKey(selected.encrypt_info.spade_a) : null;
  return { url: url.href, durationMs: duration, key, expectedBytes: selected.video_meta.size };
}

export async function boundedFetch(url, init, maxBytes, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...init, redirect:'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw Object.assign(fail('upstream_unavailable'), { httpStatus: response.status });
  }
  const chunks=[];let size=0;
  for await (const chunk of response.body) { size+=chunk.length; if(size>maxBytes)throw fail('response_limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function trackRequest(id, credentials) {
  if (!ID.test(id) || typeof credentials.cookie !== 'string' || !credentials.cookie || /[\r\n]/.test(credentials.cookie)
    || !/^\d{15,16}$/.test(credentials.deviceId || '') || !/^\d{15,16}$/.test(credentials.installId || '')) throw fail('login_required');
  const body=JSON.stringify({track_id:id,media_type:'track',queue_type:'favorite_track_playlist',scene_name:'library'});
  const query=new URLSearchParams({aid:'386088',app_name:'luna_pc',region:'cn',geo_region:'cn',os_region:'cn',sim_region:'',
    device_id:credentials.deviceId,cdid:'',iid:credentials.installId,version_name:'3.8.0',version_code:'30080000',channel:'official',
    build_mode:'master',network_carrier:'',ac:'wifi',tz_name:'Asia/Shanghai',resolution:'',device_platform:'windows',device_type:'Windows',
    os_version:'Windows 11',fp:credentials.deviceId});
  const headers={'content-type':'application/json; charset=utf-8','user-agent':'LunaPC/3.8.0(467160162)',
    'x-luna-background-type':'foreground','x-luna-is-background-req':'0','x-luna-is-local-user':'0',
    'x-tt-trace-id':`00-${randomBytes(8).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    'x-ss-stub':createHash('md5').update(body).digest('hex').toUpperCase(),cookie:credentials.cookie};
  return {url:'https://api.qishui.com/luna/pc/track_v2?'+query,method:'POST',headers,body,device_id:credentials.deviceId};
}

async function processRun(executable,args,signal,{capture=false}={}) {
  if(signal.aborted)throw fail('cancelled');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['ignore',capture?'pipe':'ignore','ignore'],windowsHide:true,shell:false});
    let output='',settled=false,wasAborted=false;
    const abort=()=>{wasAborted=true;child.kill('SIGKILL');};
    const done=(error)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(output);};
    signal.addEventListener('abort',abort,{once:true});
    child.stdout?.on('data',chunk=>{output+=chunk;if(output.length>32768){child.kill('SIGKILL');done(fail('process_output_limit'));}});
    child.once('error',()=>done(fail('decoder_unavailable')));child.once('close',code=>done(wasAborted?fail('cancelled'):code===0?null:fail('decode_failed')));
  });
}

export class QishuiPlayback {
  constructor({signerUrl,signerToken,credentialsFile,cacheDir,fetchImpl=fetch,ffmpeg='/usr/bin/ffmpeg',ffprobe='/usr/bin/ffprobe'}) {
    Object.assign(this,{signerUrl,signerToken,credentialsFile,cacheDir,fetch:fetchImpl,ffmpeg,ffprobe});
  }
  async prepare(id,{signal}={}) {
    if(typeof id!=='string'||!ID.test(id))throw fail('invalid_id');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const nonce=randomBytes(24).toString('hex'),input=path.join(this.cacheDir,nonce+'.input'),output=path.join(this.cacheDir,nonce+'.mp3');
    let success=false;
    try {
      await mkdir(this.cacheDir,{recursive:true,mode:0o700});
      let credentials;try{credentials=JSON.parse(await readFile(this.credentialsFile,'utf8'))}catch{throw fail('login_required')}
      const spec=trackRequest(id,credentials);
      const signed=JSON.parse(await boundedFetch(this.signerUrl+'/sign',{method:'POST',headers:{Authorization:'Bearer '+this.signerToken,'Content-Type':'application/json'},
        body:JSON.stringify(spec),signal:combined},16384,this.fetch));
      const signatures={};for(const [name,value]of Object.entries(signed.headers||{}))if(['x-helios','x-medusa'].includes(name.toLowerCase())&&typeof value==='string'&&value.length<4096&&!/[\r\n]/.test(value))signatures[name.toLowerCase()]=value;
      if(!signed.ok||!signatures['x-helios']||!signatures['x-medusa'])throw fail('signer_unavailable');
      const payload=JSON.parse(await boundedFetch(spec.url,{method:'POST',headers:{...spec.headers,...signatures},body:spec.body,signal:combined},2*1024*1024,this.fetch));
      if(payload.track?.id!==id)throw fail('invalid_track');
      const media=mediaVariant(payload);
      const bytes=await boundedFetch(media.url,{signal:combined,headers:{'User-Agent':'Mozilla/5.0'}},30*1024*1024,this.fetch);
      if(bytes.length!==media.expectedBytes)throw fail('incomplete_media');
      if(bytes.length<12||bytes.toString('ascii',4,8)!=='ftyp')throw fail('media_unavailable');
      await writeFile(input,bytes,{mode:0o600,flag:'wx'});
      await processRun(this.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file','-f','mov','-enable_drefs','0','-use_absolute_path','0',...(media.key?['-decryption_key',media.key]:[]),
        '-i',input,'-map','0:a:0','-vn','-t',String(media.durationMs/1000+1),'-fs',String(30*1024*1024),'-c:a','libmp3lame','-b:a','192k','-y',output],combined);
      const durationMs=Math.round(Number(await processRun(this.ffprobe,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',output],combined,{capture:true}))*1000);
      if(!Number.isSafeInteger(durationMs)||Math.abs(durationMs-media.durationMs)>2000)throw fail('not_full_track');
      success=true;return{file:output,durationMs,fullTrack:true,encrypted:false};
    }catch(error){throw fail(['invalid_id','login_required','not_full_track','media_unavailable','media_key_invalid','cancelled','decode_failed'].includes(error.code)?error.code:'upstream_unavailable')}
    finally{clearTimeout(timer);await unlink(input).catch(()=>{});if(!success)await unlink(output).catch(()=>{})}
  }
}
