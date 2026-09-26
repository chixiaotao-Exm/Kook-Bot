const MAX_QUERY = 80;
const MAX_PAGE = 2000;
const MAX_PER_PAGE = 8;
const MAX_REPLY = 1899;
const HELP = '发送「搜索鱼」或「搜索 鸡肉」查看菜单里的相关菜品，也可搜索西班牙语名称。\n翻页示例：搜索鱼 第2页。';

function normalize(value) {
  return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, '');
}

function parseRequest(input) {
  if (typeof input !== 'string') return null;
  let text = input.normalize('NFKC').trim().replace(/[?？!！。]+$/u, '').trim();
  text = text.replace(/^(?:请(?:帮我|帮我们)?|帮我|帮我们|麻烦(?:你)?(?:帮我|帮我们)?)\s*/u, '');
  let page = 1, pageError = false;
  const pageSuffix = text.match(/\s*第([^\s]{1,30})页$/u);
  if (pageSuffix) {
    page = /^\d{1,4}$/u.test(pageSuffix[1]) ? Number(pageSuffix[1]) : 0;
    pageError = page < 1 || page > MAX_PAGE;
    text = text.slice(0, pageSuffix.index).trim();
  }
  let match = text.match(/^(?:搜索|查找|查询菜品|查菜|查一下|搜一下|搜一搜|搜搜|搜)(?:一下)?\s*[:：]?\s*([\s\S]*)$/u);
  if (match) return { query: match[1].trim(), page, pageError, explicit: true };
  match = text.match(/^(?:有哪些|有什么)\s*(.+)$/u)
    ?? text.match(/^(.+?)\s*有哪些$/u);
  if (match) {
    const foodContext = /(?:类?菜品|类?菜肴|的菜)$/u.test(match[1]);
    return { query: match[1].replace(/(?:类?菜品|类?菜肴|的菜)$/u, '').trim(), page, pageError, explicit: foodContext };
  }
  match = text.match(/^(.+?)类?菜品$/u);
  return match ? { query: match[1].trim(), page, pageError, explicit: true } : null;
}

function row(item, index) {
  const price = item.priceCents === null ? '未标价，需向餐厅确认' : `$${(item.priceCents / 100).toFixed(2)} USD`;
  const uncertainty = item.uncertain ? ' · 原文不确定，待核对' : '';
  return `${index + 1}. ${item.name} [${item.key}]\n${item.spanish}\n${item.group} · 单价：${price}${uncertainty}`;
}

function header(query, total, page, pageCount) {
  return `菜单搜索：${query}\n按名称匹配 · 共 ${total} 项 · 第 ${page}/${pageCount} 页\n\n`;
}

function footer(query, nextPage) {
  return `\n\n以上为菜单美元单价，仅供选菜。${nextPage ? `\n查看下一页：搜索${query} 第${nextPage}页` : ''}`;
}

/** Deterministic read-only menu lookup. Catalog has already been validated by createWaiter. */
export function createMenuSearch(items) {
  const indexed = items.map(item => ({ item, names: [item.name, ...(item.aliases ?? []), item.spanish].map(normalize) }));
  return function search(input) {
    const request = parseRequest(input);
    if (!request) return null;
    const { query, page, pageError, explicit } = request;
    const empty = text => ({ text, query, total: 0, page: 1, pageCount: 0, items: [] });
    if (!query) return empty(HELP);
    if (query.length > MAX_QUERY || /[\u0000-\u001f\u007f]/u.test(query)) {
      return empty(`搜索关键词请控制在 ${MAX_QUERY} 字以内，且不要换行。\n${HELP}`);
    }
    const keyword = normalize(query);
    if (!keyword) return empty(HELP);
    const matches = indexed.filter(({ names }) => names.some(name => name.includes(keyword))).map(({ item }) => item);
    // Keep all literal matches; surface fish dishes before squid for the broad 鱼 query.
    if (keyword === '鱼') matches.sort((left, right) => Number(left.name.includes('鱿鱼')) - Number(right.name.includes('鱿鱼')));
    // Natural questions without a food context should stay with the waiter/AI.
    // Explicit search commands still get a deterministic not-found response.
    if (!explicit && !matches.length) return null;
    if (pageError) return empty(`页码需为 1 到 ${MAX_PAGE} 的整数。\n${HELP}`);
    if (!matches.length) return empty(`菜单中没有找到「${query}」。试试较短的菜名、食材或西班牙语名称。\n${HELP}`);

    // Reserve the largest possible header/footer before splitting, so every page
    // has complete entries and subsequent page requests never repeat or skip one.
    const overhead = header(query, matches.length, MAX_PAGE, MAX_PAGE).length + footer(query, MAX_PAGE + 1).length;
    const pages = [];
    let current = [], length = 0;
    for (const [index, item] of matches.entries()) {
      const text = row(item, index);
      if (current.length && (current.length >= MAX_PER_PAGE || length + 2 + text.length + overhead > MAX_REPLY)) {
        pages.push(current); current = []; length = 0;
      }
      current.push({ item, text });
      length += (current.length > 1 ? 2 : 0) + text.length;
    }
    if (current.length) pages.push(current);
    if (page > pages.length) {
      return { text: `「${query}」共 ${matches.length} 项，只有 ${pages.length} 页。请发送「搜索${query} 第${pages.length}页」或从第1页查看。`,
        query, total: matches.length, page, pageCount: pages.length, items: [] };
    }
    const selected = pages[page - 1];
    return { text: header(query, matches.length, page, pages.length) + selected.map(entry => entry.text).join('\n\n')
        + footer(query, page < pages.length ? page + 1 : null),
      query, total: matches.length, page, pageCount: pages.length, items: selected.map(entry => entry.item) };
  };
}
