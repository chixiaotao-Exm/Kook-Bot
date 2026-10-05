import http from 'node:http';
import path from 'node:path';
import {readFile,mkdir,open,unlink} from 'node:fs/promises';
import {CHANNEL_ID} from './domain.js';
import {KookGateway} from './kook-gateway.js';
import {createAuthorResolver,createButtonAuthorResolver} from './kook-identity.js';
import {ReportBot} from './bot.js';
import {openStore} from './store.js';
import {createSender} from './kook.js';
import {createSubmitter} from './pubg.js';
import {createOcr} from './ocr.js';

process.umask(0o077);
const token=process.env.KOOK_TOKEN?.trim();
if(!token||!/^[^\s\x00-\x1f\x7f]{1,512}$/.test(token))throw Error('Invalid KOOK configuration');
if(process.env.KOOK_CHANNEL_ID&&process.env.KOOK_CHANNEL_ID!==CHANNEL_ID)throw Error('Channel configuration not allowed');
if(process.env.PUBG_SUBMIT_ENABLED&&!['true','false'].includes(process.env.PUBG_SUBMIT_ENABLED))throw Error('Invalid submission mode');
const enabled=process.env.PUBG_SUBMIT_ENABLED==='true',dataDir=path.resolve(process.env.DATA_DIR||'data');
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||18992);
if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid health listener');
let profile={};
try{profile=JSON.parse(await readFile(path.join(dataDir,'profile.json'),'utf8'))}catch{if(enabled)throw Error('Reporter profile missing or invalid')}
const submit=createSubmitter(profile,enabled);
const ocr=process.env.PADDLEOCR_TOKEN?createOcr({token:process.env.PADDLEOCR_TOKEN,endpoint:process.env.PADDLEOCR_ENDPOINT,model:process.env.PADDLEOCR_MODEL||'PP-OCRv6'}):null;
await mkdir(dataDir,{recursive:true,mode:0o700});
// The systemd flock and PID lock prevent two gateways sharing submission state.
const lockPath=process.env.LOCK_FILE?path.resolve(process.env.LOCK_FILE):path.join(dataDir,'process.lock');let lock;
try{lock=await open(lockPath,'wx',0o600)}catch(error){
 if(error.code!=='EEXIST')throw error;
 const pid=Number(await readFile(lockPath,'utf8'));
 if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid process lock; inspect before recovery');
 let exists=true;try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')exists=false;else throw Error('Cannot verify existing process')}
 if(exists)throw Error('Report bot is already running');
 await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
}
await lock.writeFile(String(process.pid));await lock.sync();
const store=await openStore(path.join(dataDir,'state.json'));
const resolve=createAuthorResolver({token}),resolveButton=createButtonAuthorResolver({token,channelIds:[CHANNEL_ID]});
const bot=new ReportBot({store,send:createSender(token),submit,ocr,enabled,
 resolveAuthor:(id,event)=>resolve({userId:id,guildId:event.extra?.guild_id,signal:event.signal}),
 resolveButtonAuthor:(body)=>resolveButton({userId:body.user_id,channelId:body.target_id,guildId:body.guild_id,signal:body.signal})});
const gateway=new KookGateway({token,onEvent:(event,context)=>bot.handle(event,context),eventTimeoutMs:120000});
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'||req.url!=='/health'){res.writeHead(404);res.end();return}
 const state=bot.status(),connection=gateway.snapshot();const ok=state.ready&&connection.connected;
 res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify({ok,gateway:{connected:connection.connected===true},chat:{enabled:state.ready},bot:state,ocr:{enabled:Boolean(ocr),model:ocr?'PP-OCRv6':null},submissionEnabled:enabled}));
});
server.headersTimeout=5000;server.requestTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
let closing=false;
async function shutdown(){
 if(closing)return;closing=true;
 const deadline=setTimeout(()=>process.exit(1),20000);gateway.close();server.closeAllConnections();
 await Promise.allSettled([bot.close(),new Promise(resolve=>server.close(resolve))]);
 await lock.close();await unlink(lockPath).catch(()=>{});clearTimeout(deadline);process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await gateway.start();console.log(JSON.stringify({event:'report_bot_started',channelId:CHANNEL_ID,submissionEnabled:enabled,ocrEnabled:Boolean(ocr)}));
setInterval(()=>{},60000);
