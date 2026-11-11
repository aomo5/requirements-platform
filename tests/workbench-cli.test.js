"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { run } = require("../scripts/workbench"), { WorkbenchClient } = require("../lib/workbench-cli-client");
const { createDocumentHandler } = require("../lib/document-handler");
const { prepareMarkdown } = require("../lib/stable-identities");

test("LAN config persists across clients and separates per-origin sessions without following redirects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-team-config-"));
  const oldEnv = process.env.WORKBENCH_URL; delete process.env.WORKBENCH_URL;
  try {
    const c = new WorkbenchClient({ url: "http://192.168.1.18:8125", configDir: root }); c.configure();
    const reopened = new WorkbenchClient({ configDir: root }); assert.equal(reopened.origin, c.origin); assert.equal(reopened.sessionFile, c.sessionFile);
    const other = new WorkbenchClient({ url: "http://192.168.1.19:8125", configDir: root }); assert.notEqual(other.sessionFile, c.sessionFile);
    let seen;
    const remote = new WorkbenchClient({ configDir: root, fetchImpl: async (url, options) => { seen = { url, options }; return new Response('{"user":null}'); } });
    await remote.whoami(); assert.equal(seen.url, c.origin + "/api/auth/session"); assert.equal(seen.options.headers.Origin, c.origin); assert.equal(seen.options.redirect, "error");
    assert.equal(fs.statSync(c.settingsFile).mode & 0o777, 0o600);
  } finally { if (oldEnv === undefined) delete process.env.WORKBENCH_URL; else process.env.WORKBENCH_URL = oldEnv; fs.rmSync(root, { recursive: true, force: true }); }
});

test("document CLI preserves versions and edits, supports interface files, dry-run, conflicts and acknowledged saves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-doc-cli-")), file = path.join(root, "draft.json"), md = path.join(root, "edit.md");
  let remote = { revision: 2, content: "# 原契约", editorContent: "# 原契约", canEdit: true }, writes = 0, conflict = false, localEdit = false, failRead = false;
  const calls = [], output = [], client = { origin: "http://192.168.1.18:8125", request: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method) {
      if (conflict || options.body.expectedRevision !== remote.revision) throw Object.assign(Error("版本冲突"), { status: 409 });
      if (url.includes("/check")) return { valid: true, dryRun: true };
      remote = { ...remote, content: options.body.content, editorContent: options.body.content, revision: remote.revision + 1 }; writes++;
      if (localEdit) { const next = JSON.parse(fs.readFileSync(file)); next.draft.content += "\n请求期间补充"; fs.writeFileSync(file, JSON.stringify(next)); }
      return structuredClone(remote);
    }
    if (failRead) throw Error("读取中断"); return structuredClone(remote);
  } }, options = { output: x => output.push(x), clientFactory: () => client };
  try {
    await run(["interface", "pull", "--path", "20-测试/订单", "--out", file], options);
    assert.equal(new URL("http://local" + calls[0].url).searchParams.get("file"), "20-测试/订单/接口契约.md");
    fs.writeFileSync(md, "# 新契约\n\n字段1"); await run(["interface", "import", "--file", file, "--content", md], options);
    const before = fs.readFileSync(file, "utf8");
    await run(["interface", "apply", "--file", file, "--dry-run"], options); assert.equal(writes, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
    conflict = true; await assert.rejects(run(["interface", "apply", "--file", file], options), e => e.status === 409); assert.equal(fs.readFileSync(file, "utf8"), before); conflict = false;
    assert.equal(await run(["interface", "apply", "--file", file], options), 0); assert.equal(output.at(-1).verified, true);
    assert.equal(JSON.parse(fs.readFileSync(file)).base.revision, 3);
    localEdit = true; assert.equal(await run(["interface", "apply", "--file", file], options), 2); assert.equal(output.at(-1).localBaselineUpdated, false); assert.ok(fs.readFileSync(file, "utf8").includes("请求期间补充"));
    localEdit = false; await run(["interface", "pull", "--path", "20-测试/订单", "--out", path.join(root, "next.json")], options);
    failRead = true; assert.equal(await run(["interface", "apply", "--file", path.join(root, "next.json")], options), 2); assert.equal(output.at(-1).saved, true);
    await assert.rejects(run(["interface", "apply", "--file", file, "--url", "http://different.local"], options), /来源不同/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("test commands submit one controlled run, read results and reject command/environment injection", async () => {
  const calls = [], outputs = [], root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-cli-"));
  const options = { output: x => outputs.push(x), clientFactory: () => ({ request: async (url, options) => { calls.push({ url, options }); return options ? { run: { id: "run-1", status: "queued" } } : { runs: [{ id: "run-1", status: "passed" }], environments: [{ id: "test" }] }; } }) };
  try {
    await run(["test", "run", "--path", "20-测试/订单", "--link", "link-1", "--environment", "test"], options);
    assert.deepEqual(calls[0].options.body, { linkId: "link-1", environmentId: "test" }); assert.equal(calls.length, 1);
    await run(["test", "result", "--path", "20-测试/订单", "--id", "run-1"], options); assert.equal(outputs.at(-1).status, "passed");
    const input = path.join(root, "input.json"); fs.writeFileSync(input, JSON.stringify({ expectedRevision: 1, command: "shell", environment: { arbitrary: "value" } }));
    await assert.rejects(run(["test", "link", "--path", "20-测试/订单", "--input", input], options), /未知字段/);
    assert.equal(calls.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("document check uses the same origin and owner guards and always rolls back its preview", async () => {
  let rolledBack = 0, writes = 0;
  const db = { find: () => {}, validateDocumentFile: (_p, f) => f,
    transaction: async fn => { try { return await fn({}); } catch (e) { rolledBack++; throw e; } },
    putSupportingDocument: async () => { writes++; return { content: "preview", revision: 2 }; } };
  const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const handler = createDocumentHandler(db, send);
  const server = http.createServer((req, res) => { req.accountAccess = { canEdit: req.headers["x-test-owner"] === "yes" }; handler(req, res, new URL(req.url, "http://localhost")); });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); const origin = "http://127.0.0.1:" + server.address().port;
  const request = (extra = {}) => fetch(origin + "/api/document/check?path=topic&file=topic/接口契约.md", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Design-Client": "workbench-v1", "X-Test-Owner": "yes", ...extra }, body: JSON.stringify({ expectedRevision: 1, content: "preview" }) });
  try {
    assert.equal((await request({ "X-Test-Owner": "no" })).status, 403); assert.equal(writes, 0);
    assert.equal((await request({ Origin: "http://evil.invalid" })).status, 403); assert.equal(writes, 0);
    const response = await request(); assert.equal(response.status, 200); assert.equal((await response.json()).dryRun, true); assert.equal(rolledBack, 1); assert.equal(writes, 1);
  } finally { await new Promise(r => server.close(r)); }
});

test("MySQL document preview preserves history, rule identities and both document kinds", { skip: process.env.WORKBENCH_TEAM_CLI_DB_TEST !== "1" }, async () => {
  const { fixture } = require("./document-fixture"), f = await fixture();
  try {
    const { db, p } = f, initial = await db.saveDocument(p, 0, "# 标题\n\n原规则。\n");
    const handler = createDocumentHandler(db, (res, status, body) => { res.status = status; res.body = body; });
    async function preview(file, revision, content) {
      const { Readable } = require("node:stream"), req = Readable.from([Buffer.from(JSON.stringify({ expectedRevision: revision, content, editor: true }))]);
      req.method = "POST"; req.headers = { origin: "http://localhost:8125", host: "localhost:8125", "content-type": "application/json", "x-design-client": "workbench-v1" }; req.accountAccess = { canEdit: true };
      const res = {}; await handler(req, res, new URL("http://localhost/api/document/check?" + new URLSearchParams({ path: p, file }))); return res;
    }
    const history = await db.documentVersions(p), rules = initial.rules.map(r => r.blockId);
    assert.equal((await preview(p + "/需求文档.md", initial.revision, "# 标题\n\n新规则。\n")).status, 200);
    assert.deepEqual(await db.documentVersions(p), history); assert.equal((await db.document(p)).content, initial.content);
    assert.equal((await preview(p + "/需求文档.md", initial.revision - 1, "覆盖")).status, 409);
    const saved = await db.saveDocumentFile(p, p + "/需求文档.md", initial.revision, "# 标题\n\n新规则。\n", { editor: true });
    assert.deepEqual(saved.rules.map(r => r.blockId), rules);
    assert.equal((await preview(p + "/接口契约.md", 0, "# 接口")).status, 200);
    assert.equal(await db.readDocumentFile(p, p + "/接口契约.md"), null);
    assert.equal((await db.fileVersions(p, p + "/接口契约.md")).length, 0);
    const contract = await db.saveDocumentFile(p, p + "/接口契约.md", 0, "# 接口"); assert.equal(contract.revision, 1);
  } finally { await f.close(); }
});
