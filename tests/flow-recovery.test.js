'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validateContent,validateRelations} = require('../lib/flow-store');
const {createBundle,checkBundle,applyOperations,payloadForApply} = require('../lib/flow-edit-model');
const {validateBundleReferences} = require('../lib/flow-batch');
const topic='测试/订单', external='测试/调度';
const ref={entryPath:topic,flowId:'timer',nodeId:'tick'};
const n=(id,type,extra={})=>({id,type,label:id,x:0,y:0,pageId:'',...extra});
const flow=(id,nodes)=>({id,name:id,description:'',parent:null,nodes,edges:[]});
const workspace=flows=>({schemaVersion:1,revision:1,updatedAt:null,applicability:'needed',reason:'',flows,references:[]});
const wait=()=>flow('retry',[n('wait','end',{endScope:'execution',recovery:{...ref}}),n('save-failed','step',{recovery:{...ref}})]);
const timer=()=>flow('timer',[n('tick','event',{eventType:'timer',eventPhase:'trigger'})]);
const notes={schemaVersion:1,revision:0,updatedAt:null,notes:[]};
const bundle=()=>createBundle('http://localhost:8125',topic,workspace([wait(),timer()]),notes);
function save(before,after,externals=[]) {
  return validateRelations({entry:{path:topic}},before,validateContent(after,topic),{entries:[{entry:{path:topic},workspace:before},...externals.map(e=>({entry:{path:e.entryPath},workspace:e.workspace}))],issues:[]});
}
test('multiple waiters retain execution ends and share a trigger without adding sequence edges',()=>{
 const b=bundle(); assert.deepEqual(checkBundle(b).errors,[]);
 const after=payloadForApply(b).workspace;
 assert.deepEqual(after.flows[0].nodes[0].recovery,ref);
 assert.equal(after.flows[0].nodes[0].endScope,'execution');
 assert.deepEqual(after.flows.flatMap(f=>f.edges),[]);
 assert.doesNotThrow(()=>save(workspace([]),after));
 const changed=applyOperations(b,[{op:'node.update',flowId:'retry',id:'wait',unset:['recovery']}]);
 assert.equal(payloadForApply(changed).workspace.flows[0].nodes[0].recovery,undefined);
 assert.deepEqual(payloadForApply(changed).workspace.flows[0].nodes[1].recovery,ref);
});
test('missing targets, ordinary steps and intermediate events cannot be recovery triggers',()=>{
 for (const [code,mutate] of [
  ['RECOVERY_TARGET',b=>b.draft.workspace.flows.pop()],
  ['RECOVERY_TRIGGER',b=>{const n=b.draft.workspace.flows[1].nodes[0];n.type='step';delete n.eventType;delete n.eventPhase;}],
  ['RECOVERY_TRIGGER',b=>b.draft.workspace.flows[1].nodes[0].eventPhase='intermediate'],
  ['RECOVERY_TRIGGER',b=>b.draft.workspace.flows[1].nodes[0].eventType='unspecified'],
 ]) {const b=bundle();mutate(b);assert.ok(checkBundle(b).errors.some(e=>e.code===code));assert.throws(()=>save(b.base.workspace,b.draft.workspace),/异步恢复关联/);}
});
test('REST and atomic batch both protect trigger deletion and type changes across topics',()=>{
 const before=workspace([timer()]),other={entryPath:external,workspace:workspace([wait()])};
 for(const mutate of [w=>w.flows=[],w=>w.flows[0].nodes=[],w=>w.flows[0].nodes[0].eventPhase='intermediate',w=>w.flows[0].nodes[0].eventType='unspecified']) {
  const after=structuredClone(before);mutate(after);
  assert.throws(()=>save(before,after,[other]),/异步恢复关联/);
  assert.throws(()=>validateBundleReferences(topic,before,after,[],[],[other]),/失效的流程承接/);
 }
});
test('same-flow recovery works, while self references, malformed references and final business ends fail',()=>{
 const f=timer();f.nodes.push(n('wait','end',{endScope:'execution',recovery:ref}));
 assert.doesNotThrow(()=>save(workspace([]),workspace([f])));
 for(const mutate of [n=>n.recovery.nodeId='',n=>n.recovery.extra=true,n=>n.endScope='business',n=>n.endScope='terminate']) {
  const b=bundle();mutate(b.draft.workspace.flows[0].nodes[0]);assert.ok(checkBundle(b).errors.length);
 }
 const self=timer();self.nodes[0].recovery=ref;
 assert.throws(()=>validateContent(workspace([self]),topic),/其他具体触发/);
});
test('existing broken references stay visible without blocking unrelated edits; new external references are verified by server',()=>{
 const b=bundle();b.base.workspace.flows.pop();b.draft=structuredClone(b.base);b.draft.workspace.flows[0].name='改名';
 assert.deepEqual(checkBundle(b).errors,[]);assert.ok(checkBundle(b).warnings.some(w=>w.code==='RECOVERY_TARGET'));
 assert.doesNotThrow(()=>save(b.base.workspace,b.draft.workspace));
 const fresh=bundle();fresh.draft.workspace.flows[0].nodes[0].recovery.entryPath=external;
 assert.deepEqual(checkBundle(fresh).errors,[]);
 assert.throws(()=>save(fresh.base.workspace,fresh.draft.workspace),/异步恢复关联/);
 assert.doesNotThrow(()=>save(fresh.base.workspace,fresh.draft.workspace,[{entryPath:external,workspace:workspace([timer()])}]));
});

test('ordinary cross-flow outputs to timer entries preserve metadata and protect referenced nodes',()=>{
 const data=workspace([flow('retry',[n('wait','output',{target:{...ref}})]),timer()]);
 assert.doesNotThrow(()=>save(workspace([]),data));
 const b=createBundle('http://localhost:8125',topic,data,notes);
 assert.deepEqual(payloadForApply(b).workspace.flows[0].nodes[0].target,ref);
 assert.equal(payloadForApply(b).workspace.flows[0].nodes[0].recovery,undefined);
 const removed=structuredClone(data);removed.flows.pop();
 assert.throws(()=>save(data,removed),/跨图承接/);
 assert.throws(()=>validateBundleReferences(topic,data,removed,[],[],[]),/流程承接/);
 const externalCaller={entryPath:external,workspace:workspace([data.flows[0]])};
 assert.throws(()=>save(workspace([timer()]),workspace([]),[externalCaller]),/跨图承接/);
 const ordinary=structuredClone(data);ordinary.flows[1].nodes[0]=n('tick','input');
 assert.doesNotThrow(()=>save(data,ordinary)); // The target's own flow defines its execution logic.
});
