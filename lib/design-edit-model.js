"use strict";

const { isDeepStrictEqual: same } = require("node:util");
const path = require("node:path");
const { validatePages } = require("./design-store");
const { validateNotes } = require("./annotation-store");
const { stampElements, resolveElement, sha } = require("./stable-identities");
const { listElements, identityProblems, editText, editStyle, htmlFingerprint, createPageNote } = require("./design-element-edit");

const FORMAT = "workbench-design-edit/v1";
const FIELDS = {
  workspace: ["schemaVersion", "revision", "updatedAt", "pages"],
  annotations: ["schemaVersion", "revision", "updatedAt", "notes"],
  page: ["id", "name", "width", "height", "x", "y", "html", "source", "route", "platform", "group", "changeSummary"],
  note: ["id", "target", "text", "requirements", "createdAt", "updatedAt"],
};
const METADATA = new Set(["schemaVersion", "revision", "createdAt", "updatedAt"]);
const clone = value => structuredClone(value);
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
class ModelError extends Error { constructor(message, details = []) { super(message); this.name = "ModelError"; this.status = 400; this.details = details; } }
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
  requireThat(Array.isArray(workspace.pages), `${location}.workspace.pages 必须是数组`);
  requireThat(Array.isArray(annotations.notes), `${location}.annotations.notes 必须是数组`);
  for (const page of workspace.pages) fields(page, FIELDS.page, `${location}.page`);
  for (const note of annotations.notes) {
    fields(note, FIELDS.note, `${location}.note`);
    if (plain(note.target)) {
      const allowed = note.target.type === "flow-node" ? ["type", "flowId", "nodeId"] : note.target.type === "flow-edge" ? ["type", "flowId", "edgeId"] : ["type", "pageId", "route", "anchor"];
      fields(note.target, allowed, `${location}.${note.id}.target`);
      if (note.target.anchor) fields(note.target.anchor, ["elementId", "selector", "tag", "label", "htmlHash", "contextHash", "strength"], `${location}.${note.id}.anchor`);
    }
    for (const ref of note.requirements || []) fields(ref, ["file", "blockId", "quote", "heading"], `${location}.${note.id}.requirements`);
  }
}
function normalizeBundle(bundle) {
  fields(bundle, ["format", "origin", "entryPath", "base", "draft", "context"], "bundle");
  requireThat(bundle.format === FORMAT, `只支持 ${FORMAT}`);
  requireThat(validPath(bundle.entryPath), "bundle.entryPath 必须是有效需求逻辑路径");
  let origin;
  try { origin = new URL(bundle.origin); } catch { throw new ModelError("bundle.origin 无效"); }
  requireThat(["http:", "https:"].includes(origin.protocol) && origin.origin === bundle.origin, "bundle.origin 必须是无路径和凭据的 HTTP(S) origin");
  fields(bundle.context, ["flowLinks"], "context");
  requireThat(Array.isArray(bundle.context.flowLinks), "context.flowLinks 必须是数组");
  for (const link of bundle.context.flowLinks) {
    fields(link, ["flowId", "nodeId", "pageId"], "context.flowLinks");
    for (const field of ["flowId", "nodeId", "pageId"]) requireThat(typeof link[field] === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(link[field]), `context.flowLinks.${field} 无效`);
  }
  const normalized = {};
  for (const part of ["base", "draft"]) {
    fields(bundle[part], ["workspace", "annotations"], part);
    const { workspace, annotations } = bundle[part];
    validateShape(workspace, annotations, part);
    normalized[part] = { workspace: { pages: validatePages(workspace.pages, { path: bundle.entryPath }) }, annotations: { notes: validateNotes(annotations.notes) } };
  }
  for (const resource of ["workspace", "annotations"]) for (const field of ["schemaVersion", "revision", "updatedAt"]) {
    requireThat(same(bundle.base[resource][field], bundle.draft[resource][field]), `draft.${resource}.${field} 不可修改；请重新 pull 获取版本`);
  }
  const oldNotes = new Map(bundle.base.annotations.notes.map(note => [note.id, note]));
  for (const note of bundle.draft.annotations.notes) for (const field of ["createdAt", "updatedAt"]) {
    requireThat(same(oldNotes.get(note.id)?.[field], note[field]), `note:${note.id}.${field} 不可修改；时间由服务端维护`);
  }
  return normalized;
}

function createBundle(origin, entryPath, workspace, annotations, context = { flowLinks: [] }) {
  const base = clone({ workspace, annotations });
  const bundle = { format: FORMAT, origin, entryPath, base, draft: clone(base), context: clone(context) };
  normalizeBundle(bundle);
  return bundle;
}
function relationProblems(workspace, annotations, context) {
  const problems = [], pages = new Map(workspace.pages.map(page => [page.id, page]));
  const add = (code, location, ref, message) => problems.push({ code, location, ref, message });
  for (const page of workspace.pages) for (const issue of identityProblems(page.html)) {
    add(issue.code, `page:${page.id}.html`, issue, "页面元素缺少有效且唯一的固定 ID；请通过 page.update 的 html 补齐后再提交");
  }
  for (const link of context.flowLinks) if (!pages.has(link.pageId)) add("FLOW_PAGE_REFERENCE", `flow:${link.flowId}.node:${link.nodeId}`, link, "页面仍被流程节点引用；请先解除或改挂流程关联");
  for (const note of annotations.notes) {
    const target = note.target;
    if (target.type !== "page-element") continue;
    const page = pages.get(target.pageId), anchor = target.anchor;
    let matched = page && resolveElement(page.html, anchor.selector);
    if (matched && (matched.tag !== anchor.tag || (anchor.elementId && matched.id !== anchor.elementId))) matched = null;
    if (matched && anchor.strength === "path" && anchor.htmlHash !== htmlFingerprint(page.html)) matched = null;
    if (!matched) add("ORPHAN_NOTE", `note:${note.id}.target`, target, "页面元素说明的目标不存在或已变化；请同批改挂或显式移除说明");
  }
  return problems;
}
const problemKey = problem => JSON.stringify([problem.code, problem.location, problem.ref]);
function checkBundle(bundle) {
  const errors = [], warnings = []; let normalized;
  try { normalized = normalizeBundle(bundle); }
  catch (error) { return { errors: [{ code: "INVALID_CONTENT", message: error.message, location: "bundle" }], warnings }; }
  const oldNotes = new Map(bundle.base.annotations.notes.map(note => [note.id, note])), newNotes = new Map(bundle.draft.annotations.notes.map(note => [note.id, note]));
  for (const id of new Set([...oldNotes.keys(), ...newNotes.keys()])) {
    const before = oldNotes.get(id), after = newNotes.get(id);
    if ((before?.target.type !== "page-element" && before || after?.target.type !== "page-element" && after) && !same(before, after)) {
      errors.push({ code: "FLOW_NOTE_READONLY", message: "设计编辑仅支持页面元素说明，流程说明必须原样保留", location: `note:${id}` });
    }
  }
  const prior = new Set(relationProblems(normalized.base.workspace, normalized.base.annotations, bundle.context).map(problemKey));
  for (const problem of relationProblems(normalized.draft.workspace, normalized.draft.annotations, bundle.context)) {
    const existing = prior.has(problemKey(problem));
    const item = { code: problem.code, location: problem.location, message: `${problem.message}${existing ? "（基线已存在）" : ""}` };
    (existing ? warnings : errors).push(item);
  }
  return { errors, warnings };
}
function payloadForApply(bundle) {
  const checked = checkBundle(bundle);
  if (checked.errors.length) throw new ModelError("设计草稿校验失败", checked.errors);
  const { draft } = normalizeBundle(bundle);
  return { expectedRevision: bundle.base.workspace.revision, expectedAnnotationsRevision: bundle.base.annotations.revision, pages: draft.workspace.pages, notes: draft.annotations.notes };
}
function update(target, operation, allowed) {
  fields(operation.set ?? {}, allowed, `${operation.op}.set`);
  requireThat(operation.unset === undefined || (Array.isArray(operation.unset) && operation.unset.every(field => allowed.includes(field))), `${operation.op}.unset 包含不可修改字段`);
  requireThat(!operation.unset?.some(field => Object.hasOwn(operation.set || {}, field)), "同一字段不能同时 set 和 unset");
  Object.assign(target, clone(operation.set || {}));
  for (const field of operation.unset || []) delete target[field];
}
function applyOperations(bundle, operations) {
  normalizeBundle(bundle);
  requireThat(Array.isArray(operations), "ops 必须是操作数组");
  const next = clone(bundle);
  for (const operation of operations) {
    requireThat(plain(operation) && typeof operation.op === "string", "缺少操作名称 op");
    if (["element.text", "element.style"].includes(operation.op)) {
      fields(operation, operation.op === "element.text" ? ["op", "pageId", "id", "index", "expected", "value"] : ["op", "pageId", "id", "property", "value"], "operation");
      const page = next.draft.workspace.pages.find(page => page.id === operation.pageId);
      requireThat(page, `页面不存在：${operation.pageId}`);
      page.html = operation.op === "element.text" ? editText(page.html, operation.id, operation.index, operation.expected, operation.value) : editStyle(page.html, operation.id, operation.property, operation.value);
      continue;
    }
    fields(operation, ["op", "id", "value", "set", "unset"], "operation");
    const [kind, action, extra] = operation.op.split(".");
    requireThat(!extra && ["page", "note"].includes(kind) && ["add", "update", "remove"].includes(action), `不支持操作 ${operation.op}`);
    requireThat(typeof operation.id === "string" && operation.id, `${operation.op} 缺少 id`);
    const list = kind === "page" ? next.draft.workspace.pages : next.draft.annotations.notes;
    const index = list.findIndex(item => item.id === operation.id);
    if (kind === "note") {
      requireThat(index < 0 || list[index].target?.type === "page-element", "设计编辑不能修改或删除流程说明");
      const target = action === "add" ? operation.value?.target : operation.set?.target;
      requireThat((action !== "add" && target === undefined) || target?.type === "page-element", "设计说明目标只能是 page-element");
    }
    if (action === "add") {
      requireThat(index < 0, `${kind} ID 已存在：${operation.id}`);
      requireThat(operation.set === undefined && operation.unset === undefined, "add 使用 value，不接受 set/unset");
      fields(operation.value, FIELDS[kind].filter(field => !METADATA.has(field)), `${kind}.value`);
      requireThat(operation.value.id === undefined || operation.value.id === operation.id, "value.id 与操作 id 不一致");
      const value = { ...clone(operation.value), id: operation.id };
      if (kind === "page" && typeof value.html === "string") value.html = stampElements(value.html);
      list.push(value);
    } else {
      requireThat(index >= 0, `${kind} ID 不存在：${operation.id}`);
      requireThat(operation.value === undefined, `${action} 不接受 value`);
      if (action === "remove") {
        requireThat(operation.set === undefined && operation.unset === undefined, "remove 不接受 set/unset");
        list.splice(index, 1);
      } else {
        update(list[index], operation, FIELDS[kind].filter(field => field !== "id" && !METADATA.has(field)));
        if (kind === "page" && Object.hasOwn(operation.set || {}, "html") && typeof list[index].html === "string") list[index].html = stampElements(list[index].html);
      }
    }
  }
  payloadForApply(next);
  return next;
}
const htmlSummary = html => ({ length: html.length, sha256: sha(html) });
function pageSummary(page) { return page ? { ...page, html: htmlSummary(page.html) } : null; }
function elementSummary(element) {
  if (!element) return null;
  const texts = element.texts.slice(0, 20).map(slot => slot.text.length <= 240 ? slot : { ...slot, text: `${slot.text.slice(0, 240)}…`, length: slot.text.length, sha256: sha(slot.text) });
  return { id: element.id, tag: element.tag, texts, ...(element.texts.length > texts.length ? { omittedTextSlots: element.texts.length - texts.length } : {}), styles: Object.fromEntries(Object.entries(element.styles).filter(([, value]) => value)) };
}
function diffBundle(bundle) {
  const { base, draft } = normalizeBundle(bundle), changes = [];
  const beforePages = new Map(base.workspace.pages.map(page => [page.id, page])), afterPages = new Map(draft.workspace.pages.map(page => [page.id, page]));
  for (const id of new Set([...beforePages.keys(), ...afterPages.keys()])) {
    const before = beforePages.get(id), after = afterPages.get(id);
    if (!before || !after) { changes.push({ resource: "page", id, field: "*", before: pageSummary(before), after: pageSummary(after) }); continue; }
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[field], after[field])) continue;
      if (field !== "html") { changes.push({ resource: "page", id, field, before: before[field] ?? null, after: after[field] ?? null }); continue; }
      const oldElements = new Map(listElements(before.html).map(item => [item.id, item])), newElements = new Map(listElements(after.html).map(item => [item.id, item])), elementChanges = []; let changeCount = 0;
      for (const elementId of new Set([...oldElements.keys(), ...newElements.keys()])) {
        const oldElement = oldElements.get(elementId), newElement = newElements.get(elementId);
        if (!same(oldElement, newElement)) { changeCount++; if (elementChanges.length < 100) elementChanges.push({ id: elementId, before: elementSummary(oldElement), after: elementSummary(newElement) }); }
      }
      changes.push({ resource: "page", id, field, before: htmlSummary(before.html), after: htmlSummary(after.html), elementChanges, ...(changeCount > elementChanges.length ? { omittedElementChanges: changeCount - elementChanges.length } : {}) });
    }
  }
  const oldOrder = base.workspace.pages.map(page => page.id), newOrder = draft.workspace.pages.map(page => page.id);
  if (!same(oldOrder, newOrder)) changes.push({ resource: "page", field: "$order", before: oldOrder, after: newOrder });
  const oldNotes = new Map(base.annotations.notes.map(note => [note.id, note])), newNotes = new Map(draft.annotations.notes.map(note => [note.id, note]));
  for (const id of new Set([...oldNotes.keys(), ...newNotes.keys()])) {
    const before = oldNotes.get(id), after = newNotes.get(id);
    if (!before || !after) { changes.push({ resource: "note", id, field: "*", before: before || null, after: after || null }); continue; }
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) if (!same(before[field], after[field])) changes.push({ resource: "note", id, field, before: before[field] ?? null, after: after[field] ?? null });
  }
  const oldNoteOrder = base.annotations.notes.map(note => note.id), newNoteOrder = draft.annotations.notes.map(note => note.id);
  if (!same(oldNoteOrder, newNoteOrder)) changes.push({ resource: "note", field: "$order", before: oldNoteOrder, after: newNoteOrder });
  const summary = (oldRows, newRows) => ({
    added: newRows.filter(item => !oldRows.some(old => old.id === item.id)).map(item => item.id),
    removed: oldRows.filter(item => !newRows.some(next => next.id === item.id)).map(item => item.id),
    updated: newRows.filter(item => { const old = oldRows.find(old => old.id === item.id); return old && !same(old, item); }).map(item => item.id),
  });
  return { changed: { design: !same(base.workspace.pages, draft.workspace.pages), annotations: !same(base.annotations.notes, draft.annotations.notes) }, summary: { pages: summary(base.workspace.pages, draft.workspace.pages), notes: summary(base.annotations.notes, draft.annotations.notes) }, changes };
}

module.exports = { FORMAT, ModelError, createBundle, applyOperations, checkBundle, diffBundle, payloadForApply, createPageNote, listElements };
