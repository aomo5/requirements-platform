"use strict";

const { isDeepStrictEqual: same } = require("node:util");
const { validatePages, canEdit } = require("./design-store");
const { validateNotes } = require("./annotation-store");
const { stampElements, resolveElement } = require("./stable-identities");

const fail = (message, status = 409, details) => { throw Object.assign(new Error(message), { status, ...(details ? { details } : {}) }); };
const fingerprint = html => { let hash = 2166136261; for (let i = 0; i < html.length; i++) { hash ^= html.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); };
const flowLinks = workspace => workspace.flows.flatMap(flow => flow.nodes.filter(node => node.pageId).map(node => ({ flowId: flow.id, nodeId: node.id, pageId: node.pageId })));

function brokenPageLinks(workspace, links) {
  const ids = new Set(workspace.pages.map(page => page.id));
  return new Map(links.filter(link => !ids.has(link.pageId)).map(link => [JSON.stringify(link), link]));
}

function brokenPageNotes(workspace, notes) {
  const pages = new Map(workspace.pages.map(page => [page.id, page]));
  const broken = new Map();
  for (const note of notes) {
    const target = note.target;
    if (target.type !== "page-element") continue;
    const page = pages.get(target.pageId), anchor = target.anchor;
    // This checks the stored source only. Runtime route visibility is assessed
    // by the browser; a different page.route is not proof of an invalid target.
    const found = page && resolveElement(page.html, anchor.elementId ? `[data-wb-element="${anchor.elementId}"]` : anchor.selector);
    const valid = found && found.tag === anchor.tag && (anchor.strength !== "path" || fingerprint(page.html) === anchor.htmlHash);
    if (!valid) broken.set(JSON.stringify([note.id, target]), { noteId: note.id, target });
  }
  return broken;
}

function validateDesignReferences(previous, next, previousNotes, nextNotes, links) {
  const previousLinks = brokenPageLinks(previous, links);
  const introducedLinks = [...brokenPageLinks(next, links)].filter(([key]) => !previousLinks.has(key)).map(([, value]) => value);
  if (introducedLinks.length) fail("本次修改会使流程节点关联的页面失效，请先调整流程页面关联", 409, introducedLinks);
  const previousOrphans = brokenPageNotes(previous, previousNotes);
  const introducedNotes = [...brokenPageNotes(next, nextNotes)].filter(([key]) => !previousOrphans.has(key)).map(([, value]) => value);
  if (introducedNotes.length) fail("本次修改会留下失效的页面元素说明，请在同批修改中删除或迁移说明", 409, introducedNotes);
}

async function readDesignBundle(database, entryPath) {
  if (!database) fail("设计批量编辑需要 MySQL 存储，文件模式不支持", 501);
  return database.transaction(async c => ({
    workspace: (await database.read("design", entryPath, c)).workspace,
    annotations: (await database.read("annotations", entryPath, c)).workspace,
    context: { flowLinks: flowLinks((await database.read("flow", entryPath, c)).workspace) },
  }));
}

async function saveDesignBatch(database, entryPath, input) {
  if (!database) fail("设计批量编辑需要 MySQL 存储，文件模式不支持", 501);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("请求内容必须是 JSON 对象", 400);
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") fail("dryRun 必须为布尔值", 400);
  for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
    if (!Number.isInteger(input[key]) || input[key] < 0) fail("缺少有效版本号：" + key, 400);
  }
  return database.transaction(async c => {
    const { entry, workspace: previous } = await database.read("design", entryPath, c);
    const previousAnnotations = (await database.read("annotations", entryPath, c)).workspace;
    if (previous.revision !== input.expectedRevision || previousAnnotations.revision !== input.expectedAnnotationsRevision) {
      fail("设计或元素说明已在另一窗口更新，请重新读取并合并；本批修改未保存", 409,
        { revision: previous.revision, annotationsRevision: previousAnnotations.revision });
    }
    // Stamp before comparison and reference checks. Already prepared CLI HTML
    // retains its IDs, and saveInTransaction's second stamp is idempotent.
    const pages = validatePages(validatePages(input.pages, entry).map(page => ({ ...page, html: stampElements(page.html) })), entry);
    const next = { pages }, nextNotes = validateNotes(input.notes), previousNotes = validateNotes(previousAnnotations.notes);
    const isFlowNote = note => ["flow-node", "flow-edge"].includes(note.target.type);
    if (!same(previousNotes.filter(isFlowNote), nextNotes.filter(isFlowNote))) {
      fail("设计批量编辑只能修改页面元素说明；流程节点和连线说明必须原样保留", 400);
    }
    const links = flowLinks((await database.read("flow", entryPath, c)).workspace);
    validateDesignReferences(previous, next, previousNotes, nextNotes, links);
    const changed = { design: !same(validatePages(previous.pages, entry), pages), annotations: !same(previousNotes, nextNotes) };
    const options = { dryRun: input.dryRun === true, designWorkspace: next };
    const workspace = changed.design
      ? await database.saveInTransaction(c, "design", entryPath, previous.revision, pages, undefined, options) : previous;
    const annotations = changed.annotations
      ? await database.saveInTransaction(c, "annotations", entryPath, previousAnnotations.revision, nextNotes, undefined, options) : previousAnnotations;
    return { workspace, annotations, changed, ...(input.dryRun ? { dryRun: true } : {}) };
  });
}

// A design plus its annotations may exceed the single-design endpoint's 4 MB.
// Keep the existing authentication/origin contract and this larger limit local.
async function readBatchBody(request, accessMode) {
  if (!canEdit(request, accessMode)) fail("仅本机 localhost 可编辑，当前连接为只读", 403);
  if (request.headers.origin !== `http://${request.headers.host}`) fail("不允许跨站写入", 403);
  if (request.headers["x-design-client"] !== "workbench-v1") fail("缺少工作台请求标识", 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) fail("请使用 JSON 请求", 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 6 * 1024 * 1024) fail("请求最多 6 MB", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("JSON 格式不正确", 400); }
}

function createDesignBatchHandler(database, sendJson, { accessMode = "local" } = {}) {
  return async (request, response, url) => {
    try {
      const entryPath = url.searchParams.get("path");
      if (request.method === "GET" && url.pathname === "/api/design/bundle") {
        sendJson(response, 200, { ...await readDesignBundle(database, entryPath), canEdit: canEdit(request, accessMode), accessMode });
      } else if (request.method === "POST" && url.pathname === "/api/design/batch") {
        sendJson(response, 200, await saveDesignBatch(database, entryPath, await readBatchBody(request, accessMode)));
      } else sendJson(response, 405, { error: "不支持的设计批量接口或请求方法" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "设计批量操作失败，本批修改未保存", ...(error.details ? { details: error.details } : {}) });
    }
  };
}

module.exports = { readDesignBundle, saveDesignBatch, createDesignBatchHandler, validateDesignReferences };
