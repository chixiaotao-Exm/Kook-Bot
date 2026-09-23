import { createIcons, Headphones, ArrowLeft, ArrowRight, UserRound, LogOut } from 'lucide';
import { createSessionApi } from './session.js';
const $ = (id) => document.getElementById(id);
let csrf = '', actor = null, busy = false;
const api = createSessionApi({ getCsrf: () => csrf, setCsrf: (value) => { csrf = value; }, requiresPassword: () => false, onUnauthorized: () => {} });
const returnTo = safeReturn(new URLSearchParams(location.search).get('returnTo'));
function safeReturn(value) {
  const fallback = '/admin/console';
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return fallback;
  try {
    const target = new URL(value, location.origin);
    if (target.origin !== location.origin) return fallback;
    if (target.pathname === '/' || target.pathname === '/index.html') return `${fallback}${target.search}`;
    if (target.pathname === fallback) return `${fallback}${target.search}`;
    return /^\/admin(?:\/|$)/.test(target.pathname) ? fallback : `${target.pathname}${target.search}`;
  } catch { return fallback; }
}
function message(text, error = false) { $('admin-message').textContent = text; $('admin-message').classList.toggle('error', error); $('admin-message').hidden = !text; }
function lock(value) { busy = value; for (const el of document.querySelectorAll('form input,form button,#admin-logout')) el.disabled = value; }
function setCredentials(result) { if (result.csrf) csrf = result.csrf; if ('actor' in result) actor = result.actor; }
function showLogin() {
  actor = null; $('admin-account').hidden = true; $('admin-login-form').hidden = false;
  $('admin-heading').textContent = '管理员登录'; $('admin-intro').textContent = '登录后管理机器人、音乐账号和全部房间。'; document.title = '管理员登录 · 桃音';
}
async function showAccount() {
  const status = await api('/admin/status');
  $('admin-heading').textContent = '管理员账号'; $('admin-intro').textContent = '管理你的登录密码和当前登录状态。'; document.title = '管理员账号 · 桃音';
  $('admin-login-form').hidden = true; $('admin-account').hidden = false;
  $('admin-account-username').textContent = status.username || ''; $('password-username').value = status.username || ''; $('admin-console').href = returnTo;
}
async function refresh() {
  const session = await api('/session'); setCredentials(session);
  if (actor?.siteAdmin) await showAccount();
  else { showLogin(); if (!session.adminLoginEnabled) { $('admin-login-form').hidden = true; message('管理员登录暂未配置，请联系网站维护者。', true); } }
}
$('admin-login-form').onsubmit = async (event) => {
  event.preventDefault(); if (busy) return; message(''); lock(true);
  try {
    const result = await api('/admin/login', { username: $('admin-username').value.trim(), password: $('admin-password').value }, false);
    setCredentials(result); $('admin-password').value = ''; location.replace(returnTo);
  } catch (error) {
    message(error.message || '登录失败，请稍后重试。', true); $('admin-password').value = '';
    if (error.status === 401 || error.status === 403) {
      try { const session = await api('/session'); setCredentials(session); if (actor?.siteAdmin) await showAccount(); } catch { /* Keep the original login error visible; the user can retry explicitly. */ }
    }
  }
  finally { lock(false); }
};
$('admin-password-form').onsubmit = async (event) => {
  event.preventDefault(); if (busy) return; message('');
  if ($('new-password').value !== $('confirm-password').value) { message('两次输入的新密码不一致。', true); $('confirm-password').focus(); return; }
  lock(true);
  try {
    const result = await api('/admin/password', { currentPassword: $('current-password').value, newPassword: $('new-password').value }, false); setCredentials(result);
    $('admin-password-form').reset(); $('password-username').value = $('admin-account-username').textContent; message('密码已更新。其他设备需要使用新密码重新登录。');
  } catch (error) {
    message(error.message || '密码修改失败，请稍后重试。', true);
    if (error.status === 401 || error.status === 403) { await refresh().catch(() => {}); }
  } finally { lock(false); }
};
$('admin-logout').onclick = async () => {
  if (busy) return; message(''); lock(true);
  try { setCredentials(await api('/admin/logout', {}, false)); $('admin-password-form').reset(); showLogin(); message('已退出管理员登录，你的昵称和点歌记录已保留。'); }
  catch (error) { message(error.message || '退出失败，请稍后重试。', true); }
  finally { lock(false); }
};
createIcons({ icons: { Headphones, ArrowLeft, ArrowRight, UserRound, LogOut }, attrs: { 'aria-hidden': 'true' } });
void refresh().catch((error) => message(error.message || '暂时无法读取登录状态，请刷新重试。', true)).finally(() => { $('admin-loading').hidden = true; });
