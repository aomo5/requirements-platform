"use strict";
const mysql = require("mysql2/promise");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { databaseConfig } = require("./storage-config");
const { validatePages, createDesignStore } = require("./design-store");
const { validateContent, validateRelations } = require("./flow-store");
const { validateNotes } = require("./annotation-store");
const { readableDocument } = require("./document-links");
const { sha, stampElements, prepareMarkdown, atomicWrite, resolveElement, elementRecords } = require("./stable-identities");
const empty = kind => ({ schemaVersion: 1, revision: 0, updatedAt: null, ...(kind === "design" ? { pages: [] } : kind === "flow" ? { applicability: "undecided", reason: "", flows: [], references: [] } : { notes: [] }) });
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const same = require("util").isDeepStrictEqual;
const LIMITS = { design: 4*1024*1024, flow: 2*1024*1024, annotations: 1024*1024 };
const { DOCUMENT_SCHEMA, methods: documentMethods } = require("./document-storage");
const {SUPPORTING_SCHEMA,methods:supportingMethods}=require("./supporting-documents");
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wb_control (id INT PRIMARY KEY, schema_version INT NOT NULL, migrated BOOLEAN NOT NULL DEFAULT 0, maintenance BOOLEAN NOT NULL DEFAULT 0, root_path TEXT) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_entries (id CHAR(36) CHARACTER SET ascii PRIMARY KEY, path_hash CHAR(64) CHARACTER SET ascii NOT NULL UNIQUE, path TEXT NOT NULL, metadata JSON NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_workspaces (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, kind VARCHAR(16) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, payload JSON NOT NULL, PRIMARY KEY(entry_id,kind), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_versions (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, kind VARCHAR(16) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, payload JSON NOT NULL, PRIMARY KEY(entry_id,kind,revision), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_documents (entry_id CHAR(36) CHARACTER SET ascii PRIMARY KEY, source_hash CHAR(64) CHARACTER SET ascii NOT NULL, content MEDIUMTEXT NOT NULL, rules JSON NOT NULL, FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_document_versions (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, source_hash CHAR(64) CHARACTER SET ascii NOT NULL, content MEDIUMTEXT NOT NULL, captured_at VARCHAR(32) NOT NULL, PRIMARY KEY(entry_id,source_hash), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_rule_index (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, rule_id VARCHAR(80) CHARACTER SET ascii NOT NULL, payload JSON NOT NULL, present BOOLEAN NOT NULL, PRIMARY KEY(entry_id,rule_id), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_element_index (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, page_id VARCHAR(80) CHARACTER SET ascii NOT NULL, element_id VARCHAR(80) CHARACTER SET ascii NOT NULL, payload JSON NOT NULL, present BOOLEAN NOT NULL, PRIMARY KEY(entry_id,page_id,element_id), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wb_links (entry_id CHAR(36) CHARACTER SET ascii NOT NULL, note_id VARCHAR(80) CHARACTER SET ascii NOT NULL, rule_id VARCHAR(80) CHARACTER SET ascii NOT NULL, target_key CHAR(64) CHARACTER SET ascii NOT NULL, payload JSON NOT NULL, PRIMARY KEY(entry_id,note_id,rule_id), KEY rule_lookup(entry_id,rule_id), KEY target_lookup(entry_id,target_key), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
  ...require("./entry-state").SCHEMA,
  ...require("./catalog-storage").SCHEMA,
  ...DOCUMENT_SCHEMA,
  ...require("./test-module").SCHEMA,
  ...SUPPORTING_SCHEMA,
  `CREATE TABLE IF NOT EXISTS wb_import_files (path_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY, path TEXT NOT NULL, sha256 CHAR(64) CHARACTER SET ascii NOT NULL, content MEDIUMBLOB NOT NULL) ENGINE=InnoDB`,
];

class MysqlStorage {
  constructor(root, getTree, config = databaseConfig()) { this.root = fs.realpathSync(root); this.getTree = getTree; this.pool = mysql.createPool(config); }
  async init({ allowUnmigrated = false, allowMaintenance = false } = {}) {
    for (const sql of SCHEMA) await this.pool.query(sql);
    await this.pool.execute("INSERT IGNORE INTO wb_supporting_control (id,migrated) VALUES (1,0)");
    await this.pool.execute("INSERT IGNORE INTO wb_document_control (id,migrated) VALUES (1,0)");
    await this.pool.execute("INSERT IGNORE INTO wb_control (id,schema_version) VALUES (1,1)");
    const [[control]] = await this.pool.query("SELECT * FROM wb_control WHERE id=1");
    if (control.maintenance && !allowMaintenance) fail("数据库已冻结，请使用撤回后的文件模式或核对导出后恢复");
    if (control.schema_version !== 1) fail("数据库版本不兼容");
    if (control.root_path && control.root_path !== this.root) fail("数据库属于另一个需求目录，拒绝混用");
    if (!allowUnmigrated && !control.migrated) fail("数据库尚未迁移并核验，工作台未切换");
    await this.initCatalog();
    await this.refreshDocumentEntries();
  }
  async transaction(action, { maintenance = false } = {}) {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      // All graph mutations share one lock, including revision-zero creates.
      // This prevents interleaved cross-requirement edits from creating cycles.
      const [[control]] = await c.query("SELECT * FROM wb_control WHERE id=1 FOR UPDATE");
      if (control.maintenance && !maintenance) fail("工作台正在迁移或撤回，当前修改尚未保存，请稍后重试", 503);
      const result = await action(c, control); await c.commit(); return result;
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }
  find(entryPath) {
    if (typeof entryPath !== "string" || !entryPath || entryPath.length > 999 || entryPath.includes("\\") || entryPath.split("/").some(p => !p || p === "." || p === "..")) fail("请选择有效的需求", 400);
    const entry = this.getTree().modules.flatMap(m => m.features).find(e => e.path === entryPath) || this.documentEntries?.get(entryPath);
    if (!entry) fail("需求不存在", 404);
    for (let current = this.root, i = 0, parts = entryPath.split("/"); i < parts.length; i++) {
      current = path.join(current, parts[i]); const stat=fs.lstatSync(current,{throwIfNoEntry:false}); if(stat?.isSymbolicLink()) fail("需求路径包含符号链接", 403); if(!stat&&!this.documentEntries?.has(entryPath))fail("需求目录不存在",404);
    }
    return entry;
  }
  async entry(c, entry) {
    const hash = sha(entry.path);
    await c.execute("INSERT INTO wb_entries (id,path_hash,path,metadata) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE metadata=VALUES(metadata)", [crypto.randomUUID(), hash, entry.path, JSON.stringify({ module: entry.module, feature: entry.feature })]);
    const [[row]] = await c.execute("SELECT id FROM wb_entries WHERE path_hash=?", [hash]); return row.id;
  }
  async read(kind, entryPath, c = this.pool) {
    const entry = this.find(entryPath);
    const [[row]] = await c.execute("SELECT w.payload FROM wb_workspaces w JOIN wb_entries e ON e.id=w.entry_id WHERE e.path_hash=? AND w.kind=?", [sha(entryPath), kind]);
    return { entry, workspace: row?.payload || empty(kind) };
  }
  async rules(entryPath, c, { legacyIds = false, readOnly = false } = {}) {
    if (!c) return this.transaction(conn => this.rules(entryPath, conn, { legacyIds, readOnly }));
    const canonical = await this.document(entryPath, c);
    if (canonical) return { ...canonical, html: require("./requirement-rules").decorateRequirementRules(require("./markdown").renderMarkdown(canonical.content), canonical.file).html };
    const [[documentState]] = await c.query("SELECT migrated FROM wb_document_control WHERE id=1");
    if (documentState.migrated) return { file: null, rules: [] };
    const entry = this.find(entryPath), file = entry.docs?.requirement;
    if (!file) return { file: null, rules: [] };
    const doc = readableDocument(this.root, this.getTree(), file);
    if (!doc || doc.entry.path !== entryPath) fail("主需求文档不可读取", 403);
    const raw = fs.readFileSync(doc.fullPath, "utf8"), prepared = prepareMarkdown(raw, file, { legacyIds });
    if (readOnly) return { file, rules: prepared.rules, html: prepared.html, content: prepared.content };
    const id = await this.entry(c, entry);
    const hash = sha(prepared.content);
    const [[existing]] = await c.execute("SELECT source_hash FROM wb_documents WHERE entry_id=?", [id]);
    if (existing?.source_hash !== hash) {
      for (const content of new Set([raw, prepared.content])) await c.execute("INSERT IGNORE INTO wb_document_versions VALUES (?,?,?,?)", [id, sha(content), content, new Date().toISOString()]);
      // Persist the stable identity in the canonical Markdown. If the SQL
      // transaction later rolls back, the same IDs will be retried, never lost.
      if (prepared.content !== raw) atomicWrite(doc.fullPath, prepared.content, raw);
      await c.execute("INSERT INTO wb_documents VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE source_hash=VALUES(source_hash),content=VALUES(content),rules=VALUES(rules)", [id, hash, prepared.content, JSON.stringify(prepared.rules)]);
      await c.execute("UPDATE wb_rule_index SET present=0 WHERE entry_id=?", [id]);
      for (const rule of prepared.rules) await c.execute("INSERT INTO wb_rule_index VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE payload=VALUES(payload),present=1", [id, rule.blockId, JSON.stringify(rule)]);
    }
    return { file, rules: prepared.rules, html: prepared.html, content: prepared.content };
  }
  async index(c, id, kind, workspace) {
    if (kind === "design") {
      await c.execute("UPDATE wb_element_index SET present=0 WHERE entry_id=?", [id]);
      for (const page of workspace.pages) for (const element of elementRecords(page.html)) await c.execute("INSERT INTO wb_element_index VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE payload=VALUES(payload),present=1", [id, page.id, element.id, JSON.stringify(element)]);
    }
    if (kind === "annotations") {
      await c.execute("DELETE FROM wb_links WHERE entry_id=?", [id]);
      for (const note of workspace.notes) for (const ref of note.requirements || []) {
        const t=note.target;
        const key=t.type==='page-element' ? [t.type,t.pageId,t.route,t.anchor.elementId || t.anchor.selector,t.anchor.tag, ...(t.anchor.strength==='path' ? [t.anchor.htmlHash,t.anchor.contextHash] : [])] : [t.type,t.flowId,t.nodeId || t.edgeId];
        await c.execute("INSERT INTO wb_links VALUES (?,?,?,?,?)", [id, note.id, ref.blockId, sha(JSON.stringify(key)), JSON.stringify({ target: t, requirement: ref })]);
      }
    }
  }
  async put(c, id, kind, workspace) {
    await c.execute("INSERT INTO wb_versions VALUES (?,?,?,?)", [id, kind, workspace.revision, JSON.stringify(workspace)]);
    await c.execute("INSERT INTO wb_workspaces VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload)", [id, kind, workspace.revision, JSON.stringify(workspace)]);
    await this.index(c, id, kind, workspace);
  }
  async validateAnnotations(c, entryPath, notes, previous, restored, { flowWorkspace, designWorkspace, dryRun = false } = {}) {
    if (restored) return;
    const design = designWorkspace || (await this.read("design", entryPath, c)).workspace, flows = flowWorkspace || (await this.read("flow", entryPath, c)).workspace;
    const { rules } = await this.rules(entryPath, c, { readOnly: dryRun });
    for (const note of notes) {
      const old = previous.notes.find(n => n.id === note.id), target = note.target;
      if (!old || !same(old.target, target)) {
        if (target.type === "page-element") {
          const page = design.pages.find(p => p.id === target.pageId);
          if (!page) fail("页面已移除，请重新选择");
          if (target.anchor.elementId) {
            const found = resolveElement(page.html, `[data-wb-element="${target.anchor.elementId}"]`);
            if (!found || found.tag !== target.anchor.tag) fail("元素已变化，请重新选择");
          }
        } else {
          const flow = flows.flows.find(f => f.id === target.flowId);
          if (!flow || !(target.type === "flow-node" ? flow.nodes.some(n => n.id === target.nodeId) : flow.edges.some(e => e.id === target.edgeId))) fail("流程目标已移除，请重新选择");
        }
      }
      for (const ref of note.requirements) {
        if (old?.requirements.some(r => same(r, ref))) continue;
        if (!rules.some(r => !r.ambiguous && r.stable && r.file === ref.file && r.blockId === ref.blockId && r.quote === ref.quote && r.heading === ref.heading)) fail("需求原文已变化，请重新选择后关联");
      }
    }
  }
  async save(kind, entryPath, expectedRevision, input, restoreRevision) {
    return this.transaction(c => this.saveInTransaction(c, kind, entryPath, expectedRevision, input, restoreRevision));
  }
  // Shared by the normal single-resource API and atomic design/flow batches.
  // The caller must hold this.transaction's workspace mutation lock.
  async saveInTransaction(c, kind, entryPath, expectedRevision, input, restoreRevision, { dryRun = false, flowWorkspace, designWorkspace } = {}) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail("缺少有效版本号", 400);
      const { entry, workspace: previous } = await this.read(kind, entryPath, c);
      if (previous.revision !== expectedRevision) fail("已在另一窗口更新，请重新加载；当前草稿未覆盖已保存数据");
      const restored = restoreRevision !== undefined;
      if (restored) {
        if (!Number.isInteger(restoreRevision) || restoreRevision < 1 || restoreRevision >= previous.revision) fail("请选择有效历史版本", 400);
        const id = await this.entry(c, entry);
        const [[row]] = await c.execute("SELECT payload FROM wb_versions WHERE entry_id=? AND kind=? AND revision=?", [id, kind, restoreRevision]);
        if (!row) fail("历史版本不存在", 404);
        input = kind === "design" ? row.payload.pages : kind === "annotations" ? row.payload.notes : row.payload;
      }
      const now = new Date().toISOString(); let content;
      if (kind === "design") content = { pages: validatePages(validatePages(input, entry).map(p => ({ ...p, html: stampElements(p.html) })), entry) };
      if (kind === "flow") {
        content = validateContent(input, entryPath);
        const [rows] = await c.query("SELECT e.path,w.payload FROM wb_workspaces w JOIN wb_entries e ON e.id=w.entry_id WHERE w.kind='flow'");
        validateRelations({ entry }, previous, content, { entries: rows.map(r => ({ entry: { path: r.path, feature: r.path.split('/').at(-1) }, workspace: r.payload })), issues: [] });
        const design = (await this.read("design", entryPath, c)).workspace;
        for (const flow of content.flows) for (const node of flow.nodes) {
          const old = previous.flows.find(f => f.id === flow.id)?.nodes.find(n => n.id === node.id);
          if (node.pageId && node.pageId !== old?.pageId && !design.pages.some(p => p.id === node.pageId)) fail("关联页面不存在，请重新选择");
        }
      }
      if (kind === "annotations") {
        const notes = validateNotes(input);
        await this.validateAnnotations(c, entryPath, notes, previous, restored, { flowWorkspace, designWorkspace, dryRun });
        content = { notes: notes.map((note, i) => { const old = previous.notes.find(n => n.id === note.id); return { ...note, createdAt: old?.createdAt || (restored && input[i].createdAt) || now, updatedAt: old && same([old.target,old.text,old.requirements],[note.target,note.text,note.requirements]) ? old.updatedAt : now }; }) };
      }
      const workspace = { schemaVersion: 1, revision: previous.revision + (dryRun ? 0 : 1), updatedAt: dryRun ? previous.updatedAt : now, ...content };
      if (Buffer.byteLength(JSON.stringify(workspace,null,2)) > LIMITS[kind]) fail("内容超出保存容量，请拆分页面或流程", 413);
      if (!dryRun) await this.put(c, await this.entry(c, entry), kind, workspace);
      return workspace;
  }
  store(kind) {
    const sourceStore = kind === "design" ? createDesignStore(this.root, p => this.find(p)) : null;
    return {
      read: p => this.read(kind,p), save: (p,r,data) => this.save(kind,p,r,data), restore: (p,r,v) => this.save(kind,p,r,null,v),
      source: (p,f) => sourceStore.source(p,f),
      versions: async p => {
        const { workspace } = await this.read(kind,p);
        const [rows] = await this.pool.execute("SELECT v.payload FROM wb_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? AND v.kind=? ORDER BY v.revision DESC", [sha(p),kind]);
        return rows.map(({ payload: w }) => ({ revision: w.revision, updatedAt: w.updatedAt, current: w.revision === workspace.revision, [kind === "design" ? "pageCount" : kind === "flow" ? "flowCount" : "noteCount"]: (w.pages || w.flows || w.notes).length }));
      },
      catalog: async () => { const [rows] = await this.pool.query("SELECT e.path,w.payload FROM wb_workspaces w JOIN wb_entries e ON e.id=w.entry_id WHERE w.kind='flow'"); return { flows: rows.flatMap(r => r.payload.flows.map(f => ({ entryPath:r.path, feature:r.path.split('/').at(-1), id:f.id, name:f.name, parent:f.parent, ...(f.kind ? {kind:f.kind} : {}), nodes:f.nodes.map(n=>({id:n.id,label:n.label,type:n.type,...(n.call ? {call:n.call} : {}),...(n.contract ? {contract:n.contract} : {}),...(n.target ? {target:n.target} : {}),...(n.recovery ? {recovery:n.recovery} : {}),...(n.type === "event" ? {eventType:n.eventType,eventPhase:n.eventPhase} : {})})),updatedAt:r.payload.updatedAt }))), issues:[] }; },
    };
  }
  async decorateTree(tree) {
    await this.refreshDocumentEntries();
    for(const entry of this.documentEntries.values()){
      let module=tree.modules.find(m=>m.module===entry.module);if(!module){module={module:entry.module,path:entry.module,featureCount:0,features:[]};tree.modules.push(module)}
      if(!module.features.some(e=>e.path===entry.path)){module.features.push({...entry});module.featureCount=module.features.length}
    }
    tree.modules.sort((a,b)=>a.module.localeCompare(b.module,'zh-CN'));
    const [rows] = await this.pool.query("SELECT e.path,w.kind,w.payload FROM wb_workspaces w JOIN wb_entries e ON e.id=w.entry_id");
    const map = new Map(tree.modules.flatMap(m=>m.features).map(e=>[e.path,e]));
    for (const row of rows) {
      const entry = map.get(row.path), w = row.payload; if (!entry) continue;
      if (row.kind === "design") entry.design = { revision:w.revision, updatedAt:w.updatedAt, pages:w.pages.map(({id,name,width,height,route})=>({id,name,width,height,route})) };
      if (row.kind === "flow") entry.flow = { revision:w.revision, updatedAt:w.updatedAt, applicability:w.applicability, ownedCount:w.flows.length, referenceCount:w.references.length };
      if (w.updatedAt > (entry.updatedAt || "")) entry.updatedAt = w.updatedAt;
    }
    const [documents] = await this.pool.query("SELECT e.path,d.revision,d.updated_at FROM wb_requirement_documents d JOIN wb_entries e ON e.id=d.entry_id");
    for (const doc of documents) { const entry=map.get(doc.path); if(!entry)continue; entry.docs.requirement=doc.path+'/需求文档.md'; entry.document={storage:'mysql',revision:doc.revision,updatedAt:doc.updated_at}; entry.writingStatus={state:'ready',label:'需求已写'}; if(doc.updated_at>(entry.updatedAt||''))entry.updatedAt=doc.updated_at; }
    for(const [p,canonical]of this.documentEntries){const e=map.get(p);if(!e)continue;e.documentFiles=canonical.documentFiles;e.referenceDocuments=canonical.referenceDocuments;e.docs.task=canonical.docs.task;e.gitee=canonical.gitee;e.relatedRoutes=canonical.relatedRoutes;if(this.supportingMigrated){e.docs.spec=canonical.docs.spec;e.docs.contract=canonical.docs.contract;e.pageDesigns=canonical.pageDesigns;}if(canonical.updatedAt>(e.updatedAt||''))e.updatedAt=canonical.updatedAt;}
    for (const module of tree.modules) module.features.sort((a,b)=>(b.updatedAt || "").localeCompare(a.updatedAt || ""));
    tree.latestEntryPath = [...map.values()].sort((a,b)=>(b.updatedAt || "").localeCompare(a.updatedAt || ""))[0]?.path || "";
    const [states] = await this.pool.query("SELECT e.path,s.revision,s.archived,s.updated_at FROM wb_entry_states s JOIN wb_entries e ON e.id=s.entry_id");
    for(const entry of map.values())entry.archiveState={archived:false,revision:0,updatedAt:null};
    for(const row of states){const entry=map.get(row.path);if(entry)entry.archiveState={archived:!!row.archived,revision:row.revision,updatedAt:row.updated_at};}
    tree.archiveStorage='mysql';
    tree.giteeStatusSyncedAt=(await this.catalogRecord('gitee-status')).syncedAt||null;
    tree.catalogStorage='mysql';
    return tree;
  }
  async close() { await this.pool.end(); }
}
Object.assign(MysqlStorage.prototype, documentMethods,supportingMethods,require("./catalog-storage").methods,require("./entry-state").methods);
module.exports = { MysqlStorage, empty, LIMITS };
