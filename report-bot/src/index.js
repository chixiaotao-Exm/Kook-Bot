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
import {createBrowserSubmitter} from './browser.js';
import {browserConfiguration,createBrowserPool} from './browser-pool.js';
import {createOcr} from './ocr.js';
import {createGmailReader,GmailMonitor} from './mail-monitor.js';
import {createReportersReader} from './reporters.js';

process.umask(0o077);
const token=process.env.KOOK_TOKEN?.trim();
if(!token||!/^[^\s\x00-\x1f\x7f]{1,512}$/.test(token))throw Error('Invalid KOOK configuration');
if(!/^\d{5,30}$/.test(process.env.KOOK_CHANNEL_ID?.trim()||'')||/^0+$/.test(CHANNEL_ID))throw Error('KOOK_CHANNEL_ID is required');
if(process.env.PUBG_SUBMIT_ENABLED&&!['true','false'].includes(process.env.PUBG_SUBMIT_ENABLED))throw Error('Invalid submission mode');
const enabled=process.env.PUBG_SUBMIT_ENABLED==='true',dataDir=path.resolve(process.env.DATA_DIR||'data');
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||18992);
if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid health listener');
const getReporters=createReportersReader({file:path.resolve(process.env.REPORTERS_FILE||path.join(dataDir,'reporters.txt')),
 legacyFile:path.join(dataDir,'profile.json'),allowLegacy:!process.env.REPORTERS_FILE,
 email:process.env.PUBG_REPORTER_EMAIL,language:process.env.PUBG_REPORTER_LANGUAGE});
const initialReporters=await getReporters();
const {baseUrls,concurrency,pooled}=browserConfiguration();
const browserEnabled=baseUrls.length>0;
const browserPool=pooled?createBrowserPool({baseUrls,token:process.env.REPORT_BROWSER_TOKEN,enabled}):null;
const submitterFor=profile=>browserEnabled?createBrowserSubmitter(profile,enabled,{baseUrl:baseUrls[0],token:process.env.REPORT_BROWSER_TOKEN}):createSubmitter(profile,enabled);
// Validate transport settings at startup, then create an isolated submitter for each selected identity.
submitterFor(initialReporters[0]);
const submit=browserPool?browserPool.submit:(draft,{profile,signal}={})=>submitterFor(profile)(draft,{signal});
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
const mailEnabled=process.env.GMAIL_RECEIPTS_ENABLED==='true';
if(process.env.GMAIL_RECEIPTS_ENABLED&&!['true','false'].includes(process.env.GMAIL_RECEIPTS_ENABLED))throw Error('Invalid mail configuration');
if(mailEnabled&&process.env.GMAIL_ADDRESS?.trim().toLowerCase()!==initialReporters[0].email.toLowerCase())throw Error('Gmail must match the fixed reporter mailbox');
const resolve=createAuthorResolver({token}),resolveButton=createButtonAuthorResolver({token,channelIds:[CHANNEL_ID]});
const bot=new ReportBot({store,send:createSender(token),submit,ocr,enabled,
 mailEnabled,getReporters,receiptMailbox:process.env.GMAIL_ADDRESS,concurrency,
 prepareWorker:browserPool?.ready,
 timeouts:browserEnabled?{submit:110000}:{},
 resolveAuthor:(id,event)=>resolve({userId:id,guildId:event.extra?.guild_id,signal:event.signal}),
 resolveButtonAuthor:(body)=>resolveButton({userId:body.user_id,channelId:body.target_id,guildId:body.guild_id,signal:body.signal})});
bot.reporterCount=initialReporters.length;
// A batch can exceed 120s; the bot bounds every identity lookup, disk write and individual submission.
const gateway=new KookGateway({token,onEvent:(event,context)=>bot.handle(event,context),eventTimeoutMs:0});
const mail=mailEnabled?new GmailMonitor({reader:createGmailReader({address:process.env.GMAIL_ADDRESS,password:process.env.GMAIL_APP_PASSWORD}),bot,mailbox:process.env.GMAIL_ADDRESS}):null;
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'||req.url!=='/health'){res.writeHead(404);res.end();return}
 const state=bot.status(),connection=gateway.snapshot();const ok=state.ready&&connection.connected;
 res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify({ok,gateway:{connected:connection.connected===true},chat:{enabled:state.ready},bot:state,ocr:{enabled:Boolean(ocr),model:ocr?'PP-OCRv6':null},submissionEnabled:enabled,submissionTransport:browserEnabled?'flaresolverr-browser':'direct',browserWorkers:baseUrls.length,mail:mail?.status()||{enabled:false}}));
});
server.headersTimeout=5000;server.requestTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
let closing=false;
async function shutdown(){
 if(closing)return;closing=true;
 const deadline=setTimeout(()=>process.exit(1),20000);gateway.close();server.closeAllConnections();
 await Promise.allSettled([mail?.close(),bot.close(),new Promise(resolve=>server.close(resolve))]);
 await lock.close();await unlink(lockPath).catch(()=>{});clearTimeout(deadline);process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await gateway.start();console.log(JSON.stringify({event:'report_bot_started',channelId:CHANNEL_ID,submissionEnabled:enabled,ocrEnabled:Boolean(ocr)}));
mail?.start();
setInterval(()=>{},60000);
