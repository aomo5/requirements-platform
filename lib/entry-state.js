"use strict";
const {sha}=require('./stable-identities');
const {readBody}=require('./design-store');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const SCHEMA=[`CREATE TABLE IF NOT EXISTS wb_entry_states (entry_id CHAR(36) CHARACTER SET ascii PRIMARY KEY, revision INT NOT NULL, archived BOOLEAN NOT NULL, updated_at VARCHAR(32) NOT NULL, FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`];
const methods={
 async readEntryState(p,c=this.pool){this.find(p);const [[row]]=await c.execute('SELECT s.revision,s.archived,s.updated_at FROM wb_entry_states s JOIN wb_entries e ON e.id=s.entry_id WHERE e.path_hash=?',[sha(p)]);return {archived:!!row?.archived,revision:row?.revision||0,updatedAt:row?.updated_at||null};},
 async saveEntryState(p,expectedRevision,archived){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof archived!=='boolean')fail('归档状态或版本无效');
  return this.transaction(async c=>{const entry=this.find(p),current=await this.readEntryState(p,c);if(current.revision!==expectedRevision)fail('归档状态已在其他窗口更新，请刷新目录后重试',409);const id=await this.entry(c,entry),updatedAt=new Date().toISOString(),revision=current.revision+1;await c.execute('INSERT INTO wb_entry_states VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),archived=VALUES(archived),updated_at=VALUES(updated_at)',[id,revision,archived,updatedAt]);return {archived,revision,updatedAt};});
 },
 async importLegacyArchives(paths){
  if(!Array.isArray(paths)||paths.length>5000||paths.some(p=>typeof p!=='string'||p.length>999))fail('旧归档列表无效');
  return this.transaction(async c=>{const imported=[],skipped=[],unresolved=[];for(const p of new Set(paths)){let entry;try{entry=this.find(p)}catch(e){if(e.status===404){unresolved.push(p);continue}throw e}const current=await this.readEntryState(p,c);if(current.revision){skipped.push(p);continue}const id=await this.entry(c,entry);await c.execute('INSERT INTO wb_entry_states VALUES (?,1,1,?)',[id,new Date().toISOString()]);imported.push(p)}return {imported,skipped,unresolved};});
 }
};
function createEntryStateHandler(db,sendJson,accessMode){return async(req,res,url)=>{try{if(!db)fail('归档需要数据库存储',503);if(req.method==='GET'&&url.pathname==='/api/entry-state')sendJson(res,200,await db.readEntryState(url.searchParams.get('path')));else if(req.method==='PUT'&&url.pathname==='/api/entry-state'){const b=await readBody(req,accessMode);sendJson(res,200,await db.saveEntryState(url.searchParams.get('path'),b.expectedRevision,b.archived));}else if(req.method==='POST'&&url.pathname==='/api/entry-state/import'){const b=await readBody(req,accessMode);sendJson(res,200,await db.importLegacyArchives(b.paths));}else sendJson(res,405,{error:'不支持的归档接口或方法'});}catch(e){sendJson(res,e.status||500,{error:e.status?e.message:'归档保存失败，请重试'});}}}
module.exports={SCHEMA,methods,createEntryStateHandler};
