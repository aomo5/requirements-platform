"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canEdit } = require("./design-store");

const DIRECTORY = "流程设计";
const FILE_NAME = "流程工作台.json";
const HISTORY_DIR = ".flow-history";
const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const APPLICABILITY = new Set(["undecided", "needed", "not-needed"]);

class FlowError extends Error {
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}
function assert(test, message, status = 400, details) { if (!test) throw new FlowError(status, message, details); }
function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(value, max) { return typeof value === "string" && value.length <= max; }
function safeId(value) { return typeof value === "string" && ID.test(value); }
function key(entryPath, flowId) { return `${entryPath}\n${flowId}`; }
function sameRelation(left, right) {
  return Boolean(left && right && left.entryPath === right.entryPath && left.flowId === right.flowId
    && (left.nodeId || "") === (right.nodeId || ""));
}
function validEntryPath(value) {
  return text(value, 999) && value.length > 0 && !value.includes("\\") && !/[\x00-\x1f]/.test(value)
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").some((part) => part === ".." || part === "." || !part);
}
function relation(value, withNode = false) {
  assert(plain(value) && validEntryPath(value.entryPath) && safeId(value.flowId), "流程关联格式不正确");
  if (withNode) assert(value.nodeId === undefined || value.nodeId === "" || safeId(value.nodeId), "关联节点 ID 不正确");
  return { entryPath: value.entryPath, flowId: value.flowId, ...(withNode ? { nodeId: value.nodeId || "" } : {}) };
}

// Structured field documentation belongs to the node, separately from routing.
function parameterContract(value) {
  assert(plain(value) && Object.keys(value).every(field => ["inputs", "outputs"].includes(field)), "参数契约只支持 inputs 和 outputs");
  const contract = {};
  for (const direction of ["inputs", "outputs"]) {
    const rows = value[direction] ?? [];
    assert(value[direction] === undefined || Array.isArray(value[direction]), `参数契约 ${direction} 必须为数组`);
    assert(rows.length <= 50, `参数契约 ${direction} 最多 50 项`);
    const ids = new Set();
    contract[direction] = rows.map(row => {
      assert(plain(row) && Object.keys(row).every(field => ["id", "name", "type", "required", "condition", "source", "description"].includes(field)), "参数字段属性无效");
      assert(safeId(row.id) && !ids.has(row.id), "参数字段 ID 无效或重复");
      ids.add(row.id);
      assert(text(row.name, 120) && row.name.trim(), "参数字段名不能为空，最多 120 字");
      assert(text(row.type, 120) && row.type.trim(), "参数类型不能为空，最多 120 字");
      assert(["required", "optional", "conditional"].includes(row.required), "参数必需性必须为 required、optional 或 conditional");
      for (const [field, max] of [["condition", 1000], ["source", 1000], ["description", 2000]]) {
        assert(row[field] === undefined || text(row[field], max), `参数 ${field} 必须为文本，最多 ${max} 字`);
      }
      assert(row.required !== "conditional" || row.condition?.trim(), "条件必需参数须填写条件");
      return { id: row.id, name: row.name.trim(), type: row.type.trim(), required: row.required,
        ...Object.fromEntries(["condition", "source", "description"].filter(field => row[field] !== undefined).map(field => [field, row[field]])) };
    });
  }
  return contract.inputs.length || contract.outputs.length ? contract : null;
}

// A call is a synchronous invocation. Returns are mapped by each caller, never
// by a fixed destination inside the shared module. Events remain independent.
function moduleCall(value) {
  const ref = relation(value, true);
  assert(Object.keys(value).every(field => ["entryPath", "flowId", "nodeId", "returns"].includes(field)), "模块调用只支持同步入口和返回映射");
  assert(safeId(ref.nodeId), "模块调用须指定入口节点");
  assert(Array.isArray(value.returns) && value.returns.length <= 100, "模块返回映射须为数组，最多 100 项");
  const outputs = new Set();
  const returns = value.returns.map(item => {
    assert(plain(item) && safeId(item.outputNodeId) && safeId(item.targetNodeId), "模块返回映射节点 ID 无效");
    assert(Object.keys(item).every(field => ["outputNodeId", "targetNodeId"].includes(field)), "模块返回映射字段无效");
    assert(!outputs.has(item.outputNodeId), "同一模块返回出口不能重复映射");
    outputs.add(item.outputNodeId);
    return { outputNodeId: item.outputNodeId, targetNodeId: item.targetNodeId };
  });
  return { ...ref, returns };
}

function moduleProblems(entries, { deferExternal = false } = {}) {
  const graph = new Map(), problems = [];
  for (const { entryPath, workspace } of entries) for (const flow of workspace.flows) graph.set(key(entryPath, flow.id), { entryPath, flow });
  const add = (code, owner, ref, message, external = false) => problems.push({ code, ...owner, ref, message, external });
  for (const { entryPath, flow } of graph.values()) for (const node of flow.nodes) {
    if (node.type !== "call" || !node.call) continue;
    const owner = { entryPath, flowId: flow.id, nodeId: node.id }, call = node.call;
    const target = graph.get(key(call.entryPath, call.flowId))?.flow;
    for (const mapping of call.returns) {
      if (!flow.nodes.some(item => item.id === mapping.targetNodeId)) add("CALL_RECEIVER", owner, mapping, "模块返回承接节点不存在");
      else if (!flow.edges.some(edge => edge.source === node.id && edge.target === mapping.targetNodeId)) add("CALL_RETURN_EDGE", owner, mapping, "模块调用须有通向每个返回承接节点的连线");
    }
    const receivers = new Set(call.returns.map(mapping => mapping.targetNodeId));
    for (const edge of flow.edges.filter(item => item.source === node.id)) {
      if (!receivers.has(edge.target)) add("CALL_UNMAPPED_EDGE", owner, { edgeId: edge.id, targetNodeId: edge.target }, "模块调用的所有出线必须属于已配置的返回映射");
    }
    if (!target) {
      const external = deferExternal && call.entryPath !== entryPath;
      add(external ? "EXTERNAL_REFERENCE" : "CALL_TARGET", owner, call, external ? "外部模块调用由服务端核验" : "调用的公共模块不存在", external);
      continue;
    }
    if (target.kind !== "module") add("CALL_KIND", owner, call, "调用目标必须是公共模块");
    if (!target.nodes.some(item => item.id === call.nodeId && item.type === "input")) add("CALL_ENTRY", owner, call, "模块调用入口必须是目标模块的输入节点");
    const outputs = target.nodes.filter(item => item.type === "return").map(item => item.id).sort();
    const mapped = call.returns.map(item => item.outputNodeId).sort();
    if (!outputs.length || JSON.stringify(outputs) !== JSON.stringify(mapped)) add("CALL_RETURNS", owner, { ...call, expectedOutputs: outputs }, "模块每个返回出口必须且只能映射一次，不能遗漏或引用其他节点");
  }
  // Check invocation recursion separately from the existing parent tree.
  const calls = new Map([...graph].map(([id, { flow }]) => [id, flow.nodes.filter(n => n.type === "call" && n.call).map(n => ({ node: n, to: key(n.call.entryPath, n.call.flowId) }))]));
  const reaches = (from, goal, seen = new Set()) => {
    if (from === goal) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (calls.get(from) || []).some(edge => reaches(edge.to, goal, seen));
  };
  for (const [id, links] of calls) for (const { node, to } of links) if (reaches(to, id)) {
    const { entryPath, flow } = graph.get(id);
    add("CALL_CYCLE", { entryPath, flowId: flow.id, nodeId: node.id }, node.call, "公共模块调用不能形成递归循环");
  }
  return problems;
}
const moduleProblemKey = problem => JSON.stringify([problem.code, problem.entryPath, problem.flowId, problem.nodeId, problem.ref]);

// Recovery is a reference to an independently triggered execution, never a
// sequence edge or synchronous call. Several waiters may share one trigger.
function recoveryProblems(entries, { deferExternal = false } = {}) {
  const graph = new Map(), problems = [];
  for (const { entryPath, workspace } of entries) for (const flow of workspace.flows) graph.set(key(entryPath, flow.id), flow);
  for (const { entryPath, workspace } of entries) for (const flow of workspace.flows) for (const node of flow.nodes) {
    if (!node.recovery) continue;
    const ref = node.recovery, target = graph.get(key(ref.entryPath, ref.flowId))?.nodes.find(n => n.id === ref.nodeId);
    const external = !target && deferExternal && ref.entryPath !== entryPath;
    const code = external ? "EXTERNAL_REFERENCE" : !target ? "RECOVERY_TARGET" : target.type !== "event" || (target.eventPhase || "trigger") !== "trigger" || !["timer", "message", "manual", "response"].includes(target.eventType) ? "RECOVERY_TRIGGER" : null;
    if (code) problems.push({ code, entryPath, flowId: flow.id, nodeId: node.id, ref, external,
      message: external ? "外部恢复入口由服务端核验" : !target ? "异步恢复入口不存在" : "异步恢复入口必须是类型明确的触发事件" });
  }
  return problems;
}

function validateContent(data, entryPath) {
  assert(plain(data) && APPLICABILITY.has(data.applicability), "流程适用状态无效");
  assert(text(data.reason, 2000), "流程说明最多 2000 字");
  assert(Array.isArray(data.flows) && data.flows.length <= 40, "每个需求最多保存 40 个流程");
  assert(data.applicability !== "not-needed" || data.flows.length === 0, "本需求已有流程，请先处理已有流程再设为无需流程图");
  const flowIds = new Set();
  const flows = data.flows.map((flow) => {
    assert(plain(flow) && safeId(flow.id) && !flowIds.has(flow.id), "流程 ID 无效或重复");
    flowIds.add(flow.id);
    assert(text(flow.name, 100) && flow.name.trim(), "流程名称不能为空，最多 100 字");
    assert(text(flow.description, 4000), "流程描述最多 4000 字");
    assert(flow.kind === undefined || flow.kind === "module", "流程种类无效");
    assert(flow.kind !== "module" || flow.parent == null, "公共模块不能固定关联单一主流程");
    assert(flow.direction === undefined || ["TD", "TB", "BT", "LR", "RL"].includes(flow.direction), "流程方向无效");
    assert(Array.isArray(flow.nodes) && flow.nodes.length <= 100, "每张流程图最多 100 个节点");
    assert(Array.isArray(flow.edges) && flow.edges.length <= 200, "每张流程图最多 200 条连线");
    assert(flow.lanes === undefined || (Array.isArray(flow.lanes) && flow.lanes.length <= 12), "泳道最多12条");
    const lanes = (flow.lanes || []).map(lane => {
      assert(plain(lane) && safeId(lane.id) && text(lane.label, 100), "泳道标识或名称无效");
      assert([lane.x,lane.y,lane.width,lane.height].every(v => Number.isFinite(v) && Math.abs(v) <= 100000) && lane.width > 0 && lane.height > 0, "泳道范围无效");
      return {id:lane.id,label:lane.label,x:lane.x,y:lane.y,width:lane.width,height:lane.height};
    });
    assert(new Set(lanes.map(l => l.id)).size === lanes.length, "泳道标识重复");
    const nodeIds = new Set();
    const nodes = flow.nodes.map((node) => {
      assert(plain(node) && safeId(node.id) && !nodeIds.has(node.id), "节点 ID 无效或重复");
      nodeIds.add(node.id);
      assert(["start", "step", "decision", "end", "output", "input", "event", "gateway", "call", "return"].includes(node.type), "节点类型无效");
      assert(node.type !== "return" || flow.kind === "module", "返回节点只能用于公共模块");
      assert(!["call", "return"].includes(node.type) || (node.target == null && node.source == null), "调用和返回节点不能使用固定跨图来源或目标");
      assert(flow.kind !== "module" || node.type !== "input" || node.source == null, "公共模块入口不能固定关联单一调用方");
      assert(node.call == null || node.type === "call", "模块调用配置只能用于调用节点");
      assert(text(node.label, 200) && node.label.trim(), "节点名称不能为空，最多 200 字");
      assert(Number.isFinite(node.x) && Number.isFinite(node.y) && Math.abs(node.x) <= 100000 && Math.abs(node.y) <= 100000, "节点位置超出范围");
      assert(node.pageId === undefined || node.pageId === "" || safeId(node.pageId), "关联页面 ID 无效");
      assert(node.supplement === undefined || typeof node.supplement === "boolean", "补充标记必须为布尔值");
      assert(node.variant === undefined || node.variant === "branch", "节点样式无效");
      assert(node.issues === undefined || (Array.isArray(node.issues) && node.issues.length <= 5 && node.issues.every(v => /^P[0-9]{2}$/.test(v))), "问题编号无效");
      const target = node.type === "output" && node.target != null ? relation(node.target, true) : null;
      if (target) assert(safeId(target.nodeId) && (target.entryPath !== entryPath || target.flowId !== flow.id), "跨图出口必须关联其他流程的具体节点");
      const source = ['input', 'event'].includes(node.type) && node.source != null ? relation(node.source, true) : null;
      if (source) assert(safeId(source.nodeId) && !(source.entryPath === entryPath && source.flowId === flow.id && (node.type === 'input' || source.nodeId === node.id)), '入口来源必须关联有效的来源节点，跨图入口不能关联本图');
      const recovery = node.recovery == null ? null : relation(node.recovery, true);
      if (recovery) {
        assert(Object.keys(node.recovery).every(field => ["entryPath", "flowId", "nodeId"].includes(field)), "异步恢复关联字段无效");
        assert(safeId(recovery.nodeId) && !(recovery.entryPath === entryPath && recovery.flowId === flow.id && recovery.nodeId === node.id), "异步恢复须关联其他具体触发节点");
        assert(node.type !== "end" || !["business", "terminate"].includes(node.endScope), "业务完成或终止节点不能等待异步恢复");
      }
      const semantics = recovery ? { recovery } : {};
      if (node.contract !== undefined) { const contract = parameterContract(node.contract); if (contract) semantics.contract = contract; }
      if (node.type === "call" && node.call != null) semantics.call = moduleCall(node.call);
      if (node.type === 'gateway') { assert(node.gatewayMode === undefined || ['split','join','merge','unspecified'].includes(node.gatewayMode), '并行/汇合模式无效'); semantics.gatewayMode = node.gatewayMode || 'unspecified'; }
      if (source) semantics.source = source;
      if (node.type === 'event') {
        assert(node.eventType === undefined || ['unspecified','message','timer','manual','response'].includes(node.eventType), '事件类型无效');
        assert(node.eventPhase === undefined || ['trigger','intermediate'].includes(node.eventPhase), '事件阶段无效');
        semantics.eventType = node.eventType || 'unspecified'; semantics.eventPhase = node.eventPhase || 'trigger';
      }
      if (node.type === 'end') { assert(node.endScope === undefined || ['unspecified','execution','subprocess','business','terminate'].includes(node.endScope), '结束范围无效'); if (node.endScope) semantics.endScope = node.endScope; }
      return { ...semantics, ...(target ? { target } : {}), ...(node.variant ? {variant:node.variant} : {}), ...(node.issues?.length ? {issues:node.issues} : {}), ...(node.supplement ? { supplement: true } : {}), id: node.id, type: node.type, label: node.label.trim(), x: Math.round(node.x), y: Math.round(node.y), pageId: node.pageId || "" };
    });
    const edgeIds = new Set();
    const edges = flow.edges.map((edge) => {
      assert(plain(edge) && safeId(edge.id) && !edgeIds.has(edge.id), "连线 ID 无效或重复");
      edgeIds.add(edge.id);
      assert(nodeIds.has(edge.source) && nodeIds.has(edge.target), "连线两端必须是当前流程的节点");
      assert(text(edge.label, 200), "连线文字最多 200 字");
      assert(edge.trace === undefined || ["actual", "proposal", "branch"].includes(edge.trace), "连线标记无效");
      return { ...(edge.trace ? {trace:edge.trace} : {}), id: edge.id, source: edge.source, target: edge.target, label: edge.label.trim() };
    });
    const parent = flow.parent == null ? null : relation(flow.parent, true);
    assert(!nodes.some(node => node.type === "return" && edges.some(edge => edge.source === node.id)), "模块返回节点不能有后续连线");
    assert(!parent || parent.entryPath !== entryPath || parent.flowId !== flow.id, "流程不能补充自身");
    return { ...(lanes.length ? {lanes} : {}), ...(flow.kind ? { kind: flow.kind } : {}), id: flow.id, name: flow.name.trim(), description: flow.description, ...(flow.direction === undefined ? {} : { direction: flow.direction }), parent, nodes, edges };
  });
  assert(Array.isArray(data.references) && data.references.length <= 100, "每个需求最多关联 100 个外部流程");
  const referenceIds = new Set();
  const references = data.references.map((item) => {
    const ref = relation(item), identity = key(ref.entryPath, ref.flowId);
    assert(ref.entryPath !== entryPath, "本需求的流程已在列表中，无需重复关联");
    assert(!referenceIds.has(identity), "不能重复关联同一流程");
    referenceIds.add(identity);
    return ref;
  });
  return { applicability: data.applicability, reason: data.reason, flows, references };
}

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
function emptyWorkspace() {
  return { schemaVersion: 1, revision: 0, updatedAt: null, applicability: "undecided", reason: "", flows: [], references: [] };
}
function readFile(file, entryPath) {
  if (!fs.existsSync(file)) return emptyWorkspace();
  try {
    assert(fs.statSync(file).size <= MAX_BYTES, "流程文件最多 2 MB", 413);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(data.schemaVersion === 1 && Number.isInteger(data.revision) && data.revision >= 1, "不支持的流程文件版本", 409);
    return { schemaVersion: 1, revision: data.revision, updatedAt: data.updatedAt || null, ...validateContent(data, entryPath) };
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw new FlowError(409, "流程文件无法读取，原文件未覆盖；请检查 JSON 或恢复备份");
  }
}
function getFlowSummary(entryDir, requirementsRoot) {
  try {
    const file = noSymlink(requirementsRoot, path.join(entryDir, DIRECTORY, FILE_NAME));
    const workspace = readFile(file, path.relative(requirementsRoot, entryDir).split(path.sep).join("/"));
    if (!workspace.revision) return null;
    return { revision: workspace.revision, updatedAt: workspace.updatedAt, applicability: workspace.applicability,
      ownedCount: workspace.flows.length, referenceCount: workspace.references.length };
  } catch { return null; }
}

function validateRelations(loc, previous, next, state) {
    const all = state.entries.filter((item) => item.entry.path !== loc.entry.path);
    all.push({ entry: loc.entry, workspace: next });
    const contract = flow => flow && JSON.stringify([flow.kind, flow.nodes.filter(node => ["input", "return"].includes(node.type)).map(node => [node.id, node.type]).sort()]);
    const changedModule = previous.flows.some(flow => flow.kind === "module" && contract(flow) !== contract(next.flows.find(item => item.id === flow.id)));
    if (changedModule) assert(!state.issues.some(issue => issue.entryPath !== loc.entry.path), "其他需求的流程文件无法读取，无法确认公共模块接口修改影响", 409, state.issues);
    const triggers = workspace => workspace.flows.flatMap(flow => flow.nodes.filter(node => node.type === "event" && (node.eventPhase || "trigger") === "trigger").map(node => [flow.id, node.id, node.eventType]));
    const nextTriggers = new Set(triggers(next).map(item => JSON.stringify(item)));
    if (triggers(previous).some(item => !nextTriggers.has(JSON.stringify(item)))) assert(!state.issues.some(issue => issue.entryPath !== loc.entry.path), "其他需求的流程文件无法读取，无法确认异步恢复入口修改影响", 409, state.issues);
    const oldEntries = state.entries.filter(item => item.entry.path !== loc.entry.path).map(item => ({ entryPath: item.entry.path, workspace: item.workspace }));
    const priorProblems = new Set(moduleProblems([...oldEntries, { entryPath: loc.entry.path, workspace: previous }]).map(moduleProblemKey));
    const introduced = moduleProblems([...oldEntries, { entryPath: loc.entry.path, workspace: next }]).filter(problem => !priorProblems.has(moduleProblemKey(problem)));
    assert(!introduced.length, "本次修改会产生失效的模块调用或返回关系，请先修复相关节点", 409, introduced);
    const priorRecovery = new Set(recoveryProblems([...oldEntries, { entryPath: loc.entry.path, workspace: previous }]).map(moduleProblemKey));
    const introducedRecovery = recoveryProblems([...oldEntries, { entryPath: loc.entry.path, workspace: next }]).filter(problem => !priorRecovery.has(moduleProblemKey(problem)));
    assert(!introducedRecovery.length, "本次修改会产生失效的异步恢复关联，请先修复相关节点", 409, introducedRecovery);
    // Ordinary output links and legacy associations share deletion protection.
    const brokenOutputs = entries => {
      const graph = new Map(), broken = new Set();
      for (const {entryPath, workspace} of entries) for (const flow of workspace.flows) graph.set(key(entryPath, flow.id), flow);
      for (const {entryPath, workspace} of entries) for (const flow of workspace.flows) for (const node of flow.nodes) {
        if (node.type !== "output" || !node.target) continue;
        const ref = node.target;
        if (!graph.get(key(ref.entryPath,ref.flowId))?.nodes.some(n => n.id === ref.nodeId)) broken.add(JSON.stringify([entryPath,flow.id,node.id,ref.entryPath,ref.flowId,ref.nodeId]));
      }
      return broken;
    };
    const previousOutputs = brokenOutputs([...oldEntries,{entryPath:loc.entry.path,workspace:previous}]);
    const nextOutputs = brokenOutputs([...oldEntries,{entryPath:loc.entry.path,workspace:next}]);
    assert(![...nextOutputs].some(ref => !previousOutputs.has(ref)), "本次修改会产生失效的跨图承接，请先处理关联节点", 409);
    const graph = new Map();
    for (const { entry, workspace } of all) for (const flow of workspace.flows) graph.set(key(entry.path, flow.id), { entry, flow });
    const removed = new Set(previous.flows.filter((flow) => !next.flows.some((item) => item.id === flow.id)).map((flow) => flow.id));
    if (removed.size) {
      const unknown = state.issues.filter((issue) => issue.entryPath !== loc.entry.path);
      assert(!unknown.length, "其他需求的流程文件无法读取，无法确认删除影响；请修复后再删除", 409, unknown);
      const dependents = [];
      for (const { entry, workspace } of all) {
        for (const flow of workspace.flows) if (flow.parent?.entryPath === loc.entry.path && removed.has(flow.parent.flowId)) {
          dependents.push({ entryPath: entry.path, feature: entry.feature, flowId: flow.id, name: flow.name, relation: "补充流程" });
        }
        for (const ref of workspace.references) if (ref.entryPath === loc.entry.path && removed.has(ref.flowId)) {
          dependents.push({ entryPath: entry.path, feature: entry.feature, flowId: ref.flowId, relation: "引用" });
        }
      }
      assert(!dependents.length, `流程仍被 ${dependents.map((item) => `${item.feature || item.entryPath}${item.name ? ` / ${item.name}` : ""}`).join("、")} 使用，请先解除关联或改挂`, 409, dependents);
    }
    for (const flow of next.flows) {
      if (!flow.parent) continue;
      const target = graph.get(key(flow.parent.entryPath, flow.parent.flowId));
      const old = previous.flows.find((item) => item.id === flow.id);
      const unchanged = sameRelation(old?.parent, flow.parent);
      assert(target || unchanged, "所选主流程不存在，请重新选择", 409);
      assert(!target || !flow.parent.nodeId || target.flow.nodes.some((node) => node.id === flow.parent.nodeId) || unchanged,
        "所选主流程节点不存在，请重新选择", 409);
    }
    for (const ref of next.references) {
      assert(graph.has(key(ref.entryPath, ref.flowId)) || previous.references.some((item) => sameRelation(item, ref)), "所关联流程不存在，请重新选择", 409);
    }
    for (const flow of next.flows) {
      const seen = new Set();
      let current = key(loc.entry.path, flow.id);
      while (graph.has(current)) {
        assert(!seen.has(current), "补充关系不能形成循环，请选择其他主流程", 409);
        seen.add(current);
        const parent = graph.get(current).flow.parent;
        if (!parent) break;
        current = key(parent.entryPath, parent.flowId);
      }
    }
  }

function createFlowStore(requirementsRoot, findEntry, listEntries) {
  const root = fs.realpathSync(requirementsRoot);
  function locationFromEntry(entry) {
    assert(entry && validEntryPath(entry.path), "需求路径无效", 403);
    const directory = noSymlink(root, path.resolve(root, entry.path, DIRECTORY));
    return { entry, directory, file: noSymlink(root, path.join(directory, FILE_NAME)), history: noSymlink(root, path.join(directory, HISTORY_DIR)) };
  }
  function location(entryPath) {
    assert(validEntryPath(entryPath), "请选择有效的关联需求");
    const entry = findEntry(entryPath);
    assert(entry, "需求不存在", 404);
    return locationFromEntry(entry);
  }
  function snapshot() {
    const entries = [], issues = [];
    for (const entry of listEntries()) {
      try {
        const loc = locationFromEntry(entry);
        entries.push({ entry, workspace: readFile(loc.file, entry.path) });
      } catch (error) { issues.push({ entryPath: entry.path, error: error.status ? error.message : "流程文件无法读取" }); }
    }
    return { entries, issues };
  }
  function saveAt(loc, expectedRevision, content) {
    assert(Number.isInteger(expectedRevision) && expectedRevision >= 0, "缺少有效版本号");
    const previous = readFile(loc.file, loc.entry.path);
    assert(previous.revision === expectedRevision, "流程已在另一窗口更新，请重新加载后再编辑；当前草稿未覆盖文件", 409);
    const next = validateContent(content, loc.entry.path);
    validateRelations(loc, previous, next, snapshot());
    const workspace = { schemaVersion: 1, revision: previous.revision + 1, updatedAt: new Date().toISOString(), ...next };
    const serialized = JSON.stringify(workspace, null, 2);
    assert(Buffer.byteLength(serialized) <= MAX_BYTES, "流程文件最多 2 MB", 413);
    fs.mkdirSync(loc.directory, { recursive: true });
    fs.mkdirSync(loc.history, { recursive: true });
    if (previous.revision > 0) {
      const backup = noSymlink(root, path.join(loc.history, `${previous.revision}.json`));
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(previous, null, 2), { flag: "wx" });
    }
    const temporary = path.join(loc.directory, `.flow-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, serialized, { flag: "wx" }); fs.renameSync(temporary, loc.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return workspace;
  }
  return {
    read(entryPath) { const loc = location(entryPath); return { workspace: readFile(loc.file, loc.entry.path), entry: loc.entry }; },
    save(entryPath, expectedRevision, content) { return saveAt(location(entryPath), expectedRevision, content); },
    catalog() {
      const { entries, issues } = snapshot();
      const flows = entries.flatMap(({ entry, workspace }) => workspace.flows.map((flow) => ({ entryPath: entry.path,
        feature: entry.feature, id: flow.id, name: flow.name, parent: flow.parent, ...(flow.kind ? { kind: flow.kind } : {}),
        nodes: flow.nodes.map((node) => ({ id: node.id, label: node.label, type: node.type, ...(node.call ? { call: node.call } : {}), ...(node.contract ? { contract: node.contract } : {}), ...(node.target ? { target: node.target } : {}), ...(node.recovery ? { recovery: node.recovery } : {}), ...(node.type === "event" ? { eventType: node.eventType, eventPhase: node.eventPhase } : {}) })), updatedAt: workspace.updatedAt })));
      return { flows, issues };
    },
    versions(entryPath) {
      const loc = location(entryPath), current = readFile(loc.file, loc.entry.path);
      const versions = current.revision ? [{ revision: current.revision, updatedAt: current.updatedAt, flowCount: current.flows.length, current: true }] : [];
      if (fs.existsSync(loc.history)) for (const name of fs.readdirSync(loc.history).filter((item) => /^\d+\.json$/.test(item))) {
        if (Number(name.replace(".json", "")) >= current.revision) continue;
        const file = noSymlink(root, path.join(loc.history, name));
        try {
          const data = readFile(file, loc.entry.path);
          versions.push({ revision: data.revision, updatedAt: data.updatedAt, flowCount: data.flows.length, current: false });
        } catch (error) { if (error.status === 403) throw error; }
      }
      return versions.sort((left, right) => right.revision - left.revision);
    },
    restore(entryPath, expectedRevision, revision) {
      const loc = location(entryPath), current = readFile(loc.file, loc.entry.path);
      assert(Number.isInteger(revision) && revision > 0 && revision < current.revision, "请选择有效的历史版本");
      const file = noSymlink(root, path.join(loc.history, `${revision}.json`));
      assert(fs.existsSync(file), "历史版本不存在", 404);
      return saveAt(loc, expectedRevision, readFile(file, loc.entry.path));
    },
  };
}

async function readBody(request, accessMode) {
  assert(canEdit(request, accessMode), "仅本机 localhost 可编辑，当前连接为只读", 403);
  assert(request.headers.origin === `http://${request.headers.host}`, "不允许跨站写入", 403);
  assert(request.headers["x-design-client"] === "workbench-v1", "缺少工作台请求标识", 403);
  assert(/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""), "请使用 JSON 请求", 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; assert(length <= MAX_BYTES, "请求最多 2 MB", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new FlowError(400, "JSON 格式不正确"); }
}
function createFlowHandler(store, sendJson, { accessMode = "local" } = {}) {
  assert(["local", "team"].includes(accessMode), "流程访问模式须为 local 或 team");
  return async (request, response, url) => {
    const entryPath = url.searchParams.get("path");
    try {
      if (request.method === "GET" && url.pathname === "/api/flows/catalog") sendJson(response, 200, await store.catalog());
      else if (request.method === "GET" && url.pathname === "/api/flows") sendJson(response, 200, { ...(await store.read(entryPath)), canEdit: canEdit(request, accessMode), accessMode });
      else if (request.method === "GET" && url.pathname === "/api/flows/export-mermaid") {
        const { workspace } = await store.read(entryPath), flow = workspace.flows.find(item => item.id === url.searchParams.get("flow"));
        assert(flow, "流程不存在", 404);
        const revision = url.searchParams.get("revision");
        assert(revision === null || revision === String(workspace.revision), "流程版本已变化，请重新打开源码后导出", 409);
        const { serializeMermaid } = await import("../public/assets/flow-mermaid-format.mjs");
        const content = serializeMermaid(flow);
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="flow.mmd"; filename*=UTF-8''${encodeURIComponent(flow.name)}.mmd`, "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-store" });
        response.end(content);
      }
      else if (request.method === "GET" && url.pathname === "/api/flows/versions") sendJson(response, 200, { versions: await store.versions(entryPath) });
      else if (request.method === "PUT" && url.pathname === "/api/flows") {
        const body = await readBody(request, accessMode);
        assert(plain(body), "请求内容必须是 JSON 对象");
        sendJson(response, 200, { workspace: await store.save(entryPath, body.expectedRevision, body) });
      } else if (request.method === "POST" && url.pathname === "/api/flows/restore") {
        const body = await readBody(request, accessMode);
        assert(plain(body), "请求内容必须是 JSON 对象");
        sendJson(response, 200, { workspace: await store.restore(entryPath, body.expectedRevision, body.revision) });
      } else sendJson(response, 405, { error: "不支持的流程接口或请求方法" });
    } catch (error) { sendJson(response, error.status || 500, { error: error.status ? error.message : "流程文件操作失败，原文件未主动清理", ...(error.details ? { details: error.details } : {}) }); }
  };
}

module.exports = { createFlowStore, createFlowHandler, getFlowSummary, validateContent, validateRelations, moduleProblems, moduleProblemKey, recoveryProblems, FlowError };
