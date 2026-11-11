'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {fixture}=require('./document-fixture'),{backup,exportData}=require('../lib/storage-transfer'),{scanRequirements}=require('../lib/scan'),{readableDocument,rewriteDocumentLinks}=require('../lib/document-links'),{createDocumentHandler}=require('../lib/document-handler'),{createEntryService}=require('../lib/entry-create'),{GiteeSync}=require('../lib/gitee-sync');
test('exact supporting migration, independent revisions, original links and DB-only discovery/export',async()=>{
 const f=await fixture({routes:{'20-测试/正文迁移':['/account/detail']}}),out=path.join(os.tmpdir(),'wb-support-backup-'+Date.now());
 try{
  const {db,p,dir,root}=f;fs.mkdirSync(path.join(dir,'页面设计'));
  const spec=p+'/规格索引.md',page=p+'/页面设计/账户详情.md',files=new Map([[spec,'# 索引\r\n\r\n主 Gitee 需求编号：IABC12\r\n\r\n[详情](./页面设计/账户详情.md)\r\n'],[p+'/接口契约.md','# 接口\n`POST /recharge`\n'],[page,'# 账户详情\n[需求](../需求文档.md)\n<!-- 原备注 -->\n']]);
  for(const [file,raw]of files)fs.writeFileSync(path.join(root,file),raw);
  fs.mkdirSync(path.join(root,'portal/data'),{recursive:true});fs.writeFileSync(path.join(root,'portal/data/link-map.json'),JSON.stringify({[p]:['/account/detail']}));
  backup(root,out);await db.migrateDocuments(out);const before=await db.document(p),index=JSON.stringify((await db.pool.query('SELECT * FROM wb_rule_index'))[0]);
  assert.deepEqual(await db.migrateSupportingDocuments(out),{documents:3,spec:1,contract:1,page:1});assert.deepEqual(await db.migrateSupportingDocuments(out),{alreadyMigrated:true});
  for(const [file,raw]of files){const d=await db.readDocumentFile(p,file);assert.equal(d.content,raw);assert.equal(d.revision,1);assert.deepEqual(d.rules,[])}
  assert.equal((await db.saveDocumentFile(p,spec,1,'更新规格')).revision,2);assert.equal((await db.readDocumentFile(p,page)).revision,1);assert.deepEqual(await db.document(p),before);assert.equal(JSON.stringify((await db.pool.query('SELECT * FROM wb_rule_index'))[0]),index);
  await assert.rejects(db.saveDocumentFile(p,spec,1,'覆盖'),{status:409});assert.equal((await db.fileVersion(p,spec,1)).content,files.get(spec));assert.equal((await db.fileVersions(p,spec)).length,2);
  assert.equal((await db.saveDocumentFile(p,spec,2,(await db.fileVersion(p,spec,1)).content)).revision,3);
  for(const file of [p+'/页面设计/../规格索引.md',p+'/.隐藏.md',p+'/页面设计/.隐藏.md','其他/规格索引.md'])await assert.rejects(db.saveDocumentFile(p,file,0,'非法'),{status:400});
  fs.rmSync(dir,{recursive:true});await db.refreshDocumentEntries();const tree=await db.decorateTree(scanRequirements(root)),e=tree.modules[0].features[0];assert.equal(e.docs.spec,spec);assert.equal(e.gitee.ident,'IABC12');assert.deepEqual(e.relatedRoutes,['/account/detail']);assert.equal(e.pageDesigns[0].path,page);assert.equal(readableDocument(root,tree,page).fullPath,null);assert.equal((await db.readDocumentFile(p,page)).content,files.get(page));
  assert.ok(rewriteDocumentLinks('<a href="./页面设计/账户详情.md">详情</a>',{root,tree,sourceFile:spec}).includes('view=doc'));
  const sync=new GiteeSync({root,store:{},getTree:()=>scanRequirements(root),secretFile:path.join(root,'secret'),documents:db});assert.equal(sync.entries().find(e=>e.path===p).gitee.ident,'IABC12');assert.ok((await sync.local(p)).body.includes('充值'));sync.config=async()=>({});sync.url=()=> 'https://gitee.com/example/ABC';await sync.recordIndex(p,{ident:'ABC'});assert.ok((await db.readDocumentFile(p,spec)).content.includes('主 Gitee 需求编号：ABC'));assert.ok(!fs.existsSync(path.join(root,spec)));
  const exported=out+'-export';try{await exportData(db,exported);assert.equal(fs.readFileSync(path.join(exported,'snapshot',spec),'utf8'),(await db.readDocumentFile(p,spec)).content);assert.equal(fs.readFileSync(path.join(exported,'snapshot',p,'需求文档.md'),'utf8'),before.content);const dump=JSON.parse(fs.readFileSync(path.join(exported,'database.json')));assert.equal(dump.wb_supporting_documents.length,3);assert.equal(dump.wb_supporting_document_versions.length,6)}finally{fs.rmSync(exported,{recursive:true,force:true})}
 }finally{fs.rmSync(out,{recursive:true,force:true});await f.close()}
});
test('file-scoped API write protections, restore and atomic new-entry registration',async()=>{
 const f=await fixture();let server;
 try{
  const {db,p,root}=f,send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))},handler=createDocumentHandler(db,send),readonly=createDocumentHandler(db,send,{accessMode:'local'});
  server=http.createServer((req,res)=>{const u=new URL(req.url,'http://local');u.searchParams.has('readonly')?(req.headers.host='remote.test',readonly(req,res,u)):handler(req,res,u)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,file=p+'/页面设计/充值页.md',q=new URLSearchParams({path:p,file});
  const write=(route,body,method='PUT',extra={})=>fetch(base+route,{method,headers:{Origin:base,'Content-Type':'application/json','X-Design-Client':'workbench-v1',...extra},body:JSON.stringify(body)});
  assert.equal((await write('/api/document?'+q,{expectedRevision:0,content:'页'},'PUT',{Origin:'http://other.test'})).status,403);assert.equal((await write('/api/document?'+q+'&readonly=1',{expectedRevision:0,content:'页'})).status,403);
  assert.equal((await write('/api/document?'+q,{expectedRevision:0,content:'# 充值页\n'})).status,200);assert.equal((await write('/api/document?'+q,{expectedRevision:0,content:'覆盖'})).status,409);assert.equal((await(await fetch(base+'/api/document?'+q)).json()).content,'# 充值页\n');
  await write('/api/document?'+q,{expectedRevision:1,content:'更新'});assert.equal((await write('/api/document/restore?'+q,{expectedRevision:2,revision:1},'POST')).status,200);assert.equal((await db.readDocumentFile(p,file)).revision,3);
  const create=createEntryService(root,{persistDocuments:false,register:e=>db.registerEntryDocuments(e)}),entry=await create({module:'20-测试',name:'新需求',content:'原始内容'});assert.equal((await db.document(entry.path)).revision,1);assert.ok(!fs.existsSync(path.join(root,entry.docs.requirement)));assert.ok(!fs.existsSync(path.join(root,entry.docs.spec)));assert.ok((await db.decorateTree(scanRequirements(root))).modules.flatMap(m=>m.features).some(e=>e.path===entry.path));assert.equal((await db.readDocumentFile(entry.path,entry.path+'/规格索引.md')).revision,1);
  const original=db.putSupportingDocument;db.putSupportingDocument=async()=>{throw new Error('registration failure')};await assert.rejects(create({module:'20-测试',name:'失败需求',content:'原文'}),/registration failure/);db.putSupportingDocument=original;assert.equal((await db.pool.query('SELECT path FROM wb_entries WHERE path LIKE ?', ['%失败需求']))[0].length,0);assert.ok(!fs.existsSync(path.join(root,'20-测试/失败需求')));
 }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});await f.close()}
});
