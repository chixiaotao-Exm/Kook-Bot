import { sleep, UserError } from './util.js';

export class Kook {
  constructor(token, { fetchImpl = fetch, sleepImpl = sleep, now = Date.now, base = 'https://www.kookapp.cn/api/v3/' } = {}) {
    this.token = token; this.fetch = fetchImpl; this.sleep = sleepImpl; this.base = base;
    this.now = now; this.limits = new Map(); this.routeBuckets = new Map(); this.globalUntil = 0;
  }
  async request(endpoint, params = {}, method = 'GET') {
    const url = new URL(endpoint, this.base);
    if (method === 'GET') url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 4; attempt++) {
      const until = Math.max(this.globalUntil, this.limits.get(this.routeBuckets.get(endpoint) || endpoint) || 0);
      if (until > this.now()) await this.sleep(until - this.now());
      let response;
      try {
        response = await this.fetch(url, {
          method, headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(params) } : {}),
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
      } catch { throw new UserError('KOOK 请求失败或超时，请检查服务器网络。'); }
      const limited = response.status === 429;
      if (limited || response.headers.get('x-rate-limit-remaining') === '0') {
        const seconds = Number(response.headers.get('x-rate-limit-reset') || response.headers.get('retry-after') || 2 ** (attempt + 1));
        const until = this.now() + Math.max(1000, (Number.isFinite(seconds) ? seconds : 5) * 1000);
        const bucket = response.headers.get('x-rate-limit-bucket') || endpoint;
        this.routeBuckets.set(endpoint, bucket); this.limits.set(bucket, until);
        if (response.headers.has('x-rate-limit-global') && !['0', 'false'].includes(response.headers.get('x-rate-limit-global'))) this.globalUntil = until;
      }
      if (limited && attempt < 3) {
        await response.arrayBuffer();
        continue;
      }
      let body;
      try { body = await response.json(); } catch { throw new UserError(`KOOK 返回异常响应（HTTP ${response.status}）。`); }
      if (!response.ok || body.code !== 0) {
        throw new UserError(`KOOK 接口 ${endpoint} 失败（${body.code ?? response.status}），请检查 Token、频道权限及语音额度。`);
      }
      return body.data;
    }
  }
  post(endpoint, params) { return this.request(endpoint, params, 'POST'); }
  async reply(channel, content, messageId) {
    // Plain text in a card prevents song titles from creating mentions or markup.
    const card = [{ type: 'card', theme: 'secondary', size: 'lg', modules: [{
      type: 'section', text: { type: 'plain-text', content: content.slice(0, 3800) },
    }] }];
    return this.post('message/create', {
      target_id: channel, type: 10, content: JSON.stringify(card),
      ...(messageId ? { reply_msg_id: messageId } : {}),
    });
  }
}
