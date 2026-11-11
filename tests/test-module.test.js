'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarize,nativeReport,businessEvidenceComplete,ApifoxExecutor}=require('../lib/test-executor'),{TestModule,createTestHandler}=require('../lib/test-module');
const {fixture}=require('./document-fixture');
test('business evidence accepts one scenario and the complete multi-scenario set',()=>{
 const runId='evidence-qa-run';
 const evidence=names=>({runId,results:names.map(scenario=>({scenario,runId,executed:true,database:'demo_testing',cleanupCompleted:true}))});
 const card=['FORM-001'],refunds=['SAVE-001','SAVE-002','ACCESS-001'];
 assert.equal(businessEvidenceComplete(card,evidence(card),runId,'demo_testing'),true);
 assert.equal(businessEvidenceComplete(refunds,evidence([...refunds].reverse()),runId,'demo_testing'),true);
});
test('business evidence rejects invalid expectations and duplicate, missing or extra results',()=>{
 const runId='evidence-qa-run',expected=['SAVE-001','SAVE-002','ACCESS-001'];
 const valid={runId,results:expected.map(scenario=>({scenario,runId,executed:true,database:'demo_testing',cleanupCompleted:true}))};
 for(const names of [undefined,[],[''],[' '],['FORM-001', 'FORM-001'],[123],new Array(1)]){
  const results=Array.isArray(names)?Array.from(names,scenario=>({...valid.results[0],scenario})):valid.results;
  assert.equal(businessEvidenceComplete(names,{runId,results},runId,'demo_testing'),false);
 }
 const duplicate=structuredClone(valid);duplicate.results[2]=structuredClone(duplicate.results[0]);
 const missing=structuredClone(valid);missing.results.pop();
 const extra=structuredClone(valid);extra.results.push({...extra.results[0],scenario:'FORM-001'});
 const unknown=structuredClone(valid);unknown.results[2].scenario='FORM-001';
 for(const evidence of [undefined,{runId},duplicate,missing,extra,unknown])assert.equal(businessEvidenceComplete(expected,evidence,runId,'demo_testing'),false);
});
test('business evidence requires this run, real execution, the test database and successful cleanup',()=>{
 const runId='evidence-qa-run',expected=['FORM-001'];
 const valid={runId,results:[{scenario:expected[0],runId,executed:true,database:'demo_testing',cleanupCompleted:true}]};
 const wrongEnvelope=structuredClone(valid);wrongEnvelope.runId='another-run';
 assert.equal(businessEvidenceComplete(expected,wrongEnvelope,runId,'demo_testing'),false);
 for(const patch of [{runId:'another-run'},{executed:false},{executed:1},{database:'other-database'},{cleanupCompleted:false},{cleanupCompleted:undefined}]){
  const evidence=structuredClone(valid);Object.assign(evidence.results[0],patch);
  assert.equal(businessEvidenceComplete(expected,evidence,runId,'demo_testing'),false);
 }
 assert.equal(businessEvidenceComplete(expected,valid,'','demo_testing'),false);
});
test('report verdict requires real counts, assertions, complete execution and a report identity',()=>{
 const valid={reportId:123,result:{stats:{steps:{total:3,passed:3,failed:0},assertions:{total:5,passed:5,failed:0}},executions:[],failures:[]}};
 assert.equal(summarize(valid).status,'passed');
 for(const alter of [r=>r.result.stats.steps.total=0,r=>r.result.stats.assertions.total=0,r=>delete r.reportId,r=>r.result.stats.steps.passed=2,r=>r.result.stats.steps.skipped=1,r=>r.result.stats.steps.passed=4]){const r=structuredClone(valid);alter(r);assert.equal(summarize(r).status,'incomplete');}
 const failed=structuredClone(valid);failed.result.executions=[{name:'累计仍为5分',passed:false,request:{headers:{token:'secret'}},assertions:[{name:'金额',passed:false,message:'secret'}]}];
 const verdict=summarize(failed);assert.equal(verdict.status,'failed');assert.equal(verdict.failedSteps[0].name,'累计仍为5分');assert.ok(!JSON.stringify(verdict).includes('secret'));
 assert.equal(summarize({done:true}).status,'incomplete');
 assert.equal(summarize({result:{stats:{steps:{total:3,failed:3,passed:0},assertions:{total:3,failed:3}},failures:[{at:'request',error:{code:'ECONNREFUSED'}}]}}).status,'failed');
});
test('association revisions, fixed rule identities, independent runs and read-only status survive storage',async()=>{
 const f=await fixture();try{
  const doc=await f.db.saveDocument(f.p,0,f.content);
  let invoked=0;
  const executor={environments:async()=>[{id:'test',name:'受控测试库'}],resource:async b=>({type:'suite',projectId:'102',branchId:'103',resourceId:b.resourceId,name:'保存与访问回归',url:'https://app.apifox.com/project/102'}),prepare:async()=>{throw Object.assign(Error('缺少测试设备'),{status:409});},run:async()=>{invoked++;}};
  const m=new TestModule(f.db,executor);await m.init();
  const body={expectedRevision:0,type:'suite',resourceId:'123',ruleIds:[doc.rules[0].blockId]};
  const linked=await m.link(f.p,body);assert.equal(linked.revision,1);
  await assert.rejects(m.link(f.p,body),e=>e.status===409);
  await assert.rejects(m.link(f.p,{...body,expectedRevision:1,ruleIds:['title-not-id']}),e=>e.status===400);
  const r1=await m.start(f.p,{linkId:linked.links[0].id,environmentId:'test'},{id:'user',displayName:'示例成员'});
  await assert.rejects(m.start(f.p,{linkId:linked.links[0].id,environmentId:'test'}),e=>e.status===409);
  while(m.active)await new Promise(r=>setTimeout(r,10));
  let data=await m.list(f.p);assert.equal(data.runs[0].status,'blocked');assert.equal(data.runs[0].reason,'缺少测试设备');assert.equal(invoked,0);
  await m.list(f.p);assert.equal(invoked,0);
  const r2=await m.start(f.p,{linkId:linked.links[0].id,environmentId:'test'});assert.notEqual(r1.id,r2.id);
  while(m.active)await new Promise(r=>setTimeout(r,10));
  assert.equal((await m.list(f.p)).runs.length,2);
  let response;const handler=createTestHandler(m,(_,status,body)=>response={status,body});
  const url=new URL('http://localhost/api/tests/runs?'+new URLSearchParams({path:f.p}));
  await handler({method:'POST',accountAccess:{canEdit:false},socket:{remoteAddress:'127.0.0.1'},headers:{}},{},url);assert.equal(response.status,403);
  await handler({method:'GET',accountAccess:{canEdit:false}},{},new URL('http://localhost/api/tests?'+new URLSearchParams({path:f.p})));assert.equal(response.status,200);assert.equal(response.body.runs.length,2);
  await m.unlink(f.p,{linkId:linked.links[0].id,expectedRevision:1});assert.equal((await m.list(f.p)).runs.length,2);
 }finally{await f.close();}
});

test('native report links reject foreign domains and projects',()=>{
 assert.deepEqual(nativeReport('报告 https://app.apifox.com/link/project/102/api-test/test-report/104','102'),{reportId:'104',reportUrl:'https://app.apifox.com/link/project/102/api-test/test-report/104'});
 assert.deepEqual(nativeReport('https://evil.test/link/project/102/api-test/test-report/104','102'),{});
 assert.deepEqual(nativeReport('https://app.apifox.com/link/project/1020/api-test/test-report/104','102'),{});
});
test('native failures retain step identity and connection error without request credentials',()=>{
 const verdict=summarize({reportId:104,result:{stats:{steps:{total:3,passed:0,failed:3},assertions:{total:3,passed:0,failed:3}},stepTree:[{id:'step',name:'专用驱动前置检查'}],failures:[{at:'request',cursor:{ref:'step'},error:{name:'Error',code:'ECONNREFUSED',message:'secret'}}]}});
 assert.equal(verdict.status,'failed');assert.equal(verdict.failedSteps[0].name,'专用驱动前置检查');assert.equal(verdict.failedSteps[0].code,'ECONNREFUSED');assert.ok(!JSON.stringify(verdict).includes('secret'));
});
test('executor times out a hung process and does not forward database credentials',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-executor-'));
 try{const cli=path.join(dir,'cli.js');fs.writeFileSync(cli,"if(process.argv[2]==='wait')setInterval(()=>{},1000);else console.log(process.env.DB_PASSWORD?'leaked':'safe');");
  const ex=new ApifoxExecutor({cli,root:path.join(dir,'runtime'),configFile:path.join(dir,'missing')});
  assert.equal((await ex.command(['env'])).out.trim(),'safe');
  await assert.rejects(ex.command(['wait'],{timeout:30}),/执行超时/);assert.equal(ex.children.size,0);assert.deepEqual(fs.readdirSync(path.join(dir,'runtime')),[]);
  ex.stop();await assert.rejects(ex.command([]),/停止/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('executor captures complete regular-file stdout before an immediate exit and removes private files',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-executor-flush-'));
 try{
  const cli=path.join(dir,'cli.js'),root=path.join(dir,'runtime');
  fs.writeFileSync(cli,"const fs=require('node:fs');const capture=fs.readdirSync('.').find(x=>x.startsWith('.apifox-command-'));process.stdout.write(JSON.stringify({payload:'x'.repeat(100*1024),regular:fs.fstatSync(1).isFile(),fileMode:fs.fstatSync(1).mode&511,directoryMode:fs.statSync(capture).mode&511}));process.exit(0);");
  const ex=new ApifoxExecutor({cli,root,configFile:path.join(dir,'missing')});
  const result=await ex.command([]),body=JSON.parse(result.out);
  assert.equal(result.code,0);assert.equal(body.payload.length,100*1024);assert.equal(body.regular,true);assert.equal(body.fileMode,0o600);assert.equal(body.directoryMode,0o700);
  assert.deepEqual(fs.readdirSync(root),[]);assert.equal(ex.children.size,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('executor cleans private stdout after nonzero exit, oversized output, stop and spawn argument errors',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-executor-cleanup-'));
 try{
  const cli=path.join(dir,'cli.js'),root=path.join(dir,'runtime');
  fs.writeFileSync(cli,"if(process.argv[2]==='large'){process.stdout.write('x'.repeat(8*1024*1024+1));process.exit(0);}if(process.argv[2]==='wait')setInterval(()=>{},1000);else{process.stdout.write('deliberate failure');process.exit(7);}");
  const ex=new ApifoxExecutor({cli,root,configFile:path.join(dir,'missing')});
  assert.deepEqual(await ex.command(['fail']),{code:7,out:'deliberate failure'});assert.deepEqual(fs.readdirSync(root),[]);
  await assert.rejects(ex.command(['large']),/读取限制/);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(ex.children.size,0);
  ex.cli='invalid\0path';await assert.rejects(ex.command([]),/null bytes/);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(ex.children.size,0);ex.cli=cli;
  const waiting=ex.command(['wait']);while(!ex.children.size)await new Promise(r=>setTimeout(r,5));ex.stop();
  await assert.rejects(waiting,/停止/);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(ex.children.size,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('resource parsing failures do not infer that the CLI account logged out',async()=>{
 const ex=new ApifoxExecutor({cli:'unused',root:'/tmp',configFile:'unused'});ex.command=async()=>({code:0,out:'{"success":'});
 await assert.rejects(ex.resource({type:'scenario',projectId:'102',branchId:'103',resourceId:'105'}),e=>e.status===503&&e.message==='Apifox资源响应不完整或无法解析，请检查执行器连接');
});
test('environment policy rejects unapproved branches and missing real driver checks before CLI execution',async()=>{
 const ex=new ApifoxExecutor({cli:'unused',root:'/tmp',configFile:'unused'});
 const resource={projectId:'102',branchId:'103',type:'suite',resourceId:'109'};
 ex.command=async()=>{throw Error('CLI must not run');};
 ex.config=async()=>({environments:[{id:'test',ready:true,scope:'preflight',apifoxId:'107',allowedResources:['102:other:suite:109']}]});
 await assert.rejects(ex.prepare(resource,'test'),e=>e.status===403);
 ex.config=async()=>({environments:[{id:'test',ready:true,scope:'business',database:'demo_testing',apifoxId:'107',allowedResources:['102:103:suite:109']}]});
 await assert.rejects(ex.prepare(resource,'test'),e=>e.status===409&&e.message.includes('检查地址'));
});

test('CLI merged null zero counters require complete passing steps and explicit empty failures',()=>{
 const raw={reportId:1,result:{stats:{steps:{total:6,passed:6,failed:0},assertions:{total:9,passed:null,failed:null}},failures:[]}};
 assert.equal(summarize(raw).status,'passed');
 const partial=structuredClone(raw);partial.result.stats.steps.passed=3;assert.equal(summarize(partial).status,'incomplete');
 const absent=structuredClone(raw);delete absent.result.failures;assert.equal(summarize(absent).status,'incomplete');
 const failed=structuredClone(raw);failed.result.failures=[{at:'assertion',error:{test:'金额'}}];assert.equal(summarize(failed).status,'failed');
});

test('controlled acceptance keeps the runner error mode that permits final cleanup while retaining failures',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-cleanup-mode-'));
 try{
  const ex=new ApifoxExecutor({cli:'unused',root:dir,configFile:'unused'});
  ex.command=async(args,{cwd})=>{
   assert.equal(args[args.indexOf('--on-error')+1],'ignore');
   fs.writeFileSync(path.join(cwd,'result.json'),JSON.stringify({reportId:123,result:{stats:{steps:{total:3,passed:2,failed:1},assertions:{total:2,passed:1,failed:1}},failures:[{at:'assertion',error:{test:'业务结果'}}]}}));
   return {code:0,out:'https://app.apifox.com/link/project/102/api-test/test-report/123'};
  };
  const result=await ex.run({resource:{type:'scenario',resourceId:'106',projectId:'102',branchId:'103'},environment:{apifoxId:'108',scope:'preflight',onError:'ignore'}},'cleanup-test');
  assert.equal(result.status,'failed');assert.equal(result.assertions.failed,1);assert.equal(fs.existsSync(path.join(dir,'cleanup-test')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
