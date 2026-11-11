'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildRoutes,selectRoutes,inspectionQueue}=require('../lib/flow-routes');
const {readRules,evaluateEvidence,methodFacts,traceMatches}=require('../lib/flow-route-rules');
const {createReviewStore,reviewFor}=require('../lib/flow-route-service');
const p='20/测试',ref=(flowId,nodeId)=>({entryPath:p,flowId,nodeId});
const n=(id,type,opts={})=>({id,type,label:id,...opts});
const e=(source,target,id=source+'-'+target,label=id)=>({source,target,id,label});
const f=(id,nodes,edges,props={})=>({id,entryPath:p,name:id,nodes,edges,...props});
const rows=list=>Array.from({length:Number(list.count)},(_,i)=>list.at(i,true));
const business=id=>n(id,'end',{endScope:'business'});
test('one demand unfolds its stage, returns to the paired input and exposes a removed receiver',()=>{
  const root=f('main',[n('start','start'),n('stage','step'),n('received','input'),business('closed')],[e('start','stage'),e('stage','closed'),e('received','closed')]);
  const phase=f('phase',[n('in','input',{source:ref('main','stage')}),n('out','output',{target:ref('main','received')})],[e('in','out')],{parent:ref('main','stage')});
  const read=()=>rows(selectRoutes(buildRoutes([root,phase],p)));
  const r=read()[0];assert.deepEqual(r.steps.filter(s=>s.kind==='node').map(s=>s.ref.nodeId),['start','stage','in','out','received','closed']);assert.equal(r.status,'closed');
  root.nodes=root.nodes.filter(n=>n.id!=='received');const gap=read()[0];assert.equal(gap.status,'gap');assert.equal(gap.steps.at(-1).ref.nodeId,'out');
});
test('two callers of the same module return to their respective receivers',()=>{
  const call=(id,to)=>n(id,'call',{call:{...ref('m','in'),returns:[{outputNodeId:'return',targetNodeId:to}]}});
  const main=f('root',[n('s','start'),n('d','decision'),call('first','a'),call('second','b'),business('a'),business('b')],[e('s','d'),e('d','first'),e('d','second'),e('first','a'),e('second','b')]);
  const mod=f('m',[n('in','input'),n('return','return')],[e('in','return')],{kind:'module'});
  const all=rows(selectRoutes(buildRoutes([main,mod],p)));
  assert.deepEqual(all.map(r=>r.title),['a','b']);assert.ok(all.every(r=>r.steps.filter(s=>s.relation==='return').length===1));
});
test('parallel siblings are combined in one route and wait at an explicit join',()=>{
  const flow=f('f',[n('s','start'),n('split','gateway',{gatewayMode:'split'}),n('a','decision'),n('b','step'),n('a1','step'),n('a2','step'),n('join','gateway',{gatewayMode:'join'}),business('done')],
    [e('s','split'),e('split','a'),e('split','b'),e('a','a1'),e('a','a2'),e('a1','join'),e('a2','join'),e('b','join'),e('join','done')]);
  const result=rows(selectRoutes(buildRoutes([flow],p)));assert.equal(result.length,2);
  for(const r of result){assert.equal(r.status,'closed');assert.equal(r.steps.filter(s=>s.ref?.nodeId==='done' && s.kind==='node').length,1);assert.ok(r.steps.some(s=>s.lanes[0]===2));}
  flow.nodes.push(n('unresolved','end',{endScope:'execution'}));flow.edges.push(e('a','unresolved'));
  const branch=rows(selectRoutes(buildRoutes([flow],p))).find(r=>r.title==='unresolved');assert.equal(branch.status,'local');assert.ok(!branch.steps.some(s=>s.ref?.nodeId==='done'));
});
test('waits, first success, success after retry, repeated wait and monetary gaps stay visible',()=>{
  const a=f('main',[n('start','start'),n('out','output',{target:ref('handler','tick')})],[e('start','out')]);
  const b=f('handler',[n('tick','event',{eventPhase:'intermediate',eventType:'timer'}),n('choice','decision'),business('paid'),n('unknown','end',{endScope:'execution'})],
    [e('tick','choice'),e('choice','tick'),e('choice','paid'),e('choice','unknown')]);
  const model=buildRoutes([a,b],p,{rules:{endings:[{flowId:'handler',nodeId:'unknown',status:'open',reason:'退款结果待核'}]}});
  const all=rows(selectRoutes(model));assert.ok(all.some(r=>r.status==='wait'));assert.ok(all.some(r=>r.status==='loop'));assert.ok(all.some(r=>r.status==='open'));
  assert.equal(all.filter(r=>r.status==='closed').length,2);
});
test('source guard incompatibility eliminates unreachable combinations, query preserves entire witness and coordinate-only edits preserve review',()=>{
  const x=f('x',[n('s','start'),n('a','decision'),n('b','decision'),business('ok'),business('bad')],[e('s','a'),e('a','b','paid'),e('b','ok','success'),e('b','bad','conflict')]);
  const rules={guards:[{flowId:'x',edgeId:'paid',when:{paid:true}},{flowId:'x',edgeId:'conflict',when:{paid:false}}],cases:[]};
  const get=()=>selectRoutes(buildRoutes([x],p,{rules}),{query:'success'});
  const before=get().at(0,true);assert.equal(get().count,1n);assert.equal(before.steps[0].ref.nodeId,'s');
  x.nodes[1].x=350;assert.equal(get().at(0).signature,before.signature);
  x.edges[1].label='付款刚刚核实';assert.equal(get().at(0).id,before.id);assert.notEqual(get().at(0).signature,before.signature);
});
test('representative queue contains every reachable choice and complete shapes still support random access above Number.MAX_SAFE_INTEGER',()=>{
  const nodes=[n('s','start'),business('end')],edges=[];let last='s';
  for(let i=0;i<55;i++){const d='d'+i;nodes.push(n(d,'decision'));edges.push(e(last,d,last+'to'+d));const a='a'+i,b='b'+i,m='m'+i;nodes.push(n(a,'step'),n(b,'step'),n(m,'step'));edges.push(e(d,a),e(d,b),e(a,m),e(b,m));last=m;}
  edges.push(e(last,'end'));const model=buildRoutes([f('f',nodes,edges)],p),all=selectRoutes(model),queue=inspectionQueue(model,all);
  assert.equal(all.count,2n**55n);assert.ok(queue.count<=56n);assert.notEqual(all.at(0).id,all.at(all.count-1n).id);
  const hit=new Set(rows(queue).flatMap(r=>r.steps.filter(s=>s.edge).map(s=>s.edge.edgeId)));assert.ok(edges.every(e=>hit.has(e.id)));
});
test('unmapped source branch and an implementation change are reported independent of the drawn flow',()=>{
  const one=methodFacts('class A { void update(Order o) { if (o.ok()) paid(); } }','update','Order');
  const two=methodFacts('class A { void update(Order o) { if (o.ok()) paid(); if (o.readFailed()) retry(); } }','update','Order');
  assert.deepEqual(two.conditions.filter(c=>!one.conditions.includes(c)),['if (o.readFailed())']);assert.notEqual(one.fingerprint,two.fingerprint);
  const comment=methodFacts('class A { void update(Order o) { /* if (fake) */ if (o.ok()) paid(); } }','update','Order');
  assert.equal(one.fingerprint,comment.fingerprint);
});
test('duplicate start command fails despite a passing suite and a finished order; incomplete evidence cannot pass',()=>{
  const edge={entryPath:p,flowId:'f',edgeId:'e',lanes:[]},route={id:'r',signature:'v',cases:[{id:'duplicate',assertions:[{field:'starts',value:1}]}],steps:[{edge,lanes:[]}]};
  const trace={routeId:'r',routeSignature:'v',runId:'run',scenario:'duplicate',database:'demo_testing',executed:true,cleanupCompleted:true,actualEdges:[edge],observed:{starts:2}};
  const run={id:'run',path:p,environment:{scope:'business',database:trace.database},codeVersion:'1234567',status:'passed',businessExecuted:true,businessEvidence:[trace]};
  const get=()=>evaluateEvidence(route,[run],'1234567',p)[0]?.status;
  assert.equal(get(),'failed');trace.observed={};assert.equal(get(),'incomplete');trace.observed.starts=1;assert.equal(get(),'passed');trace.routeSignature='older';assert.equal(get(),undefined);
  const a={...edge,edgeId:'a',lanes:[1]},b={...edge,edgeId:'b',lanes:[2]};assert.equal(traceMatches([edge,a,b],[edge,b,a]),true);assert.equal(traceMatches([edge,a,b],[a,edge,b]),false);
});
test('review conflicts are rejected and previous-version evidence remains accessible separately',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=await createReviewStore(null,root),rec={id:'route',signature:'one',caseId:'',status:'issue'};
  await store.save(p,'user',{...rec},0);await assert.rejects(()=>store.save(p,'user',{...rec},0),/变化/);
  assert.deepEqual(await store.read(p,'other'),[]);const old=await store.read(p,'user');
  assert.equal(reviewFor({...rec,signature:'two'},new Map([['route',old]])).status,'stale');
});
test('a saved full trace can be looked up at its new rank after a new branch, even above JS safe integer',()=>{
  const {witnessKey}=require('../lib/flow-routes');
  const nodes=[n('s','start'),business('done')],edges=[];let last='s';
  for(let i=0;i<57;i++){const d='d'+i,m='m'+i;nodes.push(n(d,'decision'),n(m,'step'));edges.push(e(last,d),e(d,m,'yes'+i),e(d,m,'no'+i));last=m;}
  edges.push(e(last,'done'));const flow=f('f',nodes,edges),make=()=>selectRoutes(buildRoutes([flow],p));
  const before=make(),rank=before.count-2n,row=before.at(rank,true),record={root:row.root,id:row.id,witness:row.steps.map(witnessKey)};
  assert.equal(before.locate(record),rank);
  nodes.push(business('other'));edges.unshift(e('d0','other','new'));
  const next=make(),moved=next.locate(record);assert.equal(moved,rank+1n);assert.equal(next.at(moved).id,row.id);
  edges.splice(edges.findIndex(e=>e.id==='no0'),1);assert.equal(make().locate(record),undefined);
});
test('version comparison distinguishes business edits and removed edges from layout movement',()=>{
  const {compareVersions}=require('../lib/flow-route-service');
  const a={revision:1,flows:[f('f',[n('s','start'),business('end')],[e('s','end')])]},b=structuredClone(a);
  b.revision++;b.flows[0].nodes[0].x=180;assert.equal(compareVersions(a,b).changes.length,0);
  b.flows[0].nodes[1].label='资金已核平';b.flows[0].edges=[];const diff=compareVersions(a,b);
  assert.deepEqual(diff.changes.map(c=>[c.kind,c.change]),[['节点','修改'],['连线','移除']]);
});
test('an early asynchronous sibling cannot become the stated condition for the business outcome',()=>{
  const flow=f('f',[n('s','start'),n('split','gateway',{gatewayMode:'split'}),n('settle','decision'),n('ack','decision'),business('done'),n('worker-exit','end',{endScope:'execution'})],
    [e('s','split'),e('split','settle'),e('split','ack'),e('settle','done','balance','资金一致'),e('ack','worker-exit','log','已记日志')]);
  const r=selectRoutes(buildRoutes([flow],p,{rules:{endings:[{flowId:'f',nodeId:'worker-exit',status:'benign',reason:'线程退出'}]}})).at(0,true);
  assert.equal(r.status,'closed');assert.deepEqual(r.via,['资金一致']);assert.ok(r.steps.some(s=>s.label==='已记日志'));
});
test('only approved test bindings can run and personal filters keep the route identity',async t=>{
  const {Readable}=require('node:stream'),root=fs.mkdtempSync(path.join(os.tmpdir(),'route-bind-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,p),{recursive:true});
  fs.writeFileSync(path.join(root,p,'路线核验规则.json'),JSON.stringify({cases:[{id:'paid',when:'paid',flowId:'f',nodeId:'end',expected:'paid',assertions:[{field:'count',value:1}]}]}));
  const workspace={revision:1,references:[],flows:[f('f',[n('s','start'),business('end')],[e('s','end')])]};
  let result,executed,ready=true;
  const handler=await require('../lib/flow-route-service').createRouteService({db:null,root,store:{read:async()=>({workspace})},accessMode:'local',
    tests:{links:async()=>({links:[{id:'link',name:'paid',projectId:'1',branchId:'2',type:'case',resourceId:'3'}]}),
      executor:{environments:async()=>[{id:'safe',name:'test',business:true,ready,resourceKeys:['1:2:case:3']},{id:'other',business:false,ready:true,resourceKeys:['1:2:case:3']}]},
      start:async(p,body)=>{executed=body;return {id:'stub',status:'queued'};}},sendJson:(_,code,data)=>{result={code,data};}});
  async function api(endpoint,query={},body){
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=body?'POST':'GET';req.accountAccess={user:{id:'qa'},canEdit:true};
    req.headers={host:'localhost',origin:'http://localhost','x-design-client':'workbench-v1','content-type':'application/json'};
    await handler(req,{},new URL('http://localhost/api/flow-routes'+endpoint+'?'+new URLSearchParams({path:p,...query})));return result;
  }
  const row=(await api('',{detail:'1'})).data.row,payload={rank:'0',id:row.id,signature:row.signature,revision:1,options:{view:'queue'},caseId:'paid',expected:0};
  assert.equal((await api('/drivers')).data.items.length,1);
  assert.equal((await api('/binding',{}, {...payload,linkId:'link',environmentId:'other'})).code,409);
  assert.equal((await api('/binding',{}, {...payload,linkId:'link',environmentId:'safe'})).code,200);
  ready=false;assert.equal((await api('/run',{},payload)).code,409);assert.equal(executed,undefined);ready=true;
  assert.equal((await api('/run',{},payload)).code,202);assert.deepEqual(executed.routeAudit,{id:row.id,signature:row.signature,caseId:'paid'});
  const review={...payload,caseId:'',options:{view:'queue',review:'pending'},status:'issue',note:'金额待补'};
  assert.equal((await api('/review',{},review)).code,200);
  assert.equal((await api('',{review:'pending'})).data.count,'0');
  const flagged=(await api('',{review:'issue'})).data;assert.equal(flagged.progress.reviewed,1);assert.equal(flagged.rows[0].id,row.id);
  assert.equal((await api('',{record:row.id,signature:row.signature})).data.rank,'0');
});
test('a missing local test attachment is visible without disabling traversal',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,p),{recursive:true});fs.writeFileSync(path.join(root,p,'路线核验规则.json'),JSON.stringify({offlineFile:'removed.json',cases:[]}));
  const rules=readRules(root,p);assert.match(rules.issues[0].message,/证据文件/);
  assert.equal(selectRoutes(buildRoutes([f('main',[n('s','start'),business('end')],[e('s','end')])],p,{rules})).count,1n);
});
test('current mode excludes a proposed receiver even when reached via an unstyled cross-flow port',()=>{
  const main=f('a',[n('in','start'),n('out','output',{target:ref('b','read')})],[e('in','out')]),child=f('b',[n('read','input',{supplement:true,source:ref('a','out')}),business('end')],[e('read','end')]);
  const model=buildRoutes([main,child],p,{mode:'current'}),r=selectRoutes(model).at(0,true);
  assert.equal(r.status,'planned');assert.equal(r.hasProposal,false);assert.equal(r.steps.some(s=>s.ref.flowId==='b'),false);
  assert.equal(selectRoutes(buildRoutes([main,child],p)).at(0).status,'closed');
});
test('order closure and an independent technical end are traceable on the same route',()=>{
  const flow=f('f',[n('s','start'),n('fork','gateway',{gatewayMode:'split'}),business('settled'),n('ack','end',{endScope:'execution'})],[e('s','fork'),e('fork','settled'),e('fork','ack')]);
  const r=selectRoutes(buildRoutes([flow],p)).at(0,true);assert.equal(r.title,'settled');assert.equal(r.status,'closed');
  assert.deepEqual(r.outcomes.map(o=>o.status),['closed','local']);
});
