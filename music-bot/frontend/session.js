/** One renewal owns both the browser cookie and its matching CSRF token. */
export function createSessionApi({ getCsrf, setCsrf, requiresPassword, onUnauthorized, fetcher = fetch }) {
  let renewal = null, generation = 0;
  async function request(route, data, retry = true) {
    // Avoid sending an obsolete token while another request renews the session.
    if (renewal && route !== '/session') await renewal;
    const sentGeneration = generation;
    const response = await fetcher(`/api${route}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(getCsrf() ? { 'X-CSRF-Token': getCsrf() } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60000) });
    const body = await response.json();
    if (response.ok) return body;
    if (response.status === 401 && !requiresPassword() && retry && route !== '/session') {
      if (sentGeneration === generation && !renewal) {
        renewal = request('/session', undefined, false).then((session) => {
          if (!session.authenticated || !session.csrf) throw new Error('无法恢复控制台会话，请刷新重试。');
          setCsrf(session.csrf); generation++;
        }).finally(() => { renewal = null; });
      }
      if (renewal) await renewal;
      return request(route, data, false);
    }
    if (response.status === 401 && route !== '/login') onUnauthorized();
    const error = new Error(body.error || '请求失败'); error.code = body.code; error.status = response.status;
    error.retryAfterSeconds = body.retryAfterSeconds; throw error;
  }
  return request;
}
