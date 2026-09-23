import { readFile, unlink } from 'node:fs/promises';
import { atomicJson } from '../src/util.js';
import { readConfig } from '../src/config.js';
import path from 'node:path';

const config = readConfig();
const snapshotFile = path.join(config.dataDir, 'upgrade-playback.json');
const queueFile = path.join(config.dataDir, 'queue.json');
if (process.argv[2] === 'capture') {
  const base = `http://127.0.0.1:${config.webPort}`;
  const response = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(5000) });
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const stateResponse = await fetch(`${base}/api/state`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) });
  if (!stateResponse.ok) throw new Error('Cannot capture current playback; update stopped.');
  const state = await stateResponse.json();
  const states = await Promise.all((state.bots || [state.bot]).map(async (bot) => {
    if (bot.id === 'default') return state;
    const response = await fetch(`${base}/api/state?botId=${encodeURIComponent(bot.id)}`, {
      headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Cannot capture all bot playback; update stopped.');
    return response.json();
  }));
  await atomicJson(snapshotFile, { player: state.player, bots: states.map(({ botId, bot, player }) => ({ botId, bot, player })), capturedAt: Date.now() });
  console.log(JSON.stringify({ captured: true, bots: states.map(({ botId, player }) => ({ id: botId,
    song: player.current?.name, seconds: player.seconds, status: player.status, queue: player.queue.length, volume: player.volume,
    channel: player.context?.voiceChannelId })) }));
} else if (process.argv[2] === 'migrate') {
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  let saved;
  try { saved = JSON.parse(await readFile(queueFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved?.version === 1) {
    const same = saved.current && saved.current.id === snapshot.player.current?.id;
    const intent = same ? ({ playing: 'playing', paused: 'paused' }[snapshot.player.status] || 'idle') : 'idle';
    const elapsed = intent === 'playing' ? Math.min(5, (Date.now() - snapshot.capturedAt) / 1000) : 0;
    const positionSeconds = same && Number.isFinite(snapshot.player.seconds) ? snapshot.player.seconds + elapsed : 0;
    await atomicJson(queueFile, { ...saved, version: 2, positionSeconds, intent, hasStarted: Boolean(saved.current), savedAt: Date.now() });
    console.log(JSON.stringify({ migrated: true, intent, positionSeconds }));
  }
  await unlink(snapshotFile);
} else throw new Error('Use capture or migrate.');
