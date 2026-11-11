'use strict';

const {executionGraph,loopComponents,tuple,refKey,digest,compact} = require('./flow-route-graph');
const statusNames={closed:'图上已闭环',open:'业务未闭环',wait:'等待接手',loop:'循环待续',local:'本次执行结束',stopped:'流程已终止',gap:'缺少承接',planned:'后续待实现',limited:'待继续分析',benign:'本次处理完成'};
const NIL={kind:'any',parts:[],count:0n};
const atom=(data)=>({kind:'atom',data,count:1n});
function combine(kind,parts) {
  if (kind==='any') parts=parts.filter(p=>p.count);
  if (!parts.length || parts.some(p=>!p.count)) return NIL;
  if (parts.length===1 && kind!=='parallel') return parts[0];
  const count=kind==='any'?parts.reduce((n,p)=>n+p.count,0n):parts.reduce((n,p)=>n*p.count,1n);
  return {kind,parts,count};
}
const terminal=(status,reason,ref)=>atom({kind:'end',status,reason,ref});

function buildRoutes(flows,path,{mode='all',rules={},expressionLimit=160000}={}) {
  const graph=executionGraph(flows,path,mode,rules), {states}=graph;
  loopComponents(states);
  const memo=new Map(),joins=new Map(),limited=new Set();
  const predicates=new Map((rules.guards || []).map(r=>[tuple(path,r.flowId,r.edgeId),r]));
  const byAnchor=new Map();
  for (const rule of rules.cases || []) {
    const k=tuple(path,rule.flowId,rule.nodeId);
    if (!byAnchor.has(k)) byAnchor.set(k,[]);
    byAnchor.get(k).push(rule);
  }
  function commonJoin(s) {
    if (joins.has(s.index)) return joins.get(s.index);
    const frontiers=s.arcs.map(a=>{
      const seen=new Set(), stops=new Set();
      function walk(i) {
        if (i<0 || seen.has(i)) return;
        const t=states[i]; seen.add(i);
        if (t.ctx.node.gatewayMode==='join') {stops.add(i);return;}
        if (t.index===s.index || t.end || !t.arcs.length) return;
        t.arcs.forEach(e=>walk(e.to));
      }
      walk(a.to);return stops;
    });
    const shared=[...(frontiers[0] || [])].filter(i=>frontiers.every(set=>set.has(i)));
    const join=shared.length===1?shared[0]:-1;
    joins.set(s.index,join);return join;
  }
  function visit(index,seen=0n,repeated=0n,until=-1,facts={}) {
    const s=states[index], {node,flow,ref}=s.ctx;
    if (index===until) return atom({kind:'barrier',ref});
    if (s.cut && (repeated&s.cut)) return terminal('loop','同一处理已再次返回。后续轮次折叠在此，仍需核实退出条件。',ref);
    if (s.cut) {if (seen&s.cut) repeated|=s.cut;seen|=s.cut;}
    const key=[index,seen,repeated,until,JSON.stringify(facts)].join('/');
    if (memo.has(key)) return memo.get(key);
    if (memo.size>=expressionLimit) {limited.add(refKey(ref));return terminal('limited','此段组合量超过本轮分析容量，请按独立入口复查。',ref);}
    const cases=byAnchor.get(refKey(ref)) || [];
    const step=atom({kind:'node',ref,flow:flow.name,label:compact(node.label),type:node.type,
      style:node.variant || (node.supplement?'proposal':''),warning:s.warning,
      fingerprint:digest([node.label,node.type,node.endScope,node.eventType,node.eventPhase,node.gatewayMode,node.contract,
        node.call,node.target,node.source,node.recovery,node.supplement,node.variant,s.ctx.edges.map(e=>[e.id,e.label,e.target,e.trace]).sort(),cases.map(c=>[c.id,c.when,c.expected,c.sourceDigest])])});
    function advance(a,stop,factState=facts) {
      const edge=atom({kind:'transition',relation:a.kind,label:a.label,edge:a.edge,token:a.token,style:a.style,ref});
      if (a.to<0) return combine('seq',[edge,terminal('gap',a.reason,ref)]);
      const guard=a.edge && predicates.get(tuple(a.edge.entryPath,a.edge.flowId,a.edge.edgeId));
      if (guard) {
        if (guard.when && Object.entries(guard.when).some(([k,v])=>Object.hasOwn(factState,k) && factState[k]!==v)) return NIL;
        factState={...factState,...guard.when,...guard.set};
        for (const k of guard.clear || []) delete factState[k];
      }
      const same=s.component===states[a.to].component;
      return combine('seq',[edge,visit(a.to,same?seen:0n,same?repeated:0n,stop,factState)]);
    }
    let tail;
    if (s.end) tail=terminal(s.end.status,s.end.reason,ref);
    else if (s.parallel && s.arcs.length>1) {
      const join=commonJoin(s);
      const lanes=combine('parallel',s.arcs.map(a=>advance(a,join<0?until:join)));
      if (join<0) tail=lanes;
      else {
        // Continue beyond a synchronization point only for combinations in
        // which every lane arrived. Other combinations retain their own stops.
        const split=partition(lanes,d=>d.kind==='end');
        const next=visit(join,states[join].component===s.component?seen:0n,states[join].component===s.component?repeated:0n,until,facts);
        tail=combine('any',[combine('seq',[split.no,next]),split.yes]);
      }
    } else {
      const choices=s.arcs.map(a=>advance(a,until));
      if (s.wait) choices.push(terminal('wait',s.wait,ref));
      tail=combine('any',choices);
    }
    const expression=combine('seq',[step,tail]);memo.set(key,expression);
    return expression;
  }
  const roots=graph.roots.map(i=>({ref:states[i].ctx.ref,label:compact(states[i].ctx.node.label),flow:states[i].ctx.flow.name,tree:visit(i)}));
  return {path,mode,roots,graph,cases:rules.cases || [],preferredRoutes:rules.preferredRoutes || [],limited};
}

// Retain every matching whole route, including all sibling lanes. Partition
// products by the FIRST matching component so repeated hits never duplicate it.
function partition(root,predicate,cache=new Map()) {
  if (cache.has(root)) return cache.get(root);
  let yes,no;
  if(root.kind==='atom') {const hit=predicate(root.data);yes=hit?root:NIL;no=hit?NIL:root;}
  else {
    const pair=root.parts.map(p=>partition(p,predicate,cache));
    if (root.kind==='any') {
      yes=combine('any',pair.map(p=>p.yes));no=combine('any',pair.map(p=>p.no));
    } else {
      no=combine(root.kind,pair.map(p=>p.no));
      if (no.count===0n) yes=root;
      else if (no.count===root.count) yes=NIL;
      else yes=combine('any',pair.map((p,i)=>combine(root.kind,[...pair.slice(0,i).map(x=>x.no),p.yes,...root.parts.slice(i+1)])));
    }
  }
  const value={yes,no};cache.set(root,value);return value;
}

function unfold(expr,index,steps,lanes=[]) {
  if(expr.kind==='atom') {steps.push({...expr.data,lanes});return;}
  if(expr.kind==='any') {
    for(const item of expr.parts) {
      if(index<item.count) {unfold(item,index,steps,lanes);return;}
      index-=item.count;
    }
  } else {
    let rest=expr.count;
    expr.parts.forEach((p,i)=>{
      rest/=p.count;
      unfold(p,index/rest,steps,expr.kind==='parallel'?[...lanes,i+1]:lanes);
      index%=rest;
    });
  }
}
function routeView(model,tree,index,root,detail) {
  const steps=[];unfold(tree,index,steps);
  const nodes=steps.filter(d=>d.kind==='node');
  const ends=steps.filter(d=>d.kind==='end');
  const substantive=ends.filter(e=>e.status!=='benign');
  const priority=['gap','limited','open','loop','wait','planned','stopped','closed','local'];
  const result=priority.map(status=>substantive.find(e=>e.status===status)).find(Boolean) || ends[0];
  const status=result?.status || 'gap';
  const id=digest(steps.map(s=>[s.lanes,s.kind,s.token || refKey(s.ref),s.status || '']));
  const caseIds=model.cases.filter(c=>steps.some(s=>c.edgeId ? s.edge?.entryPath===model.path && s.edge.flowId===c.flowId && s.edge.edgeId===c.edgeId : s.kind==='node' && s.ref.entryPath===model.path && s.ref.flowId===c.flowId && s.ref.nodeId===c.nodeId)).map(c=>c.id);
  const signature=digest([steps.map(s=>s.fingerprint || [s.label,s.reason,s.style]),caseIds]);
  const business=ends.find(e=>e.status==='open') || ends.find(e=>e.status==='closed') || result;
  const endIndex=steps.indexOf(business),resultLane=business?.lanes || [];
  const decisions=steps.filter((s,i)=>i<endIndex && s.kind==='transition' && s.label &&
    s.lanes.every((n,j)=>resultLane[j]===n) && (s.relation==='return' || steps[i-1]?.type==='decision'));
  const hasProposal=steps.some(s=>s.style==='proposal');
  const reason=result?.reason || '缺少结果标记';
  const dest=business && model.graph.nodes.get(refKey(business.ref));
  const title=dest ? compact(dest.node.label) : reason;
  const outcomes=ends.map(e=>({ref:e.ref,lanes:e.lanes,status:e.status,label:compact(model.graph.nodes.get(refKey(e.ref))?.node.label),reason:e.reason}));
  return {id,signature,root:root.ref,entry:root.label,flow:root.flow,title,status,statusName:status==='closed' && hasProposal?'方案到达业务终点':statusNames[status],reason,hasProposal,
    via:decisions.slice(-3).map(s=>s.label),flowCount:new Set(nodes.map(s=>tuple(s.ref.entryPath,s.ref.flowId))).size,caseIds,
    ...(detail?{steps:steps.map(({fingerprint,token,...s})=>s),outcomes,cases:model.cases.filter(c=>caseIds.includes(c.id))}:{})};
}
// A saved trace can be ranked again after a sibling is inserted. Do not use
// the old display number to identify a person's review.
const witnessKey=s=>digest([s.kind,s.ref,s.relation || '',s.edge || '',s.status || '']);
function rankWitness(tree,witness) {
  const memo=new WeakMap(),keys=new WeakMap();let work=0;
  function match(n,from) {
    if(!memo.has(n))memo.set(n,new Map());
    const index=memo.get(n);
    if(index.has(from))return index.get(from);
    if(++work>300000)return new Map();
    let ends=new Map();
    if(n.kind==='atom') {
      if(!keys.has(n))keys.set(n,witnessKey(n.data));
      if(keys.get(n)===witness[from])ends.set(from+1,0n);
    } else if(n.kind==='any') {
      let base=0n;
      for(const p of n.parts){for(const [to,rank] of match(p,from))if(!ends.has(to))ends.set(to,base+rank);base+=p.count;}
    } else {
      ends.set(from,0n);
      for(const p of n.parts){
        const next=new Map();
        for(const [pos,prefix] of ends)for(const [to,rank] of match(p,pos))if(!next.has(to))next.set(to,prefix*p.count+rank);
        ends=next;if(!ends.size)break;
      }
    }
    index.set(from,ends);return ends;
  }
  return match(tree,0).get(witness.length);
}
function selectRoutes(model,{entry='',through='',query='',rule='',node='',status=''}={}) {
  let roots=model.roots.filter(r=>!entry || refKey(r.ref)===entry);
  function filter(pred) {
    const cache=new Map();
    roots=roots.map(r=>({...r,tree:partition(r.tree,pred,cache).yes})).filter(r=>r.tree.count);
  }
  if(through || node) filter(d=>d.kind==='node' && (!through || d.ref.flowId===through) && (!node || d.ref.nodeId===node));
  if(query) {const text=query.trim().toLowerCase();filter(d=>[d.label,d.reason,d.flow].some(v=>v?.toLowerCase().includes(text)));}
  if(rule) {
    const c=model.cases.find(c=>c.id===rule);
    if(!c) roots=[];
    else filter(d=>c.edgeId ? d.edge?.edgeId===c.edgeId && d.edge.flowId===c.flowId && d.edge.entryPath===model.path : d.kind==='node' && d.ref.entryPath===model.path && d.ref.flowId===c.flowId && d.ref.nodeId===c.nodeId);
  }
  if(status) filter(d=>d.kind==='end' && d.status===status);
  const count=roots.reduce((n,r)=>n+r.tree.count,0n);
  function at(rank,detail=false) {
    rank=BigInt(rank);
    if(rank<0n || rank>=count) return null;
    // Interleave real entries in the default inspection queue. Direct access
    // and pagination cost logarithmic time even for very large route counts.
    let low=0n,high=rank+1n;
    function filled(n) {return roots.reduce((sum,r)=>sum+(r.tree.count<n?r.tree.count:n),0n);}
    while(low+1n<high) {const mid=(low+high)/2n;if(filled(mid)<=rank)low=mid;else high=mid;}
    const root=roots.filter(r=>r.tree.count>low)[Number(rank-filled(low))];
    return routeView(model,root.tree,low,root,detail);
  }
  function locate(record) {
    const root=roots.find(r=>record.root && refKey(r.ref)===refKey(record.root));
    if(!root || !record.witness?.length)return undefined;
    const local=rankWitness(root.tree,record.witness);
    if(local===undefined)return undefined;
    const filled=roots.reduce((n,r)=>n+(r.tree.count<local?r.tree.count:local),0n);
    const rank=filled+BigInt(roots.filter(r=>r.tree.count>local).indexOf(root));
    return at(rank)?.id===record.id?rank:undefined;
  }
  return {count,at,roots,locate};
}

// Pick a whole route witnessing each reachable decision arm, transfer, stop
// and entry without enumerating the Cartesian product. The remaining routes
// stay addressable by rank in the full view.
function inspectionQueue(model,selection) {
  const best=new Map(),order=[];
  function score(e) {
    if(best.has(e)) return best.get(e);
    let cost=0,rank=0n;
    if(e.kind==='atom') cost=e.data.kind==='end'?({loop:600,limited:900,gap:320,wait:120,local:15,open:20,planned:100}[e.data.status] || 0):e.data.kind==='node'?1:0;
    else {
      const children=e.parts.map(score);
      if(e.kind==='any') {
        cost=Infinity;let offset=0n;
        e.parts.forEach((p,i)=>{if(children[i].cost<cost){cost=children[i].cost;rank=offset+children[i].rank;} offset+=p.count;});
      } else e.parts.forEach((p,i)=>{cost+=children[i].cost;rank=rank*p.count+children[i].rank;});
    }
    const v={cost,rank};best.set(e,v);order.push(e);return v;
  }
  const context=new Map(),witness=new Map();
  function offer(e,c) {if(!context.has(e) || c.extra<context.get(e).extra) context.set(e,c);}
  const choose=(id,c)=>{const old=witness.get(id);if(!old || c.cost<old.cost) witness.set(id,c);};
  const roots=selection.roots.filter(r=>r.tree.count);
  for(const root of roots) {
    const opt=score(root.tree);
    choose('root'+refKey(root.ref),{root,rank:opt.rank,cost:opt.cost});
    offer(root.tree,{root,base:0n,mul:1n,extra:0});
  }
  for(let j=order.length-1;j>=0;j--) {
    const e=order[j],c=context.get(e);if(!c) continue;
    const opt=best.get(e);
    if(e.kind==='atom') {
      const d=e.data;
      const local=model.graph.nodes.get(refKey(d.ref));
      if(d.kind==='end' || d.kind==='transition' && (d.relation!=='edge' || local?.edges.length>1 || model.cases.some(r=>r.edgeId===d.edge?.edgeId)) ||
          d.kind==='node' && model.cases.some(r=>!r.edgeId && r.nodeId===d.ref.nodeId && r.flowId===d.ref.flowId)) {
        choose(tuple(d.kind,d.token || refKey(d.ref),d.status),{root:c.root,rank:c.base,cost:c.extra+opt.cost,focus:d.kind==='transition'?d.label:''});
      }
    } else if(e.kind==='any') {
      let offset=0n;
      for(const child of e.parts) {offer(child,{...c,base:c.base+offset*c.mul});offset+=child.count;}
    } else {
      let factor=e.count;
      for(const child of e.parts) {
        factor/=child.count;const sub=best.get(child);
        offer(child,{root:c.root,base:c.base+(opt.rank-sub.rank*factor)*c.mul,mul:c.mul*factor,extra:c.extra+opt.cost-sub.cost});
      }
    }
  }
  const seen=new Map(),items=[];
  function add(w) {
    const row=routeView(model,w.root.tree,w.rank,w.root,false);
    if(seen.has(row.id))return;
    seen.set(row.id,BigInt(items.length));items.push({...w,row});
  }
  for(const route of model.preferredRoutes) {
    const root=roots.find(r=>r.ref.flowId===route.flowId && r.ref.nodeId===route.start);
    if(!root)continue;
    let tree=partition(root.tree,d=>d.kind==='end' && d.ref.flowId===route.flowId && d.ref.nodeId===route.end).yes;
    for(const flowId of route.through || [])tree=partition(tree,d=>d.kind==='node' && d.ref.entryPath===model.path && d.ref.flowId===flowId).yes;
    if(tree.count)add({root:{...root,tree},rank:score(tree).rank,focus:route.label});
  }
  const keys=new Set();
  for(const w of witness.values()) {
    const key=tuple(refKey(w.root.ref),w.rank.toString());if(keys.has(key))continue;
    keys.add(key);add(w);
  }
  return {count:BigInt(items.length),locate:r=>seen.get(r.id),at(rank,detail=false){
    const w=items[Number(rank)];if(!w)return null;
    return {...(detail?routeView(model,w.root.tree,w.rank,w.root,true):w.row),focus:w.focus || w.row.via.at(-1) || ''};
  }};
}
module.exports={buildRoutes,selectRoutes,inspectionQueue,partition,statusNames,witnessKey};
