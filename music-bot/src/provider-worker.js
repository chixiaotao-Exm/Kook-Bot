import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
try { await writeFile(path.join(tmpdir(), 'anonymous_token'), '', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
global.deviceId = randomBytes(26).toString('hex').toUpperCase();
const sdk = require('@neteasecloudmusicapienhanced/api');
const upstreamRequire = createRequire(require.resolve('@neteasecloudmusicapienhanced/api'));
upstreamRequire('axios').default.defaults.timeout = 12000;
let keyReady = false;
parentPort.on('message', async ({ id, name, params }) => {
  try {
    if (name === 'song_url_v1' && !keyReady) {
      const result = await sdk.register_xeapikey({ deviceId: global.deviceId });
      if (!result.body?.sk) throw new Error('No media key');
      await writeFile(path.join(tmpdir(), 'xeapi_public_key'), JSON.stringify(result.body), { mode: 0o600 });
      keyReady = true;
    }
    const result = await sdk[name](params);
    parentPort.postMessage({ id, ok: true, body: result.body });
  } catch { parentPort.postMessage({ id, ok: false }); }
});
