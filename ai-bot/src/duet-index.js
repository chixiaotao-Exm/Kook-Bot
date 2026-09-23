import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ModelResponsesClient } from './model-client.js';
import { KookGateway } from './kook-gateway.js';
import { createKookReply } from './kook-reply.js';
import { createKookProgress } from './kook-progress.js';
import { createAuthorResolver } from './kook-identity.js';
import { loadDuetConfig } from './duet-config.js';
import { doctorDuet } from './duet-doctor.js';
import { DuetSession } from './duet-session.js';
import { DuetCommands } from './duet-commands.js';
import { safeLog } from './index.js';

export function createDuetRuntime({ config, clients, replies, commandReply, progress, resolveAuthor,
  verify = doctorDuet, Gateway = KookGateway, logger = safeLog } = {}) {
  const modelClients = clients || config.models.map((model, index) => new ModelResponsesClient({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model, systemPrompt: config.systemPrompts[index],
    timeoutMs: config.modelTimeoutMs, maxOutputTokens: config.maxOutputTokens, reasoningEffort: config.reasoningEffort,
  }));
  const transports = replies || config.tokens.map(token => createKookReply({ token }));
  const notice = commandReply || createKookReply({ token: config.tokens[0], timeoutMs: 10000 });
  const participants = config.labels.map((label, index) => ({ label,
    generate: (messages, options) => modelClients[index].generate(messages, options),
    reply: payload => transports[index]({ ...payload, textOnly: true }),
    progress: index === 0 ? (progress === undefined ? createKookProgress({ token: config.tokens[0] }) : progress) : null,
  }));
  const session = new DuetSession({ participants, channelId: config.channelId, dataDir: config.dataDir,
    rounds: config.rounds, maxRounds: 6, deadlineMs: config.deadlineMs, betweenTurnsMs: config.betweenTurnsMs, logger });
  let commands, closing;
  const gateways = config.tokens.map((token, index) => new Gateway({ token, logger,
    onEvent: index === 0 ? event => commands.handle(event) : async () => {},
  }));
  const control = {
    start: options => gateways.every(gateway => gateway.snapshot().connected)
      ? session.start(options) : { accepted: false, reason: 'NOT_READY' },
    stop: options => session.stop(options), snapshot: () => session.snapshot(),
  };
  commands = new DuetCommands({ session: control, channelId: config.channelId, dataDir: config.dataDir, defaultRounds: config.rounds,
    getSelfId: () => gateways[0].botId, getParticipantIds: () => gateways.map(gateway => gateway.botId),
    resolveAuthor: resolveAuthor || createAuthorResolver({ token: config.tokens[0] }),
    reply: payload => notice({ ...payload, textOnly: true }), logger });
  const snapshot = () => {
    const connections = gateways.map((gateway, index) => ({ label: config.labels[index], model: config.models[index], ...gateway.snapshot() }));
    const commandState = commands.snapshot(), conversation = session.snapshot();
    return { ok: connections.every(connection => connection.connected) && commandState.enabled && conversation.enabled,
      channelId: config.channelId, bots: connections, commands: commandState, duet: conversation };
  };
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404); response.end(); return; }
    const state = snapshot();
    response.writeHead(state.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(state));
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  const runtime = {
    gateways, commands, session, server, snapshot,
    async start() {
      const inspected = await verify(config);
      if (!Array.isArray(inspected?.bots) || inspected.bots.length !== 2 || !inspected.bots.every(bot => /^\d{5,30}$/.test(bot.botId))
        || inspected.bots[0].botId === inspected.bots[1].botId || inspected.channelAccessible !== true) throw new Error('Duet identity verification failed');
      inspected.bots.forEach((bot, index) => { gateways[index].botId = bot.botId; participants[index].id = bot.botId; });
      await session.init(); await commands.init();
      if (!commands.snapshot().enabled || !session.snapshot().enabled) throw new Error('Duet state or command receipts are unavailable');
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(config.port, config.host);
      });
      await Promise.all(gateways.map(gateway => gateway.start()));
      logger({ event: 'duet_started' }); return runtime;
    },
    close() {
      if (!closing) closing = (async () => {
        gateways.forEach(gateway => gateway.close());
        const stopped = new Promise(resolve => server.listening ? server.close(resolve) : resolve()); server.closeAllConnections();
        await Promise.all([commands.close(), session.close(), stopped]); logger({ event: 'duet_stopped' });
      })();
      return closing;
    },
  };
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let runtime;
  try {
    runtime = createDuetRuntime({ config: loadDuetConfig() });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { runtime.close().catch(() => { process.exitCode = 1; }); });
    await runtime.start();
  } catch {
    safeLog({ event: 'duet_start_failed' }); await runtime?.close(); process.exitCode = 1;
  }
}
