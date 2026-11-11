"use strict";

const { isDeepStrictEqual: same } = require("node:util");
const path = require("node:path");
const { validateContent, moduleProblems, recoveryProblems } = require("./flow-store");
const { validateNotes } = require("./annotation-store");

const FORMAT = "workbench-flow-edit/v1";
const FIELDS = {
  workspace: ["applicability", "reason", "references", "flows", "schemaVersion", "revision", "updatedAt"],
  annotations: ["notes", "schemaVersion", "revision", "updatedAt"],
  flow: ["id", "name", "description", "direction", "kind", "parent", "nodes", "edges", "lanes"],
  node: ["id", "type", "label", "x", "y", "pageId", "supplement", "variant", "issues", "target", "source", "gatewayMode", "eventType", "eventPhase", "endScope", "call", "recovery", "contract"],
  edge: ["id", "source", "target", "label", "trace"],
  lane: ["id", "label", "x", "y", "width", "height"],
  note: ["id", "target", "text", "requirements", "createdAt", "updatedAt"],
  relation: ["entryPath", "flowId", "nodeId"],
};
const METADATA = new Set(["schemaVersion", "revision", "createdAt", "updatedAt"]);
const clone = value => structuredClone(value);
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);

class ModelError extends Error {
  constructor(message, details = []) { super(message); this.name = "ModelError"; this.status = 400; this.details = details; }
}
function requireThat(test, message) { if (!test) throw new ModelError(message); }
function fields(value, allowed, location) {
  requireThat(plain(value), `${location} 必须是对象`);
  for (const field of Object.keys(value)) requireThat(allowed.includes(field), `${location} 不支持字段 ${field}`);
}
function validPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 999 && !value.includes("\\") && !/[\x00-\x1f]/.test(value)
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value.split("/").every(part => part && part !== "." && part !== "..");
}
function validateShape(workspace, annotations, location) {
  fields(workspace, FIELDS.workspace, `${location}.workspace`);
  fields(annotations, FIELDS.annotations, `${location}.annotations`);
  for (const [name, data] of [["workspace", workspace], ["annotations", annotations]]) {
    requireThat(data.schemaVersion === 1, `${location}.${name}.schemaVersion 必须为 1`);
    requireThat(Number.isInteger(data.revision) && data.revision >= 0, `${location}.${name}.revision 无效`);
  }
  for (const flow of workspace.flows || []) {
    fields(flow, FIELDS.flow, `${location}.flow`);
    if (flow.parent) fields(flow.parent, FIELDS.relation, `${location}.${flow.id}.parent`);
    for (const kind of ["node", "edge", "lane"]) for (const item of flow[`${kind}s`] || []) {
      fields(item, FIELDS[kind], `${location}.${flow.id}.${kind}`);
      if (kind === "node") {
        if (item.call) {
          fields(item.call, ["entryPath", "flowId", "nodeId", "returns"], `${location}.${flow.id}.${item.id}.call`);
          for (const mapping of item.call.returns || []) fields(mapping, ["outputNodeId", "targetNodeId"], `${location}.${flow.id}.${item.id}.call.returns`);
        }
        for (const relation of ["source", "target", "recovery"]) if (item[relation]) fields(item[relation], FIELDS.relation, `${location}.${flow.id}.${item.id}.${relation}`);
        for (const [field, types] of [["target", ["output"]], ["source", ["input", "event"]], ["gatewayMode", ["gateway"]], ["eventType", ["event"]], ["eventPhase", ["event"]], ["endScope", ["end"]], ["call", ["call"]]]) {
          requireThat(item[field] == null || types.includes(item.type), `${location}.${flow.id}.${item.id}.${field} 不适用于 ${item.type}，请显式 unset`);
        }
      }
    }
  }
  for (const ref of workspace.references || []) fields(ref, FIELDS.relation.filter(field => field !== "nodeId"), `${location}.references`);
  for (const note of annotations.notes || []) {
    fields(note, FIELDS.note, `${location}.note`);
    if (plain(note.target)) {
      const allowed = note.target.type === "flow-node" ? ["type", "flowId", "nodeId"] : note.target.type === "flow-edge" ? ["type", "flowId", "edgeId"] : ["type", "pageId", "route", "anchor"];
      fields(note.target, allowed, `${location}.${note.id}.target`);
      if (note.target.anchor) fields(note.target.anchor, ["selector", "tag", "label", "htmlHash", "contextHash", "strength", "elementId"], `${location}.${note.id}.anchor`);
    }
    for (const ref of note.requirements || []) fields(ref, ["file", "blockId", "quote", "heading"], `${location}.${note.id}.requirements`);
  }
}
function normalizeBundle(bundle) {
  fields(bundle, ["format", "origin", "entryPath", "base", "draft"], "bundle");
  requireThat(bundle.format === FORMAT, `只支持 ${FORMAT}`);
  requireThat(validPath(bundle.entryPath), "bundle.entryPath 必须是有效需求逻辑路径");
  let origin;
  try { origin = new URL(bundle.origin); } catch { throw new ModelError("bundle.origin 无效"); }
  requireThat(["http:", "https:"].includes(origin.protocol) && origin.origin === bundle.origin, "bundle.origin 必须是无路径和凭据的 HTTP(S) origin");
  const normalized = {};
  for (const part of ["base", "draft"]) {
    fields(bundle[part], ["workspace", "annotations"], part);
    const { workspace, annotations } = bundle[part];
    validateShape(workspace, annotations, part);
    normalized[part] = { workspace: validateContent(workspace, bundle.entryPath), annotations: { notes: validateNotes(annotations.notes) } };
  }
  for (const resource of ["workspace", "annotations"]) for (const field of ["schemaVersion", "revision", "updatedAt"]) {
    requireThat(same(bundle.base[resource][field], bundle.draft[resource][field]), `draft.${resource}.${field} 不可修改；请重新 pull 获取版本`);
  }
  return normalized;
}

function createBundle(origin, entryPath, workspace, annotations) {
  const base = clone({ workspace, annotations });
  const bundle = { format: FORMAT, origin, entryPath, base, draft: clone(base) };
  normalizeBundle(bundle);
  return bundle;
}

function relationProblems(workspace, annotations, entryPath) {
  const problems = [], flows = new Map(workspace.flows.map(flow => [flow.id, flow]));
  const add = (code, location, ref, message, external = false) => problems.push({ code, location, ref, message, external });
  function relation(ref, location, nodeRequired) {
    if (!ref) return;
    if (ref.entryPath !== entryPath) { add("EXTERNAL_REFERENCE", location, ref, "外部流程引用由服务端核验", true); return; }
    const target = flows.get(ref.flowId);
    if (!target || ((nodeRequired || ref.nodeId) && !target.nodes.some(node => node.id === ref.nodeId))) add("DANGLING_REFERENCE", location, ref, "所引用的本需求流程或节点不存在");
  }
  for (const flow of workspace.flows) {
    relation(flow.parent, `flow:${flow.id}.parent`, false);
    for (const node of flow.nodes) {
      if (node.type === "output") relation(node.target, `flow:${flow.id}.node:${node.id}.target`, true);
      if (["input", "event"].includes(node.type)) relation(node.source, `flow:${flow.id}.node:${node.id}.source`, true);
    }
    const route = [], seen = new Set(); let current = flow;
    while (current && !seen.has(current.id)) {
      seen.add(current.id); route.push(current.id);
      current = current.parent?.entryPath === entryPath ? flows.get(current.parent.flowId) : null;
    }
    if (current) add("PARENT_CYCLE", `flow:${flow.id}.parent`, route.slice(route.indexOf(current.id)).sort(), "本需求内父子补充关系形成循环");
  }
  for (const note of annotations.notes) {
    const target = note.target;
    if (!["flow-node", "flow-edge"].includes(target.type)) continue;
    const flow = flows.get(target.flowId), items = target.type === "flow-node" ? flow?.nodes : flow?.edges;
    if (!items?.some(item => item.id === (target.nodeId || target.edgeId))) add("ORPHAN_NOTE", `note:${note.id}.target`, target, "元素说明的流程目标不存在；请同时改挂或显式移除说明");
  }
  for (const ref of workspace.references) relation(ref, `reference:${ref.entryPath}/${ref.flowId}`, false);
  for (const problem of moduleProblems([{ entryPath, workspace }], { deferExternal: true })) {
    add(problem.code, `flow:${problem.flowId}.node:${problem.nodeId}.call`, problem.ref, problem.message, problem.external);
  }
  for (const problem of recoveryProblems([{ entryPath, workspace }], { deferExternal: true })) {
    add(problem.code, `flow:${problem.flowId}.node:${problem.nodeId}.recovery`, problem.ref, problem.message, problem.external);
  }
  return problems;
}
function problemKey(problem) { return JSON.stringify([problem.code, problem.location, problem.ref]); }
function advisoryWarnings(workspace) {
  const warnings = [], warn = (code, message, location) => warnings.push({ code, message, location });
  // Same node bounds as the native canvas; overlap is only a review hint.
  const size = node => ["event", "gateway"].includes(node.type) ? [200, 86] : node.type === "decision" ? [180, 104] : node.type === "end" ? [180, 72] : node.type === "start" ? [144, 48] : [200, 68];
  for (const flow of workspace.flows) {
    for (const node of flow.nodes) {
      const outgoing = flow.edges.filter(edge => edge.source === node.id), location = `flow:${flow.id}.node:${node.id}`;
      if (node.type === "end" && (!node.endScope || node.endScope === "unspecified")) warn("END_SCOPE", "结束范围待明确", location);
      if (node.type === "end" && outgoing.length) warn("END_OUTGOING", "结束节点仍有出线，请核实是否应使用输出或独立恢复入口", location);
      if (node.type === "decision" && outgoing.length < 2) warn("DECISION_BRANCHES", "判断节点少于两个出口", location);
      if (node.type === "decision" && outgoing.some(edge => !edge.label.trim())) warn("DECISION_LABELS", "判断分支存在未标注条件的连线", location);
      if (node.type === "step" && outgoing.length > 1) warn("STEP_BRANCHES", "普通步骤有多个出口，请核实条件择一或并行语义", location);
      if (node.type === "input" && !node.source && flow.kind !== "module") warn("INPUT_SOURCE", "跨图入口尚未关联来源", location);
      if (node.type === "output" && !node.target) warn("OUTPUT_TARGET", "跨图出口尚未关联承接节点", location);
      if (node.type === "call" && !node.call) warn("CALL_TARGET", "模块调用尚未配置目标及返回映射", location);
      if (node.type === "gateway" && (!node.gatewayMode || node.gatewayMode === "unspecified")) warn("GATEWAY_MODE", "分流或汇合模式待明确", location);
    }
    for (let i = 0; i < flow.nodes.length; i++) for (let j = i + 1; j < flow.nodes.length; j++) {
      const a = flow.nodes[i], b = flow.nodes[j], [aw, ah] = size(a), [bw, bh] = size(b);
      if (a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y) warn("NODE_OVERLAP", `节点 ${a.id} 与 ${b.id} 的画布范围重叠`, `flow:${flow.id}`);
    }
  }
  return warnings;
}
function checkBundle(bundle) {
  const errors = [], warnings = []; let normalized;
  try { normalized = normalizeBundle(bundle); }
  catch (error) { return { errors: [{ code: "INVALID_CONTENT", message: error.message, location: "bundle" }], warnings }; }
  const oldNotes = new Map(bundle.base.annotations.notes.map(note => [note.id, note]));
  const newNotes = new Map(bundle.draft.annotations.notes.map(note => [note.id, note]));
  for (const id of new Set([...oldNotes.keys(), ...newNotes.keys()])) {
    const before = oldNotes.get(id), after = newNotes.get(id);
    if ((before?.target.type === "page-element" || after?.target.type === "page-element") && !same(before, after)) {
      errors.push({ code: "PAGE_NOTE_READONLY", message: "流程编辑仅支持流程说明，页面元素说明必须原样保留", location: `note:${id}` });
    }
  }
  const prior = new Set(relationProblems(normalized.base.workspace, normalized.base.annotations, bundle.entryPath).map(problemKey));
  for (const problem of relationProblems(normalized.draft.workspace, normalized.draft.annotations, bundle.entryPath)) {
    const { code, message, location } = problem, existing = prior.has(problemKey(problem));
    const item = { code, message: existing && !problem.external ? `${message}（基线已存在）` : message, location };
    (existing || problem.external ? warnings : errors).push(item);
  }
  warnings.push(...advisoryWarnings(normalized.draft.workspace));
  return { errors, warnings };
}
function payloadForApply(bundle) {
  const checked = checkBundle(bundle);
  if (checked.errors.length) throw new ModelError("流程草稿校验失败", checked.errors);
  const { draft } = normalizeBundle(bundle);
  return { expectedRevision: bundle.base.workspace.revision, expectedAnnotationsRevision: bundle.base.annotations.revision, workspace: draft.workspace, notes: draft.annotations.notes };
}

function applyOperations(bundle, operations) {
  normalizeBundle(bundle);
  requireThat(Array.isArray(operations), "ops 必须是操作数组");
  const next = clone(bundle);
  for (const operation of operations) {
    fields(operation, ["op", "flowId", "id", "value", "set", "unset"], "operation");
    requireThat(typeof operation.op === "string", "缺少操作名称 op");
    const [kind, action, extra] = operation.op.split(".");
    requireThat(!extra && ["workspace", "flow", "node", "edge", "lane", "note"].includes(kind) && ["add", "update", "remove"].includes(action), `不支持操作 ${operation.op}`);
    if (kind === "workspace") {
      requireThat(action === "update" && operation.id === undefined && operation.flowId === undefined && operation.value === undefined, "workspace 只支持 update");
      update(next.draft.workspace, operation, ["applicability", "reason", "references"]);
      continue;
    }
    let list;
    if (kind === "flow") list = next.draft.workspace.flows;
    else if (kind === "note") list = next.draft.annotations.notes;
    else {
      const flow = next.draft.workspace.flows.find(item => item.id === operation.flowId);
      requireThat(flow, `流程不存在：${operation.flowId}`);
      list = flow[`${kind}s`] ||= [];
    }
    if (["flow", "note"].includes(kind)) requireThat(operation.flowId === undefined, `${kind} 操作不接受 flowId`);
    requireThat(typeof operation.id === "string" && operation.id, `${operation.op} 缺少 id`);
    const index = list.findIndex(item => item.id === operation.id);
    if (kind === "note") {
      requireThat(index < 0 || list[index].target?.type !== "page-element", "流程编辑不能修改或删除页面元素说明");
      const target = action === "add" ? operation.value?.target : operation.set?.target;
      requireThat((action !== "add" && target === undefined) || ["flow-node", "flow-edge"].includes(target?.type), "流程说明目标只能是 flow-node 或 flow-edge");
    }
    if (action === "add") {
      requireThat(index < 0, `${kind} ID 已存在：${operation.id}`);
      requireThat(operation.set === undefined && operation.unset === undefined, "add 使用 value，不接受 set/unset");
      fields(operation.value, FIELDS[kind].filter(field => !METADATA.has(field)), `${kind}.value`);
      requireThat(operation.value.id === undefined || operation.value.id === operation.id, "value.id 与操作 id 不一致");
      list.push({ ...clone(operation.value), id: operation.id });
    } else {
      requireThat(index >= 0, `${kind} ID 不存在：${operation.id}`);
      requireThat(operation.value === undefined, `${action} 不接受 value`);
      if (action === "remove") {
        requireThat(operation.set === undefined && operation.unset === undefined, "remove 不接受 set/unset");
        list.splice(index, 1);
      } else update(list[index], operation, FIELDS[kind].filter(field => field !== "id" && !METADATA.has(field)));
    }
  }
  payloadForApply(next);
  return next;
}
function update(target, operation, allowed) {
  fields(operation.set ?? {}, allowed, `${operation.op}.set`);
  requireThat(operation.unset === undefined || (Array.isArray(operation.unset) && operation.unset.every(field => allowed.includes(field))), `${operation.op}.unset 包含不可修改字段`);
  requireThat(!operation.unset?.some(field => Object.hasOwn(operation.set || {}, field)), "同一字段不能同时 set 和 unset");
  Object.assign(target, clone(operation.set || {}));
  for (const field of operation.unset || []) delete target[field];
}

function diffBundle(bundle) {
  const { base, draft } = normalizeBundle(bundle), changes = [];
  function values(resource, id, before, after, flowId, skip = []) {
    if (before === undefined || after === undefined) {
      changes.push({ resource, id, ...(flowId ? { flowId } : {}), field: "*", before: before ?? null, after: after ?? null });
      return;
    }
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) if (!skip.includes(field) && !METADATA.has(field) && !same(before[field], after[field])) {
      changes.push({ resource, id, ...(flowId ? { flowId } : {}), field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }
  function rows(resource, oldRows, newRows, flowId, skip = []) {
    const oldMap = new Map(oldRows.map(item => [item.id, item])), newMap = new Map(newRows.map(item => [item.id, item]));
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) values(resource, id, oldMap.get(id), newMap.get(id), flowId, skip);
    if (!same(oldRows.map(item => item.id), newRows.map(item => item.id))) changes.push({ resource, ...(flowId ? { flowId } : {}), field: "$order", before: oldRows.map(item => item.id), after: newRows.map(item => item.id) });
  }
  values("workspace", bundle.entryPath, base.workspace, draft.workspace, undefined, ["flows"]);
  rows("flow", base.workspace.flows, draft.workspace.flows, undefined, ["nodes", "edges", "lanes"]);
  for (const flow of draft.workspace.flows) {
    const prior = base.workspace.flows.find(item => item.id === flow.id);
    if (!prior) continue;
    for (const kind of ["node", "edge", "lane"]) rows(kind, prior[`${kind}s`] || [], flow[`${kind}s`] || [], flow.id);
  }
  rows("note", base.annotations.notes, draft.annotations.notes);
  const summary = (oldRows, newRows) => ({
    added: newRows.filter(item => !oldRows.some(old => old.id === item.id)).map(item => item.id),
    removed: oldRows.filter(item => !newRows.some(next => next.id === item.id)).map(item => item.id),
    updated: newRows.filter(item => { const old = oldRows.find(old => old.id === item.id); return old && !same(old, item); }).map(item => item.id),
  });
  return { changed: { flows: !same(base.workspace, draft.workspace), annotations: !same(base.annotations.notes, draft.annotations.notes) }, summary: { flows: summary(base.workspace.flows, draft.workspace.flows), notes: summary(base.annotations.notes, draft.annotations.notes) }, changes };
}

module.exports = { FORMAT, ModelError, createBundle, applyOperations, checkBundle, diffBundle, payloadForApply };
