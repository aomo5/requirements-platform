'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./document-fixture');
const {createEntryStateHandler}=require('../lib/entry-state');
test('archive persists in shared tree, protects revisions and survives legacy import',async()=>{
 const f=await fixture();try{
  const {db,p}=f;
  assert.deepEqual(await db.readEntryState(p),{archived:false,revision:0,updatedAt:null});
  assert.deepEqual((await db.importLegacyArchives([p,p])).imported,[p]);
  assert.equal((await db.readEntryState(p)).archived,true);
  const state=await db.saveEntryState(p,1,false);assert.equal(state.revision,2);
  await assert.rejects(db.saveEntryState(p,1,true),e=>e.status===409);
  assert.deepEqual((await db.importLegacyArchives([p])).skipped,[p]);
  await db.importLegacyArchives([]);assert.equal((await db.readEntryState(p)).archived,false);
  const archived=await db.saveEntryState(p,2,true);
  const tree=await db.decorateTree(db.getTree());assert.equal(tree.archiveStorage,'mysql');
  assert.deepEqual(tree.modules.flatMap(m=>m.features).find(e=>e.path===p).archiveState,archived);
  const [[stored]]=await db.pool.query('SELECT archived,revision FROM wb_entry_states');assert.equal(stored.archived,1);assert.equal(stored.revision,3);
  await assert.rejects(db.saveEntryState(p,3,'true'),e=>e.status===400);
  await assert.rejects(db.saveEntryState('../bad',0,true),e=>e.status===400);
 }finally{await f.close();}
});
test('archive API rejects LAN writes and cross-origin writes; reads remain shared',async()=>{
 const f=await fixture();try{
  let result;const handle=createEntryStateHandler(f.db,(_,status,body)=>{result={status,body}},'local');
  const url=new URL('http://localhost/api/entry-state?'+new URLSearchParams({path:f.p}));
  await handle({method:'PUT',socket:{remoteAddress:'192.168.0.20'},headers:{host:'192.168.0.245:8806'}},{},url);assert.equal(result.status,403);
  await handle({method:'PUT',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:8125',origin:'http://elsewhere'}},{},url);assert.equal(result.status,403);
  await f.db.saveEntryState(f.p,0,true);
  await handle({method:'GET'},{},url);assert.equal(result.status,200);assert.equal(result.body.archived,true);
 }finally{await f.close();}
});
