"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBundle, applyOperations, checkBundle, diffBundle, payloadForApply } = require("../lib/flow-edit-model");

const entryPath = "20-收费管理/示例流程";
function node(id, type, x, y, extra = {}) { return { id, type, label: id, x, y, pageId: "", ...extra }; }
function fixture() {
  const workspace = { schemaVersion: 1, revision: 7, updatedAt: "2026-11-03T00:00:00.000Z", applicability: "needed", reason: "", references: [], flows: [
    { id: "main", name: "主流程", description: "证据", direction: "TD", parent: null,
      lanes: [{ id: "lane1", label: "主线", x: 0, y: 0, width: 400, height: 800 }],
      nodes: [node("start", "start", 20, 20), node("call", "step", 20, 200, { variant: "branch", issues: ["P01"] }), node("result", "decision", 20, 360), node("done", "end", 20, 600, { endScope: "execution" })],
      edges: [{ id: "e1", source: "start", target: "call", label: "开始" }, { id: "e2", source: "call", target: "result", label: "返回", trace: "proposal" }, { id: "e3", source: "result", target: "done", label: "结束" }] },
    { id: "child", name: "子流程", description: "", parent: { entryPath, flowId: "main", nodeId: "call" },
      nodes: [node("input", "input", 0, 0, { source: { entryPath, flowId: "main", nodeId: "call" } }), node("output", "output", 0, 200, { target: { entryPath, flowId: "main", nodeId: "result" }, supplement: true })],
      edges: [{ id: "ce", source: "input", target: "output", label: "" }] },
  ] };
  const annotations = { schemaVersion: 1, revision: 4, updatedAt: workspace.updatedAt, notes: [
    { id: "note1", target: { type: "flow-node", flowId: "main", nodeId: "call" }, text: "原证据", requirements: [], createdAt: workspace.updatedAt, updatedAt: workspace.updatedAt },
    { id: "note2", target: { type: "flow-edge", flowId: "main", edgeId: "e2" }, text: "原连线证据", requirements: [], createdAt: workspace.updatedAt, updatedAt: workspace.updatedAt },
  ] };
  return createBundle("http://127.0.0.1:8125", entryPath, workspace, annotations);
}

test("ID patch preserves all unrelated flows, geometry, styles, references and notes", () => {
  const source = fixture(), before = structuredClone(source);
  const edited = applyOperations(source, [
    { op: "node.update", flowId: "main", id: "call", set: { label: "核对原任务", x: 45 } },
    { op: "note.update", id: "note1", set: { text: "已补证" } },
  ]);
  assert.deepEqual(source, before);
  assert.deepEqual(edited.base, before.base);
  assert.deepEqual(edited.draft.workspace.flows[1], before.draft.workspace.flows[1]);
  assert.deepEqual(edited.draft.workspace.flows[0].lanes, before.draft.workspace.flows[0].lanes);
  assert.deepEqual(edited.draft.workspace.flows[0].edges, before.draft.workspace.flows[0].edges);
  const changed = edited.draft.workspace.flows[0].nodes[1];
  assert.deepEqual(changed, { ...before.draft.workspace.flows[0].nodes[1], label: "核对原任务", x: 45 });
  assert.deepEqual(edited.draft.annotations.notes[1], before.draft.annotations.notes[1]);
  assert.deepEqual(checkBundle(edited).errors, []);
  const diff = diffBundle(edited);
  assert.deepEqual(diff.changed, { flows: true, annotations: true });
  assert.deepEqual(diff.summary.flows.updated, ["main"]);
  assert.deepEqual(diff.summary.notes.updated, ["note1"]);
  assert.deepEqual(new Set(diff.changes.map(change => change.field)), new Set(["label", "x", "text"]));
});

test("a failing later operation leaves the original bundle untouched", () => {
  const source = fixture(), before = structuredClone(source);
  assert.throws(() => applyOperations(source, [
    { op: "node.update", flowId: "main", id: "call", set: { label: "新名称" } },
    { op: "edge.update", flowId: "main", id: "missing", set: { label: "失效" } },
  ]), /ID 不存在/);
  assert.deepEqual(source, before);
});

test("explicit remove must handle dependent edges, child links and notes together", () => {
  const source = fixture();
  assert.throws(() => applyOperations(source, [{ op: "node.remove", flowId: "main", id: "call" }]), /校验失败/);
  const edited = applyOperations(source, [
    { op: "node.add", flowId: "main", id: "replacement", value: node("replacement", "step", 300, 200) },
    { op: "edge.update", flowId: "main", id: "e1", set: { target: "replacement" } },
    { op: "edge.update", flowId: "main", id: "e2", set: { source: "replacement" } },
    { op: "flow.update", id: "child", set: { parent: { entryPath, flowId: "main", nodeId: "replacement" } } },
    { op: "node.update", flowId: "child", id: "input", set: { source: { entryPath, flowId: "main", nodeId: "replacement" } } },
    { op: "note.update", id: "note1", set: { target: { type: "flow-node", flowId: "main", nodeId: "replacement" } } },
    { op: "node.remove", flowId: "main", id: "call" },
  ]);
  assert.deepEqual(checkBundle(edited).errors, []);
  assert.ok(!edited.draft.workspace.flows[0].nodes.some(item => item.id === "call"));
});

test("existing broken references warn but newly broken references block", () => {
  const source = fixture();
  source.base.workspace.flows[1].nodes[1].target.nodeId = "old-missing";
  source.draft = structuredClone(source.base);
  const edited = applyOperations(source, [{ op: "node.update", flowId: "main", id: "call", set: { label: "说明更新" } }]);
  assert.deepEqual(checkBundle(edited).errors, []);
  assert.ok(checkBundle(edited).warnings.some(item => item.code === "DANGLING_REFERENCE" && item.message.includes("基线已存在")));
  edited.draft.workspace.flows[1].nodes[1].target.nodeId = "new-missing";
  assert.ok(checkBundle(edited).errors.some(item => item.code === "DANGLING_REFERENCE"));
  const deleted = fixture();
  deleted.draft.workspace.flows[0].nodes = deleted.draft.workspace.flows[0].nodes.filter(item => item.id !== "result");
  deleted.draft.workspace.flows[0].edges = deleted.draft.workspace.flows[0].edges.filter(item => ![item.source, item.target].includes("result"));
  assert.ok(checkBundle(deleted).errors.some(item => item.code === "DANGLING_REFERENCE"));
});

test("deleting an annotated edge creates an error until its note is handled", () => {
  const source = fixture();
  source.draft.workspace.flows[0].edges = source.draft.workspace.flows[0].edges.filter(item => item.id !== "e2");
  assert.ok(checkBundle(source).errors.some(item => item.code === "ORPHAN_NOTE"));
  source.draft.annotations.notes = source.draft.annotations.notes.filter(item => item.id !== "note2");
  assert.deepEqual(checkBundle(source).errors, []);
});

test("unknown fields, identity changes, metadata changes and ambiguous operations fail", () => {
  for (const operation of [
    { op: "node.update", flowId: "main", id: "call", set: { id: "renamed" } },
    { op: "node.update", flowId: "main", id: "call", set: { unknown: true } },
    { op: "node.update", flowId: "main", id: "call", unset: ["id"] },
    { op: "node.update", flowId: "main", id: "call", set: { label: "x" }, unset: ["label"] },
    { op: "workspace.update", set: { revision: 9 } },
    { op: "note.update", id: "note1", set: { createdAt: "now" } },
    { op: "node.add", flowId: "main", id: "other", value: node("wrong", "step", 100, 100) },
    { op: "node.add", flowId: "main", id: "call", value: node("call", "step", 100, 100) },
    { op: "node.move", flowId: "main", id: "call", set: { x: 10 } },
  ]) assert.throws(() => applyOperations(fixture(), [operation]));
  const direct = fixture();
  direct.draft.workspace.flows[0].nodes[1].unexpected = "not silently stripped";
  assert.match(checkBundle(direct).errors[0].message, /不支持字段 unexpected/);
  const revision = fixture(); revision.draft.workspace.revision++;
  assert.match(checkBundle(revision).errors[0].message, /不可修改/);
});

test("type change requires explicitly removing inapplicable structured semantics", () => {
  const source = fixture();
  assert.throws(() => applyOperations(source, [{ op: "node.update", flowId: "main", id: "done", set: { type: "step" } }]), /校验失败/);
  const edited = applyOperations(source, [{ op: "node.update", flowId: "main", id: "done", set: { type: "step" }, unset: ["endScope"] }]);
  assert.deepEqual(checkBundle(edited).errors, []);
  assert.equal(edited.draft.workspace.flows[0].nodes.at(-1).endScope, undefined);
});

test("diff uses the normalized payload that will actually be saved", () => {
  const source = fixture();
  source.draft.workspace.flows[0].nodes[1].label = "  核验  ";
  source.draft.workspace.flows[0].nodes[1].x = 22.8;
  const payload = payloadForApply(source), diff = diffBundle(source);
  assert.equal(payload.workspace.flows[0].nodes[1].label, "核验");
  assert.equal(payload.workspace.flows[0].nodes[1].x, 23);
  assert.equal(diff.changes.find(item => item.field === "x").after, 23);
  assert.equal(diff.changes.find(item => item.field === "label").after, "核验");
  assert.deepEqual([payload.expectedRevision, payload.expectedAnnotationsRevision], [7, 4]);
  assert.equal(payload.notes[0].createdAt, undefined);
  const unchanged = fixture(); unchanged.draft.workspace.flows[0].nodes[1].label = " call ";
  assert.deepEqual(diffBundle(unchanged).changed, { flows: false, annotations: false });
});

test("local parent cycle blocks, external references defer to service", () => {
  const source = fixture();
  source.draft.workspace.flows[0].parent = { entryPath, flowId: "child", nodeId: "input" };
  assert.ok(checkBundle(source).errors.some(item => item.code === "PARENT_CYCLE"));
  const external = fixture();
  external.draft.workspace.flows[1].nodes[1].target = { entryPath: "20-收费管理/其他需求", flowId: "outside", nodeId: "result" };
  assert.deepEqual(checkBundle(external).errors, []);
  assert.ok(checkBundle(external).warnings.some(item => item.code === "EXTERNAL_REFERENCE"));
});

test("structural and geometry suggestions remain warnings, not invented execution rules", () => {
  const source = fixture();
  source.draft.workspace.flows[0].nodes[3].endScope = "unspecified";
  source.draft.workspace.flows[0].nodes[3].x = 20;
  source.draft.workspace.flows[0].nodes[3].y = 200;
  const checked = checkBundle(source);
  assert.deepEqual(checked.errors, []);
  for (const code of ["END_SCOPE", "NODE_OVERLAP", "DECISION_BRANCHES"]) assert.ok(checked.warnings.some(item => item.code === code));
});

test("add/remove flow, edge, lane and note retain order and produce useful diff", () => {
  const source = fixture(), edited = applyOperations(source, [
    { op: "flow.add", id: "newflow", value: { name: "新流程", description: "", parent: null, nodes: [], edges: [] } },
    { op: "lane.add", flowId: "newflow", id: "newlane", value: { label: "区", x: 0, y: 0, width: 200, height: 600 } },
    { op: "node.add", flowId: "newflow", id: "newnode", value: { type: "step", label: "动作", x: 0, y: 0 } },
    { op: "note.add", id: "newnote", value: { target: { type: "flow-node", flowId: "newflow", nodeId: "newnode" }, text: "依据" } },
  ]);
  const diff = diffBundle(edited);
  assert.deepEqual(diff.summary.flows.added, ["newflow"]);
  assert.deepEqual(diff.summary.notes.added, ["newnote"]);
  const restored = applyOperations(edited, [{ op: "flow.remove", id: "newflow" }, { op: "note.remove", id: "newnote" }]);
  assert.deepEqual(diffBundle(restored).changed, { flows: false, annotations: false });
});

test("bundle scope and source format are explicit", () => {
  const source = fixture();
  assert.throws(() => createBundle("http://127.0.0.1:8125/path", entryPath, source.base.workspace, source.base.annotations), /origin/);
  assert.throws(() => createBundle("http://user:secret@127.0.0.1:8125", entryPath, source.base.workspace, source.base.annotations), /origin/);
  assert.throws(() => createBundle(source.origin, "../outside", source.base.workspace, source.base.annotations), /逻辑路径/);
  assert.deepEqual(diffBundle(source).changes, []);
});

test("page annotations are preserved read-only through operations and direct draft edits", () => {
  const source = fixture(), pageNote = { id: "page-note", target: { type: "page-element", pageId: "page-one", route: "", anchor: { selector: "#name", tag: "input", label: "姓名", htmlHash: "1234abcd", strength: "stable" } }, text: "页面说明", requirements: [] };
  source.base.annotations.notes.push(structuredClone(pageNote));
  source.draft.annotations.notes.push(structuredClone(pageNote));
  assert.deepEqual(checkBundle(source).errors, []);
  const changed = applyOperations(source, [{ op: "node.update", flowId: "main", id: "call", set: { label: "流程更新" } }]);
  assert.deepEqual(changed.draft.annotations.notes.at(-1), pageNote);
  for (const operation of [
    { op: "note.update", id: "page-note", set: { text: "禁止" } },
    { op: "note.remove", id: "page-note" },
    { op: "note.add", id: "page-new", value: { ...pageNote, id: "page-new" } },
    { op: "note.update", id: "note1", set: { target: pageNote.target } },
    { op: "note.update", id: "page-note", set: { target: { type: "flow-node", flowId: "main", nodeId: "call" } } },
  ]) assert.throws(() => applyOperations(source, [operation]), /流程/);
  const directEdits = [
    notes => { notes.at(-1).text = "禁止"; },
    notes => { notes.pop(); },
    notes => { notes.push({ ...structuredClone(pageNote), id: "new-page" }); },
    notes => { notes.at(-1).target = { type: "flow-node", flowId: "main", nodeId: "call" }; },
    notes => { notes[0].target = structuredClone(pageNote.target); },
  ];
  for (const mutate of directEdits) {
    const edited = structuredClone(source); mutate(edited.draft.annotations.notes);
    assert.ok(checkBundle(edited).errors.some(item => item.code === "PAGE_NOTE_READONLY"));
  }
});
