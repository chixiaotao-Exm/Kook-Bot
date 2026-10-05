import { CookieJar } from 'tough-cookie';
import { ORIGIN, FORM_ID, submitReport, validateProfile, checkSession } from './protocol.mjs';

// Node fetch has no cookie store. Every attempt gets a new memory-only official session.
export function sessionFetch(fetchImpl = fetch, { onPostStart = () => {} } = {}) {
  const jar = new CookieJar();
  return async (input, options = {}) => {
    let url = new URL(input), method = (options.method || 'GET').toUpperCase();
    let body = options.body;
    for (let count = 0; count < 6; count++) {
      if (options.signal?.aborted) throw new Error('Request cancelled');
      if (url.origin !== ORIGIN || url.username || url.password || !['GET', 'POST'].includes(method)) throw new Error('Unexpected request destination');
      if (method === 'POST' && url.pathname !== '/hc/zh-cn/requests') throw new Error('Unexpected submission destination');
      const headers = new Headers({ Accept: 'text/html,application/json' });
      const cookie = await jar.getCookieString(url.href);
      if (cookie) headers.set('Cookie', cookie);
      if (method === 'POST') {
        headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
        headers.set('Origin', ORIGIN);
        headers.set('Referer', ORIGIN + '/hc/zh-cn/requests/new?ticket_form_id=' + FORM_ID);
      }
      if (options.signal?.aborted) throw new Error('Request cancelled');
      if (method === 'POST') onPostStart();
      const response = await fetchImpl(url.href, { method, body, headers, redirect: 'manual', cache: 'no-store', signal: options.signal });
      const cookies = response.headers?.getSetCookie?.() || [];
      if (cookies.length > 64) throw new Error('Too many session cookies');
      for (const cookie of cookies) {
        if (cookie.length > 4096) throw new Error('Session cookie too large');
        await jar.setCookie(cookie, url.href, { ignoreError: true });
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      Promise.resolve(response.body?.cancel()).catch(() => {});
      if (!location || location.length > 8192 || options.redirect === 'error') throw new Error('Unexpected redirect');
      // A 307/308 could only continue by replaying the POST. Never do that.
      if (method === 'POST' && [307, 308].includes(response.status)) throw new Error('POST replay refused');
      url = new URL(location, url);
      if (method === 'POST') { method = 'GET'; body = undefined; }
    }
    throw new Error('Too many redirects');
  };
}

export function createSubmitter(profile, enabled, { fetchImpl = fetch, sessionTimeoutMs, submitTimeoutMs } = {}) {
  if (enabled) {
    try { validateProfile(profile); } catch { throw new Error('举报人资料无效：请从官方举报表单 HAR 重新导入邮箱、Steam ID、昵称、语言和举报分类。'); }
  }
  // Retain only the allowed profile fields; no supplied cookies or headers are reused.
  const safeProfile = profile ? Object.fromEntries(['email', 'steam', 'nickname', 'language', 'category'].map(key => [key, profile[key]])) : {};
  return async (draft, { signal } = {}) => {
    if (!enabled) return { kind: 'not_sent', message: '预览模式：尚未向 PUBG 发送举报。' };
    let postSent = false;
    return submitReport({ ...safeProfile, subject: draft?.subject }, draft?.player, draft?.description,
      sessionFetch(fetchImpl, { onPostStart: () => { postSent = true; } }), undefined,
      { signal, sessionTimeoutMs, submitTimeoutMs, wasPostSent: () => postSent });
  };
}

export function checkOfficialSession({ fetchImpl = fetch, signal, sessionTimeoutMs } = {}) {
  return checkSession(sessionFetch(fetchImpl), { signal, sessionTimeoutMs });
}
