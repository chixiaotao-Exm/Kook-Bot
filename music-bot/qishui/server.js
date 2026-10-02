import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { QishuiCatalog } from './catalog.js';
import { QishuiPlayback, boundedFetch } from './playback.js';
import { HotLibrary } from './hot-library.js';

const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function mediaRange(value,size){
  if(value==null)return{start:0,end:size-1,partial:false};
  const m=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!m||(!m[1]&&!m[2]))return null;
  let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2])),end=m[2]&&m[1]?Math.min(size-1,Number(m[2])):size-1;
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{start,end,partial:true}:null;
}
export function createQishuiServer({token,publicUrl,credentialsFile,cacheDir,catalog,playback,library,now=Date.now,fetchImpl=fetch}){
  if(typeof token!=='string'||token.length<32)throw Error('api_token_required');
  const base=new URL(publicUrl);if((base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))||base.username||base.password||base.search||base.hash)throw Error('invalid_public_url');
  const prefix=base.pathname.replace(/\/$/,''),caps=new Map(),pending=new Map(),shutdown=new AbortController();
  const cleaned=readdir(cacheDir).then(names=>Promise.all(names.filter(name=>/^[a-f0-9]{48}\.(?:mp3|input)$/.test(name))
    .map(name=>unlink(path.join(cacheDir,name)).catch(()=>{})))).catch(error=>{if(error.code!=='ENOENT')throw error});
  let accountCache=null,active=0;
  const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
  async function prune(){for(const[cap,entry]of caps)if(entry.expires<=now()){caps.delete(cap);await unlink(entry.file).catch(()=>{})}}
  async function recordPlayback(id,outcome){
    try { await library?.recordPlayback(id,outcome); } catch { /* A library write failure must not interrupt playback. */ }
  }
  async function prepared(id){
    await cleaned;
    await prune();
    const cached=[...caps.values()].find(x=>x.id===id);if(cached)return cached;
    if(pending.has(id))return pending.get(id);
    if(pending.size>=1)throw Object.assign(Error('busy'),{code:'busy'});
    const operation=(async()=>{
      let item;
      try { item=await playback.prepare(id,{signal:shutdown.signal}); }
      catch(error){
        if(['not_full_track','media_unavailable'].includes(error.code))await recordPlayback(id,'unavailable');
        throw error;
      }
      if(path.dirname(path.resolve(item.file))!==path.resolve(cacheDir))throw Error('invalid_media');
      if(shutdown.signal.aborted){await unlink(item.file).catch(()=>{});throw Error('cancelled')}
      const info=await stat(item.file);if(!info.isFile()||info.size<1||info.size>30*1024*1024)throw Error('invalid_media');
      await recordPlayback(id,'success');
      while(caps.size>=12){const[cap,old]=caps.entries().next().value;caps.delete(cap);await unlink(old.file).catch(()=>{})}
      const cap=randomBytes(24).toString('hex')+'.mp3';
      const entry={...item,id,bytes:info.size,expires:now()+60*60_000,url:base.origin+prefix+'/media/'+cap};caps.set(cap,entry);return entry;
    })();pending.set(id,operation);try{return await operation}finally{pending.delete(id)}
  }
  async function account(){
    let data={loggedIn:false};
    let fingerprint;
    try{
      const content=await readFile(credentialsFile,'utf8');
      fingerprint=createHash('sha256').update(content).digest('hex');
      if(accountCache&&accountCache.fingerprint===fingerprint&&accountCache.until>now())return accountCache.data;
      const credential=JSON.parse(content);
      if(typeof credential.cookie!=='string'||/[\r\n]/.test(credential.cookie))throw Error();
      if(!credential.cookie.trim())return{loggedIn:false};
      const body=JSON.parse(await boundedFetch('https://api.qishui.com/luna/pc/me?aid=386088',
        {headers:{Cookie:credential.cookie,'User-Agent':'LunaPC/3.8.0(467160162)'},signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(12000)])},256*1024,fetchImpl));
      const user=body.my_info||body.user||body.me||body.user_info||body.profile||body.data?.user||body.data;
      const id=user?.id||user?.user_id_str||user?.user_id||user?.uid;
      const codes=[body.status_code,body.status_info?.code,body.status_info?.status_code].filter(value=>value!==undefined);
      const rejected=codes.some(code=>Number(code)!==0);
      const loginRejected=/^(?:user\s+)?not\s+log(?:ged\s+)?in$|^login\s+required$|^未登录$|^用户未登录$|^登录(?:已)?(?:过期|失效)$|^请先登录$/i
        .test(String(body.status_info?.message||body.status_info?.msg||body.message||'').trim());
      if(rejected&&loginRejected)data={loggedIn:false,expired:true};
      else if(rejected)throw Error('account_unavailable');
      else if(id&&(typeof id==='string'&&id.trim()&&id!=='0'||Number.isSafeInteger(id)&&id>0)){data={loggedIn:true,id:String(id),name:String(user.name||user.nickname||user.screen_name||'汽水音乐账号').slice(0,100)};}
      else throw Error('account_unavailable');
    }catch(error){if(error.httpStatus===401)data={loggedIn:false,expired:true};else if(error.code!=='ENOENT')throw error}
    accountCache={until:now()+30_000,fingerprint,data};return data;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    let route;try{route=new URL(req.url,'http://127.0.0.1')}catch{json(res,400,{error:'invalid_request'});return}
    const pathname=route.pathname;
    if(pathname.startsWith(prefix+'/media/')&&['GET','HEAD'].includes(req.method)){
      const cap=pathname.slice((prefix+'/media/').length),entry=caps.get(cap);
      if(!/^[a-f0-9]{48}\.mp3$/.test(cap)||!entry||entry.expires<=now()||route.search){json(res,404,{error:'media_expired'});return}
      const range=mediaRange(req.headers.range,entry.bytes);
      if(!range){res.writeHead(416,{'Content-Range':'bytes */'+entry.bytes});res.end();return}
      res.writeHead(range.partial?206:200,{'Content-Type':'audio/mpeg','Content-Length':range.end-range.start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-store',
        ...(range.partial?{'Content-Range':`bytes ${range.start}-${range.end}/${entry.bytes}`}:{})});
      if(req.method==='HEAD'){res.end();return}
      const stream=createReadStream(entry.file,{start:range.start,end:range.end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
    }
    if(!equal(req.headers.authorization,'Bearer '+token)){json(res,401,{error:'unauthorized'});return}
    if(!pathname.startsWith(prefix+'/')){json(res,404,{error:'not_found'});return}
    if(active>=8){json(res,429,{error:'busy'});return}active++;
    try{
      const endpoint=pathname.slice(prefix.length),q=route.searchParams;
      let result;
      if(req.method==='GET')switch(endpoint){
        case '/health':result={ok:true,pending:pending.size,cachedMedia:caps.size};break;
        case '/account':result=await account();break;
        case '/search':result={tracks:await catalog.search(q.get('q'),Number(q.get('limit')||20))};break;
        case '/track':result={track:await catalog.track(q.get('id'))};break;
        case '/playlist':result=await catalog.playlistDetails(q.get('id'),{offset:Number(q.get('offset')||0),limit:Number(q.get('limit')||50)});break;
        case '/discover':result={playlists:await catalog.discover(q.get('category')||'hot')};break;
        case '/hot': {
          const limit=Number(q.get('limit')||30);
          if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('invalid_limit');
          const saved=library?.hot(limit),state=library?.snapshot({limit:1});
          result=saved&&(saved.tracks.length||state?.lastSuccessAt||state?.counts?.total)?saved:await catalog.hot(limit);
          break;
        }
        case '/library': {
          const offset=Number(q.get('offset')||0),limit=Number(q.get('limit')||50);
          if(!Number.isSafeInteger(offset)||offset<0||offset>5000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('invalid_page');
          result=library?library.snapshot({offset,limit}):{enabled:false,tracks:[],total:0,offset,limit,hasMore:false};break;
        }
        case '/lyrics':result=await catalog.lyrics(q.get('id'));break;
        default:json(res,404,{error:'not_found'});return;
      }
      else if(req.method==='POST'&&endpoint==='/stream'){
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2048)throw Error('body_limit');chunks.push(chunk)}
        const input=JSON.parse(Buffer.concat(chunks).toString());
        if(typeof input?.id!=='string'||!/^\d{1,19}$/.test(input.id))throw Error('invalid_id');
        const value=await prepared(input.id);result={url:value.url,durationMs:value.durationMs,fullTrack:true,encrypted:false};
      }else{json(res,405,{error:'method_not_allowed'});return}
      json(res,200,result);
    }catch(error){
      const code=error.code;
      json(res,code==='busy'?429:code==='login_required'?403:['not_full_track','media_unavailable','media_key_invalid'].includes(code)?422:502,{error:code==='busy'?'busy':code==='login_required'?'login_required':'music_unavailable'});
    }finally{active--}
  });
  server.headersTimeout=5000;server.requestTimeout=70000;
  const timer=setInterval(()=>{void prune().catch(()=>{})},60_000);timer.unref();
  server.closeBridge=async()=>{shutdown.abort();clearInterval(timer);const closingLibrary=library?.close();catalog.close();server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.allSettled([...pending.values(),closingLibrary]);for(const item of caps.values())await unlink(item.file).catch(()=>{});caps.clear()};
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  const {QISHUI_API_TOKEN:token,QISHUI_PUBLIC_URL:publicUrl,QISHUI_SIGNER_TOKEN:signerToken}=process.env;
  const credentialsFile=process.env.QISHUI_CREDENTIALS_FILE||'/data/credentials.json',cacheDir='/data/media';
  const catalog=new QishuiCatalog(),playback=new QishuiPlayback({signerUrl:'http://127.0.0.1:19096',signerToken,credentialsFile,cacheDir});
  const library=new HotLibrary({catalog,file:process.env.QISHUI_HOT_LIBRARY_FILE||'/data/hot-library.json'});await library.init();
  const server=createQishuiServer({token,publicUrl,credentialsFile,cacheDir,catalog,playback,library});
  server.listen(Number(process.env.PORT||19095),'127.0.0.1',()=>library.start());
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.closeBridge().finally(()=>process.exit(0)));
}
