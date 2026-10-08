import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('report destination comes from private environment configuration', () => {
  const script = "import {CHANNEL_ID,isAllowedMessage} from './src/domain.js'; console.log(CHANNEL_ID); console.log(isAllowedMessage({channel_type:'GROUP',type:1,target_id:'9876543210123456',author_id:'123456',msg_id:'12345678-1234-1234-1234-123456789abc',content:'Player',extra:{author:{bot:false}}},'654321'));";
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, KOOK_CHANNEL_ID: '9876543210123456' }, encoding: 'utf8'
  });
  assert.deepEqual(output.trim().split(/\r?\n/), ['9876543210123456', 'true']);
});
