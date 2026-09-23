// Runs the frontend against an entirely local, in-memory API. Never contacts KOOK or music accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const clone = (value) => structuredClone(value);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const bundle = await build({ entryPoints: ['frontend/app.js'], bundle: true, format: 'esm', write: false });
  const html = await fs.readFile('web/index.html');
  const song = { id: '1', source: 'netease', name: 'UI 测试歌曲', artists: '测试歌手', durationMs: 240000 };
  const bots = [{ id: 'default', name: '房间一', online: true, status: 'ready', managed: false }, { id: 'second', name: '房间二', online: true, status: 'ready', managed: true }];
  const makeFeatures = () => ({ radio: { enabled: false, source: 'netease', strategy: 'hot', lowWatermark: 2, batchSize: 10, avoidRecent: 50 }, schedules: [], rules: { enabled: false, perUserLimit: 5, preventDuplicates: true, voteSkip: true, voteThreshold: 2, managerIds: [] }, votes: { count: 0, required: 2 } });
  const features = { default: makeFeatures(), second: makeFeatures() }, posts = [], errors = [], requests = [];
  let lyricSong = song, seconds = 3, status = 'paused', heldFeatures = false, releaseFeatures;
  let qrPolls = 0, qqLogged = false, searchQQError = true;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      const types = { '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.webp':'image/webp' };
      try {
        const target = url.pathname === '/' ? null : path.join('web', url.pathname.slice(1));
        if (target && !['/app.js','/style.css','/theme.css','/favicon.svg','/assets/background.svg'].includes(url.pathname)) { res.writeHead(404); res.end(); return; }
        const body = !target ? html : url.pathname === '/app.js' ? bundle.outputFiles[0].contents : await fs.readFile(target);
        res.writeHead(200, { 'Content-Type': !target ? 'text/html' : types[path.extname(target)] }); res.end(body);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    requests.push(url.pathname + url.search);
    let input = ''; for await (const chunk of req) input += chunk;
    const data = input ? JSON.parse(input) : {}, botId = data.botId || url.searchParams.get('botId') || 'default';
    if (req.method === 'POST') posts.push({ route: url.pathname, ...data });
    let body = {}, code = 200;
    switch (url.pathname) {
      case '/api/session': body = { authenticated: true, passwordRequired: false, csrf: 'test' }; break;
      case '/api/bots': body = { bots, defaultBotId: 'default' }; break;
      case '/api/state': body = { botId, bot: bots.find((bot) => bot.id === botId), bots, preview: true, activity: [], uptime: 300,
        player: { current: lyricSong, queue: [], seconds, status, mode: 'off', volume: 60, connected: true, stayConnected: true, maxQueue: 500, capacity: 499, context: { guildId: '1', voiceChannelId: botId === 'default' ? '2' : '3' } } }; break;
      case '/api/catalog': body = { guilds: [{ id: '1', name: '测试服务器', channels: [{ id: '2', name: '频道一', type: 2 }, { id: '3', name: '频道二', type: 2 }] }] }; break;
      case '/api/sources': body = { sources: [{ id: 'netease', name: '网易云音乐', enabled: true }, { id: 'qq', name: 'QQ音乐', enabled: true }] }; break;
      case '/api/account': body = { loggedIn: url.searchParams.get('source') !== 'qq' || qqLogged, status: 'logged_in' }; break;
      case '/api/features':
        if (req.method === 'POST') features[botId][data.section] = data.value;
        if (heldFeatures && botId === 'default' && req.method === 'GET') { heldFeatures = false; const old = clone(features[botId]); old.radio.batchSize = 49; await new Promise((resolve) => { releaseFeatures = resolve; }); body = { botId, features: old }; break; }
        body = { ok: true, botId, features: clone(features[botId]) }; break;
      case '/api/search-all': body = { groups: [{ source: 'netease', name:'网易云音乐', tracks: [song] }, { source: 'qq', name: 'QQ音乐', tracks: searchQQError ? [] : [{ ...song, source: 'qq', id: '2' }], error: searchQQError ? 'QQ 临时不可用' : undefined }], tracks: [song], errors: [] }; break;
      case '/api/search': body = { tracks: [{ ...song, source: url.searchParams.get('source') }] }; break;
      case '/api/lyrics':
        if (url.searchParams.get('id') === 'old') { await wait(500); body = { available: true, lines: [{ time: 0, text: '不应出现的旧歌词' }] }; }
        else if (url.searchParams.get('id') === '2') body = { available: false, lines: [], plain: '', notice: '这首歌暂无歌词' };
        else body = { available: true, lines: [{ time: 0, text: '第一句', translation: 'first' }, { time: 2, text: '第二句', translation: 'second' }, { time: 7, text: '第三句' }] }; break;
      case '/api/health': body = { generatedAt: Date.now(), summary: { bots: 2, online: 2, connected: 2, issues: 2 }, storageError: '测试记录无法保存', accounts: { netease: { loggedIn: true, checkedAt: Date.now() }, qq: { loggedIn: false, status: 'expired', checkedAt: Date.now() } }, bots: bots.map((bot) => ({ ...bot, connected: true, status:'paused', source:'netease', trackName:song.name })), events: [{ id:'event1', time:Date.now(), botName:'房间二', level:'warning', message:'测试音源失败，请检查账号' }], limitations:'连接与播放进度不能证明频道内实际有声音。' }; break;
      case '/api/account/qr':
        if (req.method === 'POST') body = { image:'data:image/png;base64,iVBORw0KGgo=', expires:Date.now()+180000 };
        else if (++qrPolls === 1) { code = 503; body = { error: '临时网络故障' }; }
        else { qqLogged = true; body = { status:'success' }; } break;
      case '/api/control': status = data.action === 'resume' ? 'playing' : status; body = { ok:true }; break;
      case '/api/resolve': body = { kind:'playlist',source:'qq',isLink:true,input:'123',total:2,playlist:{name:'短链接歌单',id:'123'},tracks:[song] }; break;
      default: body = { ok:true, tracks: [], playlists: [] };
    }
    res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel:'msedge', headless:true });
  const page = await browser.newPage({ viewport:{width:1440,height:1000} });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  try {
    await page.goto(base); await page.locator('#bot-select:not([disabled])').waitFor();
    await page.locator('[data-view="room"]').click(); await page.locator('#radio-form').waitFor();
    await page.locator('[name="enabled"]').check(); await page.locator('[name="batchSize"]').fill('12');
    await page.locator('#radio-form button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('#room-feedback').textContent.includes('已保存'));
    assert.equal(features.default.radio.batchSize, 12); assert.equal(features.second.radio.enabled, false);
    await page.locator('[data-room-tab="schedules"]').click(); await page.locator('#schedule-add').click();
    await page.locator('[name="name"]').fill('夜间降音量'); await page.locator('[name="action"]').selectOption('volume'); await page.locator('[name="volume"]').fill('25');
    await page.locator('#schedule-form button[type="submit"]').click(); await page.locator('.schedule-card').waitFor();
    assert.equal(features.default.schedules[0].timeZone,'Asia/Shanghai'); assert.equal(features.default.schedules[0].volume,25);
    await page.locator('[data-schedule-toggle]').click(); await page.waitForFunction(() => document.querySelector('.schedule-card').textContent.includes('已停用'));
    assert.equal(features.default.schedules[0].enabled,false);
    await page.locator('[data-room-tab="rules"]').click(); await page.locator('[name="managerIds"]').fill('123, 456'); await page.locator('#rules-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#room-feedback').textContent.includes('已保存')); assert.deepEqual(features.default.rules.managerIds,['123','456']);
    console.log('PASS independent radio, schedule creation/toggle/timezone, room rules');
    await page.locator('[data-room-tab="radio"]').click(); heldFeatures = true; await page.locator('#room-reload').click();
    while (!releaseFeatures) await wait(10);
    await page.locator('#bot-select').selectOption('second'); await page.locator('#radio-form').waitFor(); releaseFeatures(); await wait(150);
    assert.equal(await page.locator('[name="batchSize"]').inputValue(),'10');
    console.log('PASS stale settings response cannot overwrite selected bot');
    await page.locator('[data-view="player"]').click(); await page.locator('[data-music-source="all"]').click();
    await page.locator('#search-input').fill('歌名'); await page.locator('#search-input').press('Enter'); await page.locator('.search-group').first().waitFor();
    assert.match(await page.locator('#search-results').innerText(),/QQ 临时不可用/); await page.locator('#search-results [data-add]').click();
    await page.waitForFunction(() => !document.body.classList.contains('working')); assert.equal(posts.findLast((p) => p.route === '/api/play').source,'netease');
    assert.ok(!requests.some((route) => /source=all/.test(route)));
    await page.locator('#search-input').fill('123'); await page.locator('#search-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#smart-link-preview').textContent.includes('纯数字'));
    await page.locator('#search-input').fill('https://c.y.qq.com/short/test'); await page.locator('#smart-link-add').waitFor();
    assert.match(await page.locator('#smart-link-preview').innerText(),/短链接歌单/);
    console.log('PASS joint search partial errors, source-specific addition, numeric guard and shortlink preview');
    await page.locator('[data-view="lyrics"]').click(); await page.locator('.lyric-line.current').waitFor();
    assert.equal(await page.locator('.lyric-line.current p').innerText(),'第二句'); await wait(500); assert.equal(await page.locator('.lyric-line.current p').innerText(),'第二句');
    await page.locator('#lyrics-translation').click(); assert.equal(await page.locator('.lyric-line>span').count(),0);
    await page.locator('#lyrics-immerse').click(); assert.ok(await page.locator('body').evaluate((el) => el.classList.contains('lyrics-immersive'))); await page.keyboard.press('Escape');
    lyricSong = { ...song,id:'old' }; await wait(1600); lyricSong = { ...song,id:'2',source:'qq' }; await page.locator('#bot-select').selectOption('default');
    await page.waitForFunction(() => document.querySelector('#lyrics-notice').textContent.includes('暂无歌词')); assert.equal(await page.locator('.lyric-line').count(),0);
    console.log('PASS lyrics timestamps, pause freeze, translation, immersion exit and song/bot switch');
    await page.locator('[data-view="health"]').click(); await page.locator('.health-event').waitFor();
    assert.match(await page.locator('#health-accounts').innerText(),/登录失效/); assert.match(await page.locator('#health-limits').innerText(),/不能证明/);
    assert.ok(await page.locator('#health-storage-error').isVisible()); assert.match(await page.locator('#health-storage-error').innerText(),/测试记录无法保存/);
    await page.locator('#health-refresh').click(); await page.waitForFunction(() => !document.querySelector('#health-refresh').disabled);
    assert.ok(requests.includes('/api/health?refresh=1'));
    console.log('PASS diagnostics and explicit account refresh');
    await page.locator('[data-view="account"]').click(); await page.locator('#qq-qr-button').click();
    await page.locator('#qr-dialog').waitFor({state:'hidden',timeout:18000}); assert.ok(qrPolls>=2); assert.equal(posts.filter((p)=>p.route==='/api/account/qr').length,1);
    console.log('PASS QR transient failure retries existing QR without regenerating it');
    await fs.mkdir('data/screenshots',{recursive:true});
    for (const size of [{width:1440,height:1000},{width:360,height:800}]) {
      await page.setViewportSize(size);
      for (const view of ['room','health','lyrics']) {
        await page.locator(`[data-view="${view}"]`).click(); await wait(100);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1), `${view} at ${size.width} overflow`);
        await page.screenshot({path:`data/screenshots/features-${view}-${size.width}.png`,fullPage:true});
      }
    }
    assert.deepEqual(errors,[]); console.log('PASS desktop/mobile no horizontal overflow or script errors');
  } finally { await browser.close(); server.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1;});
