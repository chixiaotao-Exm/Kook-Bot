import { randomUUID } from 'node:crypto';
import { OpsError } from './storage.js';
import { observeRepairs, observeRepairMonitor, repairState, repairSnapshot } from './auto-repair.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, max = 100) => finite(value) && value >= 0 && value <= max ? value : null;
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\b(?:sk-|admin-|ghp_|github_pat_)\S+|Bearer\s+\S+|\b\d{1,5}\/[A-Za-z0-9+/=]+\/[A-Za-z0-9+/=]+/gi, '[隐藏]').slice(0, max) : '';
const iso = now => new Date(now).toISOString();
const fresh = (value, now, ttl) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && now - Date.parse(value) <= ttl && now - Date.parse(value) >= -60000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export class OpsEngine {
  constructor({ config, store, probe, send, now = Date.now }) {
    Object.assign(this, { config, store, probe, send, now }); this.timer = null; this.running = false; this.polling = null; this.sending = null;
    this.notificationError = null; this.queryBotStatus = () => ({ connected: false }); this.startedAt = now();
  }
  hostFresh(value, now = this.now()) { return value && fresh(value.lastSeenAt, now, this.config.hostStaleMs) && fresh(value.observedAt, now, this.config.hostStaleMs); }
  hostProblem(value) {
    if (value.services.some(service => !service.ok)) return '服务状态不符合运行计划';
    if (value.bots.some(bot => bot.state === 'offline' || bot.state === 'unknown' || ['degraded', 'unknown'].includes(bot.health))) return '机器人连接或业务状态异常，或状态未知';
    if (value.metrics.diskPercent >= 90) return '磁盘使用率达到 90%';
    if (value.metrics.memoryPercent >= 90) return '内存使用率达到 90%';
    if (value.metrics.cpuPercent >= 90) return 'CPU 使用率达到 90%';
    return null;
  }
  observe(draft, targetId, category, name, problem, at) {
    if (draft.maintenance[targetId]) { draft.streaks[targetId] = { fail: 0, pass: 0 }; return; }
    const counter = draft.streaks[targetId] ||= { fail: 0, pass: 0 };
    if (problem) { counter.fail++; counter.pass = 0; } else { counter.pass++; counter.fail = 0; }
    const open = draft.incidents.find(item => item.targetId === targetId && item.state === 'open');
    if (problem && counter.fail >= 3 && !open) {
      draft.incidents.unshift({ id: randomUUID(), targetId, category, title: `${name} · ${problem}`, state: 'open', openedAt: at, resolvedAt: null, notified: 'pending', recoveryNotified: null });
    } else if (!problem && counter.pass >= 2 && open) {
      open.state = 'resolved'; open.resolvedAt = at;
      if (open.notified === 'pending') { open.notified = 'suppressed'; open.recoveryNotified = 'suppressed'; }
      else open.recoveryNotified = 'pending';
    }
    draft.incidents = [...draft.incidents.filter(item => item.state === 'open'), ...draft.incidents.filter(item => item.state !== 'open').slice(0, 300)];
  }
  normalizeReport(host, raw) {
    const now = this.now();
    if (!raw || raw.hostId !== host.id || !fresh(raw.observedAt, now, 120000) || !raw.metrics || !Array.isArray(raw.services) || raw.services.length > 30
      || !Array.isArray(raw.bots) || raw.bots.length > 40 || !Array.isArray(raw.commandResults) || raw.commandResults.length > 30) throw new OpsError('采集报告格式无效或已过期。');
    const services = host.services.map(config => {
      const reported = raw.services.find(item => item?.id === config.id) || {};
      const activeState = ['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(reported.activeState) ? reported.activeState : 'unknown';
      return { ...config, activeState, subState: text(reported.subState, 30), pid: number(reported.pid, 1e9), restarts: number(reported.restarts, 1e9),
        ok: config.expected === 'stopped' ? activeState === 'inactive'
          : activeState === 'active' && reported.subState === 'running' && number(reported.pid, 1e9) > 0 };
    });
    const seen = new Set();
    const bots = raw.bots.filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(item.id) && !seen.has(item.id) && seen.add(item.id))
      .map(item => {
        const state = ['online', 'offline', 'stopped', 'unknown'].includes(item.state) ? item.state : 'unknown';
        const lastError = state === 'stopped' && item.kind === 'music' ? '' : text(item.lastError, 180), transport = state !== 'stopped' && ['connected', 'disconnected'].includes(item.transport) ? item.transport : null;
        const health = state === 'unknown' ? 'unknown' : state === 'stopped' ? 'healthy' : state === 'offline' ? 'degraded'
          : item.kind === 'music' && (lastError || item.playing === true && transport === 'disconnected') ? 'degraded'
            : ['healthy', 'degraded', 'unknown'].includes(item.health) ? item.health : 'healthy';
        const binding=(host.repairBindings||[]).find(entry=>item.id===entry.probeId||item.id.startsWith(entry.probeId+':'));
        const repairReason=binding&&item.serviceId===binding.serviceId&&(
          item.repairReason==='gateway_offline'&&state==='offline'||item.repairReason==='health_probe_failed'&&state==='unknown')?item.repairReason:null;
        const runtimeKnown = ['online','offline'].includes(state) && health !== 'unknown';
        const uptime = runtimeKnown ? number(item.uptimeSeconds, 1e12) : null;
        const started = typeof item.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(item.startedAt) ? Date.parse(item.startedAt) : NaN;
        return { id: item.id, name: text(item.name) || item.id, kind: text(item.kind, 30), state, health, transport,
          ...(item.kind === 'music' ? { uptimeSeconds: uptime === null ? null : Math.floor(uptime),
            startedAt: runtimeKnown && Number.isFinite(started) && started >= 0 && started <= now + 60000 ? iso(started) : null } : {}),
          ...(binding&&item.serviceId===binding.serviceId?{serviceId:binding.serviceId,repairReason}:{}),
          channelName: text(item.channelName), playing: item.playing === true && state === 'online' && health === 'healthy', lastError };
      });
    return { observedAt: raw.observedAt, lastSeenAt: iso(now), services, bots, metrics: {
      cpuPercent: number(raw.metrics.cpuPercent), memoryPercent: number(raw.metrics.memoryPercent), diskPercent: number(raw.metrics.diskPercent),
      load1: number(raw.metrics.load1, 100000), uptimeSeconds: number(raw.metrics.uptimeSeconds, 1e12) } };
  }
  async ingest(host, raw) {
    const report = this.normalizeReport(host, raw), now = this.now();
    const result = await this.store.transaction(draft => {
      const previous = draft.hosts[host.id];
      if (previous && Date.parse(previous.observedAt) > Date.parse(report.observedAt)) throw new OpsError('旧报告不能覆盖新报告。', 409);
      if (!previous || Date.parse(previous.observedAt) < Date.parse(report.observedAt)) {
        const history = previous?.history || [];
        if (!history.length || now - Date.parse(history.at(-1).at) >= 60000) history.push({ at: iso(now), ...report.metrics });
        draft.hosts[host.id] = { ...report, history: history.filter(item => now - Date.parse(item.at) <= 86400000).slice(-1440) };
        this.observe(draft, `host:${host.id}`, 'infra', host.name, this.hostProblem(report), iso(now));
      }
      for (const completed of raw.commandResults) {
        const command = draft.commands.find(item => item.id === completed?.id && item.hostId === host.id);
        if (!command || !['dispatched', 'unknown'].includes(command.status) || !['succeeded', 'failed', 'unknown'].includes(completed.status)) continue;
        command.status = completed.status; command.finishedAt = iso(now);
        command.message = completed.status === 'succeeded' ? '服务重启命令已完成。' : completed.status === 'failed' ? '服务重启失败，请检查服务器。' : '执行结果待确认，请先核对服务状态。';
      }
      this.expireCommands(draft, now);
      if (!previous || Date.parse(previous.observedAt) < Date.parse(report.observedAt)) observeRepairs(draft,host,report,previous,this.config,now);
      const commands = [];
      for (const command of draft.commands.filter(item => item.hostId === host.id && item.status === 'pending')) {
        const policy = host.services.find(item => item.id === command.serviceId);
        if(command.origin==='auto'&&(!policy?.autoRepair||draft.maintenance['host:'+host.id]||this.config.monitors.some(m=>m.repairTarget?.hostId===host.id&&m.repairTarget.serviceId===command.serviceId&&draft.maintenance['monitor:'+m.id]))) {
          command.status='failed';command.message='自动修复策略或维护状态已暂停执行。';continue;
        }
        if (!policy?.restartAllowed || policy.expected !== 'running') { command.status = 'failed'; command.message = '服务策略已禁止执行。'; continue; }
        command.status = 'dispatched'; command.dispatchedAt = iso(now);
        if(command.origin==='auto'){
          const state=draft.autoRepair?.states[host.id+':'+command.serviceId];
          if(state?.commandId===command.id){state.phase='restarting';state.message='自动重启已派发，等待执行回执'}
        }
        commands.push({ id: command.id, serviceId: command.serviceId, action: 'restart', expiresAt: command.expiresAt });
      }
      return { accepted: true, commands };
    });
    void this.flushNotifications(); return result;
  }
  expireCommands(draft, now) {
    for (const item of draft.commands) {
      if (item.status === 'pending' && Date.parse(item.expiresAt) <= now) { item.status = 'failed'; item.message = '命令未及时领取，已过期。'; }
      if (item.status === 'dispatched' && now - Date.parse(item.dispatchedAt) > 120000) { item.status = 'unknown'; item.message = '未收到执行回执，请核对实际服务状态。'; }
    }
  }
  async command(input, authorize = () => {}) {
    if (!input || input.action !== 'restart' || !uuid(input.requestId)) throw new OpsError('操作请求无效。');
    return this.store.transaction(draft => {
      authorize(); const now = this.now(), host = this.config.hosts.find(item => item.id === input.hostId), service = host?.services.find(item => item.id === input.serviceId);
      if (!service?.restartAllowed || service.expected !== 'running') throw new OpsError('此服务不允许重启。', 403);
      const existing = draft.commands.find(item => item.requestId === input.requestId);
      if (existing) { if (existing.hostId !== input.hostId || existing.serviceId !== input.serviceId) throw new OpsError('操作标识冲突。', 409); return structuredClone(existing); }
      if (!this.hostFresh(draft.hosts[host.id], now)) throw new OpsError('服务器采集已离线，不能执行重启。', 409);
      this.expireCommands(draft, now);
      if (draft.commands.some(item => item.hostId === host.id && (['pending', 'dispatched'].includes(item.status) || now - Date.parse(item.createdAt) < 60000))) throw new OpsError('此服务器刚收到操作，请稍后再试。', 429);
      const command = { id: randomUUID(), requestId: input.requestId, hostId: host.id, serviceId: service.id, action: 'restart', origin:'manual', status: 'pending', createdAt: iso(now), expiresAt: iso(now + 90000), message: '等待服务器领取。' };
      draft.commands.unshift(command); draft.commands = draft.commands.slice(0, 300);
      draft.audit.unshift({ at: iso(now), action: 'restart_requested', target: `${host.name} / ${service.name}` }); draft.audit = draft.audit.slice(0, 300);
      return structuredClone(command);
    });
  }
  async maintenance(input, authorize = () => {}) {
    if (!input || !['host', 'monitor'].includes(input.kind) || typeof input.enabled !== 'boolean') throw new OpsError('维护设置无效。');
    const target = (input.kind === 'host' ? this.config.hosts : this.config.monitors).find(item => item.id === input.id);
    if (!target) throw new OpsError('目标不存在。', 404);
    return this.store.transaction(draft => {
      authorize(); const key = `${input.kind}:${target.id}`; draft.maintenance[key] = input.enabled;
      draft.streaks[key] = { fail: 0, pass: 0 };
      for(const monitor of this.config.monitors.filter(m=>input.kind==='monitor'?m.id===target.id:m.repairTarget?.hostId===target.id)) {
        if(draft.autoRepair?.monitorChecks?.[monitor.id])draft.autoRepair.monitorChecks[monitor.id]={fail:0,checkedAt:null};
      }
      draft.audit.unshift({ at: iso(this.now()), action: input.enabled ? 'maintenance_enabled' : 'maintenance_disabled', target: target.name }); draft.audit = draft.audit.slice(0, 300);
      return { updated: true };
    });
  }
  snapshot() {
    const now = this.now(), data = this.store.data;
    return { updatedAt: iso(now), hosts: this.config.hosts.map(host => {
      const value = data.hosts[host.id], valid = this.hostFresh(value, now), maintenance = data.maintenance[`host:${host.id}`] === true;
      return { id: host.id, name: host.name, observedAt: value?.observedAt || null, lastSeenAt: value?.lastSeenAt || null, maintenance,
        state: maintenance ? 'maintenance' : !valid ? 'unknown' : this.hostProblem(value) ? 'down' : 'up',
        metrics: value?.metrics || {}, services: value?.services || host.services.map(({ token, ...service }) => ({ ...service, activeState: 'unknown', ok: false })),
        bots: [...(value?.bots || []).map(bot => valid ? bot : { ...bot, state: bot.state === 'stopped' ? 'stopped' : 'unknown', health: 'unknown', transport: null, playing: false,
          ...(bot.kind === 'music' ? { uptimeSeconds: null, startedAt: null } : {}) }),
          ...host.services.filter(service => service.expected === 'stopped').map(service => ({ id: `planned:${service.id}`, name: service.name, kind: 'discussion',
            state: valid && value.services.find(item => item.id === service.id)?.activeState === 'inactive' ? 'stopped' : 'unknown', channelName: '', playing: false, lastError: '' }))], history: value?.history || [] };
    }), monitors: this.config.monitors.map(monitor => {
      const value = data.monitors[monitor.id], valid = value && fresh(value.checkedAt, now, this.config.monitorStaleMs), maintenance = data.maintenance[`monitor:${monitor.id}`] === true;
      return { id: monitor.id, name: monitor.name, url: monitor.url, ...value, maintenance, state: maintenance ? 'maintenance' : !valid ? 'unknown' : value.ok ? 'up' : 'down' };
    }), incidents: data.incidents.slice(0, 100), commands: data.commands.slice(0, 50), audit: data.audit.slice(0, 100),
    notification: { enabled: Boolean(this.send), botName: '思维2', infraChannel: this.config.channelIds.infra, webChannel: this.config.channelIds.web, lastError: this.notificationError },
    queryBot: this.queryBotStatus(), reports: this.reportStatus?.() || { enabled: false, intervalMinutes: 30, nextRunAt: null, lastRunAt: null, channels: {}, lastError: null },
    autoRepair:repairSnapshot(data,this.config,now),
    storageError: this.store.failed ? '状态存储不可用' : null };
  }
  async monitor(monitor) {
    let result; try { result = await this.probe(monitor); } catch { result = { ok: false, checkedAt: iso(this.now()), latencyMs: null, httpStatus: null, tlsDays: null, error: '监控请求失败' }; }
    await this.store.transaction(draft => {
      const now = this.now(), history = draft.monitors[monitor.id]?.history || [];
      const safe = { ok: result.ok === true, checkedAt: iso(now), latencyMs: number(result.latencyMs, 120000), httpStatus: number(result.httpStatus, 599), tlsDays: finite(result.tlsDays) ? result.tlsDays : null, error: text(result.error, 150) || null };
      history.push({ at: safe.checkedAt, ok: safe.ok, latencyMs: safe.latencyMs });
      draft.monitors[monitor.id] = { ...safe, history: history.filter(item => now - Date.parse(item.at) <= 86400000).slice(-1440) };
      observeRepairMonitor(draft,monitor,safe,this.config);
      const problem = !safe.ok ? safe.error || '接口不可用' : safe.tlsDays !== null && safe.tlsDays <= 14 ? 'HTTPS 证书即将到期' : null;
      this.observe(draft, `monitor:${monitor.id}`, 'web', monitor.name, problem, iso(now));
    });
  }
  async tick() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const queue = [...this.config.monitors];
      await Promise.all(Array.from({ length: 2 }, async () => { while (queue.length) await this.monitor(queue.shift()); }));
      await this.store.transaction(draft => {
        const now = this.now(); this.expireCommands(draft, now);
        for (const host of this.config.hosts) {
          if (!this.hostFresh(draft.hosts[host.id], now) && now - this.startedAt > this.config.hostStaleMs) this.observe(draft, `host:${host.id}`, 'infra', host.name, '采集连接中断', iso(now));
        }
      });
      await this.flushNotifications();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  async flushNotifications() {
    if (!this.send || this.sending || this.store.failed) return;
    this.sending = (async () => {
      for (;;) {
        const repairMaintenance=(draft,item)=>draft.maintenance['host:'+item.hostId]||this.config.monitors.some(m=>m.repairTarget?.hostId===item.hostId&&m.repairTarget.serviceId===item.serviceId&&draft.maintenance['monitor:'+m.id]);
        const repair=this.store.data.autoRepair?.events.slice().reverse().find(item=>item.notification==='pending'&&!repairMaintenance(this.store.data,item));
        if(repair){
          const claimed=await this.store.transaction(draft=>{
            const entry=repairState(draft).events.find(item=>item.id===repair.id);
            if(!entry||entry.notification!=='pending'||repairMaintenance(draft,entry))return null;
            const current=draft.autoRepair.states[entry.hostId+':'+entry.serviceId];
            if(entry.phase==='queued'&&['recovered','maintenance','failed','unknown','blocked'].includes(current?.phase)){entry.notification='suppressed';return null}
            entry.notification='sending';return structuredClone(entry);
          });
          if(!claimed)continue;
          let state='sent';
          try{
            await this.send({category:claimed.category,title:claimed.title,theme:claimed.phase==='recovered'?'success':['failed','unknown','blocked'].includes(claimed.phase)?'warning':'info',
              lines:[claimed.message,`时间：${new Date(claimed.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）`]});
            this.notificationError=null;
          }catch{state='uncertain';this.notificationError='KOOK 修复通知未确认送达，请查看修复记录。'}
          await this.store.transaction(draft=>{const entry=repairState(draft).events.find(item=>item.id===repair.id);if(entry)entry.notification=state});
          continue;
        }
        const record = this.store.data.incidents.find(item => !this.store.data.maintenance[item.targetId] && (item.notified === 'pending' || item.recoveryNotified === 'pending'));
        if (!record) return;
        const key = record.notified === 'pending' ? 'notified' : 'recoveryNotified';
        const claimed = await this.store.transaction(draft => {
          const current = draft.incidents.find(item => item.id === record.id);
          if (!current || current[key] !== 'pending' || draft.maintenance[current.targetId]) return null;
          if (key === 'notified' && current.state !== 'open') {
            current.notified = 'suppressed'; if (current.recoveryNotified === 'pending') current.recoveryNotified = 'suppressed'; return null;
          }
          current[key] = 'sending'; return structuredClone(current);
        });
        if (!claimed) continue;
        const latest = this.store.data.incidents.find(item => item.id === record.id);
        if (this.store.data.maintenance[record.targetId] || key === 'notified' && latest?.state !== 'open') {
          await this.store.transaction(draft => { const current = draft.incidents.find(item => item.id === record.id); if (current) current[key] = current.state === 'open' ? 'pending' : 'suppressed'; });
          continue;
        }
        let state = 'sent';
        try {
          await this.send({ category: record.category, title: key === 'notified' ? '运维告警' : '服务已恢复',
            theme: key === 'notified' ? 'danger' : 'success', lines: [record.title, `发生时间：${new Date(key === 'notified' ? record.openedAt : record.resolvedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`, key === 'notified' ? '已连续 3 次发现异常，请打开运维中心核对。' : '连续 2 次检查正常。'] });
          this.notificationError = null;
        } catch { state = 'uncertain'; this.notificationError = 'KOOK 通知未确认送达，请查看事件记录。'; }
        await this.store.transaction(draft => { const item = draft.incidents.find(item => item.id === record.id); if (item) item[key] = state; });
      }
    })().catch(() => { this.notificationError = '通知状态无法保存，已停止发送。'; }).finally(() => { this.sending = null; });
    return this.sending;
  }
  start() {
    this.running = true;
    const run = async () => { if (!this.running) return; try { await this.tick(); } catch {} if (this.running) this.timer = setTimeout(run, this.config.intervalMs); };
    void run();
  }
  async close() { this.running = false; clearTimeout(this.timer); await Promise.allSettled([this.polling, this.sending]); await this.store.close(); }
}
