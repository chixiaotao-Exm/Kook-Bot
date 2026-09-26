const MAX_INPUT = 800;
const MAX_ITEMS = 12;
const MAX_REPLY = 1900;
const NON_NAME_INTENT = /搜索|查找|查询|推荐|建议|多少钱|多少美元|价格|价钱|怎么卖|怎么选|有哪些|有什么|适合|过敏|辣不辣|计算|合计|总共|一共|[?？]|(?:m[12]|drink|combo|ice):\s*\d/iu;
const ORDER_INTENT = /^(?:请(?:给我|帮我|来)?|帮我|帮我们|给我|给我们|我想|我们想|我要|我们要|点餐|点菜|来|要)/u;
const QUANTITY = /\d|[零〇一二两三四五六七八九十百半]+\s*(?:份|个|盘|碗|瓶|杯|听|罐|套)|[x×*＋+−-]/iu;
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const spanishKey = value => value.normalize('NFC').toUpperCase().trim().replace(/\s+/gu, ' ');
const label = value => value.replace(/[\r\n\t]/gu, ' ').replace(/[\\`*_<>{}\[\]@]/gu, '').trim().slice(0, 70);
const limitResult = () => ({ text: '菜品较多，请分批发送，每次最多 12 项。', items: [], issues: [{ type: 'limit' }] });

/** Return only source Spanish names for a bare list of catalog dish names. */
export function createMenuTranslation(items) {
  const names = new Map();
  const addName = (name, item) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = normalize(name), matches = names.get(key) ?? [];
    if (!matches.some(candidate => candidate.key === item.key)) matches.push(item);
    names.set(key, matches);
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.key !== 'string' || typeof item.name !== 'string' || typeof item.spanish !== 'string' || !item.spanish.trim()) continue;
    for (const name of [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])]) addName(name, item);
    // This colloquial name is a routing alias, not a change to the source menu.
    if (item.key === 'm2:11') addName('薯条', item);
  }

  return function translate(input) {
    if (typeof input !== 'string' || input.length > MAX_INPUT || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(input)) return null;
    let text = input.normalize('NFKC').trim().replace(/[。!！]+$/u, '').trim();
    const prefix = text.match(/^(?:翻译(?:成西班牙语|成西语)?|西班牙语|西语)\s*[:：]?\s*/u);
    if (prefix) text = text.slice(prefix[0].length).trim();
    if (!text || NON_NAME_INTENT.test(text) || ORDER_INTENT.test(text)) return null;
    // Delimiters inside complete catalog names (including Gran Furama and
    // 牛肉、鸡肉、猪肉炒饭) are kept by matching the longest complete name first.
    const delimiters = [...text.matchAll(/(?:[\s,，、;；]+|以及|还有|和)+/gu)]
      .map(match => ({ start: match.index, end: match.index + match[0].length }));
    const requests = [];
    let start = 0;
    while (start < text.length && requests.length <= MAX_ITEMS) {
      const separators = delimiters.filter(delimiter => delimiter.start >= start);
      const leading = separators.find(delimiter => delimiter.start === start);
      if (leading) { start = leading.end; continue; }
      const cuts = [...separators.map(delimiter => delimiter.start), text.length];
      let matched;
      for (let index = cuts.length - 1; index >= 0; index--) {
        const end = cuts[index], candidates = names.get(normalize(text.slice(start, end)));
        if (candidates) { matched = { end, candidates }; break; }
      }
      const end = matched?.end ?? separators[0]?.start ?? text.length;
      requests.push({ input: text.slice(start, end).trim(), candidates: matched?.candidates ?? [] });
      start = separators.find(separator => separator.start === end)?.end ?? text.length;
    }
    if (!requests.length || (!prefix && !requests.some(request => request.candidates.length))) return null;
    // Numeric beverage sizes are recognized as part of full names above. Any
    // unresolved quantity must stay with the existing quote parser unchanged.
    if (requests.some(request => !request.candidates.length && (QUANTITY.test(request.input) || ORDER_INTENT.test(request.input)))) return null;
    if (requests.length > MAX_ITEMS) return limitResult();

    const lines = [], selected = [], issues = [];
    for (const request of requests) {
      if (!request.candidates.length) {
        issues.push({ type: 'unknown', input: request.input });
        lines.push(`未找到「${label(request.input)}」，请核对菜单菜名。`);
        continue;
      }
      const distinct = new Set(request.candidates.map(item => spanishKey(item.spanish)));
      if (distinct.size > 1 || request.candidates.some(item => item.uncertain)) {
        issues.push({ type: distinct.size > 1 ? 'ambiguous' : 'uncertain', input: request.input, candidates: request.candidates });
        lines.push(`「${label(request.input)}」${distinct.size > 1 ? '有多个原菜单名称' : '原文不确定'}，请确认：\n${request.candidates.map(item => `${item.key} · ${item.spanish}`).join('\n')}`);
      } else {
        selected.push(request.candidates[0]);
        lines.push(request.candidates[0].spanish);
      }
    }
    const result = lines.join('\n');
    return result.length > MAX_REPLY ? limitResult() : { text: result, items: selected, issues };
  };
}
