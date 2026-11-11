'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {Accounts}=require('../lib/accounts'),{MysqlStorage}=require('../lib/mysql-storage'),{scanRequirements}=require('../lib/scan');
const {backup,migrate}=require('../lib/storage-transfer');
test('accounts protect every requirement write while retaining team reads and independent creation',{skip:process.env.DB_NAME!=='requirements_workbench_ownerqa',timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-owners-')),p='00-测试/原有需求';fs.mkdirSync(path.join(root,p),{recursive:true});fs.writeFileSync(path.join(root,p,'需求文档.md'),'# 原有需求\n\n只有创建者可以编辑。\n');
 const db=new MysqlStorage(root,()=>scanRequirements(root));let server;
 try{
  await db.init({allowUnmigrated:true});const b=root+'-backup';backup(root,b);await migrate(db,b);
  const accounts=new Accounts(db.pool);await accounts.init();
  await assert.rejects(accounts.create({username:'early',password:'test-password-2026'}),{status:409});
  const setupFile=path.join(root,'setup.json');fs.writeFileSync(setupFile,JSON.stringify({username:'owner',displayName:'原创建者',token:'test-setup-token'}),{mode:0o600});
  const {createEntryService}=require('../lib/entry-create');
  const failedCreate=createEntryService(root,{persistDocuments:false,register:entry=>db.registerEntryDocuments(entry,{afterWrite:async()=>{throw Error('injected ownership failure');}})});
  await assert.rejects(failedCreate({module:'00-测试',name:'故障需求',content:'用于事务回滚'}),/injected ownership failure/);
  const [[failed]]=await db.pool.execute('SELECT COUNT(*) AS n FROM wb_entries WHERE path=?',['00-测试/故障需求']);assert.equal(failed.n,0);assert.equal(fs.existsSync(path.join(root,'00-测试/故障需求')),false);
  fs.mkdirSync(path.join(root,p,'原型设计'),{recursive:true});fs.writeFileSync(path.join(root,p,'原型设计','demo.html'),'<h1>独立原型</h1>');
  let logs='';server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,REQUIREMENTS_ROOT:root,WORKBENCH_AUTH:'required',WORKBENCH_STORAGE:'mysql',PORT:'8817',HOST:'127.0.0.1',GITEE_SYNC_ENABLED:'false',WORKBENCH_SETUP_FILE:setupFile}});server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const base='http://127.0.0.1:8817';for(let i=0;i<80;i++){try{if((await fetch(base+'/api/storage/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.match(logs,/running at/);
  const request=async(route,{cookie='',method='GET',body,origin=base}={})=>{const r=await fetch(base+route,{method,headers:{Cookie:cookie,Origin:origin,'X-Design-Client':'workbench-v1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};};
  assert.equal((await request('/api/auth/register',{method:'POST',body:{username:'early',password:'test-password-2026'}})).status,409);
  const blocked=await new Promise((resolve,reject)=>require('node:http').get(base+'/api/auth/setup-info',{headers:{Host:'192.168.0.245:8817'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(blocked,403);
  assert.equal((await request('/api/auth/setup-info')).data.username,'owner');
  assert.equal((await request('/api/auth/setup',{method:'POST',body:{token:'wrong',password:'owner-password-2026'}})).status,403);
  assert.equal((await request('/api/auth/setup',{method:'POST',body:{token:'test-setup-token',password:'owner-password-2026'}})).status,200);
  assert.equal(fs.existsSync(setupFile),false);
  assert.equal((await request('/api/auth/setup-info')).status,409);
  await assert.rejects(accounts.create({username:'takeover',password:'test-password-2026'},[p]),{status:409});
  assert.equal((await request('/api/tree')).status,401);assert.equal((await request('/api/ai/context?path='+encodeURIComponent(p))).status,401);
  const a=await request('/api/auth/login',{method:'POST',body:{username:'owner',password:'owner-password-2026'}});assert.equal(a.status,200);
  const prototype=await fetch(base+'/preview/'+encodeURI(p+'/原型设计/demo.html'),{headers:{Cookie:a.cookie}});assert.equal(prototype.status,200);assert.match(prototype.headers.get('content-security-policy'),/^sandbox /);assert.ok(!prototype.headers.get('content-security-policy').includes('allow-same-origin'));
  const z=await request('/api/auth/register',{method:'POST',body:{username:'member',displayName:'团队成员',password:'member-password-2026'}});assert.equal(z.status,200);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{username:'owner',password:'wrong-password'}})).status,401);
  const q='?path='+encodeURIComponent(p);
  for(const route of ['/api/entry','/api/flows','/api/design','/api/annotations','/api/document']){
   const mine=await request(route+q,{cookie:a.cookie}),other=await request(route+q,{cookie:z.cookie});assert.equal(mine.status,200,route+JSON.stringify(mine.data));assert.equal(other.status,200,route);assert.equal(route==='/api/entry'?mine.data.entry.canEdit:mine.data.canEdit,true);assert.equal(route==='/api/entry'?other.data.entry.canEdit:other.data.canEdit,false);
  }
  for(const [route,method] of [['/api/flows','PUT'],['/api/flows/restore','POST'],['/api/design','PUT'],['/api/design/restore','POST'],['/api/annotations','PUT'],['/api/annotations/restore','POST'],['/api/document','PUT'],['/api/document/restore','POST'],['/api/catalog/routes','PUT'],['/api/entry-state','PUT'],['/api/entry-state/import','POST']])assert.equal((await request(route+q,{cookie:z.cookie,method,body:{}})).status,403,route);
  const content={applicability:'undecided',reason:'',flows:[],references:[],expectedRevision:0};
  assert.equal((await request('/api/flows'+q,{cookie:a.cookie,method:'PUT',body:content,origin:'http://evil.test'})).status,403);
  assert.equal((await request('/api/flows'+q,{cookie:a.cookie,method:'PUT',body:content})).status,200);
  assert.equal((await request('/api/flows'+q,{cookie:a.cookie,method:'PUT',body:content})).status,409);
  const created=await request('/api/entries',{cookie:z.cookie,method:'POST',body:{module:'00-测试',name:'成员的新需求',content:'成员创建的需求'}});assert.equal(created.status,201,JSON.stringify(created.data));
  const np=created.data.entry.path,nq='?path='+encodeURIComponent(np);
  assert.equal((await accounts.owner(np)).id,z.data.user.id);
  assert.equal((await request('/api/flows'+nq,{cookie:z.cookie,method:'PUT',body:content})).status,200);
  assert.equal((await request('/api/flows'+nq,{cookie:a.cookie,method:'PUT',body:content})).status,403);
  assert.equal((await request('/api/entry-state/import'+q,{cookie:a.cookie,method:'POST',body:{paths:[np]}})).status,403);
  const tree=await request('/api/tree',{cookie:z.cookie});assert.equal(tree.data.modules.flatMap(m=>m.features).find(e=>e.path===p).canEdit,false);
  assert.equal((await request('/api/ai/context'+q,{cookie:z.cookie})).status,200);
  const shared=await request('/api/auth/ai-link',{cookie:a.cookie,method:'POST',body:{path:p}});assert.equal(shared.status,200);
  const sharedOverview=await request(shared.data.url);assert.equal(sharedOverview.status,200);
  for(const doc of sharedOverview.data.documents)assert.equal((await request(doc.url)).status,200);
  const forged=new URL(shared.data.url,base);forged.searchParams.set('path',np);assert.equal((await request(forged.pathname+forged.search)).status,401);
  assert.equal((await request(shared.data.url,{method:'PUT',body:{}})).status,401);
  await request('/api/auth/logout',{cookie:z.cookie,method:'POST',body:{}});assert.equal((await request('/api/tree',{cookie:z.cookie})).status,401);
  console.log(JSON.stringify({anonymousBlocked:true,teamReads:true,foreignWritesBlocked:11,ownerWrites:true,newOwnership:true,csrfBlocked:true,revisionConflicts:true,logoutRevoked:true}));
 }finally{if(server){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await db.close();}
});
