// Organization metadata never changes page identity, HTML or requirement links.
export function pageOrganization(page) {
  const [family, ...states] = page.name.split(/\s*·\s*/);
  const platform = page.platform || (/^(mobile-|mini-)/.test(page.id) || /^运营端/.test(family) ? '运营端' : page.width <= 600 ? '移动端' : 'Web 后台');
  const group = page.group || family.replace(/^运营端[\s·-]*/, '') || page.name;
  return { platform, group, key: JSON.stringify([platform, group]), label: states.join(' · ') || page.name };
}
export function pageGroups(pages) {
  const groups = new Map();
  for (const page of pages) {
    const meta = pageOrganization(page);
    if (!groups.has(meta.key)) groups.set(meta.key, { ...meta, pages: [] });
    groups.get(meta.key).pages.push(page);
  }
  return [...groups.values()];
}
export function bounds(pages, padding = 0) {
  if (!pages.length) return null;
  const x = Math.min(...pages.map(p => p.x)) - padding, y = Math.min(...pages.map(p => p.y)) - padding;
  const right = Math.max(...pages.map(p => p.x + p.width)) + padding, bottom = Math.max(...pages.map(p => p.y + p.height)) + padding;
  return { x, y, width: right - x, height: bottom - y, right, bottom };
}
export function intersects(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
export function movePages(pages, dx, dy) {
  // Clamp the shared delta, not individual pages, so spacing remains unchanged.
  dx = Math.max(...pages.map(p => -100000 - p.x), Math.min(dx, ...pages.map(p => 100000 - p.x)));
  dy = Math.max(...pages.map(p => -100000 - p.y), Math.min(dy, ...pages.map(p => 100000 - p.y)));
  for (const p of pages) { p.x = Math.round(p.x + dx); p.y = Math.round(p.y + dy); }
}
export function organizePages(pages, action) {
  const box = bounds(pages); if (!box || pages.length < 2) return;
  if (action === 'tidy') {
    let y = box.y;
    const columns = Math.min(4, Math.ceil(Math.sqrt(pages.length)));
    for (let i = 0; i < pages.length; i += columns) {
      let x = box.x; const row = pages.slice(i, i + columns);
      for (const p of row) { p.x = x; p.y = y; x += p.width + 100; }
      y += Math.max(...row.map(p => p.height)) + 120;
    }
  } else if (action.startsWith('distribute')) {
    if (pages.length < 3) return;
    const horizontal = action === 'distributeX', pos = horizontal ? 'x' : 'y', dim = horizontal ? 'width' : 'height';
    const sorted = pages.slice().sort((a,b) => a[pos] - b[pos]);
    const first = sorted[0][pos], last = sorted.at(-1)[pos] + sorted.at(-1)[dim];
    const gap = (last - first - sorted.reduce((s,p) => s + p[dim], 0)) / (pages.length - 1);
    let cursor = first;
    for (const p of sorted) { p[pos] = Math.round(cursor); cursor += p[dim] + gap; }
  } else for (const p of pages) {
    if (action === 'left') p.x = box.x;
    if (action === 'centerX') p.x = Math.round(box.x + (box.width - p.width) / 2);
    if (action === 'right') p.x = box.right - p.width;
    if (action === 'top') p.y = box.y;
    if (action === 'centerY') p.y = Math.round(box.y + (box.height - p.height) / 2);
    if (action === 'bottom') p.y = box.bottom - p.height;
  }
  if (pages.some(p => Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000)) throw new RangeError('排布超出画布范围，请先移到画布中央');
}
export function snapDelta(moving, others, dx, dy, tolerance, { previous = [], maxDistance = Infinity } = {}) {
  const box = bounds(moving); if (!box) return { dx, dy, guides: [] };
  // Page coordinates are integers. Do not advertise half-pixel alignments that
  // movePages would immediately round away.
  const result = { dx: Math.round(dx), dy: Math.round(dy), guides: [] }, matches = [];
  for (const [pos, dim, delta] of [['x','width','dx'], ['y','height','dy']]) {
    const cross = pos === 'x' ? 'y' : 'x', size = pos === 'x' ? 'height' : 'width', offset = pos === 'x' ? dy : dx;
    const origins = [box[pos], box[pos] + box[dim] / 2, box[pos] + box[dim]], candidates = [];
    for (const p of others) {
      const gap = Math.max(p[cross] - (box[cross] + offset + box[size]), box[cross] + offset - (p[cross] + p[size]), 0);
      if (gap > maxDistance) continue;
      const proximity = Math.abs(p[cross] + p[size] / 2 - (box[cross] + offset + box[size] / 2));
      for (const at of [p[pos], p[pos] + p[dim] / 2, p[pos] + p[dim]]) origins.forEach((origin, originIndex) => {
        const snapped = at - origin;
        if (!Number.isInteger(snapped)) return;
        const distance = Math.abs(snapped - (pos === 'x' ? dx : dy));
        const held = previous.some(g => g.axis === pos && g.at === at && g.targetId === p.id && g.originIndex === originIndex);
        if (distance <= tolerance * (held ? 1.5 : 1)) candidates.push({ axis:pos, at, targetId:p.id, originIndex, snapped, distance, proximity, held, page:p });
      });
    }
    candidates.sort((a,b) => Number(b.held)-Number(a.held) || a.distance-b.distance || a.proximity-b.proximity || String(a.targetId).localeCompare(String(b.targetId)) || a.originIndex-b.originIndex || a.at-b.at);
    const match = candidates[0];
    if (match) { result[delta] = match.snapped; matches.push(match); }
  }
  for (const {axis,at,targetId,originIndex,page} of matches) {
    const cross = axis === 'x' ? 'y' : 'x', dim = axis === 'x' ? 'height' : 'width', offset = axis === 'x' ? result.dy : result.dx;
    result.guides.push({axis,at,targetId,originIndex,from:Math.min(box[cross]+offset,page[cross]),to:Math.max(box[cross]+offset+box[dim],page[cross]+page[dim])});
  }
  return result;
}
export function zoomAt(view, scale, x, y) {
  scale = Math.max(.0001,Math.min(4,scale));
  return {scale,x:x-(x-view.x)*scale/view.scale,y:y-(y-view.y)*scale/view.scale};
}
export function canvasWheel({deltaX=0,deltaY=0,deltaMode=0,shiftKey=false,ctrlKey=false,metaKey=false}, height) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  let dx = deltaX * unit, dy = deltaY * unit;
  const zoom = ctrlKey || metaKey;
  if (shiftKey && !zoom && !dx) { dx = dy; dy = 0; }
  return {dx,dy,zoom,factor:Math.exp(-Math.max(-200,Math.min(200,dy)) * .002)};
}
export function reorderPages(pages, ids, targetId, organization = null) {
  const chosen = new Set(ids), moving = pages.filter(p => chosen.has(p.id));
  if (!moving.length || chosen.has(targetId)) return pages;
  const rest = pages.filter(p => !chosen.has(p.id));
  const index = rest.findIndex(p => p.id === targetId);
  if (index < 0) return pages;
  if (organization) for (const p of moving) { p.platform = organization.platform; p.group = organization.group; }
  rest.splice(index, 0, ...moving); return rest;
}
