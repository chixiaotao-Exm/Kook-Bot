const{chromium}=require('playwright');const fs=require('node:fs');const http=require('node:http');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),now=new Date().toISOString();
let status={accounts:[{id:'1',name:'OpenAI_5X',platform:'openai',type:'oauth',planLabel:'Pro 5x',status:'active',schedulable:true,
 metrics:[{key:'7d',label:'7 天额度窗口',kind:'percent',usedPercent:40,freshness:'fresh',source:'sub2api-active-quota'}],
 resetCredits:{cachedCount:1,availableCount:1,source:'sub2api-active-quota',checkedAt:now,status:'available',freshness:'fresh',expiresAt:[new Date(Date.now()+86400000).toISOString()]},
 quotaQuery:{status:'success',queriedAt:now,message:''}}],updatedAt:now,refreshIntervalMs:600000,
 activeQuota:{enabled:true,intervalMs:1800000,running:false,lastFinishedAt:now,successCount:5,failedCount:0,skippedCount:0,accounts:[],lastError:''}};
const writes=[];
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');const json=v=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
 if(req.method!=='GET'){writes.push(u.pathname);res.writeHead(405);return res.end();}if(u.pathname.endsWith('/api/session'))return json({publicAccess:true,authenticated:false});if(u.pathname.endsWith('/api/status'))return json(status);
 const file={'/quota/':'index.html','/quota/app.js':'app.js','/quota/style.css':'style.css'}[u.pathname];if(!file){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('css')?'text/css':file.endsWith('js')?'text/javascript':'text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'public',file)));});
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);await page.locator('#active-quota-status').waitFor();
 assert.match(await page.locator('#active-quota-status').innerText(),/每30分钟.*成功 5 个/);assert.equal(await page.locator('.reset-credit-source').innerText(),'已查询');assert.match(await page.locator('.overview-remaining').innerText(),/60/);
 await page.locator('summary').click();assert.match(await page.locator('.account-details-body').innerText(),/主动查询/);assert.doesNotMatch(await page.locator('.account-details-body').innerText(),/自动检查记录/);await page.locator('summary').click();
 for(const width of[1440,390,360]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width!==360)await page.screenshot({path:path.join(root,`data/screenshots/active-quota-${width}.png`)});}
 status.activeQuota={...status.activeQuota,running:true};await page.reload();await page.waitForFunction(()=>document.querySelector('#active-quota-status').textContent.includes('查询中'));
 status.activeQuota={...status.activeQuota,running:false,successCount:3,failedCount:1,accounts:[{id:'1',status:'skipped',code:'AUTO_RESET_ENABLED'}],lastError:'部分账号查询失败，保留上次数据。'};
 status.accounts[0].resetCredits.freshness='stale';status.accounts[0].quotaQuery={status:'failed',queriedAt:now,message:'主动查询失败，保留上次数据'};
 await page.reload();await page.waitForFunction(()=>document.querySelector('#active-quota-status').textContent.includes('自动用卡未关闭'));
 assert.equal(await page.locator('.reset-credit-source').innerText(),'上次查询');assert.match(await page.locator('.account-notices').innerText(),/保留上次数据/);assert.ok(await page.locator('#active-quota-status').evaluate(n=>n.classList.contains('has-warning')));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log(JSON.stringify({activeCadence:true,queryTimestamp:true,guardAndFailureStates:true,widths:[1440,390,360],overflow:false,errors:0,writes:0}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
