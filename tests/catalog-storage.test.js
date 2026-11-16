'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./document-fixture'),{scanRequirements}=require('../lib/scan'),{readableDocument,listedDocument}=require('../lib/document-links');
test('related routes are imported once and persist after the source file is removed',async()=>{
 const f=await fixture({routes:{'20-测试/正文迁移':['/original']}});try{
 const {db,p,root}=f;
 fs.writeFileSync(path.join(root,'portal/data/link-map.json'),JSON.stringify({[p]:['/stale']}));
 await db.initCatalog();await db.refreshDocumentEntries();const tree=await db.decorateTree(scanRequirements(root)),e=tree.modules.flatMap(m=>m.features).find(e=>e.path===p);
 assert.equal(tree.catalogStorage,'mysql');assert.deepEqual(e.relatedRoutes,['/original']);await db.saveRelatedRoutes(p,['/original'],['/new']);await assert.rejects(db.saveRelatedRoutes(p,['/original'],['/stale']),{status:409});
 fs.rmSync(path.join(root,'portal/data'),{recursive:true});await db.refreshDocumentEntries();assert.deepEqual(db.documentEntries.get(p).relatedRoutes,['/new']);
 }finally{await f.close()}
});
test('task and reference documents retain links, revisions and downloads after source removal',async()=>{
 const f=await fixture();try{const {db,p,dir}=f;for(const name of ['任务拆分.md','现有实现复核.md']){const file=p+'/'+name;await db.saveDocumentFile(p,file,0,'# '+name+'\n内容');await db.saveDocumentFile(p,file,1,'# 更新\n内容');await assert.rejects(db.saveDocumentFile(p,file,1,'过期内容'),{status:409});assert.equal((await db.fileVersion(p,file,1)).content,'# '+name+'\n内容');}
 fs.rmSync(dir,{recursive:true});const tree=await db.decorateTree(scanRequirements(f.root)),e=tree.modules[0].features[0];assert.equal(e.docs.task,p+'/任务拆分.md');assert.equal(e.referenceDocuments[0].path,p+'/现有实现复核.md');for(const file of [e.docs.task,e.referenceDocuments[0].path]){assert.ok(listedDocument(e,file));assert.equal(readableDocument(f.root,tree,file).fullPath,null);assert.equal((await db.readDocumentFile(p,file)).revision,2);}
 }finally{await f.close()}
});
test('old loopback workbench links stay on the reader origin while other services remain external',()=>{
 const {rewriteDocumentLinks}=require('../lib/document-links');const html=rewriteDocumentLinks('<a href="http://127.0.0.1:8125/#path=a&amp;view=flow">流程</a><a href="http://localhost:8806/preview/a.html">原型</a><a href="http://127.0.0.1:9998/">业务</a>',{root:'/',tree:{modules:[]},sourceFile:'a.md'});assert.ok(html.includes('href="/#path=a&amp;view=flow"'));assert.ok(html.includes('href="/preview/a.html"'));assert.ok(html.includes('href="http://127.0.0.1:9998/" target="_blank"'));
});
