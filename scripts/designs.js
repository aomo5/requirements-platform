#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DesignClient, CliError, localOrigin } = require("../lib/design-cli-client");
const { parseArgs, required, readJson, writeFile, promptLine } = require("../lib/workbench-cli-files");
const model = require("../lib/design-edit-model");
const HELP = `设计工作台 CLI（与 flow CLI 共用登录）

node scripts/designs.js <命令> [参数]       或 npm run design -- <命令>
  login [--username 账号] [--password-stdin] | whoami | logout
  list --path 主题路径
  pull --path 主题路径 --out 草稿.json
  show --file 草稿.json [--page ID] [--element ID]
  elements --file 草稿.json --page ID [--match 文字]
  html --file 草稿.json --page ID --out 页面.html
  import --file 草稿.json --page ID --html 页面.html [--name 名称]
         [--width 1440 --height 900 --x 0 --y 0 --source 主题/原型设计/页面.html]
         [--route '#状态' --platform Web --group 分组]
  patch --file 草稿.json --ops 操作.json
  note --file 草稿.json --page ID --element ID --id 说明ID --text-file 说明.txt
  check --file 草稿.json | diff --file 草稿.json
  apply --file 草稿.json [--dry-run]
  export --file 草稿.json --page ID[,ID] --format png|jpg|pdf|html --out 文件
         [--scale 1|2|3] [--transparent]    多画板输出 ZIP；--all 选择全部
  versions --path 主题路径 [--kind design|annotations]
  rules --path 主题路径                    读取可关联的当前需求规则
  link --path 主题路径 [--page ID]

全局：--url 工作台根地址（默认 http://127.0.0.1:8125，也支持局域网）。草稿固定来源，不能改投实例。
import 更新已有页；新增页须给 --name，默认 1440×900。HTML 是画板副本，不自动写回 source。
patch/import/note 可加 --out 新草稿.json；--ops - 从 stdin 读 JSON 数组。
check 不等于视觉与交互验收。退出码：0 成功、1 参数/连接、2 校验、3 冲突、4 未登录/无权限。
`;
const SCHEMA = {
  flags: ["help", "dry-run", "password-stdin", "transparent", "all"],
  keys: ["url", "username", "path", "out", "file", "page", "element", "match", "html", "name", "width", "height", "x", "y", "source", "route", "platform", "group", "ops", "id", "text-file", "text", "kind", "format", "scale"],
};
const emit = value => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
function link(origin, entryPath, pageId) { return origin + "/#" + new URLSearchParams({ path: entryPath, view: "design", ...(pageId ? { page: pageId } : {}) }); }
function pageOf(bundle, options) {
  const id = required(options, "page"), page = bundle.draft.workspace.pages.find(p => p.id === id);
  if (!page) throw new CliError("画板不存在：" + id);
  return page;
}
function assertCheck(check) { if (check.errors.length) throw new CliError("设计草稿校验未通过，未提交", 422, check); }
function readText(file, limit = 600000) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { throw new CliError("无法读取文件：" + file); }
  if (text.length > limit) throw new CliError(`文件内容最多 ${limit} 字符`);
  return text;
}
function writeDraft(file, next, options, output) {
  const out = options.out || file;
  writeFile(out, next, { exclusive: path.resolve(out) !== path.resolve(file) });
  output({ file: path.resolve(out), ...model.diffBundle(next), check: model.checkBundle(next) });
}

async function run(argv, { output = emit, clientFactory = options => new DesignClient(options) } = {}) {
  const { command, options } = parseArgs([...argv], SCHEMA);
  if (command === "help" || options.help) { output(HELP); return 0; }
  if (!["login", "whoami", "logout", "list", "pull", "show", "elements", "html", "import", "patch", "note", "check", "diff", "apply", "export", "versions", "rules", "link"].includes(command)) throw new CliError("未知命令：" + command);
  if (["login", "whoami", "logout"].includes(command)) {
    const client = clientFactory({ url: options.url });
    if (command === "login") {
      const username = options.username || await promptLine("工作台账号：");
      const password = options["password-stdin"] ? fs.readFileSync(0, "utf8").replace(/\r?\n$/, "") : await promptLine("密码（不回显）：", true);
      output(await client.login(username, password));
    } else output(await client[command]());
    return 0;
  }
  if (["list", "pull", "versions", "rules", "link"].includes(command)) {
    const entryPath = required(options, "path"), client = clientFactory({ url: options.url });
    if (command === "link") { output(link(client.origin, entryPath, options.page) + "\n"); return 0; }
    if (command === "rules") { output(await client.request("/api/requirement-rules?" + new URLSearchParams({ path: entryPath }))); return 0; }
    if (command === "versions") {
      const kind = options.kind || "design";
      if (!["design", "annotations"].includes(kind)) throw new CliError("--kind 只接受 design 或 annotations");
      output(await client.request(`/api/${kind}/versions?` + new URLSearchParams({ path: entryPath }))); return 0;
    }
    const data = await client.bundle(entryPath);
    if (command === "list") output({ entryPath, revision: data.workspace.revision, annotationsRevision: data.annotations.revision, canEdit: data.canEdit,
      pages: data.workspace.pages.map(({ html, ...p }) => ({ ...p, htmlLength: html.length, url: link(client.origin, entryPath, p.id) })) });
    else {
      const file = required(options, "out");
      writeFile(file, model.createBundle(client.origin, entryPath, data.workspace, data.annotations, data.context), { exclusive: true });
      output({ file: path.resolve(file), revision: data.workspace.revision, annotationsRevision: data.annotations.revision, canEdit: data.canEdit });
    }
    return 0;
  }
  const file = required(options, "file"), { value: bundle, source: original } = readJson(file, { withSource: true }), check = model.checkBundle(bundle);
  if (command === "check") { output(check); return check.errors.length ? 2 : 0; }
  if (command === "patch") { writeDraft(file, model.applyOperations(bundle, readJson(required(options, "ops"))), options, output); return 0; }
  if (command === "import") {
    const id = required(options, "page"), html = readText(required(options, "html"));
    const old = bundle.draft.workspace.pages.find(p => p.id === id), fields = { html };
    for (const key of ["name", "source", "route", "platform", "group"]) if (Object.hasOwn(options, key)) fields[key] = options[key];
    for (const key of ["width", "height", "x", "y"]) if (Object.hasOwn(options, key)) {
      if (!Number.isFinite(Number(options[key]))) throw new CliError(`--${key} 必须为数字`);
      fields[key] = Number(options[key]);
    }
    const operation = old ? { op: "page.update", id, set: fields }
      : { op: "page.add", id, value: { name: required(options, "name"), width: 1440, height: 900, x: 0, y: 0, source: "", route: "", ...fields } };
    writeDraft(file, model.applyOperations(bundle, [operation]), options, output); return 0;
  }
  if (command === "note") {
    const page = pageOf(bundle, options), id = required(options, "id"), elementId = required(options, "element");
    if (!!options["text-file"] === Object.hasOwn(options, "text")) throw new CliError("请在 --text-file 和 --text 中选择一个");
    const text = options["text-file"] ? readText(options["text-file"], 8000) : options.text;
    const previous = bundle.draft.annotations.notes.find(n => n.id === id);
    if (previous && previous.target.type !== "page-element") throw new CliError("设计 CLI 不能修改流程说明");
    const value = model.createPageNote(page, elementId, { id, text, requirements: previous?.requirements || [] });
    const { id: ignored, ...set } = value;
    const operation = previous ? { op: "note.update", id, set } : { op: "note.add", id, value };
    writeDraft(file, model.applyOperations(bundle, [operation]), options, output); return 0;
  }
  assertCheck(check);
  if (command === "diff") { output(model.diffBundle(bundle)); return 0; }
  if (command === "html") {
    writeFile(required(options, "out"), pageOf(bundle, options).html, { exclusive: true, json: false });
    output({ file: path.resolve(options.out), message: "已导出保留元素 ID 的画板 HTML；修改后用 import 明确更新画板" }); return 0;
  }
  if (command === "elements") {
    let elements = model.listElements(pageOf(bundle, options).html);
    if (options.match) elements = elements.filter(e => JSON.stringify(e).toLowerCase().includes(options.match.toLowerCase()));
    output({ pageId: options.page, elements }); return 0;
  }
  if (command === "show") {
    if (options.element && !options.page) throw new CliError("--element 需要同时指定 --page");
    if (!options.page) { output(bundle.draft); return 0; }
    const page = pageOf(bundle, options), { html, ...info } = page;
    const notes = bundle.draft.annotations.notes.filter(n => n.target.type === "page-element" && n.target.pageId === page.id);
    if (options.element) {
      const element = model.listElements(html).find(e => e.id === options.element);
      if (!element) throw new CliError("元素 ID 不存在，或属于无法静态修改的动态元素");
      output({ page: info, element, notes: notes.filter(n => n.target.anchor.elementId === element.id), url: link(bundle.origin, bundle.entryPath, page.id) });
    } else output({ page: info, htmlLength: html.length, notes, url: link(bundle.origin, bundle.entryPath, page.id) });
    return 0;
  }
  if (options.url && localOrigin(options.url) !== bundle.origin) throw new CliError("--url 与草稿来源不同；请从目标实例重新 pull");
  const client = clientFactory({ url: bundle.origin });
  if (command === "export") {
    if (Boolean(options.page) === Boolean(options.all)) throw new CliError("用 --page 指定画板，或用 --all 选择全部");
    const ids = options.page?.split(",");
    if (ids && new Set(ids).size !== ids.length) throw new CliError("画板 ID 不能重复");
    const pages = ids ? ids.map(id => pageOf(bundle, { page: id })) : bundle.draft.workspace.pages;
    const format = required(options, "format"), scale = options.scale === undefined ? 1 : Number(options.scale);
    const { exportOptions } = require("../lib/design-export");
    const payload = exportOptions({ pages, format, scale, transparent: !!options.transparent }, { path: bundle.entryPath });
    const out = required(options, "out"), extension = pages.length > 1 ? "zip" : format;
    const ext = path.extname(out).toLowerCase();
    if (ext !== "." + extension && !(extension === "jpg" && ext === ".jpeg")) throw new CliError(`导出文件应使用 .${extension} 后缀`);
    if (fs.existsSync(out)) throw new CliError("输出文件已存在，请选择新的路径");
    const result = await client.export(bundle.entryPath, payload);
    const types = { zip: "application/zip", png: "image/png", jpg: "image/jpeg", pdf: "application/pdf", html: "text/html" };
    if (result.contentType.split(";")[0].trim() !== types[extension]) throw new CliError("导出响应类型不符合请求，未写入文件");
    writeFile(out, result.bytes, { exclusive: true, json: false });
    output({ file: path.resolve(out), bytes: result.bytes.length, format: extension, pages: pages.map(p => p.id), savedToWorkbench: false }); return 0;
  }
  const diff = model.diffBundle(bundle), payload = model.payloadForApply(bundle);
  const result = await client.apply(bundle.entryPath, payload, Boolean(options["dry-run"]));
  if (options["dry-run"]) { output({ dryRun: true, diff, check, server: result }); return 0; }
  try { writeFile(file, model.createBundle(bundle.origin, bundle.entryPath, result.workspace, result.annotations, result.context || bundle.context), { expectedContent: original }); }
  catch {
    output({ saved: true, verified: false, localBaselineUpdated: false, revision: result.workspace?.revision, annotationsRevision: result.annotations?.revision,
      message: "服务已确认保存，但本地草稿未能更新；请重新 pull 到新文件，不要重放旧草稿" }); return 2;
  }
  let verified;
  try { verified = await client.bundle(bundle.entryPath); }
  catch (error) {
    output({ saved: true, verified: false, revision: result.workspace.revision, annotationsRevision: result.annotations.revision,
      message: "服务已确认保存，本地基线已更新；回读失败：" + error.message }); return 2;
  }
  const verification = model.createBundle(bundle.origin, bundle.entryPath, result.workspace, result.annotations, result.context || bundle.context);
  const sameVersions = verified.workspace.revision === result.workspace.revision && verified.annotations.revision === result.annotations.revision;
  verification.draft = { workspace: { ...verified.workspace, revision: result.workspace.revision, updatedAt: result.workspace.updatedAt },
    annotations: { ...verified.annotations, revision: result.annotations.revision, updatedAt: result.annotations.updatedAt } };
  const delta = model.diffBundle(verification), matches = sameVersions && !delta.changed.design && !delta.changed.annotations;
  output({ saved: true, verified: matches, changed: result.changed, revision: result.workspace.revision, annotationsRevision: result.annotations.revision,
    file: path.resolve(file), url: link(bundle.origin, bundle.entryPath, options.page), ...(!matches ? { message: "保存后已有其他更新，请重新 pull 比对" } : {}) });
  return matches ? 0 : 2;
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(JSON.stringify({ error: error.code === "EEXIST" ? "输出文件已存在，请选择新的路径" : error.message,
    ...(error.status ? { status: error.status } : {}), ...(error.details ? { details: error.details } : {}) }) + "\n");
  process.exitCode = error.status === 409 ? 3 : [401, 403].includes(error.status) ? 4 : error.status === 422 || error.name === "ModelError" ? 2 : 1;
});
module.exports = { run, link };
