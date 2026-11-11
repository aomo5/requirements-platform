"use strict";
const fs=require('fs'),path=require('path');
const {sha}=require('./stable-identities');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const SUPPORTING_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS wb_supporting_control (id INT PRIMARY KEY, migrated BOOLEAN NOT NULL DEFAULT 0) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_supporting_documents (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, file_hash CHAR(64) CHARACTER SET ascii NOT NULL, file TEXT NOT NULL, kind VARCHAR(16) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, content MEDIUMTEXT NOT NULL, updated_at VARCHAR(32) NOT NULL, PRIMARY KEY(entry_id,file_hash), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_supporting_document_versions (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, file_hash CHAR(64) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, content MEDIUMTEXT NOT NULL, captured_at VARCHAR(32) NOT NULL, PRIMARY KEY(entry_id,file_hash,revision), FOREIGN KEY(entry_id,file_hash) REFERENCES wb_supporting_documents(entry_id,file_hash)) ENGINE=InnoDB`,
];
function documentKind(entryPath,file){
 if(typeof file!=='string'||!file.startsWith(entryPath+'/')||file.includes('\\')||file.length>2000)fail('文档不属于当前需求');
 const relative=file.slice(entryPath.length+1);
 const fixed={'需求文档.md':'requirement','规格索引.md':'spec','接口契约.md':'contract','任务拆分.md':'task'};
 if(fixed[relative])return fixed[relative];
 if(/^页面设计\/[^/\u0000-\u001f<>:"|?*]{1,100}\.md$/.test(relative)&&!relative.split('/').some(s=>s.startsWith('.')||s.trim()!==s))return 'page';
 if(/^[^/\u0000-\u001f<>:"|?*]{1,100}\.md$/.test(relative)&&!relative.startsWith('.')&&relative.trim()===relative)return 'reference';
 fail('不支持的需求文档路径');
}
const methods={
 validateDocumentFile(p,file=p+'/需求文档.md'){
  this.find(p);documentKind(p,file);
  let cursor=this.root;for(const part of file.split('/')){cursor=path.join(cursor,part);if(fs.lstatSync(cursor,{throwIfNoEntry:false})?.isSymbolicLink())fail('文档路径包含符号链接',403)}return file;
 },
 async readDocumentFile(p,file=p+'/需求文档.md',c=this.pool){
  this.validateDocumentFile(p,file);if(documentKind(p,file)==='requirement')return this.document(p,c);
  const [[r]]=await c.execute('SELECT d.* FROM wb_supporting_documents d JOIN wb_entries e ON e.id=d.entry_id WHERE e.path_hash=? AND d.file_hash=?',[sha(p),sha(file)]);
  return r?{file:r.file,content:r.content,editorContent:r.content,rules:[],revision:r.revision,updatedAt:r.updated_at,storage:'mysql'}:null;
 },
 async putSupportingDocument(c,p,file,expectedRevision,content){
  this.validateDocumentFile(p,file);const kind=documentKind(p,file);
  if(kind==='requirement')fail('请使用主需求保存方法');
  if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)fail('文档最多 2 MB');
  if(!Number.isInteger(expectedRevision)||expectedRevision<0)fail('缺少有效的文档版本');
  const old=await this.readDocumentFile(p,file,c);
  if((old?.revision||0)!==expectedRevision)fail('文档已被其他人修改，当前草稿已保留，请核对最新版本后再保存',409);
  if(old?.content===content)return old;
  const id=await this.entry(c,this.find(p)),revision=expectedRevision+1,updatedAt=new Date().toISOString();
  await c.execute('INSERT INTO wb_supporting_documents VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),content=VALUES(content),updated_at=VALUES(updated_at)',[id,sha(file),file,kind,revision,content,updatedAt]);
  await c.execute('INSERT INTO wb_supporting_document_versions VALUES (?,?,?,?,?)',[id,sha(file),revision,content,updatedAt]);
  return {file,content,editorContent:content,rules:[],revision,updatedAt,storage:'mysql'};
 },
 async saveDocumentFile(p,file,expectedRevision,content,options={}){
  this.validateDocumentFile(p,file);
  if(documentKind(p,file)==='requirement')return this.saveDocument(p,expectedRevision,content,options);
  const result=await this.transaction(c=>this.putSupportingDocument(c,p,file,expectedRevision,content));await this.refreshDocumentEntries();return result;
 },
 async fileVersions(p,file){
  this.validateDocumentFile(p,file);if(documentKind(p,file)==='requirement')return this.documentVersions(p);
  const [rows]=await this.pool.execute('SELECT v.revision,v.captured_at AS updatedAt FROM wb_supporting_document_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? AND v.file_hash=? ORDER BY v.revision DESC',[sha(p),sha(file)]);return rows;
 },
 async fileVersion(p,file,revision){
  this.validateDocumentFile(p,file);if(documentKind(p,file)==='requirement')return this.documentVersion(p,revision);
  if(!Number.isInteger(revision)||revision<1)fail('无效的文档版本');
  const [[r]]=await this.pool.execute('SELECT v.revision,v.content,v.captured_at AS updatedAt FROM wb_supporting_document_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? AND v.file_hash=? AND v.revision=?',[sha(p),sha(file),revision]);
  if(!r)fail('文档版本不存在',404);return {...r,editorContent:r.content};
 },
 async registerEntryDocuments(entry,{afterWrite=async()=>{}}={}){
  await this.transaction(async c=>{
   await this.putRequirementDocument(c,entry.path,0,fs.readFileSync(path.join(this.root,entry.docs.requirement),'utf8'));
   await this.putSupportingDocument(c,entry.path,entry.docs.spec,0,fs.readFileSync(path.join(this.root,entry.docs.spec),'utf8'));
   await afterWrite(c);
  });await this.refreshDocumentEntries();
 },
 async migrateSupportingDocuments(backupDir){
  const manifest=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8'));
  if(manifest.source!==this.root)fail('备份不属于当前需求目录');
  const baseline=new Map(manifest.files.map(f=>[f.path,f.sha256])),sources=[];
  for(const entry of this.getTree().modules.flatMap(m=>m.features))for(const file of [entry.docs?.spec,entry.docs?.contract,...(entry.pageDesigns||[]).map(d=>d.path)].filter(Boolean)){
   this.validateDocumentFile(entry.path,file);const raw=fs.readFileSync(path.join(this.root,file),'utf8');
   if(baseline.get(file)!==sha(raw)||baseline.get(file)!==sha(fs.readFileSync(path.join(backupDir,'snapshot',file))))fail('文档或备份已变化，请重新备份：'+file,409);
   sources.push({p:entry.path,file,raw});
  }
  const result=await this.transaction(async c=>{
   const [[state]]=await c.query('SELECT migrated FROM wb_supporting_control WHERE id=1');if(state.migrated)return {alreadyMigrated:true};
   const counts={spec:0,contract:0,page:0};
   for(const {p,file,raw}of sources){if(await this.readDocumentFile(p,file,c))fail('已有数据库文档，未覆盖：'+file,409);await this.putSupportingDocument(c,p,file,0,raw);counts[documentKind(p,file)]++;}
   await c.query('UPDATE wb_supporting_control SET migrated=1 WHERE id=1');return {documents:sources.length,...counts};
  });await this.refreshDocumentEntries();return result;
 },
};
module.exports={SUPPORTING_SCHEMA,methods,documentKind};
