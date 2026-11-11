"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { FlowClient, localOrigin } = require("../lib/flow-cli-client");

async function service() {
  const calls = [], sessions = new Map();
  const token = "a".repeat(64);
  let failRead = false;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, body });
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.origin !== `http://${req.headers.host}` || req.headers["x-design-client"] !== "workbench-v1") return send(403, { error: "同源标识错误" });
    if (req.url === "/api/auth/login") {
      if (body.username !== "owner" || body.password !== "local-test-password") return send(401, { error: "账号或密码不正确" });
      sessions.set(token, true); res.setHeader("Set-Cookie", `wb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
      return send(200, { user: { id: "owner", username: "owner" } });
    }
    if (!sessions.has((req.headers.cookie || "").replace("wb_session=", ""))) return send(401, { error: "请先登录" });
    if (req.url === "/api/auth/logout") { sessions.clear(); return send(200, { ok: true }); }
    if (req.url === "/api/auth/session") return send(200, { user: { id: "owner" }, enabled: true });
    if (req.url.includes("forbidden")) return send(403, { error: "只有需求创建者可以修改此需求" });
    if (failRead && req.method === "GET") return send(503, { error: "暂不可读" });
    if (req.method === "POST") {
      if (body.expectedRevision !== 1) return send(409, { error: "版本冲突" });
      return send(200, { acknowledged: true });
    }
    return send(200, { available: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-flow-cli-"));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, origin, calls, sessions, client: new FlowClient({ url: origin, configDir: root }),
    async close() { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("HTTP CLI authenticates once, uses private same-origin session, retains 401/403/409 and never retries writes", async () => {
  const f = await service();
  try {
    await assert.rejects(f.client.bundle("20-测试/图"), e => e.status === 401);
    const login = await f.client.login("owner", "local-test-password");
    assert.equal(login.user.id, "owner"); assert.ok(!JSON.stringify(login).includes("a".repeat(64)));
    assert.equal(fs.statSync(f.client.sessionFile).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(f.client.sessionFile, "utf8").includes("local-test-password"));
    const reopened = new FlowClient({ url: f.origin, configDir: f.root });
    assert.equal((await reopened.bundle("20-测试/图")).available, true);
    await assert.rejects(reopened.apply("forbidden", { expectedRevision: 1 }), e => e.status === 403);
    await assert.rejects(reopened.apply("20-测试/图", { expectedRevision: 0 }), e => e.status === 409);
    assert.equal(f.calls.filter(c => c.method === "POST" && c.body?.expectedRevision === 0).length, 1);
    await reopened.logout(); assert.equal(fs.existsSync(f.client.sessionFile), false);
    await assert.rejects(reopened.bundle("20-测试/图"), e => e.status === 401);
  } finally { await f.close(); }
});

test("CLI accepts configured LAN origins and refuses credentials, permissive sessions, symlinks and redirects", async () => {
  assert.equal(localOrigin("http://192.168.1.10:8125"), "http://192.168.1.10:8125");
  assert.equal(localOrigin("http://workbench.local:8125"), "http://workbench.local:8125");
  for (const origin of ["ftp://example.com", "http://user:pass@localhost:8125", "http://localhost:8125/path", "http://127.0.0.1:8125/?x=1"]) assert.throws(() => localOrigin(origin));
  const f = await service();
  try {
    await f.client.login("owner", "local-test-password");
    fs.chmodSync(f.client.sessionFile, 0o644); assert.throws(() => f.client.session());
    fs.chmodSync(f.client.sessionFile, 0o600);
    const target = f.client.sessionFile + ".saved"; fs.renameSync(f.client.sessionFile, target); fs.symlinkSync(target, f.client.sessionFile);
    assert.throws(() => f.client.session());
    let seen;
    const client = new FlowClient({ url: f.origin, configDir: path.join(f.root, "empty"), fetchImpl: async (_, options) => { seen = options; throw new Error("redirect"); } });
    await assert.rejects(client.apply("20-测试/图", {}), /不要自动重试/);
    assert.equal(seen.redirect, "error");
    const brokenResponse = new FlowClient({ url: f.origin, configDir: path.join(f.root, "empty"), fetchImpl: async () => new Response("{", { status: 200 }) });
    await assert.rejects(brokenResponse.apply("20-测试/图", {}), /保存状态不确定.*不要自动重试/);
  } finally { await f.close(); }
});

test("draft workflow pulls, patches by ID, dry-runs, commits and verifies; conflicts preserve draft", async () => {
  const { run } = require("../scripts/flows");
  const model = require("../lib/flow-edit-model");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-flow-cli-run-"));
  const file = path.join(root, "draft.json"), ops = path.join(root, "ops.json");
  const workspace = { schemaVersion: 1, revision: 3, updatedAt: "2026-11-03T01:00:00Z", applicability: "needed", reason: "",
    references: [], flows: [{ id: "main", name: "主图", description: "", parent: null,
      nodes: [{ id: "a", type: "step", label: "原节点", x: 10, y: 20, pageId: "" }], edges: [] }] };
  const annotations = { schemaVersion: 1, revision: 2, updatedAt: "2026-11-03T01:00:00Z", notes: [] };
  let remote = { workspace, annotations, canEdit: true }, writes = 0, rejectConflict = false, failRead = false, failLocalAfterSave = false, localEdit = false;
  const client = { origin: "http://127.0.0.1:8125", bundle: async () => { if (failRead) throw new Error("回读失败"); return structuredClone(remote); },
    apply: async (_, payload, dryRun) => {
      if (rejectConflict) throw Object.assign(new Error("版本冲突"), { status: 409 });
      assert.equal(payload.expectedRevision, remote.workspace.revision);
      if (dryRun) return { valid: true };
      writes++;
      remote = { workspace: { ...remote.workspace, ...payload.workspace, revision: remote.workspace.revision + 1 },
        annotations: { ...remote.annotations, notes: payload.notes }, changed: { flows: true, annotations: false } };
      if (failLocalAfterSave) { fs.rmSync(file); fs.mkdirSync(file); }
      if (localEdit) { const newer = JSON.parse(fs.readFileSync(file, "utf8")); newer.draft.workspace.flows[0].name = "提交期间新增修改"; fs.writeFileSync(file, JSON.stringify(newer)); }
      return structuredClone(remote);
    } };
  const output = [], options = { output: value => output.push(value), clientFactory: () => client };
  const contract = { inputs: [{ id: "task-id", name: "id", type: "Long", required: "required", source: "原通知" }], outputs: [] };
  try {
    assert.equal(await run(["pull", "--path", "20-测试/图", "--out", file], options), 0);
    fs.writeFileSync(ops, JSON.stringify([{ op: "node.update", flowId: "main", id: "a", set: { label: "已修改", x: 50, contract } }]));
    await run(["patch", "--file", file, "--ops", ops], options);
    await run(["show", "--file", file, "--flow", "main", "--node", "a"], options);
    assert.deepEqual(output.at(-1).node.contract, contract);
    const before = fs.readFileSync(file, "utf8");
    await run(["apply", "--file", file, "--dry-run"], options); assert.equal(writes, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
    rejectConflict = true; await assert.rejects(run(["apply", "--file", file], options), e => e.status === 409);
    assert.equal(fs.readFileSync(file, "utf8"), before); rejectConflict = false;
    assert.equal(await run(["apply", "--file", file], options), 0);
    assert.equal(output.at(-1).verified, true); assert.equal(writes, 1);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.base.workspace.revision, 4); assert.equal(saved.draft.workspace.flows[0].nodes[0].label, "已修改");
    assert.deepEqual(saved.draft.workspace.flows[0].nodes[0].contract, contract);
    assert.equal(model.diffBundle(saved).changed.flows, false);
    await assert.rejects(run(["apply", "--file", file, "--url", "http://localhost:9999"], options), /来源不同/);
    failRead = true;
    assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).saved, true); assert.equal(output.at(-1).verified, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).base.workspace.revision, 5);
    failRead = false; localEdit = true;
    assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).localBaselineUpdated, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).draft.workspace.flows[0].name, "提交期间新增修改");
    localEdit = false; fs.writeFileSync(file, JSON.stringify(model.createBundle(client.origin, "20-测试/图", remote.workspace, remote.annotations)));
    failLocalAfterSave = true;
    assert.equal(await run(["apply", "--file", file], options), 2);
    assert.equal(output.at(-1).saved, true); assert.equal(output.at(-1).localBaselineUpdated, false);
    assert.equal(output.at(-1).revision, 7);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
