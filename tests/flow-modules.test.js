"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateContent, validateRelations, createFlowStore } = require("../lib/flow-store");
const { createBundle, applyOperations, checkBundle, diffBundle, payloadForApply } = require("../lib/flow-edit-model");
const { validateBundleReferences } = require("../lib/flow-batch");
const { MysqlStorage } = require("../lib/mysql-storage");

const topic = "00-测试/调用方", library = "00-测试/公共模块";
const node = (id, type = "step", extra = {}) => ({ id, type, label: id, x: 0, y: 0, pageId: "", ...extra });
const edge = (id, source, target) => ({ id, source, target, label: "" });
const flow = (id, nodes, edges = [], extra = {}) => ({ id, name: id, description: "", parent: null, nodes, edges, ...extra });
const moduleFlow = () => flow("refund", [node("entry", "input"), node("recheck", "input"), node("done", "return"), node("pending", "return")],
  [edge("start-done", "entry", "done"), edge("retry-pending", "recheck", "pending")], { kind: "module" });
const caller = (id = "main", entryPath = topic) => flow(id, [node("invoke", "call", { call: { entryPath, flowId: "refund", nodeId: "entry",
  returns: [{ outputNodeId: "done", targetNodeId: "complete" }, { outputNodeId: "pending", targetNodeId: "wait" }] } }), node("complete"), node("wait")],
  [edge("ok", "invoke", "complete"), edge("later", "invoke", "wait")]);
const workspace = flows => ({ schemaVersion: 1, revision: 1, updatedAt: null, applicability: "needed", reason: "", flows, references: [] });
const notes = { schemaVersion: 1, revision: 0, updatedAt: null, notes: [] };
const bundle = () => createBundle("http://127.0.0.1:8125", topic, workspace([caller(), moduleFlow()]), notes);
const state = (entryPath, value, externals = []) => ({ entries: [{ entry: { path: entryPath }, workspace: value }, ...externals.map(e => ({ entry: { path: e.entryPath }, workspace: e.workspace }))], issues: [] });
const validSave = (before, after, externals = []) => validateRelations({ entry: { path: topic } }, before, validateContent(after, topic), state(topic, before, externals));

test("public modules preserve stable input/return contracts for multiple callers", () => {
  const data = workspace([caller(), caller("another"), moduleFlow()]);
  data.flows[1].nodes[0].call.nodeId = "recheck";
  const normalized = validateContent(data, topic);
  assert.equal(normalized.flows[2].kind, "module");
  assert.deepEqual(normalized.flows[0].nodes[0].call, data.flows[0].nodes[0].call);
  assert.doesNotThrow(() => validSave(workspace([]), data));
  const checked = checkBundle(createBundle("http://127.0.0.1:8125", topic, data, notes));
  assert.deepEqual(checked.errors, []);
  assert.ok(!checked.warnings.some(w => w.code === "INPUT_SOURCE"));
});

test("module entry and return cannot capture a caller or use fixed output semantics", () => {
  const ref = { entryPath: library, flowId: "caller", nodeId: "call" };
  for (const mutate of [
    f => { f.parent = ref; },
    f => { f.nodes[0].source = ref; },
    f => { f.nodes[2].target = ref; },
    f => { f.nodes[2].source = ref; },
    f => { delete f.kind; },
    f => { f.edges.push(edge("bad", "done", "entry")); },
  ]) {
    const f = moduleFlow(); mutate(f);
    assert.throws(() => validateContent(workspace([f]), topic), /模块|调用和返回/);
  }
});

test("call configuration validates target kind, entry type and exact return coverage", () => {
  for (const [code, mutate] of [
    ["CALL_TARGET", b => { b.draft.workspace.flows[0].nodes[0].call.flowId = "missing"; }],
    ["CALL_KIND", b => { const f = b.draft.workspace.flows[1]; delete f.kind; f.nodes = f.nodes.filter(n => n.type !== "return"); f.edges = []; }],
    ["CALL_ENTRY", b => { b.draft.workspace.flows[0].nodes[0].call.nodeId = "done"; }],
    ["CALL_RETURNS", b => { b.draft.workspace.flows[0].nodes[0].call.returns.pop(); }],
    ["CALL_RETURNS", b => { b.draft.workspace.flows[0].nodes[0].call.returns[0].outputNodeId = "entry"; }],
    ["CALL_RECEIVER", b => { b.draft.workspace.flows[0].nodes[0].call.returns[0].targetNodeId = "absent"; }],
    ["CALL_RETURN_EDGE", b => { b.draft.workspace.flows[0].edges.pop(); }],
  ]) {
    const b = bundle(); mutate(b);
    assert.ok(checkBundle(b).errors.some(e => e.code === code), code);
  }
  const duplicate = bundle(); duplicate.draft.workspace.flows[0].nodes[0].call.returns.push({ outputNodeId: "done", targetNodeId: "wait" });
  assert.match(checkBundle(duplicate).errors[0].message, /重复映射/);
});

test("CLI operations, diff and apply preserve module and invocation metadata", () => {
  const b = bundle();
  const call = structuredClone(b.draft.workspace.flows[0].nodes[0].call);
  call.nodeId = "recheck";
  const changed = applyOperations(b, [{ op: "node.update", flowId: "main", id: "invoke", set: { call } }]);
  assert.ok(diffBundle(changed).changes.length);
  assert.deepEqual(payloadForApply(changed).workspace.flows[0].nodes[0].call, call);
  assert.equal(payloadForApply(changed).workspace.flows[1].kind, "module");
  const draft = applyOperations(b, [{ op: "node.update", flowId: "main", id: "invoke", unset: ["call"] }]);
  assert.ok(checkBundle(draft).warnings.some(w => w.code === "CALL_TARGET"));
  assert.deepEqual(checkBundle(draft).errors, []);
  const invalid = structuredClone(b); invalid.draft.workspace.flows[0].nodes[0].call.mode = "async";
  assert.match(checkBundle(invalid).errors[0].message, /不支持字段 mode/);
  assert.throws(() => validateContent(invalid.draft.workspace, topic), /只支持同步/);
});

test("configured calls reject unmapped outgoing edges but allow several returns to share one receiver", () => {
  const b = bundle(), current = b.draft.workspace.flows[0];
  current.nodes.push(node("unexpected"));
  current.edges.push(edge("unmapped", "invoke", "unexpected"));
  assert.ok(checkBundle(b).errors.some(error => error.code === "CALL_UNMAPPED_EDGE"));
  assert.throws(() => validSave(b.base.workspace, b.draft.workspace), error => error.details.some(problem => problem.code === "CALL_UNMAPPED_EDGE"));
  current.edges = current.edges.filter(item => !["unmapped", "later"].includes(item.id));
  current.nodes[0].call.returns[1].targetNodeId = "complete";
  assert.deepEqual(checkBundle(b).errors, []);
  assert.doesNotThrow(() => validSave(b.base.workspace, b.draft.workspace));
});

test("nested calls are allowed but direct and indirect recursion are rejected independently of parent trees", () => {
  const a = moduleFlow();
  const b = caller("nested"); b.kind = "module"; b.nodes.push(node("entry", "input"), node("result", "return"));
  b.edges.push(edge("from-entry", "entry", "invoke"), edge("return-ok", "complete", "result"), edge("return-pending", "wait", "result"));
  const good = workspace([a, b]);
  assert.doesNotThrow(() => validSave(workspace([]), good));
  const bad = structuredClone(good);
  bad.flows[0].nodes.push(node("loop", "call", { call: { entryPath: topic, flowId: "nested", nodeId: "entry", returns: [{ outputNodeId: "result", targetNodeId: "done" }] } }));
  bad.flows[0].edges.push(edge("loop-return", "loop", "done"));
  assert.throws(() => validSave(good, bad), error => error.details.some(p => p.code === "CALL_CYCLE"));
  const self = workspace([moduleFlow()]);
  self.flows[0].nodes.push(node("loop", "call", { call: { ...caller().nodes[0].call, returns: [{ outputNodeId: "done", targetNodeId: "done" }, { outputNodeId: "pending", targetNodeId: "pending" }] } }));
  self.flows[0].edges.push(edge("loop-done", "loop", "done"), edge("loop-pending", "loop", "pending"));
  assert.throws(() => validSave(workspace([]), self), error => error.details.some(p => p.code === "CALL_CYCLE"));
});

test("both normal save and atomic batch protect cross-topic modules, inputs and return contracts", () => {
  const before = workspace([moduleFlow()]);
  const external = [{ entryPath: library, workspace: workspace([caller("external", topic)]) }];
  for (const mutate of [
    w => { w.flows = []; },
    w => { w.flows[0].nodes = w.flows[0].nodes.filter(n => n.id !== "entry"); w.flows[0].edges = w.flows[0].edges.filter(e => e.source !== "entry"); },
    w => { w.flows[0].nodes[0].type = "step"; },
    w => { w.flows[0].nodes[2].type = "step"; },
    w => { w.flows[0].nodes.push(node("new-result", "return")); },
    w => { delete w.flows[0].kind; w.flows[0].nodes.forEach(n => { if (n.type === "return") n.type = "step"; }); },
  ]) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => validSave(before, after, external), /失效的模块调用/);
    assert.throws(() => validateBundleReferences(topic, before, after, [], [], external), /失效的流程承接/);
  }
});

test("pre-existing invalid module references remain warnings during unrelated edits", () => {
  const before = workspace([caller("main", library)]);
  const after = structuredClone(before); after.flows[0].name = "仅改名称";
  assert.doesNotThrow(() => validSave(before, after));
  assert.doesNotThrow(() => validateBundleReferences(topic, before, after, [], [], []));
  const local = bundle(); local.base.workspace.flows[0].nodes[0].call.flowId = "old-missing";
  local.draft = structuredClone(local.base); local.draft.workspace.flows[0].name = "仅改名称";
  assert.deepEqual(checkBundle(local).errors, []);
  assert.ok(checkBundle(local).warnings.some(w => w.code === "CALL_TARGET" && /基线已存在/.test(w.message)));
  const changed = structuredClone(after); changed.flows[0].nodes[0].call.flowId = "another-missing";
  assert.throws(() => validSave(before, changed), /失效的模块调用/);
});

test("file store round-trips shared module calls and guards deletion without schema migration", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-modules-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = [topic, library].map(p => ({ path: p, feature: p.split("/").at(-1) }));
  for (const e of entries) fs.mkdirSync(path.join(root, e.path), { recursive: true });
  const store = createFlowStore(root, p => entries.find(e => e.path === p), () => entries);
  store.save(library, 0, workspace([moduleFlow()]));
  store.save(topic, 0, workspace([caller("main", library), caller("another", library)]));
  assert.deepEqual(store.read(topic).workspace.flows[0].nodes[0].call, caller("main", library).nodes[0].call);
  const catalog = store.catalog().flows;
  assert.equal(catalog.find(f => f.id === "refund").kind, "module");
  assert.equal(catalog.find(f => f.id === "refund").nodes[0].type, "input");
  assert.equal(catalog.find(f => f.id === "main").nodes[0].call.flowId, "refund");
  assert.throws(() => store.save(library, 1, workspace([])), /失效的模块调用/);
});

test("MySQL catalog exposes the same module and call contract as file storage", async () => {
  const db = Object.create(MysqlStorage.prototype);
  db.pool = { query: async () => [[{ path: topic, payload: workspace([caller(), moduleFlow()]) }]] };
  const catalog = await db.store("flow").catalog();
  assert.equal(catalog.flows[1].kind, "module");
  assert.equal(catalog.flows[1].nodes[0].type, "input");
  assert.deepEqual(catalog.flows[0].nodes[0].call, caller().nodes[0].call);
});
