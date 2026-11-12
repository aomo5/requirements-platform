"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FILE_NAME = "设计工作台.json";
const HISTORY_DIR = ".design-history";
const MAX_BYTES = 8 * 1024 * 1024;

class DesignError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function assert(test, message, status = 400) { if (!test) throw new DesignError(status, message); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function number(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }
function text(value, max) { return typeof value === "string" && value.length <= max; }

function validatePages(pages, entry) {
  assert(Array.isArray(pages) && pages.length <= 120, "最多保存 120 个页面");
  const ids = new Set();
  return pages.map((page) => {
    assert(plain(page), "页面格式不正确");
    assert(text(page.id, 80) && /^[a-zA-Z0-9_-]{1,80}$/.test(page.id) && !ids.has(page.id), "页面 ID 无效或重复");
    ids.add(page.id);
    assert(text(page.name, 100) && page.name.trim(), "页面名称不能为空，最多 100 字");
    assert(number(page.width, 240, 2560) && Number.isInteger(page.width), "页面宽度须为 240—2560");
    assert(number(page.height, 200, 6000) && Number.isInteger(page.height), "页面高度须为 200—6000");
    assert(number(page.x, -100000, 100000) && number(page.y, -100000, 100000), "页面位置超出范围");
    assert(text(page.html, 600000), "单个页面 HTML 最多 600000 字符");
    assert(!page.source || (text(page.source, 1200) && page.source.startsWith(`${entry.path}/原型设计/`) && /\.html?$/i.test(page.source)
      && path.posix.normalize(page.source) === page.source && !page.source.includes("\\")), "引用原型不属于当前需求");
    assert(!page.route || (text(page.route, 500) && page.route.startsWith("#")), "路由须以 # 开头");
    for (const key of ["platform", "group"]) assert(page[key] === undefined || (text(page[key], 100) && page[key].trim()), "页面分组须为 1—100 字");
    assert(page.changeSummary === undefined || text(page.changeSummary, 4000), "页面改动说明最多 4000 字");
    assert(page.description === undefined || text(page.description, 80000), "页面说明最多 80000 字");
    assert(page.status === undefined || ["planned", "designed"].includes(page.status), "页面状态须为待设计或已有设计");
    assert(page.descriptionPageId === undefined || (text(page.descriptionPageId, 80) && page.descriptionPageId !== page.id && pages.some(p => p?.id === page.descriptionPageId && !p.descriptionPageId)), "共用说明须关联当前设计中的独立说明页面");
    assert(!page.descriptionPageId || !page.description?.trim(), "共用说明时不能同时维护另一份页面说明");
    return { ...Object.fromEntries(["platform", "group", "changeSummary", "description", "status", "descriptionPageId"].filter(key => page[key] !== undefined).map(key => [key, page[key].trim()])), id: page.id, name: page.name.trim(), width: page.width, height: page.height,
      x: Math.round(page.x), y: Math.round(page.y), html: page.html, source: page.source || "", route: page.route || "" };
  });
}

function validateDesignContent(input, entry, previous = {}) {
  const data = Array.isArray(input) ? { pages: input } : input;
  assert(plain(data), "设计内容格式不正确");
  const overview = data.overview === undefined ? previous.overview : data.overview;
  assert(overview === undefined || text(overview, 160000), "设计说明最多 160000 字");
  return { pages: validatePages(data.pages, entry), ...(overview === undefined ? {} : { overview: overview.trim() }) };
}

// Resolve every component, not only the final path: symlinks may point outside the requirement.
function noSymlink(root, target) {
  const relative = path.relative(root, target);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "路径不在需求目录内", 403);
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { assert(!fs.lstatSync(cursor).isSymbolicLink(), "不允许写入或读取符号链接", 403); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

function createDesignStore(requirementsRoot, findEntry) {
  const root = fs.realpathSync(requirementsRoot);
  function location(entryPath) {
    assert(typeof entryPath === "string" && entryPath.length < 1000, "请选择关联需求");
    const entry = findEntry(entryPath);
    assert(entry, "需求不存在", 404);
    const directory = noSymlink(root, path.resolve(root, entry.path, "原型设计"));
    const file = noSymlink(root, path.join(directory, FILE_NAME));
    const history = noSymlink(root, path.join(directory, HISTORY_DIR));
    return { entry, directory, file, history };
  }
  function readAt(loc) {
    if (!fs.existsSync(loc.file)) return { schemaVersion: 1, revision: 0, updatedAt: null, pages: [] };
    try {
      assert(fs.statSync(loc.file).size <= MAX_BYTES, "设计文件过大", 413);
      const data = JSON.parse(fs.readFileSync(loc.file, "utf8"));
      assert(data.schemaVersion === 1 && Number.isInteger(data.revision) && data.revision >= 1, "不支持的设计文件版本", 409);
      return { ...data, ...validateDesignContent(data, loc.entry) };
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw new DesignError(409, "设计文件无法读取，未覆盖原文件；请检查 JSON 或恢复备份");
    }
  }
  function saveAt(loc, expectedRevision, pages) {
    assert(Number.isInteger(expectedRevision) && expectedRevision >= 0, "缺少有效版本号");
    const previous = readAt(loc);
    assert(previous.revision === expectedRevision, "文件已在另一窗口更新，请重新加载后再编辑；当前草稿未覆盖文件", 409);
    const data = { schemaVersion: 1, revision: previous.revision + 1, updatedAt: new Date().toISOString(), ...validateDesignContent(pages, loc.entry, previous) };
    const content = JSON.stringify(data, null, 2);
    assert(Buffer.byteLength(content) <= MAX_BYTES, "设计文件最多 8 MB", 413);
    fs.mkdirSync(loc.directory, { recursive: true });
    fs.mkdirSync(loc.history, { recursive: true });
    // Keep the pre-save state as well, including files generated directly by an agent.
    if (previous.revision > 0) {
      const backup = noSymlink(root, path.join(loc.history, `${previous.revision}.json`));
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(previous, null, 2), { flag: "wx" });
    }
    const temporary = path.join(loc.directory, `.design-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { flag: "wx" });
      fs.renameSync(temporary, loc.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return data;
  }
  return {
    read(entryPath) { const loc = location(entryPath); return { workspace: readAt(loc), entry: loc.entry }; },
    save(entryPath, expectedRevision, pages) { return saveAt(location(entryPath), expectedRevision, pages); },
    versions(entryPath) {
      const loc = location(entryPath), current = readAt(loc);
      const versions = current.revision ? [{ revision: current.revision, updatedAt: current.updatedAt, pageCount: current.pages.length, current: true }] : [];
      if (fs.existsSync(loc.history)) {
        for (const name of fs.readdirSync(loc.history).filter((name) => /^\d+\.json$/.test(name))) {
          if (Number(name.replace(".json", "")) >= current.revision) continue;
          const file = noSymlink(root, path.join(loc.history, name));
          try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            versions.push({ revision: data.revision, updatedAt: data.updatedAt, pageCount: data.pages.length, current: false });
          } catch (error) { if (error instanceof DesignError) throw error; }
        }
      }
      return versions.sort((a, b) => b.revision - a.revision);
    },
    restore(entryPath, expectedRevision, revision) {
      const loc = location(entryPath);
      assert(Number.isInteger(revision) && revision > 0, "历史版本无效");
      const current = readAt(loc);
      assert(revision < current.revision, "请选择历史版本");
      const file = noSymlink(root, path.join(loc.history, `${revision}.json`));
      assert(fs.existsSync(file), "历史版本不存在", 404);
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw new DesignError(409, "历史版本损坏，未修改当前设计"); }
      return saveAt(loc, expectedRevision, { pages: snapshot.pages, overview: snapshot.overview || "" });
    },
    source(entryPath, filePath) {
      const loc = location(entryPath);
      assert(loc.entry.prototypes.some((item) => item.path === filePath && item.type === "html"), "只能导入当前需求的 HTML 原型", 403);
      const fullPath = noSymlink(root, path.resolve(root, filePath));
      assert(fs.statSync(fullPath).size <= 600000, "原型过大，请拆分为页面后导入", 413);
      return { html: fs.readFileSync(fullPath, "utf8"), source: filePath };
    },
  };
}

function canEdit(request, accessMode = "local") {
  if (request.accountAccess) return request.accountAccess.canEdit === true;
  // Team mode is an explicit server-side opt-in for a trusted internal network.
  // Keep origin, path, revision and payload checks even when all teammates can edit.
  if (accessMode === "team") return true;
  const address = request.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${request.headers.host}`).hostname); }
  catch { return false; }
}
async function readBody(request, accessMode) {
  assert(canEdit(request, accessMode), "仅本机 localhost 可编辑，当前连接为只读", 403);
  assert(request.headers.origin === `http://${request.headers.host}`, "不允许跨站写入", 403);
  assert(request.headers["x-design-client"] === "workbench-v1", "缺少工作台请求标识", 403);
  assert(/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""), "请使用 JSON 请求", 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length; assert(length <= MAX_BYTES, "请求最多 8 MB", 413); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DesignError(400, "JSON 格式不正确"); }
}
function createDesignHandler(store, sendJson, { accessMode = "local" } = {}) {
  assert(["local", "team"].includes(accessMode), "设计访问模式须为 local 或 team");
  return async (request, response, url) => {
    const entryPath = url.searchParams.get("path");
    try {
      if (request.method === "GET" && url.pathname === "/api/design") {
        sendJson(response, 200, { ...(await store.read(entryPath)), canEdit: canEdit(request, accessMode), accessMode });
      } else if (request.method === "GET" && url.pathname === "/api/design/versions") {
        sendJson(response, 200, { versions: await store.versions(entryPath) });
      } else if (request.method === "GET" && url.pathname === "/api/design/source") {
        sendJson(response, 200, await store.source(entryPath, url.searchParams.get("file")));
      } else if (request.method === "PUT" && url.pathname === "/api/design") {
        const body = await readBody(request, accessMode);
        sendJson(response, 200, { workspace: await store.save(entryPath, body.expectedRevision, { pages: body.pages, ...(body.overview === undefined ? {} : { overview: body.overview }) }) });
      } else if (request.method === "POST" && url.pathname === "/api/design/restore") {
        const body = await readBody(request, accessMode);
        sendJson(response, 200, { workspace: await store.restore(entryPath, body.expectedRevision, body.revision) });
      } else sendJson(response, 405, { error: "不支持的设计接口或请求方法" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "设计文件操作失败，原文件未主动清理" });
    }
  };
}
module.exports = { createDesignStore, createDesignHandler, validatePages, validateDesignContent, DesignError, canEdit, readBody };
