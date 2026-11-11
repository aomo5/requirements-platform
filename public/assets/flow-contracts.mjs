export const CONTRACT_LIMITS = { rows: 50, name: 120, type: 120, condition: 1000, source: 1000, description: 2000 };
export const requirementLabels = { required: '必需', optional: '可选', conditional: '条件必需' };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateContractRow(row) {
  if (!plain(row) || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id || '')) return '参数标识无效。';
  if (!Object.hasOwn(requirementLabels, row.required)) return '请选择必需性。';
  for (const [field, limit] of Object.entries(CONTRACT_LIMITS)) {
    if (field === 'rows') continue;
    if (row[field] != null && (typeof row[field] !== 'string' || row[field].length > limit)) return `${({name:'字段名',type:'类型',condition:'条件',source:'来源／取值',description:'含义'})[field]}最多 ${limit} 字。`;
  }
  if (!row.name?.trim()) return '请填写字段名。';
  if (!row.type?.trim()) return '请填写类型。';
  if (row.required === 'conditional' && !row.condition?.trim()) return '请填写必需条件。';
  return '';
}
export function cleanContractRow(row) {
  return { id: row.id, name: row.name.trim(), type: row.type.trim(), required: row.required,
    ...Object.fromEntries(['condition','source','description'].filter(key => row[key]?.trim()).map(key => [key, row[key].trim()])) };
}
const singleLine = value => String(value || '').replace(/\s*\n\s*/g, ' / ');
export function contractRelations(flows, current, node, callContext = null) {
  if (!current || !node) return [];
  const result = [], seen = new Set();
  const add = (label, reference) => {
    if (!reference) return;
    const f = flows.find(item => item.entryPath === reference.entryPath && item.id === reference.flowId);
    const n = f?.nodes.find(item => item.id === reference.nodeId);
    const key = JSON.stringify([label,reference]); if (seen.has(key)) return; seen.add(key);
    result.push({ label, reference, available: !!n, location: n ? `${f.name} → ${singleLine(n.label)}` : `关联不可用：${reference.flowId} / ${reference.nodeId}` });
  };
  const local = nodeId => ({entryPath:current.entryPath,flowId:current.id,nodeId});
  if (node.source) add('输入来源', node.source);
  if (node.target || node.recovery) {
    const reference = node.target || node.recovery;
    const destination = flows.find(f => f.entryPath === reference.entryPath && f.id === reference.flowId)?.nodes.find(n => n.id === reference.nodeId);
    add(destination?.eventType === 'timer' ? '后续定时入口' : '承接位置', reference);
  }
  if (node.call) {
    add('调用入口', node.call);
    const module = flows.find(f => f.entryPath === node.call.entryPath && f.id === node.call.flowId);
    for (const mapping of node.call.returns || []) {
      const output = module?.nodes.find(n => n.id === mapping.outputNodeId);
      add(`返回：${singleLine(output?.label || mapping.outputNodeId)}`, local(mapping.targetNodeId));
    }
  }
  const callers = flows.flatMap(f => (f.nodes || []).filter(n => n.type === 'call' && n.call?.entryPath === current.entryPath && n.call.flowId === current.id).map(n => ({f,n})));
  if (node.type === 'return') {
    for (const {f,n} of callers) {
      if (callContext && (f.entryPath !== callContext.entryPath || f.id !== callContext.flowId || n.id !== callContext.nodeId)) continue;
      for (const mapping of n.call.returns || []) if (mapping.outputNodeId === node.id) add(callContext ? '本次返回位置' : `返回位置（${singleLine(n.label)}）`, {entryPath:f.entryPath,flowId:f.id,nodeId:mapping.targetNodeId});
    }
  } else if (node.type === 'input' && current.kind === 'module') {
    for (const {f,n} of callers) if (n.call.nodeId === node.id) add('调用来源', {entryPath:f.entryPath,flowId:f.id,nodeId:n.id});
  }
  for (const call of current.nodes || []) for (const mapping of call.call?.returns || []) if (mapping.targetNodeId === node.id) {
    const module = flows.find(f => f.entryPath === call.call.entryPath && f.id === call.call.flowId);
    const output = module?.nodes.find(n => n.id === mapping.outputNodeId);
    add(`接收返回：${singleLine(output?.label || mapping.outputNodeId)}`, local(call.id));
  }
  return result;
}
const markdownCell = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
export function formatContractCopy(contract, relations = []) {
  const parts = [];
  for (const [direction, label] of [['inputs','输入参数'],['outputs','返回参数']]) {
    const rows = contract?.[direction] || [];
    if (!rows.length) continue;
    parts.push(`${label}\n\n| 字段名 | 类型 | 必需性 | 来源／取值 | 含义 |\n| --- | --- | --- | --- | --- |\n` + rows.map(row => `| ${[row.name,row.type,`${requirementLabels[row.required] || row.required}${row.condition ? `（${row.condition}）` : ''}`,row.source || '—',row.description || '—'].map(markdownCell).join(' | ')} |`).join('\n'));
  }
  if (relations.length) parts.push('来源与承接\n\n' + relations.map(item => `- ${item.label}：${item.location}（流程 ID：${item.reference.flowId}；节点 ID：${item.reference.nodeId}；需求：${item.reference.entryPath}）`).join('\n'));
  return parts.join('\n\n');
}
