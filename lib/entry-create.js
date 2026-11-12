"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { canEdit } = require("./design-store");
const { scanRequirements, findEntryByPath } = require("./scan");

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function createEntryService(root, { register = async () => {}, persistDocuments = true } = {}) {
  root = fs.realpathSync(root);
  return async (input, actor) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("请填写需求信息");
    const moduleName = typeof input.module === "string" ? input.module : "";
    const name = typeof input.name === "string" ? input.name.trim().normalize("NFC") : "";
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!/^\d{2}-[^/\\]+$/.test(moduleName)) fail("请选择所属模块");
    const moduleDir = path.join(root, moduleName);
    const stat = fs.lstatSync(moduleDir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("所属模块不存在或不可用");
    if (!name || [...name].length > 80 || Buffer.byteLength(name) > 240 || /^[.]/.test(name)
      || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) || /[.]$/.test(name)
      || ["原型设计", "页面设计", "流程设计", "portal"].includes(name)) fail("需求名称须为 1–80 个字符，不能包含路径或文件名特殊字符");
    if (!content) fail("请填写需求内容");
    if (content.length > 12000) fail("需求内容最多 12000 个字符");
    const entryPath = `${moduleName}/${name}`, dir = path.join(moduleDir, name);
    try { fs.mkdirSync(dir); }
    catch (error) { if (error.code === "EEXIST") fail("该模块下已有同名需求，请修改名称", 409); throw error; }
    const files = new Map([
      ["规格索引.md", `# ${name}规格索引\n\n- 阶段：需求草稿，待整理和评审。\n- 主 Gitee 需求：未关联。\n\n## 文档入口\n\n- [需求文档](./需求文档.md)\n- 接口契约：待确认是否涉及前后端协作后补齐。\n- 任务拆分：需求尚未评审，暂不适用。\n- 设计：在设计模块维护页面清单、说明、画板及关联；未出图的页面先标记待设计。\n\n## 下一步\n\n整理业务规则、已确认事项与待确认事项，再同步或关联 Gitee 需求。\n`],
      ["需求文档.md", `# ${name}\n\n## 原始需求\n\n${content}\n`],
    ]);
    const written = [], folders = [];
    try {
      for (const [file, text] of files) { fs.writeFileSync(path.join(dir, file), text, { flag: "wx" }); written.push(file); }
      for (const folder of ["原型设计"]) { fs.mkdirSync(path.join(dir, folder)); folders.push(folder); }
      const entry = findEntryByPath(scanRequirements(root), entryPath);
      if (!entry) fail("需求创建后未能读取，请重试", 500);
      await register(entry, actor);
      if (!persistDocuments) for (const file of written) {
        const target=path.join(dir,file);
        if(fs.readFileSync(target,'utf8')===files.get(file))fs.unlinkSync(target);
      }
      return entry;
    } catch (error) {
      // Only remove the files this attempt wrote, and only while still unchanged.
      for (const file of written) {
        const target = path.join(dir, file);
        try { if (fs.readFileSync(target, "utf8") === files.get(file)) fs.unlinkSync(target); } catch {}
      }
      for (const folder of folders.reverse()) { try { fs.rmdirSync(path.join(dir, folder)); } catch {} }
      try { fs.rmdirSync(dir); } catch {}
      throw error;
    }
  };
}

function createEntryHandler(create, sendJson, { accessMode = "local" } = {}) {
  return async (request, response) => {
    try {
      if (request.method !== "POST") fail("新增需求仅支持 POST", 405);
      if (!canEdit(request, accessMode)) fail("当前连接为只读，不能新增需求", 403);
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers["x-design-client"] !== "workbench-v1") fail("不允许跨站写入", 403);
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) fail("请使用 JSON 请求", 415);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) fail("请求内容过大", 413); chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("JSON 格式不正确"); }
      sendJson(response, 201, { entry: await create(input, request.accountAccess?.user) });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "需求创建失败，请重试；已填写内容保留" });
    }
  };
}

module.exports = { createEntryService, createEntryHandler };
