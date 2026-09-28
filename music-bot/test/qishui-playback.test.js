import test from 'node:test';
import assert from 'node:assert/strict';
import { audioKey, mediaVariant, trackRequest, boundedFetch } from '../qishui/playback.js';
import { mediaRange, createQishuiServer } from '../qishui/server.js';
const credentials={cookie:'sessionid=test-placeholder',deviceId:'1234567890123456',installId:'123456789012345'};
const fixture=(seconds=240)=>({track:{id:'7501674235158431760',duration:240000},track_player:{video_model:JSON.stringify({video_duration:seconds,video_list:[{
 main_url:'https://v26-luna.douyinvod.com/test.m4a',video_meta:{codec_type:'aac',quality:'higher',size:1024},encrypt_info:{encrypt:false},
}]})}});
test('unsigned metadata cannot turn a 30-second preview into a playable full track',()=>{
 assert.throws(()=>mediaVariant(fixture(30)),{code:'not_full_track'});
 assert.equal(mediaVariant(fixture()).durationMs,240000);
 const p=fixture();p.track.duration=0;assert.throws(()=>mediaVariant(p));
});
test('media URLs require the official HTTPS audio CDN and valid audio-key material',()=>{
 for(const url of ['http://v26-luna.douyinvod.com/a','https://evil.test/a','https://v26-luna.douyinvod.com.evil.test/a','https://user@v26-luna.douyinvod.com/a','https://v26-luna.douyinvod.com:8443/a']){
  const p=fixture(),m=JSON.parse(p.track_player.video_model);m.video_list[0].main_url=url;p.track_player.video_model=JSON.stringify(m);assert.throws(()=>mediaVariant(p),{code:'media_unavailable'});
 }
 for(const value of ['',null,'abcd','A'.repeat(1000),'secret\nvalue'])assert.throws(()=>audioKey(value),{code:'media_key_invalid'});
});
test('track signing binds exact body and own credentials to the fixed official endpoint',()=>{
 const r=trackRequest('7501674235158431760',credentials);
 assert.equal(new URL(r.url).hostname,'api.qishui.com');assert.equal(JSON.parse(r.body).track_id,'7501674235158431760');
 assert.equal(r.headers.cookie,credentials.cookie);assert.match(r.headers['x-ss-stub'],/^[A-F0-9]{32}$/);
 assert.throws(()=>trackRequest('x',credentials));assert.throws(()=>trackRequest('1',{...credentials,cookie:'secret\r\nvalue'}));
});
test('upstream downloads are bounded and never follow redirects',async()=>{
 await assert.rejects(boundedFetch('https://example.test',{},2,async()=>new Response('abc')),{code:'response_limit'});
 await assert.rejects(boundedFetch('https://example.test',{},100,async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}})),{code:'upstream_unavailable'});
 await boundedFetch('https://example.test',{},100,async(_,opts)=>{assert.equal(opts.redirect,'error');return new Response('ok')});
});
test('media ranges handle FFmpeg seeking and reject malformed multi-range requests',()=>{
 assert.deepEqual(mediaRange('bytes=50-',100),{start:50,end:99,partial:true});
 assert.deepEqual(mediaRange('bytes=-25',100),{start:75,end:99,partial:true});
 for(const r of ['bytes=100-','bytes=10-9','bytes=0-1,3-4','bytes=-0','garbage'])assert.equal(mediaRange(r,100),null);
});
test('bridge requires bearer auth and strips private errors',async t=>{
 const token='a'.repeat(40),server=createQishuiServer({token,publicUrl:'https://api.example.test/_qishui',credentialsFile:'/missing',cacheDir:'/unused',
  catalog:{search:async()=>{throw Error('secret_cookie')},close(){}},playback:{}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.closeBridge());
 const base='http://127.0.0.1:'+server.address().port+'/_qishui';
 assert.equal((await fetch(base+'/health')).status,401);
 const response=await fetch(base+'/search?q=x',{headers:{Authorization:'Bearer '+token}});
 assert.equal(response.status,502);assert.ok(!(await response.text()).includes('secret_cookie'));
 assert.equal((await fetch(base+'/health',{headers:{Authorization:'Bearer '+token}})).status,200);
});
