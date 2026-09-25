'use strict';

// One shell, two same-origin services. Credentials are never retained by this module.
window.opsConsole = (() => {
  let panel, pending, shadow, selected = null, callbacks = {}, generation = 0, guestMode = false;
  async function request(route, { method = 'GET', body, csrf } = {}) {
    const response = await fetch(`/ops/api/${route}`, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '运维服务暂时不可用。');
    return result;
  }
  async function mount() {
    if (panel) return panel;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetch('/ops/panel.html', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('运维页面加载失败，请稍后重试。');
      const template = new DOMParser().parseFromString(await response.text(), 'text/html');
      const host = document.querySelector('#ops-panel');
      shadow ||= host.attachShadow({ mode: 'open' });
      shadow.replaceChildren();
      for (const id of ['boot-view', 'login-view', 'app-view', 'restart-dialog', 'toast']) {
        const source = template.getElementById(id);
        if (!source) throw new Error('运维页面版本不匹配。');
        shadow.append(document.importNode(source, true));
      }
      const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = '/ops/style.css?v=3'; shadow.prepend(sheet);
      const styles = document.createElement('link'); styles.rel = 'stylesheet'; styles.href = new URL('./console-panel.css?v=1', location.href).href; shadow.append(styles);
      const login = shadow.querySelector('.login-card');
      login.querySelector('h2').textContent = '登录后查看运维';
      login.querySelector('form').hidden = true;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button primary'; button.textContent = '管理员登录';
      button.addEventListener('click', () => {
        if (guestMode) panel?.refreshSession().catch(error => { shadow.querySelector('#login-error').textContent = error.message; shadow.querySelector('#login-error').hidden = false; });
        else callbacks.onLogin?.();
      }); login.append(button);
      if (!window.createOpsPanel) {
        window.__OPS_EMBED_ONLY__ = true;
        await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = '/ops/app.js?v=4';
          const timer = setTimeout(() => { script.remove(); reject(new Error('运维脚本加载超时，请重试。')); }, 15000);
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('运维脚本加载失败，请重试。')); };
          document.head.append(script);
        });
      }
      panel = window.createOpsPanel(shadow, { apiBase: '/ops/api/',
        onSession: (authenticated, user, capabilities) => {
          guestMode = capabilities?.publicManagement === true;
          login.querySelector('h2').textContent = guestMode ? '重新连接运维中心' : '登录后查看运维';
          button.textContent = guestMode ? '重新连接' : '管理员登录';
          callbacks.onSession?.(authenticated, user);
        },
        onView: view => callbacks.onView?.(`ops-${view}`),
      });
      if (selected) panel.show(selected); else panel.hide();
      return panel;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    configure(value) { callbacks = value; },
    async show(view) {
      selected = view; const epoch = ++generation;
      const feedback = document.querySelector('#ops-feedback'); feedback.hidden = false; feedback.textContent = '正在连接运维中心…';
      document.querySelector('#ops-retry').hidden = true;
      try { const value = await mount(); if (epoch !== generation) return; feedback.hidden = true; value.show(view); }
      catch (error) { if (epoch !== generation) return; feedback.textContent = error.message; document.querySelector('#ops-retry').hidden = false; }
    },
    hide() { selected = null; generation++; panel?.hide(); },
    async login(credentials) {
      const session = await request('session');
      const result = await request('login', { method: 'POST', body: credentials, csrf: session.csrf });
      callbacks.onSession?.(result.authenticated, result.user);
      if (panel) await panel.refreshSession();
    },
    async logout() {
      panel?.clear();
      const session = await request('session');
      await request('logout', { method: 'POST', body: {}, csrf: session.csrf });
      panel?.clear();
      callbacks.onSession?.(false);
    },
  };
})();
