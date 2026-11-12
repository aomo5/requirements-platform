"use strict";

const fs = require("node:fs");
const { sha } = require("./stable-identities");
const { renderMarkdown } = require("./markdown");
const { readableDocument, rewriteDocumentLinks } = require("./document-links");
const { findEntryByPath } = require("./scan");

const SCHEMA = [`CREATE TABLE IF NOT EXISTS wb_design_documents (
  entry_id CHAR(36) CHARACTER SET ascii NOT NULL, file_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  file TEXT NOT NULL, source_revision INT NOT NULL, target VARCHAR(16) NOT NULL,
  page_id VARCHAR(80) CHARACTER SET ascii NOT NULL DEFAULT '', design_revision INT NOT NULL,
  migrated_at VARCHAR(32) NOT NULL, PRIMARY KEY(entry_id,file_hash),
  FOREIGN KEY(entry_id,file_hash) REFERENCES wb_supporting_documents(entry_id,file_hash)
) ENGINE=InnoDB`];

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

function designDocumentUrl(entryPath, mapping) {
  const params = new URLSearchParams({ path: entryPath, view: "design" });
  if (mapping.pageId) params.set("prototype", "design:" + mapping.pageId);
  if (mapping.target === "history") params.set("historyDocument", mapping.file);
  else params.set("inspector", mapping.pageId ? "description" : "overview");
  return "/#" + params;
}

async function readMappings(db, entryPath, connection = db.pool) {
  const [rows] = await connection.execute(
    "SELECT d.file,d.source_revision,d.target,d.page_id,d.design_revision,d.migrated_at FROM wb_design_documents d JOIN wb_entries e ON e.id=d.entry_id WHERE e.path_hash=?",
    [sha(entryPath)],
  );
  return rows.map(row => ({
    file: row.file, sourceRevision: row.source_revision, target: row.target,
    pageId: row.page_id, designRevision: row.design_revision, migratedAt: row.migrated_at,
  }));
}

async function validateMigrations(db, connection, entryPath, input, design) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 200) fail("页面说明迁移清单无效", 400);
  if (!input.length) return [];
  const prior = await readMappings(db, entryPath, connection);
  const seen = new Set();
  const result = [];

  for (const mapping of input) {
    if (!mapping || typeof mapping !== "object" || !["page", "overview", "history"].includes(mapping.target)
        || !Number.isInteger(mapping.sourceRevision) || mapping.sourceRevision < 1) {
      fail("页面说明迁移目标或来源版本无效", 400);
    }
    const file = db.validateDocumentFile(entryPath, mapping.file);
    if (!file.startsWith(entryPath + "/页面设计/") || seen.has(file)) fail("只可迁移本需求内不重复的页面说明", 400);
    seen.add(file);
    const document = await db.readDocumentFile(entryPath, file, connection);
    if (!document || document.revision !== mapping.sourceRevision) fail("页面说明已变化，请重新读取后迁移：" + file);

    const pageId = mapping.pageId || "";
    if (mapping.target === "page") {
      const page = design.pages.find(item => item.id === pageId);
      if (!page) fail("页面说明的承接页面不存在", 400);
      const owner = page.descriptionPageId ? design.pages.find(item => item.id === page.descriptionPageId) : page;
      if (!owner?.description?.trim()) fail("请先补齐承接页面的有效说明", 400);
    } else if (pageId) {
      fail("设计总说明和历史记录不指定页面", 400);
    }
    if (mapping.target === "overview" && !design.overview?.trim()) fail("请先补齐设计总说明", 400);

    const existing = prior.find(item => item.file === file);
    if (existing) {
      if (existing.sourceRevision !== mapping.sourceRevision || existing.target !== mapping.target || existing.pageId !== pageId) {
        fail("此页面说明已经迁移，不能覆盖原迁移记录");
      }
      continue;
    }
    result.push({
      file, sourceRevision: mapping.sourceRevision, target: mapping.target, pageId,
      content: document.content, updatedAt: document.updatedAt,
    });
  }
  return result;
}

async function saveMigrations(db, connection, entryPath, mappings, revision) {
  const id = await db.entry(connection, db.find(entryPath));
  for (const mapping of mappings) {
    const fileHash = sha(mapping.file);
    await connection.execute("INSERT IGNORE INTO wb_supporting_document_versions VALUES (?,?,?,?,?)",
      [id, fileHash, mapping.sourceRevision, mapping.content, mapping.updatedAt || new Date().toISOString()]);
    await connection.execute("INSERT INTO wb_design_documents VALUES (?,?,?,?,?,?,?,?)",
      [id, fileHash, mapping.file, mapping.sourceRevision, mapping.target, mapping.pageId, revision, new Date().toISOString()]);
  }
}

async function legacyDocuments(db, entry) {
  const documents = new Map((entry.pageDesigns || []).map(item => [item.path, { file: item.path, revision: 0 }]));
  const mappings = db ? await readMappings(db, entry.path) : [];
  if (db) {
    const [rows] = await db.pool.execute(
      "SELECT d.file,d.revision FROM wb_supporting_documents d JOIN wb_entries e ON e.id=d.entry_id WHERE e.path_hash=? AND d.kind='page' ORDER BY d.file",
      [sha(entry.path)],
    );
    for (const row of rows) documents.set(row.file, row);
  }
  return [...documents.values()].map(document => ({
    ...document,
    name: document.file.split("/").at(-1).replace(/\.md$/i, ""),
    migration: mappings.find(mapping => mapping.file === document.file) || null,
  }));
}

function createDesignDocumentsHandler(db, sendJson, { getTree, root, designStore = db?.store("design") }) {
  return async (request, response, url) => {
    try {
      if (request.method !== "GET") fail("不支持的方法", 405);
      const entryPath = url.searchParams.get("path");
      const tree = await getTree();
      const entry = findEntryByPath(tree, entryPath);
      if (!entry) fail("需求不存在", 404);

      const render = (content, sourceFile) => rewriteDocumentLinks(renderMarkdown(content), { root, tree, sourceFile });
      if (url.pathname === "/api/design/description") {
        const { workspace } = await designStore.read(entryPath);
        const pageId = url.searchParams.get("page");
        const page = pageId ? workspace.pages.find(item => item.id === pageId) : null;
        if (pageId && !page) fail("设计页面不存在", 404);
        const owner = page?.descriptionPageId ? workspace.pages.find(item => item.id === page.descriptionPageId) : page;
        const content = page ? owner?.description || "" : workspace.overview || "";
        sendJson(response, 200, {
          revision: workspace.revision, pageId: page?.id || "", descriptionPageId: owner?.id || "",
          title: page?.name || "设计说明", content, html: render(content, entryPath + "/需求文档.md"),
        });
        return;
      }

      if (url.pathname !== "/api/design/documents") fail("设计说明接口不存在", 404);
      const documents = await legacyDocuments(db, entry);
      const file = url.searchParams.get("file");
      if (file === null) {
        sendJson(response, 200, { documents });
        return;
      }

      const record = documents.find(document => document.file === file);
      if (!record) fail("此文件不在设计的旧页面说明中", 404);
      const revision = url.searchParams.get("revision");
      if (record.revision > 0) {
        if (revision === null) {
          sendJson(response, 200, { name: record.name, versions: await db.fileVersions(entryPath, file) });
        } else {
          const version = await db.fileVersion(entryPath, file, Number(revision));
          sendJson(response, 200, { ...version, html: render(version.content, file) });
        }
        return;
      }

      const document = readableDocument(root, tree, file);
      if (revision !== null || !document?.fullPath || document.entry.path !== entryPath) fail("页面说明文件不存在", 404);
      sendJson(response, 200, {
        name: record.name, versions: [], html: render(fs.readFileSync(document.fullPath, "utf8"), file),
      });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "设计说明读取失败" });
    }
  };
}

module.exports = { SCHEMA, readMappings, validateMigrations, saveMigrations, designDocumentUrl, createDesignDocumentsHandler };
