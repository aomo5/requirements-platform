'use strict';

const {createHash} = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const tuple = (...ids) => JSON.stringify(ids);
const compact = text => String(text || '').replace(/\s+/g, ' ').trim();
const refKey = ref => tuple(ref.entryPath, ref.flowId, ref.nodeId);
const flowKey = (path, id) => tuple(path, id);
function compatible(output,input) {
  const labels=rows=>(rows || []).map(r=>r.name).filter(n=>n?.startsWith('【对应】'));
  const gives=labels(output.contract?.outputs),takes=labels(input.contract?.inputs);
  return !gives.length || !takes.length || gives.some(v=>takes.includes(v));
}

// A state includes the caller. Shared modules cannot return to another caller.
function executionGraph(flows, path, mode, rules = {}) {
  const nodes = new Map(), flowMap = new Map(), children = new Map(), issues = [];
  const entries = [], pointed = new Set();
  const declared = new Map((rules.endings || []).map(r => [tuple(path,r.flowId,r.nodeId),r]));
  for (const flow of flows) {
    flowMap.set(flowKey(flow.entryPath,flow.id),flow);
    for (const node of flow.nodes) {
      const ref = {entryPath:flow.entryPath,flowId:flow.id,nodeId:node.id};
      nodes.set(refKey(ref), {node,flow,ref,edges:[],incoming:0});
      for (const r of [node.target,node.recovery,node.call]) if (r) pointed.add(refKey(r));
      if (flow.parent?.nodeId && node.source && refKey(node.source) === refKey(flow.parent)) {
        const k = refKey(node.source);
        if (!children.has(k)) children.set(k,[]);
        children.get(k).push(ref);
      }
    }
    for (const e of flow.edges) {
      nodes.get(tuple(flow.entryPath,flow.id,e.source))?.edges.push(e);
      const target = nodes.get(tuple(flow.entryPath,flow.id,e.target));
      if (target) target.incoming++;
    }
  }
  const declaredRoots = new Set(rules.externalFlows || []);
  const owned = ctx => ctx.flow.entryPath === path || declaredRoots.has(flowKey(ctx.flow.entryPath,ctx.flow.id));
  for (const [key,ctx] of nodes) {
    const {node:n,ref} = ctx;
    if (!owned(ctx)) continue;
    const entry=n.type === 'start' || n.type === 'event' && n.eventPhase === 'trigger' && !n.source && !ctx.incoming ||
        n.type === 'input' && !n.source && !ctx.incoming && !pointed.has(key) && !ctx.flow.parent && ctx.flow.kind !== 'module';
    if(entry && (mode!=='current' || !n.supplement))entries.push(ref);
    if (n.source && !nodes.has(refKey(n.source))) issues.push({ref,message:'输入标记的来源节点不存在'});
    if (n.type === 'output') {
      const target = n.target && nodes.get(refKey(n.target));
      if (!target || !['event','input'].includes(target.node.type)) issues.push({ref,message:target?'跨图出口未落到输入或事件':'出口缺少可定位的接收入口'});
    }
  }
  const states = [], stateIds = new Map();
  function intern(ref, stack) {
    const k = refKey(ref), ctx = nodes.get(k);
    if (!ctx) return -1;
    const id = tuple(k,...stack);
    if (stateIds.has(id)) return stateIds.get(id);
    const index = states.length;
    stateIds.set(id,index);
    states.push({index,ctx,stack,arcs:[],depth:stack.length});
    return index;
  }
  const roots = entries.map(ref=>intern(ref,[]));
  function belongs(flow, module) {
    const visited = new Set();
    while (flow && !visited.has(flow)) {
      if (flow.id === module.flowId && flow.entryPath === module.entryPath) return true;
      visited.add(flow); flow = flow.parent && flowMap.get(flowKey(flow.parent.entryPath,flow.parent.flowId));
    }
    return false;
  }
  function destinationStack(ref, stack) {
    const dest = nodes.get(refKey(ref));
    let count = stack.length;
    while (dest && count && !belongs(dest.flow,nodes.get(stack[count-1]).node.call)) count--;
    return count === stack.length ? stack : stack.slice(0,count);
  }
  for (let index=0; index<states.length; index++) {
    const s=states[index], {node:n,flow,ref,edges}=s.ctx, k=refKey(ref);
    const finish = (status,reason) => { s.end={status,reason}; };
    const arc = (target,stack,kind,label,edge=null,edgeFlow=flow) => {
      if(mode==='current' && (edge?.trace==='proposal' || nodes.get(refKey(target))?.node.supplement))return;
      const dest=intern(target,stack);
      const edgeRef=edge ? {entryPath:edgeFlow.entryPath,flowId:edgeFlow.id,edgeId:edge.id} : null;
      s.arcs.push({to:dest,kind,label:compact(label),edge:edgeRef,style:edge?.trace || '',
        token:edgeRef ? [kind,edgeRef.entryPath,edgeRef.flowId,edgeRef.edgeId] : [kind,refKey(ref),refKey(target)],
        ...(dest<0?{reason:'目标节点不存在'}:{})});
    };
    if (n.type==='output' || n.recovery) {
      const target=n.target || n.recovery, dest=target && nodes.get(refKey(target));
      if (!dest || !['event','input'].includes(dest.node.type)) finish('gap','跨图出口缺少有效接收入口');
      else if(!compatible(n,dest.node)) finish('gap','双方的固定对应标签不匹配，需核实交接条件');
      else {
        const event=dest.node.type==='event';
        arc(target,destinationStack(target,s.stack),event?'event':'handoff',event?'事件触发后继续':'出口 → 接收入口');
        if (event) s.wait='等待'+compact(dest.node.label);
      }
    } else if (n.type==='call') {
      const call=n.call, dest=call && nodes.get(refKey(call));
      if (dest?.flow.kind!=='module' || dest.node.type!=='input') finish('gap','调用缺少有效的模块输入');
      else if (s.stack.includes(k)) finish('loop','同一调用再次递归，后续按同一模块继续');
      else arc(call,[...s.stack,k],'call','进入本次调用');
    } else if (n.type==='return') {
      const caller=nodes.get(s.stack.at(-1));
      const map=caller?.node.call.returns.filter(r=>r.outputNodeId===n.id) || [];
      const edge=map.length===1 && caller.edges.find(e=>e.target===map[0].targetNodeId);
      if (!caller || !belongs(flow,caller.node.call) || !edge) finish('gap','模块返回缺少本次调用方的唯一接收位置');
      else arc({...caller.ref,nodeId:edge.target},s.stack.slice(0,-1),'return',edge.label || '返回本次调用方',edge,caller.flow);
    } else if (n.type==='end') {
      const ending=declared.get(k);
      if (ending) finish(ending.status,ending.reason);
      else if (n.endScope==='business') finish('closed',compact(n.label));
      else if (n.endScope==='execution' || n.endScope==='subprocess') finish('local',compact(n.label));
      else finish(n.endScope==='terminate'?'stopped':'gap',n.endScope==='terminate'?'本次流程已终止':'结束范围待明确');
    } else if (children.has(k) && n.type!=='gateway') {
      // An ownership link alone is just navigation. Only a reciprocal entry
      // can replace the overview of this same execution.
      for (const dest of children.get(k)) {
        const isEvent=nodes.get(refKey(dest)).node.type==='event';
        arc(dest,s.stack,isEvent?'event':'expand',isEvent?'异步执行开始':'展开同一阶段');
        if (isEvent) s.wait='等待'+compact(nodes.get(refKey(dest)).node.label);
      }
    } else {
      s.parallel=n.type==='gateway' && n.gatewayMode==='split';
      if (s.parallel && children.has(k)) {
        // A child unfolding this very fork carries its lanes exactly once.
        for (const dest of children.get(k)) arc(dest,s.stack,'expand','展开同一次分流');
        s.parallel=false;
      } else {
        for (const edge of edges) {
          if (mode==='current' && edge.trace==='proposal') continue;
          arc({...ref,nodeId:edge.target},s.stack,'edge',edge.label,edge);
        }
      }
      if (!s.arcs.length) finish(edges.length?'planned':'gap',edges.length?'后续只有拟改步骤或连线':'此处没有后续连线或结束范围');
      else if (s.arcs.length>1 && !s.parallel && !['decision','input','event','call','gateway'].includes(n.type)) {
        s.warning='多条出线的择一或并行规则待明确';
        issues.push({ref,message:s.warning});
      }
    }
    if(!s.end && !s.arcs.length)finish('planned','承接位置列为拟改，本轮现状走到这里');
    if (s.end?.status==='gap') issues.push({ref,message:s.end.reason});
  }
  const reached=new Set(states.map(s=>refKey(s.ctx.ref)));
  const edgeSet=new Set(states.flatMap(s=>s.arcs.filter(a=>a.edge).map(a=>tuple(a.edge.entryPath,a.edge.flowId,a.edge.edgeId))));
  // Unentered modules/stages are exposed as gaps, never manufactured as another business root.
  const uncovered=[];
  for (const [k,ctx] of nodes) if (owned(ctx) && !reached.has(k)) uncovered.push(ctx.ref);
  const unusedEdges=[];
  for(const [k,ctx] of nodes)if(owned(ctx))for(const e of ctx.edges) {
    if(edgeSet.has(tuple(ctx.ref.entryPath,ctx.ref.flowId,e.id)))continue;
    const reason=mode==='current' && e.trace==='proposal'?'当前筛选排除拟改连线':children.has(k)?'此步展开为详细流程':!reached.has(k)?'入口未到达该节点':'当前入口未走到这条连线';
    unusedEdges.push({ref:{...ctx.ref,edgeId:e.id},label:compact(e.label || ctx.node.label),reason});
  }
  return {states,roots,issues,uncovered,unusedEdges,edgeSet,nodes,flowMap,children};
}

// Only back-edge targets need visit counters. Drop those counters on leaving
// a strongly connected component, so shared suffixes can be counted once.
function loopComponents(states) {
  let number=0,component=0;
  const order=[],low=[],onStack=new Set(),stack=[];
  const active=new Set(),cuts=new Set();
  function visit(i) {
    order[i]=low[i]=++number; stack.push(i); onStack.add(i); active.add(i);
    for (const {to} of states[i].arcs) if (to>=0) {
      if (active.has(to)) cuts.add(to);
      if (!order[to]) { visit(to); low[i]=Math.min(low[i],low[to]); }
      else if (onStack.has(to)) low[i]=Math.min(low[i],order[to]);
    }
    active.delete(i);
    if (low[i]!==order[i]) return;
    let top;
    do {top=stack.pop();onStack.delete(top);states[top].component=component;} while(top!==i);
    component++;
  }
  for (const s of states) if (!order[s.index]) visit(s.index);
  let bit=1n;
  for(const i of cuts) {states[i].cut=bit;bit<<=1n;}
}

module.exports={executionGraph,loopComponents,compact,digest,tuple,refKey,flowKey};
