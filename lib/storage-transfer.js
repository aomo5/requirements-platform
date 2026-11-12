"use strict";
const fs = require("fs"), path = require("path");
const { scanRequirements } = require("./scan");
const { validatePages } = require("./design-store");
const { validateContent } = require("./flow-store");
const { validateNotes } = require("./annotation-store");
const { sha, stampElements, atomicWrite, resolveElement } = require("./stable-identities");
const layouts = {
  design: ["原型设计", "设计工作台.json", ".design-history"],
  flow: ["流程设计", "流程工作台.json", ".flow-history"],
  annotations: ["页面设计", "元素说明.json", ".annotations-history"],
};
function walk(root) {
  const result = [];
  function visit(dir) { for (const d of fs.readdirSync(dir,{withFileTypes:true})) {
    if ([".git","node_modules",".runtime",".env",".storage-mode.json"].includes(d.name) || d.name.startsWith(".env.")) continue;
    const file = path.join(dir,d.name);
    if (d.isSymbolicLink()) throw new Error(`备份不接受符号链接：${file}`);
    if (d.isDirectory()) visit(file); else if (d.isFile()) result.push(file);
  } }
  visit(root); return result;
}
function backup(root, output) {
  if (fs.existsSync(output)) throw new Error("备份目录必须是新目录");
  if (path.resolve(output).startsWith(path.resolve(root)+path.sep)) throw new Error("备份必须位于需求目录外");
  fs.mkdirSync(output,{recursive:true,mode:0o700}); const files=[];
  for (const file of walk(root)) {
    const relative = path.relative(root,file), dest=path.join(output,"snapshot",relative), content=fs.readFileSync(file);
    fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,content,{mode:fs.statSync(file).mode});
    const digest=sha(content);
    if (sha(fs.readFileSync(file))!==digest || sha(fs.readFileSync(dest))!==digest) throw new Error(`备份期间文件变化：${relative}`);
    files.push({path:relative,sha256:digest,bytes:content.length});
  }
  const manifest={source:fs.realpathSync(root),createdAt:new Date().toISOString(),files};
  fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2)); return manifest;
}
function fingerprint(html) { let h=2166136261; for(let i=0;i<html.length;i++){h^=html.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,"0"); }
function importFiles(root) {
  const out=[];
  for (const file of walk(root)) for (const [kind,[dir,name,history]] of Object.entries(layouts)) {
    const relative=path.relative(root,file).split(path.sep).join("/"), parts=relative.split("/");
    const head=parts.at(-1)===name && parts.at(-2)===dir;
    const historical=parts.at(-2)===history && parts.at(-3)===dir && /^\d+\.json$/.test(parts.at(-1));
    if(!head && !historical) continue;
    const entryPath=parts.slice(0,head?-2:-3).join("/"), content=fs.readFileSync(file), payload=JSON.parse(content.toString());
    if(payload.schemaVersion!==1 || !Number.isInteger(payload.revision) || payload.revision<1) throw new Error(`无法识别版本：${relative}`);
    if(historical && Number(parts.at(-1).replace('.json',''))!==payload.revision) throw new Error(`历史文件版本号不匹配：${relative}`);
    if(kind==='design') validatePages(payload.pages,{path:entryPath});
    if(kind==='flow') validateContent(payload,entryPath);
    if(kind==='annotations') validateNotes(payload.notes);
    out.push({relative,entryPath,kind,head,content,payload});
  }
  return out;
}
async function migrate(db, backupDir) {
  const manifest=JSON.parse(fs.readFileSync(path.join(backupDir,"manifest.json"),"utf8"));
  if(manifest.source!==db.root) throw new Error("备份不属于当前需求目录");
  const baseline=new Map(manifest.files.map(f=>[f.path,f.sha256])), files=importFiles(db.root);
  const tree=db.getTree(), entries=tree.modules.flatMap(m=>m.features);
  // Check fresh data and documents against a verified backup before any writes.
  for(const file of [...files.map(f=>f.relative),...entries.map(e=>e.docs?.requirement).filter(Boolean)]) {
    if(baseline.get(file)!==sha(fs.readFileSync(path.join(db.root,file)))) throw new Error(`请先重新备份已变化的文件：${file}`);
    if(baseline.get(file)!==sha(fs.readFileSync(path.join(backupDir,'snapshot',file)))) throw new Error(`备份校验失败：${file}`);
  }
  const report=await db.transaction(async(c,control)=>{
    if(control.migrated) throw new Error("当前库已经迁移，拒绝重复导入；请运行 verify");
    const [[count]]=await c.query("SELECT COUNT(*) AS n FROM wb_workspaces"); if(count.n) throw new Error("目标库不是空库");
    const ids=new Map();
    for(const entry of entries) ids.set(entry.path,await db.entry(c,entry));
    const versions=new Map();
    for(const file of files) {
      const id=ids.get(file.entryPath); if(!id) throw new Error(`存在未收录数据：${file.relative}`);
      const key=[id,file.kind,file.payload.revision].join('/'), existing=versions.get(key);
      if(existing && JSON.stringify(existing)!==JSON.stringify(file.payload)) throw new Error(`同版本存在不同内容：${file.relative}`);
      if(!existing) {await c.execute("INSERT INTO wb_versions VALUES (?,?,?,?)",[id,file.kind,file.payload.revision,JSON.stringify(file.payload)]);versions.set(key,file.payload);}
      await c.execute("INSERT INTO wb_import_files VALUES (?,?,?,?)",[sha(file.relative),file.relative,sha(file.content),file.content]);
      if(file.head) await c.execute("INSERT INTO wb_workspaces VALUES (?,?,?,?)",[id,file.kind,file.payload.revision,JSON.stringify(file.payload)]);
    }
    for(const file of files.filter(f=>!f.head)) {
      const head=files.find(h=>h.head&&h.entryPath===file.entryPath&&h.kind===file.kind);
      if(!head || file.payload.revision>head.payload.revision) throw new Error(`历史版本缺少有效当前文件：${file.relative}`);
    }
    let rules=0, pages=0, flows=0, notes=0, identityRevisions=0;
    for(const entry of entries) rules+=(await db.rules(entry.path,c,{legacyIds:true})).rules.length;
    for(const file of files.filter(f=>f.head).sort((a,b)=>Object.keys(layouts).indexOf(a.kind)-Object.keys(layouts).indexOf(b.kind))) {
      const id=ids.get(file.entryPath), w=structuredClone(file.payload); let changed=false;
      if(file.kind==='design') { pages+=w.pages.length; for(const page of w.pages){const html=stampElements(page.html);changed ||= html!==page.html;page.html=html;} validatePages(w.pages,{path:file.entryPath}); }
      if(file.kind==='flow') flows+=w.flows.length;
      if(file.kind==='annotations') {
        notes+=w.notes.length;
        const design=(await db.read('design',file.entryPath,c)).workspace;
        const oldDesign=files.find(f=>f.head&&f.kind==='design'&&f.entryPath===file.entryPath)?.payload;
        for(const note of w.notes) if(note.target.type==='page-element' && !note.target.anchor.elementId) {
          const page=design.pages.find(p=>p.id===note.target.pageId), old=oldDesign?.pages.find(p=>p.id===note.target.pageId), a=note.target.anchor;
          if(!page || !old || a.strength==='path' && a.htmlHash!==fingerprint(old.html)) continue;
          const before=resolveElement(old.html,a.selector), found=resolveElement(page.html,a.selector);
          if(before?.tag===a.tag && found?.id && found.tag===a.tag){note.target.anchor={...a,elementId:found.id,selector:`[data-wb-element="${found.id}"]`,strength:'stable',htmlHash:fingerprint(page.html),contextHash:''};changed=true;}
        }
      }
      if(changed){w.revision++;w.updatedAt=new Date().toISOString();await db.put(c,id,file.kind,w);identityRevisions++;}
      else await db.index(c,id,file.kind,w);
    }
    // Record document originals as well as their marker-bearing snapshots.
    await c.execute("UPDATE wb_control SET migrated=1,root_path=? WHERE id=1",[db.root]);
    return {entries:entries.length,sourceFiles:files.length,importedVersions:versions.size,identityRevisions,pages,flows,notes,rules,backup:backupDir};
  });
  fs.writeFileSync(path.join(backupDir,'migration.json'),JSON.stringify(report,null,2)); return report;
}
async function verify(db) {
  const [imports]=await db.pool.query("SELECT path,sha256,content FROM wb_import_files");
  const [versions]=await db.pool.query("SELECT e.path,v.kind,v.revision,v.payload FROM wb_versions v JOIN wb_entries e ON e.id=v.entry_id");
  const byKey=new Map(versions.map(v=>[[v.path,v.kind,v.revision].join('/'),v.payload]));
  for(const file of imports) {
    if(sha(file.content)!==file.sha256) throw new Error(`原始数据哈希不一致：${file.path}`);
    const original=JSON.parse(file.content.toString()), parts=file.path.split('/'), kind=Object.keys(layouts).find(k=>parts.includes(layouts[k][1])||parts.includes(layouts[k][2]));
    const entry=parts.slice(0,parts.includes(layouts[kind][2])?-3:-2).join('/');
    if(!require('util').isDeepStrictEqual(original,byKey.get([entry,kind,original.revision].join('/')))) throw new Error(`原始版本内容不一致：${file.path}`);
  }
  const [[heads]]=await db.pool.query("SELECT COUNT(*) AS n FROM wb_workspaces");
  const [[links]]=await db.pool.query("SELECT COUNT(*) AS n FROM wb_links");
  return {verified:true,originalFiles:imports.length,versions:versions.length,currentWorkspaces:heads.n,links:links.n};
}
const TABLES=['wb_control','wb_entries','wb_workspaces','wb_versions','wb_documents','wb_document_versions','wb_rule_index','wb_element_index','wb_links','wb_import_files','wb_document_control','wb_requirement_documents','wb_requirement_document_versions','wb_supporting_control','wb_supporting_documents','wb_supporting_document_versions','wb_design_documents','wb_entry_states','wb_catalog_records','wb_test_links','wb_test_runs'];
async function exportData(db, output, { freeze=false }={}) {
  if(freeze) await db.transaction(async c=>{await c.query('UPDATE wb_control SET maintenance=1 WHERE id=1');});
  let manifest;
  const dump=await db.transaction(async c=>{
    for (const entry of db.getTree().modules.flatMap(m=>m.features)) await db.rules(entry.path,c);
    manifest=backup(db.root,output);
    const data={};for(const table of TABLES){const [rows]=await c.query(`SELECT * FROM ${table}`);data[table]=rows;}
    const [syncTables]=await c.query("SHOW TABLES LIKE 'wb_gitee_sync'");
    if(syncTables.length){const [rows]=await c.query("SELECT * FROM wb_gitee_sync");data.wb_gitee_sync=rows;}
    for(const table of ['wb_users','wb_owners','wb_account_control','wb_sessions']) {
      const [found]=await c.query('SHOW TABLES LIKE ?', [table]);
      if(found.length){const [rows]=await c.query(`SELECT * FROM ${table}`);data[table]=rows;}
    }
    return data;
  },{maintenance:true});
  fs.writeFileSync(path.join(output,'database.json'),JSON.stringify(dump,null,2),{mode:0o600});
  const byId=new Map(dump.wb_entries.map(e=>[e.id,e.path]));
  // Overlay exported current states and every version onto a copy of the files.
  for(const v of dump.wb_versions){const [dir,,history]=layouts[v.kind];atomicWrite(path.join(output,'snapshot',byId.get(v.entry_id),dir,history,`${v.revision}.json`),JSON.stringify(v.payload,null,2)+'\n');}
  for(const w of dump.wb_workspaces){const [dir,name]=layouts[w.kind];atomicWrite(path.join(output,'snapshot',byId.get(w.entry_id),dir,name),JSON.stringify(w.payload,null,2)+'\n');}
  for(const d of dump.wb_requirement_documents||[])atomicWrite(path.join(output,'snapshot',byId.get(d.entry_id),'需求文档.md'),d.content);
  for(const d of dump.wb_supporting_documents||[])atomicWrite(path.join(output,'snapshot',d.file),d.content);
  const exports=walk(path.join(output,'snapshot')).map(file=>({path:path.relative(path.join(output,'snapshot'),file),sha256:sha(fs.readFileSync(file))}));
  fs.writeFileSync(path.join(output,'export-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),databaseSha256:sha(fs.readFileSync(path.join(output,'database.json'))),files:exports},null,2));
  return {output,workspaces:dump.wb_workspaces.length,versions:dump.wb_versions.length,freeze,baseline:manifest};
}
async function rollback(db, output, modeFile) {
  const result=await exportData(db,output,{freeze:true});
  const baseline=new Map(result.baseline.files.map(f=>[f.path,f.sha256]));
  // The DB stays frozen until restart in files mode. A partial retry can always
  // recover from the complete export; no volume or database is deleted.
  for(const file of importFiles(path.join(output,'snapshot'))) {
    const target=path.join(db.root,file.relative), before=fs.existsSync(target)?fs.readFileSync(target,'utf8'):undefined;
    if(before!==undefined && sha(before)!==baseline.get(file.relative)) throw new Error(`撤回时文件已变化，导出已保留：${file.relative}`);
    atomicWrite(target,file.content,before);
  }
  const dump=JSON.parse(fs.readFileSync(path.join(output,'database.json'),'utf8')),byId=new Map(dump.wb_entries.map(e=>[e.id,e.path]));
  for(const doc of dump.wb_requirement_documents || []){const relative=byId.get(doc.entry_id)+'/需求文档.md',target=path.join(db.root,relative),before=fs.existsSync(target)?fs.readFileSync(target,'utf8'):undefined;if(before!==undefined&&sha(before)!==baseline.get(relative))throw new Error('撤回时正文已变化：'+relative);atomicWrite(target,doc.content,before);}
  for(const doc of dump.wb_supporting_documents||[]){const target=path.join(db.root,doc.file),before=fs.existsSync(target)?fs.readFileSync(target,'utf8'):undefined;if(before!==undefined&&sha(before)!==baseline.get(doc.file))throw new Error('撤回时文档已变化：'+doc.file);atomicWrite(target,doc.content,before);}
  atomicWrite(modeFile,JSON.stringify({mode:'files',export:output,at:new Date().toISOString()},null,2));
  return {output:result.output,workspaces:result.workspaces,versions:result.versions,mode:'files',restartRequired:true};
}
module.exports={layouts,backup,importFiles,migrate,verify,exportData,rollback,TABLES};
