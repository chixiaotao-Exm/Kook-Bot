import path from 'node:path';
import { access as fileAccess } from 'node:fs/promises';
import { Sub2apiClient } from './sub2api.js';
import { Dashboard } from './dashboard.js';
import { BroadcastScheduler, createKookSender } from './broadcast.js';
import { QuotaServer } from './server.js';
import { NewApiAccountSource } from './newapi.js';
import { KeyUsageClient } from './key-usage.js';
import { KookGateway } from './kook-gateway.js';
import { createAuthorResolver } from './kook-identity.js';
import { KookKeyQueryBot } from './kook-key-query.js';
import { createKookQueryReply } from './kook-query-reply.js';
import { BroadcastImageRenderer } from './broadcast-image.js';
import { createKookImageSender } from './kook-image-sender.js';
import { ActiveQuotaClient } from './active-quota.js';
import { ActiveQuotaSchedule } from './active-quota-schedule.js';
import { InvitationClient } from './invitations.js';
import { AccountLoad } from './account-load.js';

const config = {
  dataDir: path.resolve(process.env.DATA_DIR || './data'), sub2apiUrl: process.env.SUB2API_URL || 'http://127.0.0.1:8080',
  publicUrl: process.env.PUBLIC_URL || 'http://127.0.0.1:18998/quota/', adminApiKey: process.env.SUB2API_ADMIN_KEY,
  refreshMs: Math.max(30000, Number(process.env.REFRESH_SECONDS || 600) * 1000),
};
if (!config.adminApiKey) throw new Error('SUB2API_ADMIN_KEY is required');
const providers = process.env.ARK717_QUERY_KEY ? [new NewApiAccountSource({ baseUrl: 'https://api.ark717.com', queryKey: process.env.ARK717_QUERY_KEY,
  accountId: process.env.ARK717_ACCOUNT_ID || '4201' })] : [];
let activeQuota;
const sourceClient = new Sub2apiClient({ baseUrl: config.sub2apiUrl, adminApiKey: config.adminApiKey, accountOverlay: accounts => activeQuota?.apply(accounts) || accounts });
const activeClient = new ActiveQuotaClient({ baseUrl: config.sub2apiUrl, adminApiKey: config.adminApiKey });
const dashboard = await new Dashboard({ client: sourceClient, providers,
  hiddenPlatforms: (process.env.HIDDEN_PLATFORMS || '').split(','), dataDir: config.dataDir, refreshMs: config.refreshMs }).init();
activeQuota = await new ActiveQuotaSchedule({ dataDir: config.dataDir, enabled: process.env.ACTIVE_QUOTA_ENABLED === 'true',
  listAccounts: () => sourceClient.fetchAccounts(), queryAccount: (id, options) => activeClient.refreshAccount(id, options),
  onUpdated: () => dashboard.refreshAfterQuotaQuery(),
}).init();
const imageRenderer = process.env.BROADCAST_FORMAT === 'image' ? new BroadcastImageRenderer() : undefined;
const createSender = imageRenderer ? createKookImageSender : createKookSender;
const send = process.env.KOOK_TOKEN && process.env.KOOK_CHANNEL_ID ? createSender({ token: process.env.KOOK_TOKEN, channelId: process.env.KOOK_CHANNEL_ID, dashboardUrl: config.publicUrl }) : undefined;
const scheduler = new BroadcastScheduler({ dataDir: config.dataDir, getSnapshot: () => {
  const snapshot = dashboard.snapshot();
  return { ...snapshot, accounts: snapshot.accounts.filter(account => account.platform === 'openai') };
}, send, imageRenderer, beforeBroadcast: process.env.ACTIVE_QUOTA_ENABLED === 'true' ? async ({ signal }) => {
  await activeQuota.ensureCurrent({ signal });
  await dashboard.refresh({ force: true });
} : undefined, sendTimeoutMs: imageRenderer ? 90000 : 15000, dashboardUrl: config.publicUrl });
let configured = true; try { await fileAccess(scheduler.file); } catch { configured = false; }
await scheduler.init();
const defaultReportTimes = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
if (!configured) await scheduler.configure({ enabled: process.env.BROADCAST_ENABLED === 'true' && Boolean(send), times: process.env.BROADCAST_TIMES ? process.env.BROADCAST_TIMES.split(',').map((time) => time.trim()) : defaultReportTimes, timeZone: process.env.BROADCAST_TIME_ZONE || 'Asia/Shanghai' });
await dashboard.refresh(); dashboard.start();
const invitations = process.env.INVITATIONS_ENABLED !== 'false' ? await new InvitationClient({
  baseUrl: config.sub2apiUrl, adminApiKey: config.adminApiKey, dataDir: config.dataDir,
  getAccount: id => dashboard.snapshot().accounts.find(account => account.id === id),
  onUpdated: async (id, invitation) => {
    const result = await dashboard.updateInvitation(id, invitation);
    if (result.storageError) throw new Error('Invitation snapshot not persisted');
  },
}).init() : undefined;
const keyUsage = new KeyUsageClient({ baseUrl: config.sub2apiUrl });
const accountLoad = new AccountLoad({ baseUrl: config.sub2apiUrl, adminApiKey: config.adminApiKey,
  getAccountIds: () => dashboard.snapshot().accounts.map(account => account.id) });
let queryGateway, queryBot;
if (process.env.KOOK_TOKEN && process.env.KOOK_QUERY_ENABLED !== 'false') {
  queryBot = await new KookKeyQueryBot({ keyUsage, reply: createKookQueryReply({ token: process.env.KOOK_TOKEN }),
    dataDir: config.dataDir, getSelfId: () => queryGateway?.snapshot().botId,
    resolveAuthor: createAuthorResolver({ token: process.env.KOOK_TOKEN }),
    channelIds: (process.env.KOOK_QUERY_CHANNEL_IDS || process.env.KOOK_CHANNEL_ID || '').split(',').map(value => value.trim()),
    logger: entry => console.log(JSON.stringify(entry)),
  }).init();
  queryGateway = new KookGateway({ token: process.env.KOOK_TOKEN, onEvent: event => queryBot.handle(event),
    logger: (event, details) => console.log(JSON.stringify({ event, ...details })),
  });
}
const web = new QuotaServer({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 18998), publicUrl: config.publicUrl, sub2apiUrl: config.sub2apiUrl,
  publicAccess: process.env.PUBLIC_ACCESS !== 'false',
  invitations, publicInvites: process.env.PUBLIC_INVITES === 'true',
  keyUsage, accountLoad,
  queryBotStatus: () => queryBot ? { ...queryBot.snapshot(), ...queryGateway.snapshot(), queryLastError: queryBot.snapshot().lastError } : { enabled: false },
  activeQuotaStatus: () => activeQuota.snapshot(),
  keyPresets: [
    { id: 'yeluogpt', label: '叶落GPT', key: process.env.API_KEY_YELUOGPT },
    { id: 'exiaomenggpt', label: '恶小梦GPT', key: process.env.API_KEY_EXIAOMENGGPT },
  ],
  dashboard, scheduler, reporter: { channelId: process.env.KOOK_CHANNEL_ID || '', channelName: process.env.KOOK_CHANNEL_NAME || '', botName: process.env.KOOK_BOT_NAME || '' } });
await web.start(); console.log(JSON.stringify({ event: 'started', port: Number(process.env.PORT || 18998) }));
void queryGateway?.start();
activeQuota.start(); scheduler.start();
let closing = false;
async function shutdown() { if (closing) return; closing = true; const deadline = setTimeout(() => process.exit(1), 20000); queryGateway?.close(); dashboard.close(); await Promise.all([web.close(), scheduler.close(), queryBot?.close(), activeQuota.close(), invitations?.close(), accountLoad.close()]); clearTimeout(deadline); process.exit(0); }
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
