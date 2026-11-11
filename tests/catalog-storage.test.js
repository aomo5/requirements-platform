'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./document-fixture'),{scanRequirements}=require('../lib/scan'),{readableDocument,listedDocument}=require('../lib/document-links'),{GiteeStore}=require('../lib/gitee-store');
test('catalog is imported once and statuses merge across clients without filesystem dependency',async()=>{
 const f=await fixture({routes:{'20-测试/正文迁移':['/original']}});try{
 const {db,p,root}=f;
 const config={programId:'101',enterprisePath:'example',programName:'示例项目'};
 await db.cacheGiteeStatus(p,{ident:'IABC12',state:'closed',title:'账户',updated_at:'2026-10-23'},config);
 await Promise.all([db.cacheGiteeStatus('another/path',{ident:'IABC13',state:'open',title:'另一个'},config),db.cacheGiteeStatus('third/path',{ident:'IABC14',state:'progressing',title:'第三个'},config)]);
 fs.writeFileSync(path.join(root,'portal/data/link-map.json'),JSON.stringify({[p]:['/stale']}));
 fs.writeFileSync(path.join(root,'portal/data/gitee-status.json'),JSON.stringify({paths:{[p]:'IWRONG'},issues:{}}));
 await db.initCatalog();await db.refreshDocumentEntries();const tree=await db.decorateTree(scanRequirements(root)),e=tree.modules.flatMap(m=>m.features).find(e=>e.path===p);
 assert.equal(tree.catalogStorage,'mysql');assert.equal(e.gitee.ident,'IABC12');assert.equal(e.gitee.state,'closed');assert.equal(e.gitee.label,'已完成');assert.deepEqual(e.relatedRoutes,['/original']);await db.saveRelatedRoutes(p,['/original'],['/new']);await assert.rejects(db.saveRelatedRoutes(p,['/original'],['/stale']),{status:409});assert.equal(Object.keys((await db.catalogRecord('gitee-status')).issues).length,3);
 fs.rmSync(path.join(root,'portal/data'),{recursive:true});await db.refreshDocumentEntries();assert.equal(db.documentEntries.get(p).gitee.state,'closed');
 }finally{await f.close()}
});
test('task and reference documents retain links, revisions and downloads after source removal',async()=>{
 const f=await fixture();try{const {db,p,dir}=f;for(const name of ['任务拆分.md','现有实现复核.md']){const file=p+'/'+name;await db.saveDocumentFile(p,file,0,'# '+name+'\n内容');await db.saveDocumentFile(p,file,1,'# 更新\n内容');await assert.rejects(db.saveDocumentFile(p,file,1,'过期内容'),{status:409});assert.equal((await db.fileVersion(p,file,1)).content,'# '+name+'\n内容');}
 fs.rmSync(dir,{recursive:true});const tree=await db.decorateTree(scanRequirements(f.root)),e=tree.modules[0].features[0];assert.equal(e.docs.task,p+'/任务拆分.md');assert.equal(e.referenceDocuments[0].path,p+'/现有实现复核.md');for(const file of [e.docs.task,e.referenceDocuments[0].path]){assert.ok(listedDocument(e,file));assert.equal(readableDocument(f.root,tree,file).fullPath,null);assert.equal((await db.readDocumentFile(p,file)).revision,2);}
 }finally{await f.close()}
});
test('latest batch is discovered from persisted jobs rather than a browser pointer',async()=>{
 const f=await fixture();try{const store=new GiteeStore(f.db);await store.init();await store.put('job:older',{id:'older',createdAt:'2026-10-22',state:'done'});await store.put('job:newer',{id:'newer',createdAt:'2026-10-23',state:'done'});assert.equal((await new GiteeStore(f.db).latestJob()).id,'newer');await store.put('job:active',{id:'active',createdAt:'2026-10-24',state:'running',runner:{host:require('os').hostname(),pid:process.pid}});await store.recover();assert.equal((await store.get('job:active')).state,'running');await store.put('job:dead',{id:'dead',state:'running',runner:{host:require('os').hostname(),pid:2147483647}});await store.recover();assert.equal((await store.get('job:dead')).state,'failed');}finally{await f.db.pool.query('DROP TABLE IF EXISTS wb_gitee_sync');await f.close()}
});

test('old loopback workbench links stay on the reader origin while other services remain external',()=>{
 const {rewriteDocumentLinks}=require('../lib/document-links');const html=rewriteDocumentLinks('<a href="http://127.0.0.1:8125/#path=a&amp;view=flow">流程</a><a href="http://localhost:8806/preview/a.html">原型</a><a href="http://127.0.0.1:9998/">业务</a>',{root:'/',tree:{modules:[]},sourceFile:'a.md'});assert.ok(html.includes('href="/#path=a&amp;view=flow"'));assert.ok(html.includes('href="/preview/a.html"'));assert.ok(html.includes('href="http://127.0.0.1:9998/" target="_blank"'));
});
