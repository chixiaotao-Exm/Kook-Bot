const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const assert=require('node:assert/strict');const{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const pngs=[1,2,3].map(i=>fs.readFileSync(path.join(root,`output/broadcast-glass/openai-glass-${i}.png`)));
let preview={format:'image',accountCount:8,images:pngs.map((buffer,i)=>({url:`./api/report-images/${String(i+1).repeat(64)}.png`,width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20),alt:`OpenAI 额度第${i+1}页`}))};
let broken=false;const writes=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(req.method!=='GET'){writes.push(url.pathname);res.writeHead(405);return res.end();}
 if(url.pathname==='/quota/api/session')return json({publicAccess:true,authenticated:false});
 if(url.pathname==='/quota/api/status')return json({accounts:[],updatedAt:new Date().toISOString(),refreshIntervalMs:600000});
 if(url.pathname==='/quota/api/report-config')return json({enabled:true,configured:true,times:Array.from({length:48},(_,i)=>`${String(Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`)});
 if(url.pathname==='/quota/api/report-preview')return json(preview);
 if(url.pathname==='/quota/api/reports')return json({records:[]});
 if(url.pathname.startsWith('/quota/api/report-images/')){const index=Number(url.pathname.split('/').at(-1)[0])-1;if(broken||!pngs[index]){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'image/png'});return res.end(pngs[index]);}
 const file={'/quota/':'index.html','/quota/app.js':'app.js','/quota/style.css':'style.css'}[url.pathname];
 if(!file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('css')?'text/css':file.endsWith('js')?'text/javascript':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'public',file)));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/quota/`);await page.locator('[data-view=reports]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.report-image-page img').length===3&&[...document.querySelectorAll('.report-image-page img')].every(img=>img.complete&&img.naturalWidth===1000));
  assert.equal(await page.locator('.report-image-page').count(),3);assert.equal(await page.locator('.report-card').count(),0);
  assert.ok((await page.locator('.report-image-page figcaption').first().innerText()).includes('1 / 3'));
  for(const width of [1440,390,360]){await page.setViewportSize({width,height:1050});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('.preview-panel').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,`data/screenshots/image-preview-${width}.png`)});}
  for(const link of await page.locator('.report-image-page a').all()){assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);}
  preview={...preview,images:[preview.images[0]]};
  await page.locator('#preview-refresh').click();await page.waitForFunction(()=>document.querySelector('.report-image-page figcaption')?.textContent.includes('高清总览'));
  assert.equal(await page.locator('.report-image-page img').count(),1);
  preview={format:'image',images:[{url:'https://example.invalid/api/report-images/'+ 'a'.repeat(64)+'.png',alt:'bad'},{url:'javascript:alert(1)'},{url:'./api/report-images/'+ 'a'.repeat(64)+'.png?key=secret'},{url:'./api/report-images/'+ 'a'.repeat(64)+'.png#token'},{url:'./api/other.png'}]};
  await page.locator('#preview-refresh').click();await page.waitForFunction(()=>document.querySelector('#report-preview').textContent.includes('图片预览暂不可用'));assert.equal(await page.locator('#report-preview img').count(),0);
  preview={format:'image',images:[{url:'./api/report-images/'+ '9'.repeat(64)+'.png',alt:'<img onerror=alert(1)>'}]};broken=true;
  await page.locator('#preview-refresh').click();await page.locator('.report-image-error').waitFor();assert.ok(await page.locator('.report-image-page a').isHidden());
  preview={text:'旧版兼容预览'};await page.locator('#preview-refresh').click();await page.waitForFunction(()=>document.querySelector('#report-preview').textContent==='旧版兼容预览');
  assert.equal(await page.locator('#report-preview').evaluate(node=>node.classList.contains('has-images')),false);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log(JSON.stringify({pages:3,widths:[1440,390,360],imagesLoaded:true,unsafeUrlsBlocked:true,imageErrorHandled:true,textFallback:true,errors:0,writes:0}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
