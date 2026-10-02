import { sourceName, normalizeSource } from './music-sources.js';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLyrics({ api, root, drawIcons }) {
  let active = false, snapshot = null, receivedAt = 0, key = '', generation = 0, lines = [], current = -1, timer;
  let translation = true, immersive = false, content = '请先播放一首歌曲。', loaded = false;
  root.innerHTML = '<div class="feature-heading"><div><h2 id="lyrics-title">随音乐一起</h2><p id="lyrics-meta">选择机器人，查看当前歌曲的歌词。</p></div><div class="feature-actions"><button class="secondary" id="lyrics-translation" aria-pressed="true" hidden>显示译文</button><button class="secondary" id="lyrics-retry" hidden>重试</button><button class="secondary" id="lyrics-immerse" aria-pressed="false"><i data-lucide="expand"></i>沉浸歌词</button></div></div><p id="lyrics-notice" class="feature-note" role="status"></p><div id="lyrics-lines" class="lyrics-lines" tabindex="0" aria-label="当前歌曲歌词"></div>';
  const list = root.querySelector('#lyrics-lines');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width: 800px)');
  function revealPanel() {
    if (active && !immersive && mobile.matches) root.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function centerCurrent(smooth = true) {
    if (!active || !list.clientHeight) return;
    const line = list.querySelector('.current');
    list.scrollTo({ top: line ? Math.max(0, line.offsetTop - list.clientHeight / 2 + line.offsetHeight / 2) : 0,
      behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
  }
  const resize = new ResizeObserver(() => centerCurrent(false));
  resize.observe(list, { box: 'border-box' });
  mobile.addEventListener('change', revealPanel);
  document.fonts?.ready.then(() => centerCurrent(false));
  function render() {
    if (!active) return;
    const song = snapshot?.player?.current;
    root.querySelector('#lyrics-title').textContent = song?.name || '随音乐一起';
    root.querySelector('#lyrics-meta').textContent = song ? `${snapshot.bot?.name || '当前机器人'} · ${song.artists || ''} · ${sourceName(song.source)}` : '选择机器人，查看当前歌曲的歌词。';
    root.querySelector('#lyrics-notice').textContent = content;
    root.querySelector('#lyrics-translation').hidden = !lines.some((line) => line.translation);
    list.innerHTML = lines.map((line, index) => `<div class="lyric-line" data-lyric-index="${index}"><p>${escape(line.text)}</p>${translation && line.translation ? `<span>${escape(line.translation)}</span>` : ''}</div>`).join('');
    current = -1; tick(); centerCurrent(false); drawIcons();
  }
  function tick() {
    if (!active || !snapshot) return;
    const p = snapshot.player;
    // Only extrapolate briefly; stale state must not pretend audio kept playing.
    const delta = p.status === 'playing' ? Math.min(5, Math.max(0, performance.now() - receivedAt) / 1000) : 0;
    const seconds = Math.max(0, Number(p.seconds) || 0) + delta;
    let index = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].time <= seconds) index = i; else break; }
    if (index === current) return;
    const previous = list.querySelector('.current');
    previous?.classList.remove('current'); previous?.removeAttribute('aria-current'); current = index;
    const line = list.querySelector(`[data-lyric-index="${index}"]`);
    if (line) { line.classList.add('current'); line.setAttribute('aria-current', 'true'); }
    centerCurrent();
  }
  async function load() {
    if (!active || !snapshot?.player?.current || loaded) return;
    const song = snapshot.player.current, captured = key, request = ++generation;
    loaded = true; content = '正在读取歌词…'; root.querySelector('#lyrics-retry').hidden = true; render();
    try {
      const data = await api(`/lyrics?${new URLSearchParams({ source: normalizeSource(song.source), id: song.source === 'qq' ? song.mid || song.id : song.id })}`);
      if (request !== generation || captured !== key) return;
      lines = (data.lines || []).filter((line) => Number.isFinite(line.time)).sort((a, b) => a.time - b.time);
      content = data.notice || (lines.length ? '歌词跟随当前机器人的播放进度。' : data.plain || '这首歌暂无歌词，或是纯音乐。');
      render();
    } catch (error) {
      if (request !== generation || captured !== key) return;
      content = error.message || '歌词读取失败，请稍后重试。'; lines = []; render(); root.querySelector('#lyrics-retry').hidden = false;
    }
  }
  function update(value) {
    snapshot = value; receivedAt = performance.now(); const song = value.player.current;
    const next = `${value.botId}:${song?.source || 'netease'}:${song?.mid || song?.id || ''}`;
    if (next !== key) { key = next; generation++; lines = []; loaded = false; content = song ? '正在读取歌词…' : '请先播放一首歌曲。'; root.querySelector('#lyrics-retry').hidden = true; render(); void load(); }
    tick();
  }
  function setImmersive(value) {
    immersive = value; document.body.classList.toggle('lyrics-immersive', value);
    const button = root.querySelector('#lyrics-immerse'); button.setAttribute('aria-pressed', String(value));
    button.innerHTML = `<i data-lucide="${value ? 'minimize' : 'expand'}"></i>${value ? '退出沉浸' : '沉浸歌词'}`; centerCurrent(false); revealPanel(); drawIcons();
  }
  root.querySelector('#lyrics-translation').onclick = (event) => { translation = !translation; event.currentTarget.setAttribute('aria-pressed', String(translation)); render(); };
  root.querySelector('#lyrics-retry').onclick = () => { loaded = false; void load(); };
  root.querySelector('#lyrics-immerse').onclick = () => setImmersive(!immersive);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && immersive) setImmersive(false); });
  return { update, setActive(value) { const entering = value && !active; active = value; clearInterval(timer); if (value) { render(); void load(); timer = setInterval(tick, 250); if (entering) revealPanel(); } else setImmersive(false); } };
}
