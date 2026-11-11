"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canEdit } = require("./design-store");
const { MAX_QUOTE_LENGTH, MAX_HEADING_LENGTH } = require("./requirement-rules");

const MAX_BYTES = 1024 * 1024;
const FILE_NAME = "元素说明.json";
const HISTORY_DIR = ".annotations-history";
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

class AnnotationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function assert(test, message, status = 400) { if (!test) throw new AnnotationError(status, message); }
function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(value, maximum) { return typeof value === "string" && value.length <= maximum; }
function safeId(value) { return typeof value === "string" && ID.test(value); }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validEntryPath(value) {
  return text(value, 999) && value.length > 0 && !value.includes("\\") && !/[\x00-\x1f]/.test(value)
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").some((part) => part === ".." || part === "." || !part);
}
function validateTarget(target) {
  assert(plain(target), "说明目标格式不正确");
  if (target.type === "page-element") {
    assert(safeId(target.pageId), "说明页面 ID 无效");
    assert(text(target.route, 500) && (!target.route || target.route.startsWith("#")), "页面状态须为空或以 # 开头，最多 500 字");
    const anchor = target.anchor;
    assert(plain(anchor), "元素锚点格式不正确");
    assert(text(anchor.selector, 1000) && anchor.selector.trim(), "元素定位不能为空，最多 1000 字");
    assert(text(anchor.tag, 32) && anchor.tag.trim(), "元素类型不能为空，最多 32 字");
    assert(text(anchor.label, 160), "元素摘要最多 160 字");
    assert(typeof anchor.htmlHash === "string" && /^[a-f0-9]{8}$/.test(anchor.htmlHash), "页面内容指纹格式不正确");
    assert(anchor.contextHash === undefined || anchor.contextHash === "" || (typeof anchor.contextHash === "string" && /^[a-f0-9]{8}$/.test(anchor.contextHash)), "元素上下文指纹格式不正确");
    assert(["stable", "path"].includes(anchor.strength), "元素锚点强度无效");
    assert(anchor.elementId === undefined || anchor.elementId === "" || /^el-[a-f0-9-]{36}$/.test(anchor.elementId), "元素固定编号无效");
    assert(!anchor.elementId || anchor.selector === `[data-wb-element="${anchor.elementId}"]`, "元素固定编号与定位不一致");
    return { type: target.type, pageId: target.pageId, route: target.route,
      anchor: { ...(anchor.elementId ? { elementId: anchor.elementId } : {}), selector: anchor.selector, tag: anchor.tag, label: anchor.label, htmlHash: anchor.htmlHash, contextHash: anchor.contextHash || "", strength: anchor.strength } };
  }
  if (target.type === "flow-node") {
    assert(safeId(target.flowId) && safeId(target.nodeId), "流程节点目标 ID 无效");
    return { type: target.type, flowId: target.flowId, nodeId: target.nodeId };
  }
  if (target.type === "flow-edge") {
    assert(safeId(target.flowId) && safeId(target.edgeId), "流程连线目标 ID 无效");
    return { type: target.type, flowId: target.flowId, edgeId: target.edgeId };
  }
  throw new AnnotationError(400, "不支持的说明目标类型");
}
function validateNotes(notes) {
  assert(Array.isArray(notes) && notes.length <= 500, "每个需求最多保存 500 条元素说明");
  const ids = new Set();
  return notes.map((note) => {
    assert(plain(note) && safeId(note.id) && !ids.has(note.id), "说明 ID 无效或重复");
    ids.add(note.id);
    const requirements = validateRequirements(note.requirements);
    assert(text(note.text, 8000) && (note.text.trim() || requirements.length), "请填写说明或关联需求规则，说明最多 8000 字");
    return { id: note.id, target: validateTarget(note.target), text: note.text, requirements };
  });
}
function validateRequirements(requirements = []) {
  assert(Array.isArray(requirements) && requirements.length <= 12, "每条元素说明最多关联 12 条需求规则");
  const keys = new Set();
  return requirements.map((reference) => {
    assert(plain(reference), "需求规则引用格式不正确");
    assert(text(reference.file, 2000) && reference.file.endsWith("/需求文档.md") && !reference.file.includes("\\")
      && !/[\x00-\x1f]/.test(reference.file) && !path.posix.isAbsolute(reference.file)
      && path.posix.normalize(reference.file) === reference.file && !reference.file.split("/").some((part) => !part || part.startsWith(".")), "需求规则文件路径无效");
    assert(safeId(reference.blockId) && reference.blockId.startsWith("rule-"), "需求规则定位无效");
    assert(text(reference.quote, MAX_QUOTE_LENGTH) && reference.quote.trim(), `需求规则摘录不能为空，最多 ${MAX_QUOTE_LENGTH} 字`);
    assert(text(reference.heading, MAX_HEADING_LENGTH), `需求规则标题最多 ${MAX_HEADING_LENGTH} 字`);
    const key = `${reference.file}\0${reference.blockId}`;
    assert(!keys.has(key), "同一元素不能重复关联同一需求规则");
    keys.add(key);
    return { file: reference.file, blockId: reference.blockId, quote: reference.quote, heading: reference.heading };
  });
}
function sameTarget(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function noSymlink(root, target) {
  const relative = path.relative(root, target);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "路径不在需求目录内", 403);
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { assert(!fs.lstatSync(cursor).isSymbolicLink(), "不允许读取或写入符号链接", 403); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}
function readFile(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, revision: 0, updatedAt: null, notes: [] };
  try {
    assert(fs.statSync(file).size <= MAX_BYTES, "元素说明文件最多 1 MB", 413);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(data.schemaVersion === 1 && Number.isInteger(data.revision) && data.revision >= 1 && validTimestamp(data.updatedAt), "不支持的元素说明文件版本或时间", 409);
    const notes = validateNotes(data.notes).map((note, index) => {
      const source = data.notes[index];
      assert(validTimestamp(source.createdAt) && validTimestamp(source.updatedAt), "元素说明时间格式不正确", 409);
      return { ...note, createdAt: source.createdAt, updatedAt: source.updatedAt };
    });
    return { schemaVersion: 1, revision: data.revision, updatedAt: data.updatedAt, notes };
  } catch (error) {
    if (error instanceof AnnotationError) throw error;
    throw new AnnotationError(409, "元素说明文件无法读取，原文件未覆盖；请检查 JSON 或恢复备份");
  }
}

function createAnnotationStore(requirementsRoot, findEntry, { readDesign, readFlows, readRules }) {
  const root = fs.realpathSync(requirementsRoot);
  function location(entryPath) {
    assert(validEntryPath(entryPath), "请选择有效的关联需求");
    const entry = findEntry(entryPath);
    assert(entry && validEntryPath(entry.path), "需求不存在", 404);
    const directory = noSymlink(root, path.resolve(root, entry.path, "页面设计"));
    return { entry, directory, file: noSymlink(root, path.join(directory, FILE_NAME)), history: noSymlink(root, path.join(directory, HISTORY_DIR)) };
  }
  function validateNewTargets(entryPath, notes, previousNotes) {
    const oldById = new Map(previousNotes.map((note) => [note.id, note]));
    let design, flows;
    for (const note of notes) {
      const old = oldById.get(note.id);
      // A lost target never prevents editing the saved explanation itself.
      if (old && sameTarget(old.target, note.target)) continue;
      const target = note.target;
      if (target.type === "page-element") {
        if (!design) { const data = readDesign(entryPath); design = data.workspace || data; }
        assert(design.pages.some((page) => page.id === target.pageId), "说明页面尚未保存或已移除，请先保存设计并重新选择页面", 409);
      } else {
        if (!flows) { const data = readFlows(entryPath); flows = data.workspace || data; }
        const flow = flows.flows.find((item) => item.id === target.flowId);
        assert(flow, "说明流程尚未保存或已移除，请先保存流程并重新选择", 409);
        if (target.type === "flow-node") assert(flow.nodes.some((node) => node.id === target.nodeId), "说明节点尚未保存或已移除，请先保存流程并重新选择", 409);
        else assert(flow.edges.some((edge) => edge.id === target.edgeId), "说明连线尚未保存或已移除，请先保存流程并重新选择", 409);
      }
    }
  }
  function validateNewRequirements(entryPath, notes, previousNotes) {
    const oldById = new Map(previousNotes.map((note) => [note.id, note]));
    let currentRules;
    for (const note of notes) {
      const previous = oldById.get(note.id)?.requirements || [];
      for (const reference of note.requirements) {
        // Preserve the exact saved snapshot after the source changes or disappears.
        if (previous.some((item) => sameTarget(item, reference))) continue;
        if (!currentRules) currentRules = typeof readRules === "function" ? readRules(entryPath).rules : [];
        assert(currentRules.some((rule) => !rule.ambiguous && rule.file === reference.file && rule.blockId === reference.blockId
          && rule.quote === reference.quote && rule.heading === reference.heading), "需求规则已变化或不属于当前需求，请重新选择后关联", 409);
      }
    }
  }
  function saveAt(loc, expectedRevision, inputNotes, restored = false) {
    assert(Number.isInteger(expectedRevision) && expectedRevision >= 0, "缺少有效版本号");
    const previous = readFile(loc.file);
    assert(previous.revision === expectedRevision, "元素说明已在另一窗口更新，请重新加载后再编辑；当前说明草稿未覆盖文件", 409);
    const cleanNotes = validateNotes(inputNotes);
    if (!restored) {
      validateNewTargets(loc.entry.path, cleanNotes, previous.notes);
      validateNewRequirements(loc.entry.path, cleanNotes, previous.notes);
    }
    const now = new Date().toISOString();
    const oldById = new Map(previous.notes.map((note) => [note.id, note]));
    const historyById = restored ? new Map(inputNotes.map((note) => [note.id, note])) : null;
    const notes = cleanNotes.map((note) => {
      const old = oldById.get(note.id), historical = historyById?.get(note.id);
      const changed = !old || old.text !== note.text || !sameTarget(old.target, note.target) || !sameTarget(old.requirements, note.requirements);
      return { ...note, createdAt: old?.createdAt || historical?.createdAt || now, updatedAt: changed ? now : old.updatedAt };
    });
    const workspace = { schemaVersion: 1, revision: previous.revision + 1, updatedAt: now, notes };
    const content = JSON.stringify(workspace, null, 2);
    assert(Buffer.byteLength(content) <= MAX_BYTES, "元素说明文件最多 1 MB", 413);
    fs.mkdirSync(loc.directory, { recursive: true });
    fs.mkdirSync(loc.history, { recursive: true });
    if (previous.revision) {
      const file = noSymlink(root, path.join(loc.history, `${previous.revision}.json`));
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(previous, null, 2), { flag: "wx" });
    }
    const temporary = path.join(loc.directory, `.annotations-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, content, { flag: "wx" }); fs.renameSync(temporary, loc.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return workspace;
  }
  return {
    read(entryPath) { return { workspace: readFile(location(entryPath).file) }; },
    save(entryPath, expectedRevision, notes) { return saveAt(location(entryPath), expectedRevision, notes); },
    versions(entryPath) {
      const loc = location(entryPath), current = readFile(loc.file);
      const versions = current.revision ? [{ revision: current.revision, updatedAt: current.updatedAt, noteCount: current.notes.length, current: true }] : [];
      if (fs.existsSync(loc.history)) for (const name of fs.readdirSync(loc.history).filter((item) => /^\d+\.json$/.test(item))) {
        if (Number(name.replace(".json", "")) >= current.revision) continue;
        const file = noSymlink(root, path.join(loc.history, name));
        try { const data = readFile(file); versions.push({ revision: data.revision, updatedAt: data.updatedAt, noteCount: data.notes.length, current: false }); }
        catch (error) { if (error.status === 403) throw error; }
      }
      return versions.sort((left, right) => right.revision - left.revision);
    },
    restore(entryPath, expectedRevision, revision) {
      const loc = location(entryPath), current = readFile(loc.file);
      assert(Number.isInteger(revision) && revision > 0 && revision < current.revision, "请选择有效的历史版本");
      const file = noSymlink(root, path.join(loc.history, `${revision}.json`));
      assert(fs.existsSync(file), "历史版本不存在", 404);
      return saveAt(loc, expectedRevision, readFile(file).notes, true);
    },
  };
}

async function readBody(request, accessMode) {
  assert(canEdit(request, accessMode), "仅本机 localhost 可编辑，当前连接为只读", 403);
  assert(request.headers.origin === `http://${request.headers.host}`, "不允许跨站写入", 403);
  assert(request.headers["x-design-client"] === "workbench-v1", "缺少工作台请求标识", 403);
  assert(/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""), "请使用 JSON 请求", 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; assert(length <= MAX_BYTES, "请求最多 1 MB", 413); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert(plain(body), "请求内容必须是 JSON 对象"); return body; }
  catch (error) { if (error instanceof AnnotationError) throw error; throw new AnnotationError(400, "JSON 格式不正确"); }
}
function createAnnotationHandler(store, sendJson, { accessMode = "local" } = {}) {
  assert(["local", "team"].includes(accessMode), "元素说明访问模式须为 local 或 team");
  return async (request, response, url) => {
    const entryPath = url.searchParams.get("path");
    try {
      if (request.method === "GET" && url.pathname === "/api/annotations") sendJson(response, 200, { ...(await store.read(entryPath)), canEdit: canEdit(request, accessMode), accessMode });
      else if (request.method === "GET" && url.pathname === "/api/annotations/versions") sendJson(response, 200, { versions: await store.versions(entryPath) });
      else if (request.method === "PUT" && url.pathname === "/api/annotations") {
        const body = await readBody(request, accessMode);
        sendJson(response, 200, { workspace: await store.save(entryPath, body.expectedRevision, body.notes) });
      } else if (request.method === "POST" && url.pathname === "/api/annotations/restore") {
        const body = await readBody(request, accessMode);
        sendJson(response, 200, { workspace: await store.restore(entryPath, body.expectedRevision, body.revision) });
      } else sendJson(response, 405, { error: "不支持的元素说明接口或请求方法" });
    } catch (error) { sendJson(response, error.status || 500, { error: error.status ? error.message : "元素说明文件操作失败，原文件未主动清理" }); }
  };
}

module.exports = { createAnnotationStore, createAnnotationHandler, validateNotes, validateTarget, validateRequirements, AnnotationError };
