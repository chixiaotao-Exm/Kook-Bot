import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { KookGateway } from '../ai-bot/src/kook-gateway.js';

const token = process.env.KOOK_TOKEN;
const channel = process.env.KOOK_CHANNEL_ID;
if (!token || !/^\d+$/.test(channel || '')) throw new Error('Missing KOOK configuration');
const worker = spawn(process.env.PYTHON || 'python3', ['-u', 'bot.py'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let stopping = false;
const acknowledgements = new Map();
let serial = 0;
function input(value) { if (!worker.stdin.destroyed) worker.stdin.write(JSON.stringify(value) + '\n'); }
const gateway = new KookGateway({ token,
  logger: (event, detail) => console.error(JSON.stringify({event, ...detail})),
  onEvent: async event => {
    if (event.channel_type !== 'GROUP' || event.target_id !== channel || ![1, 9].includes(event.type)
      || event.extra?.author?.bot || !event.author_id || !event.msg_id) return;
    const id = String(++serial);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { acknowledgements.delete(id); reject(new Error('worker_ack_timeout')); }, 10000);
      acknowledgements.set(id, () => { clearTimeout(timer); resolve(); });
      input({op: 'event', id, event});
    });
  },
});

async function send(action) {
  // The worker can only send to this deployment's configured channel.
  const body = {type: 10, target_id: channel, content: JSON.stringify([{
    type: 'card', theme: action.theme || 'info', size: 'lg', modules: [
      {type: 'header', text: {type: 'plain-text', content: '幻兽帕鲁 · 帕鲁管家'}},
      {type: 'section', text: {type: 'plain-text', content: String(action.text).slice(0, 4500)}},
    ],
  }])};
  if (action.quote) body.quote = action.quote;
  const response = await fetch('https://www.kookapp.cn/api/v3/message/create', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {'Authorization': `Bot ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (raw.length > 65536) throw new Error('oversized_kook_response');
  const result = JSON.parse(raw);
  if (!response.ok || result.code !== 0) throw new Error(`kook_send_${Number(result.code) || response.status}`);
  return {message_id: result.data?.msg_id};
}
// Sequential outbound messages preserve progress/result order and avoid bursts.
let outbox = Promise.resolve();
createInterface({input: worker.stdout}).on('line', line => {
  try {
    const action = JSON.parse(line);
    if (action.op === 'ack') {
      acknowledgements.get(action.id)?.(); acknowledgements.delete(action.id); return;
    }
    if (action.op !== 'send' || typeof action.text !== 'string') return;
    outbox = outbox.then(async () => {
      try { input({op: 'result', id: action.id, ok: true, result: await send(action)}); }
      catch (error) { input({op: 'result', id: action.id, ok: false, error: /^kook_send_\d+$/.test(error.message) ? error.message : 'send_failed'}); }
    });
  } catch { console.error('invalid_worker_output'); }
});
worker.on('exit', code => { gateway.close(); if (!stopping) process.exit(code || 1); });
worker.on('error', () => { console.error('worker_failed'); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true; gateway.close(); worker.kill('SIGTERM');
  setTimeout(() => process.exit(0), 8000).unref();
});
await gateway.start();
