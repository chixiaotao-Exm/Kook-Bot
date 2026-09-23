/** Preserve the catalog item's kind when handing it to the room's link preview. */
export function musicRoomLink({ origin, botId, input, source = 'netease', kind = 'song' }) {
  const room = new URL(`/room/${encodeURIComponent(botId)}`, origin);
  if (!input) return room.href;
  let query = String(input);
  if (source === 'qq' && /^(?:[1-9]\d{0,18}|[A-Za-z0-9]{14}|top:[1-9]\d{0,5})$/.test(query)) {
    const chart = query.startsWith('top:');
    const route = chart ? 'toplist' : kind === 'playlist' ? 'playlist' : 'songDetail';
    query = `https://y.qq.com/n/ryqq/${route}/${chart ? query.slice(4) : query}`;
  } else if (source === 'netease' && /^[1-9]\d{0,17}$/.test(query)) {
    query = `https://music.163.com/${kind === 'playlist' ? 'playlist' : 'song'}?id=${query}`;
  }
  room.searchParams.set('q', query); room.searchParams.set('source', source);
  return room.href;
}
