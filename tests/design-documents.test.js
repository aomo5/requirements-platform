'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateDesignContent,validatePages}=require('../lib/design-store');
const model=require('../lib/design-edit-model');
const {saveDesignBatch,readDesignBundle}=require('../lib/design-batch');
const {readMappings,createDesignDocumentsHandler}=require('../lib/design-documents');
const {createDocumentHandler}=require('../lib/document-handler');
const {createAiContext}=require('../lib/ai-context');
const {rewriteDocumentLinks}=require('../lib/document-links');
const page=id=>({id,name:id,width:1280,height:900,x:0,y:0,html:'',source:'',route:'',status:'planned'});

test('file mode reads saved design descriptions and legacy page documents', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanRequirements, findEntryByPath } = require('../lib/scan');
  const { createDesignStore } = require('../lib/design-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-design-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const topic = '01-示例/文章投稿';
  const legacy = `${topic}/页面设计/旧说明.md`;
  fs.mkdirSync(path.dirname(path.join(root, legacy)), { recursive: true });
  fs.writeFileSync(path.join(root, legacy), '# 旧说明\n\n原有审核规则。');
  const getTree = () => scanRequirements(root);
  const designStore = createDesignStore(root, entryPath => findEntryByPath(getTree(), entryPath));
  await designStore.save(topic, 0, {
    pages: [{ ...page('draft'), description: '当前审核规则。' }], overview: '投稿流程。',
  });

  let result;
  const handler = createDesignDocumentsHandler(null, (_res, status, data) => { result = { status, data }; },
    { root, getTree, designStore });
  const get = async (endpoint, query = {}) => {
    await handler({ method: 'GET' }, {}, new URL(`http://local/api/design/${endpoint}?` + new URLSearchParams({ path: topic, ...query })));
    return result;
  };
  assert.match((await get('description', { page: 'draft' })).data.html, /当前审核规则/);
  assert.match((await get('description')).data.html, /投稿流程/);
  assert.equal((await get('documents')).data.documents[0].file, legacy);
  const old = await get('documents', { file: legacy });
  assert.equal(old.status, 200);
  assert.deepEqual(old.data.versions, []);
  assert.match(old.data.html, /原有审核规则/);
  assert.equal((await get('documents', { file: `${topic}/原型设计/旧说明.md` })).status, 404);
  assert.equal(findEntryByPath(getTree(), topic).design.pages[0].status, 'planned');
});

test('canonical descriptions, shared states and overview survive CLI and undo/redo',async()=>{
 const path='20-测试/设计',w={schemaVersion:1,revision:2,updatedAt:null,pages:[{...page('one'),description:'已有规则'}, {...page('state'),descriptionPageId:'one'}],overview:'设计路径'};
 const b=model.createBundle('http://127.0.0.1:8125',path,w,{schemaVersion:1,revision:0,updatedAt:null,notes:[]});
 const edited=model.applyOperations(b,[{op:'workspace.update',set:{overview:'新路径'}},{op:'page.update',id:'one',set:{description:'当前规则'}}]);
 const payload=model.payloadForApply(edited);assert.equal(payload.overview,'新路径');assert.equal(payload.pages[1].descriptionPageId,'one');assert.equal(payload.pages[0].status,'planned');
 assert.equal(model.diffBundle(edited).changed.design,true);
 assert.equal(validateDesignContent(w.pages,{path},w).overview,w.overview);
 assert.throws(()=>validatePages(w.pages.slice(1),{path}),/共用说明/);
 assert.throws(()=>validatePages([{...w.pages[0],descriptionPageId:'state'},w.pages[1]],{path}),/共用说明/);
 const {createDesignEditHistory}=await import('../public/assets/design-model.js');const h=createDesignEditHistory(w);
 h.record({...w,overview:'更改'});assert.equal(h.undo().overview,'设计路径');assert.equal(h.redo().overview,'更改');
});
test('migration is atomic, revision guarded, archived read-only, linked to current design and absent from duplicate AI docs',{skip:process.env.WORKBENCH_DESIGN_BATCH_DB_TEST!=='1',timeout:60000},async()=>{
 const f=await require('./document-fixture').fixture();try{
 const {db,p}=f,file=p+'/页面设计/账户.md',old='# 账户说明\n\n有效规则。\n';
 const original=await db.saveDocumentFile(p,file,0,old);
 const base=await readDesignBundle(db,p),input={expectedRevision:base.workspace.revision,expectedAnnotationsRevision:base.annotations.revision,pages:[{...page('accounts'),description:old}],notes:base.annotations.notes,overview:'# 设计说明',migrations:[{file,sourceRevision:original.revision,target:'page',pageId:'accounts'}]};
 await assert.rejects(saveDesignBatch(db,p,{...input,migrations:[{...input.migrations[0],sourceRevision:99}]}),{status:409});
 await assert.rejects(saveDesignBatch(db,p,{...input,migrations:[{...input.migrations[0],pageId:'missing'}]}),{status:400});
 await saveDesignBatch(db,p,{...input,dryRun:true});assert.equal((await readMappings(db,p)).length,0);assert.equal((await db.read('design',p)).workspace.revision,0);
 const result=await saveDesignBatch(db,p,input);assert.equal(result.migratedDocuments,1);assert.equal((await db.fileVersion(p,file,original.revision)).content,old);
 const repeat=await saveDesignBatch(db,p,{...input,expectedRevision:result.workspace.revision});assert.equal(repeat.changed.design,false);assert.equal((await readMappings(db,p)).length,1);
 await db.refreshDocumentEntries();const tree=await db.decorateTree(db.getTree());const e=tree.modules.flatMap(m=>m.features).find(e=>e.path===p);
 assert.equal(e.pageDesigns.some(x=>x.path===file),false);assert.equal(e.designDocuments[0].pageId,'accounts');
 const link=rewriteDocumentLinks('<a href="./页面设计/账户.md">账户</a>',{root:f.root,tree,sourceFile:p+'/需求文档.md'});assert.match(link,/view=design/);assert.match(link,/inspector=description/);
 let response;const handler=createDocumentHandler(db,(_res,status,data)=>response={status,data});
 await handler({method:'GET'},{},new URL('http://local/api/document?'+new URLSearchParams({path:p,file})));assert.match(response.data.redirect,/view=design/);assert.equal(response.data.canEdit,false);
 await handler({method:'PUT'},{},new URL('http://local/api/document?'+new URLSearchParams({path:p,file})));assert.equal(response.status,409);
 const dh=createDesignDocumentsHandler(db,(_res,status,data)=>response={status,data},{root:f.root,getTree:async()=>tree});
 await dh({method:'GET'},{},new URL('http://local/api/design/documents?'+new URLSearchParams({path:p,file,revision:original.revision})));assert.equal(response.status,200);assert.match(response.data.html,/有效规则/);
 const store=kind=>({read:q=>db.read(kind,q)});const ai=createAiContext({root:f.root,getTree:async()=>tree,designStore:store('design'),annotationStore:store('annotations'),flowStore:{...store('flow'),catalog:async()=>({flows:[],issues:[]})},readDocument:(e,file)=>db.readDocumentFile(e.path,file)});
 const overview=await ai.read('context',new URLSearchParams({path:p}));assert.ok(!overview.documents.some(d=>d.file===file));assert.equal(overview.sources[0].design.overview,'# 设计说明');
 const changed=await db.save('design',p,result.workspace.revision,{pages:[{...result.workspace.pages[0],description:'更新规则'}],overview:'当前总览'});
 assert.equal((await ai.read('document',new URLSearchParams({file}))).content,'更新规则');
 // A later legacy pages-only save must retain the unified overview.
 const legacy=await db.save('design',p,changed.revision,changed.pages);assert.equal(legacy.overview,'当前总览');
 }finally{await f.close();}
});
test('page merge moves canonical notes and document links while pre-migration restore stays read-only',{skip:process.env.WORKBENCH_DESIGN_BATCH_DB_TEST!=='1',timeout:60000},async()=>{
 const f=await require('./document-fixture').fixture();try{
  const {db,p}=f,file=p+'/页面设计/旧页.md',old='# 独有规则';await db.saveDocumentFile(p,file,0,old);
  const initial=await db.save('design',p,0,{pages:[page('old'), {...page('kept'),description:'# 保留规则'}, {...page('state'),descriptionPageId:'old'}],overview:'[详情](/#path='+encodeURIComponent(p)+'&view=design&prototype=design:old)'});
  const base=await readDesignBundle(db,p);base.workspace.pages.find(x=>x.id==='old').description=old;
  const migrated=await saveDesignBatch(db,p,{expectedRevision:base.workspace.revision,expectedAnnotationsRevision:base.annotations.revision,pages:base.workspace.pages,overview:base.workspace.overview,notes:base.annotations.notes,migrations:[{file,sourceRevision:1,target:'page',pageId:'old'}]});
  const result=await require('../lib/design-merge').mergePages(db,p,{expectedRevision:migrated.workspace.revision,sourceId:'old',targetId:'kept'});
  assert.equal(result.workspace.pages.length,2);const target=result.workspace.pages.find(x=>x.id==='kept');assert.match(target.description,/独有规则/);assert.match(target.description,/保留规则/);
  assert.equal(result.workspace.pages.find(x=>x.id==='state').descriptionPageId,'kept');assert.match(result.workspace.overview,/design:kept/);
  assert.equal((await readMappings(db,p))[0].pageId,'kept');assert.equal((await db.fileVersion(p,file,1)).content,old);
  await assert.rejects(db.save('design',p,result.workspace.revision,null,initial.revision),/早于页面说明迁移/);
 }finally{await f.close();}
});
