// Real social preview with isolated data, identities and RoomAccess/Player/SocialRooms APIs.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'), port=Number(process.env.SOCIAL_PREVIEW_PORT||8794), base=`http://127.0.0.1:${port}`;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const secrets=[];const safe=(value)=>secrets.reduce((text,secret)=>text.split(secret).join('[PRIVATE]'),String(value));
(async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kook-social-ui-'));
  const preview=spawn(process.execPath,[path.join(root,'src/preview.js')],{cwd:dir,env:{...process.env,PREVIEW_PORT:String(port),PREVIEW_SOCIAL:'true',PREVIEW_REQUIRE_PASSWORD:'false'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='',exited=false,browser;preview.stdout.on('data',(x)=>log+=x);preview.stderr.on('data',(x)=>log+=x);preview.on('exit',()=>exited=true);
  const pass=(name)=>console.log(`PASS ${name}`), errors=[];
  async function until(task,timeout=18000){const start=Date.now();while(Date.now()-start<timeout){if(await task())return;await wait(150);}throw Error('Timed out waiting for social UI state');}
  const read=async(page,route)=>{const res=await page.request.get(base+'/api'+route);assert.equal(res.status(),200,route);return res.json();};
  const post=async(page,route,data,expected=200)=>{const session=await read(page,'/session');const res=await page.request.post(base+'/api'+route,{data,headers:{'X-CSRF-Token':session.csrf,Origin:base}});assert.equal(res.status(),expected,`${route} status`);return res.json();};
  async function name(page,value){await page.locator('#identity-button').click();await page.locator('#nickname').fill(value);await page.locator('#identity-form button[type=submit]').click();await page.locator('#identity-dialog').waitFor({state:'hidden'});}
  async function enter(page,url='/room/default'){await page.goto(base+url);await page.locator('#room:not([hidden]),#lobby:not([hidden])').waitFor();}
  async function add(page,id){await page.locator('#room-query').fill(id);await page.locator('#room-query').press('Enter');await page.locator('[data-request="preview"]').waitFor();await page.locator('[data-request="preview"]').click();await until(async()=>(await read(page,'/room?botId=default')).mine.some((entry)=>entry.track.id===id));}
  async function invite(page,role){await page.locator('#manage-room-roles').click();await page.locator('#invite-role').selectOption(role);await page.locator('#create-invite').click();await page.locator('#new-invite').waitFor({state:'visible'});const url=await page.locator('#invite-url').inputValue();secrets.push(new URLSearchParams(new URL(url).hash.slice(1)).get('invite'));await page.locator('#roles-dialog [data-close]').click();return url;}
  try{
    await until(()=>{if(exited)throw Error('Social preview startup failed: '+safe(log));return log.includes(`Preview: ${base}`);},15000);
    const privateAdmin=JSON.parse(await fs.readFile(path.join(dir,'data/preview/social-runs',String(preview.pid),'preview-admin.json'),'utf8')).token;secrets.push(privateAdmin);
    browser=await chromium.launch({channel:'msedge',headless:true});
    const contexts=await Promise.all([1,2,3].map(()=>browser.newContext({viewport:{width:1440,height:1000}})));
    const [admin,a,b]=await Promise.all(contexts.map((context)=>context.newPage()));
    for(const page of [admin,a,b]){page.setDefaultTimeout(15000);page.on('pageerror',(e)=>errors.push(e.message));}
    await enter(a,'/');assert.equal((await read(a,'/state')).preview,true);assert.equal((await read(a,'/session')).accessControlled,true);assert.equal(await a.locator('.room-card').count(),2);assert.equal(await a.locator('#console-link').isVisible(),false);await enter(a,'/rooms');assert.equal(await a.locator('.room-card').count(),2);
    await enter(a);await until(async()=>(await read(a,'/room?botId=default')).members.webCount>=1);assert.equal(await a.locator('#dj-controls').isVisible(),true);assert.equal(await a.locator('#room-volume').isDisabled(),true);await a.locator('#playback-identity').click();await a.locator('#identity-dialog').waitFor({state:'visible'});await a.locator('#identity-dialog [data-close]').click();
    await post(a,'/control',{botId:'default',action:'volume',value:0},403);await post(a,'/room/request',{botId:'default',input:'1000010',source:'netease',role:'owner'},403);
    assert.equal(await a.locator('#console-link').isVisible(),false);await a.goto(base+'/admin/console');await a.waitForURL(base+'/admin?'+new URLSearchParams({returnTo:'/admin/console'}));await a.locator('#admin-heading').filter({hasText:'管理员登录'}).waitFor();
    pass('root and /rooms show the public lobby; anonymous console access redirects to login and forged member requests are rejected');

    await enter(a);await name(a,'晚风 A');assert.equal(await a.locator('#console-link').isVisible(),false);await enter(b);await name(b,'山月 B');
    const controls=[];a.on('request',(request)=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/room/control')controls.push(request.postDataJSON());});
    assert.equal(await a.locator('#dj-console').isVisible(),false);assert.equal(await a.locator('#owner-panel').isVisible(),false);assert.equal(await a.locator('#edit-room').isVisible(),false);
    const otherBefore=(await read(a,'/room?botId=preview-two')).player;
    await a.locator('#room-play-toggle').click();await until(async()=>(await read(a,'/room?botId=default')).player.status==='paused');
    await a.locator('#room-progress:not([disabled])').evaluate((el)=>{el.value='65';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await until(async()=>(await read(a,'/room?botId=default')).player.seconds===65);
    await a.locator('#room-play-toggle:not([disabled])').click();await until(async()=>(await read(a,'/room?botId=default')).player.status==='playing');
    await a.locator('#room-volume:not([disabled])').evaluate((el)=>{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));el.value='41';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await wait(4200);assert.equal(await a.locator('#room-volume').inputValue(),'41');assert.equal(await a.locator('#room-volume-value').textContent(),'41%');
    await a.locator('#room-volume:not([disabled])').evaluate((el)=>{el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
    await until(async()=>(await read(a,'/room?botId=default')).player.volume===41);
    const originalSong=(await read(a,'/room?botId=default')).player.current.id;
    await a.locator('[data-control=skip]:not([disabled])').click();await until(async()=>(await read(a,'/room?botId=default')).player.current.id!==originalSong);
    await a.locator('[data-control=previous]:not([disabled])').click();await until(async()=>(await read(a,'/room?botId=default')).player.current.id===originalSong);
    for(const mode of ['one','all','off']){await a.locator('#room-loop:not([disabled])').selectOption(mode);await until(async()=>(await read(a,'/room?botId=default')).player.mode===mode);}
    const queuedBefore=(await read(a,'/room?botId=default')).queue.map((entry)=>entry.entryId).sort();
    await a.locator('[data-control=shuffle]:not([disabled])').click();await until(()=>controls.some((item)=>item.action==='shuffle'));await until(async()=>await a.locator('[data-control=clear]').isEnabled());
    assert.deepEqual((await read(a,'/room?botId=default')).queue.map((entry)=>entry.entryId).sort(),queuedBefore);
    const beforeCancel=controls.length;a.once('dialog',(dialog)=>{assert.match(dialog.message(),/当前歌曲会继续播放/);assert.match(dialog.message(),/自动电台/);return dialog.dismiss();});
    await a.locator('[data-control=clear]').click();await wait(200);assert.equal(controls.length,beforeCancel);assert.equal((await read(a,'/room?botId=default')).queue.length,queuedBefore.length);
    a.once('dialog',(dialog)=>dialog.accept());await a.locator('[data-control=clear]').click();await until(async()=>(await read(a,'/room?botId=default')).queue.length===0);assert.equal((await read(a,'/room?botId=default')).player.current.id,originalSong);
    assert.deepEqual((await read(a,'/room?botId=preview-two')).player,otherBefore);assert.deepEqual(new Set(controls.map((item)=>item.action)),new Set(['pause','seek','resume','volume','skip','previous','loop','shuffle','clear']));assert.ok(controls.every((item)=>item.expectedVoiceChannelId==='20001'&&item.botId==='default'));
    await post(a,'/control',{botId:'default',action:'volume',value:2},403);await post(a,'/room/profile',{botId:'default',title:'不可改',description:'',theme:'bamboo'},403);await post(a,'/room/invite',{botId:'default',role:'dj'},403);
    pass('ordinary named members can pause/resume, seek, adjust volume without polling interference, switch tracks, loop, shuffle and confirm shared queue clearing; another bot and management permissions stay unchanged');
    const extra=await contexts[1].newPage();await enter(extra);await until(async()=>(await read(a,'/room?botId=default')).members.webCount===2);
    assert.equal((await read(a,'/session')).actor.id,(await read(extra,'/session')).actor.id);
    await until(async()=>Number.isInteger((await read(a,'/room?botId=default')).members.voiceCount));const members=(await read(a,'/room?botId=default')).members;assert.equal(members.web.filter((m)=>m.name==='晚风 A').length,1);
    await add(a,'1000010');await add(b,'1000011');await a.locator('[data-tab="mine"]').click();await a.locator('[data-withdraw]').waitFor();
    const aEntry=(await read(a,'/room?botId=default')).mine[0];assert.equal(aEntry.requester.name,'晚风 A');await post(b,'/room/withdraw',{botId:'default',entryId:aEntry.entryId},400);
    assert.equal((await read(extra,'/room?botId=default')).mine.length,1);
    pass('three browser identities stay separate; same-browser tabs count once and my requests are owned on the server');

    await enter(admin,`/rooms#admin=${encodeURIComponent(privateAdmin)}`);await until(async()=>(await read(admin,'/session')).actor.siteAdmin);assert.equal(new URL(admin.url()).hash,'');await name(admin,'站长');await enter(admin);
    await post(admin,'/control',{botId:'default',action:'move',value:{from:aEntry.position,to:1}});
    await a.locator(`[data-withdraw="${aEntry.entryId}"]`).click();await until(async()=>(await read(a,'/room?botId=default')).mine.length===0);
    assert.equal((await read(b,'/room?botId=default')).mine.length,1);
    await admin.locator('#share-room').click();await admin.locator('#share-dialog').waitFor({state:'visible'});const shared=await admin.locator('#share-url').inputValue();assert.equal(new URL(shared).hash,'');assert.equal(new URL(shared).pathname,'/room/default');assert.ok((await admin.locator('#share-qr').getAttribute('src')).startsWith('data:image/png'));
    assert.ok(!secrets.some((token)=>shared.includes(token)));await admin.locator('#share-dialog [data-close]').click();
    pass('stable-entry withdrawal survives queue reordering; admin fragment is removed and ordinary QR share carries no access token');

    const ownerUrl=await invite(admin,'owner');await a.goto(ownerUrl);await a.locator('#edit-room').waitFor({state:'visible'});assert.equal(new URL(a.url()).hash,'');
    await a.locator('#edit-room').click();await a.locator('#room-profile-form [name=title]').fill('国风小筑');await a.locator('#room-profile-form [name=description]').fill('晚风与音乐，和朋友慢慢听。');await fs.mkdir(path.join(root,'data/screenshots'),{recursive:true});
    for(const theme of ['bamboo','blossom','night']){await a.locator('#room-profile-form [name=theme]').selectOption(theme);assert.equal(await a.locator('#profile-preview-title').textContent(),'国风小筑');assert.equal((await read(a,'/room?botId=default')).profile.theme,'bamboo');await a.locator('#profile-dialog').screenshot({path:path.join(root,'data/screenshots',`social-profile-${theme}.png`)});}
    await a.locator('#room-profile-form [name=theme]').selectOption('blossom');await a.locator('#room-profile-form button[type=submit]').click();await a.locator('#profile-dialog').waitFor({state:'hidden'});await until(async()=>(await read(a,'/room?botId=default')).profile.title==='国风小筑');
    await post(a,'/room/profile',{botId:'preview-two',title:'不可改',description:'',theme:'bamboo'},403);await post(a,'/room/invite',{botId:'default',role:'owner'},403);
    const djUrl=await invite(a,'dj');await b.goto(djUrl);await b.locator('#dj-controls').waitFor({state:'visible'});assert.equal(await b.locator('#owner-panel').isVisible(),false);assert.equal(new URL(b.url()).hash,'');
    await b.locator('#room-volume').evaluate((el)=>{el.value='29';el.dispatchEvent(new Event('change',{bubbles:true}));});await until(async()=>(await read(b,'/state?botId=default')).player.volume===29);
    assert.equal((await read(b,'/state?botId=preview-two')).player.volume,35);await post(b,'/control',{botId:'preview-two',action:'volume',value:4},403);await post(b,'/control',{botId:'default',action:'stop'},403);
    pass('owner appearance and DJ invitations are room-scoped; DJ controls its room without affecting another bot or owner actions');

    assert.equal(await a.locator('#console-link').getAttribute('href'),'/admin/console?botId=default');assert.equal(await a.locator('#room-settings-link').getAttribute('href'),'/admin/console?botId=default&view=room');assert.equal(await b.locator('#console-link').getAttribute('href'),'/admin/console?botId=default');assert.equal(await b.locator('#dj-console').getAttribute('href'),'/admin/console?botId=default');
    await b.locator('#dj-console').click();await b.waitForURL(base+'/admin/console?botId=default');await b.locator('#access-title').filter({hasText:'DJ'}).waitFor();assert.equal(await b.locator('#volume').isDisabled(),false);assert.equal(await b.locator('#leave-button').isDisabled(),true);assert.equal(await b.locator('#site-account-controls').isVisible(),false);
    await b.locator('#bot-select').selectOption('preview-two');await until(async()=>await b.locator('#volume').isDisabled());
    await a.locator('#room-settings-link').click();await a.waitForURL(base+'/admin/console?botId=default&view=room');await a.locator('#radio-form').waitFor();assert.equal(await a.locator('#site-account-controls').isVisible(),false);
    await admin.goto(base+'/');await admin.locator('.room-card').first().waitFor();assert.equal(await admin.locator('#app').count(),0);await admin.locator('#console-link').click();await admin.locator('#bot-select:not([disabled])').waitFor();await admin.locator('[data-view="account"]').click();await admin.locator('#site-account-controls').waitFor({state:'visible'});assert.equal(await admin.locator('#add-bot-button').isVisible(),true);
    pass('dedicated console preserves scoped DJ/owner controls and site-admin-only accounts; signed-in root remains the lobby');

    await enter(a);await enter(b);const djId=(await read(b,'/session')).actor.id;
    await a.locator('#manage-room-roles').click();await a.locator(`[data-revoke="${djId}"]`).click();await until(async()=>!(await read(b,'/room?botId=default')).permissions.control);await b.locator('#dj-console').waitFor({state:'hidden'});assert.equal(await b.locator('#dj-controls').isVisible(),true);assert.equal(await b.locator('#console-link').isVisible(),false);await post(b,'/control',{botId:'default',action:'volume',value:88},403);
    await b.locator('#room-volume').evaluate((el)=>{el.value='38';el.dispatchEvent(new Event('change',{bubbles:true}));});await until(async()=>(await read(b,'/room?botId=default')).player.volume===38);assert.equal((await read(b,'/room?botId=default')).permissions.playbackControl,true);
    await a.locator('#create-invite').click();await a.locator('#new-invite').waitFor({state:'visible'});const revokedUrl=await a.locator('#invite-url').inputValue();secrets.push(new URLSearchParams(new URL(revokedUrl).hash.slice(1)).get('invite'));
    const pending=(await read(a,'/room/roles?botId=default')).invites.filter((i)=>i.expires>Date.now()).at(-1);assert.ok(pending);await a.locator(`[data-revoke-invite="${pending.id}"]`).click();await a.locator('#roles-dialog [data-close]').click();
    await b.goto(revokedUrl);await b.locator('#portal-message').filter({hasText:'未能验证'}).waitFor();assert.equal((await read(b,'/room?botId=default')).permissions.control,false);
    pass('DJ revocation immediately removes management access while ordinary member playback remains available; a revoked invitation cannot restore DJ rights');

    await fs.mkdir(path.join(root,'data/screenshots'),{recursive:true});
    for(const [width,height]of[[1440,1000],[360,820]]){await a.setViewportSize({width,height});for(const route of ['/','/rooms','/room/default']){await enter(a,route);if(route.includes('/room/'))await a.locator('#room-title').filter({hasText:'国风小筑'}).waitFor();else await a.locator('.room-card').first().waitFor();assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${route} ${width}px overflow`);await a.screenshot({path:path.join(root,'data/screenshots',`social-${route==='/'?'home':route==='/rooms'?'lobby':'room'}-${width}.png`),fullPage:true});}}
    await b.locator('#identity-button').click();b.once('dialog',(dialog)=>dialog.accept());await b.locator('#leave-identity').click();await until(async()=>(await read(b,'/session')).actor.name==='');assert.equal((await read(b,'/room?botId=default')).mine.length,0);assert.equal((await read(a,'/room?botId=default')).permissions.manageRoom,true);
    assert.deepEqual(errors,[]);await extra.close();
    pass('desktop/mobile fit without overflow; logout replaces only this browser identity and clears access to previous my-requests');
  }finally{if(browser)await browser.close();if(!exited){preview.kill('SIGTERM');await Promise.race([new Promise((r)=>preview.once('exit',r)),wait(5000)]);}if(!exited)preview.kill('SIGKILL');console.log('Isolated social preview stopped; no access tokens printed.');}
})().catch((error)=>{console.error(safe(error.stack||error.message));process.exitCode=1;});
