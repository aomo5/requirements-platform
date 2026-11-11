"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { MysqlStorage } = require("../lib/mysql-storage");
const { readFlowBundle, saveFlowBatch, createFlowBatchHandler } = require("../lib/flow-batch");

const topic = "00-测试/流程批量编辑";
const stamp = "2026-11-03T00:00:00.000Z";
const clone = value => structuredClone(value);
const node = (id, properties = {}) => ({ id, type: "step", label: id, x: 0, y: 0, pageId: "", ...properties });
const flow = (id, nodes, properties = {}) => ({ id, name: id, description: "", parent: null, nodes, edges: [], ...properties });
const workspace = flows => ({ schemaVersion: 1, revision: 3, updatedAt: stamp, applicability: "needed", reason: "", flows, references: [] });
const note = (id, flowId, nodeId, text = "原说明") => ({ id, target: { type: "flow-node", flowId, nodeId }, text, requirements: [], createdAt: stamp, updatedAt: stamp });

// Use the real resource validation/save methods with a transaction fixture.
// No database connection, shared schema, or running service is touched.
function fixture(initial = workspace([flow("main", [node("a"), node("b")])]), notes = [note("note-a", "main", "a")], external = []) {
  const db = Object.create(MysqlStorage.prototype);
  db.state = { flow: clone(initial), annotations: { schemaVersion: 1, revision: 5, updatedAt: stamp, notes: clone(notes) }, history: [] };
  db.external = clone(external);
  db.transactions = 0;
  db.entryCalls = 0;
  db.putCalls = 0;
  db.read = async (kind, entryPath) => {
    assert.equal(entryPath, topic);
    return { entry: { path: topic, feature: "流程批量编辑" }, workspace: clone(kind === "design" ? { pages: [] } : db.state[kind]) };
  };
  db.entry = async () => { db.entryCalls++; return "entry-id"; };
  db.rules = async () => ({ rules: [] });
  db.put = async (c, id, kind, value) => {
    db.putCalls++;
    if (db.failPut === kind) throw Error("injected write failure");
    db.state.history.push({ kind, revision: value.revision });
    db.state[kind] = clone(value);
  };
  const c = { query: async sql => {
    assert.match(sql, /WHERE w.kind='flow'/);
    return [[{ path: topic, payload: clone(db.state.flow) }, ...db.external.map(e => ({ path: e.entryPath, payload: clone(e.workspace) }))]];
  } };
  db.transaction = async action => {
    db.transactions++;
    const before = clone(db.state);
    try { return await action(c); } catch (error) { db.state = before; throw error; }
  };
  return db;
}

function payload(db) {
  return { expectedRevision: db.state.flow.revision, expectedAnnotationsRevision: db.state.annotations.revision,
    workspace: clone(db.state.flow), notes: clone(db.state.annotations.notes) };
}

test("bundle reads both resource revisions within one transaction", async () => {
  const db = fixture();
  const value = await readFlowBundle(db, topic);
  assert.equal(db.transactions, 1);
  assert.equal(value.workspace.revision, 3);
  assert.equal(value.annotations.revision, 5);
  assert.equal(db.putCalls, 0);
});

test("batch saves a new node and its annotation atomically with independent histories", async () => {
  const db = fixture(), input = payload(db);
  input.workspace.flows[0].nodes.push(node("new"));
  input.notes.push(note("note-new", "main", "new", "新增节点证据"));
  const result = await saveFlowBatch(db, topic, input);
  assert.deepEqual(result.changed, { flows: true, annotations: true });
  assert.equal(result.workspace.revision, 4);
  assert.equal(result.annotations.revision, 6);
  assert.equal(result.annotations.notes[0].updatedAt, stamp);
  assert.deepEqual(db.state.history, [{ kind: "flow", revision: 4 }, { kind: "annotations", revision: 6 }]);
  assert.equal(db.transactions, 1);
});

test("no-op keeps both revisions, while a flow-only edit does not rewrite annotations", async () => {
  const db = fixture();
  const noChange = await saveFlowBatch(db, topic, payload(db));
  assert.deepEqual(noChange.changed, { flows: false, annotations: false });
  assert.equal(db.putCalls, 0);
  const input = payload(db);
  input.workspace.flows[0].nodes[1].x = 123;
  const result = await saveFlowBatch(db, topic, input);
  assert.deepEqual(result.changed, { flows: true, annotations: false });
  assert.equal(result.annotations.revision, 5);
  assert.deepEqual(db.state.history, [{ kind: "flow", revision: 4 }]);
});

test("either stale revision prevents every resource write", async () => {
  for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
    const db = fixture(), before = clone(db.state), input = payload(db);
    input[key]--;
    input.workspace.flows[0].nodes[0].label = "不得写入";
    await assert.rejects(saveFlowBatch(db, topic, input), { status: 409 });
    assert.deepEqual(db.state, before);
    assert.equal(db.putCalls, 0);
  }
});

test("failure writing annotations rolls back the graph and its history", async () => {
  const db = fixture(), before = clone(db.state), input = payload(db);
  input.workspace.flows[0].nodes[0].label = "新名称";
  input.notes[0].text = "新说明";
  db.failPut = "annotations";
  await assert.rejects(saveFlowBatch(db, topic, input), /injected write failure/);
  assert.deepEqual(db.state, before);
});

test("dryRun validates new-node annotations without writing or advancing revisions", async () => {
  const db = fixture(), before = clone(db.state), input = payload(db);
  input.dryRun = true;
  input.workspace.flows[0].nodes.push(node("new"));
  input.notes.push(note("note-new", "main", "new"));
  const result = await saveFlowBatch(db, topic, input);
  assert.deepEqual(result.changed, { flows: true, annotations: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.workspace.revision, 3);
  assert.equal(result.annotations.revision, 5);
  assert.deepEqual(db.state, before);
  assert.equal(db.putCalls, 0);
  assert.equal(db.entryCalls, 0);
  input.workspace.flows[0].nodes[0].pageId = "missing-page";
  await assert.rejects(saveFlowBatch(db, topic, input), /关联页面不存在/);
});

test("new dangling input/output references fail, including in dry-run", async () => {
  for (const type of ["input", "output", "event"]) {
    const db = fixture(), input = payload(db);
    input.dryRun = true;
    input.workspace.flows[0].nodes.push(node("linked", { type, [type === "output" ? "target" : "source"]:
      { entryPath: topic, flowId: "missing", nodeId: "missing" } }));
    await assert.rejects(saveFlowBatch(db, topic, input), /失效的流程承接/);
    assert.equal(db.putCalls, 0);
  }
});

test("deleting a referenced node cannot break another topic's input/output/parent", async () => {
  for (const relation of ["source", "target", "parent"]) {
    const reference = { entryPath: topic, flowId: "main", nodeId: "b" };
    const otherFlow = relation === "parent" ? flow("child", [node("entry")], { parent: reference })
      : flow("child", [node("entry", { type: relation === "source" ? "input" : "output", [relation]: reference })]);
    const db = fixture(undefined, undefined, [{ entryPath: "00-测试/另一需求", workspace: workspace([otherFlow]) }]), input = payload(db);
    input.workspace.flows[0].nodes = input.workspace.flows[0].nodes.filter(n => n.id !== "b");
    await assert.rejects(saveFlowBatch(db, topic, input), /失效的流程承接/);
    assert.equal(db.putCalls, 0);
  }
});

test("removing an annotated node requires removing or retargeting the note in the same batch", async () => {
  const db = fixture(), input = payload(db);
  input.workspace.flows[0].nodes = input.workspace.flows[0].nodes.filter(n => n.id !== "a");
  await assert.rejects(saveFlowBatch(db, topic, input), /失效的流程说明/);
  input.notes[0].target.nodeId = "b";
  const result = await saveFlowBatch(db, topic, input);
  assert.equal(result.annotations.notes[0].id, "note-a");
  assert.equal(result.annotations.notes[0].target.nodeId, "b");
});

test("pre-existing broken references/notes do not block an unrelated edit", async () => {
  const broken = node("out", { type: "output", target: { entryPath: topic, flowId: "old-missing", nodeId: "old" } });
  const db = fixture(workspace([flow("main", [node("a"), broken])]), [note("old-orphan", "main", "old-missing")]);
  const input = payload(db);
  input.workspace.flows[0].nodes[0].label = "无关文案修改";
  const result = await saveFlowBatch(db, topic, input);
  assert.equal(result.workspace.revision, 4);
  assert.equal(result.annotations.revision, 5);
});

test("flow batches preserve page-element notes and reject additions, deletions, edits or type conversions", async () => {
  const pageNote = { id: "page-note", text: "页面原说明", requirements: [], target: { type: "page-element", pageId: "page", route: "",
    anchor: { selector: "#field", tag: "input", label: "字段", htmlHash: "12345678", contextHash: "", strength: "stable" } } };
  const db = fixture(undefined, [note("note-a", "main", "a"), pageNote]);
  const unchanged = payload(db);
  unchanged.notes[0].text = "只改流程说明";
  assert.equal((await saveFlowBatch(db, topic, unchanged)).changed.annotations, true);
  const before = clone(db.state);
  for (const mutate of [
    input => { input.notes.push({ ...clone(pageNote), id: "page-new" }); },
    input => { input.notes = input.notes.filter(n => n.id !== "page-note"); },
    input => { input.notes.find(n => n.id === "page-note").text = "不应允许"; },
    input => { input.notes.find(n => n.id === "page-note").target = { type: "flow-node", flowId: "main", nodeId: "a" }; },
    input => { input.notes.find(n => n.id === "note-a").target = clone(pageNote.target); },
  ]) {
    const input = payload(db);
    mutate(input);
    await assert.rejects(saveFlowBatch(db, topic, input), /页面元素说明必须原样保留/);
    assert.deepEqual(db.state, before);
  }
});

test("HTTP handler retains owner and origin guards and clearly rejects file mode", async () => {
  const db = fixture();
  const call = async (database, { method = "POST", route = "/api/flows/batch", canWrite = true, origin = "http://127.0.0.1:8125", body = payload(db) } = {}) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method, headers: { host: "127.0.0.1:8125", origin, "content-type": "application/json", "x-design-client": "workbench-v1" }, socket: { remoteAddress: "127.0.0.1" }, accountAccess: { canEdit: canWrite } });
    let response;
    await createFlowBatchHandler(database, (_, status, data) => { response = { status, data }; })(request, {}, new URL(route + "?path=" + encodeURIComponent(topic), origin));
    return response;
  };
  assert.equal((await call(db, { canWrite: false })).status, 403);
  assert.equal((await call(db, { origin: "http://evil.test" })).status, 403);
  assert.equal((await call(null)).status, 501);
  const read = await call(db, { route: "/api/flows/bundle", method: "GET", canWrite: false });
  assert.equal(read.status, 200);
  assert.equal(read.data.canEdit, false);
  assert.equal((await call(db)).status, 200);
});

test("MySQL atomic batches, conflicts, no-op history and cross-topic references", {
  skip: process.env.WORKBENCH_FLOW_BATCH_DB_TEST !== "1", timeout: 60000,
}, async () => {
  const { fixture: databaseFixture } = require("./document-fixture");
  const fs = require("node:fs"), path = require("node:path");
  const f = await databaseFixture();
  try {
    const request = bundle => ({ expectedRevision: bundle.workspace.revision,
      expectedAnnotationsRevision: bundle.annotations.revision,
      workspace: clone(bundle.workspace), notes: clone(bundle.annotations.notes) });
    const initial = await readFlowBundle(f.db, f.p);
    const input = request(initial);
    input.workspace = workspace([flow("main", [node("a"), node("b")])]);
    input.notes = [note("note-a", "main", "a")];
    const first = await saveFlowBatch(f.db, f.p, input);
    assert.equal(first.workspace.revision, 1);
    assert.equal(first.annotations.revision, 1);
    const history = () => f.db.pool.query("SELECT kind,revision FROM wb_versions ORDER BY kind,revision").then(([rows]) => rows);
    const firstHistory = await history();
    assert.deepEqual(firstHistory, [{ kind: "annotations", revision: 1 }, { kind: "flow", revision: 1 }]);

    const noop = await saveFlowBatch(f.db, f.p, request(first));
    assert.deepEqual(noop.changed, { flows: false, annotations: false });
    assert.deepEqual(await history(), firstHistory);
    for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
      const stale = request(first);
      stale[key] = 0;
      await assert.rejects(saveFlowBatch(f.db, f.p, stale), { status: 409 });
    }
    assert.deepEqual(await readFlowBundle(f.db, f.p), { workspace: first.workspace, annotations: first.annotations });

    const next = request(first);
    next.workspace.flows[0].nodes.push(node("new"));
    next.notes.push(note("note-new", "main", "new"));
    const preview = await saveFlowBatch(f.db, f.p, { ...next, dryRun: true });
    assert.equal(preview.workspace.revision, 1);
    assert.equal(preview.annotations.revision, 1);
    assert.deepEqual(await history(), firstHistory);
    const originalPut = f.db.put;
    f.db.put = async function (c, id, kind, value) {
      if (kind === "annotations") throw Error("injected MySQL annotation failure");
      return originalPut.call(this, c, id, kind, value);
    };
    try { await assert.rejects(saveFlowBatch(f.db, f.p, next), /injected MySQL annotation failure/); }
    finally { f.db.put = originalPut; }
    assert.deepEqual(await readFlowBundle(f.db, f.p), { workspace: first.workspace, annotations: first.annotations });
    assert.deepEqual(await history(), firstHistory);
    const second = await saveFlowBatch(f.db, f.p, next);
    assert.equal(second.workspace.revision, 2);
    assert.equal(second.annotations.revision, 2);
    assert.ok(second.annotations.notes.some(n => n.target.nodeId === "new"));

    const bad = request(second);
    bad.workspace.flows[0].nodes.push(node("bad", { type: "input", source: { entryPath: f.p, flowId: "absent", nodeId: "absent" } }));
    await assert.rejects(saveFlowBatch(f.db, f.p, bad), /失效的流程承接/);
    const other = "20-测试/引用方";
    fs.mkdirSync(path.join(f.root, other), { recursive: true });
    fs.writeFileSync(path.join(f.root, other, "需求文档.md"), "# 引用方\n");
    await f.db.save("flow", other, 0, workspace([flow("receiver", [node("entry", { type: "input", source: { entryPath: f.p, flowId: "main", nodeId: "b" } })])]));
    const deletion = request(second);
    deletion.workspace.flows[0].nodes = deletion.workspace.flows[0].nodes.filter(n => n.id !== "b");
    await assert.rejects(saveFlowBatch(f.db, f.p, deletion), /失效的流程承接/);
    assert.equal((await readFlowBundle(f.db, f.p)).workspace.revision, 2);
  } finally { await f.close(); }
});
