import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ModelResponsesClient } from './model-client.js';
import { KookGateway } from './kook-gateway.js';
import { createKookReply } from './kook-reply.js';
import { createAuthorResolver } from './kook-identity.js';
import { AiChatBot } from './chat-bot.js';

function safeLog(record) {
  const event = typeof record === 'string' ? record : record?.event;
  if (typeof event === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(event)) {
    console.info(JSON.stringify({ at: new Date().toISOString(), event }));
  }
}

export function createRuntime({ config, modelClient, reply, resolveAuthor, Gateway = KookGateway, logger = safeLog } = {}) {
  const client = modelClient || new ModelResponsesClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, systemPrompt: config.systemPrompt });
  const transport = reply || createKookReply({ token: config.token });
  let gateway, closing;
  const bot = new AiChatBot({ generate: (messages, options) => client.generate(messages, options), reply: transport,
    getSelfId: () => gateway?.botId, channelId: config.channelId, dataDir: config.dataDir, model: config.model,
    resolveAuthor: resolveAuthor || createAuthorResolver({ token: config.token }), logger });
  gateway = new Gateway({ token: config.token, onEvent: event => bot.handle(event), logger });
  const snapshot = () => {
    const chat = bot.snapshot(), connection = gateway.snapshot();
    return { ok: Boolean(chat.enabled && connection.connected), model: config.model, gateway: connection, chat };
  };
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return;
    }
    const status = snapshot();
    response.writeHead(status.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(status));
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  const runtime = {
    gateway, bot, server, snapshot,
    async start() {
      await bot.init();
      if (!bot.snapshot().enabled) throw new Error('无法读取机器人状态文件。');
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(config.port, config.host);
      });
      await gateway.start(); logger({ event: 'ai_bot_started' }); return runtime;
    },
    close() {
      if (!closing) closing = (async () => {
        gateway.close();
        const stopped = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
        server.closeAllConnections();
        await Promise.all([bot.close(), stopped]); logger({ event: 'ai_bot_stopped' });
      })();
      return closing;
    },
  };
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let runtime;
  try {
    runtime = createRuntime({ config: loadConfig() });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      runtime.close().catch(() => { process.exitCode = 1; });
    });
    await runtime.start();
  } catch {
    safeLog({ event: 'ai_bot_start_failed' });
    await runtime?.close(); process.exitCode = 1;
  }
}
