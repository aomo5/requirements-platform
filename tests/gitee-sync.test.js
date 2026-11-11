'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {GiteeSync,projectBody}=require('../lib/gitee-sync');
const {GiteeApi}=require('../lib/gitee-api');
const {scanRequirements}=require('../lib/scan');
const {createGiteeHandler}=require('../lib/gitee-handler');
class MemoryStore{
  values=new Map();locked=false;
  async get(k){return structuredClone(this.values.get(k)||null);}
  async put(k,v){this.values.set(k,structuredClone(v));return v;}
  async lock(fn){if(this.locked)throw Object.assign(new Error('已有同步'),{status:409});this.locked=true;try{return await fn();}finally{this.locked=false;}}
}
function fixture(t,{linked=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-gitee-')),p='00-测试/同步需求',file=path.join(root,p,'需求文档.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 const original='# 同步需求\n\n<!-- wb-rule:rule-stable-123 -->\n本地规格\n';fs.writeFileSync(file,original);
 fs.writeFileSync(path.join(root,p,'规格索引.md'),linked?'# 规格索引\n\n主 Gitee 需求编号：IABC12\n':'# 规格索引\n');
 const remote={ident:'IABC12',title:'同步需求',description:'远端原文',program_id:101,state:'open',updated_at:'2026-10-01',comments:[{id:1,content:'原始评审意见',created_at:'2026-10-01'}]};
 let creates=0,updates=0;const api={get:async()=>structuredClone(remote),test:async()=>({read:true,write:'unverified'}),discover:async()=>[],create:async l=>{creates++;remote.description=l.body;remote.title=l.title;return remote.ident;},update:async(i,l)=>{updates++;remote.description=l.body;remote.title=l.title;remote.updated_at+='x';}};
 const store=new MemoryStore(),service=new GiteeSync({root,store,getTree:()=>scanRequirements(root),secretFile:path.join(root,'private/token'),apiFactory:()=>api});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,p,file,original,remote,api,store,service,get creates(){return creates;},get updates(){return updates;}};
}
test('first divergent association requires a reviewed direction; pull preserves local rule IDs and complete comments',async t=>{
 const f=fixture(t),s=f.service;assert.equal((await s.run(f.p)).state,'conflict');assert.equal(f.updates,0);
 const v=await s.preview(f.p);assert.equal(v.action,'conflict');const r=await s.run(f.p,{direction:'pull',review:v.review});assert.equal(r.state,'synced');
 const raw=fs.readFileSync(f.file,'utf8');assert.ok(raw.startsWith(f.original));assert.match(raw,/原始评审意见/);assert.match(raw,/远端原文/);assert.equal(projectBody(raw),projectBody(f.original));
 assert.equal((await s.preview(f.p)).action,'none');assert.equal((await s.run(f.p)).state,'synced');assert.equal(f.updates,0);
});
test('local-only push, remote-only pull and dual changes use the last successful baseline',async t=>{
 const f=fixture(t),s=f.service;await s.run(f.p,{direction:'pull',review:(await s.preview(f.p)).review});
 fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('本地规格','修改的本地规格'));
 assert.equal((await s.list())[0].state,'pending');assert.equal((await s.preview(f.p)).action,'push');assert.equal((await s.run(f.p)).state,'synced');assert.equal(f.updates,1);
 f.remote.description='远端修订';f.remote.updated_at+='x';f.remote.comments.push({id:2,content:'新增补充'});
 assert.equal((await s.preview(f.p)).action,'pull');assert.equal((await s.run(f.p)).state,'synced');assert.match(fs.readFileSync(f.file,'utf8'),/新增补充/);
 fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('修改的本地规格','再次修改本地规格'));f.remote.description='双方改动';f.remote.updated_at+='x';
 assert.equal((await s.run(f.p)).state,'conflict');assert.equal(f.updates,1);
});
test('stale reviewed snapshot refuses overwrite; pre-write remote race is detected',async t=>{
 const f=fixture(t),s=f.service,v=await s.preview(f.p);f.remote.updated_at+='new';
 assert.equal((await s.run(f.p,{direction:'push',review:v.review})).state,'conflict');assert.equal(f.updates,0);
 const fresh=await s.preview(f.p);let reads=0;f.api.get=async()=>{reads++;if(reads===2)f.remote.updated_at+='race';return structuredClone(f.remote);};
 assert.equal((await s.run(f.p,{direction:'push',review:fresh.review})).state,'conflict');assert.equal(f.updates,0);
});
test('unlinked batch never creates; explicit creation is idempotent and unknown outcomes never retry POST',async t=>{
 const f=fixture(t,{linked:false}),s=f.service;assert.equal((await s.run(f.p)).state,'unlinked');assert.equal(f.creates,0);
 const v=await s.preview(f.p);assert.equal((await s.run(f.p,{direction:'create',review:v.review})).state,'synced');assert.equal(f.creates,1);await s.run(f.p);assert.equal(f.creates,1);
 const g=fixture(t,{linked:false});g.api.create=async()=>{throw Object.assign(new Error('timeout'),{status:502});};
 const review=(await g.service.preview(g.p)).review;assert.equal((await g.service.run(g.p,{direction:'create',review})).state,'failed');
 let retries=0;g.api.create=async()=>{retries++;return 'IABC12';};await g.service.run(g.p,{direction:'create',review});assert.equal(retries,0);
 await g.service.link(g.p,'IABC12');assert.equal((await g.service.row(g.p)).createIntent,undefined);
});
test('definite authentication rejection permits a corrected retry, retaining the failure reason',async t=>{
 const f=fixture(t,{linked:false});f.api.create=async()=>{throw Object.assign(new Error('Gitee 凭据无效或已过期（401）'),{status:502,definiteNoWrite:true});};
 const r=await f.service.run(f.p,{direction:'create',review:(await f.service.preview(f.p)).review});assert.equal(r.state,'failed');assert.match(r.error,/401/);assert.equal(r.createIntent,undefined);
});
test('config secrets are server-only, mode 0600, revision checked; destination/token substitution is rejected',async t=>{
 const f=fixture(t),s=f.service,c=await s.publicConfig();
 const input={...c,enterpriseId:'123',enterprisePath:'example',programId:'101',token:'test-private-secret'};const r=await s.saveConfig(input);assert.equal(r.credentialConfigured,true);assert.ok(!JSON.stringify(r).includes(input.token));assert.ok(!JSON.stringify([...f.store.values]).includes(input.token));assert.equal(fs.statSync(s.secretFile).mode&0o777,0o600);
 await assert.rejects(s.saveConfig(input),e=>e.status===409);await assert.rejects(s.saveConfig({...r,apiBase:'https://evil.example/enterprises',token:'x'}),/域名/);
 await assert.rejects(s.saveConfig({...r,enterpriseId:'555'}),/重新提供/);
});
test('jobs preserve per-item failures and continue remaining items',async t=>{
 const f=fixture(t);const p2='00-测试/第二个需求';fs.mkdirSync(path.join(f.root,p2));fs.writeFileSync(path.join(f.root,p2,'需求文档.md'),'第二个');
 const started=await f.service.startJob([f.p,p2]);await started.promise;const job=await f.store.get('job:'+started.job.id);assert.equal(job.done,2);assert.equal(job.state,'done');assert.deepEqual(job.results.map(r=>r.state),['conflict','unlinked']);
});
test('HTTP handler rejects cross-site and remote configuration before touching secrets',async()=>{
 const out=[],handler=createGiteeHandler({publicConfig:async()=>{throw new Error('should not run');}},(r,status,b)=>out.push({status,b}));
 await handler({method:'GET',headers:{host:'localhost:8125'},socket:{remoteAddress:'10.0.0.4'}},{},new URL('http://localhost/api/gitee/config'));assert.equal(out[0].status,403);
 await handler({method:'PUT',headers:{host:'localhost:8125',origin:'https://evil.example'},socket:{remoteAddress:'127.0.0.1'}},{},new URL('http://localhost/api/gitee/config'));assert.equal(out[1].status,403);
});
test('official enterprise adapter uses program_id, Bearer headers, qt=ident and all comment pages',async()=>{
 const requests=[];let commentPage=0;const api=new GiteeApi({apiBase:'https://api.gitee.com/enterprises',enterpriseId:12,programId:101},'private-token',async(url,opts)=>{
  requests.push({url:String(url),opts});let d;
  if(url.pathname.endsWith('/notes')){commentPage++;d={data:commentPage===1?[{id:1,content:'第一条'}]:[{id:2,content:'第二条'}],total_count:2};}
  else if(opts.method==='POST')d={ident:'IABC12'};
  else d={ident:'IABC12',title:'标题',description:'正文',program_id:101,updated_at:'v1'};
  return new Response(JSON.stringify(d));
 });
 const remote=await api.get('IABC12');assert.equal(remote.comments.length,2);assert.match(requests[0].url,/qt=ident/);
 await api.create({title:'标题',body:'正文'},'operation');const last=requests.at(-1);assert.equal(last.opts.headers.Authorization,'Bearer private-token');assert.ok(!last.url.includes('private-token'));assert.equal(JSON.parse(last.opts.body).program_id,101);assert.equal(JSON.parse(last.opts.body).project_id,undefined);
});
test('HTTP errors and permission failures never leak a returned credential body; project mismatch blocks writes',async()=>{
 const c={apiBase:'https://api.gitee.com/enterprises',enterpriseId:12,programId:101};
 const api=new GiteeApi(c,'secret',async()=>new Response('secret echoed by upstream',{status:403}));await assert.rejects(api.get('IABC12'),e=>e.message.includes('403')&&!e.message.includes('secret'));
 const other=new GiteeApi(c,'secret',async()=>new Response(JSON.stringify({ident:'IABC12',title:'x',description:'x',updated_at:'x',program_id:1})));await assert.rejects(other.get('IABC12'),/不属于/);
});
test('nonexistent requirement document can be pulled without losing existing spec index',async t=>{
 const f=fixture(t);fs.unlinkSync(f.file);await f.service.run(f.p,{direction:'pull',review:(await f.service.preview(f.p)).review});assert.match(fs.readFileSync(f.file,'utf8'),/远端原文/);assert.match(fs.readFileSync(path.join(f.root,f.p,'规格索引.md'),'utf8'),/主 Gitee 需求编号/);
});

test('archived revisions retain previously assigned rule IDs, never replace or duplicate a version',async t=>{
 const f=fixture(t),s=f.service;await s.run(f.p,{direction:'pull',review:(await s.preview(f.p)).review});
 const before=fs.readFileSync(f.file,'utf8').replace('远端原文','远端原文 <!-- wb-rule:rule-remote-linked -->');fs.writeFileSync(f.file,before);
 f.remote.description='新远端原文';f.remote.updated_at+='next';await s.run(f.p);
 const after=fs.readFileSync(f.file,'utf8');assert.ok(after.startsWith(before));assert.match(after,/rule-remote-linked/);assert.equal((after.match(/wb-gitee-archive:start/g)||[]).length,2);
 await s.run(f.p);assert.equal(fs.readFileSync(f.file,'utf8'),after);
});

test('outbound Markdown keeps line breaks, tables and lists when removing stable rule markers',()=>{
 const raw='- 第一项 <!-- wb-rule:rule-a -->\n- 第二项 <!-- wb-rule:rule-b -->\n\n| 一 | 二 <!-- wb-rule:rule-c --> |\n';
 assert.equal(projectBody(raw),'- 第一项\n- 第二项\n\n| 一 | 二 |');
});
test('duplicate existing main references block any remote overwrite',async t=>{
 const f=fixture(t),other=path.join(f.root,'00-测试/重复主需求');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'规格索引.md'),'主 Gitee 需求编号：IABC12');
 assert.equal((await f.service.run(f.p)).state,'conflict');assert.equal(f.updates,0);assert.match((await f.service.row(f.p)).error,/多个目录/);
});

test('remote check jobs discover remote-only changes without pushing or pulling content',async t=>{
 const f=fixture(t);await f.service.run(f.p,{direction:'pull',review:(await f.service.preview(f.p)).review});
 const before=fs.readFileSync(f.file,'utf8');f.remote.description='远端独立修改';f.remote.updated_at+='changed';
 const started=await f.service.startJob([f.p],{mode:'check'});await started.promise;
 const job=await f.store.get('job:'+started.job.id);assert.equal(job.results[0].state,'pending');assert.equal((await f.service.list())[0].state,'pending');assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(f.updates,0);
});
