const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assets=path.join(__dirname,'../public/assets');
const modules=import(pathToFileURL(path.join(assets,'flow-modules.mjs')));
const toUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const textUrl=toUrl(fs.readFileSync(path.join(assets,'flow-text.js'),'utf8'));
const geometryUrl=toUrl(fs.readFileSync(path.join(assets,'flow-geometry.js'),'utf8').replace("'./flow-text.js'",JSON.stringify(textUrl)));
const formatUrl=pathToFileURL(path.join(assets,'flow-mermaid-format.mjs')).href;
const mermaid=import(toUrl(fs.readFileSync(path.join(assets,'flow-mermaid.js'),'utf8').replaceAll('"./flow-mermaid-format.mjs"',JSON.stringify(formatUrl)).replace('"./flow-geometry.js"',JSON.stringify(geometryUrl))));
const n=(id,type='step')=>({id,type,label:id,x:0,y:0,pageId:''});
const shared={entryPath:'业务/模块',id:'shared',name:'公共收尾',kind:'module',nodes:[n('entry','input'),n('completed','return'),n('pending','return')],edges:[]};
const caller=(id,receiver)=>({entryPath:'业务/订单',id,name:id,nodes:[{...n('invoke','call'),call:{entryPath:shared.entryPath,flowId:shared.id,nodeId:'entry',returns:[{outputNodeId:'completed',targetNodeId:receiver},{outputNodeId:'pending',targetNodeId:receiver}]}},n(receiver,'decision')],edges:[{id:'edge',source:'invoke',target:receiver,label:''}]});

test('one definition returns to the active caller and never a fixed parent',async()=>{
  const {moduleCallers,resolveModuleReturn}=await modules;
  const a=caller('paid','paid-result'),b=caller('scan','scan-result'),flows=[shared,a,b];
  assert.equal(moduleCallers(flows,shared.entryPath,shared.id).length,2);
  for(const current of [a,b]) {
    const result=resolveModuleReturn(flows,{entryPath:current.entryPath,flowId:current.id,nodeId:'invoke'},shared.entryPath,shared.id,'pending');
    assert.equal(result.flowId,current.id);assert.equal(result.nodeId,current.nodes[1].id);
  }
  assert.equal(resolveModuleReturn(flows,null,shared.entryPath,shared.id,'completed'),null);
  assert.equal(resolveModuleReturn(flows,{entryPath:a.entryPath,flowId:a.id,nodeId:'missing'},shared.entryPath,shared.id,'completed'),null);
});

test('return navigation revalidates changed call bindings, deleted receivers, and absent edges',async()=>{
  const {resolveModuleReturn}=await modules;
  const a=caller('paid','result'),context={entryPath:a.entryPath,flowId:a.id,nodeId:'invoke'};
  const resolve=()=>resolveModuleReturn([shared,a],context,shared.entryPath,shared.id,'completed');
  assert.ok(resolve());a.edges=[];assert.equal(resolve(),null);
  a.edges=[{source:'invoke',target:'result'}];a.nodes[0].call.flowId='different';assert.equal(resolve(),null);
  a.nodes[0].call.flowId=shared.id;a.nodes.splice(1);assert.equal(resolve(),null);
});

test('nested module call keeps inner and outer return contexts separate',async()=>{
  const {resolveModuleReturn}=await modules;
  const inner=caller('outer-module','outer-result');inner.kind='module';inner.entryPath='业务/模块';inner.nodes.push(n('entry','input'),n('finished','return'));
  const outer=caller('business','business-result');outer.nodes[0].call={entryPath:inner.entryPath,flowId:inner.id,nodeId:'entry',returns:[{outputNodeId:'finished',targetNodeId:'business-result'}]};
  const flows=[shared,inner,outer];
  assert.equal(resolveModuleReturn(flows,{entryPath:inner.entryPath,flowId:inner.id,nodeId:'invoke'},shared.entryPath,shared.id,'completed').flowId,inner.id);
  assert.equal(resolveModuleReturn(flows,{entryPath:outer.entryPath,flowId:outer.id,nodeId:'invoke'},inner.entryPath,inner.id,'finished').flowId,outer.id);
  assert.equal(resolveModuleReturn(flows,{entryPath:outer.entryPath,flowId:outer.id,nodeId:'invoke'},shared.entryPath,shared.id,'completed'),null);
});

test('Mermaid preserves shared module kind, call mappings, and return semantics',async()=>{
  const {serializeMermaid,parseMermaid}=await mermaid;
  const a=caller('paid','end');a.direction='TB';
  const text=serializeMermaid(a),parsed=parseMermaid(text,a);
  assert.deepEqual(parsed.nodes.find(n=>n.id==='invoke').call,a.nodes[0].call);
  const imported=parseMermaid(text);
  assert.equal(imported.nodes.find(n=>n.id==='invoke').call.returns[0].targetNodeId,'n_end');
  const moduleParsed=parseMermaid(serializeMermaid(shared),shared);
  assert.equal(moduleParsed.kind,'module');
  assert.equal(moduleParsed.nodes.find(n=>n.id==='completed').type,'return');
  assert.equal(moduleParsed.nodes.find(n=>n.id==='completed').target,undefined);
  assert.equal(moduleParsed.nodes.find(n=>n.id==='entry').source,undefined);
});

test('changing one return destination replaces only obsolete call edges and preserves retained IDs',async()=>{
  const {planModuleCallEdges}=await modules;
  const a=caller('paid','old-result');a.nodes.push(n('pending-result'),n('new-result'));
  a.nodes[0].call.returns[1].targetNodeId='pending-result';
  a.edges.push({id:'kept-edge',source:'invoke',target:'pending-result',label:'资金未决',trace:'branch'});
  const unrelated={id:'unrelated',source:'old-result',target:'pending-result',label:'人工核验'};a.edges.push(unrelated);
  const retained=a.edges[1],before=structuredClone(a);
  const notes=[{id:'note-kept',target:{type:'flow-edge',flowId:a.id,edgeId:'kept-edge'},text:'保留原请求'}];
  const result=planModuleCallEdges(a,'invoke',[{outputNodeId:'completed',targetNodeId:'new-result'},{outputNodeId:'pending',targetNodeId:'pending-result'}],notes,()=> 'new-edge');
  assert.deepEqual(a,before);assert.deepEqual(result.removedIds,['edge']);
  assert.equal(result.edges.find(edge=>edge.id==='kept-edge'),retained);
  assert.equal(result.edges.find(edge=>edge.id==='unrelated'),unrelated);
  assert.deepEqual(result.edges.find(edge=>edge.id==='new-edge'),{id:'new-edge',source:'invoke',target:'new-result',label:'本次调用返回'});
});

test('annotated obsolete return edges and unrelated outgoing edges must be handled explicitly',async()=>{
  const {planModuleCallEdges}=await modules;
  const a=caller('paid','old-result');a.nodes.push(n('new-result'));
  const returns=[{outputNodeId:'completed',targetNodeId:'new-result'},{outputNodeId:'pending',targetNodeId:'new-result'}];
  const note={target:{type:'flow-edge',flowId:a.id,edgeId:'edge'},text:'原业务含义'};
  assert.throws(()=>planModuleCallEdges(a,'invoke',returns,[note],()=> 'new'),/元素说明/);
  assert.throws(()=>planModuleCallEdges(a,'invoke',returns,undefined,()=> 'new'),/无法确认/);
  a.nodes[0].call.returns=[];
  assert.throws(()=>planModuleCallEdges(a,'invoke',returns,[],()=> 'new'),/非原返回映射/);
});
