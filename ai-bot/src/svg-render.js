import sharp from 'sharp';

sharp.cache({ memory: 16, files: 0, items: 16 });
sharp.concurrency(1);

const SVG_TAGS = new Set(('svg g path defs linearGradient radialGradient stop rect circle ellipse line polyline polygon '
  + 'text tspan textPath title desc clipPath mask pattern use symbol marker switch view style filter feGaussianBlur feDropShadow feOffset feBlend '
  + 'feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feFlood feMerge feMergeNode '
  + 'feMorphology feTurbulence feDisplacementMap feConvolveMatrix feDiffuseLighting feSpecularLighting '
  + 'feDistantLight fePointLight feSpotLight').split(' '));

// This deliberately recognizes a conservative subset of static SVG. Unknown or
// malformed markup remains downloadable source text; it is never run or rendered.
export function staticSvg(content) {
  if (typeof content !== 'string' || content.length > 256 * 1024) return null;
  const opens = [...content.matchAll(/<svg\b/g)], closes = [...content.matchAll(/<\/svg\s*>/g)];
  if (opens.length !== 1 || closes.length !== 1 || closes[0].index <= opens[0].index) return null;
  const svg = content.slice(opens[0].index, closes[0].index + closes[0][0].length);
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|image|animate\w*|set)\b/i.test(content)
    || /<\?/.test(svg) || /<style\b[^>]*>[\s\S]*?&[\s\S]*?<\/style>/i.test(svg)
    || /\s(?:on[\w:-]+|src|xml:base)\s*=|javascript\s*:|@import|@font-face|\\/i.test(svg)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(svg)) return null;
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2])) return null;
  }
  for (const match of svg.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^\s*(["']?)#[A-Za-z_][\w:.-]*\1\s*$/.test(match[1])) return null;
  }
  const stack = []; let cursor = 0;
  // Tokenize quoted attributes without interpreting XML entities or external resources.
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>/g;
  for (const match of svg.matchAll(tag)) {
    const between = svg.slice(cursor, match.index);
    if (between.includes('<') || between.includes(']]>')) return null;
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!--')) {
      if (match[0].slice(4, -3).includes('--')) return null;
      continue;
    }
    if (match[0].startsWith('<![CDATA[')) continue;
    const closing = /^<\//.test(match[0]), name = /^<\/?([\w:.-]+)/.exec(match[0])[1];
    if (!SVG_TAGS.has(name)) return null;
    if (closing) {
      if (!/^<\/[\w:.-]+\s*>$/.test(match[0]) || stack.pop() !== name) return null;
    } else {
      const attributes = match[0].slice(name.length + 1).replace(/\/?\s*>$/, '');
      let rest = attributes; const names = new Set();
      while (rest.trim()) {
        const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/.exec(rest);
        if (!attribute || names.has(attribute[1])) return null;
        names.add(attribute[1]);
        if (attribute[2].includes('&') || attribute[2].includes('<')) return null;
        if (attribute[1].startsWith('xmlns') && !((attribute[1] === 'xmlns'
          && attribute[2].slice(1, -1) === 'http://www.w3.org/2000/svg') || (attribute[1] === 'xmlns:xlink'
          && attribute[2].slice(1, -1) === 'http://www.w3.org/1999/xlink'))) return null;
        rest = rest.slice(attribute[0].length);
      }
      if (!/\/\s*>$/.test(match[0])) stack.push(name);
    }
    if (!stack.length && cursor !== svg.length) return null;
  }
  if (stack.length || cursor !== svg.length || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(svg)) return null;
  return svg;
}

export class SvgRenderError extends Error {
  constructor(code) { super(code); this.name = 'SvgRenderError'; this.code = code; }
}

/** Rasterizes only bounded, static SVG source. Never accepts paths or remote URLs. */
export async function renderSvgPng(svg, { sharpImpl = sharp, signal, timeoutMs = 10000 } = {}) {
  if (typeof svg !== 'string' || svg.length > 32000 || staticSvg(svg) !== svg
    || typeof sharpImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new SvgRenderError('SVG_INVALID_INPUT');
  }
  if (signal?.aborted) throw new SvgRenderError('SVG_ABORTED');
  let pipeline, timer, rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const abort = () => {
    try { pipeline?.destroy(); } catch {}
    rejectInterrupted(new SvgRenderError('SVG_ABORTED'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    pipeline = sharpImpl(Buffer.from(svg, 'utf8'), { density: 144, limitInputPixels: 16_000_000, failOn: 'error' })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true }).timeout({ seconds: 10 });
    timer = setTimeout(() => {
      try { pipeline.destroy(); } catch {}
      rejectInterrupted(new SvgRenderError('SVG_TIMEOUT'));
    }, timeoutMs);
    const { data, info } = await Promise.race([pipeline.toBuffer({ resolveWithObject: true }), interrupted]);
    if (!Buffer.isBuffer(data) || data.length > 4 * 1024 * 1024 || data.length < 24
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || !Number.isInteger(info?.width) || !Number.isInteger(info?.height)
      || info.width < 1 || info.height < 1 || info.width > 1600 || info.height > 1600) {
      throw new SvgRenderError('SVG_OUTPUT_LIMIT');
    }
    if (signal?.aborted) throw new SvgRenderError('SVG_ABORTED');
    return data;
  } catch (error) {
    if (error instanceof SvgRenderError) throw error;
    if (signal?.aborted) throw new SvgRenderError('SVG_ABORTED');
    throw new SvgRenderError('SVG_RENDER_FAILED');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
