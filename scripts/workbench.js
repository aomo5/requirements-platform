#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { WorkbenchClient, CliError, localOrigin } = require("../lib/workbench-cli-client");
const { parseArgs, required, readJson, writeFile } = require("../lib/workbench-cli-files");
const model = require("../lib/document-edit-model");
const HELP = `需求平台 CLI
workbench config --url http://局域网服务器:8125
workbench login | whoami | logout
workbench list
workbench flow <命令> | design <命令>       运行对应 help 查看
workbench requirement|interface|spec|task|page <命令>
  pull --path 主题 --out 草稿.json         page 还需 --document 页面设计/页面名.md
  import --file 草稿.json --content 正文.md
  show|check|diff --file 草稿.json
  export --file 草稿.json --out 正文.md
  apply --file 草稿.json [--dry-run]
  versions --path 主题 [--document 逻辑文件]
  version --path 主题 --revision 版本 --out 正文.md
workbench requirement create --module 模块 --name 名称 --content 原始需求.md
workbench test list|environments|runs --path 主题
workbench test result --path 主题 --id 执行ID
workbench test link|unlink --path 主题 --input 参数.json
workbench test run --path 主题 --link ID --environment ID
全局 --url 指定服务；配置、登录供全部命令共用。测试 run 只提交一次，result 查询结果。
`;
const FILES = { requirement: "需求文档.md", interface: "接口契约.md", spec: "规格索引.md", task: "任务拆分.md" };
const SCHEMA = { flags: ["help", "dry-run"], keys: ["url", "path", "out", "file", "content", "document", "revision", "module", "name", "input", "id", "link", "environment"] };
function query(p, file) { return new URLSearchParams({ path: p, ...(file ? { file } : {}) }); }
function documentFile(area, o) {
  const p = required(o, "path"), relative = o.document || FILES[area];
  if (!relative) throw new CliError("page 命令需要 --document 页面设计/页面名.md");
  if (relative.startsWith(p + "/")) return relative;
  return p + "/" + relative;
}
function text(file) {
  const value = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new CliError("正文最多 2 MB", 422);
  return value;
}
const emit = value => process.stdout.write(typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n");
async function run(argv, { output = emit, clientFactory = o => new WorkbenchClient(o) } = {}) {
  const args = [...argv], area = args.shift() || "help";
  if (["help", "--help"].includes(area)) { output(HELP); return 0; }
  if (["flow", "design"].includes(area)) return require(area === "flow" ? "./flows" : "./designs").run(args, { output, clientFactory: undefined });
  if (["login", "whoami", "logout"].includes(area)) return require("./flows").run([area, ...args], { output });
  const parsed = parseArgs([...( ["config", "list"].includes(area) ? [area] : []), ...args], SCHEMA);
  const command = parsed.command, o = parsed.options;
  if (o.help || ["help", "--help"].includes(command)) { output(HELP); return 0; }
  const client = ["config", "list", "test"].includes(area) || ["pull", "versions", "version", "create"].includes(command)
    ? clientFactory({ url: o.url }) : null;
  if (area === "config") { required(o, "url"); output(client.configure()); return 0; }
  if (area === "list") { output(await client.request("/api/tree")); return 0; }
  if (area === "test") {
    const p = required(o, "path"), suffix = "?" + query(p);
    if (["list", "environments", "runs", "result"].includes(command)) {
      const data = await client.request("/api/tests" + suffix);
      if (command === "result") {
        const found = data.runs.find(r => r.id === required(o, "id"));
        if (!found) throw new CliError("执行记录不在最近 50 条中，请核对需求和执行 ID", 404);
        output(found);
      } else output(command === "list" ? data : data[command]);
      return 0;
    }
    if (!["link", "unlink", "run"].includes(command)) throw new CliError("未知测试命令");
    const body = command === "run" ? { linkId: required(o, "link"), environmentId: required(o, "environment") } : readJson(required(o, "input"));
    const allowed = command === "link" ? ["expectedRevision", "type", "projectId", "branchId", "resourceId", "ruleIds"] : command === "unlink" ? ["expectedRevision", "linkId"] : ["linkId", "environmentId"];
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw new CliError("测试参数含未知字段");
    output(await client.request("/api/tests/" + ({ link: "links", unlink: "unlink", run: "runs" })[command] + suffix, { method: "POST", body }));
    return 0;
  }
  if (!Object.hasOwn(FILES, area) && area !== "page") throw new CliError("未知板块：" + area);
  if (command === "create" && area === "requirement") {
    output(await client.request("/api/entries", { method: "POST", body: { module: required(o, "module"), name: required(o, "name"), content: text(required(o, "content")) } })); return 0;
  }
  if (["pull", "versions", "version"].includes(command)) {
    const p = required(o, "path"), file = documentFile(area, o), suffix = "?" + query(p, file);
    if (command === "versions") { output(await client.request("/api/document/versions" + suffix)); return 0; }
    if (command === "version") {
      const revision = Number(required(o, "revision"));
      if (!Number.isInteger(revision) || revision < 1) throw new CliError("版本号无效");
      const data = await client.request("/api/document/version" + suffix + "&revision=" + revision);
      writeFile(required(o, "out"), data.editorContent ?? data.content, { exclusive: true, json: false });
      output({ file: path.resolve(o.out), revision }); return 0;
    }
    const data = await client.request("/api/document" + suffix), out = required(o, "out");
    writeFile(out, model.bundle(client.origin, p, file, data), { exclusive: true });
    output({ file: path.resolve(out), revision: data.revision, canEdit: data.canEdit }); return 0;
  }
  if (!["show", "check", "diff", "export", "import", "apply"].includes(command)) throw new CliError("未知文档命令：" + command);
  const file = required(o, "file"), { value: b, source } = readJson(file, { withSource: true }); model.validate(b);
  if (command === "import") {
    b.draft.content = text(required(o, "content")); model.validate(b);
    writeFile(file, b, { expectedContent: source }); output(model.diff(b)); return 0;
  }
  if (command === "show") { output(b.draft.content); return 0; }
  if (command === "check") { output({ valid: true, bytes: Buffer.byteLength(b.draft.content), revision: b.base.revision }); return 0; }
  if (command === "diff") { output(model.diff(b)); return 0; }
  if (command === "export") { writeFile(required(o, "out"), b.draft.content, { exclusive: true, json: false }); output({ file: path.resolve(o.out) }); return 0; }
  if (o.url && localOrigin(o.url) !== b.origin) throw new CliError("--url 与草稿来源不同，请重新 pull");
  const target = clientFactory({ url: b.origin }), suffix = "?" + query(b.entryPath, b.documentFile);
  const result = await target.request("/api/document" + (o["dry-run"] ? "/check" : "") + suffix,
    { method: o["dry-run"] ? "POST" : "PUT", body: { expectedRevision: b.base.revision, content: b.draft.content, editor: true } });
  if (o["dry-run"]) { output({ dryRun: true, valid: result.valid, diff: model.diff(b) }); return 0; }
  try { writeFile(file, model.bundle(b.origin, b.entryPath, b.documentFile, result), { expectedContent: source }); }
  catch { output({ saved: true, verified: false, localBaselineUpdated: false, revision: result.revision, message: "本地草稿未更新，已保留后续修改；请重新 pull 到新文件比对，不要重放旧草稿" }); return 2; }
  try {
    const readback = await target.request("/api/document" + suffix);
    const verified = readback.revision === result.revision && readback.content === result.content;
    output({ saved: true, verified, revision: result.revision, documentFile: b.documentFile }); return verified ? 0 : 2;
  } catch { output({ saved: true, verified: false, revision: result.revision, message: "服务确认保存，回读失败；本地基线已更新，请先回读核对" }); return 2; }
}
if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => {
  process.stderr.write(JSON.stringify({ error: e.message, ...(e.status ? { status: e.status } : {}) }) + "\n");
  process.exitCode = e.status === 409 ? 3 : [401, 403].includes(e.status) ? 4 : e.status === 422 ? 2 : 1;
});
module.exports = { run };
