// Text layout never changes the source label or saved node dimensions.
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const graphemes = value => [...segmenter.segment(value)].map(item => item.segment);
const closing = /^[，。！？；：、）》」』】〕〉…,.!?;:%）]/u;
const opening = /[（《「『【〔〈(]$/u;
const word = char => /^[\p{L}\p{N}_-]+$/u.test(char) && !/\p{Script=Han}/u.test(char);
let context, family;
const widths = new Map();
export function measureText(text, size) {
  if (typeof document !== 'undefined' && !context) {
    context = document.createElement('canvas').getContext('2d');
    family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif';
  }
  const key = `${size}:${text}`;
  if (!widths.has(key)) {
    if (context) context.font = `400 ${size}px ${family}`;
    const width = context ? context.measureText(text).width : graphemes(text).reduce((sum, c) => sum + size * (/^[\x00-\xff]+$/.test(c) ? .56 : 1), 0);
    if (widths.size > 2000) widths.clear();
    widths.set(key, width);
  }
  return widths.get(key);
}

export function wrapText(value, lineWidths, fontSize, measure = measureText) {
  const lines = [], paragraphs = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  let truncated = false;
  for (let p = 0; p < paragraphs.length; p++) {
    let remaining = graphemes(paragraphs[p]);
    do {
      if (lines.length === lineWidths.length) { truncated = true; break; }
      const width = lineWidths[lines.length];
      let end = 0;
      while (end < remaining.length && measure(remaining.slice(0, end + 1).join(''), fontSize) <= width) end++;
      if (remaining.length && !end) { end = 1; truncated = true; }
      if (end < remaining.length && end > 1) {
        let boundary = end;
        if (word(remaining[end - 1]) && word(remaining[end])) {
          while (boundary > 0 && word(remaining[boundary - 1])) boundary--;
          if (boundary > 0) end = boundary;
        }
        while (end > 1 && (closing.test(remaining[end]) || opening.test(remaining[end - 1]))) end--;
      }
      lines.push(remaining.slice(0, end).join('').trimEnd());
      remaining = remaining.slice(end);
      // Spaces at a soft wrap are separators; explicit line breaks are retained.
      while (remaining[0] === ' ') remaining.shift();
    } while (remaining.length);
    if (truncated || lines.length === lineWidths.length && (remaining.length || p < paragraphs.length - 1)) { truncated = true; break; }
  }
  if (truncated && lines.length) {
    let last = graphemes(lines.at(-1));
    while (last.length && measure(last.join('') + '…', fontSize) > lineWidths[lines.length - 1]) last.pop();
    lines[lines.length - 1] = last.join('').trimEnd() + '…';
  }
  return { lines, truncated };
}

export function nodeTextLayout(node, { w, h }, measure = measureText) {
  const fontSize = 13, lineHeight = 18, diamond = node.type === 'decision', pill = ['start', 'end'].includes(node.type);
  const maxLines = pill ? (node.pageId ? 1 : 2) : (node.pageId ? 2 : 3);
  const cy = h / 2 - (node.pageId ? 9 : 0) - (['event','end','gateway','call','return'].includes(node.type) && h >= 68 ? 10 : 0);
  let layout;
  for (let count = 1; count <= maxLines; count++) {
    const ys = Array.from({ length: count }, (_, i) => cy + (i - (count - 1) / 2) * lineHeight);
    const lineWidths = ys.map(y => diamond ? w * (1 - (Math.abs(y - h / 2) + fontSize / 2) / (h / 2)) - 20 : w - (pill || ['output','input','gateway'].includes(node.type) ? 40 : 28));
    layout = { ...wrapText(node.label, lineWidths, fontSize, measure), ys, lineWidths, fontSize, lineHeight, pageY: h - (diamond ? 24 : ['event','end','gateway','call','return'].includes(node.type) && h >= 68 ? 27 : 11) };
    if (!layout.truncated) break;
  }
  // Balance centered captions, avoiding a lone final character. Hard breaks
  // remain paragraph boundaries; overflowing captions retain maximum capacity.
  if (!layout.truncated && layout.lines.length > 1) {
    let low = 0, high = 1;
    for (let i = 0; i < 10; i++) {
      const ratio = (low + high) / 2;
      const candidate = wrapText(node.label, layout.lineWidths.map(width => width * ratio), fontSize, measure);
      if (!candidate.truncated) { high = ratio; layout.lines = candidate.lines; } else low = ratio;
    }
  }
  return layout;
}

export function edgeTextLayout(label, measure = measureText) {
  const fontSize = 12, lineHeight = 16;
  const result = wrapText(label, [180, 180, 180], fontSize, measure);
  return { ...result, fontSize, lineHeight, width: Math.ceil(Math.max(0, ...result.lines.map(line => measure(line, fontSize)))) + 16, height: result.lines.length * lineHeight + 8 };
}

// Keep direction visible at useful zoom levels without oversized overview arrows.
export function arrowSize(scale = 1) { return Math.min(16, 10 / scale, 8 / Math.sqrt(scale)); }
