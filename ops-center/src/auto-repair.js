import { randomUUID } from 'node:crypto';

export const REPAIR_POLICY = Object.freeze({ failureThreshold: 2, recoveryThreshold: 2, cooldownMs: 15 * 60000, maxAttemptsPerHour: 2 });
const VERIFY_MS = 5 * 60000;
const at = value => new Date(value).toISOString();
const recent = (time, now, ttl) => typeof time === 'string' && Number.isFinite(Date.parse(time)) && now - Date.parse(time) >= 0 && now - Date.parse(time) <= ttl;
const phases = new Set(['idle','queued','restarting','verifying','recovered','failed','blocked','unknown','maintenance']);

export function repairState(draft) {
  if (draft.autoRepair === undefined) draft.autoRepair = { states: {}, events: [] };
  const value = draft.autoRepair;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.states || typeof value.states !== 'object'
    || Array.isArray(value.states) || Object.keys(value.states).length > 600 || !Array.isArray(value.events) || value.events.length > 300)
    throw Error('invalid_repair_state');
  value.monitorChecks ||= {};
  if(typeof value.monitorChecks!=='object'||Array.isArray(value.monitorChecks)||Object.keys(value.monitorChecks).length>40)throw Error('invalid_repair_monitor_state');
  return value;
}

export function observeRepairMonitor(draft, monitor, result, config){
  if(!monitor.repairTarget)return;
  const checks=repairState(draft).monitorChecks;
  const counter=checks[monitor.id] ||= {fail:0,checkedAt:null};
  if(draft.maintenance['monitor:'+monitor.id]||draft.maintenance['host:'+monitor.repairTarget.hostId]){counter.fail=0;counter.checkedAt=result.checkedAt;return}
  const elapsed=Date.parse(result.checkedAt)-Date.parse(counter.checkedAt);
  if(counter.checkedAt&&elapsed<20000)return;
  if(counter.checkedAt&&elapsed>config.monitorStaleMs)counter.fail=0;
  counter.checkedAt=result.checkedAt;
  counter.fail=result.ok===false&&(result.httpStatus===null||result.httpStatus>=500||result.httpStatus===200)?Math.min(counter.fail+1,100):0;
}

function event(state, data, phase, message, now) {
  const title = { queued:'开始自动修复', recovered:'自动修复成功', failed:'自动修复未恢复', unknown:'自动修复结果待确认', blocked:'自动修复已暂停', verifying:'检测到自动重启', maintenance:'自动修复已暂停' }[phase];
  if (!title) return;
  data.events.unshift({ id:randomUUID(), hostId:state.hostId, serviceId:state.serviceId, phase, category:state.category,
    title, message, at:at(now), notification:'pending' });
  data.events=data.events.slice(0,300);
}
function phase(state,data,value,message,now) {
  if(state.phase===value&&state.message===message)return;
  state.phase=value;state.message=message;
  event(state,data,value,message,now);
}

/** Server-side policy is authoritative; reports cannot nominate another unit or repair action. */
export function repairSignals(host, report, draft, config, now) {
  return host.services.map(service => {
    const status=report.services.find(item=>item.id===service.id);
    const bindings=(host.repairBindings||[]).filter(item=>item.serviceId===service.id);
    const bots=report.bots.filter(bot=>bot.serviceId===service.id && bindings.some(binding=>bot.id===binding.probeId||bot.id.startsWith(binding.probeId+':')));
    const associated=config.monitors.filter(m=>m.repairTarget?.hostId===host.id&&m.repairTarget.serviceId===service.id);
    const monitorRows=associated.map(m=>({config:m,value:draft.monitors[m.id],maintenance:draft.maintenance['monitor:'+m.id]}));
    const monitorBad=monitorRows.find(({config:m,value,maintenance})=>!maintenance&&recent(value?.checkedAt,now,config.monitorStaleMs)
      && value.ok===false && (value.httpStatus===null||value.httpStatus>=500||value.httpStatus===200) && (draft.autoRepair?.monitorChecks?.[m.id]?.fail||0)>0);
    const botBad=bots.find(bot=>bot.repairReason==='gateway_offline'&&bot.state==='offline'||bot.repairReason==='health_probe_failed'&&bot.state==='unknown');
    const processBad=status&&['failed','inactive'].includes(status.activeState);
    const maintenance=draft.maintenance['host:'+host.id]===true || monitorRows.some(row=>row.maintenance===true);
    const healthy=status?.ok===true && bindings.every(binding=>bots.some(bot=>bot.id===binding.probeId||bot.id.startsWith(binding.probeId+':')))
      && bots.every(bot=>['online','stopped'].includes(bot.state)&&bot.health==='healthy'&&!bot.repairReason)
      && monitorRows.every(({value,maintenance})=>maintenance||recent(value?.checkedAt,now,config.monitorStaleMs)&&value.ok===true);
    return { service,status,maintenance,healthy,problem:processBad?'服务进程未运行':botBad?.repairReason==='gateway_offline'?'机器人网关持续离线':botBad?'本机健康连接持续失败':monitorBad?'本机健康接口持续异常':null,
      monitorFailureCount:!processBad&&!botBad&&monitorBad?draft.autoRepair.monitorChecks[monitorBad.config.id].fail:null,
      category:monitorBad?'web':'infra' };
  });
}

export function observeRepairs(draft, host, report, previous, config, now) {
  const data=repairState(draft);
  for(const signal of repairSignals(host,report,draft,config,now)) {
    const {service,status,maintenance}=signal,key=host.id+':'+service.id;
    if(service.expected!=='running')continue;
    const oldStatus=previous?.services.find(item=>item.id===service.id);
    const systemRestart=Number.isSafeInteger(status?.restarts)&&Number.isSafeInteger(oldStatus?.restarts)&&status.restarts>oldStatus.restarts;
    if(!service.autoRepair&&!data.states[key]&&!systemRestart)continue;
    const state=data.states[key] ||= {hostId:host.id,serviceId:service.id,phase:'idle',category:'infra',reason:'',message:'监控中',
      failures:0,successes:0,attempts:[],lastObservationAt:null,lastAttemptAt:null,lastRecoveredAt:null,commandId:null};
    if(!phases.has(state.phase)||!Array.isArray(state.attempts))throw Error('invalid_repair_state');
    state.attempts=state.attempts.filter(time=>Number.isFinite(time)&&time>now-3600_000);
    if(maintenance) {
      state.failures=0;state.successes=0;state.lastObservationAt=report.observedAt;
      if(state.commandId){const command=draft.commands.find(c=>c.id===state.commandId);if(command?.status==='pending'){command.status='failed';command.message='维护模式已取消自动重启。';state.commandId=null}}
      state.phase='maintenance';state.message='维护模式中，不执行自动修复';continue;
    }
    if(state.phase==='maintenance'){state.phase='idle';state.message='维护结束，重新观察';state.failures=0;state.successes=0}
    // Two reports sent too close together or replayed reports must not manufacture confidence.
    if(state.lastObservationAt&&Date.parse(report.observedAt)-Date.parse(state.lastObservationAt)<20000)continue;
    if(state.lastObservationAt&&Date.parse(report.observedAt)-Date.parse(state.lastObservationAt)>config.hostStaleMs){state.failures=0;state.successes=0}
    state.lastObservationAt=report.observedAt;
    state.failures=signal.problem?(signal.monitorFailureCount??state.failures+1):0;
    state.successes=signal.healthy?state.successes+1:0;
    const command=draft.commands.find(item=>item.id===state.commandId);
    if(systemRestart&&!command&&!['queued','restarting','verifying','unknown'].includes(state.phase)) {
      state.category='infra';state.reason='systemd 自动重启';state.lastAttemptAt=at(now);state.verifyAt=at(now);state.successes=0;
      phase(state,data,'verifying',`${host.name} / ${service.name}：systemd 已自动重启，等待健康复查。`,now);
    }
    if(command) {
      if(command.status==='dispatched'){state.phase='restarting';state.message='重启命令已派发，等待执行回执'}
      else if(command.status==='pending'){state.phase='queued';state.message='等待采集器领取重启命令'}
      else if(command.status==='unknown')phase(state,data,'unknown',`${host.name} / ${service.name}：重启回执未确认，停止自动重试并等待人工核对。`,now);
      else if(command.status==='succeeded'&&state.phase!=='verifying'){
        state.phase='verifying';state.message='重启命令已完成，等待连续两次正常';state.verifyAt=at(now);state.successes=signal.healthy?1:0;
      }else if(command.status==='failed'&&!['failed','blocked'].includes(state.phase)){
        state.commandId=null;phase(state,data,'failed',`${host.name} / ${service.name}：重启执行失败；冷却后重新评估。`,now);
      }
    }
    if(['verifying','unknown','failed','blocked'].includes(state.phase)&&state.lastAttemptAt&&state.successes>=REPAIR_POLICY.recoveryThreshold) {
      if(command?.status==='unknown')command.recoveryVerifiedAt=at(now);
      state.commandId=null;state.lastRecoveredAt=at(now);state.failures=0;
      phase(state,data,'recovered',`${host.name} / ${service.name}：连续两次新采样正常，已确认恢复。`,now);continue;
    }
    if(state.phase==='verifying'&&recent(state.verifyAt,now,VERIFY_MS)===false) {
      state.commandId=null;phase(state,data,'failed',`${host.name} / ${service.name}：重启后五分钟内未恢复正常；请检查账号、网络或服务日志。`,now);
    }
    if(['queued','restarting','verifying','unknown'].includes(state.phase))continue;
    if(!service.autoRepair||!service.restartAllowed||!signal.problem||state.failures<REPAIR_POLICY.failureThreshold)continue;
    state.reason=signal.problem;state.category=signal.category;
    if(state.attempts.length>=REPAIR_POLICY.maxAttemptsPerHour){phase(state,data,'blocked',`${host.name} / ${service.name}：一小时已尝试两次，暂不继续重启，请人工检查。`,now);continue}
    if(state.lastAttemptAt&&now-Date.parse(state.lastAttemptAt)<REPAIR_POLICY.cooldownMs){state.message='处于15分钟冷却期，继续监控';continue}
    // Any in-flight/uncertain command blocks more automation on that host.
    if(draft.commands.some(item=>item.hostId===host.id&&(['pending','dispatched'].includes(item.status)||item.status==='unknown'&&!(item.origin==='auto'&&item.recoveryVerifiedAt)||now-Date.parse(item.createdAt)<60000))){state.message='其他操作仍在执行或待确认，暂不重复重启';continue}
    const id=randomUUID();state.commandId=id;state.lastAttemptAt=at(now);state.attempts.push(now);state.successes=0;state.verifyAt=null;
    draft.commands.unshift({id,requestId:randomUUID(),hostId:host.id,serviceId:service.id,action:'restart',origin:'auto',reason:signal.problem,
      status:'pending',createdAt:at(now),expiresAt:at(now+90000),message:'持续异常达到阈值，等待自动重启。'});
    draft.commands=draft.commands.slice(0,300);
    draft.audit.unshift({at:at(now),action:'auto_restart_requested',target:`${host.name} / ${service.name}`});draft.audit=draft.audit.slice(0,300);
    phase(state,data,'queued',`${host.name} / ${service.name}：连续${REPAIR_POLICY.failureThreshold}次检测到${signal.problem}，已触发自动重启（本小时第 ${state.attempts.length}/2 次）。`,now);
  }
}

export function repairSnapshot(data,config,now) {
  const value=data.autoRepair||{states:{},events:[]};
  return {enabled:config.hosts.some(host=>host.services.some(service=>service.autoRepair)),policy:REPAIR_POLICY,
    states:Object.values(value.states).map(state=>({hostId:state.hostId,serviceId:state.serviceId,phase:state.phase,category:state.category,
      reason:state.reason,message:state.message,lastAttemptAt:state.lastAttemptAt,lastRecoveredAt:state.lastRecoveredAt,
      attemptsInHour:state.attempts.filter(time=>time>now-3600_000).length,
      nextAttemptAt:state.lastAttemptAt?at(Math.max(Date.parse(state.lastAttemptAt)+REPAIR_POLICY.cooldownMs,state.attempts.length>=2?state.attempts.at(-2)+3600_000:0)):null})),
    events:value.events.slice(0,100)};
}
