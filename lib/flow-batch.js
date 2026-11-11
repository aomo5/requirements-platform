"use strict";

const { isDeepStrictEqual: same } = require("node:util");
const { validateContent, moduleProblems, moduleProblemKey, recoveryProblems } = require("./flow-store");
const { validateNotes } = require("./annotation-store");
const { canEdit, readBody } = require("./design-store");

const fail = (message, status = 409, details) => { throw Object.assign(new Error(message), { status, ...(details ? { details } : {}) }); };
const flowKey = (entryPath, flowId) => JSON.stringify([entryPath, flowId]);

function brokenReferences(entries) {
  const graph = new Map();
  for (const { entryPath, workspace } of entries) for (const flow of workspace.flows) graph.set(flowKey(entryPath, flow.id), flow);
  const broken = new Map();
  function check(owner, field, reference, nodeRequired) {
    if (!reference) return; // Unbound draft nodes remain supported.
    const target = graph.get(flowKey(reference.entryPath, reference.flowId));
    if (target && (!nodeRequired || (reference.nodeId && target.nodes.some(n => n.id === reference.nodeId)))) return;
    const detail = { ...owner, field, target: reference };
    broken.set(JSON.stringify([owner.entryPath, owner.flowId || "", owner.nodeId || "", field,
      reference.entryPath, reference.flowId, reference.nodeId || ""]), detail);
  }
  for (const { entryPath, workspace } of entries) {
    for (const reference of workspace.references || []) check({ entryPath }, "reference", reference, false);
    for (const flow of workspace.flows) {
      check({ entryPath, flowId: flow.id }, "parent", flow.parent, Boolean(flow.parent?.nodeId));
      for (const node of flow.nodes) {
        const owner = { entryPath, flowId: flow.id, nodeId: node.id };
        if (node.type === "output") check(owner, "target", node.target, true);
        if (node.type === "input" || node.type === "event") check(owner, "source", node.source, true);
      }
    }
  }
  for (const problem of [...moduleProblems(entries), ...recoveryProblems(entries)]) broken.set(moduleProblemKey(problem), problem);
  return broken;
}

function brokenNotes(workspace, notes) {
  const broken = new Map();
  for (const note of notes) {
    const target = note.target;
    if (!["flow-node", "flow-edge"].includes(target.type)) continue;
    const flow = workspace.flows.find(f => f.id === target.flowId);
    const found = flow && (target.type === "flow-node" ? flow.nodes.some(n => n.id === target.nodeId) : flow.edges.some(e => e.id === target.edgeId));
    if (!found) broken.set(JSON.stringify([note.id, target.type, target.flowId, target.nodeId || target.edgeId]), { noteId: note.id, target });
  }
  return broken;
}

function validateBundleReferences(entryPath, previous, next, previousNotes, nextNotes, externalEntries) {
  const others = externalEntries.filter(e => e.entryPath !== entryPath);
  const before = brokenReferences([...others, { entryPath, workspace: previous }]);
  const after = brokenReferences([...others, { entryPath, workspace: next }]);
  const introduced = [...after].filter(([key]) => !before.has(key)).map(([, value]) => value);
  if (introduced.length) fail("本次修改会产生失效的流程承接或引用，请先修复相关节点", 409, introduced);
  const oldOrphans = brokenNotes(previous, previousNotes);
  const newOrphans = [...brokenNotes(next, nextNotes)].filter(([key]) => !oldOrphans.has(key)).map(([, value]) => value);
  if (newOrphans.length) fail("本次修改会留下失效的流程说明，请在同批修改中删除或迁移说明", 409, newOrphans);
}

async function readFlowBundle(database, entryPath) {
  if (!database) fail("流程批量编辑需要 MySQL 存储，文件模式不支持", 501);
  return database.transaction(async c => ({
    workspace: (await database.read("flow", entryPath, c)).workspace,
    annotations: (await database.read("annotations", entryPath, c)).workspace,
  }));
}

async function saveFlowBatch(database, entryPath, input) {
  if (!database) fail("流程批量编辑需要 MySQL 存储，文件模式不支持", 501);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("请求内容必须是 JSON 对象", 400);
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") fail("dryRun 必须为布尔值", 400);
  for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
    if (!Number.isInteger(input[key]) || input[key] < 0) fail("缺少有效版本号：" + key, 400);
  }
  return database.transaction(async c => {
    const previous = (await database.read("flow", entryPath, c)).workspace;
    const previousAnnotations = (await database.read("annotations", entryPath, c)).workspace;
    if (previous.revision !== input.expectedRevision || previousAnnotations.revision !== input.expectedAnnotationsRevision) {
      fail("流程或元素说明已在另一窗口更新，请重新读取并合并；本批修改未保存", 409,
        { revision: previous.revision, annotationsRevision: previousAnnotations.revision });
    }
    const next = validateContent(input.workspace, entryPath);
    const nextNotes = validateNotes(input.notes);
    const previousNotes = validateNotes(previousAnnotations.notes);
    if (!same(previousNotes.filter(n => n.target.type === "page-element"), nextNotes.filter(n => n.target.type === "page-element"))) {
      fail("流程批量编辑只能修改流程节点或连线说明；页面元素说明必须原样保留", 400);
    }
    const [rows] = await c.query("SELECT e.path,w.payload FROM wb_workspaces w JOIN wb_entries e ON e.id=w.entry_id WHERE w.kind='flow'");
    validateBundleReferences(entryPath, previous, next, previousAnnotations.notes, nextNotes,
      rows.map(row => ({ entryPath: row.path, workspace: row.payload })));
    const changed = {
      flows: !same(validateContent(previous, entryPath), next),
      annotations: !same(previousNotes, nextNotes),
    };
    // Save the graph first inside the same transaction, so annotation validation
    // sees newly added nodes. A later validation or write failure rolls both back.
    const options = { dryRun: input.dryRun === true, flowWorkspace: next };
    const workspace = changed.flows
      ? await database.saveInTransaction(c, "flow", entryPath, previous.revision, next, undefined, options) : previous;
    const annotations = changed.annotations
      ? await database.saveInTransaction(c, "annotations", entryPath, previousAnnotations.revision, nextNotes, undefined, options) : previousAnnotations;
    return { workspace, annotations, changed, ...(input.dryRun ? { dryRun: true } : {}) };
  });
}

function createFlowBatchHandler(database, sendJson, { accessMode = "local" } = {}) {
  return async (request, response, url) => {
    try {
      const entryPath = url.searchParams.get("path");
      if (request.method === "GET" && url.pathname === "/api/flows/bundle") {
        sendJson(response, 200, { ...await readFlowBundle(database, entryPath), canEdit: canEdit(request, accessMode), accessMode });
      } else if (request.method === "POST" && url.pathname === "/api/flows/batch") {
        const body = await readBody(request, accessMode);
        sendJson(response, 200, await saveFlowBatch(database, entryPath, body));
      } else sendJson(response, 405, { error: "不支持的流程批量接口或请求方法" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "流程批量操作失败，本批修改未保存", ...(error.details ? { details: error.details } : {}) });
    }
  };
}

module.exports = { readFlowBundle, saveFlowBatch, createFlowBatchHandler, validateBundleReferences };
