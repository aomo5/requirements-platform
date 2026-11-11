"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { unzipSync } = require("fflate");
const { DesignClient } = require("../lib/design-cli-client");
const { FlowClient } = require("../lib/flow-cli-client");
const { createDesignExportHandler } = require("../lib/design-export");
const { stampElements } = require("../lib/stable-identities");
const { run } = require("../scripts/designs");
const model = require("../lib/design-edit-model");

const topic = "00-测试/设计 CLI", stamp = "2026-11-03T00:00:00Z";
const page = () => ({ id: "main", name: "主页面", width: 1000, height: 800, x: 0, y: 0, source: "", route: "",
  html: stampElements('<!doctype html><html><head><style>button{color:black}</style></head><body><button>提交 <strong>申请</strong></button><script>window.sample="提交"</script></body></html>') });
const initial = () => ({ workspace: { schemaVersion: 1, revision: 3, updatedAt: stamp, pages: [page()] },
  annotations: { schemaVersion: 1, revision: 2, updatedAt: stamp, notes: [] }, context: { flowLinks: [] }, canEdit: true });

test("CLI imports, edits source slots, annotates, dry-runs, commits and verifies; conflict preserves draft", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-design-cli-"));
  const file = path.join(root, "draft.json"), ops = path.join(root, "ops.json"), html = path.join(root, "source.html");
  let remote = initial(), writes = 0, conflict = false, failRead = false, failLocal = false, localEdit = false;
  const output = [], client = { origin: "http://127.0.0.1:8125", bundle: async () => {
    if (failRead) throw Error("回读失败"); return structuredClone(remote);
  }, apply: async (_, payload, dryRun) => {
    if (conflict) throw Object.assign(Error("版本冲突"), { status: 409 });
    assert.equal(payload.expectedRevision, remote.workspace.revision);
    assert.equal(payload.expectedAnnotationsRevision, remote.annotations.revision);
    if (dryRun) return { dryRun: true };
    writes++;
    remote = { ...remote, workspace: { ...remote.workspace, pages: payload.pages, revision: remote.workspace.revision + 1 },
      annotations: { ...remote.annotations, notes: payload.notes, revision: remote.annotations.revision + 1 }, changed: { design: true, annotations: true } };
    if (failLocal) { fs.rmSync(file); fs.mkdirSync(file); }
    if (localEdit) { const newer = JSON.parse(fs.readFileSync(file, "utf8")); newer.draft.workspace.pages[0].name = "提交期间新增修改"; fs.writeFileSync(file, JSON.stringify(newer)); }
    return structuredClone(remote);
  } }, options = { output: v => output.push(v), clientFactory: () => client };
  try {
    await run(["pull", "--path", topic, "--out", file], options);
    await assert.rejects(run(["pull", "--path", topic, "--out", file], options), { code: "EEXIST" });
    await run(["elements", "--file", file, "--page", "main", "--match", "提交"], options);
    const button = output.at(-1).elements.find(e => e.tag === "button"); assert.ok(button);
    fs.writeFileSync(ops, JSON.stringify([
      { op: "element.text", pageId: "main", id: button.id, index: 0, expected: "提交 ", value: "确认 " },
      { op: "element.style", pageId: "main", id: button.id, property: "color", value: "#1677ff" },
    ]));
    await run(["patch", "--file", file, "--ops", ops], options);
    await run(["note", "--file", file, "--page", "main", "--element", button.id, "--id", "submit-note", "--text", "提交前检查必填字段"], options);
    await run(["html", "--file", file, "--page", "main", "--out", html], options);
    const exported = fs.readFileSync(html, "utf8");
    assert.ok(exported.includes('window.sample="提交"')); assert.ok(exported.includes(button.id)); assert.ok(exported.includes("确认 "));
    await run(["import", "--file", file, "--page", "main", "--html", html, "--name", "确认页面"], options);
    fs.writeFileSync(html, "<main><h1>完成</h1></main>");
    await run(["import", "--file", file, "--page", "done", "--html", html, "--name", "完成页", "--width", "390", "--height", "844"], options);
    await run(["check", "--file", file], options); assert.deepEqual(output.at(-1).errors, []);
    const before = fs.readFileSync(file, "utf8");
    await run(["apply", "--file", file, "--dry-run"], options); assert.equal(writes, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
    conflict = true; await assert.rejects(run(["apply", "--file", file], options), e => e.status === 409);
    assert.equal(fs.readFileSync(file, "utf8"), before); conflict = false;
    assert.equal(await run(["apply", "--file", file], options), 0); assert.equal(output.at(-1).verified, true); assert.equal(writes, 1);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.base.workspace.revision, 4); assert.equal(saved.draft.workspace.pages.length, 2);
    assert.deepEqual(model.diffBundle(saved).changed, { design: false, annotations: false });
    await assert.rejects(run(["apply", "--file", file, "--url", "http://localhost:9999"], options), /来源不同/);
    failRead = true; assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).saved, true); assert.equal(output.at(-1).verified, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).base.workspace.revision, 5);
    failRead = false; localEdit = true; assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).localBaselineUpdated, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).draft.workspace.pages[0].name, "提交期间新增修改");
    localEdit = false; fs.writeFileSync(file, JSON.stringify(model.createBundle(client.origin, topic, remote.workspace, remote.annotations, remote.context)));
    failLocal = true; assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).saved, true); assert.equal(output.at(-1).localBaselineUpdated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("flow login is shared with design HTTP export; HTML and ZIP preserve draft without saving", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-design-http-"));
  let validSession = false, saves = 0; const token = "b".repeat(64), remote = initial();
  const sendJson = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const exportHandler = createDesignExportHandler({ read: async () => ({ entry: { path: topic, feature: "设计 CLI" } }) }, { root, publicRoot: root, sendJson });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/auth/login") {
      let raw = ""; for await (const part of req) raw += part;
      const credentials = JSON.parse(raw); assert.equal(credentials.username, "tester"); assert.equal(credentials.password, "test-only");
      validSession = true; res.setHeader("Set-Cookie", `wb_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return sendJson(res, 200, { user: { id: "tester" } });
    }
    if (!validSession || req.headers.cookie !== "wb_session=" + token) return sendJson(res, 401, { error: "请先登录" });
    if (url.pathname === "/api/design/export") return exportHandler(req, res, url);
    if (req.method === "POST") saves++;
    sendJson(res, 200, remote);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, configDir = path.join(root, "session");
  const design = new DesignClient({ url: origin, configDir }), flow = new FlowClient({ url: origin, configDir });
  const options = { output: () => {}, clientFactory: () => design }, file = path.join(root, "draft.json");
  try {
    await assert.rejects(design.bundle(topic), e => e.status === 401);
    await flow.login("tester", "test-only"); assert.equal(flow.sessionFile, design.sessionFile);
    await run(["pull", "--path", topic, "--out", file], options);
    const html = path.join(root, "single.html");
    await run(["export", "--file", file, "--page", "main", "--format", "html", "--out", html], options);
    assert.ok(fs.readFileSync(html, "utf8").includes(`<base href="${origin}/">`));
    await assert.rejects(run(["export", "--file", file, "--page", "main", "--format", "html", "--out", html], options), /已存在/);
    const draft = JSON.parse(fs.readFileSync(file, "utf8")); draft.draft.workspace.pages.push({ ...draft.draft.workspace.pages[0], id: "copy" });
    fs.writeFileSync(file, JSON.stringify(draft)); const before = fs.readFileSync(file, "utf8"), zip = path.join(root, "boards.zip");
    await run(["export", "--file", file, "--all", "--format", "html", "--out", zip], options);
    const entries = unzipSync(fs.readFileSync(zip)); assert.equal(Object.keys(entries).length, 2);
    assert.ok(Object.values(entries).every(bytes => Buffer.from(bytes).toString().includes("<button")));
    assert.equal(saves, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
    await assert.rejects(run(["export", "--file", file, "--all", "--format", "html", "--out", path.join(root, "bad.html")], options), /\.zip/);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test("binary client rejects oversized and interrupted exports without saving or retrying", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-design-response-")); let calls = 0;
  try {
    const tooLarge = new DesignClient({ configDir: root, fetchImpl: async () => { calls++; return new Response("", { headers: { "content-length": String(65 * 1024 * 1024) } }); } });
    await assert.rejects(tooLarge.export(topic, {}), /超过 64 MB/); assert.equal(calls, 1);
    const disconnected = new DesignClient({ configDir: root, fetchImpl: async () => { calls++; throw Error("closed"); } });
    await assert.rejects(disconnected.export(topic, {}), /当前设计未修改/); assert.equal(calls, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
