"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createEntryService, createEntryHandler } = require("../lib/entry-create");
const { scanRequirements, findEntryByPath } = require("../lib/scan");

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-entry-create-"));
  fs.mkdirSync(path.join(root, "20-收费管理"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, create: createEntryService(root, options) };
}
const input = { module: "20-收费管理", name: "新增设备收费", content: "设备费由对应站点的账户承担。\n\n充值与扣费分别记录。" };

test("creates a readable draft and registers it without fabricating reviewed specs", async t => {
  let registered;
  const f = fixture(t, { register: async entry => { registered = entry; } });
  const entry = await f.create(input);
  assert.equal(entry.path, "20-收费管理/新增设备收费");
  assert.equal(registered.path, entry.path);
  assert.equal(findEntryByPath(scanRequirements(f.root), entry.path).path, entry.path);
  const requirement = fs.readFileSync(path.join(f.root, entry.docs.requirement), "utf8");
  assert.ok(requirement.endsWith(input.content + "\n"));
  assert.match(fs.readFileSync(path.join(f.root, entry.docs.spec), "utf8"), /需求草稿/);
  assert.equal(entry.gitee.state, "unlinked");
  assert.ok(fs.statSync(path.join(f.root, entry.path, "页面设计")).isDirectory());
  assert.ok(fs.statSync(path.join(f.root, entry.path, "原型设计")).isDirectory());
});

test("duplicate and simultaneous creates cannot overwrite an existing requirement", async t => {
  let count = 0;
  const f = fixture(t, { register: async () => { count++; await new Promise(resolve => setTimeout(resolve, 20)); } });
  const results = await Promise.allSettled([f.create(input), f.create({ ...input, content: "不能覆盖" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  assert.equal(count, 1);
  assert.ok(fs.readFileSync(path.join(f.root, input.module, input.name, "需求文档.md"), "utf8").includes(input.content));
});

test("rejects traversal, unknown modules, symlinks, empty content, and invalid names", async t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, "20-收费管理"), path.join(f.root, "30-链接"));
  const invalid = [null, [], { module: "../20-收费管理" }, { module: "99-不存在" }, { module: "30-链接" },
    { name: "../覆盖" }, { name: "流程设计" }, { name: "隐藏." }, { name: ".隐藏" }, { name: "" },
    { name: "a".repeat(81) }, { content: " " }, { content: "a".repeat(12001) }];
  for (const value of invalid) await assert.rejects(f.create(value === null || Array.isArray(value) ? value : { ...input, ...value }), { status: 400 });
  assert.deepEqual(fs.readdirSync(path.join(f.root, input.module)), []);
});

test("failed database registration removes only this attempt's unchanged files and allows retry", async t => {
  const f = fixture(t, { register: async () => { throw new Error("database unavailable"); } });
  await assert.rejects(f.create(input), /database unavailable/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, input.module)), []);
  assert.equal((await createEntryService(f.root)(input)).path, `${input.module}/${input.name}`);
});

test("HTTP creation enforces write access, origin, method and JSON validation", async t => {
  const f = fixture(t);
  const handler = createEntryHandler(f.create, (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, "X-Design-Client": "workbench-v1", "Content-Type": "application/json" };
  const post = (body, changes = {}) => fetch(base, { method: "POST", headers: { ...headers, ...changes }, body });
  assert.equal((await fetch(base)).status, 405);
  assert.equal((await post(JSON.stringify(input), { Origin: "https://external.test" })).status, 403);
  const remoteStatus = await new Promise((resolve, reject) => {
    const req = http.request(base, { method: "POST", headers: { ...headers, Host: "remote.test" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end(JSON.stringify(input));
  });
  assert.equal(remoteStatus, 403);
  assert.equal((await post(JSON.stringify(input), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(" ".repeat(65537))).status, 413);
  const result = await post(JSON.stringify(input));
  assert.equal(result.status, 201);
  assert.equal((await result.json()).entry.path, `${input.module}/${input.name}`);
  assert.equal((await post(JSON.stringify(input))).status, 409);
});
