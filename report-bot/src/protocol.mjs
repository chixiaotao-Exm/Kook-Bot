export const ORIGIN = 'https://support.pubg.com';
export const FORM_ID = '5040224537369';
export const CATEGORY = '__dc.issue_illegal_program_usage__';
export const FIELD = Object.freeze({
  email: 'request[anonymous_requester_email]',
  steam: 'request[custom_fields][4413697824537]',
  nickname: 'request[custom_fields][4413716837017]',
  language: 'request[custom_fields][114102354993]',
  category: 'request[custom_fields][5040844547865]'
});
const SESSION_URL = ORIGIN + '/api/v2/help_center/sessions.json';
const SUBMIT_URL = ORIGIN + '/hc/zh-cn/requests';
const MAX_SESSION_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const hasControls = value => /[\u0000-\u001f\u007f]/u.test(value);

function text(value, max, message, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) : hasControls(value))) throw new Error(message);
  return value.trim();
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Import a valid reporter profile first.');
  const email = text(profile.email, 254, 'Save a valid email address first.');
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)) throw new Error('Save a valid email address first.');
  if (typeof profile.steam !== 'string' || !/^\d{17}$/.test(profile.steam)) throw new Error('Steam ID must contain 17 digits.');
  text(profile.nickname, 128, 'Enter a valid reporter nickname.');
  if (typeof profile.language !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(profile.language)) throw new Error('Import a valid language setting from the official form.');
  if (profile.category !== CATEGORY) throw new Error('Import the correct report category from the official form.');
}

export function validate(profile, player, description) {
  validateProfile(profile);
  if (typeof player !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(player)) throw new Error('Enter a valid player nickname to report.');
  const subject = text(profile.subject, 200, 'The report subject is invalid or too long.');
  if (subject.replaceAll('{player}', player).length > 200) throw new Error('The report subject is too long.');
  text(description, 12000, 'The report description is invalid or too long.', { multiline: true });
}

export function buildBody(profile, player, description, token) {
  validate(profile, player, description);
  if (typeof token !== 'string' || !token || token.length > 4096 || /\s|[\u0000-\u001f\u007f]/u.test(token)) throw new Error('No valid temporary CSRF token was received.');
  const escaped = description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replace(/\r\n?|\n/g, '<br>');
  const body = new URLSearchParams({
    'request[ticket_form_id]': FORM_ID,
    'request[custom_fields][5050432733209]': player,
    'request[subject]': profile.subject.trim().replaceAll('{player}', player),
    'request[description]': `<p>${escaped}</p>`,
    'request[description_mimetype]': 'text/html',
    authenticity_token: token
  });
  for (const [key, field] of Object.entries(FIELD)) body.set(field, profile[key].trim());
  return body;
}

export function importProfile(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Invalid HAR file.');
  const entry = entries.find(e => e?.request?.method === 'POST' && e.request.url === SUBMIT_URL);
  const data = entry?.request?.postData;
  if (!data || (data.mimeType && !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(data.mimeType))) throw new Error('No official report form submission was found in the HAR file.');
  let params;
  if (typeof data.text === 'string' && data.text) {
    if (Buffer.byteLength(data.text, 'utf8') > 256 * 1024) throw new Error('The HAR form is too large.');
    // Text is the encoded wire body: decode once, preserving literal + and %.
    params = new URLSearchParams(data.text);
  } else {
    if (!Array.isArray(data.params) || data.params.length > 128) throw new Error('The HAR file does not contain a valid form.');
    params = new URLSearchParams();
    for (const p of data.params) {
      if (typeof p?.name !== 'string' || typeof p.value !== 'string' || p.name.length > 256 || p.value.length > 16384) throw new Error('Invalid HAR field.');
      // HAR params normally are decoded. Some exporters encode names and values together.
      const encoded = /%5b/i.test(p.name);
      const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
      params.append(encoded ? decode(p.name) : p.name, encoded ? decode(p.value) : p.value);
    }
  }
  const allowed = ['request[ticket_form_id]', ...Object.values(FIELD)];
  for (const key of allowed) if (params.getAll(key).length !== 1) throw new Error('The HAR file has missing or duplicate profile fields.');
  if (params.get('request[ticket_form_id]') !== FORM_ID) throw new Error('The HAR file does not contain a supported official report form.');
  // Deliberately exclude cookies, headers, CSRF tokens, subjects and old evidence.
  const profile = Object.fromEntries(Object.entries(FIELD).map(([key, field]) => [key, params.get(field)]));
  validateProfile(profile);
  return profile;
}

function flashMessages(html) {
  const match = /"flash_messages"\s*:\s*\[/g.exec(html);
  if (!match) return [];
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      try { const result = JSON.parse(html.slice(start, i + 1)); return Array.isArray(result) ? result : []; } catch { return []; }
    }
  }
  return [];
}

export function classifyResponse(response, html) {
  let url;
  try { url = new URL(response.url); } catch { return unknown('No valid official response URL was received'); }
  if (url.origin !== ORIGIN || url.username || url.password) return unknown('The response left the official website');
  if ([401, 403].includes(response.status)) return { kind: 'verification', message: 'The official website requires sign-in or manual verification. The request may have been delivered; check your email or the official website. It will not be retried automatically.' };
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) return unknown('The official response is invalid or too large');
  // Only the captured official success notice on its expected landing page proves success.
  if (response.status === 200 && /^\/hc\/zh-cn\/?$/.test(url.pathname) &&
      flashMessages(html).some(m => m?.type === 'notice' && m.title === '您的请求已成功提交。')) {
    return { kind: 'success', message: 'The official website confirmed that your request was submitted successfully. This does not indicate a confirmed violation or ban.' };
  }
  return unknown(`No official success notice was received (HTTP ${response.status})`);
}

function unknown(reason) { return { kind: 'unknown', message: `${reason}. The request may have been delivered; check your email or the official website before submitting again. It will not be retried automatically.` }; }
function notSent() { return { kind: 'not_sent', message: 'Could not obtain an official session or validate the profile. No report was sent. Open the official website to complete any required verification.' }; }
function throwIfAborted(signal) { if (signal?.aborted) throw new Error('Aborted'); }

// The race bounds even custom fetch/body implementations that ignore AbortSignal.
async function bounded(work, timeoutMs, signal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timeout, abort;
  const stopped = new Promise((_, reject) => {
    const stop = () => { controller.abort(); reject(new Error('Request interrupted')); };
    abort = stop;
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(stop, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => { throwIfAborted(controller.signal); return work(controller.signal); }), stopped]); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

async function boundedText(response, limit, signal) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    Promise.resolve(response.body?.cancel()).catch(() => {});
    throw new Error('Response too large');
  }
  if (!response.body?.getReader) {
    const result = await response.text();
    throwIfAborted(signal);
    if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > limit) throw new Error('Response too large');
    return result;
  }
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) { cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function getSession(fetcher, signal, timeoutMs) {
  return bounded(async activeSignal => {
    const session = await fetcher(SESSION_URL, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual', signal: activeSignal });
    if (!session.ok) { Promise.resolve(session.body?.cancel()).catch(() => {}); throw new Error('Official session rejected'); }
    const token = JSON.parse(await boundedText(session, MAX_SESSION_BYTES, activeSignal))?.current_session?.csrf_token;
    if (typeof token !== 'string' || !token || token.length > 4096 || /\s|[\u0000-\u001f\u007f]/u.test(token)) throw new Error('Invalid session');
    return token;
  }, timeoutMs, signal);
}

export async function submitReport(profile, player, description, fetcher = fetch, beforePost = async () => {}, { signal, sessionTimeoutMs = 20000, submitTimeoutMs = 30000, wasPostSent } = {}) {
  let body;
  try {
    validate(profile, player, description);
    const token = await getSession(fetcher, signal, sessionTimeoutMs);
    body = buildBody(profile, player, description, token);
    throwIfAborted(signal);
    await bounded(() => beforePost(), sessionTimeoutMs, signal);
    throwIfAborted(signal);
  } catch { return notSent(); }
  let postStarted = false;
  try {
    return await bounded(async activeSignal => {
      throwIfAborted(activeSignal);
      postStarted = true;
      const response = await fetcher(SUBMIT_URL, {
        method: 'POST', credentials: 'include', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(), signal: activeSignal
      });
      return classifyResponse(response, await boundedText(response, MAX_RESPONSE_BYTES, activeSignal));
    }, submitTimeoutMs, signal);
  } catch { return postStarted && (wasPostSent ? wasPostSent() : true) ? unknown('The connection was interrupted or timed out after the submission attempt') : notSent(); }
}

// A read-only readiness probe. It never returns the token or sends a report.
export async function checkSession(fetcher, { signal, sessionTimeoutMs = 20000 } = {}) {
  try { await getSession(fetcher, signal, sessionTimeoutMs); return { ok: true, kind: 'ready' }; }
  catch { return { ok: false, ...notSent() }; }
}
