const {chromium}=require('playwright');const fs=require('node:fs');const http=require('node:http');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),now=new Date().toISOString(),resetAt=new Date(Date.now()+7200000).toISOString();
const pct=(key,value,extra={})=>({key,label:key==='5h'?'5 小时额度窗口':'7 天额度窗口',kind:'percent',scope:'upstream',usedPercent:value,freshness:'fresh',resetAt,...extra});
const base=(id,name,metrics,extra={})=>({id,name,platform:'openai',type:'oauth',planLabel:'Team Pro',planSource:'upstream',status:'active',schedulable:true,freshness:'fresh',observedAt:now,metrics,...extra});
const accounts=[
 base('1','OpenAI_5X',[pct('5h',38),pct('7d',55)],{planLabel:'Pro 5x'}),
 base('2','低电量与空电池',[pct('5h',70),pct('7d',100)]),
 base('3','满电池与黄色边界',[pct('5h',0),pct('7d',50)]),
 base('4','精确颜色边界',[pct('5h',69.5),pct('7d',49.5)]),
 base('5','极小非零余量',[pct('5h',99.9999),pct('7d',.0001)]),
 base('6','历史额度',[pct('5h',80,{freshness:'stale'})],{freshness:'stale'}),
 base('7','剩余比例与超额',[pct('5h',undefined,{remainingPercent:30}),pct('7d',120)]),
 base('8','未知额度',[pct('5h',null),pct('7d',-1)]),
 base('9','API 余额',[{key:'balance',label:'账户共享余额',kind:'balance',unit:'USD',value:5715.66},{key:'local-limit',label:'本站消费限额',kind:'count',scope:'local',unit:'USD',used:20,remaining:80,limit:100,usedPercent:20}],{type:'apikey',planLabel:'API 计费'}),
 base('10','<img src=x onerror=alert(1)>',[pct('5h',50,{label:'<script>alert(1)</script>'})])
];
let status={accounts,updatedAt:now,refreshIntervalMs:600000};const writes=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');const json=value=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 if(req.method!=='GET'){writes.push(url.pathname);res.writeHead(405);return res.end();}
 if(url.pathname.endsWith('/api/session'))return json({authenticated:false,publicAccess:true,canManage:false});
 if(url.pathname.endsWith('/api/status'))return json(status);
 const file={'/quota/':'index.html','/quota/app.js':'app.js','/quota/style.css':'style.css'}[url.pathname];
 if(!file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'public',file)));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);await page.locator('.overview-battery').first().waitFor();
  const expected=[['1',0,62,6,'high'],['1',1,45,5,'medium'],['2',0,30,3,'low'],['2',1,0,0,'low'],['3',0,100,10,'high'],['3',1,50,5,'medium'],['4',0,30.5,3,'medium'],['4',1,50.5,5,'high'],['5',0,.0001,1,'low'],['5',1,99.9999,9,'high'],['7',0,30,3,'low'],['7',1,0,0,'low']];
  for(const[id,index,remaining,filled,tone]of expected){const gauge=page.locator(`[data-account-id="${id}"] .overview-battery`).nth(index);assert.ok(Math.abs(Number(await gauge.getAttribute('aria-valuenow'))-remaining)<.000001);assert.equal(await gauge.locator('.filled').count(),filled);assert.equal(await gauge.locator('..').getAttribute('data-charge'),tone);assert.equal(await gauge.getAttribute('role'),'meter');assert.match(await gauge.getAttribute('aria-label'),/剩余/);assert.equal(await gauge.locator('.overview-battery-cell').count(),10);}
  assert.equal(await page.locator('[data-account-id="8"] .overview-battery,[data-account-id="9"] .overview-battery').count(),0);
  assert.ok((await page.locator('[data-account-id="9"]').innerText()).includes('5,715.66'));
  assert.match(await page.locator('[data-account-id="6"] .overview-battery').getAttribute('aria-valuetext'),/旧缓存/);
  assert.match(await page.locator('[data-account-id="5"] .overview-remaining').first().innerText(),/<0.01/);
  assert.equal(await page.locator('#accounts img,#accounts script').count(),0);
  assert.equal(await page.locator('#accounts .progress-track').count(),0);
  for(const width of[1440,1100,390,360]){
   await page.setViewportSize({width,height:1080});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.ok(await page.locator('.overview-battery').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().right+6<=node.parentElement.getBoundingClientRect().right)));
   assert.ok(await page.locator('.overview-charge').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)));
   const rows=await page.locator('.account-card').evaluateAll(nodes=>nodes.map(node=>({top:node.offsetTop,height:node.getBoundingClientRect().height})));const seen=new Map();
   for(const row of rows){if(seen.has(row.top))assert.ok(Math.abs(seen.get(row.top)-row.height)<1);else seen.set(row.top,row.height);}
   if([1440,390].includes(width))await page.screenshot({path:path.join(root,`data/screenshots/overview-battery-${width}.png`)});
  }
  const details=page.locator('[data-account-id="1"] .account-details');await details.locator('summary').click();assert.match(await details.innerText(),/已用% 38/);await details.locator('summary').click();
  await page.locator('#search').fill('OpenAI_5X');assert.equal(await page.locator('.account-card').count(),1);await page.locator('#search').fill('');
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log(JSON.stringify({remainingBatteries:true,boundaryCases:expected.length,unknownAndBalancePreserved:true,oldDataLabeled:true,widths:[1440,1100,390,360],aligned:true,overflow:false,errors:0,writes:0}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1});
