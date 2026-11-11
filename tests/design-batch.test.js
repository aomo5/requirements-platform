"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { MysqlStorage } = require("../lib/mysql-storage");
const { stampElements, elementRecords } = require("../lib/stable-identities");
const { readDesignBundle, saveDesignBatch, createDesignBatchHandler } = require("../lib/design-batch");

const topic = "00-测试/设计批量编辑", stamp = "2026-11-03T00:00:00.000Z";
const clone = value => structuredClone(value);
const page = (id, html = '<button id="submit">提交</button>', properties = {}) => ({ id, name: id, width: 1000, height: 800, x: 0, y: 0, html: stampElements(html), source: "", route: "", ...properties });
const workspace = pages => ({ schemaVersion: 1, revision: 3, updatedAt: stamp, pages });
const note = (id, targetPage, text = "页面说明") => {
  const element = elementRecords(targetPage.html)[0];
  return { id, target: { type: "page-element", pageId: targetPage.id, route: targetPage.route, anchor: {
    elementId: element.id, selector: `[data-wb-element="${element.id}"]`, tag: element.tag, label: "提交", htmlHash: "12345678", contextHash: "", strength: "stable",
  } }, text, requirements: [], createdAt: stamp, updatedAt: stamp };
};
const flowNote = { id: "flow-note", target: { type: "flow-node", flowId: "main", nodeId: "open" }, text: "流程说明", requirements: [], createdAt: stamp, updatedAt: stamp };
function fixture({ pages = [page("one")], notes, links = [] } = {}) {
  const db = Object.create(MysqlStorage.prototype);
  db.state = { design: workspace(pages), annotations: { schemaVersion: 1, revision: 5, updatedAt: stamp, notes: clone(notes || [note("note-one", pages[0]), flowNote]) },
    flow: { flows: [{ id: "main", nodes: [{ id: "open", pageId: "" }, ...links.map((pageId, index) => ({ id: "linked-" + index, pageId }))], edges: [] }] }, history: [] };
  db.transactions = db.putCalls = db.entryCalls = 0;
  db.read = async (kind, entryPath) => {
    assert.equal(entryPath, topic);
    return { entry: { path: topic, feature: "设计批量编辑" }, workspace: clone(db.state[kind]) };
  };
  db.entry = async () => { db.entryCalls++; return "entry-id"; };
  db.rules = async (_path, _c, options) => { db.ruleOptions = options; return { rules: db.currentRules || [] }; };
  db.put = async (_c, _id, kind, value) => {
    db.putCalls++;
    if (db.failPut === kind) throw Error("injected write failure");
    db.state.history.push({ kind, revision: value.revision }); db.state[kind] = clone(value);
  };
  db.transaction = async action => {
    db.transactions++; const before = clone(db.state);
    try { return await action({}); } catch (error) { db.state = before; throw error; }
  };
  return db;
}
function payload(db) {
  return { expectedRevision: db.state.design.revision, expectedAnnotationsRevision: db.state.annotations.revision,
    pages: clone(db.state.design.pages), notes: clone(db.state.annotations.notes) };
}

test("bundle reads design, annotations and flow links in one transaction", async () => {
  const db = fixture({ links: ["one", "legacy-missing"] }), result = await readDesignBundle(db, topic);
  assert.equal(db.transactions, 1); assert.equal(result.workspace.revision, 3); assert.equal(result.annotations.revision, 5);
  assert.deepEqual(result.context, { flowLinks: [{ flowId: "main", nodeId: "linked-0", pageId: "one" }, { flowId: "main", nodeId: "linked-1", pageId: "legacy-missing" }] });
});

test("new page and its annotation save atomically and unchanged annotations retain timestamps", async () => {
  const db = fixture(), input = payload(db), created = page("new");
  input.pages.push(created); input.notes.push(note("note-new", created));
  const result = await saveDesignBatch(db, topic, input);
  assert.deepEqual(result.changed, { design: true, annotations: true });
  assert.equal(result.workspace.revision, 4); assert.equal(result.annotations.revision, 6);
  assert.equal(result.annotations.notes[0].updatedAt, stamp);
  assert.deepEqual(db.state.history, [{ kind: "design", revision: 4 }, { kind: "annotations", revision: 6 }]);
});

test("no-op keeps revisions and design-only text/style edits preserve stable notes", async () => {
  const db = fixture(), unchanged = await saveDesignBatch(db, topic, payload(db));
  assert.deepEqual(unchanged.changed, { design: false, annotations: false }); assert.equal(db.putCalls, 0);
  const input = payload(db); input.pages[0].html = input.pages[0].html.replace('id="submit"', 'id="submit" style="color:red"').replace("提交", "确认");
  const result = await saveDesignBatch(db, topic, input);
  assert.deepEqual(result.changed, { design: true, annotations: false });
  assert.equal(result.annotations.revision, 5); assert.deepEqual(db.state.annotations.notes, input.notes);
});

test("either stale revision rejects the entire batch before any writes", async () => {
  for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
    const db = fixture(), before = clone(db.state), input = payload(db); input[key]--; input.pages[0].name = "新名称";
    await assert.rejects(saveDesignBatch(db, topic, input), { status: 409 }); assert.deepEqual(db.state, before); assert.equal(db.putCalls, 0);
  }
});

test("failed second write rolls back design and both histories", async () => {
  const db = fixture(), before = clone(db.state), input = payload(db); input.pages[0].name = "新名称"; input.notes[0].text = "新说明"; db.failPut = "annotations";
  await assert.rejects(saveDesignBatch(db, topic, input), /injected write failure/); assert.deepEqual(db.state, before);
});

test("dry-run validates candidate page annotations and rule references without writes", async () => {
  const db = fixture(), before = clone(db.state), input = payload(db), created = page("new");
  input.dryRun = true; input.pages.push(created); input.notes.push(note("note-new", created));
  const rule = { file: topic + "/需求文档.md", blockId: "rule-one", quote: "已确认规则", heading: "规则" };
  db.currentRules = [{ ...rule, stable: true, ambiguous: false }]; input.notes.at(-1).requirements = [rule];
  const result = await saveDesignBatch(db, topic, input);
  assert.deepEqual(result.changed, { design: true, annotations: true }); assert.equal(result.workspace.revision, 3); assert.equal(result.annotations.revision, 5);
  assert.equal(result.dryRun, true); assert.deepEqual(db.state, before); assert.equal(db.putCalls, 0); assert.equal(db.entryCalls, 0); assert.deepEqual(db.ruleOptions, { readOnly: true });
  input.notes.at(-1).requirements[0].quote = "过期规则";
  await assert.rejects(saveDesignBatch(db, topic, input), /需求原文已变化/); assert.deepEqual(db.state, before);
});

test("deleting a flow-linked page is rejected while pre-existing broken links remain permitted", async () => {
  const db = fixture({ links: ["one", "already-missing"] }), input = payload(db); input.pages = []; input.notes = [clone(flowNote)]; input.dryRun = true;
  await assert.rejects(saveDesignBatch(db, topic, input), /流程节点关联的页面失效/);
  const harmless = payload(db); harmless.pages[0].x = 20;
  assert.equal((await saveDesignBatch(db, topic, harmless)).changed.design, true);
});

test("deleting annotated elements requires same-batch removal or a valid retarget", async () => {
  for (const dryRun of [true, false]) {
    const db = fixture(), before = clone(db.state), input = payload(db); input.dryRun = dryRun;
    input.pages[0].html = stampElements('<input id="replacement">');
    await assert.rejects(saveDesignBatch(db, topic, input), /失效的页面元素说明/); assert.deepEqual(db.state, before);
    input.notes[0] = note("note-one", input.pages[0]);
    assert.equal((await saveDesignBatch(db, topic, input)).changed.annotations, true);
  }
  const db = fixture(), input = payload(db); input.pages = []; input.notes = [clone(flowNote)];
  assert.deepEqual((await saveDesignBatch(db, topic, input)).changed, { design: true, annotations: true });
});

test("new invalid/ambiguous/mismatched targets fail, old orphans can be kept", async () => {
  const db = fixture(), original = payload(db);
  for (const mutate of [
    n => { n.target.pageId = "missing"; },
    n => { n.target.anchor.tag = "input"; },
    n => { delete n.target.anchor.elementId; n.target.anchor.selector = ".missing"; },
    n => { delete n.target.anchor.elementId; n.target.anchor.selector = "["; },
  ]) {
    const input = clone(original); input.notes[0].id = "new-note"; mutate(input.notes[0]);
    await assert.rejects(saveDesignBatch(db, topic, input), /失效的页面元素说明/);
  }
  const ambiguous = page("two", '<button class="same">一</button><button class="same">二</button>'), input = clone(original), added = note("ambiguous", ambiguous);
  delete added.target.anchor.elementId; added.target.anchor.selector = ".same"; input.pages.push(ambiguous); input.notes.push(added);
  await assert.rejects(saveDesignBatch(db, topic, input), /失效的页面元素说明/);
  db.state.annotations.notes[0].target.pageId = "old-missing";
  const legacy = payload(db); legacy.notes[0].text = "补充旧孤立说明"; legacy.pages[0].name = "改名";
  assert.deepEqual((await saveDesignBatch(db, topic, legacy)).changed, { design: true, annotations: true });
});

test("legacy stable selector supports text edits while path anchors require the saved HTML fingerprint", async () => {
  const db = fixture(), a = db.state.annotations.notes[0].target.anchor;
  delete a.elementId; a.selector = "#submit";
  const input = payload(db); input.pages[0].html = input.pages[0].html.replace("提交", "确认");
  await saveDesignBatch(db, topic, input);
  const fingerprint = html => { let h = 2166136261; for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); };
  db.state.annotations.notes[0].target.anchor.strength = "path";
  db.state.annotations.notes[0].target.anchor.htmlHash = fingerprint(db.state.design.pages[0].html);
  const pathEdit = payload(db); pathEdit.pages[0].html += "\n";
  await assert.rejects(saveDesignBatch(db, topic, pathEdit), /失效的页面元素说明/);
});

test("page state metadata does not pretend to prove runtime annotation visibility", async () => {
  const db = fixture(), input = payload(db); input.pages[0].route = "#another-state";
  assert.equal((await saveDesignBatch(db, topic, input)).changed.design, true);
});

test("flow notes must pass through unchanged, including new, removed and converted notes", async () => {
  for (const mutate of [
    input => { input.notes.push({ ...clone(flowNote), id: "another-flow-note" }); },
    input => { input.notes = input.notes.filter(n => n.id !== "flow-note"); },
    input => { input.notes.find(n => n.id === "flow-note").text = "不能改"; },
    input => { input.notes.find(n => n.id === "flow-note").target = clone(input.notes[0].target); },
    input => { input.notes[0].target = clone(flowNote.target); },
  ]) {
    const db = fixture(), before = clone(db.state), input = payload(db); mutate(input);
    await assert.rejects(saveDesignBatch(db, topic, input), /流程节点和连线说明必须原样保留/); assert.deepEqual(db.state, before);
  }
});

test("raw added HTML is stamped before validation and dry-run output can be applied exactly", async () => {
  const db = fixture(), input = payload(db); input.dryRun = true;
  input.pages.push(page("raw", "", { html: '<section><button>新增</button></section>' }));
  const dry = await saveDesignBatch(db, topic, input);
  assert.equal(elementRecords(dry.workspace.pages.at(-1).html).length, 2);
  const result = await saveDesignBatch(db, topic, { ...input, dryRun: false, pages: dry.workspace.pages });
  assert.equal(result.workspace.pages.at(-1).html, dry.workspace.pages.at(-1).html);
});

test("the larger batch envelope retains separate design and annotation capacity limits", async () => {
  const db = fixture(), before = clone(db.state), design = payload(db);
  design.dryRun = true;
  for (let i = 0; i < 8; i++) design.pages.push(page("large-" + i, "<div>" + "x".repeat(550000) + "</div>"));
  await assert.rejects(saveDesignBatch(db, topic, design), { status: 413 });
  const annotations = payload(db); annotations.dryRun = true;
  for (let i = 0; i < 140; i++) annotations.notes.push(note("large-note-" + i, annotations.pages[0], "x".repeat(8000)));
  await assert.rejects(saveDesignBatch(db, topic, annotations), { status: 413 });
  assert.deepEqual(db.state, before); assert.equal(db.putCalls, 0);
});

test("HTTP endpoint enforces owner, same-origin, client header, JSON and a local 6 MB limit", async () => {
  const db = fixture();
  async function call({ database = db, method = "POST", route = "/api/design/batch", canWrite = true, headers = {}, body = payload(db), raw } = {}) {
    const request = Readable.from([Buffer.from(raw === undefined ? JSON.stringify(body) : raw)]);
    Object.assign(request, { method, headers: { host: "127.0.0.1:8125", origin: "http://127.0.0.1:8125", "content-type": "application/json", "x-design-client": "workbench-v1", ...headers }, socket: { remoteAddress: "127.0.0.1" }, accountAccess: { canEdit: canWrite } });
    let result;
    await createDesignBatchHandler(database, (_, status, data) => { result = { status, data }; })(request, {}, new URL(route + "?path=" + encodeURIComponent(topic), "http://127.0.0.1:8125"));
    return result;
  }
  assert.equal((await call({ canWrite: false })).status, 403);
  assert.equal((await call({ headers: { origin: "http://evil.test" } })).status, 403);
  assert.equal((await call({ headers: { "x-design-client": "" } })).status, 403);
  assert.equal((await call({ headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call({ raw: "{" })).status, 400);
  assert.equal((await call({ raw: " ".repeat(6 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await call({ raw: " ".repeat(4 * 1024 * 1024) + JSON.stringify(payload(db)) })).status, 200);
  assert.equal((await call({ database: null })).status, 501);
  const read = await call({ method: "GET", route: "/api/design/bundle", canWrite: false });
  assert.equal(read.status, 200); assert.equal(read.data.canEdit, false); assert.equal(read.data.accessMode, "local");
});

test("MySQL atomic design batches, conflict, dry-run and failure leave isolated histories consistent", {
  skip: process.env.WORKBENCH_DESIGN_BATCH_DB_TEST !== "1", timeout: 60000,
}, async () => {
  const f = await require("./document-fixture").fixture();
  try {
    const request = bundle => ({ expectedRevision: bundle.workspace.revision, expectedAnnotationsRevision: bundle.annotations.revision,
      pages: clone(bundle.workspace.pages), notes: clone(bundle.annotations.notes) });
    const history = () => f.db.pool.query("SELECT kind,revision FROM wb_versions ORDER BY kind,revision").then(([rows]) => rows);
    const firstPage = page("one"), initial = await readDesignBundle(f.db, f.p);
    const first = await saveDesignBatch(f.db, f.p, { ...request(initial), pages: [firstPage], notes: [note("note-one", firstPage)] });
    assert.deepEqual(first.changed, { design: true, annotations: true }); assert.equal(first.workspace.revision, 1); assert.equal(first.annotations.revision, 1);
    const firstHistory = await history(); assert.deepEqual(firstHistory, [{ kind: "annotations", revision: 1 }, { kind: "design", revision: 1 }]);
    const noOp = await saveDesignBatch(f.db, f.p, request(first)); assert.deepEqual(noOp.changed, { design: false, annotations: false }); assert.deepEqual(await history(), firstHistory);
    const second = page("two"), draft = request(first); draft.pages.push(second); draft.notes.push(note("note-two", second)); draft.dryRun = true;
    const dry = await saveDesignBatch(f.db, f.p, draft); assert.equal(dry.workspace.revision, 1); assert.equal(dry.annotations.revision, 1);
    assert.deepEqual(await history(), firstHistory); assert.equal((await readDesignBundle(f.db, f.p)).workspace.pages.length, 1);
    for (const key of ["expectedRevision", "expectedAnnotationsRevision"]) {
      const stale = request(first); stale[key] = 0; stale.pages[0].name = "不得写入";
      await assert.rejects(saveDesignBatch(f.db, f.p, stale), { status: 409 }); assert.deepEqual(await history(), firstHistory);
    }
    const put = f.db.put;
    f.db.put = async function(c, id, kind, value) { if (kind === "annotations") throw Error("injected DB write failure"); return put.call(this, c, id, kind, value); };
    await assert.rejects(saveDesignBatch(f.db, f.p, { ...draft, dryRun: false }), /injected DB write failure/);
    f.db.put = put; assert.deepEqual(await history(), firstHistory); assert.equal((await readDesignBundle(f.db, f.p)).workspace.pages.length, 1);
    const current = await saveDesignBatch(f.db, f.p, { ...draft, dryRun: false });
    assert.equal(current.workspace.revision, 2); assert.equal(current.annotations.revision, 2);
    const linkedFlow = { applicability: "needed", reason: "", references: [], flows: [{ id: "main", name: "入口", description: "", parent: null,
      nodes: [{ id: "open", type: "step", label: "打开页面", x: 0, y: 0, pageId: "one" }], edges: [] }] };
    await f.db.save("flow", f.p, 0, linkedFlow);
    const linked = await readDesignBundle(f.db, f.p), deletion = request(linked);
    deletion.pages = deletion.pages.filter(p => p.id !== "one"); deletion.notes = deletion.notes.filter(n => n.target.pageId !== "one");
    await assert.rejects(saveDesignBatch(f.db, f.p, deletion), /流程节点关联的页面失效/);
    assert.deepEqual((await readDesignBundle(f.db, f.p)).workspace, linked.workspace);
  } finally { await f.close(); }
});
