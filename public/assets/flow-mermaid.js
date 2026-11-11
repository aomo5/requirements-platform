import { syntaxIds } from "./flow-mermaid-format.mjs";
import { positionImportedNodes } from "./flow-geometry.js";
export { serializeMermaid } from "./flow-mermaid-format.mjs";
// A bounded Mermaid flowchart bridge. Unsupported syntax is rejected, never discarded.
const fail = (message, line) => { throw new Error(`${line ? `第 ${line} 行：` : ''}${message}`); };
const freshId = () => globalThis.crypto?.randomUUID?.() || `e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function statements(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === '```mermaid' && lines.at(-1)?.trim() === '```') { lines[0] = ''; lines[lines.length - 1] = ''; }
  const result = []; let text = '', depth = 0, quote = false, start = 1;
  for (let line = 0; line < lines.length; line++) {
    for (let i = 0; i < lines[line].length; i++) {
      const c = lines[line][i];
      if (!quote && !depth && lines[line].slice(i, i + 2) === '%%') { if (lines[line].slice(i).startsWith('%%{')) fail('暂不支持 Mermaid 初始化指令。', line + 1); break; }
      if (!text.trim()) start = line + 1;
      if (c === '"') quote = !quote;
      if (!quote && '[({'.includes(c)) depth++;
      if (!quote && '])}'.includes(c)) { depth--; if (depth < 0) fail('括号不匹配。', line + 1); }
      if (c === ';' && !quote && !depth) { if (text.trim()) result.push({ text: text.trim(), line: start }); text = ''; }
      else text += c;
    }
    if (!depth && !quote) { if (text.trim()) result.push({ text: text.trim(), line: start }); text = ''; }
    else text += '\n';
  }
  if (depth || quote) fail('节点括号或引号尚未闭合。', start);
  return result;
}
function label(raw, line, required = true) {
  let value = raw.trim();
  if (value.startsWith('"')) { if (!value.endsWith('"')) fail('文字引号尚未闭合。', line); value = value.slice(1, -1); if (value.includes('"')) fail('文字中的双引号请写为 #quot;。', line); }
  else if (/["\[\]{}]/.test(value)) fail('特殊文字请放在双引号内。', line);
  value = value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/#(\d+);|#quot;|#amp;|&quot;|&amp;|&lt;|&gt;/g, (token, number) => number ? (Number(number) <= 0x10ffff ? String.fromCodePoint(Number(number)) : token) : ({ '#quot;': '"', '#amp;': '&', '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' }[token])).trim();
  if (required && !value) fail('节点名称不能为空。', line);
  if (value.length > 200) fail('文字最多 200 字。', line);
  return value;
}
function parseContract(value) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!plain(value) || Object.keys(value).some(field => !['inputs','outputs'].includes(field))) fail('参数契约只支持 inputs 和 outputs。');
  const result = {};
  for (const direction of ['inputs','outputs']) {
    const rows = value[direction] === undefined ? [] : value[direction], ids = new Set();
    if (!Array.isArray(rows) || rows.length > 50) fail('参数契约每组须为数组，最多 50 项。');
    result[direction] = rows.map(row => {
      if (!plain(row) || Object.keys(row).some(field => !['id','name','type','required','condition','source','description'].includes(field))) fail('参数字段属性无效。');
      if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id)) fail('参数字段 ID 无效或重复。');
      ids.add(row.id);
      if (['name','type'].some(field => typeof row[field] !== 'string' || !row[field].trim() || row[field].length > 120)) fail('参数名称与类型必填，最多 120 字。');
      if (!['required','optional','conditional'].includes(row.required)) fail('参数必需性无效。');
      for (const [field, max] of [['condition',1000],['source',1000],['description',2000]]) if (row[field] !== undefined && (typeof row[field] !== 'string' || row[field].length > max)) fail('参数说明字段格式或长度无效。');
      if (row.required === 'conditional' && !row.condition?.trim()) fail('条件必需参数须填写条件。');
      return {...row,name:row.name.trim(),type:row.type.trim()};
    });
  }
  return result.inputs.length || result.outputs.length ? result : null;
}
export function parseMermaid(source, previous = null) {
  if (typeof source !== 'string' || source.length > 100000) fail('Mermaid 源码最多 100,000 字符。');
  let flowMetadata = null;
  for (const line of source.split('\n')) if (line.trim().startsWith('%% workbench-flow ')) {
    let value; try { value = JSON.parse(line.trim().slice('%% workbench-flow '.length)); } catch { fail('流程语义元数据格式错误。'); }
    if (flowMetadata || !value || value.kind !== 'module' || Object.keys(value).some(key => key !== 'kind')) fail('流程语义元数据无效。');
    flowMetadata = value;
  }
  const semanticNodes = new Map();
  for (const line of source.split('\n')) if (line.trim().startsWith('%% workbench-node ')) {
    let value; try { value = JSON.parse(line.trim().slice('%% workbench-node '.length)); } catch { fail('节点语义元数据格式错误。'); }
    if (!value || typeof value.id !== 'string' || !['input','event','end','gateway','call','return'].includes(value.type) || semanticNodes.has(value.id)) fail('节点语义 ID 或类型无效。');
    semanticNodes.set(value.id,value);
  }
  const contracts = new Map();
  for (const line of source.split('\n')) if (line.trim().startsWith('%% workbench-contract ')) {
    let value; try { value = JSON.parse(line.trim().slice('%% workbench-contract '.length)); } catch { fail('参数契约元数据格式错误。'); }
    if (!value || typeof value.id !== 'string' || Object.keys(value).some(field => !['id','contract'].includes(field)) || contracts.has(value.id)) fail('参数契约节点 ID 无效或重复。');
    contracts.set(value.id, parseContract(value.contract));
  }
  const recoveries = new Map();
  for (const line of source.split('\n')) if (line.trim().startsWith('%% workbench-recovery ')) {
    let value; try { value = JSON.parse(line.trim().slice('%% workbench-recovery '.length)); } catch { fail('异步恢复元数据格式错误。'); }
    if (!value || typeof value.id !== 'string' || recoveries.has(value.id) || !value.recovery || Object.keys(value.recovery).some(key => !['entryPath','flowId','nodeId'].includes(key)) || ['entryPath','flowId','nodeId'].some(key => typeof value.recovery[key] !== 'string' || !value.recovery[key])) fail('异步恢复关联无效或重复。');
    recoveries.set(value.id, value.recovery);
  }
  const outputs = new Map();
  for (const line of source.split('\n')) if (line.trim().startsWith('%% workbench-output ')) {
    let value; try { value = JSON.parse(line.trim().slice('%% workbench-output '.length)); } catch { fail('跨图出口元数据格式错误。'); }
    if (!value || typeof value.id !== 'string' || outputs.has(value.id)) fail('跨图出口 ID 无效或重复。');
    outputs.set(value.id, value.target);
  }
  const rows = statements(source.trimEnd()), header = rows.shift();
  const match = header?.text.match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)$/);
  if (!match) fail('请以 flowchart TD 或 graph LR 等流程图方向开头。', header?.line || 1);
  const direction = match[1], nodes = new Map(), links = [], oldNodes = new Map((previous?.nodes || []).map(n => [n.id, n]));
  const aliases = new Map([...syntaxIds(previous?.nodes)].map(([id, token]) => [token, id]));
  const normalizeId = (id) => aliases.get(id) || id;
  function parseRow(row) {
    const text = row.text; let at = 0;
    const skip = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
    function oneNode() {
      skip(); const idMatch = text.slice(at).match(/^[a-zA-Z0-9_](?:[a-zA-Z0-9_]|-(?!-))*/);
      if (!idMatch) fail('这里需要节点 ID。', row.line);
      const token = idMatch[0]; at += token.length; skip();
      if (token === 'end') fail('end 是 Mermaid 保留字，请改用其他节点 ID。', row.line);
      const id = normalizeId(token);
      if (id.length > 80) fail('节点 ID 最多 80 字符。', row.line);
      let type = null, raw = '', close = '';
      const shapes = [['(((', ')))', 'end'], ['([', '])', 'start'], ['((', '))', 'end'], ['[', ']', 'step'], ['{', '}', 'decision'], ['(', ')', 'step']];
      for (const [open, end, shape] of shapes) if (text.startsWith(open, at)) { at += open.length; close = end; type = shape; break; }
      if (close) {
        let quoted = false, found = false;
        for (; at < text.length; at++) {
          if (!quoted && text.startsWith(close, at)) { at += close.length; found = true; break; }
          if (text[at] === '"') quoted = !quoted;
          raw += text[at];
        }
        if (!found) fail('节点形状尚未闭合。', row.line);
      }
      const existing = nodes.get(id);
      if (!existing) nodes.set(id, { id, type: type || 'step', label: type ? label(raw, row.line) : id, explicit: !!type, stadium: close === '])' });
      else if (type) Object.assign(existing, { type, label: label(raw, row.line), explicit: true, stadium: close === '])' });
      if (nodes.size > 100) fail('每张流程图最多 100 个节点。', row.line);
      return id;
    }
    function group() { const ids = [oneNode()]; skip(); while (text[at] === '&') { at++; ids.push(oneNode()); skip(); } return ids; }
    let from = group(); skip();
    while (at < text.length) {
      let edgeLabel = '';
      if (text.startsWith('-->', at)) { at += 3; skip(); if (text[at] === '|') { at++; let raw = '', quoted = false; while (at < text.length) { const c = text[at++]; if (c === '"') quoted = !quoted; if (c === '|' && !quoted) break; raw += c; } if (text[at - 1] !== '|') fail('连线文字缺少结尾的 |。', row.line); edgeLabel = label(raw, row.line, false); } }
      else if (text.startsWith('--', at)) { at += 2; const end = text.indexOf('-->', at); if (end < 0) fail('目前支持 --> 有向连线及其文字。', row.line); edgeLabel = label(text.slice(at, end), row.line, false); at = end + 3; }
      else fail('暂不支持此语法；支持节点、--> 连线、分支文字和 & 分支。样式、子图及其他图类型请先移除。', row.line);
      const to = group(); for (const source of from) for (const target of to) links.push({ source, target, label: edgeLabel });
      if (links.length > 200) fail('每张流程图最多 200 条连线。', row.line);
      from = to; skip();
    }
  }
  const unsupported = /^(?:subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
  for (const row of rows) { if (unsupported.test(row.text)) fail('暂不支持子图、样式、点击指令或其他扩展语法，请先移除后再导入。', row.line); parseRow(row); }
  const incoming = new Map(), outgoing = new Map();
  links.forEach(e => { incoming.set(e.target, (incoming.get(e.target) || 0) + 1); outgoing.set(e.source, (outgoing.get(e.source) || 0) + 1); });
  // Preserve bound node identities, page links and manual positions when direction is unchanged.
  const graphNodes = [...nodes.values()].map(n => {
    const old = oldNodes.get(n.id); let type = n.type;
    if (!n.explicit && old) type = old.type;
    if (n.stadium && incoming.has(n.id) && !outgoing.has(n.id)) type = 'end';
    if (n.stadium && ['start', 'end'].includes(old?.type)) type = old.type;
    const semanticKey = [...semanticNodes.keys()].find(key => normalizeId(key) === n.id);
    const semantic = semanticKey !== undefined ? semanticNodes.get(semanticKey) : (!n.explicit && old ? old : null);
    if (semantic) type = semantic.type;
    const recoveryKey = [...recoveries.keys()].find(key => normalizeId(key) === n.id);
    const recovery = recoveryKey !== undefined ? recoveries.get(recoveryKey) : old?.recovery;
    const metadata = recovery ? { recovery } : {};
    const contractKey = [...contracts.keys()].find(key => normalizeId(key) === n.id);
    const contract = contractKey !== undefined ? contracts.get(contractKey) : old?.contract;
    if (contract) metadata.contract = parseContract(contract);
    if (type === 'gateway') metadata.gatewayMode = semantic?.gatewayMode || 'unspecified';
    if (['input','event'].includes(type) && semantic?.source) metadata.source = semantic.source;
    if (type === 'event') { metadata.eventType = semantic?.eventType || 'unspecified'; metadata.eventPhase = semantic?.eventPhase || 'trigger'; }
    if (type === 'end' && semantic?.endScope) metadata.endScope = semantic.endScope;
    if (type === 'call' && semantic?.call) {
      const call = semantic.call;
      if (!call || typeof call.entryPath !== 'string' || typeof call.flowId !== 'string' || typeof call.nodeId !== 'string' || !Array.isArray(call.returns)
        || call.returns.some(item => !item || typeof item.outputNodeId !== 'string' || typeof item.targetNodeId !== 'string')) fail('模块调用元数据无效。');
      metadata.call = { entryPath: call.entryPath, flowId: call.flowId, nodeId: call.nodeId, returns: call.returns.map(item => ({ outputNodeId: item.outputNodeId, targetNodeId: normalizeId(item.targetNodeId) })) };
    }
    const outputKey = [...outputs.keys()].find(key => normalizeId(key) === n.id);
    if (outputKey !== undefined) type = 'output';
    const target = outputKey !== undefined ? outputs.get(outputKey) : old?.type === 'output' && type === 'output' ? old.target : null;
    return { ...metadata, ...(type === 'output' && target ? { target } : {}), ...(old?.variant ? {variant:old.variant} : {}), ...(old?.issues ? {issues:old.issues} : {}), ...(old?.supplement ? { supplement: true } : {}), id: n.id, type, label: n.explicit || !old ? n.label : old.label, x: old?.x ?? 0, y: old?.y ?? 0, pageId: old?.pageId || '' };
  });
  for (const id of semanticNodes.keys()) if (!nodes.has(normalizeId(id)) || outputs.has(id)) fail('节点语义引用不存在或重复定义。');
  for (const id of contracts.keys()) if (!nodes.has(normalizeId(id))) fail('参数契约元数据引用了不存在的节点。');
  for (const id of recoveries.keys()) if (!nodes.has(normalizeId(id))) fail('异步恢复元数据引用了不存在的节点。');
  for (const id of outputs.keys()) if (!nodes.has(normalizeId(id))) fail('跨图出口元数据引用了不存在的节点。');
  const remaining = [...(previous?.edges || [])];
  // Reserve exact matches first so an edited parallel edge cannot take another edge's notes.
  const matched = links.map(e => { const index = remaining.findIndex(old => old.source === e.source && old.target === e.target && old.label === e.label); return index < 0 ? null : remaining.splice(index, 1)[0]; });
  const edges = links.map((e, i) => { let old = matched[i]; if (!old) { const index = remaining.findIndex(item => item.source === e.source && item.target === e.target); if (index >= 0) old = remaining.splice(index, 1)[0]; } return { ...(old?.trace ? {trace:old.trace} : {}), id: old?.id || freshId(), ...e }; });
  return { ...(flowMetadata?.kind || previous?.kind ? {kind:flowMetadata?.kind || previous.kind} : {}), ...(previous?.lanes ? {lanes:previous.lanes} : {}), direction, nodes: positionImportedNodes(graphNodes, edges, direction, previous), edges };
}
