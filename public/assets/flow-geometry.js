import { edgeTextLayout } from './flow-text.js';

// Geometry is display-only: IDs, labels, page links and edge order stay intact.
export function dimensions(n) { return ['event','gateway'].includes(n.type) ? { w: 200, h: 86 } : n.type === 'end' ? { w: 180, h: 72 } : n.type === 'decision' ? { w: 180, h: 104 } : ['start', 'end'].includes(n.type) ? { w: 144, h: 48 } : { w: 200, h: 68 }; }
export function center(n) { const { w, h } = dimensions(n); return { x: n.x + w / 2, y: n.y + h / 2 }; }
export function nodeBox(n, padding = 0) { const { w, h } = dimensions(n); return { id: n.id, x: n.x - padding, y: n.y - padding, width: w + padding * 2, height: h + padding * 2 }; }

// Remove only DFS back edges from the layout calculation, never from the graph.
// Unlike indegree-only ranking, a retry loop cannot collapse the entire flow.
export function layoutNodes(nodes, edges, direction = 'TD') {
  const result = nodes.map(n => ({ ...n }));
  const byId = new Map(result.map(n => [n.id, n]));
  const outgoing = new Map(result.map(n => [n.id, []])), incoming = new Map(result.map(n => [n.id, []]));
  const neighbors = new Map(result.map(n => [n.id, []]));
  for (const e of edges) if (byId.has(e.source) && byId.has(e.target) && e.source !== e.target) {
    outgoing.get(e.source).push(e.target); neighbors.get(e.source).push(e.target); neighbors.get(e.target).push(e.source);
  }
  const color = new Map(), forward = new Map(result.map(n => [n.id, []]));
  function visit(id) {
    color.set(id, 1);
    for (const next of outgoing.get(id)) {
      if (color.get(next) === 1) continue;
      forward.get(id).push(next); incoming.get(next).push(id);
      if (!color.has(next)) visit(next);
    }
    color.set(id, 2);
  }
  const roots = result.filter(n => !edges.some(e => e.target === n.id && e.source !== n.id));
  for (const n of [...roots, ...result.filter(n => n.type === 'start'), ...result]) if (!color.has(n.id)) visit(n.id);
  const seen = new Set(), components = [];
  for (const n of result) if (!seen.has(n.id)) {
    const component = [], queue = [n.id]; seen.add(n.id);
    for (let i = 0; i < queue.length; i++) { const id = queue[i]; component.push(byId.get(id)); for (const next of neighbors.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
    components.push(component);
  }
  const horizontal = ['LR', 'RL'].includes(direction), reverse = ['BT', 'RL'].includes(direction);
  let crossOffset = 60;
  for (const component of components) {
    const degree = new Map(component.map(n => [n.id, incoming.get(n.id).length]));
    const queue = component.filter(n => !degree.get(n.id)).map(n => n.id), ranks = new Map(component.map(n => [n.id, 0]));
    for (let i = 0; i < queue.length; i++) for (const next of forward.get(queue[i])) {
      ranks.set(next, Math.max(ranks.get(next), ranks.get(queue[i]) + 1)); degree.set(next, degree.get(next) - 1); if (!degree.get(next)) queue.push(next);
    }
    const layers = Array.from({ length: Math.max(...ranks.values()) + 1 }, () => []);
    component.forEach(n => layers[ranks.get(n.id)].push(n));
    // Barycentric sweeps keep branches and merges close without unstable sorting.
    for (let sweep = 0; sweep < 4; sweep++) {
      const order = new Map(layers.flatMap(row => row.map((n, i) => [n.id, i])));
      for (const row of sweep % 2 ? [...layers].reverse() : layers) {
        const score = n => { const list = (sweep % 2 ? forward : incoming).get(n.id); return list.length ? list.reduce((sum, id) => sum + order.get(id), 0) / list.length : order.get(n.id); };
        row.sort((a, b) => score(a) - score(b) || order.get(a.id) - order.get(b.id));
      }
    }
    const crossSize = n => dimensions(n)[horizontal ? 'h' : 'w'];
    const mainSize = n => dimensions(n)[horizontal ? 'w' : 'h'];
    const widths = layers.map(row => row.reduce((sum, n) => sum + crossSize(n), 0) + Math.max(0, row.length - 1) * 72);
    const maxWidth = Math.max(...widths), sizes = layers.map(row => Math.max(...row.map(mainSize)));
    const mainOffsets = []; let main = 60;
    for (const size of sizes) { mainOffsets.push(main); main += size + 88; }
    layers.forEach((row, i) => {
      let cross = crossOffset + (maxWidth - widths[i]) / 2;
      for (const n of row) {
        let axis = mainOffsets[i] + (sizes[i] - mainSize(n)) / 2;
        if (reverse) axis = main - 88 + 60 - axis - mainSize(n);
        n.x = Math.round(horizontal ? axis : cross); n.y = Math.round(horizontal ? cross : axis);
        cross += crossSize(n) + 72;
      }
    });
    crossOffset += maxWidth + 120;
  }
  return result;
}

export function positionImportedNodes(nodes, edges, direction, previous) {
  const arranged = layoutNodes(nodes, edges, direction);
  if (!previous || (previous.direction || 'TD') !== direction) return arranged;
  const old = new Map(previous.nodes.map(n => [n.id, n])), planned = new Map(arranged.map(n => [n.id, { x: n.x, y: n.y }]));
  const placed = nodes.filter(n => old.has(n.id)).map(n => ({ ...n, x: old.get(n.id).x, y: old.get(n.id).y }));
  for (const n of arranged.filter(n => !old.has(n.id))) {
    const related = edges.filter(e => e.source === n.id || e.target === n.id).map(e => e.source === n.id ? e.target : e.source);
    const anchor = placed.find(p => related.includes(p.id));
    if (anchor) { const plan = planned.get(anchor.id); n.x += anchor.x - plan.x; n.y += anchor.y - plan.y; }
    while (placed.some(other => overlap(nodeBox(n, 20), nodeBox(other, 20)))) { if (['LR', 'RL'].includes(direction)) n.y += 140; else n.x += 260; }
    n.x = Math.max(-100000, Math.min(100000, n.x)); n.y = Math.max(-100000, Math.min(100000, n.y)); placed.push(n);
  }
  const positions = new Map(placed.map(n => [n.id, n])); return nodes.map(n => ({ ...n, x: positions.get(n.id).x, y: positions.get(n.id).y }));
}
export function overlap(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
// Restore the original smooth connectors and keep labels close to their curve.
export function anchor(n, toward) {
  const c = center(n), { w, h } = dimensions(n), dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return { x: c.x, y: n.y + h };
  const divisor = n.type === 'decision' ? Math.abs(dx) / (w / 2) + Math.abs(dy) / (h / 2) : Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  return { x: c.x + dx / divisor, y: c.y + dy / divisor };
}
export function curveGeometry(start, end, offset = 0) {
  const vertical = Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
  const midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2;
  const first = vertical ? { x: start.x + offset, y: midY } : { x: midX, y: start.y + offset };
  const second = vertical ? { x: end.x + offset, y: midY } : { x: midX, y: end.y + offset };
  return cubicGeometry([start, first, second, end]);
}
function cubicGeometry(points) {
  const [start, first, second, end] = points;
  return {
    d: `M${start.x},${start.y} C${first.x},${first.y} ${second.x},${second.y} ${end.x},${end.y}`,
    points,
    midpoint: { x: (start.x + 3 * first.x + 3 * second.x + end.x) / 8, y: (start.y + 3 * first.y + 3 * second.y + end.y) / 8 }
  };
}
function labelHitsNode(box, n) {
  if (n.type !== 'decision') return overlap(box, nodeBox(n));
  const c = center(n), { w, h } = dimensions(n);
  const dx = Math.max(box.x - c.x, c.x - box.x - box.width, 0);
  const dy = Math.max(box.y - c.y, c.y - box.y - box.height, 0);
  return dx / (w / 2) + dy / (h / 2) < 1;
}
export function edgeGeometry(edge, nodes, edges = []) {
  const a = nodes.find(n => n.id === edge.source), b = nodes.find(n => n.id === edge.target);
  if (!a || !b) return null;
  const parallel = edges.filter(e => e.source === edge.source && e.target === edge.target);
  const index = Math.max(0, parallel.findIndex(e => e.id === edge.id));
  let curve;
  if (a === b) {
    const { w } = dimensions(a), c = center(a), right = a.x + w, reach = 100 + index * 32;
    curve = cubicGeometry([{ x: right, y: c.y - 10 }, { x: right + reach, y: c.y - 100 }, { x: right + reach, y: c.y + 100 }, { x: right, y: c.y + 10 }]);
  } else {
    curve = curveGeometry(anchor(a, center(b)), anchor(b, center(a)), (index - (parallel.length - 1) / 2) * 24);
  }
  const text = edgeTextLayout(edge.label), mid = curve.midpoint;
  const positions = [
    { x: mid.x, y: mid.y - text.height / 2 - 2 },
    { x: mid.x + text.width / 2 + 6, y: mid.y },
    { x: mid.x - text.width / 2 - 6, y: mid.y },
    { x: mid.x, y: mid.y + text.height / 2 + 2 }
  ].map(position => {
    const box = { x: position.x - text.width / 2, y: position.y - text.height / 2, width: text.width, height: text.height };
    return { ...position, box, hits: nodes.filter(n => labelHitsNode(box, n)).length };
  });
  // Tight gaps may hide a label under a node. Move only to the adjacent side,
  // never to a distant floating position unrelated to the connector.
  const label = positions.reduce((best, next) => next.hits < best.hits ? next : best);
  return { ...curve, x: label.x, y: label.y, labelBox: label.box, labelText: text };
}
export function graphGeometry(current) {
  const result = new Map();
  for (const e of current?.edges || []) { const g = edgeGeometry(e, current.nodes, current.edges); if (g) result.set(e.id, g); }
  return result;
}
