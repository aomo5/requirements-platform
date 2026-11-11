'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareMarkdown}=require('../lib/stable-identities'),{stripMarkers,reconcileDocument}=require('../lib/document-storage');
const {scanRequirements}=require('../lib/scan'),{MysqlStorage}=require('../lib/mysql-storage'),{backup,TABLES}=require('../lib/storage-transfer'),{databaseConfig}=require('../lib/storage-config');
const {GiteeSync}=require('../lib/gitee-sync');
const {fixture}=require('./document-fixture');

test('plain editor preserves paragraph and table identities through text changes and reordering',()=>{
 const file='20-测试/正文/需求文档.md',raw=prepareMarkdown('# 标题\n\n第一条规则。\n\n第二条规则。\n\n| 列 | 值 |\n| --- | --- |\n| A | 100 |\n| B | 200 |\n',file).content;
 const first=prepareMarkdown(raw,file).rules;
 const text=stripMarkers(raw).replace('标题','新标题').replace('第一条规则。','修改后的第一条规则。').replace('| A | 100 |','| A | 150 |');
 const changed=prepareMarkdown(reconcileDocument(raw,text,file),file);
 assert.deepEqual(changed.rules.map(r=>r.blockId),first.map(r=>r.blockId));
 assert.ok(!stripMarkers(changed.content).includes('wb-rule:'));
 const reordered=stripMarkers(raw).replace('第一条规则。\n\n第二条规则。','第二条规则。\n\n第一条规则。');
 const again=prepareMarkdown(reconcileDocument(raw,reordered,file),file).rules;
 assert.equal(again[0].blockId,first[1].blockId);assert.equal(again[1].blockId,first[0].blockId);
 assert.throws(()=>reconcileDocument(raw,'内容 <!-- wb-rule:rule-injected -->',file),{status:400});
 const example='# 示例\n\n```html\n<!-- wb-rule:rule-example -->\n```\n\n正常文字。\n';
 const preparedExample=prepareMarkdown(example,file).content;
 assert.equal(stripMarkers(preparedExample),example);
 assert.ok(prepareMarkdown(reconcileDocument(preparedExample,example.replace('正常文字','修改文字'),file),file).content.includes('<!-- wb-rule:rule-example -->'));

});

test('real MySQL migration, canonical saves, conflicts, history and Gitee preserve existing notes and files',async()=>{
 const f=await fixture();try{
  const {db,p,dir,root,content}=f;
  await db.rules(p);const old=(await db.rules(p)).rules;
  const page={id:'a',name:'账户',width:390,height:844,x:0,y:0,html:'<p id="amount">余额</p>',source:'',route:'#account'};
  const design=await db.save('design',p,0,[page]);
  const note={id:'note-1',text:'充值规则',target:{type:'page-element',pageId:'a',route:'#account',anchor:{selector:'#amount',tag:'p',label:'余额',strength:'stable',htmlHash:'00000000',contextHash:''}},requirements:[{file:p+'/需求文档.md',blockId:old[0].blockId,quote:old[0].quote,heading:old[0].heading}]};
  const notes=await db.save('annotations',p,0,[note]);
  const before=JSON.stringify((await db.read('annotations',p)).workspace),beforeDesign=JSON.stringify((await db.read('design',p)).workspace);
  const dest=path.join(os.tmpdir(),'wb-doc-backup-'+Date.now());backup(root,dest);
  try{const migration=await db.migrateDocuments(dest);assert.equal(migration.documents,1);assert.ok(migration.versions>=1);
   const canonical=await db.document(p);assert.equal(canonical.content,content);assert.deepEqual(canonical.rules.map(r=>r.blockId),old.map(r=>r.blockId));
   fs.writeFileSync(path.join(dir,'需求文档.md'),'# 旧文件变动\n不能覆盖数据库。\n');
   assert.equal((await db.rules(p)).content,content);
   const saved=await db.saveDocument(p,canonical.revision,canonical.editorContent.replace('充值只进入对应账户。','充值仅进入选定账户。'),{editor:true});
   assert.equal(saved.rules[0].blockId,old[0].blockId);assert.ok(saved.content.includes('充值仅进入选定账户。'));
   await assert.rejects(db.saveDocument(p,canonical.revision,'覆盖旧版本'),{status:409});
   assert.ok((await db.documentVersions(p)).length>=2);
   assert.equal((await db.documentVersion(p,canonical.revision)).content,content);
   assert.equal(JSON.stringify((await db.read('annotations',p)).workspace),before);
   assert.equal(JSON.stringify((await db.read('design',p)).workspace),beforeDesign);
   const tree=await db.decorateTree(scanRequirements(root));assert.equal(tree.modules[0].features[0].document.storage,'mysql');
   const memory={get:async()=>null};const sync=new GiteeSync({root,store:memory,getTree:()=>scanRequirements(root),secretFile:path.join(root,'secret'),documents:db});
   assert.ok((await sync.local(p)).body.includes('充值仅进入选定账户。'));assert.ok(!(await sync.local(p)).body.includes('不能覆盖数据库'));
   const restored=await db.saveDocument(p,saved.revision,(await db.documentVersion(p,canonical.revision)).content);assert.ok(restored.revision>saved.revision);assert.equal(restored.content,content);
   fs.unlinkSync(path.join(dir,'需求文档.md'));fs.unlinkSync(path.join(dir,'规格索引.md'));
   const discovered=await db.decorateTree(scanRequirements(root));assert.equal(discovered.modules[0].features[0].path,p);assert.equal((await db.document(p)).content,content);

  }finally{fs.rmSync(dest,{recursive:true,force:true})}
 }finally{await f.close()}
});
