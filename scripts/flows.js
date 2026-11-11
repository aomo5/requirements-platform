#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, required, readJson, writeFile, promptLine } = require("../lib/workbench-cli-files");
const { FlowClient, CliError, localOrigin } = require("../lib/flow-cli-client");
const model = require("../lib/flow-edit-model");

const HELP = `流程工作台 CLI（默认 http://127.0.0.1:8125）

node scripts/flows.js <命令> [参数]       或 npm run flow -- <命令>
  login [--username 账号] [--password-stdin]  登录一次，保存私有会话，不保存密码
  whoami | logout                           检查登录 / 撤销 CLI 会话
  list --path 主题路径                       列出流程和版本
  routes --path 主题路径 [--view queue|all] [--through 流程ID] [--rule 场景ID] [--offset 0] [--detail]
                                            整个需求的核验路线、源码缺口与实测证据
  pull --path 主题路径 --out 草稿.json        读取图、说明与双版本基线
  show --file 草稿.json [--flow ID] [--node ID] 查看指定图/节点及说明
  patch --file 草稿.json --ops 操作.json      按稳定 ID 批量修改本地草稿
  check --file 草稿.json                     校验结构、引用与可读性提示
  diff --file 草稿.json                      展示规范化后的逐项差异
  apply --file 草稿.json [--dry-run]          原子提交图与说明；冲突停止
  versions --path 主题路径 [--kind flows|annotations]
  export-mermaid --file 草稿.json --flow ID --out 图.mmd
  link --path 主题路径 [--flow ID] [--node ID] 输出原生画布定位链接

全局：--url 工作台根地址（也可 WORKBENCH_URL 或 workbench config 配置）
patch 可加 --out 新草稿.json；--ops - 从 stdin 读 JSON 数组。
pull 不覆盖已有文件；操作草稿在临时目录，不是新的在线数据源。
退出码：0 成功，1 参数/连接失败，2 校验失败，3 版本冲突，4 未登录/无权限。
`;

function canvasLink(origin, entryPath, flowId, nodeId) {
  return origin + "/#" + new URLSearchParams({ path: entryPath, view: "flow",
    ...(flowId ? { flow: flowId } : {}), ...(nodeId ? { node: nodeId } : {}) });
}
function readDraft(options) {
  const file = required(options, "file"), { value: bundle, source: original } = readJson(file, { withSource: true });
  // checkBundle also verifies immutable revision metadata and origin/path shape.
  const check = model.checkBundle(bundle);
  return { file, bundle, check, original };
}
function checkOrThrow(check) {
  if (check.errors.length) throw new CliError("草稿校验未通过，未提交", 422, check);
}

async function run(argv, { output = value => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"), clientFactory = options => new FlowClient(options) } = {}) {
  const { command, options } = parseArgs([...argv],argv[0]==="routes" ? {
    flags:["help","detail","changes"],keys:["url","path","out","view","mode","through","node","entry","query","rule","status","review","test","offset","limit","meta"]
  } : {});
  if (command === "help" || options.help) { output(HELP); return 0; }
  const commands = new Set(["login", "logout", "whoami", "list", "routes", "pull", "show", "patch", "check", "diff", "apply", "versions", "export-mermaid", "link"]);
  if (!commands.has(command)) throw new CliError(`未知命令：${command}，运行 help 查看用法`);
  if (["login", "logout", "whoami"].includes(command)) {
    const client = clientFactory({ url: options.url });
    if (command === "login") {
      const username = options.username || await promptLine("工作台账号：");
      const password = options["password-stdin"] ? fs.readFileSync(0, "utf8").replace(/\r?\n$/, "") : await promptLine("密码（不回显）：", true);
      output(await client.login(username, password));
    } else output(await client[command]());
    return 0;
  }
  if (command==="routes") {
    const query=new URLSearchParams({path:required(options,"path")});
    for(const k of ["view","mode","through","node","entry","query","rule","status","review","test","offset","limit","meta"])if(options[k])query.set(k,String(options[k]));
    if(options.detail)query.set("detail","1");
    const data=await clientFactory({url:options.url}).request("/api/flow-routes"+(options.changes?"/changes":"")+"?"+query);
    if(options.out)writeFile(options.out,data);else output(data);
    return 0;
  }
  if (["list", "pull", "versions", "link"].includes(command)) {
    const entryPath = required(options, "path"), client = clientFactory({ url: options.url });
    if (command === "link") { output(canvasLink(client.origin, entryPath, options.flow, options.node) + "\n"); return 0; }
    if (command === "versions") {
      const kind = options.kind || "flows";
      if (!["flows", "annotations"].includes(kind)) throw new CliError("--kind 只接受 flows 或 annotations");
      output(await client.request(`/api/${kind}/versions?` + new URLSearchParams({ path: entryPath }))); return 0;
    }
    const data = await client.bundle(entryPath);
    if (command === "list") output({ entryPath, revision: data.workspace.revision, annotationsRevision: data.annotations.revision,
      canEdit: data.canEdit, flows: data.workspace.flows.map(f => ({ id: f.id, name: f.name, parent: f.parent, nodes: f.nodes.length, edges: f.edges.length,
        url: canvasLink(client.origin, entryPath, f.id) })) });
    else {
      const file = required(options, "out");
      writeFile(file, model.createBundle(client.origin, entryPath, data.workspace, data.annotations), { exclusive: true });
      output({ file: path.resolve(file), revision: data.workspace.revision, annotationsRevision: data.annotations.revision, canEdit: data.canEdit });
    }
    return 0;
  }
  const { file, bundle, check, original } = readDraft(options);
  if (command === "check") { output(check); return check.errors.length ? 2 : 0; }
  if (command === "patch") {
    const next = model.applyOperations(bundle, readJson(required(options, "ops"))), out = options.out || file;
    writeFile(out, next, { exclusive: path.resolve(out) !== path.resolve(file) });
    output({ file: path.resolve(out), ...model.diffBundle(next), check: model.checkBundle(next) }); return 0;
  }
  checkOrThrow(check);
  if (command === "diff") { output(model.diffBundle(bundle)); return 0; }
  if (command === "show") {
    const flows = bundle.draft.workspace.flows;
    const flow = options.flow ? flows.find(f => f.id === options.flow) : null;
    if (options.flow && !flow) throw new CliError("指定流程不存在");
    if (options.node && !flow) throw new CliError("--node 必须同时指定 --flow");
    const node = options.node ? flow.nodes.find(n => n.id === options.node) : null;
    if (options.node && !node) throw new CliError("指定节点不存在");
    output(node ? { node, incoming: flow.edges.filter(e => e.target === node.id), outgoing: flow.edges.filter(e => e.source === node.id),
      notes: bundle.draft.annotations.notes.filter(n => n.target.flowId === flow.id && n.target.nodeId === node.id),
      url: canvasLink(bundle.origin, bundle.entryPath, flow.id, node.id) }
      : flow ? { flow, notes: bundle.draft.annotations.notes.filter(n => n.target.flowId === flow.id) } : bundle.draft);
    return 0;
  }
  if (command === "export-mermaid") {
    const flow = bundle.draft.workspace.flows.find(f => f.id === required(options, "flow"));
    if (!flow) throw new CliError("指定流程不存在");
    const { serializeMermaid } = await import("../public/assets/flow-mermaid-format.mjs");
    writeFile(required(options, "out"), serializeMermaid(flow), { exclusive: true, json: false });
    output({ file: path.resolve(options.out), note: "Mermaid 用于阅读；草稿 JSON 保留完整布局、样式、ID 和说明" }); return 0;
  }
  if (command === "apply") {
    if (options.url && localOrigin(options.url) !== bundle.origin) throw new CliError("--url 与草稿来源不同；请从目标实例重新 pull");
    // Always use the recorded origin; ambient environment must not retarget a saved draft.
    const client = clientFactory({ url: bundle.origin }), payload = model.payloadForApply(bundle);
    const diff = model.diffBundle(bundle);
    const result = await client.apply(bundle.entryPath, payload, Boolean(options["dry-run"]));
    if (options["dry-run"]) { output({ dryRun: true, diff, check, server: result }); return 0; }
    // Save the acknowledged baseline even if the following read fails; never replay a stale write.
    try {
      const next = model.createBundle(bundle.origin, bundle.entryPath, result.workspace, result.annotations);
      writeFile(file, next, { expectedContent: original });
    } catch {
      output({ saved: true, verified: false, localBaselineUpdated: false,
        revision: result.workspace?.revision, annotationsRevision: result.annotations?.revision,
        message: "服务已确认保存，但本地草稿未能更新。请重新 pull 到新文件核对，不要重放旧草稿。" });
      return 2;
    }
    let verified;
    try { verified = await client.bundle(bundle.entryPath); }
    catch (error) {
      output({ saved: true, verified: false, revision: result.workspace.revision, annotationsRevision: result.annotations.revision,
        message: "服务已确认保存，回读失败；草稿基线已更新。" + error.message }); return 2;
    }
    const verification = model.createBundle(bundle.origin, bundle.entryPath, result.workspace, result.annotations);
    verification.draft = { workspace: verified.workspace, annotations: verified.annotations };
    // diffBundle expects fixed revisions, compare after checking actual revisions separately.
    const sameVersions = verified.workspace.revision === result.workspace.revision && verified.annotations.revision === result.annotations.revision;
    verification.draft.workspace = { ...verification.draft.workspace, revision: result.workspace.revision, updatedAt: result.workspace.updatedAt };
    verification.draft.annotations = { ...verification.draft.annotations, revision: result.annotations.revision, updatedAt: result.annotations.updatedAt };
    const delta = model.diffBundle(verification);
    const matches = sameVersions && !delta.changed.flows && !delta.changed.annotations;
    output({ saved: true, verified: matches, changed: result.changed, revision: result.workspace.revision,
      annotationsRevision: result.annotations.revision, file: path.resolve(file), url: canvasLink(bundle.origin, bundle.entryPath, options.flow),
      ...(!matches ? { message: "保存后已有其他更新；本地保留本次保存基线，请重新 pull 比对" } : {}) });
    return matches ? 0 : 2;
  }
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(JSON.stringify({ error: error.code === "EEXIST" ? "输出文件已存在，请选择新的路径" : error.message,
    ...(error.status ? { status: error.status } : {}), ...(error.details ? { details: error.details } : {}) }) + "\n");
  process.exitCode = error.status === 409 ? 3 : [401, 403].includes(error.status) ? 4 : error.status === 422 || error.name === "ModelError" ? 2 : 1;
});

module.exports = { run, parseArgs, canvasLink };
