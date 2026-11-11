"use strict";
const fs=require('fs'),path=require('path');
const {prepareMarkdown,sha}=require('./stable-identities');
const {renderMarkdown}=require('./markdown');
const {decorateRequirementRules}=require('./requirement-rules');
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
const DOCUMENT_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS wb_document_control (id INT PRIMARY KEY, migrated BOOLEAN NOT NULL DEFAULT 0) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_requirement_documents (entry_id CHAR(36) CHARACTER SET ascii PRIMARY KEY, revision INT NOT NULL, content MEDIUMTEXT NOT NULL, rules JSON NOT NULL, updated_at VARCHAR(32) NOT NULL, FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_requirement_document_versions (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, content MEDIUMTEXT NOT NULL, captured_at VARCHAR(32) NOT NULL, PRIMARY KEY(entry_id,revision), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
];
function stripMarkers(s){
 const lines=s.split(/\r?\n/),newline=s.includes('\r\n')?'\r\n':'\n';
 for(const rule of sourceRules(s,'editor/需求文档.md'))if(rule.stable&&Number.isInteger(rule.sourceLine))lines[rule.sourceLine]=lines[rule.sourceLine].replace(new RegExp(' ?<!-- wb-rule:'+rule.blockId+' -->','g'),'');
 return lines.join(newline);
}
function sourceRules(raw,file){return decorateRequirementRules(renderMarkdown(raw,{trackSource:true}),file).rules}
// Keep stable identities outside the editor. Exact blocks survive reordering;
// equal-sized edited runs between unchanged anchors retain their identities.
function reconcileDocument(previous,edited,file){
 if(sourceRules(edited,file).some(r=>r.stable))fail('内部段落标识不可手工添加',400);
 const old=sourceRules(previous,file),next=sourceRules(edited,file),matched=new Map(),used=new Set();
 const groups=items=>{const m=new Map();items.forEach((r,i)=>{const a=m.get(r.quote)||[];a.push(i);m.set(r.quote,a)});return m};
 const a=groups(old),b=groups(next);
 for(const [quote,indices]of b){const prior=a.get(quote);if(!prior||prior.length!==indices.length)continue;indices.forEach((n,j)=>{matched.set(n,prior[j]);used.add(prior[j])})}
 // Only anchor monotonically ordered regions; reordered blocks are already matched.
 const anchors=[[-1,-1]],pairs=[...matched].sort((x,y)=>x[0]-y[0]);let last=-1;
 for(const [n,o]of pairs)if(o>last){anchors.push([n,o]);last=o}
 anchors.push([next.length,old.length]);
 for(let i=1;i<anchors.length;i++){
  const [pn,po]=anchors[i-1],[nn,no]=anchors[i];
  const ns=[],os=[];for(let n=pn+1;n<nn;n++)if(!matched.has(n))ns.push(n);for(let o=po+1;o<no;o++)if(!used.has(o))os.push(o);
  if(ns.length===os.length)ns.forEach((n,j)=>{matched.set(n,os[j]);used.add(os[j])})
 }
 const lines=edited.split(/\r?\n/),newline=edited.includes('\r\n')?'\r\n':'\n';
 for(const[n,o]of matched){const rule=next[n],id=old[o]?.blockId;if(!id||!Number.isInteger(rule.sourceLine))continue;const marker=` <!-- wb-rule:${id} -->`,i=rule.sourceLine;lines[i]=rule.tag==='tr'?lines[i].replace(/\|(\s*)$/,`${marker} |$1`):lines[i]+marker}
 return lines.join(newline);
}
const methods={
 async refreshDocumentEntries(){
  const [rows]=await this.pool.query('SELECT e.path,e.metadata,d.revision,d.updated_at,d.content FROM wb_entries e LEFT JOIN wb_requirement_documents d ON e.id=d.entry_id');
  const [supporting]=await this.pool.query('SELECT e.path,d.file,d.kind,d.revision,d.updated_at FROM wb_supporting_documents d JOIN wb_entries e ON e.id=d.entry_id');
  const [[control]]=await this.pool.query('SELECT migrated FROM wb_supporting_control WHERE id=1');this.supportingMigrated=!!control?.migrated;
  const [specs]=await this.pool.query("SELECT e.path,d.content FROM wb_supporting_documents d JOIN wb_entries e ON e.id=d.entry_id WHERE d.kind='spec'");const specTexts=new Map(specs.map(d=>[d.path,d.content]));
  const status=await this.catalogRecord('gitee-status'),linkMap=await this.catalogRecord('related-routes');
  this.documentEntries=new Map(rows.map(r=>[r.path,{module:r.metadata.module,feature:r.metadata.feature,path:r.path,updatedAt:r.updated_at,writingStatus:{state:r.revision?'ready':'empty',label:r.revision?'需求已写':'待补充'},docs:{spec:null,requirement:r.revision?r.path+'/需求文档.md':null,contract:null},prototypes:[],pageDesigns:[],referenceDocuments:[],relatedRoutes:Array.isArray(linkMap[r.path])?linkMap[r.path]:[],gitee:require('./scan').getGiteeStatus(path.join(this.root,r.path),r.path,status,{specText:this.supportingMigrated?(specTexts.get(r.path)||''):undefined,requirementText:r.content??undefined}),document:r.revision?{storage:'mysql',revision:r.revision,updatedAt:r.updated_at}:null,documentFiles:{}}]));
  for(const r of supporting){const e=this.documentEntries.get(r.path);if(!e)continue;e.documentFiles[r.file]={storage:'mysql',revision:r.revision,updatedAt:r.updated_at};if(r.kind==='page')e.pageDesigns.push({name:path.posix.basename(r.file),path:r.file});else if(r.kind==='reference')e.referenceDocuments.push({name:path.posix.basename(r.file),path:r.file});else e.docs[r.kind]=r.file;if(r.updated_at>(e.updatedAt||''))e.updatedAt=r.updated_at;}
  for(const e of this.documentEntries.values())e.pageDesigns.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));return rows;
 },
 async document(entryPath,c=this.pool){
  this.find(entryPath);
  const [[row]]=await c.execute('SELECT d.* FROM wb_requirement_documents d JOIN wb_entries e ON e.id=d.entry_id WHERE e.path_hash=?',[sha(entryPath)]);
  if(!row)return null;
  return {file:entryPath+'/需求文档.md',content:row.content,rules:row.rules,revision:row.revision,updatedAt:row.updated_at,editorContent:stripMarkers(row.content),storage:'mysql'};
 },
 async indexDocument(c,id,rules){
  await c.execute('UPDATE wb_rule_index SET present=0 WHERE entry_id=?',[id]);
  for(const rule of rules)await c.execute('INSERT INTO wb_rule_index VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE payload=VALUES(payload),present=1',[id,rule.blockId,JSON.stringify(rule)]);
 },
 async saveDocument(entryPath,expectedRevision,content,{editor=false}={}){
  if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)fail('需求正文最多 2 MB',400);
  if(!Number.isInteger(expectedRevision)||expectedRevision<0)fail('缺少有效的文档版本',400);
  const saved=await this.transaction(c=>this.putRequirementDocument(c,entryPath,expectedRevision,content,{editor}));
  await this.refreshDocumentEntries();return saved;
 },
 async putRequirementDocument(c,entryPath,expectedRevision,content,{editor=false}={}){
   if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)fail('需求正文最多 2 MB',400);
   if(!Number.isInteger(expectedRevision)||expectedRevision<0)fail('缺少有效的文档版本',400);
   const entry=this.find(entryPath),previous=await this.document(entryPath,c);
   if((previous?.revision||0)!==expectedRevision)fail('需求文档已被其他人修改，当前草稿已保留，请核对最新版本后再保存');
   const file=entryPath+'/需求文档.md',raw=editor?reconcileDocument(previous?.content||'',content,file):content,prepared=prepareMarkdown(raw,file);
   if(prepared.rules.some(r=>r.ambiguous))fail('文档包含重复段落标识，请保留当前草稿并核对',400);
   if(previous?.content===prepared.content)return previous;
   const id=await this.entry(c,entry),revision=(previous?.revision||0)+1,updatedAt=new Date().toISOString();
   await c.execute('INSERT INTO wb_requirement_documents VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),content=VALUES(content),rules=VALUES(rules),updated_at=VALUES(updated_at)',[id,revision,prepared.content,JSON.stringify(prepared.rules),updatedAt]);
   await c.execute('INSERT INTO wb_requirement_document_versions VALUES (?,?,?,?)',[id,revision,prepared.content,updatedAt]);
   await this.indexDocument(c,id,prepared.rules);
   return {file,content:prepared.content,editorContent:stripMarkers(prepared.content),rules:prepared.rules,revision,updatedAt,storage:'mysql'};
 },
 async documentVersion(entryPath,revision){
  this.find(entryPath);if(!Number.isInteger(revision)||revision<1)fail('无效的文档版本',400);
  const [[row]]=await this.pool.execute('SELECT v.revision,v.content,v.captured_at AS updatedAt FROM wb_requirement_document_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? AND v.revision=?',[sha(entryPath),revision]);
  if(!row)fail('文档版本不存在',404);return {...row,editorContent:stripMarkers(row.content)};
 },
 async documentVersions(entryPath){
  this.find(entryPath);const [rows]=await this.pool.execute('SELECT v.revision,v.captured_at AS updatedAt FROM wb_requirement_document_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? ORDER BY v.revision DESC',[sha(entryPath)]);return rows;
 },
 async migrateDocuments(backupDir){
  const manifest=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8'));
  if(manifest.source!==this.root)fail('备份不属于当前需求目录',400);
  const baseline=new Map(manifest.files.map(f=>[f.path,f.sha256]));
  const entries=this.getTree().modules.flatMap(m=>m.features).filter(e=>e.docs?.requirement);
  const sources=entries.map(entry=>{const file=entry.docs.requirement,full=path.join(this.root,file),raw=fs.readFileSync(full,'utf8');if(fs.lstatSync(full).isSymbolicLink()||baseline.get(file)!==sha(raw)||baseline.get(file)!==sha(fs.readFileSync(path.join(backupDir,'snapshot',file))))fail('正文或备份已变化，请先重新备份：'+file);return {entry,file,raw}});
  return this.transaction(async c=>{
   const [[state]]=await c.query('SELECT migrated FROM wb_document_control WHERE id=1');if(state.migrated)return {alreadyMigrated:true};
   let versions=0,rules=0;
   for(const {entry,file,raw}of sources){
    const id=await this.entry(c,entry);const [[exists]]=await c.execute('SELECT revision FROM wb_requirement_documents WHERE entry_id=?',[id]);if(exists)fail('迁移前已有数据库正文，请先核对，未覆盖：'+entry.path);
    const prepared=prepareMarkdown(raw,file,{legacyIds:true});
    if(prepared.rules.some(r=>r.ambiguous))fail('原文存在重复段落标识，请核对：'+file);
    const [history]=await c.execute('SELECT content,captured_at FROM wb_document_versions WHERE entry_id=? ORDER BY captured_at,source_hash',[id]);
    const [[cached]]=await c.execute('SELECT content FROM wb_documents WHERE entry_id=?',[id]);
    const snapshots=[...history.map(h=>({content:h.content,at:h.captured_at})),...(cached?[{content:cached.content,at:new Date().toISOString()}]:[]),{content:raw,at:new Date().toISOString()}];
    const seen=new Set();let revision=0;
    for(const snap of snapshots){const key=sha(snap.content);if(key===sha(prepared.content)||seen.has(key))continue;seen.add(key);await c.execute('INSERT INTO wb_requirement_document_versions VALUES (?,?,?,?)',[id,++revision,snap.content,snap.at]);}
    const at=new Date().toISOString();await c.execute('INSERT INTO wb_requirement_document_versions VALUES (?,?,?,?)',[id,++revision,prepared.content,at]);
    await c.execute('INSERT INTO wb_requirement_documents VALUES (?,?,?,?,?)',[id,revision,prepared.content,JSON.stringify(prepared.rules),at]);
    await this.indexDocument(c,id,prepared.rules);versions+=revision;rules+=prepared.rules.length;
   }
   await c.execute('UPDATE wb_document_control SET migrated=1 WHERE id=1');return {documents:sources.length,versions,rules};
  });
 },
};
module.exports={DOCUMENT_SCHEMA,methods,stripMarkers,reconcileDocument};
