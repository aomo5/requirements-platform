// Calls refer to one module definition. Navigation context belongs to the
// caller, never to the shared module or its ownership tree.
export function resolveModuleCall(flows, caller, nodeId) {
  const node = caller?.nodes?.find(item => item.id === nodeId);
  const call = node?.type === 'call' && node.call;
  const module = call && flows.find(item => item.entryPath === call.entryPath && item.id === call.flowId);
  const entry = module?.nodes?.find(item => item.id === call.nodeId && item.type === 'input');
  if (!call || !Array.isArray(call.returns) || module?.kind !== 'module' || !entry) return null;
  return { node, module, entry, call };
}

export function moduleCallers(flows, entryPath, flowId) {
  return flows.flatMap(flow => (flow.nodes || []).filter(node => node.type === 'call'
    && node.call?.entryPath === entryPath && node.call.flowId === flowId)
    .map(node => ({ entryPath: flow.entryPath, flowId: flow.id, nodeId: node.id, flowName: flow.name, label: node.label })));
}

export function resolveModuleReturn(flows, context, modulePath, moduleId, outputNodeId) {
  if (!context) return null;
  const caller = flows.find(item => item.entryPath === context.entryPath && item.id === context.flowId);
  const resolved = resolveModuleCall(flows, caller, context.nodeId);
  if (!resolved || resolved.module.entryPath !== modulePath || resolved.module.id !== moduleId
    || !resolved.module.nodes.some(item => item.id === outputNodeId && item.type === 'return')) return null;
  const mappings = resolved.call.returns.filter(item => item.outputNodeId === outputNodeId);
  if (mappings.length !== 1) return null;
  const receiver = caller.nodes.find(item => item.id === mappings[0].targetNodeId);
  if (!receiver || !caller.edges?.some(edge => edge.source === resolved.node.id && edge.target === receiver.id)) return null;
  return { entryPath: caller.entryPath, flowId: caller.id, nodeId: receiver.id, label: receiver.label };
}

// A return mapping change updates only the former call's own continuation
// edges. Retained edges keep their identities and attached notes.
export function planModuleCallEdges(flow, nodeId, returns, notes, newId) {
  const node=flow.nodes.find(item=>item.id===nodeId), targets=new Set(returns.map(item=>item.targetNodeId));
  if(!node || returns.some(item=>!flow.nodes.some(receiver=>receiver.id===item.targetNodeId))) throw new Error('返回接收节点不存在。');
  const oldTargets=new Set(node.call?.returns.map(item=>item.targetNodeId) || []);
  const removed=flow.edges.filter(edge=>edge.source===nodeId && !targets.has(edge.target));
  if(removed.some(edge=>!oldTargets.has(edge.target))) throw new Error('调用节点存在非原返回映射的出线，请先处理这些连线。');
  if(removed.length && !Array.isArray(notes)) throw new Error('无法确认原返回连线的元素说明，请稍后重试。');
  if(removed.some(edge=>notes?.some(note=>note.target?.type==='flow-edge' && note.target.flowId===flow.id && note.target.edgeId===edge.id))) throw new Error('原返回连线带有元素说明，请先移除或改挂说明，再更换返回位置。');
  const removedIds=new Set(removed.map(edge=>edge.id)), edges=flow.edges.filter(edge=>!removedIds.has(edge.id));
  for(const target of targets) if(!edges.some(edge=>edge.source===nodeId && edge.target===target)) edges.push({id:newId(),source:nodeId,target,label:'本次调用返回'});
  if(edges.length>200) throw new Error('返回连线将超过每张图 200 条的限制。');
  return {edges,removedIds:[...removedIds]};
}
