// Real WebConsole + Player + RoomFeatures + Diagnostics, with src/preview.js music/voice providers.
// Starts its own loopback preview and isolated data directory; never uses production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');
const port = Number(process.env.FEATURE_PREVIEW_PORT || 8789);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const base = new URL(`http://127.0.0.1:${port}/`);
const fingerprint = (state) => JSON.stringify({ current: state.player.current, queue: state.player.queue,
  status: state.player.status, volume: state.player.volume, seconds: state.player.seconds, context: state.player.context });

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kook-feature-integration-'));
  const child = spawn(process.execPath, [path.join(root, 'src/preview.js')], {
    cwd: dir, env: { ...process.env, PREVIEW_PORT: String(port), PREVIEW_REQUIRE_PASSWORD: 'false' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', childExited = false, browser, page, verifiedPreview = false;
  child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
  child.on('exit', () => { childExited = true; });
  const read = async (route) => { const response = await page.request.get(new URL('/api' + route, base).href); assert.equal(response.status(),200,route); return response.json(); };
  const write = async (route, data) => {
    assert.equal(verifiedPreview,true,'Only a verified preview may be changed');
    const session = await read('/session');
    const response = await page.request.post(new URL('/api' + route, base).href, { data, headers:{ 'X-CSRF-Token':session.csrf, Origin:base.origin } });
    assert.equal(response.status(),200,`${route}: ${await response.text()}`); return response.json();
  };
  const state = (id='default') => read(`/state?botId=${id}`);
  const settings = (id='default') => read(`/features?botId=${id}`);
  const persisted = async () => JSON.parse(await fs.readFile(path.join(dir,'data/preview/feature-runs',`${child.pid}-default`,'room-features.json'),'utf8'));
  async function until(predicate, timeout=18000) {
    const start=Date.now(); while(Date.now()-start<timeout) { if(await predicate()) return; await wait(250); } throw new Error('Timed out waiting for runtime state');
  }
  try {
    await until(()=> { if(childExited) throw new Error(`Preview startup failed: ${log}`); return log.includes(`Preview: ${base.origin}`); },15000);
    browser = await chromium.launch({channel:'msedge',headless:true});
    page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(15000);
    const errors=[], mutations=[];
    page.on('pageerror',(error)=>errors.push(error.message));
    page.on('request',(req)=>{const url=new URL(req.url());if(url.origin===base.origin&&req.method()==='POST')mutations.push({route:url.pathname,...req.postDataJSON()});});
    await page.goto(base.href); await page.locator('#bot-select:not([disabled])').waitFor();
    assert.equal((await state()).preview,true); verifiedPreview=true;
    const initialSecond = await state('preview-two'), baseline = fingerprint(initialSecond);
    assert.equal((await settings()).features.radio.enabled,false);
    assert.equal((await settings()).features.rules.enabled,false);
    assert.deepEqual((await settings()).features.schedules,[]);

    await page.locator('[data-view="room"]').click(); await page.locator('#radio-form').waitFor();
    await page.locator('[name="enabled"]').check(); await page.locator('[name="lowWatermark"]').fill('20');
    await page.locator('[name="batchSize"]').fill('4'); await page.locator('#radio-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#room-feedback').textContent.includes('已保存'));
    assert.equal(mutations.findLast((m)=>m.route==='/api/features').botId,'default');
    const before = (await state()).player.queue.length;
    await until(async()=>Boolean((await settings()).features.radio.lastRunAt));
    const filled = await state(); assert.equal(filled.player.queue.length,before+4);
    assert.equal(filled.player.queue.filter((item)=>item.requestedBy==='auto-radio').length,4);
    assert.equal(fingerprint(await state('preview-two')),baseline);
    console.log('PASS real RoomFeatures automatic fill adds four songs only to selected bot');

    await write('/control',{botId:'default',action:'pause'});
    await write('/control',{botId:'default',action:'clear'});
    await until(async()=>(await settings()).features.radio.suspended);
    const paused = await state(), pausedRunAt = (await settings()).features.radio.lastRunAt;
    await wait(11000); assert.equal((await state()).player.status,'paused');
    assert.equal((await state()).player.seconds,paused.player.seconds); assert.equal((await state()).player.queue.length,0);
    assert.equal((await settings()).features.radio.lastRunAt,pausedRunAt);
    assert.equal((await persisted()).radioState.suspended,true);
    await page.locator('#room-reload').click(); await page.locator('#radio-form').waitFor();
    await page.locator('[name="enabled"]').uncheck(); await page.locator('#radio-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#room-feedback').textContent.includes('已保存'));
    assert.equal((await settings()).features.radio.enabled,false); assert.equal((await persisted()).radio.enabled,false);
    console.log('PASS manual pause durably suspends automatic fill and preserves playback progress; radio disables cleanly');

    await page.locator('[data-room-tab="schedules"]').click(); await page.locator('#schedule-add').click();
    await page.locator('[name="name"]').fill('集成验收·不执行'); await page.locator('[name="enabled"]').uncheck();
    await page.locator('[name="action"]').selectOption('volume'); await page.locator('[name="volume"]').fill('18');
    await page.locator('[name="timeZone"]').fill('Asia/Shanghai');
    await page.locator('#schedule-form button[type="submit"]').click(); await page.locator('.schedule-card').waitFor();
    const scheduled=(await settings()).features.schedules[0]; assert.equal(scheduled.enabled,false);assert.equal(scheduled.volume,18);assert.equal(scheduled.timeZone,'Asia/Shanghai');
    assert.equal((await persisted()).schedules[0].enabled,false);
    await page.locator('#room-reload').click(); await page.locator('.schedule-card').waitFor(); assert.match(await page.locator('.schedule-card').innerText(),/集成验收·不执行/);
    await page.locator('[data-room-tab="rules"]').click();await page.locator('[name="enabled"]').check();await page.locator('[name="perUserLimit"]').fill('3');await page.locator('[name="managerIds"]').fill('123, 456');
    await page.locator('#rules-form button[type="submit"]').click(); await page.waitForFunction(()=>document.querySelector('#room-feedback').textContent.includes('已保存'));
    const savedRules=(await persisted()).rules;assert.equal(savedRules.enabled,true);assert.equal(savedRules.perUserLimit,3);assert.deepEqual(savedRules.managerIds,['123','456']);
    assert.equal((await settings('preview-two')).features.rules.enabled,false);assert.deepEqual((await settings('preview-two')).features.schedules,[]);
    console.log('PASS disabled schedule survives reread and file persistence; KOOK room rules persist independently');

    await page.locator('[data-view="player"]').click();await page.locator('[data-music-source="all"]').click();
    await page.locator('#search-input').fill('晴天');await page.locator('#search-input').press('Enter'); await page.locator('.search-group').first().waitFor();
    assert.equal(await page.locator('.search-group').count(),2);assert.ok(await page.locator('#search-results [data-item-source="netease"]').count()>0);assert.ok(await page.locator('#search-results [data-item-source="qq"]').count()>0);
    const queueBeforeLinks=(await state()).player.queue.length, addBefore=mutations.filter((m)=>['/api/play','/api/playlist'].includes(m.route)).length;
    for(const [input,source] of [['https://163cn.tv/preview','netease'],['https://c6.y.qq.com/base/fcgi-bin/u?__=preview','qq']]) {
      await page.locator('#search-input').fill(input);await page.waitForFunction((source)=>{const el=document.querySelector('#smart-link-preview');return el.dataset.smartSource===source&&el.dataset.smartKind==='playlist'&&Boolean(el.querySelector('#smart-link-add'));},source);
      assert.match(await page.locator('#smart-link-preview').innerText(),/123/);
    }
    assert.equal((await state()).player.queue.length,queueBeforeLinks);assert.equal(mutations.filter((m)=>['/api/play','/api/playlist'].includes(m.route)).length,addBefore);
    console.log('PASS real search-all groups preserve platform labels; both preview shortlinks resolve to read-only playlist previews');

    await page.locator('[data-view="lyrics"]').click();await page.locator('.lyric-line.current').waitFor();
    assert.match(await page.locator('#lyrics-meta').innerText(),/桃音音乐机器人/);
    const line=await page.locator('.lyric-line.current p').innerText();await wait(2200);assert.equal(await page.locator('.lyric-line.current p').innerText(),line);
    assert.equal((await state()).player.seconds,paused.player.seconds);
    await page.locator('#bot-select').selectOption('preview-two');await page.waitForFunction(()=>document.querySelector('#lyrics-meta').textContent.includes('深夜音乐机器人'));
    assert.match(await page.locator('.lyric-line.current p').innerText(),/下一段旋律/);
    assert.equal(fingerprint(await state('preview-two')),baseline);
    console.log('PASS real paused playback freezes lyrics; selecting another bot uses its independent song and timestamp');

    await page.locator('[data-view="health"]').click();await page.locator('.health-event').first().waitFor();
    const health=await read('/health');assert.equal(health.summary.bots,2);assert.ok(health.events.some((event)=>event.kind==='radio_fill'));assert.ok(health.events.some((event)=>event.kind==='settings_saved'));
    assert.match(await page.locator('#health-events').innerText(),/自动电台已补充 4 首/);
    assert.deepEqual(errors,[]);
    console.log('PASS Diagnostics records real automatic-fill/settings events and renders without script errors');

    await fs.mkdir(path.join(root,'data/screenshots'),{recursive:true});
    for(const [width,height] of [[1440,1000],[360,800]]) {await page.setViewportSize({width,height});for(const view of ['room','health','lyrics']) {await page.locator(`[data-view="${view}"]`).click();await wait(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view} ${width}px overflow`);await page.screenshot({path:path.join(root,'data/screenshots',`feature-integration-${view}-${width}.png`),fullPage:true});}}
    console.log('PASS integrated desktop/mobile feature views fit without horizontal overflow');
  } finally {
    if(verifiedPreview&&page&&!childExited) {
      for(const id of ['default','preview-two']) {
        try {const current=(await settings(id)).features;await write('/features',{botId:id,section:'radio',value:{...current.radio,enabled:false}});await write('/features',{botId:id,section:'rules',value:{...current.rules,enabled:false}});await write('/features',{botId:id,section:'schedules',value:[]});} catch(error){console.error(`Preview cleanup failed for ${id}: ${error.message}`);}
      }
    }
    if(browser)await browser.close();
    if(!childExited) {child.kill('SIGTERM');await Promise.race([new Promise((resolve)=>child.once('exit',resolve)),wait(5000)]);}
    if(!childExited)child.kill('SIGKILL');
    console.log(`Isolated preview stopped; review data retained at ${dir}`);
  }
})().catch((error)=>{console.error(error);process.exitCode=1;});
