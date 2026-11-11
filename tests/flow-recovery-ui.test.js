const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const assets=path.join(__dirname,'../public/assets');
const helpers=import(pathToFileURL(path.join(assets,'flow-links.mjs')));
const toUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const textUrl=toUrl(fs.readFileSync(path.join(assets,'flow-text.js'),'utf8'));
const geometryUrl=toUrl(fs.readFileSync(path.join(assets,'flow-geometry.js'),'utf8').replace("'./flow-text.js'",JSON.stringify(textUrl)));
const formatUrl=pathToFileURL(path.join(assets,'flow-mermaid-format.mjs')).href;
const mermaid=import(toUrl(fs.readFileSync(path.join(assets,'flow-mermaid.js'),'utf8').replaceAll('"./flow-mermaid-format.mjs"',JSON.stringify(formatUrl)).replace('"./flow-geometry.js"',JSON.stringify(geometryUrl))));
const ref={entryPath:'业务/通知',flowId:'scheduler',nodeId:'tick'};
const source={entryPath:ref.entryPath,id:'retry',name:'通知',nodes:[{id:'end',type:'end',endScope:'execution',label:'保存时间',x:30,y:60,pageId:'',recovery:ref}],edges:[]};
const scheduler={entryPath:ref.entryPath,id:ref.flowId,name:'定时回扫',nodes:[{id:'tick',type:'event',eventType:'timer',eventPhase:'trigger',label:'到期触发',x:0,y:0,pageId:''}],edges:[]};
test('shared cross-flow navigation locates targets and retains legacy associations',async()=>{
 const {resolveFlowTarget,flowSources}=await helpers;
 const other=structuredClone(source);other.id='second';other.nodes[0].id='save-error';
 const catalog=[source,other,scheduler],before=structuredClone(catalog);
 assert.equal(resolveFlowTarget(catalog,ref).node.id,'tick');
 assert.deepEqual(flowSources(catalog,ref).map(n=>[n.flowId,n.nodeId]),[['retry','end'],['second','save-error']]);
 assert.deepEqual(catalog,before);
 assert.equal(resolveFlowTarget(catalog,{...ref,nodeId:'missing'}),null);
 const changed=structuredClone(scheduler);changed.nodes[0].type='input';assert.equal(resolveFlowTarget([source,changed],ref).node.type,'input');
});
test('Mermaid roundtrip preserves recovery separately from sequence, source and output relations',async()=>{
 const {serializeMermaid,parseMermaid}=await mermaid;
 const text=serializeMermaid(source),parsed=parseMermaid(text,source);
 assert.match(text,/%% workbench-recovery/);
 assert.deepEqual(parsed.nodes[0],source.nodes[0]);assert.deepEqual(parsed.edges,[]);
 const imported=parseMermaid(text);assert.deepEqual(imported.nodes[0].recovery,ref);
 assert.equal(imported.nodes[0].type,'end');assert.equal(imported.nodes[0].target,undefined);
 assert.throws(()=>parseMermaid(text+'\n%% workbench-recovery {"id":"absent","recovery":'+JSON.stringify(ref)+'}'),/不存在/);
});

 test('ordinary output to a timer uses the same shape metadata and association as every other output',async()=>{
 const {nodeTarget,resolveFlowTarget,flowSources}=await helpers;
 const {serializeMermaid,parseMermaid}=await mermaid;
 const common=structuredClone(source);common.nodes[0]={...common.nodes[0],type:'output',target:ref};delete common.nodes[0].recovery;delete common.nodes[0].endScope;
 const text=serializeMermaid(common),parsed=parseMermaid(text,common);
 assert.match(text,/workbench-output/);assert.doesNotMatch(text,/workbench-recovery/);
 assert.deepEqual(parsed.nodes[0],common.nodes[0]);assert.deepEqual(parsed.edges,[]);
 assert.equal(resolveFlowTarget([common,scheduler],nodeTarget(common.nodes[0])).node.id,'tick');
 assert.equal(flowSources([common,scheduler],ref)[0].nodeId,'end');
 });
