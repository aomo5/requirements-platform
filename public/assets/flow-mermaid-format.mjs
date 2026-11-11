const directions = new Set(['TD', 'TB', 'BT', 'LR', 'RL']);
const reservedIds = new Set(['end', 'subgraph', 'classDef', 'class', 'style', 'linkStyle', 'click', 'direction', 'accTitle', 'accDescr']);
export function syntaxIds(nodes = []) {
  const used = new Set(nodes.map(n => n.id)), result = new Map();
  for (const n of nodes) { let id = n.id; if (reservedIds.has(id)) { id = `n_${id}`; while (used.has(id)) id += '_'; used.add(id); } result.set(n.id, id); }
  return result;
}
function encode(value) { return String(value).replace(/[&"<>#|\n]/g, c => c === '\n' ? '<br/>' : `#${c.codePointAt(0)};`); }
export function serializeMermaid(flow) {
  const ids = syntaxIds(flow?.nodes);
  const result = [`flowchart ${directions.has(flow?.direction) ? flow.direction : 'TD'}`];
  if (flow?.kind === 'module') result.push('%% workbench-flow {"kind":"module"}');
  for (const n of flow?.nodes || []) { const [open, close] = ({ start: ['([', '])'], step: ['[', ']'], decision: ['{', '}'], end: ['(((', ')))'] })[n.type] || ['[', ']']; result.push(`  ${ids.get(n.id)}${open}"${encode(n.label)}"${close}`); }
  for (const n of flow?.nodes || []) if (n.type === 'output') result.push(`%% workbench-output ${JSON.stringify({ id: ids.get(n.id), target: n.target || null })}`);
  for (const n of flow?.nodes || []) if (['input','event','end','gateway','call','return'].includes(n.type)) result.push(`%% workbench-node ${JSON.stringify({id:ids.get(n.id),type:n.type,...(n.call ? {call:{...n.call,returns:n.call.returns.map(item=>({...item,targetNodeId:ids.get(item.targetNodeId)||item.targetNodeId}))}}:{}),...(n.gatewayMode ? {gatewayMode:n.gatewayMode}:{}),...(n.source ? {source:n.source}:{}),...(n.eventType ? {eventType:n.eventType}:{}),...(n.eventPhase ? {eventPhase:n.eventPhase}:{}),...(n.endScope ? {endScope:n.endScope}:{})})}`);
  for (const n of flow?.nodes || []) if (n.contract) result.push(`%% workbench-contract ${JSON.stringify({ id: ids.get(n.id), contract: n.contract })}`);
  for (const n of flow?.nodes || []) if (n.recovery) result.push(`%% workbench-recovery ${JSON.stringify({ id: ids.get(n.id), recovery: n.recovery })}`);
  for (const e of flow?.edges || []) result.push(`  ${ids.get(e.source)} -->${e.label ? `|"${encode(e.label)}"|` : ''} ${ids.get(e.target)}`);
  return result.join('\n') + '\n';
}
