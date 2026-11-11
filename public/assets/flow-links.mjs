// All cross-flow navigation uses the same reference and controls. A target's
// own logic determines when it executes; following a link never invokes it.
export const nodeTarget = node => node?.type === 'output' ? node.target : node?.recovery; // Legacy associations remain readable.
export const isTrigger = node => node?.type === 'event' && (node.eventPhase || 'trigger') === 'trigger' && ['timer','message','manual','response'].includes(node.eventType);
export function resolveFlowTarget(catalog, ref) {
  if (!ref) return null;
  const flow = catalog.find(f => f.entryPath === ref.entryPath && f.id === ref.flowId);
  const node = flow?.nodes.find(n => n.id === ref.nodeId);
  return node ? {flow,node} : null;
}
export function flowSources(catalog, ref) {
  return catalog.flatMap(flow => flow.nodes.filter(node => {
    const target = nodeTarget(node);
    return target?.entryPath === ref.entryPath && target.flowId === ref.flowId && target.nodeId === ref.nodeId;
  }).map(node => ({entryPath:flow.entryPath,flowId:flow.id,nodeId:node.id,flowName:flow.name,label:node.label})));
}
