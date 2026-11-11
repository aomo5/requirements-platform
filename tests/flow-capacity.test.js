"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { validateContent, createFlowHandler, createFlowStore } = require('../lib/flow-store');
const { LIMITS } = require('../lib/mysql-storage');
const topic = '00-测试/流程数量边界';
const node = id => ({id,type:'step',label:id,x:0,y:0,pageId:''});
const content = count => ({applicability:'needed',reason:'',references:[],flows:Array.from({length:count},(_,i)=>({id:`f${i}`,name:`流程${i}`,description:'',parent:null,nodes:[node('n0')],edges:[]}))});

test('22 and 40 flows are accepted by server and editor draft recovery; 41 is rejected',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/assets/flow.js'),'utf8');
  const from=source.indexOf('function safeDraftContent('),to=source.indexOf('function recoverDraft(',from);
  assert.ok(from>=0&&to>from);
  const context=vm.createContext({});vm.runInContext(source.slice(from,to),context);
  for(const count of [22,40]) {
    assert.equal(validateContent(content(count),topic).flows.length,count);
    assert.equal(context.safeDraftContent(content(count)),true);
  }
  assert.throws(()=>validateContent(content(41),topic),/最多保存 40 个流程/);
  assert.equal(context.safeDraftContent(content(41)),false);
});

test('per-flow limits remain 100 nodes and 200 edges',()=>{
  const data=content(1),flow=data.flows[0];
  flow.nodes=Array.from({length:100},(_,i)=>node(`n${i}`));
  flow.edges=Array.from({length:200},(_,i)=>({id:`e${i}`,source:'n0',target:'n1',label:''}));
  assert.equal(validateContent(data,topic).flows[0].nodes.length,100);
  flow.nodes.push(node('n100'));assert.throws(()=>validateContent(data,topic),/最多 100 个节点/);flow.nodes.pop();
  flow.edges.push({id:'e200',source:'n0',target:'n1',label:''});assert.throws(()=>validateContent(data,topic),/最多 200 条连线/);
});

test('flow HTTP request limit remains exactly 2 MiB',async()=>{
  const limit=2*1024*1024,base=JSON.stringify({...content(22),expectedRevision:0});
  let writes=0,result;
  const handler=createFlowHandler({save:async(p,revision,value)=>{writes++;return validateContent(value,p);}},(_,status,body)=>{result={status,body};});
  const request=length=>{
    const req=Readable.from([Buffer.from(base+' '.repeat(length-Buffer.byteLength(base)))]);
    req.method='PUT';req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'127.0.0.1:8125',origin:'http://127.0.0.1:8125','content-type':'application/json','x-design-client':'workbench-v1'};
    return req;
  };
  const url=new URL('/api/flows?'+new URLSearchParams({path:topic}),'http://127.0.0.1:8125');
  await handler(request(limit),{},url);assert.equal(result.status,200);assert.equal(writes,1);
  await handler(request(limit+1),{},url);assert.equal(result.status,413);assert.match(result.body.error,/最多 2 MB/);assert.equal(writes,1);
  assert.equal(LIMITS.flow,limit);
});

test('40 valid graphs still cannot bypass the 2 MiB persisted workspace limit',()=>{
  const data=content(40);
  for(const flow of data.flows) {
    flow.nodes=Array.from({length:100},(_,i)=>({...node(`n${i}`),label:'x'.repeat(200)}));
    flow.edges=Array.from({length:200},(_,i)=>({id:`e${i}`,source:'n0',target:'n1',label:'x'.repeat(200)}));
  }
  assert.equal(validateContent(data,topic).flows.length,40);
  assert.ok(Buffer.byteLength(JSON.stringify(data,null,2))>2*1024*1024);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-flow-capacity-')),entry={path:topic,feature:'流程数量边界'};
  try {
    const store=createFlowStore(root,p=>p===topic?entry:null,()=>[entry]);
    assert.throws(()=>store.save(topic,0,data),error=>error.status===413&&/最多 2 MB/.test(error.message));
    assert.equal(store.read(topic).workspace.revision,0);
    assert.deepEqual(fs.readdirSync(root),[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
