import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpsEngine } from '../src/engine.js';
import { StateStore } from '../src/storage.js';
import { validateConfig } from '../src/config.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const SERVICE = { id:'ai', name:'AI', unit:'kook-ai-bot.service', expected:'running', restartAllowed:true, autoRepair:true };
const STOPPED = { id:'duet', name:'已停用讨论', unit:'kook-ai-duet.service', expected:'stopped', restartAllowed:false };
const MONITOR = { id:'health', name:'本机健康', url:'http://127.0.0.1:19000/health', repairTarget:{ hostId:'linux', serviceId:'ai' } };
function fixture({send, probe, writeState, services=[SERVICE,STOPPED], bindings=[], monitors=[]}={}) {
  let now=NOW;
  const raw={localHostId:'linux',hosts:[{id:'linux',name:'Linux',token:'a'.repeat(48),services,repairBindings:bindings}],monitors};
  const config=validateConfig(raw,{});
  const store=new StateStore({dataDir:'unused',writeState:writeState|| (async()=>{}),timeoutMs:50});
  const engine=new OpsEngine({config,store,send,now:()=>now,probe:probe|| (async()=>({ok:true,httpStatus:200,latencyMs:1,tlsDays:null}))});
  const report=(extra={})=>({hostId:'linux',observedAt:new Date(now).toISOString(),metrics:{cpuPercent:1,memoryPercent:20,diskPercent:30},
    services:[{id:'ai',activeState:'active',subState:'running',pid:42,restarts:0},{id:'duet',activeState:'inactive',subState:'dead',pid:0,restarts:0}],bots:[],commandResults:[],...extra});
  const bad=(extra={})=>report({services:[{id:'ai',activeState:'failed',subState:'failed',pid:0,restarts:0},{id:'duet',activeState:'inactive',subState:'dead',pid:0,restarts:0}],...extra});
  const ingest=value=>engine.ingest(config.hosts[0],value||report());
  return {config,raw,store,engine,report,bad,ingest,advance:ms=>{now+=ms;},get now(){return now;}};
}
async function samples(f, count=3, make=()=>f.bad()) {
  let result;for(let index=0;index<count;index++){result=await f.ingest(make());f.advance(30000);}return result;
}
const state=f=>f.store.data.autoRepair?.states['linux:ai'];
const bot=(extra={})=>({id:'gateway:1',name:'AI',kind:'ai',state:'offline',health:'degraded',serviceId:'ai',repairReason:'gateway_offline',...extra});

test('three distinct spaced failures issue one durable restart with the strict agent wire shape',async()=>{
  const saved=[],f=fixture({writeState:async value=>saved.push(structuredClone(value))});
  assert.deepEqual((await samples(f,2)).commands,[]);
  const response=await samples(f,1);
  assert.equal(response.commands.length,1);
  assert.deepEqual(Object.keys(response.commands[0]).sort(),['action','expiresAt','id','serviceId']);
  assert.equal(response.commands[0].serviceId,'ai');
  assert.equal(saved.at(-1).commands[0].status,'dispatched');
  assert.equal(saved.at(-1).commands[0].origin,'auto');
  assert.equal(saved.at(-1).audit[0].action,'auto_restart_requested');
  assert.deepEqual((await samples(f,1)).commands,[]);
  assert.equal(f.store.data.commands.length,1);
});

test('replays and reports less than twenty seconds apart cannot manufacture the failure threshold',async()=>{
  const f=fixture(),original=f.bad();await f.ingest(original);
  f.advance(1000);await f.ingest(original);
  f.advance(1000);await f.ingest(f.bad());
  f.advance(1000);await f.ingest(f.bad());
  assert.equal(state(f).failures,1);assert.equal(f.store.data.commands.length,0);
  f.advance(30000);await f.ingest(f.bad());assert.equal(state(f).failures,2);
  f.advance(30000);assert.equal((await f.ingest(f.bad())).commands.length,1);
});

test('unknown status, stale reports, resource pressure, and planned stops do not restart services',async()=>{
  for(const extra of [
    {services:[]},
    {services:[{id:'ai',activeState:'activating',subState:'start',pid:0}]},
    {metrics:{cpuPercent:99,memoryPercent:99,diskPercent:99}},
  ]){
    const f=fixture();await samples(f,4,()=>f.report(extra));assert.equal(f.store.data.commands.length,0);
  }
  const f=fixture();await samples(f,4,()=>f.report());assert.equal(f.store.data.commands.length,0);
  assert.equal(f.store.data.autoRepair.states['linux:duet'],undefined);
  await assert.rejects(f.ingest(f.bad({observedAt:new Date(NOW-600000).toISOString()})),/过期/);
  assert.throws(()=>fixture({services:[{...STOPPED,autoRepair:true}]}),/Automatic repair/);
  assert.throws(()=>fixture({services:[{...SERVICE,restartAllowed:false}]}),/Automatic repair/);
  const disabled=fixture({services:[{...SERVICE,autoRepair:false}]});await samples(disabled,4);assert.equal(disabled.store.data.commands.length,0);
});

test('a stale collection gap breaks consecutiveness instead of restarting immediately after reconnection',async()=>{
  const f=fixture();await samples(f,2);f.advance(120001);
  assert.deepEqual((await f.ingest(f.bad())).commands,[]);assert.equal(state(f).failures,1);
  f.advance(30000);await f.ingest(f.bad());f.advance(30000);
  assert.equal((await f.ingest(f.bad())).commands.length,1);
});

test('healthy observations resolve an uncertain repair without claiming its command receipt arrived',async()=>{
  const f=fixture();const first=(await samples(f)).commands[0];
  await f.ingest(f.report({commandResults:[{id:first.id,status:'unknown'}]}));f.advance(30000);await f.ingest(f.report());
  assert.equal(state(f).phase,'recovered');assert.equal(f.store.data.commands[0].status,'unknown');
  assert.ok(f.store.data.commands[0].recoveryVerifiedAt);
  f.advance(900000);await samples(f,2);assert.equal((await samples(f,1)).commands.length,1);
});

test('maintenance clears evidence and prevents repair, then requires three fresh failures again',async()=>{
  const f=fixture();await samples(f,2);
  await f.engine.maintenance({kind:'host',id:'linux',enabled:true});await samples(f,4);
  assert.equal(f.store.data.commands.length,0);assert.equal(state(f).phase,'maintenance');
  await f.engine.maintenance({kind:'host',id:'linux',enabled:false});await samples(f,2);
  assert.equal(f.store.data.commands.length,0);assert.equal((await samples(f,1)).commands.length,1);
});

test('only the independently configured probe-to-service mapping can nominate a gateway restart',async()=>{
  for(const entry of [bot({serviceId:'duet'}),bot({id:'gateway-other:1'}),bot({id:'other:1'}),
    bot({repairReason:'exec'}),bot({state:'online'}),bot({state:'stopped'}),bot({serviceId:undefined})]){
    const f=fixture({bindings:[{probeId:'gateway',serviceId:'ai'}]});await samples(f,4,()=>f.report({bots:[entry]}));
    assert.equal(f.store.data.commands.length,0,JSON.stringify(entry));
  }
  const unbound=fixture();await samples(unbound,4,()=>unbound.report({bots:[bot()]}));assert.equal(unbound.store.data.commands.length,0);
  for(const entry of [bot(),bot({id:'gateway'}),bot({state:'unknown',repairReason:'health_probe_failed'})]){
    const f=fixture({bindings:[{probeId:'gateway',serviceId:'ai'}]});assert.equal((await samples(f,3,()=>f.report({bots:[entry]}))).commands.length,1);
  }
});

test('recovery requires the restart acknowledgement and two later healthy observations',async()=>{
  const f=fixture(),started=await samples(f),id=started.commands[0].id;
  await f.ingest(f.report());f.advance(30000);await f.ingest(f.report());f.advance(30000);
  assert.notEqual(state(f).phase,'recovered');
  await f.ingest(f.report({commandResults:[{id,status:'succeeded'}]}));
  assert.equal(state(f).phase,'verifying');
  f.advance(30000);await f.ingest();assert.equal(state(f).phase,'recovered');
  const events=f.store.data.autoRepair.events.filter(event=>event.phase==='recovered');assert.equal(events.length,1);
  f.advance(30000);await f.ingest();assert.equal(f.store.data.autoRepair.events.filter(event=>event.phase==='recovered').length,1);
});

test('a restart acknowledgement alone does not mean a disconnected or missing bot recovered',async()=>{
  const f=fixture({bindings:[{probeId:'gateway',serviceId:'ai'}]}),result=await samples(f,3,()=>f.report({bots:[bot()]})),id=result.commands[0].id;
  await f.ingest(f.report({bots:[bot()],commandResults:[{id,status:'succeeded'}]}));f.advance(30000);
  await samples(f,2,()=>f.report());assert.notEqual(state(f).phase,'recovered');
  await samples(f,2,()=>f.report({bots:[bot({state:'online',health:'healthy',repairReason:null})]}));assert.equal(state(f).phase,'recovered');
});

test('intentionally stopped music tenants do not prevent the shared service from confirming recovery',async()=>{
  const f=fixture({bindings:[{probeId:'gateway',serviceId:'ai'}]}),result=await samples(f,3,()=>f.report({bots:[bot()]})),id=result.commands[0].id;
  const bots=[bot({state:'online',health:'healthy',repairReason:null}),bot({id:'gateway:disabled',kind:'music',state:'stopped',health:'healthy',repairReason:null})];
  await f.ingest(f.report({bots,commandResults:[{id,status:'succeeded'}]}));f.advance(30000);
  await f.ingest(f.report({bots}));assert.equal(state(f).phase,'recovered');
});

test('failed restarts wait fifteen minutes, allow only two attempts in an hour, and re-evaluate after expiry',async()=>{
  const f=fixture(),first=await samples(f),firstId=first.commands[0].id,firstAt=Date.parse(f.store.data.commands[0].createdAt);
  await f.ingest(f.bad({commandResults:[{id:firstId,status:'failed'}]}));f.advance(30000);
  await samples(f,3);assert.equal(f.store.data.commands.length,1);
  f.advance(firstAt+15*60000-f.now);await samples(f,2);assert.equal(f.store.data.commands.length,1);
  const second=await samples(f,1),secondId=second.commands[0].id;assert.equal(f.store.data.commands.length,2);
  await f.ingest(f.bad({commandResults:[{id:secondId,status:'failed'}]}));f.advance(30000);
  f.advance(15*60000);await samples(f,3);assert.equal(f.store.data.commands.length,2);assert.equal(state(f).phase,'blocked');
  f.advance(firstAt+3600001-f.now);await samples(f,3);assert.equal(f.store.data.commands.length,3);
});

test('an uncertain acknowledgement is never blindly repeated even after the cooldown and hourly window',async()=>{
  const f=fixture(),response=await samples(f),id=response.commands[0].id;
  await f.ingest(f.bad({commandResults:[{id,status:'unknown'}]}));f.advance(3600001);await samples(f,4);
  assert.equal(f.store.data.commands.length,1);assert.equal(state(f).phase,'unknown');
});

test('a command with no acknowledgement becomes uncertain and stays single delivery',async()=>{
  const f=fixture();await samples(f);f.advance(130000);await samples(f,3);
  assert.equal(f.store.data.commands.length,1);assert.equal(f.store.data.commands[0].status,'unknown');assert.equal(state(f).phase,'unknown');
});

test('five minutes of unhealthy post-restart samples reports failure instead of claiming recovery',async()=>{
  const f=fixture(),response=await samples(f),id=response.commands[0].id;
  await f.ingest(f.bad({commandResults:[{id,status:'succeeded'}]}));f.advance(30000);
  assert.equal(state(f).phase,'verifying');
  await samples(f,10);assert.equal(state(f).phase,'verifying');
  await samples(f,1);assert.equal(state(f).phase,'failed');assert.equal(f.store.data.commands.length,1);
  assert.match(f.store.data.autoRepair.events[0].message,/五分钟/);
});

test('manual and automatic restarts share the host in-flight lock',async()=>{
  const f=fixture();await samples(f,2);
  const manual=await f.engine.command({hostId:'linux',serviceId:'ai',action:'restart',requestId:randomUUID()});
  const result=await f.ingest(f.bad());assert.deepEqual(result.commands.map(command=>command.id),[manual.id]);assert.equal(f.store.data.commands.length,1);
  const g=fixture();await samples(g);
  await assert.rejects(g.engine.command({hostId:'linux',serviceId:'ai',action:'restart',requestId:randomUUID()}),/稍后/);
});

test('systemd restart-counter increases are broadcast and verified without issuing another restart',async()=>{
  const f=fixture();await f.ingest();f.advance(30000);
  const healthy=()=>f.report({services:[{id:'ai',activeState:'active',subState:'running',pid:66,restarts:1},{id:'duet',activeState:'inactive',subState:'dead',pid:0,restarts:0}]});
  await f.ingest(healthy());assert.equal(state(f).phase,'verifying');assert.equal(f.store.data.commands.length,0);
  assert.equal(f.store.data.autoRepair.events[0].title,'检测到自动重启');f.advance(30000);
  await f.ingest(healthy());assert.equal(state(f).phase,'verifying');f.advance(30000);
  await f.ingest(healthy());assert.equal(state(f).phase,'recovered');assert.equal(f.store.data.commands.length,0);
});

test('only mapped local persistent HTTP 500 faults can request a monitor repair; TLS and client errors cannot',async()=>{
  assert.throws(()=>fixture({monitors:[{...MONITOR,url:'https://external.example/health'}]}),/local/);
  assert.throws(()=>fixture({monitors:[{...MONITOR,repairTarget:{hostId:'linux',serviceId:'duet'}}]}),/repair target/);
  for(const result of [{ok:false,httpStatus:401},{ok:false,httpStatus:403},{ok:false,httpStatus:404},{ok:true,httpStatus:200,tlsDays:1}]){
    const f=fixture({monitors:[MONITOR],probe:async()=>result});
    for(let count=0;count<5;count++){await f.engine.tick();await f.ingest();f.advance(30000);}
    assert.equal(f.store.data.commands.length,0,JSON.stringify(result));
  }
  const f=fixture({monitors:[MONITOR],probe:async()=>({ok:false,httpStatus:500})});
  for(let count=0;count<5;count++){await f.engine.tick();await f.ingest();f.advance(30000);}
  assert.equal(f.store.data.commands.length,1);assert.equal(state(f).category,'web');
  const unmapped=fixture({monitors:[{id:'site',name:'site',url:'https://external.example/'}],probe:async()=>({ok:false,httpStatus:500})});
  for(let count=0;count<5;count++){await unmapped.engine.tick();await unmapped.ingest();unmapped.advance(30000);}
  assert.equal(unmapped.store.data.commands.length,0);
});

test('a local monitor cannot accidentally restart a service on a different host',()=>{
  const raw=fixture().raw;
  raw.hosts.push({...raw.hosts[0],id:'music-cn',token:'b'.repeat(48)});
  assert.throws(()=>validateConfig({...raw,monitors:[{...MONITOR,repairTarget:{hostId:'music-cn',serviceId:'ai'}}]},{}),/local host/);
  assert.throws(()=>validateConfig({...raw,localHostId:undefined,monitors:[MONITOR]},{}),/local host/);
});

test('monitor maintenance prevents the corresponding service auto-restart even when its process fails',async()=>{
  const f=fixture({monitors:[MONITOR]});await f.engine.maintenance({kind:'monitor',id:'health',enabled:true});await samples(f,4);
  assert.equal(f.store.data.commands.length,0);assert.equal(state(f).phase,'maintenance');
});

test('repair notifications are durably claimed and uncertain sends are not retried',async()=>{
  const f=fixture();await samples(f);const attempts=[];
  f.engine.send=async message=>{attempts.push(message);if(message.title==='开始自动修复'){
    assert.equal(f.store.data.autoRepair.events[0].notification,'sending');throw Error('ambiguous timeout');
  }};
  await f.engine.flushNotifications();await f.engine.flushNotifications();
  assert.equal(attempts.filter(message=>message.title==='开始自动修复').length,1);
  assert.equal(f.store.data.autoRepair.events[0].notification,'uncertain');
});

test('delayed repair notifications cannot announce an obsolete start after recovery',async()=>{
  const f=fixture(),response=await samples(f),id=response.commands[0].id;
  await f.ingest(f.report({commandResults:[{id,status:'succeeded'}]}));f.advance(30000);await f.ingest();
  const messages=[];f.engine.send=async message=>messages.push(message);
  await f.engine.flushNotifications();
  const repairTitles=messages.map(message=>message.title).filter(title=>['开始自动修复','自动修复成功'].includes(title));
  assert.ok(repairTitles.includes('自动修复成功'));
  assert.ok(repairTitles.indexOf('开始自动修复')<repairTitles.indexOf('自动修复成功'));
  assert.equal(repairTitles.filter(title=>title==='自动修复成功').length,1);
});

test('failed durable command admission never returns or sends an unpersisted restart',async()=>{
  const f=fixture();await samples(f,2);f.store.writeState=async()=>{throw Error('disk failed');};
  await assert.rejects(f.ingest(f.bad()),/保存失败/);assert.equal(f.store.data.commands.length,0);assert.equal(f.store.failed,true);
  await assert.rejects(f.ingest(f.bad()),/不可用/);
});

test('failed notification claim stops sending and retains the unsent event',async()=>{
  const f=fixture();await samples(f);let sent=0;f.engine.send=async()=>{sent++;};
  f.store.writeState=async()=>{throw Error('disk failed');};await f.engine.flushNotifications();
  assert.equal(sent,0);assert.equal(f.store.data.autoRepair.events[0].notification,'pending');assert.equal(f.store.failed,true);
});

test('a process restart recovers in-flight notification claims as uncertain without duplicate delivery',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'ops-repair-test-'));
  try{
    const f=fixture();await samples(f);f.store.data.autoRepair.events[0].notification='sending';
    f.store.data.incidents=[];
    await writeFile(path.join(directory,'ops-state.json'),JSON.stringify(f.store.data));
    const store=await new StateStore({dataDir:directory}).init();let sent=0;
    const engine=new OpsEngine({config:f.config,store,now:()=>f.now,send:async()=>{sent++;}});
    await engine.flushNotifications();assert.equal(sent,0);assert.equal(store.data.autoRepair.events[0].notification,'uncertain');
    await engine.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
