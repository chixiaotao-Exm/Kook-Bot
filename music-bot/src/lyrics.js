const MAX_LYRIC = 128 * 1024;
const STAMP = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function clean(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos);/g,
    (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name])
    .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/gi, (all, code) => {
      const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
    }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1000);
}

/** LRC offsets advance lyrics when positive; returned times are media seconds. */
export function parseLrc(value) {
  const raw = typeof value === 'string' ? value.slice(0, MAX_LYRIC) : '';
  const offsets = [...raw.matchAll(/^\s*\[offset:([+-]?\d{1,7})\]\s*$/gmi)];
  const offset = Number(offsets.at(-1)?.[1] || 0) / 1000;
  const timed = new Map(), plain = [];
  for (const row of raw.split(/\r?\n/).slice(0, 4000)) {
    if (/^\s*\[(?:ar|al|ti|au|by|re|ve|length|offset):[^\]]*\]\s*$/i.test(row)) continue;
    const stamps = [...row.matchAll(STAMP)], text = clean(row.replace(STAMP, ''));
    if (!text) continue;
    if (!stamps.length) { if (!/^\s*\[\d+:/.test(row)) plain.push(text); continue; }
    for (const stamp of stamps) {
      const hours = Number(stamp[1] || 0), minutes = Number(stamp[2]), seconds = Number(stamp[3]);
      if (seconds >= 60 || (stamp[1] && minutes >= 60)) continue;
      const millis = Number((stamp[4] || '').padEnd(3, '0'));
      const time = Math.round(Math.max(0, hours * 3600 + minutes * 60 + seconds + millis / 1000 - offset) * 1000);
      if (time > 24 * 3600 * 1000) continue;
      if (!timed.has(time)) timed.set(time, []);
      if (!timed.get(time).includes(text)) timed.get(time).push(text);
    }
  }
  return { lines: [...timed].sort(([a], [b]) => a - b).map(([time, text]) => ({ time: time / 1000, text: text.join('\n').slice(0, 2000) })),
    plain: plain.join('\n').slice(0, 16000) };
}

export function normalizeLyrics(raw = {}) {
  const original = parseLrc(raw.lyric), translated = parseLrc(raw.translation || raw.trans);
  const translation = new Map(translated.lines.map((line) => [Math.round(line.time * 1000), line.text]));
  const lines = original.lines.map((line) => {
    const text = translation.get(Math.round(line.time * 1000));
    return text && text !== line.text ? { ...line, translation: text } : line;
  });
  const available = Boolean(lines.length || original.plain);
  return { lines, ...(original.plain ? { plain: original.plain } : {}), available,
    ...(!available ? { notice: raw.notice || '这首歌暂未提供歌词，可能是纯音乐。' } : {}) };
}
