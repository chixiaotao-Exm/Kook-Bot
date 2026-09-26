const MAX_INPUT = 1200;
const MAX_ITEMS = 12;
const MAX_QUANTITY = 99;
const MAX_REPLY = 1900;
const GROUPS = new Set(['菜单一', '菜单二', '饮品', '套餐']);
const COUNT = '[+-]?(?:\\d+(?:[./]\\d+)?|[零〇一二两三四五六七八九十百半]+)';
const UNIT = '(?:份|个|盘|碗|瓶|杯|听|罐|套)';
const AFTER_COUNT = new RegExp(`^(.*?)(?:[x×*]\\s*)?(${COUNT})\\s*(${UNIT})?$`, 'iu');
const BEFORE_COUNT = new RegExp(`^(${COUNT})\\s*(${UNIT})?\\s*(.+)$`, 'u');
const ORDER_PREFIX = /^(?:请(?:给我|帮我|来)?|帮我(?:点|来)?|我想(?:要|点)|我要|点餐|点菜|来一?下|来|要)\s*[:：]?\s*/u;
const ADVICE_INTENT = /推荐|建议|哪个好|怎么选|有什么|适合|吃什么|多少钱|什么价格|贵不贵|过敏|辣不辣|能不能|可以吗|吗[?？]?$/u;
const PRICE_SUFFIX = /(?:多少钱(?:一份)?|多少美元|什么价格|价格(?:是多少)?|价钱(?:是多少)?|怎么卖)[?？。!！\s]*$/u;

function priceQueryName(text) {
  return PRICE_SUFFIX.test(text)
    ? text.replace(PRICE_SUFFIX, '').replace(/^(?:请问|问一下|问下|查一下|查询)\s*/u, '').trim()
    : text;
}

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, '').trim();
}

function quantity(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY ? value : null;
  const text = String(value).trim();
  if (/^\d{1,2}$/u.test(text)) return quantity(Number(text));
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (Object.hasOwn(digits, text)) return digits[text];
  const tens = text.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : null;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function shown(value, max = 55) {
  // User text is a label, never KOOK markup or a control instruction.
  const safe = String(value).replace(/[\r\n\t]/gu, ' ').replace(/[\\`*_<>\[\]@]/gu, '').trim();
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

function copyItem(item) {
  return {
    key: item.key, group: item.group, code: item.code, name: item.name,
    spanish: item.spanish, priceCents: item.priceCents, aliases: [...item.aliases],
    uncertain: item.uncertain, ...(item.note ? { note: item.note } : {}),
  };
}

function invalidResult(message) {
  return { complete: false, currency: 'USD', items: [], issues: [{ type: 'limit', message }], totalCents: 0, text: message };
}

export function createWaiter(catalog) {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 2000) throw new Error('Invalid waiter catalog');
  const byKey = new Map();
  const byName = new Map();
  for (const original of catalog) {
    if (!original || typeof original !== 'object' || typeof original.key !== 'string'
      || !/^(?:m[12]|drink|combo):[1-9]\d{0,2}[a-c]?$/iu.test(original.key)
      || byKey.has(original.key) || !GROUPS.has(original.group)
      || typeof original.code !== 'string' || !/^(?:[1-9]\d{0,2}[a-c]?|[a-z][a-z0-9_-]{0,15})$/iu.test(original.code)
      || typeof original.name !== 'string' || !original.name.trim() || original.name.length > 120
      || typeof original.spanish !== 'string' || !original.spanish.trim() || original.spanish.length > 400
      || (original.priceCents !== null && (!Number.isSafeInteger(original.priceCents) || original.priceCents < 0 || original.priceCents > 100000000))
      || (original.aliases !== undefined && (!Array.isArray(original.aliases) || original.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 120)))) {
      throw new Error('Invalid waiter catalog item');
    }
    const item = { ...original, aliases: [...(original.aliases ?? [])], uncertain: original.uncertain === true };
    byKey.set(item.key, item);
    const names = [item.key, `${item.group}${item.code}`, `${item.group}${item.code}号`];
    for (const name of [item.name, ...item.aliases]) names.push(name, `${item.group}${name}`);
    for (const name of names) {
      const normalized = normalize(name);
      const matches = byName.get(normalized) ?? [];
      if (!matches.includes(item)) matches.push(item);
      byName.set(normalized, matches);
    }
  }

  function resolve(text) {
    return byName.get(normalize(text)) ?? [];
  }

  function parsedItem(text) {
    text = priceQueryName(text);
    const exact = resolve(text);
    if (exact.length) return { input: text, quantity: 1, candidates: exact };
    // Match the complete name first: digits in beverage sizes and dish numbers
    // are part of the name, and must never be mistaken for a quantity.
    const after = text.match(AFTER_COUNT);
    const before = text.match(BEFORE_COUNT);
    const possibilities = [];
    if (after && after[1].trim()) possibilities.push({ name: after[1].replace(/[x×*]\s*$/iu, '').trim(), count: after[2] });
    if (before && before[3].trim()) possibilities.push({ name: before[3].trim(), count: before[1] });
    for (const possibility of possibilities) {
      const candidates = resolve(possibility.name);
      if (candidates.length) return { input: text, quantity: quantity(possibility.count), candidates };
    }
    return { input: text, quantity: null, candidates: [] };
  }

  function segmentInput(input) {
    // Some original names contain commas, enumeration commas, or conjunctions.
    // Prefer the longest recognizable complete item before treating a character
    // as a boundary, so 牛肉、鸡肉、猪肉炒饭 remains one menu entry.
    const delimiters = [...input.matchAll(/(?:[\n,，、;；+＋]+|以及|还有|和)+/gu)]
      .map(match => ({ start: match.index, end: match.index + match[0].length }));
    const requests = [];
    let start = 0;
    while (start < input.length) {
      const remaining = delimiters.filter(delimiter => delimiter.start >= start);
      const cuts = [...remaining.map(delimiter => delimiter.start), input.length];
      let matched;
      for (let index = cuts.length - 1; index >= 0; index--) {
        const end = cuts[index];
        const text = input.slice(start, end).replace(ORDER_PREFIX, '').trim();
        if (!text) continue;
        const request = parsedItem(text);
        if (request.candidates.length) { matched = { request, end }; break; }
      }
      if (matched) {
        requests.push(matched.request);
        start = remaining.find(delimiter => delimiter.start === matched.end)?.end ?? input.length;
      } else {
        const next = remaining[0];
        const text = input.slice(start, next?.start ?? input.length).replace(ORDER_PREFIX, '').trim();
        if (text) requests.push(parsedItem(text));
        start = next?.end ?? input.length;
      }
      if (requests.length > MAX_ITEMS) break;
    }
    return requests;
  }

  function finish(requests, preliminaryIssues = []) {
    const issues = [...preliminaryIssues];
    const items = [];
    let totalCents = 0;
    for (const request of requests) {
      const label = shown(request.input);
      if (!request.candidates.length) {
        issues.push({ type: 'unknown', input: request.input, message: `未找到「${label}」，请核对菜名或使用菜单编号。` });
        continue;
      }
      if (request.quantity === null) {
        issues.push({ type: 'quantity', input: request.input, message: `「${label}」数量需为 1～${MAX_QUANTITY} 的整数；半份或自定义分量需另行确认。` });
        continue;
      }
      if (request.candidates.length > 1) {
        const candidates = request.candidates.map(copyItem);
        const choices = candidates.slice(0, 4).map(item => `${item.key} ${item.name}（${item.priceCents === null ? '未标价' : money(item.priceCents)}）`);
        issues.push({ type: 'ambiguous', input: request.input, candidates, message: `「${label}」有多个项目，请指定：${choices.join('；')}${candidates.length > 4 ? '；另有其他项目，请带上菜单及编号' : ''}。` });
        continue;
      }
      const selected = request.candidates[0];
      const lineCents = selected.priceCents === null || selected.uncertain ? null : selected.priceCents * request.quantity;
      const item = { ...copyItem(selected), quantity: request.quantity, lineCents };
      items.push(item);
      if (lineCents !== null) totalCents += lineCents;
      if (selected.uncertain) issues.push({ type: 'uncertain', input: request.input, key: selected.key, message: `「${shown(selected.name)}」原菜单信息待确认，暂不计入金额。` });
      else if (selected.priceCents === null) issues.push({ type: 'unpriced', input: request.input, key: selected.key, message: `「${shown(selected.name)}」原菜单未标价，暂不计入金额。` });
    }
    const complete = issues.length === 0 && items.length > 0;
    const lines = ['点餐核对 · 美元 USD'];
    for (const item of items) {
      lines.push(`${item.group} ${item.code}｜${item.name} × ${item.quantity}`);
      lines.push(item.spanish);
      lines.push(item.lineCents === null
        ? `单价 ${item.priceCents === null ? '未标价' : money(item.priceCents)}｜金额待确认`
        : `${money(item.priceCents)} × ${item.quantity} = ${money(item.lineCents)}`);
    }
    if (issues.length) lines.push('待确认：', ...issues.map(issue => issue.message));
    lines.push(`${complete ? '合计' : '已知小计'}：${money(totalCents)}`);
    if (!complete) lines.push('待确认项目未计入；请补充完整菜名或菜单编号后重新发送。');
    const text = lines.join('\n');
    if (text.length > MAX_REPLY) return invalidResult('这份点餐明细较长，请分批发送，每次最多 6 项，便于核对西班牙语原名和金额。');
    return { complete, currency: 'USD', items, issues, totalCents, text };
  }

  function quote(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    if (text.length > MAX_INPUT) return invalidResult(`点餐内容过长，请控制在 ${MAX_INPUT} 字内，每次最多 ${MAX_ITEMS} 项。`);
    let input = priceQueryName(text.normalize('NFKC').trim());
    if (ADVICE_INTENT.test(input)) return null;
    const hasOrderPrefix = ORDER_PREFIX.test(input);
    input = input.replace(ORDER_PREFIX, '').replace(/(?:[,，\s]*(?:谢谢|麻烦了))[。.!！]?$/u, '').replace(/[。.!！]+$/u, '').trim();
    if (!input) return null;
    const requests = segmentInput(input);
    if (requests.length > MAX_ITEMS) return invalidResult(`每次最多核对 ${MAX_ITEMS} 项，请分批发送。`);
    if (!hasOrderPrefix && !requests.some(request => request.candidates.length) && !/^(?:m[12]:|drink:|combo:|菜单[一二]|饮品\d|套餐\d)/iu.test(input)) return null;
    return finish(requests);
  }

  function quoteItems(requested) {
    if (!Array.isArray(requested) || !requested.length || requested.length > MAX_ITEMS) {
      return invalidResult(`每次需提供 1～${MAX_ITEMS} 项菜品。`);
    }
    const requests = requested.map(request => {
      const key = request && typeof request.key === 'string' ? request.key : '';
      const found = byKey.get(key);
      return {
        input: key || '未指定菜品',
        quantity: typeof request?.quantity === 'number' ? quantity(request.quantity) : null,
        candidates: found ? [found] : [],
      };
    });
    return finish(requests);
  }

  function summaryForAI() {
    return [...byKey.values()].map(copyItem);
  }

  return Object.freeze({ quote, quoteItems, summaryForAI });
}
