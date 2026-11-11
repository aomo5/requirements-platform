export const clone = (value) => JSON.parse(JSON.stringify(value));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Page records are flat; immutable HTML strings are shared between snapshots.
export const copyPages = (pages) => pages.map((page) => ({ ...page }));
export const samePages = (left, right) => left.length === right.length && left.every((page, index) => {
  const other = right[index];
  return Object.keys(page).length === Object.keys(other).length && Object.keys(page).every((key) => page[key] === other[key]);
});
export function createEditHistory(pages = [], limit = 30, budget = 8000000) {
  let current = copyPages(pages), past = [], future = [];
  const weight = (entries) => { const html = new Set(entries.flatMap(entry => entry.map(page => page.html || ""))); return entries.reduce((sum, entry) => sum + entry.length * 256, 0) + [...html].reduce((sum, value) => sum + value.length * 2, 0); };
  function trim() {
    while (past.length > 1 && (past.length > limit || weight(past) > budget)) past.shift();
  }
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    record(next) {
      if (samePages(current, next)) return false;
      past.push(current); current = copyPages(next); future = []; trim(); return true;
    },
    undo() { if (!past.length) return null; future.push(current); current = past.pop(); return copyPages(current); },
    redo() { if (!future.length) return null; past.push(current); current = future.pop(); trim(); return copyPages(current); },
  };
}
export function createPageId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Plain HTTP on a LAN is not a secure context; getRandomValues remains available.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `page_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function uniquePageName(pages, base = "新页面") {
  base = base.trim().slice(0, 100) || "新页面";
  const names = new Set(pages.map((page) => page.name));
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) {
    const suffix = ` ${index}`, name = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    if (!names.has(name)) return name;
  }
}
export function nextPagePosition(pages, width, height, anchor = pages.at(-1)) {
  if (!pages.length) return { x: 0, y: 0 };
  const free = (x, y) => Math.abs(x) <= 100000 && Math.abs(y) <= 100000
    && pages.every((page) => x + width + 40 <= page.x || page.x + page.width + 40 <= x || y + height + 40 <= page.y || page.y + page.height + 40 <= y);
  const right = anchor.x + anchor.width + 100;
  for (let index = 0; index <= pages.length; index++) {
    const x = right + index * (width + 100), y = anchor.y;
    if (free(x, y)) return { x, y };
  }
  for (let index = 0; index <= pages.length; index++) {
    const x = anchor.x, y = anchor.y + anchor.height + 100 + index * (height + 100);
    if (free(x, y)) return { x, y };
  }
  // A bounded grid also handles boards positioned at the coordinate limits.
  for (let index = 0; ; index++) {
    const x = -100000 + (index % 50) * (width + 100), y = -100000 + Math.floor(index / 50) * (height + 100);
    if (free(x, y)) return { x, y };
  }
}
export function arrangePages(pages, columns = 3) {
  let y = 0;
  for (let index = 0; index < pages.length; index += columns) {
    const row = pages.slice(index, index + columns); let x = 0;
    for (const page of row) { page.x = x; page.y = y; x += page.width + 100; }
    y += Math.max(...row.map((page) => page.height)) + 100;
  }
  return pages;
}
export function fitPages(pages, width, height) {
  if (!pages.length) return { x: 50, y: 100, scale: .7 };
  const left = Math.min(...pages.map((page) => page.x));
  const top = Math.min(...pages.map((page) => page.y - 80));
  const right = Math.max(...pages.map((page) => page.x + page.width));
  const bottom = Math.max(...pages.map((page) => page.y + page.height));
  const scale = clamp(Math.min(Math.max(1, width - 80) / (right - left), Math.max(1, height - 160) / (bottom - top)), .0001, 1);
  return { scale, x: (width - (right - left) * scale) / 2 - left * scale,
    y: 48 + (height - 160 - (bottom - top) * scale) / 2 - top * scale };
}
export function blankHtml(name) {
  const safe = name.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${safe}</title>\n<style>\n* { box-sizing: border-box; }\nbody { margin: 0; background: #fff; color: #1e293b; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }\n</style>\n</head>\n<body></body>\n</html>`;
}
