const{chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),now=Date.now(),future=new Date(now+86400000).toISOString(),past=new Date(now-86400000).toISOString();
const base=(id,name,credits,extra={})=>({id,name,platform:'openai',type:'oauth',planLabel:'Pro 5x',schedulable:true,status:'active',metrics:[{key:'7d',kind:'percent',label:'7天额度窗口',usedPercent:38,remainingPercent:62,freshness:'fresh'}],resetCredits:credits,...extra});
const accounts=[
 base('1','OpenAI_5X',{cachedCount:1,availableCount:0,status:'no_credit',checkedAt:past,expiresAt:[future],freshness:'stale'}),
 base('2','无卡记录',{cachedCount:0,availableCount:0,status:'no_credit',checkedAt:past,expiresAt:[],freshness:'fresh'}),
 base('3','尚未查询',null),
 base('4','过期记录',{cachedCount:2,availableCount:null,expiresAt:[past,past],freshness:'stale'}),
 base('5','只有检查记录',{cachedCount:null,availableCount:3,checkedAt:new Date(now).toISOString(),expiresAt:[],freshness:'unknown'}),
 base('6','小鸡毛',null,{type:'apikey',planLabel:'API 计费'}),
 base('7','Claude',null,{platform:'anthropic'}),
 base('8','不合法次数',{cachedCount:-1,availableCount:'7',status:'<img src=x>',expiresAt:[]}),
];
const writes=[];
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(req.method!=='GET'){writes.push(url.pathname);res.writeHead(405);return res.end();}
 if(url.pathname.endsWith('/api/session'))return json({publicAccess:true,authenticated:false});
 if(url.pathname.endsWith('/api/status'))return json({accounts,updatedAt:new Date(now).toISOString(),refreshIntervalMs:600000});
 const file={'/quota/':'index.html','/quota/app.js':'app.js','/quota/style.css':'style.css'}[url.pathname];if(!file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'public',file)));});
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);await page.locator('[data-reset-credits]').first().waitFor();
 const panel=id=>page.locator(`[data-account-id="${id}"] [data-reset-credits]`);
 assert.match(await panel('1').innerText(),/1\s*次/);assert.match(await panel('1').innerText(),/缓存记录/);assert.doesNotMatch(await panel('1').innerText(),/无卡|可用/);
 assert.match(await panel('2').innerText(),/0\s*次/);assert.match(await panel('3').innerText(),/未知/);assert.match(await panel('4').innerText(),/记录已到期/);assert.match(await panel('4').innerText(),/上次记录 2 次/);assert.equal((await panel('4').locator('.reset-credit-count').innerText()),'未知');
 assert.match(await panel('5').innerText(),/3\s*次/);assert.equal(await panel('6').count(),0);assert.equal(await panel('7').count(),0);assert.match(await panel('8').innerText(),/未知/);
 assert.equal(await page.locator('[data-reset-credits] button,[data-reset-credits] input,#accounts img').count(),0);
 assert.ok(await panel('1').evaluate(node=>node.getBoundingClientRect().bottom<=node.parentElement.querySelector('.metrics').getBoundingClientRect().top));
 for(const width of[1440,1100,390,360]){await page.setViewportSize({width,height:1080});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator('[data-reset-credits]').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)));const rows=await page.locator('.account-card').evaluateAll(nodes=>nodes.map(node=>({top:node.offsetTop,height:node.getBoundingClientRect().height})));const map=new Map();for(const row of rows){if(map.has(row.top))assert.ok(Math.abs(map.get(row.top)-row.height)<1);else map.set(row.top,row.height);}if([1440,390].includes(width))await page.screenshot({path:path.join(root,`data/screenshots/reset-credits-${width}.png`)});}
 await page.locator('[data-account-id="1"] summary').click();assert.match(await page.locator('[data-account-id="1"] .account-details-body').innerText(),/自动检查记录/);assert.match(await page.locator('[data-account-id="1"] .account-details-body').innerText(),/可能早于当前快照/);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);console.log(JSON.stringify({positiveAndZero:true,missingAndExpired:true,cachedCountsIndependentOfOldStatus:true,readOnly:true,aboveQuota:true,widths:[1440,1100,390,360],aligned:true,errors:0,writes:0}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
