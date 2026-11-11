import { installFlowInspectorLayout } from "./flow-inspector-layout.js";
import { bindCopyButton } from "./ai-context.js";
import { createContractEditor } from "./flow-contract-editor.js";
import { contractRelations, formatContractCopy } from "./flow-contracts.mjs";
import { icon, controlHint, iconButton, iconButtons } from "./workbench-icons.js";
import { createFlowAnnotations } from "./flow-annotations.js";
import { parseMermaid, serializeMermaid } from "./flow-mermaid.js";
import { dimensions, center, nodeBox, edgeGeometry, graphGeometry, anchor, curveGeometry } from "./flow-geometry.js";
import { nodeTextLayout, arrowSize } from "./flow-text.js";
import { snapDelta, canvasWheel } from "./design-navigation.js";
import { resolveModuleCall, moduleCallers, resolveModuleReturn, planModuleCallEdges } from "./flow-modules.mjs";
import { nodeTarget, isTrigger, resolveFlowTarget, flowSources } from "./flow-links.mjs";
import { installWorkspaceBridge } from "./workspace-bridge.js";
import { createRouteAudit } from "./flow-route-audit.js";

const $ = (id) => document.getElementById(id);
const MIN_FLOW_SCALE = .0001;
iconButtons(document, [
  ["annotationsToggle", "note", "元素说明"],
  ["copySelection", "copy", "复制节点信息"],
  ["copyFlowName", "copy", "复制流程名称"],
  ["annotationsEmbedToggle", "note", "元素说明"],
  ["versionsButton", "history", "版本历史"],
  ["mermaidButton", "code", "Mermaid 源码"],
  ["exportButton", "download", "导出 SVG"],
  ["linkButton", "link", "关联已有流程"],
  ["startConnection", "connect", "从此节点连线"],
  ["deleteFlow", "trash", "删除流程"],
  ["mermaidClose", "close", "关闭 Mermaid 编辑器"],
  ["mermaidImport", "upload", "导入 Mermaid 文件"],
  ["mermaidExport", "download", "导出 Mermaid 文件"],
  ["mermaidReset", "refresh", "还原源码"],
  ["undoButton", "undo", "撤销", "⌘/Ctrl Z"],
  ["redoButton", "redo", "重做", "⌘/Ctrl Shift Z"],
  ["addButton", "plus", "新建流程"],
  ["settingsButton", "settings", "流程设置"],
  ["helpButton", "help", "快捷键"],
  ["selectTool", "select", "选择", "V"],
  ["panTool", "hand", "拖动画布", "H / 空格"],
  ["connectTool", "connect", "连线", "C"],
  ["fitButton", "expand", "适应画布", "Shift 1"],
  ["zoomOut", "minus", "缩小"],
  ["zoomIn", "plus", "放大"],
  ["flowSettings", "settings", "流程属性"],
  ["unlinkButton", "unlink", "移除流程关联"]
]);
for (const button of document.querySelectorAll('[data-add-node]')) iconButton(button, ({call:'step',return:'output'})[button.dataset.addNode] || button.dataset.addNode, button.getAttribute('aria-label'));
for (const button of document.querySelectorAll('.dialog-heading [data-close]')) iconButton(button, 'close', button.dataset.close === 'libraryDialog' ? '关闭流程选择' : `关闭${button.closest('dialog').querySelector('h2').textContent}`);
controlHint($('zoomLabel'), '还原到 100%');
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const copy = (value) => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const params = new URLSearchParams(location.search);
const startupAction = params.get("action") || "";
const embedded = params.get("embed") === "1";
const shell = params.get("shell") === "1";
const returnParams = params.get("return") || "";
const state = { path: params.get("path") || "", entry: null, tree: [], workspace: null, catalog: [], catalogIssues: [], catalogError: "", canEdit: false, busy: false, error: "", dirty: false, source: "", flowId: params.get("flow") || "", external: null, node: "", edge: "", mode: "select", connectFrom: "", view: { x: 60, y: 80, scale: 1 }, history: [], index: 0, saved: "", loadToken: 0, selectionToken: 0, libraryMode: "link", libraryKey: "" };
document.body.classList.toggle("embedded", embedded);
document.body.classList.toggle("workspace-shell", shell);
if (shell) {
  for (const id of ["undoButton", "redoButton", "versionsButton", "mermaidButton", "saveButton"]) $("flowHistoryActions").append($(id));
  document.querySelector(".inspector-tabs").insertBefore($("annotationsToggle"), $("exportButton"));
}

Object.assign(state, { inspectorEditing: false, inspectorTab: "properties", inspectorSelection: "", saving: false, savePaused: false, conflict: false, fieldDrafts: {}, recovery: null });
let autosaveTimer = null, savePromise = null, workspaceBridge = null, initialization = null, initialized = false;
let mermaidSession = null, mermaidTimer = null, flowRename = null, flowListContentKey = "";
const sourceDraft = () => Object.values(state.fieldDrafts).find(field => field.control === "mermaidSource");
const contractDraft = () => Object.values(state.fieldDrafts).find(field => field.control === "contractEditor");
const composing = new Set();
const dataDirty = () => !!state.workspace && serialized() !== state.saved;
const incomplete = () => Object.keys(state.fieldDrafts).length > 0;
const draftKey = (entryPath = state.path) => `requirements-flow-draft:v1:${entryPath}`;
const key = (entryPath, flowId) => JSON.stringify([entryPath, flowId]);
const payload = () => ({ applicability: state.workspace.applicability, reason: state.workspace.reason, flows: state.workspace.flows, references: state.workspace.references });
const serialized = () => JSON.stringify(payload());
const owned = () => state.source === state.path;
const flow = () => owned() ? state.workspace?.flows.find((item) => item.id === state.flowId) : state.external?.workspace.flows.find((item) => item.id === state.flowId);
const editable = () => state.canEdit && !embedded && !state.busy && !state.recovery;
const graphEditable = () => editable() && owned() && !!flow();
const node = () => flow()?.nodes.find((item) => item.id === state.node);
const edge = () => flow()?.edges.find((item) => item.id === state.edge);
const routeAudit=createRouteAudit({dialog:$("routeAuditDialog"),trigger:$("routeAuditOpen"),returnButton:$("routeAuditReturn"),
  getContext:()=>({path:state.path}),
  guard:()=>dataDirty() || incomplete() || state.saving || state.recovery || annotations.getStatus?.().dirty ? guard() : true,
  async locate(ref) {
    await navigateFlow(ref.entryPath,ref.flowId,ref.nodeId,true);
    if(!ref.edgeId || state.source!==ref.entryPath || state.flowId!==ref.flowId)return;
    const selected=flow()?.edges.find(e=>e.id===ref.edgeId);
    if(!selected)return;
    const endpoints=[selected.source,selected.target].map(id=>flow().nodes.find(n=>n.id===id)).filter(Boolean).map(center);
    if(endpoints.length===2){
      state.view.x=$("viewport").clientWidth/2-(endpoints[0].x+endpoints[1].x)/2*state.view.scale;
      state.view.y=$("viewport").clientHeight/2-(endpoints[0].y+endpoints[1].y)/2*state.view.scale;
    }
    state.node="";state.edge=selected.id;renderInspector();renderCanvas();saveView();
  },
  onHighlight:()=>routeAudit.paint($("graph"),state.source,state.flowId),onVisibility:()=>workspaceBridge?.notify()});
bindCopyButton({ button: $("copyFlowName"), label: "复制流程名称", success: "已复制流程名称", getText: () => flow()?.name || "" });
const contractEditor = createContractEditor({
  context: () => ({path:state.source,flow:flow() ? {...flow(),entryPath:state.source} : null,node:node(),editable:graphEditable() && state.inspectorEditing,canEdit:graphEditable(),flows:moduleCatalog(),callContext:currentModuleContext()}),
  getNode: (flowId,nodeId,entryPath) => entryPath === state.path ? state.workspace?.flows.find(f=>f.id===flowId)?.nodes.find(n=>n.id===nodeId) : null,
  canEdit: entryPath => entryPath === state.path && editable(),
  newId: uid, notify: toast, beginEditing: () => { state.inspectorTab="contract";setInspectorEditing(true); },
  getDraft: key => state.fieldDrafts[key], drafts: () => Object.values(state.fieldDrafts),
  setDraft(key,value) { state.fieldDrafts[key]=value;state.dirty=dataDirty()||incomplete();persistDraft();renderStatus(); },
  removeDraft(key) { delete state.fieldDrafts[key];state.dirty=dataDirty()||incomplete();persistDraft();renderStatus(); },
  commit(context,row) { mutate(()=>{
    const n=state.workspace.flows.find(f=>f.id===context.flowId)?.nodes.find(n=>n.id===context.nodeId);if(!n)return;
    n.contract ||= {inputs:[],outputs:[]};n.contract[context.direction] ||= [];
    const index=n.contract[context.direction].findIndex(item=>item.id===row.id);
    if(index<0)n.contract[context.direction].push(row);else n.contract[context.direction][index]=row;
  }); },
  remove(flowId,nodeId,direction,rowId) { mutate(()=>{
    const n=state.workspace.flows.find(f=>f.id===flowId)?.nodes.find(n=>n.id===nodeId);if(!n?.contract)return;
    n.contract[direction]=(n.contract[direction]||[]).filter(row=>row.id!==rowId);
    delete state.fieldDrafts[`contractEditor:${flowId}:${nodeId}:${direction}:${rowId}`];
    if(!n.contract.inputs?.length&&!n.contract.outputs?.length)delete n.contract;
  }); },
  async navigate(ref) { if(await guard())await navigateFlow(ref.entryPath,ref.flowId,ref.nodeId,true); }
});
bindCopyButton({ button: $("copySelection"), label: "复制元素信息", success: "已复制节点信息、参数与承接位置", flush: async () => {
  const identity=JSON.stringify([state.source,state.flowId,state.node,state.edge]);
  if(!await guard())return false;
  if(identity!==JSON.stringify([state.source,state.flowId,state.node,state.edge]))throw new Error('所选元素已切换，请重新复制。');
  return true;
}, getText: () => {
  const current = flow(), selected = node() || edge();
  if (!current || !selected) return "";
  const query = new URLSearchParams({ path: state.source || state.path, view: "flow", flow: current.id });
  if (node()) query.set("node", selected.id);
  const kind = node() ? "节点" : "连线";
  const details=node() ? formatContractCopy(selected.contract,contractRelations(moduleCatalog(),{...current,entryPath:state.source},selected,currentModuleContext())) : "";
  return `需求：${sourceEntry()?.feature || state.source || state.path}
流程：${current.name}
${kind}：${selected.label || "未命名连线"}
${kind} ID：${selected.id}
流程 ID：${current.id}${edge() ? `
连线：${selected.source} → ${selected.target}` : ""}
定位：${location.origin}/#${query}${details ? `\n\n${details}` : ""}`;
} });
const sourceEntry = () => {
  const entry = owned() ? state.entry : state.external?.entry;
  // Workspace endpoints return filesystem metadata; the tree hydrates the
  // current database page catalog, including pages with no source JSON file.
  const catalogEntry = state.tree.find(item => item.path === state.source);
  return entry ? { ...entry, design: catalogEntry?.design || entry.design } : catalogEntry;
};
const annotations = createFlowAnnotations({
  onStatusChange() { queueMicrotask(() => renderStatus()); },
  getContext() {
    const current = flow(), selected = node() ? { type: "flow-node", flowId: state.flowId, nodeId: state.node } : edge() ? { type: "flow-edge", flowId: state.flowId, edgeId: state.edge } : null;
    let savedFlows = [];
    try { savedFlows = owned() ? JSON.parse(state.saved || "{}").flows || [] : state.external?.workspace.flows || []; } catch {}
    const savedFlow = savedFlows.find((item) => item.id === state.flowId);
    const savedTarget = selected?.type === "flow-node" ? savedFlow?.nodes.some((item) => item.id === selected.nodeId) : selected?.type === "flow-edge" ? savedFlow?.edges.some((item) => item.id === selected.edgeId) : false;
    return { sourcePath: state.source || state.path, flowId: state.flowId, flows: owned() ? state.workspace?.flows || [] : state.external?.workspace.flows || [], selection: selected, inspectorEditing: state.inspectorEditing, editableSource: owned() && editable(), bindable: !dataDirty() && !!savedTarget && !!current, flowDirty: state.dirty, flowSaving: state.saving, flushFlow, embedded, reference: !owned() && !!state.source, sourceName: sourceEntry()?.feature || "元素说明", sourceUrl: relatedUrl(state.source || state.path, state.flowId) };
  },
  markerPoint(target) {
    const current = displayFlow(); if (!current || target.flowId !== current.id) return null;
    if (target.type === "flow-node") { const item = current.nodes.find((n) => n.id === target.nodeId); return item ? { x: item.x + dimensions(item).w + 2, y: item.y - 2 } : null; }
    const item = current.edges.find((e) => e.id === target.edgeId), geometry = item && geometryFor(current).get(item.id); return geometry ? { x: geometry.x + 12, y: geometry.y - 10 } : null;
  },
  locate(target) {
    if (target.flowId !== state.flowId) return;
    state.node = target.type === "flow-node" ? target.nodeId : ""; state.edge = target.type === "flow-edge" ? target.edgeId : "";
    const point = node() ? center(node()) : edge() ? geometryFor(flow()).get(edge().id) : null;
    if (point) { state.view.x = $("viewport").clientWidth / 2 - point.x * state.view.scale; state.view.y = $("viewport").clientHeight / 2 - point.y * state.view.scale; }
    renderInspector(); renderCanvas(); renderStatus(); saveView();
  },
});
function catalog() {
  return [...state.catalog.filter((item) => item.entryPath !== state.path), ...(state.workspace?.flows || []).map((item) => ({ entryPath: state.path, feature: state.entry?.feature || "", ...item }))];
}
const findFlow = (entryPath, flowId) => catalog().find((item) => item.entryPath === entryPath && item.id === flowId);
const children = () => catalog().filter((item) => item.parent?.entryPath === state.source && item.parent?.flowId === state.flowId);
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $("toast").hidden = true; }, 6000); }
async function api(url, options) { const response = await fetch(url, { cache: "no-store", ...options }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error || "请求失败，请重试"); error.status = response.status; throw error; } return data; }
function writeOptions(body, method = "PUT") { return { method, headers: { "Content-Type": "application/json", "X-Design-Client": "workbench-v1" }, body: JSON.stringify(body) }; }
function portalUrl(view = "flow", doc = "requirement") { const hash = new URLSearchParams({ path: state.path, view }); if (view === "doc") hash.set("doc", doc); if (view === "flow" && state.flowId) { hash.set("flow", state.flowId); if (!owned()) hash.set("flowSource", state.source); } return `/#${hash}`; }
function editorUrl(entryPath, flowId, extra = {}) { const query = new URLSearchParams({ path: entryPath, ...(flowId ? { flow: flowId } : {}), ...(returnParams ? { return: returnParams } : {}) }); Object.entries(extra).forEach(([name, value]) => { if (value) query.set(name, value); }); return `/flow?${query}`; }
function currentUrl() { return editorUrl(state.path, state.flowId, { flowSource: owned() ? "" : state.source, fromPath: params.get("fromPath"), fromFlow: params.get("fromFlow"), fromSource: params.get("fromSource"), shell: shell ? "1" : "", shellToken: params.get("shellToken") }); }
function updatePageLink() {
  const current = node();
  const page = (sourceEntry()?.design?.pages || []).find(item => item.id === current?.pageId);
  $("openPageCompactLink").hidden = !page;
  if (page) {
    const href = `/design?${new URLSearchParams({ path: state.source, page: current.pageId, return: portalUrl().slice(2), flowReturn: pageReturnUrl() })}`;
    $("openPageLink").href = href; $("openPageCompactLink").href = href;
    $("openPageLink").textContent = `查看 ${page.name} ↗`;
    $("openPageCompactLink").textContent = `查看 ${page.name} ↗`;
  }
}
function pageReturnUrl() {
  const url = new URL(currentUrl(), location.origin);
  for (const [key, value] of Object.entries({node: state.node, zoom: state.view.scale, x: state.view.x, y: state.view.y})) url.searchParams.set(key, String(value));
  url.searchParams.delete("shell"); url.searchParams.delete("shellToken");
  return url.pathname + url.search;
}
function relatedUrl(entryPath, flowId) { return editorUrl(entryPath, flowId, { fromPath: state.path, fromFlow: state.flowId, fromSource: owned() ? "" : state.source }); }
function syncLocation() {
  if (!embedded) history.replaceState(null, "", currentUrl());
  const previous = new URLSearchParams(returnParams);
  if (previous.get("view") === "flow" && previous.get("path") === state.path) {
    if (state.flowId) previous.set("flow", state.flowId); else previous.delete("flow");
    if (state.flowId && !owned()) previous.set("flowSource", state.source); else previous.delete("flowSource");
  }
  $("portalLink").href = returnParams ? `/#${previous}` : portalUrl();
  $("requirementLink").href = portalUrl("doc"); $("specLink").href = portalUrl("doc", "spec"); $("pageLink").href = portalUrl("doc", "page"); $("contractLink").href = portalUrl("doc", "contract");
  $("designLink").href = `/design?${new URLSearchParams({ path: state.path, return: portalUrl().slice(2), flowReturn: pageReturnUrl() })}`;
}
function record() {
  const snapshot = serialized();
  if (snapshot !== state.history[state.index]) { state.history = state.history.slice(0, state.index + 1); state.history.push(snapshot); let size = state.history.reduce((sum, value) => sum + value.length, 0); while (state.history.length > 2 && (state.history.length > 30 || size > 8000000)) size -= state.history.shift().length; state.index = state.history.length - 1; }
  pruneFieldDrafts(); state.dirty = snapshot !== state.saved || incomplete(); persistDraft(); render(); scheduleAutosave();
}
function mutate(fn) { if (!editable()) return; fn(); record(); }
function undo(direction) { if (!editable()) return; if (flowRename) { finishFlowRename(false); return; } if (incomplete()) { state.fieldDrafts = {}; composing.clear(); state.dirty = dataDirty(); persistDraft(); render(); scheduleAutosave(); return; } const index = state.index + direction; if (index < 0 || index >= state.history.length) return; state.index = index; Object.assign(state.workspace, JSON.parse(state.history[index])); state.dirty = dataDirty(); if (owned() && !flow()) state.flowId = state.workspace.flows[0]?.id || ""; state.node = ""; state.edge = ""; state.connectFrom = ""; persistDraft(); render(); scheduleAutosave(); }
async function refreshCatalog() {
  try { const data = await api("/api/flows/catalog"); state.catalog = data.flows; state.catalogIssues = data.issues || []; state.catalogError = ""; }
  catch (error) { state.catalogError = error.message; }
}
function saveView() { if (!state.flowId) return; try { sessionStorage.setItem(`flow-view:${key(state.source, state.flowId)}`, JSON.stringify({ ...state.view, node: state.node, width: $("viewport").clientWidth, height: $("viewport").clientHeight })); } catch {} }
function restoreView() { try { const v = JSON.parse(sessionStorage.getItem(`flow-view:${key(state.source, state.flowId)}`)); if (v && [v.x, v.y, v.scale].every(Number.isFinite) && v.scale >= MIN_FLOW_SCALE && v.scale <= 2.5 && Math.abs((v.width || 0) - $("viewport").clientWidth) < 60 && Math.abs((v.height || 0) - $("viewport").clientHeight) < 100) { state.view = { x: v.x, y: v.y, scale: v.scale }; state.node = flow()?.nodes.some((n) => n.id === v.node) ? v.node : ""; renderInspector(); renderCanvas(); renderStatus(); return; } } catch {} fit(); }
async function choose(entryPath, flowId, remember = true, preserveCallContext = false) {
  if (!await annotations.beforeContextChange(entryPath, flowId)) return false;
  // Only navigation through the current module invocation retains a caller.
  // Sidebar/library/bridge selections open a definition without an invocation.
  if (!preserveCallContext) { moduleCallStack.length = 0; browseReturn = null; }
  finishDrag(true); if (remember) saveView(); const token = ++state.selectionToken;
  for(const ancestor of flowAncestors(findFlow(entryPath,flowId),entryPath)) if(ancestor.id !== flowId || ancestor.entryPath !== entryPath) collapsedFlowBranches.delete(key(ancestor.entryPath,ancestor.id));
  state.source = entryPath; state.flowId = flowId; state.node = ""; state.edge = ""; state.external = null; state.connectFrom = ""; setMode("select"); render();
  if (entryPath !== state.path) {
    try { const data = await api(`/api/flows?${new URLSearchParams({ path: entryPath })}`); if (token !== state.selectionToken) return; state.external = data; }
    catch (error) { if (token !== state.selectionToken) return; toast(`来源不可用：${error.message}`); }
  }
  if (token !== state.selectionToken) return false; render(); restoreView(); return true;
}
async function load(entryPath, requestedFlow = "", requestedSource = "", discard = false) {
  if (!discard && state.workspace && !await guard()) return;
  clearTimeout(autosaveTimer);
  moduleCallStack.length = 0; browseReturn = null;
  const token = ++state.loadToken; ++state.selectionToken; state.busy = true; state.error = ""; state.canEdit = false; state.path = entryPath; state.workspace = null; state.fieldDrafts = {}; state.recovery = null; state.savePaused = false; state.conflict = false; composing.clear(); renderStatus();
  try {
    const [data] = await Promise.all([api(`/api/flows?${new URLSearchParams({ path: entryPath })}`), refreshCatalog()]);
    if (token !== state.loadToken) return;
    state.workspace = data.workspace; state.entry = data.entry; state.canEdit = data.canEdit; state.saved = serialized(); state.history = [state.saved]; state.index = 0; state.dirty = false; state.busy = false; state.source = entryPath;
    recoverDraft();
    $("featureTitle").textContent = data.entry.feature; $("requirementSelect").value = entryPath; document.title = `${data.entry.feature} · 流程工作台`;
    const reference = state.workspace.references.find((item) => item.flowId === requestedFlow && (!requestedSource || item.entryPath === requestedSource));
    const own = (!requestedSource || requestedSource === entryPath) && state.workspace.flows.find((item) => item.id === requestedFlow);
    const target = own ? { entryPath, flowId: own.id } : reference || (requestedFlow ? { entryPath: requestedSource || entryPath, flowId: requestedFlow } : null) || (state.workspace.flows[0] ? { entryPath, flowId: state.workspace.flows[0].id } : state.workspace.references[0]);
    await choose(target?.entryPath || entryPath, target?.flowId || "", false);
    scheduleAutosave();
  } catch (error) { if (token !== state.loadToken) return; state.busy = false; state.error = error.message; $("emptyCanvas").hidden = false; $("emptyDescription").textContent = error.message; $("graph").innerHTML = ""; renderStatus(); toast(error.message); }
}
function persistDraft() {
  if (!state.workspace || !state.path || state.recovery || embedded || !state.canEdit) return;
  try {
    if (dataDirty() || incomplete()) localStorage.setItem(draftKey(), JSON.stringify({ schemaVersion: 1, path: state.path, baseRevision: state.workspace.revision, base: state.saved, content: payload(), fields: state.fieldDrafts, paused: state.savePaused, updatedAt: new Date().toISOString() }));
    else localStorage.removeItem(draftKey());
    state.storageError = "";
  } catch { state.storageError = "本机草稿缓存不可用，请保持此窗口打开，等待自动保存完成。"; }
}
function safeDraftContent(content) {
  const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  return content && ["undecided", "needed", "not-needed"].includes(content.applicability) && typeof content.reason === "string"
    && Array.isArray(content.references) && content.references.length <= 100 && content.references.every((r) => r && typeof r.entryPath === "string" && id(r.flowId))
    && Array.isArray(content.flows) && content.flows.length <= 40 && content.flows.every((f) => f && id(f.id) && typeof f.name === "string" && f.name.trim() && typeof f.description === "string"
      && (f.direction === undefined || ["TD", "TB", "BT", "LR", "RL"].includes(f.direction))
      && (!f.parent || typeof f.parent.entryPath === "string" && id(f.parent.flowId) && (!f.parent.nodeId || id(f.parent.nodeId)))
      && Array.isArray(f.nodes) && f.nodes.length <= 100 && f.nodes.every((n) => n && id(n.id) && ["start", "step", "decision", "end", "output", "input", "event", "gateway", "call", "return"].includes(n.type) && typeof n.label === "string" && n.label.trim() && Number.isFinite(n.x) && Number.isFinite(n.y))
      && Array.isArray(f.edges) && f.edges.length <= 200 && f.edges.every((e) => e && id(e.id) && typeof e.label === "string" && f.nodes.some((n) => n.id === e.source) && f.nodes.some((n) => n.id === e.target)));
}
function recoverDraft() {
  if (!state.canEdit || embedded) return;
  let raw; try { raw = localStorage.getItem(draftKey()); } catch { return; }
  if (!raw) return;
  let cached; try { cached = JSON.parse(raw); } catch { cached = null; }
  if (!cached || cached.schemaVersion !== 1 || cached.path !== state.path || !safeDraftContent(cached.content)) {
    state.recovery = { raw }; state.savePaused = true; state.error = "本地流程草稿无法直接恢复，请先下载留存或使用当前版本。"; return;
  }
  const fields = Object.fromEntries(Object.entries(cached.fields || {}).filter(([, field]) => field && ["flowName", "flowDescription", "nodeLabel", "mermaidSource", "contractEditor"].includes(field.control) && typeof field.flowId === "string" && typeof field.value === "string").map(([name, field]) => [name, { ...field, ...(field.control === "mermaidSource" ? { error: field.error || "Mermaid 源码尚未完成" } : {}), composing: false }]));
  const alreadySaved = JSON.stringify(cached.content) === state.saved;
  if (!alreadySaved && (cached.baseRevision !== state.workspace.revision || cached.base !== state.saved)) {
    state.recovery = cached; state.savePaused = true; state.conflict = true; state.error = "发现本地草稿，但远端版本已变化。已停止自动保存，请下载草稿核对后使用当前版本。"; return;
  }
  if (!alreadySaved) Object.assign(state.workspace, copy(cached.content));
  state.fieldDrafts = fields; pruneFieldDrafts(); state.dirty = dataDirty() || incomplete();
  if (dataDirty()) { state.history.push(serialized()); state.index = 1; }
  if (cached.paused && state.dirty) { state.savePaused = true; state.error = "已恢复未保存草稿，自动保存已暂停。检查后点击重试。"; }
  persistDraft();
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!editable() || state.savePaused || !dataDirty()) return;
  autosaveTimer = setTimeout(() => { if (composing.size || drag?.type === "node") { scheduleAutosave(); return; } void saveSnapshot(); }, 600);
}
function saveSnapshot() {
  if (savePromise) return savePromise;
  if (state.savePaused || state.recovery || !editable()) return Promise.resolve(false);
  if (!dataDirty()) return Promise.resolve(true);
  const entryPath = state.path, generation = state.loadToken, expectedRevision = state.workspace.revision;
  const submitted = copy(payload()), submittedText = JSON.stringify(submitted);
  state.saving = true; renderStatus();
  savePromise = (async () => {
    try {
      const data = await api(`/api/flows?${new URLSearchParams({ path: entryPath })}`, writeOptions({ expectedRevision, ...submitted }));
      if (entryPath !== state.path || generation !== state.loadToken) return false;
      const clean = { applicability: data.workspace.applicability, reason: data.workspace.reason, flows: data.workspace.flows, references: data.workspace.references };
      // Only normalize the submitted state if the user has not changed it in flight.
      if (serialized() === submittedText) Object.assign(state.workspace, clean);
      state.workspace.revision = data.workspace.revision; state.workspace.updatedAt = data.workspace.updatedAt;
      state.saved = JSON.stringify(clean); state.dirty = dataDirty() || incomplete(); state.error = ""; state.conflict = false;
      persistDraft(); annotations.sync(); await refreshCatalog(); return true;
    } catch (error) {
      if (entryPath !== state.path || generation !== state.loadToken) return false;
      state.error = error.message; state.savePaused = true; state.conflict = error.status === 409; state.dirty = dataDirty() || incomplete(); persistDraft();
      toast(`${error.message}\n自动保存已暂停，本地草稿已保留。`); return false;
    } finally {
      state.saving = false; savePromise = null; renderStatus(); scheduleAutosave();
    }
  })();
  return savePromise;
}
async function flushFlow({ retry = false } = {}) {
  finishDrag(); clearTimeout(autosaveTimer);
  if (!finishFlowRename()) return false;
  if ($("mermaidDialog").open && !applyMermaid()) return false;
  if (state.recovery) { renderStatus(); return false; }
  if (retry) { state.savePaused = false; state.error = ""; }
  if (state.savePaused) { renderStatus(); return false; }
  if (composing.size) { toast("请先完成正在输入的文字。更改已保留在当前页面。"); return false; }
  while (state.saving || dataDirty()) {
    const success = state.saving ? await savePromise : await saveSnapshot();
    clearTimeout(autosaveTimer); if (!success) return false;
  }
  state.dirty = incomplete(); persistDraft(); renderStatus();
  if (incomplete()) { toast(contractDraft() ? "参数尚未填写完整，请继续填写或撤销未完成输入。" : sourceDraft() ? "Mermaid 源码尚未完成，请继续编辑或还原源码后再离开。" : "请补全空白名称，或撤销这次输入后再离开。"); return false; }
  return true;
}
async function save() { if (!await flushFlow({ retry: true })) return false; return annotations.flush ? await annotations.flush() : await annotations.guard(); }
function confirmAction(title, message, { leave = false, action = "确定" } = {}) {
  $("confirmTitle").textContent = title; $("confirmText").textContent = message; $("confirmButton").textContent = leave ? "保存并继续" : action; $("discardButton").hidden = !leave; $("confirmDialog").returnValue = "cancel"; $("confirmDialog").showModal();
  return new Promise((resolve) => $("confirmDialog").addEventListener("close", () => resolve($("confirmDialog").returnValue), { once: true }));
}
async function guard() { if (!await flushFlow()) return false; return annotations.flush ? await annotations.flush() : await annotations.guard(); }
function renderStatus() {
  const available = !!state.workspace && !state.busy;
  const noteStatus = annotations.getStatus?.() || {};
  $("saveState").textContent = state.busy ? "正在加载…" : state.error || noteStatus.error ? "自动保存已暂停" : !state.canEdit || embedded ? "只读" : state.saving || noteStatus.saving ? "正在自动保存…" : flowRename ? "正在编辑名称" : incomplete() ? contractDraft() ? "参数尚未完成" : sourceDraft() ? sourceDraft().error ? "源码尚未完成" : "等待自动保存" : "请补全名称" : state.dirty || noteStatus.dirty ? "等待自动保存" : "已自动保存";
  $("saveState").title = state.error || noteStatus.error || "更改会自动保存";
  $("saveState").className = state.error ? "error" : state.dirty ? "dirty" : "";
  $("saveButton").hidden = !state.savePaused || !!state.recovery; $("saveButton").textContent = "重试保存"; $("saveButton").disabled = !editable() || state.saving;
  $("undoButton").disabled = !editable() || state.index <= 0 && !incomplete(); $("redoButton").disabled = !editable() || state.index >= state.history.length - 1;
  for (const id of ["addButton", "linkButton", "settingsButton", "emptyAdd", "emptyLink", "emptyNone"]) $(id).disabled = !available || !editable();
  $("mermaidButton").disabled = !available || !flow() && (!editable() || state.workspace.flows.length >= 40);
  $("versionsButton").disabled = !available || !state.workspace.revision; $("exportButton").disabled = !flow();
  for (const button of document.querySelectorAll("[data-add-node],#connectTool,#startConnection,#addSupplement,#deleteSelection")) button.disabled = !graphEditable();
  for (const id of ["nodeType", "nodeStyle", "nodePage", "flowKind", "configureCall", "outputTarget", "nodeSource", "eventType", "eventPhase", "endScope", "gatewayMode", "parentButton", "detachParent", "deleteFlow"]) $(id).disabled = !graphEditable();
  for (const id of ["flowName", "flowDescription", "nodeLabel"]) { $(id).disabled = false; $(id).readOnly = !graphEditable(); }
  $("copySelection").disabled = !node() && !edge(); $("copyFlowName").disabled = !flow();
  $("flowAppearanceButton").disabled = !graphEditable();
  $("routeAuditOpen").disabled = !state.workspace || state.busy;
  $("unlinkButton").disabled = !editable(); $("requirementSelect").disabled = state.busy;
  $("flowSaveNotice").hidden = !(state.error || state.storageError || incomplete() && (!sourceDraft() || sourceDraft().error) && !(flowRename && Object.keys(state.fieldDrafts).every(name => name === `flowName:${flowRename.id}`)));
  $("flowSaveMessage").textContent = state.error || state.storageError || (contractDraft() ? "参数尚未填写完整，草稿已保留。继续填写后将自动保存。" : sourceDraft() ? "Mermaid 源码尚未完成。草稿已保留，画布仍显示上一版流程。" : "名称尚未填写完整，已保留原内容。补全后将自动保存。");
  $("downloadFlowDraft").hidden = !(state.savePaused || state.recovery); $("useRemoteFlow").hidden = !(state.conflict || state.recovery);
  $("focusFlowDraft").hidden = !incomplete();
  document.body.classList.toggle("readonly", !graphEditable());
  if ($("mermaidDialog").open) syncMermaidExport();
  workspaceBridge?.notify();
}
function fieldBinding(control) {
  const current = flow(); if (!current || !owned()) return null;
  if (control === "flowName" || control === "flowDescription") return { control, flowId: current.id, itemId: "", kind: "flow", field: control === "flowName" ? "name" : "description", required: control === "flowName", object: current, key: `${control}:${current.id}` };
  const selected = node() || edge(); if (!selected) return null;
  return { control, flowId: current.id, itemId: selected.id, kind: node() ? "node" : "edge", field: "label", required: !!node(), object: selected, key: `nodeLabel:${current.id}:${selected.id}` };
}
function pruneFieldDrafts() {
  for (const [name, field] of Object.entries(state.fieldDrafts)) {
    const current = state.workspace?.flows.find((f) => f.id === field.flowId);
    if (field.control === "mermaidSource" && field.isNew && !current) continue;
    if (!current || field.kind === "node" && !current.nodes.some((n) => n.id === field.itemId) || field.kind === "edge" && !current.edges.some((e) => e.id === field.itemId)) delete state.fieldDrafts[name];
  }
}
function renderField(control, value) {
  const input = $(control), binding = fieldBinding(control), pending = binding && state.fieldDrafts[binding.key];
  if (document.activeElement !== input || input.dataset.binding !== binding?.key) input.value = pending ? pending.value : value;
  input.dataset.binding = binding?.key || "";
}
function editField(control) {
  if (!graphEditable()) return;
  const binding = fieldBinding(control); if (!binding) return;
  const raw = $(control).value, value = control === "flowDescription" ? raw : raw.trim();
  if (composing.has(control) || binding.required && !value) {
    const { object, ...metadata } = binding;
    state.fieldDrafts[binding.key] = { ...metadata, value: raw, composing: composing.has(control) };
    state.dirty = true; persistDraft(); renderStatus(); return;
  }
  delete state.fieldDrafts[binding.key]; binding.object[binding.field] = value; record();
}
function updateFlowList(markup) {
  const list = $("flowList"), template = document.createElement("template");
  template.innerHTML = markup;
  const rowKey = item => item.dataset.flowRow ? key(item.dataset.flowSource, item.dataset.flowRow) : `${item.tagName}:${item.textContent}`;
  const existing = new Map([...list.children].map(item => [rowKey(item), item]));
  const next = [...template.content.children].map(fresh => {
    const current = existing.get(rowKey(fresh));
    if (!current) return fresh;
    if (current.outerHTML === fresh.outerHTML) return current;
    const oldButton = current.querySelector("[data-select-flow]"), newButton = fresh.querySelector("[data-select-flow]");
    if (!oldButton || !newButton) return fresh;
    // Preserve the pressed row and button when another row commits on focusout.
    current.className = fresh.className; oldButton.className = newButton.className;
    if (newButton.hasAttribute("aria-current")) oldButton.setAttribute("aria-current", "true"); else oldButton.removeAttribute("aria-current");
    for (const selector of ["strong", "small"]) {
      const target = oldButton.querySelector(selector), incoming = newButton.querySelector(selector);
      if (target && incoming && target.textContent !== incoming.textContent) target.textContent = incoming.textContent;
    }
    const oldRename = current.querySelector("[data-rename-flow]"), newRename = fresh.querySelector("[data-rename-flow]");
    if (oldRename && newRename) oldRename.setAttribute("aria-label", newRename.getAttribute("aria-label"));
    else if (oldRename) oldRename.remove(); else if (newRename) current.append(newRename);
    return current;
  });
  const retained = new Set(next);
  for (const item of [...list.children]) if (!retained.has(item)) item.remove();
  let cursor = list.firstElementChild;
  for (const item of next) {
    if (item === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(item, cursor);
  }
}
const collapsedFlowBranches = new Set();
const initializedFlowTrees = new Set();
function flowAncestors(current = flow(), source = state.source) {
  const chain = [], seen = new Set();
  while (current && !seen.has(key(source, current.id))) {
    seen.add(key(source,current.id)); chain.unshift({ ...current, entryPath:source });
    const parent = current.parent; if (!parent) break;
    source = parent.entryPath; current = findFlow(source,parent.flowId);
  }
  return chain;
}
function renderList() {
  // Keep the live input mounted during typing, especially an active IME composition.
  if (flowRename && document.activeElement === $("flowRenameInput")) return;
  if (state.workspace?.flows?.length && !initializedFlowTrees.has(state.path)) {
    initializedFlowTrees.add(state.path);
    for (const item of state.workspace.flows) collapsedFlowBranches.add(key(state.path,item.id));
    for (const item of flowAncestors()) collapsedFlowBranches.delete(key(item.entryPath,item.id));
  }
  const filter = $("flowSearch").value.trim().toLowerCase();
  const contentKey = JSON.stringify({ path: state.path, filter, editable: editable(), selected: key(state.source,state.flowId), collapsed: [...collapsedFlowBranches], own: state.workspace?.flows.map(item => [item.id, item.name, item.parent, item.kind]), refs: state.workspace?.references.map(item => [item.entryPath, item.flowId, findFlow(item.entryPath, item.flowId)?.name, findFlow(item.entryPath, item.flowId)?.feature]), rename: flowRename && [flowRename.path, flowRename.id] });
  if (contentKey === flowListContentKey) {
    for (const row of $("flowList").querySelectorAll("[data-flow-row]")) {
      const selected = row.dataset.flowSource === state.source && row.dataset.flowRow === state.flowId;
      row.classList.toggle("selected", selected);
      const button = row.querySelector("[data-select-flow]");
      if (button) { button.classList.toggle("selected", selected); if (selected) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current"); }
    }
    $("applicabilityLabel").textContent = ({ undecided: "可选", needed: "需要流程图", "not-needed": "无需新图" })[state.workspace?.applicability] || "可选";
    return;
  }
  flowListContentKey = contentKey;
  function row(entryPath, id, name, meta, symbol) {
    const renaming = flowRename?.path === entryPath && flowRename.id === id;

    const selected = state.source === entryPath && state.flowId === id;
    const content = renaming
      ? `<div class="flow-rename-field"><span aria-hidden="true">${symbol}</span><span class="flow-item-copy"><input id="flowRenameInput" aria-label="流程名称" maxlength="100" value="${escape(flowRename.value)}"><small>${escape(meta)}</small></span></div>`
      : `<button type="button" data-select-source="${escape(entryPath)}" data-select-flow="${escape(id)}" class="flow-select${selected ? " selected" : ""}"${selected ? ' aria-current="true"' : ""}><span aria-hidden="true">${symbol}</span><span class="flow-item-copy"><strong title="${escape(name)}">${escape(name)}</strong>${meta ? `<small>${escape(meta)}</small>` : ""}</span></button>`;
    const rename = !renaming && entryPath === state.path && editable() ? `<button type="button" class="flow-rename-button" data-rename-flow="${escape(id)}" aria-label="重命名 ${escape(name)}">✎</button>` : "";
    return `<div class="flow-list-row${selected ? " selected" : ""}" data-flow-row="${escape(id)}" data-flow-source="${escape(entryPath)}">${content}${rename}</div>`;
  }
  const own = state.workspace?.flows || [], byId = new Map(own.map(f => [f.id,f])), visited = new Set();
  const childRows = f => own.filter(c => c.parent?.entryPath === state.path && c.parent.flowId === f.id);
  const matches = (f, seen = new Set()) => {
    if (seen.has(f.id)) return false; seen.add(f.id);
    return !filter || f.name.toLowerCase().includes(filter) || childRows(f).some(c => matches(c,seen));
  };
  function branch(f, depth = 0) {
    if (visited.has(f.id) || !matches(f)) return ""; visited.add(f.id);
    const kids = childRows(f), open = !!filter || !collapsedFlowBranches.has(key(state.path,f.id));
    const toggle = kids.length ? `<button class="flow-disclosure" data-toggle-branch="${escape(f.id)}" aria-label="${open ? "收起" : "展开"} ${escape(f.name)}" aria-expanded="${open}">${icon("next")}</button>` : '<span class="flow-tree-spacer"></span>';
    return `<li class="flow-tree-item"><div class="flow-tree-line" style="--flow-depth:${depth}">${toggle}${row(state.path,f.id,f.name,f.parent && f.parent.entryPath !== state.path ? "跨需求子流程" : "","")}</div>${kids.length ? `<ul ${open ? "" : "hidden"}>${kids.map(child => branch(child, depth + 1)).join("")}</ul>` : ""}</li>`;
  }
  const roots = own.filter(f => f.kind !== "module" && (!f.parent || f.parent.entryPath !== state.path || !byId.has(f.parent.flowId)));
  let treeRows = roots.map(f => branch(f)).join("");
  for (const f of own) if (f.kind !== "module" && !visited.has(f.id) && !flowAncestors(f,state.path).some(item=>item.kind==='module')) treeRows += branch(f);
  const moduleRows = own.filter(f => f.kind === "module").map(f => branch(f)).join("");
  const ownRows = treeRows ? `<ul class="flow-tree">${treeRows}</ul>` : "";
  const refs = (state.workspace?.references || []).map((item) => { const source = findFlow(item.entryPath, item.flowId); return row(item.entryPath, item.flowId, source?.name || "来源不可用", source?.feature || item.entryPath, "↗"); }).join("");
  updateFlowList((ownRows ? ownRows : "") + (moduleRows ? `<h3>公共模块</h3><ul class="flow-tree">${moduleRows}</ul>` : "") + (refs ? `<h3>关联流程</h3>${refs}` : "") || `<p class="empty-list">${filter ? "没有匹配的流程" : "还没有流程图"}</p>`);
  for (const button of $("flowList").querySelectorAll("[data-rename-flow]")) iconButton(button, "edit", button.getAttribute("aria-label"), "F2");
  $("applicabilityLabel").textContent = ({ undecided: "可选", needed: "需要流程图", "not-needed": "无需新图" })[state.workspace?.applicability] || "可选";
}
function uniqueFlowName(base = "新流程") {
  const used = new Set((state.workspace?.flows || []).map(item => item.name));
  const name = base.trim().slice(0, 100) || "新流程";
  if (!used.has(name)) return name;
  for (let number = 2; ; number++) {
    const suffix = ` ${number}`, candidate = name.slice(0, 100 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}
async function beginFlowRename(id) {
  if (!editable() || !state.workspace?.flows.some(item => item.id === id)) return;
  if (flowRename?.id === id && flowRename.path === state.path) { $("flowRenameInput")?.focus(); return; }
  if (!finishFlowRename()) return;
  if (state.source !== state.path || state.flowId !== id) {
    await choose(state.path, id);
    if (!owned() || state.flowId !== id || !editable()) return;
  }
  const current = state.workspace.flows.find(item => item.id === id);
  if (!current) return;
  flowRename = { path: state.path, id, original: current.name, value: state.fieldDrafts[`flowName:${id}`]?.value ?? current.name, composing: false };
  renderList();
  $("flowRenameInput")?.focus(); $("flowRenameInput")?.select();
}
function stageFlowRename() {
  if (!flowRename) return;
  state.fieldDrafts[`flowName:${flowRename.id}`] = { control: "flowName", flowId: flowRename.id, itemId: "", kind: "flow", field: "name", required: true, value: flowRename.value, composing: flowRename.composing };
  state.dirty = true; persistDraft(); renderStatus();
}
function finishFlowRename(commit = true, restoreFocus = false) {
  const pending = flowRename;
  if (!pending) return true;
  if (commit && pending.composing) { toast("请先完成正在输入的名称。"); return false; }
  const value = ($("flowRenameInput")?.value ?? pending.value).trim().slice(0, 100);
  flowRename = null; composing.delete("flowRename");
  delete state.fieldDrafts[`flowName:${pending.id}`];
  const current = pending.path === state.path && state.workspace?.flows.find(item => item.id === pending.id);
  if (commit && current && editable() && value && value !== current.name) {
    delete state.fieldDrafts[`flowName:${current.id}`];
    mutate(() => { current.name = value; });
  } else { state.dirty = dataDirty() || incomplete(); persistDraft(); renderList(); renderStatus(); scheduleAutosave(); }
  if (restoreFocus) [...$("flowList").querySelectorAll("[data-select-flow]")].find(button => button.dataset.selectSource === pending.path && button.dataset.selectFlow === pending.id)?.focus();
  return true;
}
function navigationButton(item, label, nodeId = "", destinationLabel = "") {
  const hint = destinationLabel ? `${label}：${destinationLabel}` : label;
  return `<button type="button" data-navigate-flow="${escape(item.id)}" data-navigate-source="${escape(item.entryPath)}" data-locate-node="${escape(nodeId)}" title="${escape(hint)}" aria-label="${escape(hint)}">${escape(label)}</button>`;
}
async function navigateFlow(source,id,nodeId = "", rememberOrigin = false) {
  const origin = rememberOrigin ? {entryPath:state.source,flowId:state.flowId,nodeId:state.node} : null;
  const destinationChain = flowAncestors(findFlow(source,id), source);
  while (moduleCallStack.length) {
    const context = moduleCallStack.at(-1), caller = moduleCatalog().find(f=>f.entryPath===context.entryPath && f.id===context.flowId);
    const called = resolveModuleCall(moduleCatalog(),caller,context.nodeId);
    if (called && destinationChain.some(f=>f.entryPath===called.module.entryPath && f.id===called.module.id)) break;
    moduleCallStack.pop();
  }
  if (!await choose(source,id,true,true)) return;
  if(state.source !== source || state.flowId !== id) return;
  // This is browsing history, never an execution edge or module return mapping.
  if (origin) browseReturn = {origin,destination:{entryPath:source,flowId:id}};
  else if (browseReturn && (browseReturn.destination.entryPath !== source || browseReturn.destination.flowId !== id
    || browseReturn.origin.entryPath === source && browseReturn.origin.flowId === id && browseReturn.origin.nodeId === nodeId)) browseReturn = null;
  if (!nodeId) { renderContext(); return; }
  const target = flow()?.nodes.find(n => n.id === nodeId);
  if(!target) { browseReturn = null; renderContext(); toast("原关联节点已移除，已打开来源流程。"); return; }
  state.node = nodeId; state.edge = "";
  const point = center(target); state.view.scale = Math.max(.7,state.view.scale);
  state.view.x = $("viewport").clientWidth / 2 - point.x * state.view.scale;
  state.view.y = $("viewport").clientHeight / 2 - point.y * state.view.scale;
  renderInspector(); renderCanvas(); saveView();
}
let browseReturn = null;
const moduleCallStack = [];
let callDialogContext = null;
function moduleCatalog() {
  const flows = catalog(), present = new Set();
  const full = [state.external, ...moduleCallStack.map(context => context.callerWorkspace)].filter(Boolean)
    .flatMap(data => data.workspace.flows.map(item => ({...item,entryPath:data.entry.path})));
  return [...full, ...flows].filter(item => { const id=key(item.entryPath,item.id); if(present.has(id)) return false; present.add(id); return true; });
}
function currentModuleContext() {
  const context = moduleCallStack.at(-1);
  if (!context) return null;
  const caller = moduleCatalog().find(item => item.entryPath === context.entryPath && item.id === context.flowId);
  const called = resolveModuleCall(moduleCatalog(), caller, context.nodeId);
  return called && flowAncestors().some(item => item.entryPath === called.module.entryPath && item.id === called.module.id) ? context : null;
}
function callDialogModule() {
  const value = $("callModule").value;
  return catalog().find(item => key(item.entryPath,item.id) === value && item.kind === 'module');
}
function renderCallDialog() {
  const module = callDialogModule(), current = flow(), configured = current?.nodes.find(n=>n.id===callDialogContext?.nodeId)?.call;
  const inputs = module?.nodes.filter(n=>n.type==='input') || [];
  $("callEntry").innerHTML = '<option value="">选择入口</option>' + inputs.map(n=>`<option value="${escape(n.id)}">${escape(n.label)}</option>`).join('');
  const sameModule = configured && module && configured.flowId === module.id && configured.entryPath === module.entryPath;
  $("callEntry").value = sameModule ? configured.nodeId : inputs.length === 1 ? inputs[0].id : '';
  const receivers = current?.nodes.filter(n=>n.id!==callDialogContext?.nodeId) || [];
  $("callReturns").innerHTML = (module?.nodes.filter(n=>n.type==='return') || []).map((output,index)=> {
    const existing = sameModule ? configured.returns.find(item=>item.outputNodeId===output.id)?.targetNodeId : '';
    return `<label for="callReturn${index}">${escape(output.label)} →</label><select id="callReturn${index}" data-call-return="${escape(output.id)}" required><option value="">选择本图接收节点</option>${receivers.map(n=>`<option value="${escape(n.id)}"${n.id===existing?' selected':''}>${escape(n.label)}</option>`).join('')}</select>`;
  }).join('');
  $("callError").textContent = module && !inputs.length ? '此模块尚无调用入口。' : module && !module.nodes.some(n=>n.type==='return') ? '此模块尚无返回结果。' : '';
}
async function openCallDialog() {
  if (!graphEditable() || node()?.type !== 'call') return;
  await refreshCatalog();
  const current = flow(), selected = node(); if (!current || selected?.type !== 'call') return;
  callDialogContext = {flowId:current.id,nodeId:selected.id};
  const modules = catalog().filter(item=>item.kind==='module' && !(item.entryPath===state.source && item.id===current.id));
  $("callModule").innerHTML = '<option value="">选择公共模块</option>' + modules.map(item=>`<option value="${escape(key(item.entryPath,item.id))}">${escape(item.name)}${item.entryPath!==state.path ? ` · ${escape(item.feature || item.entryPath)}` : ''}</option>`).join('');
  $("callModule").value = selected.call ? key(selected.call.entryPath, selected.call.flowId) : '';
  renderCallDialog(); $("moduleCallDialog").showModal();
}
function renderContext() {
  const current = flow(), chain = flowAncestors();
  const parts = chain.map((item,i) => i === chain.length - 1
    ? `<strong aria-current="page">${escape(item.name)}</strong>`
    : navigationButton(item,item.name,chain[i+1].parent?.nodeId || ""));
  let back = "";
  if(current?.parent) {
    const parent = findFlow(current.parent.entryPath,current.parent.flowId);
    back = parent ? navigationButton({...parent,entryPath:current.parent.entryPath}, current.parent.nodeId ? "返回来源节点" : "返回主流程",current.parent.nodeId)
      : '<span class="parent-error">主流程来源不可用</span>';
  }
  const previous = browseReturn?.destination.entryPath === state.source && browseReturn.destination.flowId === current?.id ? browseReturn.origin : null;
  const previousFlow = previous && findFlow(previous.entryPath,previous.flowId);
  const previousNode = previousFlow?.nodes.find(n => n.id === previous.nodeId);
  if (previousNode && (previous.entryPath !== state.source || previous.flowId !== current.id || previous.nodeId !== state.node))
    back += navigationButton({id:previous.flowId,entryPath:previous.entryPath},'返回上次查看位置',previous.nodeId,`${previousFlow.name} · ${previousNode.label.replaceAll('\n',' / ')}`);
  const callContext = currentModuleContext();
  if (callContext) back += `<button type="button" id="callBack">返回调用节点</button>`;
  $("canvasContext").innerHTML = `<nav class="flow-breadcrumb" aria-label="流程层级">${parts.join('<span aria-hidden="true">›</span>')}</nav>${back ? `<div class="flow-return">${back}</div>` : ""}`;
}
function inspectorSelectionKey() { return JSON.stringify([state.source,state.flowId,state.node,state.edge]); }
function setInspectorEditing(value) {
  if(value && !graphEditable())return;
  state.inspectorSelection=inspectorSelectionKey();state.inspectorEditing=value;renderInspector();renderStatus();
}
function setInspectorTab(tab, focus = false) {
  if (!node() || !['properties','contract'].includes(tab)) return;
  state.inspectorTab = tab;
  renderInspector();
  if (focus) $("inspector-tab-" + tab).focus();
}
function renderInspector() {
  const identity=inspectorSelectionKey();
  if(identity!==state.inspectorSelection){state.inspectorSelection=identity;state.inspectorEditing=false;}
  if(!graphEditable())state.inspectorEditing=false;
  renderContext();
  contractEditor.render();
  const current = flow(), n = node(), e = edge(), selected = n || e;
  $("inspectorTabList").hidden = !n;
  $("inspectorTitle").hidden = !!n;
  const tab = n ? state.inspectorTab : 'properties';
  $("selectionProperties").hidden = tab !== 'properties';
  $("selectionContract").hidden = !n || tab !== 'contract';
  for (const button of $("inspectorTabList").querySelectorAll('[data-inspector-tab]')) {
    const active = button.dataset.inspectorTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $("editSelection").hidden=!selected||!graphEditable();
  $("editSelection").textContent=state.inspectorEditing?'完成':'编辑';
  $("editSelection").setAttribute('aria-pressed',String(state.inspectorEditing));
  $("nodeNameRead").textContent=selected?.label||'未命名连线';
  $("nodeNameRead").hidden=state.inspectorEditing;
  $("nodeNameEditor").hidden=!state.inspectorEditing;
  $("nodePropertiesRead").hidden=state.inspectorEditing||!selected;
  $("deleteSelection").hidden=!state.inspectorEditing;
  $("selectionInspector").hidden = !selected; $("flowInspector").hidden = !current || !owned() || !!selected; $("referenceInspector").hidden = owned() || !state.flowId; $("inspectorEmpty").hidden = !!current || !!state.flowId;
  if (current && owned()) {
    renderField("flowName", current.name); renderField("flowDescription", current.description); $("flowKind").value = current.kind || "";
    const parent = current.parent && findFlow(current.parent.entryPath, current.parent.flowId); const anchor = parent?.nodes.find((item) => item.id === current.parent.nodeId);
    $("relationSummary").innerHTML = current.parent ? parent ? `<span>补充到</span><a href="${escape(relatedUrl(parent.entryPath, parent.id))}">${escape(parent.name)} ↗</a>${current.parent.nodeId ? `<span>${escape(anchor?.label || "原关联节点已移除")}</span>` : '<span>整个流程</span>'}` : '<span>主流程来源不可用，可重新关联。</span>' : current.kind === "module" ? "公共模块" : "独立流程";
    $("parentButton").hidden = current.kind === "module";
    $("parentButton").textContent = current.parent ? "更改主流程" : "关联主流程"; $("detachParent").hidden = !current.parent;
    const callers = moduleCallers(catalog(), state.source, current.id);
    $("moduleCallers").innerHTML = current.kind === "module" && callers.length ? `<h3>调用位置 · ${callers.length}</h3>${callers.map(c => navigationButton({entryPath:c.entryPath,id:c.flowId},`${c.flowName} · ${c.label}`,c.nodeId)).join("")}` : "";
    $("childrenList").innerHTML = children().length ? `<h3>补充流程 · ${children().length}</h3>${children().map((item) => `<a href="${escape(relatedUrl(item.entryPath, item.id))}">${escape(item.name)} ↗</a>`).join("")}` : "";
  }
  if (!owned() && state.flowId) { $("referenceSource").textContent = `来源：${sourceEntry()?.feature || state.source}`; $("editSource").href = relatedUrl(state.source, state.flowId); }
  $("compactStyleControl").hidden = !n || !state.inspectorEditing; $("compactNodeStyle").disabled = !graphEditable();
  if (n) $("compactNodeStyle").value = n.variant === "branch" ? "branch" : n.supplement ? "blue" : "default";
  if (selected) {
    $("selectionTitle").textContent = n ? "节点" : "连线"; iconButton($("copySelection"), "copy", n ? "复制节点信息" : "复制连线信息"); renderField("nodeLabel", selected.label); $("nodeFields").hidden = !n || !state.inspectorEditing; $("nodeChildren").hidden = !n; iconButton($("deleteSelection"), "trash", n ? "删除节点" : "删除连线");
    if (n) {
      $("nodeType").value = n.type; $("nodeStyle").value = n.variant === "branch" ? "branch" : n.supplement ? "blue" : "default"; $("nodeChildren").innerHTML = children().filter((f) => f.parent.nodeId === n.id).map((f) => `<a class="inspector-link" href="${escape(relatedUrl(f.entryPath, f.id))}">↳ ${escape(f.name)}</a>`).join("");
      $("callFields").hidden = n.type !== "call"; $("returnFields").hidden = n.type !== "return";
      const called = resolveModuleCall(moduleCatalog(), {...current,entryPath:state.source}, n.id);
      $("callSummary").textContent = called ? `${called.module.name} · ${called.entry.label}` : n.call ? "模块或入口不可用，请重新配置。" : "尚未配置公共模块。";
      $("returnSummary").textContent = currentModuleContext() ? "按当前调用位置返回对应结果。" : "从调用节点进入后，可返回该次调用。";
      $("gatewayFields").hidden = n.type !== 'gateway';
      $("gatewayMode").value = n.gatewayMode || 'unspecified';
      const incomingCount = current.edges.filter(e => e.target === n.id).length, outgoingCount = current.edges.filter(e => e.source === n.id).length;
      $("gatewayHint").textContent = n.gatewayMode === 'split' ? (incomingCount !== 1 || outgoingCount < 2 ? '全部执行需要一条入线和至少两条出线；汇入与分流请分开表达。' : '每条出路都执行，各自推进。') : ['join','merge'].includes(n.gatewayMode) ? (incomingCount < 2 || outgoingCount !== 1 ? '汇合需要至少两条入线和一条出线。' : n.gatewayMode === 'join' ? '等待同一实例、同一轮次的每条入路到齐。' : '不等待、不去重；两次到达可使下游执行两次。') : '请选择分流或汇合模式。';
      $("semanticFields").hidden = !['input','event','end'].includes(n.type);
      $("sourceFields").hidden = !['input','event'].includes(n.type) || n.type === "input" && current.kind === "module";
      $("eventFields").hidden = n.type !== 'event'; $("endFields").hidden = n.type !== 'end';
      $("eventType").value = n.eventType || 'unspecified'; $("eventPhase").value = n.eventPhase || 'trigger'; $("endScope").value = n.endScope || 'unspecified';
      const sources = (state.workspace?.flows || []).filter(f => n.type === 'event' || f.id !== current.id).flatMap(f => f.nodes.filter(item => f.id !== current.id || item.id !== n.id).map(item => ({entryPath:state.path,flowId:f.id,nodeId:item.id,label:`${f.name} · ${item.label.replaceAll('\n',' / ')}`})));
      const sourceKey = t => JSON.stringify([t.entryPath,t.flowId,t.nodeId]);
      const sourceValid = n.source && sources.some(t => sourceKey(t) === sourceKey(n.source));
      $("nodeSource").innerHTML = '<option value="">未关联图中节点</option>' + sources.map(t => `<option value="${escape(sourceKey(t))}">${escape(t.label)}</option>`).join('') + (n.source && !sourceValid ? `<option value="${escape(sourceKey(n.source))}">原来源不可用</option>` : '');
      $("nodeSource").value = n.source ? sourceKey(n.source) : '';
      $("sourceWarning").textContent = n.source && !sourceValid ? '来源节点不可用，请重新关联。' : n.type === 'input' && current.kind !== 'module' && !n.source ? '跨图入口待关联来源。' : '';
      const reference = nodeTarget(n);
      $("outputFields").hidden = n.type !== "output" && !n.recovery;
      const targets = catalog().flatMap(f => f.nodes.filter(item =>
        (f.entryPath !== state.source || f.id !== current.id || !!n.recovery) &&
        !(f.entryPath === state.source && f.id === current.id && item.id === n.id) &&
        (!n.recovery || isTrigger(item))
      ).map(item => ({entryPath:f.entryPath,flowId:f.id,nodeId:item.id,label:`${f.name} · ${item.label.replaceAll('\n',' / ')}`})));
      const targetValue = t => JSON.stringify([t.entryPath, t.flowId, t.nodeId]);
      const resolved = reference && targets.find(t => targetValue(t) === targetValue(reference));
      $("outputTarget").innerHTML = '<option value="">待关联</option>' + targets.map(t => `<option value="${escape(targetValue(t))}">${escape(t.label)}</option>`).join('') + (reference && !resolved ? `<option value="${escape(targetValue(reference))}">目标不可用，请重新关联</option>` : '');
      $("outputTarget").value = reference ? targetValue(reference) : '';
      $("outputWarning").textContent = !$("outputFields").hidden && !resolved ? (reference ? '承接节点已移除或不可用，请重新关联。' : '请选择跨图承接节点。') : '';
      $("outputLink").hidden = !resolved;
      if (resolved) $("outputLink").href = editorUrl(resolved.entryPath, resolved.flowId, {node:resolved.nodeId,fromPath:state.path,fromFlow:state.flowId});
      const pages = sourceEntry()?.design?.pages || [];
      $("nodePage").innerHTML = '<option value="">不关联</option>' + pages.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join("") + (n.pageId && !pages.some((p) => p.id === n.pageId) ? `<option value="${escape(n.pageId)}">原画板已移除</option>` : ""); $("nodePage").value = n.pageId || "";
      $("openPageLink").hidden = !n.pageId || !pages.some((p) => p.id === n.pageId);
      $("addSupplement").textContent = children().some((f) => f.parent.nodeId === n.id) ? "再补充此节点的流程" : "补充此节点的流程";
    }
  }
  $("nodeFlowLinks").innerHTML = n ? children().filter(f => f.parent.nodeId === n.id).map(f => navigationButton(f,`子流程 · ${f.name}`)).join("") : "";
  if (n?.type === 'output' || n?.recovery) {
    const destination = resolveFlowTarget(catalog(), nodeTarget(n));
    $("nodeFlowLinks").innerHTML += destination ? `<button type="button" id="outputJump" title="${escape(destination.flow.name + ' · ' + destination.node.label)}">前往承接节点 ↗</button>` : '<span role="status">跨图出口待关联</span>';
  }
  if (['input','event'].includes(n?.type) && n.source) {
    const origin = findFlow(n.source.entryPath,n.source.flowId), sourceNode = origin?.nodes.find(item => item.id === n.source.nodeId);
    $("nodeFlowLinks").innerHTML += sourceNode ? `<button type="button" id="sourceJump" title="${escape(origin.name + ' · ' + sourceNode.label)}">查看来源节点 ↗</button>` : '<span role="status">来源节点不可用</span>';
  }
  if (n) {
    const sources = flowSources(catalog(), {entryPath:state.source,flowId:current.id,nodeId:n.id}).filter(item => !(n.source?.entryPath === item.entryPath && n.source.flowId === item.flowId && n.source.nodeId === item.nodeId));
    $("nodeFlowLinks").innerHTML += sources.map(item => navigationButton({entryPath:item.entryPath,id:item.flowId}, `查看来源 · ${item.label.replaceAll('\n',' / ')}`, item.nodeId)).join('');
  }
  if (n?.type === 'call') {
    const called = resolveModuleCall(moduleCatalog(), {...current,entryPath:state.source}, n.id);
    $("nodeFlowLinks").innerHTML += called ? `<button type="button" id="callJump">打开 ${escape(called.module.name)} ↗</button>` : '<span role="status">模块调用待配置</span>';
  }
  if (n?.type === 'return') {
    const receiver = resolveModuleReturn(moduleCatalog(), currentModuleContext(), state.source, current.id, n.id);
    $("nodeFlowLinks").innerHTML += receiver ? `<button type="button" id="moduleReturnJump" title="${escape(receiver.label)}">返回本次调用结果 ↗</button>` : '<span role="status">请从调用节点进入此模块</span>';
  }
  if (current?.kind === 'module' && !currentModuleContext() && (!n || ['input','return'].includes(n.type))) {
    const callers = moduleCallers(catalog(), state.source, current.id);
    $("nodeFlowLinks").innerHTML += callers.map(c => navigationButton({entryPath:c.entryPath,id:c.flowId},`调用处 · ${c.flowName} / ${c.label}`,c.nodeId)).join('');
  }
  $("nodeFlowLinks").hidden = !$("nodeFlowLinks").innerHTML;
  const contextBottom = $("canvasContext").offsetTop + $("canvasContext").offsetHeight + 8;
  $("compactStyleControl").style.top = `${contextBottom}px`;
  $("nodeFlowLinks").style.top = `${contextBottom + 44}px`;
  const readProperties=[];
  if(n) {
    const optionLabel=id=>$(id).selectedOptions[0]?.textContent||'';
    readProperties.push(['类型',optionLabel('nodeType')],['样式',optionLabel('nodeStyle')]);
    if(n.type==='event')readProperties.push(['事件',optionLabel('eventType')],['阶段',optionLabel('eventPhase')]);
    if(n.type==='end')readProperties.push(['结束范围',optionLabel('endScope')]);
    if(n.type==='gateway')readProperties.push(['模式',optionLabel('gatewayMode')]);
    if(n.pageId)readProperties.push(['关联页面',optionLabel('nodePage')]);
  } else if(e)readProperties.push(['连线',`${current.nodes.find(n=>n.id===e.source)?.label||e.source} → ${current.nodes.find(n=>n.id===e.target)?.label||e.target}`]);
  $("nodePropertiesRead").innerHTML=readProperties.map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('');
  updatePageLink();
  annotations.sync();
}
let geometryKey = '', geometryCache = new Map();
function displayFlow() {
  const current = flow();
  if (!current || drag?.type !== 'node' || !drag.position) return current;
  return { ...current, nodes: current.nodes.map(n => n.id === drag.id ? { ...n, ...drag.position } : n) };
}
function geometryFor(current) {
  const key = JSON.stringify([current?.direction, current?.nodes.map(n => [n.id, n.type, n.x, n.y]), current?.edges]);
  if (key !== geometryKey) { geometryKey = key; geometryCache = graphGeometry(current); }
  return geometryCache;
}
function labelMarkup(e, g) {
  if (!e.label) return '';
  const b = g.labelBox, text = g.labelText;
  return `<g class="edge-label" transform="translate(${g.x} ${g.y})"><rect class="edge-label-bg" x="${-b.width / 2}" y="${-b.height / 2}" width="${b.width}" height="${b.height}" rx="4"/><text>${text.lines.map((line, i) => `<tspan x="0" y="${(i - (text.lines.length - 1) / 2) * text.lineHeight}">${escape(line)}</tspan>`).join('')}</text></g>`;
}
function graphMarkup(current, selection = true) {
  if (!current) return "";
  const geometry = geometryFor(current);
  const selectedNode = selection && current.nodes.some(n => n.id === state.node) ? state.node : "";
  const related = e => selectedNode && (e.source === selectedNode || e.target === selectedNode);
  const edges = [...current.edges].sort((a, b) => Number(!!related(a)) - Number(!!related(b))).map(e => {
    const g = geometry.get(e.id); if (!g) return '';
    const direction = selectedNode && e.source === selectedNode ? ' outgoing' : selectedNode && e.target === selectedNode ? ' incoming' : '';
    return `<g class="flow-edge${e.trace ? ` trace-${e.trace}` : ''}${direction}${selection && state.edge === e.id ? ' selected' : ''}" data-edge="${escape(e.id)}" role="button" tabindex="0" aria-pressed="${selection && state.edge === e.id}" aria-label="${escape(e.label || '连线')}${direction === ' incoming' ? '（输入）' : direction === ' outgoing' ? '（输出）' : ''}"><path class="edge-hit" d="${g.d}"/><path class="edge-line" d="${g.d}"/>${labelMarkup(e, g)}<title>${escape(e.label || '连线')}${direction === ' incoming' ? '（输入）' : direction === ' outgoing' ? '（输出）' : ''}</title></g>`;
  }).join('');
  const supplemented = new Set(children().map(f => f.parent.nodeId));
  const lanes = (current.lanes || []).map(l => `<g class="flow-lane" aria-label="泳道：${escape(l.label)}"><rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" fill="#fafbfc" stroke="#d9dde3"/><text x="${l.x+18}" y="${l.y+30}" fill="#383838" style="font:500 16px sans-serif">${escape(l.label)}</text></g>`).join('');
  const legendItems = [];
  if (current.nodes.some(n => n.variant !== "branch" && !n.supplement)) legendItems.push('白色：原有逻辑');
  if (current.nodes.some(n => n.variant === "branch")) legendItems.push("紫色：分支实现 / 待业务验收");
  if (current.nodes.some(n => n.supplement)) legendItems.push('蓝色：拟优化 / 未实现');
  if (current.edges.some(e => e.trace === 'actual')) legendItems.push('红线：实际路径');
  if (current.nodes.some(n => n.issues?.length)) legendItems.push('P编号：问题标记');
  const explicitLegend = current.description?.match(/^图例[：:]\s*([^\r\n]{1,240})$/m)?.[1]?.trim();
  const legendOrigin = current.lanes?.[0] || (explicitLegend && current.nodes.length ? { x: Math.min(...current.nodes.map(n => n.x)), y: Math.min(...current.nodes.map(n => n.y)) } : null);
  const legend = legendOrigin ? `<text x="${legendOrigin.x}" y="${legendOrigin.y-20}" fill="#555" style="font:13px sans-serif">${escape(explicitLegend || legendItems.join('　'))}</text>` : '';
  return lanes + legend + edges + current.nodes.map(n => {
    const { w, h } = dimensions(n), text = nodeTextLayout(n, { w, h });
    const shape = n.type === "gateway" ? `<path class="shape" d="M16,0 H${w-16} L${w},${h/2} L${w-16},${h} H16 L0,${h/2} Z"/>` : n.type === "input" ? `<path class="shape" d="M0,0 H${w} V${h} H0 L18,${h/2} Z"/>` : n.type === "event" ? `<rect class="shape" width="${w}" height="${h}" rx="24"/>${n.eventPhase === 'intermediate' ? `<rect class="shape" x="5" y="5" width="${w-10}" height="${h-10}" rx="20" style="fill:none"/>` : ''}` : ["output","return"].includes(n.type) ? `<path class="shape" d="M0,0 H${w-18} L${w},${h/2} L${w-18},${h} H0 Z"/>` : n.type === "decision" ? `<path class="shape" d="M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z"/>` : `<rect class="shape" width="${w}" height="${h}" rx="${["step","call"].includes(n.type) ? 0 : 24}"/>`;
    const semanticCaption = n.type === 'call' ? '调用公共模块' : n.type === 'return' ? '返回调用处' : n.type === 'gateway' ? ({split:'＋ 全部执行',join:'＋ 等待全部完成',merge:'→ 每次到达即继续'})[n.gatewayMode] || '分流／汇合模式待明确' : n.type === 'event' ? `${({message:'消息',timer:'定时',manual:'人工',response:'响应'})[n.eventType] || '事件类型待明确'} · ${n.eventPhase === 'intermediate' ? '原处理继续' : '触发处理'}` : n.type === 'end' ? ({execution:'本次执行结束',subprocess:'子流程结束',business:'业务完成',terminate:'终止当前流程其他执行'})[n.endScope] || '结束范围待明确' : '';
    const eventIcon = ({message:'<rect x="1" y="3" width="14" height="10"/><path d="m1 3 7 6 7-6"/>',timer:'<circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/>',manual:'<circle cx="8" cy="4" r="3"/><path d="M2 15v-2a6 6 0 0 1 12 0v2"/>',response:'<path d="m6 2-4 4 4 4M2 6h8a4 4 0 0 1 0 8H6"/>'})[n.eventType];
    const eventMark = n.type === 'event' && eventIcon ? `<g transform="translate(16 ${h-22})" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">${eventIcon}</g>` : '';
    const semanticMark = semanticCaption ? `<text x="${w/2}" y="${h-12}" style="font-size:10px">${escape(semanticCaption)}</text>` : '';
    return `<g class="flow-node${n.variant === "branch" ? " flow-branch" : n.supplement ? " flow-supplement" : ""}${selection && state.node === n.id ? " selected" : ""}${selection && state.connectFrom === n.id ? " connect-source" : ""}${supplemented.has(n.id) ? " supplemented" : ""}" data-node="${escape(n.id)}" transform="translate(${n.x} ${n.y})" role="button" tabindex="0" aria-pressed="${selection && state.node === n.id}" aria-label="${escape(n.label)}${n.variant === "branch" ? "（紫色分支样式）" : n.supplement ? "（蓝色样式）" : ""}"><title>${escape(n.label)}${n.variant === "branch" ? "（紫色分支样式）" : n.supplement ? "（蓝色样式）" : ""}</title>${shape}${n.type === "call" ? `<path d="M8 0V${h}M${w-8} 0V${h}" fill="none" stroke="currentColor" stroke-width="1"/>` : ""}${eventMark}${semanticMark}${n.issues?.length ? `<g class="issue-badge"><rect x="0" y="-20" width="${n.issues.length*38+8}" height="18" rx="4" fill="#b42318"/><text x="${(n.issues.length*38+8)/2}" y="-10" style="fill:white;font-size:11px">${escape(n.issues.join(' · '))}</text></g>` : ''}<text class="node-label">${text.lines.map((line, i) => `<tspan x="${w / 2}" y="${text.ys[i]}">${escape(line)}</tspan>`).join('')}</text>${n.pageId ? `<text class="page-mark" x="${w / 2}" y="${text.pageY}">↗ 页面</text>` : ""}${supplemented.has(n.id) ? `<text class="page-mark" x="${w - 12}" y="14" style="text-anchor:end">子流程 ${children().filter(f => f.parent.nodeId === n.id).length}</text>` : ""}</g>`;
  }).join('');
}
function renderCanvas() {
  const focusedItem = document.activeElement?.closest("#graph [data-node], #graph [data-edge]");
  const focusNode = focusedItem?.dataset.node, focusEdge = focusedItem?.dataset.edge;
  $("graph").innerHTML = graphMarkup(displayFlow()); transform();
  routeAudit.paint($("graph"),state.source,state.flowId);
  drawGestureFeedback();
  if (focusNode || focusEdge) [...$("graph").querySelectorAll("[data-node],[data-edge]")].find(el => focusNode ? el.dataset.node === focusNode : el.dataset.edge === focusEdge)?.focus({ preventScroll: true });
  annotations.renderMarkers();
  const current = flow(); $("emptyCanvas").hidden = !!current;
  if (!current) { const missing = !!state.flowId; $("emptyCanvas").querySelector("h2").textContent = missing ? "来源不可用" : state.workspace?.applicability === "not-needed" ? "本需求无需新流程图" : "让流程清楚地连接起来"; $("emptyDescription").textContent = missing ? "关联已保留，可在右侧回到来源或移除关联。" : state.workspace?.reason || "新建一张图，或关联其他需求已有的流程。"; $("emptyNone").hidden = missing || state.workspace?.applicability === "not-needed"; $("emptyAdd").hidden = missing; $("emptyLink").hidden = missing; }
  $("canvasHint").textContent = state.mode === "connect" ? state.connectFrom ? "选择目标节点 · Esc 取消" : "选择起点，再选择终点" : !current ? "" : !current.nodes.length ? "从下方工具栏添加第一个节点" : "滚轮平移 · ⌘/Ctrl 滚轮缩放";
}
function render() { renderList(); renderInspector(); renderCanvas(); renderStatus(); syncLocation(); }
function transform() {
  updatePageLink();
  const value = `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`;
  $("graph").setAttribute('transform', value); $("flowGuides").setAttribute('transform', value); $("connectionPreview").setAttribute('transform', value);
  for (const marker of document.querySelectorAll('#flowCanvas marker')) { marker.setAttribute('markerWidth', arrowSize(state.view.scale)); marker.setAttribute('markerHeight', arrowSize(state.view.scale)); }
  $("zoomLabel").textContent = `${state.view.scale < .01 ? (state.view.scale * 100).toFixed(2) : Math.round(state.view.scale * 100)}%`;
}
function bounds(nodes = flow()?.nodes || [], current = flow()) {
  if (!nodes.length) return { x: 0, y: 0, w: 400, h: 250 };
  const boxes = nodes.map(n => nodeBox(n));
  for (const l of current?.lanes || []) boxes.push({x:l.x,y:l.y-40,width:l.width,height:l.height+40});
  for (const g of geometryFor(current).values()) {
    for (const p of g.points) boxes.push({ x: p.x, y: p.y, width: 0, height: 0 });
    boxes.push(g.labelBox);
  }
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.width)) - x, h: Math.max(...boxes.map(b => b.y + b.height)) - y };
}
function fit() {
  const b = bounds(), rect = $("viewport").getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const top = Math.max(64, $("canvasContext").offsetTop + $("canvasContext").offsetHeight + 20), bottom = (document.querySelector('.canvas-dock')?.getBoundingClientRect().height || 70) + 40, height = Math.max(80, rect.height - top - bottom);
  const scale = Math.max(MIN_FLOW_SCALE, Math.min(1, (rect.width - 64) / (b.w + 20), height / (b.h + 20)));
  state.view = { x: (rect.width - b.w * scale) / 2 - b.x * scale, y: top + (height - b.h * scale) / 2 - b.y * scale, scale }; transform(); saveView();
}
function zoom(scale, x = $("viewport").clientWidth / 2, y = $("viewport").clientHeight / 2) { const next = Math.min(2.5, Math.max(MIN_FLOW_SCALE, scale)); const ratio = next / state.view.scale; state.view = { x: x - (x - state.view.x) * ratio, y: y - (y - state.view.y) * ratio, scale: next }; transform(); saveView(); }
function setMode(mode) { finishDrag(true); connectionPoint = null; connectionTarget = ''; state.mode = mode; if (mode !== "connect") state.connectFrom = ""; $("viewport").classList.toggle("panning", mode === "pan"); $("viewport").classList.toggle("connecting", mode === "connect"); for (const name of ["select", "pan", "connect"]) { $(`${name}Tool`).classList.toggle("active", mode === name); $(`${name}Tool`).setAttribute("aria-pressed", mode === name ? "true" : "false"); } renderCanvas(); }
function availableParents(excludeId = "") {
  const all = catalog(), excluded = new Set(excludeId ? [key(state.path, excludeId)] : []); let changed = true;
  while (changed) { changed = false; for (const f of all) if (f.parent && excluded.has(key(f.parent.entryPath, f.parent.flowId)) && !excluded.has(key(f.entryPath, f.id))) { excluded.add(key(f.entryPath, f.id)); changed = true; } }
  return all.filter((f) => !excluded.has(key(f.entryPath, f.id)));
}
function fillAnchors(select, parent, selected = "") { select.innerHTML = '<option value="">整个流程</option>' + (parent?.nodes || []).map((n) => `<option value="${escape(n.id)}">${escape(n.label)}</option>`).join(""); if ([...select.options].some((o) => o.value === selected)) select.value = selected; }
async function openNew(parent = null) {
  if (!editable() || !state.workspace || !finishFlowRename()) return;
  if (state.workspace.flows.length >= 40) { toast("每个需求最多 40 张流程图"); return; }
  const entryPath = state.path, id = uid();
  let source = parent && findFlow(parent.entryPath, parent.flowId);
  let anchor = source?.nodes.find(item => item.id === parent.nodeId);
  if (parent && (!source || parent.nodeId && !anchor)) { toast("主流程或关联节点已不可用，请重新选择。"); return; }
  if (!await annotations.beforeContextChange(entryPath, id) || entryPath !== state.path || !editable()) return;
  // Saving notes can yield while the parent flow or its anchor is edited or removed.
  source = parent && findFlow(parent.entryPath, parent.flowId);
  anchor = source?.nodes.find(item => item.id === parent.nodeId);
  if (parent && (!source || parent.nodeId && !anchor)) { toast("主流程或关联节点已不可用，请重新选择。"); return; }
  if (state.workspace.flows.length >= 40) { toast("每个需求最多 40 张流程图"); return; }
  const name = uniqueFlowName(parent ? `${(anchor?.label || source.name).slice(0, 86)} · 补充流程` : "新流程");
  const current = { id, name, description: "", parent: parent ? { entryPath: parent.entryPath, flowId: parent.flowId, nodeId: parent.nodeId || "" } : null, direction: "TD", nodes: [], edges: [] };
  saveView(); ++state.selectionToken; $("flowSearch").value = "";
  mutate(() => {
    state.workspace.flows.push(current); state.workspace.applicability = "needed"; state.workspace.reason = "";
    state.source = state.path; state.flowId = id; state.external = null; state.node = ""; state.edge = ""; state.connectFrom = "";
  });
  setMode("select"); fit();
  [...$("flowList").querySelectorAll("[data-select-flow]")].find(button => button.dataset.selectFlow === id && button.dataset.selectSource === state.path)?.focus();
}
function libraryCandidates() { const filter = $("librarySearch").value.trim().toLowerCase(); const list = state.libraryMode === "parent" ? availableParents(state.flowId) : catalog().filter((f) => f.entryPath !== state.path && !state.workspace.references.some((r) => r.entryPath === f.entryPath && r.flowId === f.id)); return list.filter((f) => !filter || `${f.name} ${f.feature} ${f.entryPath}`.toLowerCase().includes(filter)); }
function renderLibrary() { const items = libraryCandidates(); $("libraryList").innerHTML = items.map((f) => `<label class="library-option"><input type="radio" name="libraryFlow" value="${escape(key(f.entryPath, f.id))}"${key(f.entryPath, f.id) === state.libraryKey ? " checked" : ""}><span><b>${escape(f.name)}</b><small>${escape(f.feature)} · ${f.parent ? "补充流程" : "独立流程"}</small></span></label>`).join("") || '<p class="muted">没有可关联的流程，可以先新建一张。</p>'; $("librarySubmit").disabled = !items.some((f) => key(f.entryPath, f.id) === state.libraryKey); $("anchorFields").hidden = state.libraryMode !== "parent" || !state.libraryKey; }
async function openLibrary(mode) { if (!editable()) return; await refreshCatalog(); state.libraryMode = mode; state.libraryKey = ""; $("librarySearch").value = ""; $("libraryTitle").textContent = mode === "parent" ? "关联主流程" : "关联已有流程"; $("libraryNote").textContent = state.catalogError ? `流程库读取失败，请关闭后重试：${state.catalogError}` : state.catalogIssues.length ? `${state.catalogIssues.length} 份流程资料无法读取；可在来源需求中检查。` : mode === "parent" ? "可补充整个流程，也可指定其中一个节点。" : "关联后共享同一张图，修改在来源需求中进行。"; renderLibrary(); $("libraryDialog").showModal(); $("librarySearch").focus(); }
function openSettings(value) { if (!editable()) return; $("applicability").value = value || state.workspace.applicability; $("reason").value = state.workspace.reason; $("settingsError").textContent = ""; $("settingsDialog").showModal(); }
function addNode(type) {
  if (type === 'return' && flow()?.kind !== 'module') { toast('返回节点只能放在公共模块中。'); return; }
  if (!graphEditable()) return; if (flow().nodes.length >= 100) { toast('每张流程图最多 100 个节点'); return; }
  const selected = node(), rect = $("viewport").getBoundingClientRect(), size = dimensions({ type });
  const horizontal = ['LR', 'RL'].includes(flow().direction), reverse = ['BT', 'RL'].includes(flow().direction);
  let x = Math.round((rect.width / 2 - state.view.x) / state.view.scale - size.w / 2), y = Math.round((rect.height / 2 - state.view.y) / state.view.scale - size.h / 2);
  if (selected) {
    const c = center(selected), other = dimensions(selected);
    x = horizontal ? reverse ? selected.x - size.w - 88 : selected.x + other.w + 88 : c.x - size.w / 2;
    y = horizontal ? c.y - size.h / 2 : reverse ? selected.y - size.h - 88 : selected.y + other.h + 88;
  }
  while (flow().nodes.some(n => { const b = nodeBox(n, 16); return x < b.x + b.width && x + size.w > b.x && y < b.y + b.height && y + size.h > b.y; })) { if (horizontal) y += size.h + 72; else x += size.w + 72; }
  const n = { id: uid(), type, ...(type === 'gateway' ? {gatewayMode:'split'} : {}), label: ({ start: '开始', step: '新的步骤', decision: '是否满足条件？', end: '结束', output: '跨图继续', input: '承接上游', event: '事件触发', gateway: '并行分流', call:'调用公共模块', return:'返回本次结果' })[type], x: Math.round(Math.max(-100000, Math.min(100000, x))), y: Math.round(Math.max(-100000, Math.min(100000, y))), pageId: '' };
  mutate(() => { flow().nodes.push(n); state.node = n.id; state.edge = ''; }); setMode('select'); if (window.innerWidth > 760) { $("nodeLabel").focus(); $("nodeLabel").select(); }
}
function connectNode(id) { if (!graphEditable()) return; if (flow().nodes.some(n=>n.id===(state.connectFrom || id) && n.type==="return")) { toast("模块返回节点没有本图出线，请在调用处配置返回映射。"); return; } if (!state.connectFrom) { state.connectFrom = id; state.node = id; state.edge = ""; renderCanvas(); renderInspector(); return; } if (flow().edges.length >= 200) { toast("每张图最多 200 条连线"); return; } const source = state.connectFrom; if (!flow().nodes.some((n) => n.id === source) || !flow().nodes.some((n) => n.id === id)) { state.connectFrom = ""; renderCanvas(); return; } if (flow().edges.some((e) => e.source === source && e.target === id)) { toast("这两个节点已有同向连线"); return; } mutate(() => { const e = { id: uid(), source, target: id, label: "" }; flow().edges.push(e); state.edge = e.id; state.node = ""; state.connectFrom = ""; }); setMode("select"); }
async function deleteSelection() { if (!graphEditable()) return; const n = node(), e = edge(); if (!n && !e) return; if (n && children().some((f) => f.parent.nodeId === n.id) && await confirmAction("删除关联节点", "补充流程仍会保留，但其原关联节点将标记为已移除。", { action: "删除节点" }) !== "confirm") return; mutate(() => { if (n) { flow().nodes = flow().nodes.filter((item) => item.id !== n.id); flow().edges = flow().edges.filter((item) => item.source !== n.id && item.target !== n.id); } else flow().edges = flow().edges.filter((item) => item.id !== e.id); state.node = ""; state.edge = ""; state.connectFrom = ""; }); }
function svgExport() { const f = flow(); if (!f) return; const b = bounds(); const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w + 120}" height="${b.h + 120}" viewBox="${b.x - 60} ${b.y - 60} ${b.w + 120} ${b.h + 120}"><title>${escape(f.name)}</title><style>.shape{fill:white;stroke:#90959e;stroke-width:1.5}.flow-node text{text-anchor:middle;dominant-baseline:middle;fill:#383838;white-space:pre;font:13px ${escape(getComputedStyle(document.documentElement).getPropertyValue("--font").trim())}}.flow-node .page-mark{font-size:11px;fill:#666}.edge-line{fill:none;stroke:#90959e;stroke-width:1.6;marker-end:url(#arrow)}.flow-supplement .shape{fill:#e8f3ff;stroke:#0768cf}.flow-branch .shape{fill:#f4ebff;stroke:#7f56d9}.flow-branch .node-label{fill:#6941c6}.trace-branch .edge-line{stroke:#7f56d9}.trace-branch text{fill:#6941c6}.trace-actual .edge-line{stroke:#b42318;stroke-width:2.4}.trace-proposal .edge-line{stroke:#0768cf;stroke-dasharray:6 4}.edge-hit{display:none}.edge-label-bg{fill:white;stroke:none}.flow-edge text{fill:#383838;stroke:none;dominant-baseline:middle;text-anchor:middle;white-space:pre;font:12px ${escape(getComputedStyle(document.documentElement).getPropertyValue("--font").trim())}}</style><defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path fill="#90959e" d="M0 0L10 5L0 10Z"/></marker></defs><rect x="${b.x - 60}" y="${b.y - 60}" width="${b.w + 120}" height="${b.h + 120}" fill="white"/>${graphMarkup(f, false)}</svg>`; const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `${f.name.replace(/[\\/:*?"<>|]/g, "-")}.svg`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function showVersions() { $("versionsList").textContent = "正在读取…"; $("versionsDialog").showModal(); try { const data = await api(`/api/flows/versions?${new URLSearchParams({ path: state.path })}`); $("versionsList").innerHTML = data.versions.map((v) => `<div class="version-row"><span>版本 ${v.revision}${v.current ? " · 当前" : ""}<small>${escape(new Date(v.updatedAt).toLocaleString("zh-CN"))} · ${v.flowCount ?? v.ownedCount ?? 0} 张图</small></span>${!v.current && editable() ? `<button data-restore="${v.revision}">恢复</button>` : ""}</div>`).join(""); } catch (error) { $("versionsList").textContent = error.message; } }

$("librarySearch").addEventListener("input", renderLibrary);
$("libraryList").addEventListener("change", (event) => { state.libraryKey = event.target.value; fillAnchors($("libraryAnchor"), catalog().find((f) => key(f.entryPath, f.id) === state.libraryKey)); renderLibrary(); });
$("libraryForm").addEventListener("submit", (event) => { event.preventDefault(); const selected = libraryCandidates().find((f) => key(f.entryPath, f.id) === state.libraryKey); if (!selected || !editable()) return; if (state.libraryMode === "parent") mutate(() => { flow().parent = { entryPath: selected.entryPath, flowId: selected.id, nodeId: $("libraryAnchor").value }; }); else { mutate(() => state.workspace.references.push({ entryPath: selected.entryPath, flowId: selected.id })); choose(selected.entryPath, selected.id); } $("libraryDialog").close(); });
function updateSettings() { if (!editable()) return; if ($("applicability").value === "not-needed" && state.workspace.flows.length) { $("settingsError").textContent = "当前需求已有流程图，请先处理这些图，再标记无需流程图。"; $("applicability").value = state.workspace.applicability; return; } $("settingsError").textContent = ""; mutate(() => { state.workspace.applicability = $("applicability").value; state.workspace.reason = $("reason").value; }); }
$("settingsForm").addEventListener("submit", (event) => { event.preventDefault(); updateSettings(); $("settingsDialog").close(); });
$("applicability").addEventListener("change", updateSettings);
$("reason").addEventListener("input", (event) => { if (!event.isComposing) updateSettings(); });
$("reason").addEventListener("compositionend", updateSettings);
$("flowSearch").addEventListener("input", renderList);
$("flowList").addEventListener("dblclick", event => {
  if (event.target.closest("input,[data-rename-flow]")) return;
  const row = event.target.closest("[data-flow-row]");
  if (row?.dataset.flowSource === state.path) { event.preventDefault(); void beginFlowRename(row.dataset.flowRow); }
});
$("flowList").addEventListener("input", event => { if (event.target.id === "flowRenameInput" && flowRename) { flowRename.value = event.target.value; stageFlowRename(); } });
$("flowList").addEventListener("compositionstart", event => { if (event.target.id === "flowRenameInput" && flowRename) { flowRename.composing = true; composing.add("flowRename"); stageFlowRename(); } });
$("flowList").addEventListener("compositionend", event => {
  if (event.target.id !== "flowRenameInput" || !flowRename) return;
  flowRename.composing = false; flowRename.value = event.target.value; composing.delete("flowRename");
  if (document.activeElement !== event.target) finishFlowRename(); else stageFlowRename();
});
$("flowList").addEventListener("focusout", event => { if (event.target.id === "flowRenameInput") finishFlowRename(); });
$("flowList").addEventListener("keydown", event => {
  if (event.target.id !== "flowRenameInput") return;
  if (event.isComposing || flowRename?.composing || event.keyCode === 229) return;
  if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishFlowRename(event.key === "Enter", true); }
});
for (const control of ["flowName", "flowDescription", "nodeLabel"]) {
  $(control).addEventListener("compositionstart", () => { composing.add(control); editField(control); });
  $(control).addEventListener("compositionend", () => { composing.delete(control); editField(control); });
  $(control).addEventListener("input", (event) => { if (event.isComposing) composing.add(control); editField(control); });
}
$("inspectorTabList").addEventListener('click', event => {
  const button = event.target.closest('[data-inspector-tab]');
  if (button) setInspectorTab(button.dataset.inspectorTab, true);
});
$("inspectorTabList").addEventListener('keydown', event => {
  if (!event.target.closest('[role="tab"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const tab = event.key === 'Home' ? 'properties' : event.key === 'End' ? 'contract' : state.inspectorTab === 'properties' ? 'contract' : 'properties';
  setInspectorTab(tab, true);
});
$("editSelection").addEventListener("click", async()=>{
  if(!graphEditable())return;
  if(state.inspectorEditing){if(await guard())setInspectorEditing(false);}
  else setInspectorEditing(true);
});
$("nodeType").addEventListener("change", () => { const value = $("nodeType").value; if (value === "return" && flow()?.edges.some(e=>e.source===node()?.id)) { toast("先处理当前节点的出线，再改为模块返回。"); renderInspector(); return; } if (value === "return" && flow()?.kind !== "module") { toast("返回节点只能放在公共模块中。"); renderInspector(); return; } if (graphEditable() && node()) mutate(() => { node().type = value; if (value === "output" && node().recovery) { node().target = node().recovery; delete node().recovery; } if (value === 'gateway') node().gatewayMode ||= 'split'; else delete node().gatewayMode; if (value !== "output") delete node().target; if (value !== "call") delete node().call;
  if (!['input','event'].includes(value)) delete node().source;
  if (value !== 'event') { delete node().eventType; delete node().eventPhase; } else { node().eventType ||= 'unspecified'; node().eventPhase ||= 'trigger'; }
  if (value !== 'end') delete node().endScope; else node().endScope ||= 'unspecified'; }); });
for (const field of ['eventType','eventPhase','endScope','gatewayMode']) $(field).addEventListener('change', () => { const value = $(field).value; if (field === 'endScope' && node()?.recovery && ['business','terminate'].includes(value)) { toast('请先解除后续流程关联，再设为业务完成或终止。'); renderInspector(); return; } if (graphEditable() && node()) mutate(() => { node()[field] = value; }); });
$("nodeSource").addEventListener('change', () => { const value = $("nodeSource").value; if (graphEditable() && ['input','event'].includes(node()?.type)) mutate(() => { if (!value) delete node().source; else { const [entryPath,flowId,nodeId] = JSON.parse(value); node().source = {entryPath,flowId,nodeId}; } }); });
$("outputTarget").addEventListener("change", () => {
  if (!graphEditable() || !node() || node().type !== 'output' && !node().recovery) return;
  const value = $("outputTarget").value;
  mutate(() => { const field = node().type === "output" ? "target" : "recovery"; if (!value) delete node()[field]; else { const [entryPath,flowId,nodeId] = JSON.parse(value); node()[field] = {entryPath,flowId,nodeId}; } });
});
$("flowKind").addEventListener('change', () => {
  if (!graphEditable()) return;
  const current=flow(), kind=$("flowKind").value;
  if (kind === 'module' && (current.parent || current.nodes.some(n=>n.type==='input' && n.source))) {
    toast('先解除主流程归属和调用入口的固定来源，再改为公共模块。'); renderInspector(); return;
  }
  if (!kind && (current.nodes.some(n=>n.type==='return') || moduleCallers(catalog(),state.path,current.id).length)) {
    toast('先处理返回节点和现有调用，再改为业务流程。'); renderInspector(); return;
  }
  mutate(()=>{if(kind) current.kind=kind; else delete current.kind;});
});
$("callModule").addEventListener('change',renderCallDialog);
$("moduleCallForm").addEventListener('submit', async event => {
  event.preventDefault();
  if (!graphEditable() || flow()?.id!==callDialogContext?.flowId || node()?.id!==callDialogContext?.nodeId) { $("callError").textContent='当前节点已变化，请重新打开配置。'; return; }
  const module=callDialogModule(), entry=$("callEntry").value, current=flow(), selected=node();
  const returns=[...$("callReturns").querySelectorAll('[data-call-return]')].map(select=>({outputNodeId:select.dataset.callReturn,targetNodeId:select.value}));
  if (!module || !module.nodes.some(n=>n.id===entry && n.type==='input') || !returns.length || returns.some(r=>!current.nodes.some(n=>n.id===r.targetNodeId))) { $("callError").textContent='请选择模块入口及每个结果的接收节点。'; return; }
  const targets = new Set(returns.map(r=>r.targetNodeId));
  const obsolete = current.edges.filter(e=>e.source===selected.id && !targets.has(e.target));
  try {
    let notes=[];
    if(obsolete.length) {
      if(!await annotations.flush()) throw new Error('请先保存当前元素说明，再应用调用配置。');
      notes=(await api(`/api/annotations?${new URLSearchParams({path:state.path})}`)).workspace?.notes;
    }
    if(!graphEditable() || flow()!==current || node()!==selected || !$('moduleCallDialog').open) return;
    const planned=planModuleCallEdges(current,selected.id,returns,notes,uid);
    mutate(()=>{
      selected.call={entryPath:module.entryPath,flowId:module.id,nodeId:entry,returns};
      current.edges=planned.edges;
    });
    $("moduleCallDialog").close();
  } catch(error) { $("callError").textContent=error.message; }
});
for (const styleControl of ["nodeStyle", "compactNodeStyle"]) $(styleControl).addEventListener("change", () => { const value = $(styleControl).value; if (graphEditable() && node()) mutate(() => { setNodeAppearance(node(), value); }); });
$("nodePage").addEventListener("change", () => { const value = $("nodePage").value; if (graphEditable() && node()) mutate(() => { node().pageId = value; }); });
$("requirementSelect").addEventListener("change", async () => { const next = $("requirementSelect").value; if (await guard()) { saveView(); await load(next); } else $("requirementSelect").value = state.path; });
document.addEventListener("click", async (event) => {
  if (event.defaultPrevented) return;
  const target = event.target.closest("button,a"); if (!target) return;
  if (target.id === 'configureCall') { await openCallDialog(); return; }
  if (target.id === 'callJump') {
    const caller={...flow(),entryPath:state.source}, called=resolveModuleCall(moduleCatalog(),caller,state.node);
    if(!called) {toast('模块或入口已不可用，请重新配置。');return;}
    const context={entryPath:state.source,flowId:caller.id,nodeId:state.node,...(!owned()?{callerWorkspace:copy(state.external)}:{})};
    moduleCallStack.push(context); browseReturn=null;
    await navigateFlow(called.module.entryPath,called.module.id,called.entry.id);
    if(state.source!==called.module.entryPath || state.flowId!==called.module.id) moduleCallStack.pop();
    return;
  }
  if (target.id === 'callBack') {
    const context=currentModuleContext();if(!context)return;
    moduleCallStack.pop();await navigateFlow(context.entryPath,context.flowId,context.nodeId);return;
  }
  if (target.id === 'moduleReturnJump') {
    const context=currentModuleContext(), modulePath=state.source, moduleId=state.flowId, outputId=state.node;
    if(!context){toast('请从调用节点进入此模块。');return;}
    if(context.entryPath!==state.path) {
      try {context.callerWorkspace=await api(`/api/flows?${new URLSearchParams({path:context.entryPath})}`);}
      catch(error){toast(`调用来源不可用：${error.message}`);return;}
    }
    const receiver=resolveModuleReturn(moduleCatalog(),context,modulePath,moduleId,outputId);
    if(!receiver){toast('本次调用的返回映射已变化或不可用，请返回调用节点检查。');return;}
    moduleCallStack.pop();await navigateFlow(receiver.entryPath,receiver.flowId,receiver.nodeId);return;
  }
  if (target.dataset.toggleBranch) { const branchKey = key(state.path,target.dataset.toggleBranch); if(collapsedFlowBranches.has(branchKey)) collapsedFlowBranches.delete(branchKey); else collapsedFlowBranches.add(branchKey); renderList(); return; }
  if (target.id === 'sourceJump') {
    event.preventDefault(); const origin = node()?.source;
    if (!origin || !findFlow(origin.entryPath,origin.flowId)?.nodes.some(n=>n.id===origin.nodeId)) { toast('来源节点不可用，请重新关联。'); return; }
    await navigateFlow(origin.entryPath,origin.flowId,origin.nodeId,true); return;
  }
  if (['outputLink', 'outputJump'].includes(target.id)) {
    event.preventDefault();
    const destination = nodeTarget(node());
    if (!destination || !findFlow(destination.entryPath, destination.flowId)?.nodes.some(n => n.id === destination.nodeId)) { toast('承接节点不可用，请重新关联。'); return; }
    await navigateFlow(destination.entryPath, destination.flowId, destination.nodeId,true); return;
  }
  if (target.dataset.navigateFlow) { event.preventDefault(); await navigateFlow(target.dataset.navigateSource,target.dataset.navigateFlow,target.dataset.locateNode); return; }
  if (target.dataset.close) { $(target.dataset.close).close(); return; }
  if (target.dataset.renameFlow) { await beginFlowRename(target.dataset.renameFlow); return; }
  if (target.dataset.selectFlow) { moduleCallStack.length = 0; await choose(target.dataset.selectSource, target.dataset.selectFlow); return; }
  if (target.dataset.addNode) { addNode(target.dataset.addNode); return; }
  if (target.dataset.restore) { const revision = Number(target.dataset.restore); $("versionsDialog").close(); if (!await guard() || await confirmAction("恢复流程版本", `将版本 ${revision} 的全部流程和关联恢复为新版本。`, { action: "恢复" }) !== "confirm") return; state.busy = true; renderStatus(); try { await api(`/api/flows/restore?${new URLSearchParams({ path: state.path })}`, writeOptions({ expectedRevision: state.workspace.revision, revision }, "POST")); await load(state.path, state.flowId); toast("已恢复为新版本"); } catch (error) { state.busy = false; state.error = error.message; renderStatus(); toast(error.message); } return; }
  if (target.tagName === "A" && !embedded && target.getAttribute("href")?.startsWith("/")) { if (workspaceBridge) return; event.preventDefault(); const url = target.href; if (await guard()) { saveView(); location.href = url; } return; }
  switch (target.id) {
    case "addButton": case "emptyAdd": await openNew(); break;
    case "linkButton": case "emptyLink": await openLibrary("link"); break;
    case "settingsButton": openSettings(); break;
    case "emptyNone": openSettings("not-needed"); break;
    case "parentButton": await openLibrary("parent"); break;
    case "detachParent": mutate(() => { flow().parent = null; }); break;
    case "saveButton": await save(); break;
    case "downloadFlowDraft": { const cached = state.recovery || { path: state.path, baseRevision: state.workspace?.revision, base: state.saved, content: state.workspace ? payload() : null, fields: state.fieldDrafts }; const url = URL.createObjectURL(new Blob([JSON.stringify(cached, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `${state.entry?.feature || "流程"}-未保存草稿.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break; }
    case "useRemoteFlow": { if (state.saving || await confirmAction("使用当前版本", "将清除本机未保存流程草稿并重新读取已保存版本。需要留存时，请先下载草稿。", { action: "使用当前版本" }) !== "confirm") break; if (annotations.flush && !await annotations.flush()) break; localStorage.removeItem(draftKey()); state.recovery = null; state.fieldDrafts = {}; state.dirty = false; await load(state.path, state.flowId, owned() ? "" : state.source, true); break; }
    case "mermaidButton": openMermaid(); break;
    case "focusFlowDraft": { const pending = Object.values(state.fieldDrafts)[0]; if (!pending) break; await choose(state.path, pending.flowId); if (pending.control === "mermaidSource") { openMermaid(pending); break; } state.node = pending.kind === "node" ? pending.itemId : ""; state.edge = pending.kind === "edge" ? pending.itemId : ""; setInspectorEditing(true); if(pending.control === "contractEditor") { contractEditor.openDraft(pending); break; } $(pending.control).focus(); $(pending.control).select(); break; }
    case "undoButton": undo(-1); break;
    case "redoButton": undo(1); break;
    case "selectTool": setMode("select"); break;
    case "panTool": setMode("pan"); break;
    case "connectTool": setMode("connect"); break;
    case "startConnection": state.connectFrom = state.node; setMode("connect"); break;
    case "addSupplement": await openNew({ entryPath: state.path, flowId: state.flowId, nodeId: state.node }); break;
    case "deleteSelection": await deleteSelection(); break;
    case "flowSettings": state.node = ""; state.edge = ""; render(); break;
    case "deleteFlow": { const current = flow(); if (!graphEditable() || !current) break; const callers = moduleCallers(catalog(),state.source,current.id); if(callers.length) {toast("此模块仍有调用位置，请先解除调用关系。");break;} const deps = children(); if (deps.length) { toast(`先解除补充关系：${deps.map((f) => f.name).join("、")}`); break; } if (await confirmAction("删除流程", `删除“${current.name}”？将自动保存，历史版本会保留。`, { action: "删除" }) !== "confirm") break; mutate(() => { state.workspace.flows = state.workspace.flows.filter((f) => f.id !== current.id); state.flowId = state.workspace.flows[0]?.id || ""; state.node = ""; state.edge = ""; }); fit(); break; }
    case "unlinkButton": { const source = state.source, id = state.flowId; mutate(() => { state.workspace.references = state.workspace.references.filter((r) => r.entryPath !== source || r.flowId !== id); state.source = state.path; state.flowId = state.workspace.flows[0]?.id || ""; state.node = ""; state.edge = ""; }); fit(); break; }
    case "zoomIn": zoom(state.view.scale * 1.2); break;
    case "zoomOut": zoom(state.view.scale / 1.2); break;
    case "zoomLabel": zoom(1); break;
    case "fitButton": fit(); break;
    case "exportButton": svgExport(); break;
    case "versionsButton": await showVersions(); break;
    case "helpButton": $("helpDialog").showModal(); break;
  }
});
let drag = null, spaceMode = null, spaceHeld = false, gestureFrame = 0, connectionPoint = null, connectionTarget = '';
function queueGesture() { if (!gestureFrame) gestureFrame = requestAnimationFrame(() => { gestureFrame = 0; paintGesture(); }); }
function drawGestureFeedback() {
  const scale = state.view.scale, pad = 8 / scale, tick = 3 / scale;
  $("flowGuides").innerHTML = (drag?.guides || []).map(g => g.axis === 'x'
    ? `<path d="M${g.at},${g.from - pad} V${g.to + pad} M${g.at - tick},${g.from - pad} h${tick * 2} M${g.at - tick},${g.to + pad} h${tick * 2}"/>`
    : `<path d="M${g.from - pad},${g.at} H${g.to + pad} M${g.from - pad},${g.at - tick} v${tick * 2} M${g.to + pad},${g.at - tick} v${tick * 2}"/>`).join('');
  const source = flow()?.nodes.find(n => n.id === state.connectFrom), target = flow()?.nodes.find(n => n.id === connectionTarget);
  let path = '';
  if (state.mode === 'connect' && source && connectionPoint) {
    if (target) path = edgeGeometry({ source: source.id, target: target.id, label: '' }, flow().nodes, [], flow().direction)?.d || '';
    else {
      path = curveGeometry(anchor(source, connectionPoint), connectionPoint).d;
    }
  }
  $("connectionPreview").setAttribute('d', path);
  for (const el of $("graph").querySelectorAll('[data-node]')) el.classList.toggle('connect-target', !!path && el.dataset.node === connectionTarget);
}
function paintGesture() {
  if (!drag) { drawGestureFeedback(); transform(); return; }
  const dx = drag.lastX - drag.x, dy = drag.lastY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  if (drag.type === 'pan') { state.view.x = drag.view.x + dx; state.view.y = drag.view.y + dy; transform(); return; }
  if (!graphEditable() || flow()?.id !== drag.flowId) { finishDrag(true); return; }
  const selected = flow().nodes.find(n => n.id === drag.id); if (!selected) return;
  const scale = state.view.scale, rawX = dx / scale, rawY = dy / scale;
  const snap = drag.alt || scale < .1 ? { dx: Math.round(rawX), dy: Math.round(rawY), guides: [] } : snapDelta([nodeBox({ ...selected, ...drag.start })], flow().nodes.filter(n => n.id !== drag.id).map(n => nodeBox(n)), rawX, rawY, 6 / scale, { previous: drag.guides, maxDistance: 240 / scale });
  const x = Math.round(Math.max(-100000, Math.min(100000, drag.start.x + snap.dx))), y = Math.round(Math.max(-100000, Math.min(100000, drag.start.y + snap.dy)));
  drag.position = { x, y }; drag.guides = snap.guides.filter(g => g.axis === 'x' ? x === drag.start.x + snap.dx : y === drag.start.y + snap.dy);
  const current = displayFlow(), geometry = geometryFor(current);
  const el = [...$("graph").querySelectorAll('[data-node]')].find(el => el.dataset.node === drag.id);
  if (el) { el.setAttribute('transform', `translate(${x} ${y})`); el.classList.add('dragging'); $("graph").append(el); }
  for (const el of $("graph").querySelectorAll('[data-edge]')) {
    const g = geometry.get(el.dataset.edge); if (!g) continue;
    for (const path of el.querySelectorAll('path')) path.setAttribute('d', g.d);
    el.querySelector('.edge-label')?.setAttribute('transform', `translate(${g.x} ${g.y})`);
  }
  drawGestureFeedback(); annotations.renderMarkers();
}
$("flowCanvas").addEventListener('pointerdown', event => {
  if (drag || event.button !== 0 && event.button !== 1 || !event.isPrimary) return;
  const n = event.target.closest('[data-node]'), e = event.target.closest('[data-edge]');
  if (state.mode === 'connect' && n && event.button === 0) { event.preventDefault(); connectNode(n.dataset.node); return; }
  const explicitPan = state.mode === 'pan' || event.button === 1, pan = explicitPan || (!n && !e);
  if (pan) drag = { type: 'pan', view: { ...state.view }, clearSelection: !explicitPan };
  else if (n) {
    state.node = n.dataset.node; state.edge = ''; renderInspector(); renderCanvas();
    if (graphEditable()) drag = { type: 'node', id: state.node, flowId: flow().id, start: { x: node().x, y: node().y }, guides: [] };
  } else if (e) { state.edge = e.dataset.edge; state.node = ''; renderInspector(); renderCanvas(); }
  renderStatus();
  if (drag) {
    Object.assign(drag, { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, pointerId: event.pointerId, alt: event.altKey, moved: false });
    event.preventDefault(); $("flowCanvas").setPointerCapture(event.pointerId);
    $("viewport").classList.toggle('gesture-pan', drag.type === 'pan'); $("viewport").classList.toggle('gesture-node', drag.type === 'node');
    $("viewport").focus({ preventScroll: true });
  }
});
$("flowCanvas").addEventListener('pointermove', event => {
  if (drag) { if (drag.pointerId !== event.pointerId) return; drag.lastX = event.clientX; drag.lastY = event.clientY; drag.alt = event.altKey; queueGesture(); }
  else if (state.mode === 'connect' && state.connectFrom) {
    const rect = $("viewport").getBoundingClientRect(); connectionPoint = { x: (event.clientX - rect.left - state.view.x) / state.view.scale, y: (event.clientY - rect.top - state.view.y) / state.view.scale }; connectionTarget = event.target.closest('[data-node]')?.dataset.node || ''; queueGesture();
  }
});
$("flowCanvas").addEventListener('pointerleave', () => { if (!drag) { connectionPoint = null; connectionTarget = ''; drawGestureFeedback(); } });
function finishDrag(cancel = false) {
  if (!drag) return;
  cancelAnimationFrame(gestureFrame); gestureFrame = 0;
  if (!cancel) paintGesture();
  const completed = drag; if (!completed) return; drag = null;
  $("viewport").classList.remove('gesture-pan', 'gesture-node');
  if ($("flowCanvas").hasPointerCapture(completed.pointerId)) $("flowCanvas").releasePointerCapture(completed.pointerId);
  if (completed.type === 'node') {
    const selected = flow()?.id === completed.flowId && flow().nodes.find(n => n.id === completed.id);
    if (!cancel && selected && completed.position && (selected.x !== completed.position.x || selected.y !== completed.position.y)) { Object.assign(selected, completed.position); record(); }
    else renderCanvas();
  } else {
    if (cancel) state.view = completed.view;
    else if (!completed.moved && completed.clearSelection) { state.node = ''; state.edge = ''; renderInspector(); renderCanvas(); }
    transform();
  }
  drawGestureFeedback(); saveView();
  if (spaceMode !== null && !spaceHeld) endSpace();
}
$("flowCanvas").addEventListener('pointerup', event => { if (drag?.pointerId !== event.pointerId) return; drag.lastX = event.clientX; drag.lastY = event.clientY; drag.alt = event.altKey; finishDrag(); });
$("flowCanvas").addEventListener('pointercancel', () => finishDrag(true));
$("flowCanvas").addEventListener('lostpointercapture', () => finishDrag(true));
$("flowCanvas").addEventListener('dblclick', event => { if (!event.target.closest('[data-node]') || !graphEditable()) return; $("nodeLabel").focus(); $("nodeLabel").select(); });
$("flowCanvas").addEventListener('keydown', event => {
  const target = event.target.closest('[data-node],[data-edge]');
  if (target && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); if (state.mode === 'connect' && target.dataset.node) { connectNode(target.dataset.node); return; }
    state.node = target.dataset.node || ''; state.edge = target.dataset.edge || ''; renderInspector(); renderCanvas(); renderStatus();
  }
});
$("viewport").addEventListener('wheel', event => {
  if (event.target.closest('button,a') || drag) return; event.preventDefault();
  const wheel = canvasWheel(event, $("viewport").clientHeight);
  if (wheel.zoom) {
    const rect = $("viewport").getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const next = Math.min(2.5, Math.max(MIN_FLOW_SCALE, state.view.scale * wheel.factor)), ratio = next / state.view.scale;
    state.view = { x: x - (x - state.view.x) * ratio, y: y - (y - state.view.y) * ratio, scale: next };
  } else { state.view.x -= wheel.dx; state.view.y -= wheel.dy; }
  queueGesture(); clearTimeout(saveView.timer); saveView.timer = setTimeout(saveView, 120);
}, { passive: false });
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (drag) {
    if (event.key === 'Escape') { event.preventDefault(); finishDrag(true); return; }
    if (event.key === 'Alt') { drag.alt = true; queueGesture(); }
    if (event.key !== 'Alt') event.preventDefault();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
  if (event.target.closest("input,textarea,select,[contenteditable=true]") || document.querySelector("dialog[open]")) return;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === "F2" && !mod && !event.altKey) { const row = event.target.closest("[data-flow-row]"); if ((row && row.dataset.flowSource !== state.path) || (!row && !owned())) return; event.preventDefault(); void beginFlowRename(row?.dataset.flowRow || state.flowId); return; }
  if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); save(); return; }
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey ? 1 : -1); return; }
  if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); undo(1); return; }
  if (mod) return;
  if (event.key === " " && event.target.closest("button,a")) return;
  if (event.key === " " && spaceMode === null) { event.preventDefault(); spaceHeld = true; spaceMode = state.mode; setMode("pan"); }
  else if (event.key.toLowerCase() === "v") setMode("select");
  else if (event.key.toLowerCase() === "h") setMode("pan");
  else if (event.key.toLowerCase() === "c" && graphEditable()) setMode("connect");
  else if (event.key === "Escape") { state.node = ""; state.edge = ""; setMode("select"); renderInspector(); }
  else if (event.shiftKey && (event.code === "Digit1" || event.key === "!")) { event.preventDefault(); fit(); }
  else if (event.key === "+" || event.key === "=") zoom(state.view.scale * 1.2);
  else if (event.key === "-") zoom(state.view.scale / 1.2);
  else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); }
  else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && graphEditable() && node()) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; mutate(() => { const n = node(); n.x = Math.max(-100000, Math.min(100000, n.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))); n.y = Math.max(-100000, Math.min(100000, n.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))); }); }
});
function endSpace() { if (spaceMode !== null) { const mode = spaceMode; spaceMode = null; setMode(mode); } }
document.addEventListener("keyup", event => { if (event.key === 'Alt' && drag) { drag.alt = false; queueGesture(); } if (event.key === ' ') { spaceHeld = false; if (!drag) endSpace(); } });
window.addEventListener('blur', () => { finishDrag(true); endSpace(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { finishDrag(true); endSpace(); } });
window.addEventListener("beforeunload", (event) => { finishFlowRename(); finishDrag(true); saveView(); persistDraft(); if (flowRename || dataDirty() || incomplete() || state.saving || annotations.isDirty()) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("workspace-save-state", () => renderStatus());
let viewportWidth = $("viewport").clientWidth;
window.addEventListener("resize", () => { const width = $("viewport").clientWidth; if (!width) return; if (Math.abs(width - viewportWidth) > 60) fit(); else transform(); viewportWidth = width; });
function openMermaid(pending = null) {
  if (!state.workspace || state.busy) return;
  const current = flow();
  pending ||= state.fieldDrafts[`mermaidSource:${current?.id}`] || (!current ? sourceDraft() : null);
  const canWrite = editable() && owned() && (!!current || state.workspace.flows.length < 40);
  if (!current && !canWrite) return;
  mermaidSession = { path: state.path, id: pending?.flowId || current?.id || uid(), canWrite, isNew: !current, preview: current ? copy(current) : null };
  $("mermaidTitle").textContent = canWrite ? "Mermaid" : "Mermaid · 只读";
  $("mermaidContext").textContent = current?.name || "新流程";
  $("mermaidNameField").hidden = !!current;
  $("mermaidName").value = pending?.name || "新流程";
  $("mermaidSource").value = pending?.value ?? serializeMermaid(current);
  $("mermaidSource").readOnly = !canWrite;
  $("mermaidImport").hidden = !canWrite;
  $("mermaidReset").hidden = !canWrite;
  $("mermaidError").textContent = "";
  $("mermaidSource").removeAttribute("aria-invalid");
  drawMermaidPreview(mermaidSession.preview); syncMermaidExport();
  $("mermaidDialog").showModal();
  syncPreviewArrow();
  if (pending) validateMermaid(false);
  $("mermaidSource").focus();
}
function drawMermaidPreview(current) {
  const b = bounds(current?.nodes || [], current);
  $("mermaidPreview").setAttribute("viewBox", `${b.x - 30} ${b.y - 30} ${b.w + 60} ${b.h + 60}`);
  $("mermaidGraph").innerHTML = graphMarkup(current, false).replaceAll('role="button" tabindex="0"', '');
  syncPreviewArrow();
}
function syncPreviewArrow() {
  if (!$("mermaidDialog").open) return;
  const scale = $("mermaidGraph").getScreenCTM()?.a;
  if (!scale) return;
  const marker = $("mermaidArrow"), size = arrowSize(scale);
  marker.setAttribute('markerWidth', size); marker.setAttribute('markerHeight', size);
}
new ResizeObserver(syncPreviewArrow).observe($("mermaidPreview"));
function queueMermaid() {
  if (!mermaidSession?.canWrite || mermaidSession.path !== state.path) return;
  state.fieldDrafts[`mermaidSource:${mermaidSession.id}`] = { control: "mermaidSource", kind: "mermaid", flowId: mermaidSession.id, isNew: mermaidSession.isNew, name: $("mermaidName").value, value: $("mermaidSource").value, error: "" };
  syncMermaidExport();
  state.dirty = true; persistDraft(); renderStatus();
  clearTimeout(mermaidTimer); mermaidTimer = setTimeout(() => applyMermaid(), 350);
}
function validateMermaid(apply = true) {
  const session = mermaidSession;
  if (!session?.canWrite || session.path !== state.path) return true;
  try {
    const current = state.workspace.flows.find(f => f.id === session.id);
    const graph = parseMermaid($("mermaidSource").value, current);
    const name = session.isNew ? $("mermaidName").value.trim() : current?.name;
    if (!name) throw new Error("请填写流程名称。");
    if (!current && !graph.nodes.length) throw new Error("添加至少一个节点后，将自动创建流程。");
    session.preview = { ...(current || {}), ...graph };
    drawMermaidPreview(session.preview);
    $("mermaidError").textContent = ""; $("mermaidSource").removeAttribute("aria-invalid");
    if (!apply) return true;
    delete state.fieldDrafts[`mermaidSource:${session.id}`];
    if (current) {
      if (JSON.stringify({ direction: current.direction || "TD", nodes: current.nodes, edges: current.edges, name: current.name }) !== JSON.stringify({ ...graph, name })) { Object.assign(current, graph, { name }); record(); }
      else { state.dirty = dataDirty() || incomplete(); persistDraft(); renderStatus(); }
    } else {
      if (state.workspace.flows.length >= 40) throw new Error("每个需求最多保存 40 个流程。");
      state.workspace.flows.push({ id: session.id, name, description: "", parent: null, ...graph });
      state.workspace.applicability = "needed"; state.workspace.reason = ""; state.source = state.path; state.flowId = session.id; state.node = ""; state.edge = ""; record();
    }
    $("mermaidContext").textContent = name; syncMermaidExport(); fit(); return true;
  } catch (error) {
    const draft = state.fieldDrafts[`mermaidSource:${session.id}`]; if (draft) draft.error = error.message;
    $("mermaidError").textContent = `${error.message} 画布保留上一版，源码草稿已留在本机。`;
    $("mermaidSource").setAttribute("aria-invalid", "true");
    persistDraft(); renderStatus(); return false;
  }
}
function applyMermaid() {
  clearTimeout(mermaidTimer);
  if (!$("mermaidDialog").open || !mermaidSession?.canWrite) return true;
  if (composing.has("mermaidSource")) return false;
  if (!state.fieldDrafts[`mermaidSource:${mermaidSession.id}`]) return true;
  return validateMermaid();
}
async function closeMermaid() {
  if (await flushFlow()) { $("mermaidDialog").close(); fit(); }
  else $("mermaidSource").focus();
}
$("mermaidSource").addEventListener("input", queueMermaid);
$("mermaidName").addEventListener("input", queueMermaid);
$("mermaidSource").addEventListener("compositionstart", () => composing.add("mermaidSource"));
$("mermaidSource").addEventListener("compositionend", () => { composing.delete("mermaidSource"); queueMermaid(); });
$("mermaidSource").addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } });
$("mermaidDialog").addEventListener("cancel", event => { event.preventDefault(); void closeMermaid(); });
$("mermaidClose").addEventListener("click", closeMermaid);
$("mermaidDone").addEventListener("click", closeMermaid);
$("mermaidReset").addEventListener("click", () => {
  if (!mermaidSession?.canWrite) return;
  clearTimeout(mermaidTimer); composing.delete("mermaidSource");
  const current = state.workspace.flows.find(f => f.id === mermaidSession.id);
  delete state.fieldDrafts[`mermaidSource:${mermaidSession.id}`];
  $("mermaidSource").value = serializeMermaid(current); $("mermaidError").textContent = ""; $("mermaidSource").removeAttribute("aria-invalid");
  mermaidSession.preview = current; drawMermaidPreview(current); syncMermaidExport(); state.dirty = dataDirty() || incomplete(); persistDraft(); renderStatus(); $("mermaidSource").focus();
});
$("mermaidImport").addEventListener("click", () => $("mermaidFile").click());
$("mermaidFile").addEventListener("change", async () => {
  const file = $("mermaidFile").files[0], session = mermaidSession; $("mermaidFile").value = "";
  if (!file || !session?.canWrite) return;
  try {
    if (file.size > 400000) throw new Error("文件过大，Mermaid 源码最多 100,000 字符。");
    const text = await file.text(); if (session !== mermaidSession || !$("mermaidDialog").open) return;
    if (text.length > 100000) throw new Error("Mermaid 源码最多 100,000 字符。");
    $("mermaidSource").value = text;
    if (session.isNew && !state.workspace.flows.some(f => f.id === session.id)) $("mermaidName").value = file.name.replace(/\.(mmd|mermaid|md|txt)$/i, "").slice(0, 100) || "新流程";
    queueMermaid(); applyMermaid();
  } catch (error) { $("mermaidError").textContent = error.message; }
});
function syncMermaidExport() {
  const current = flow(), workspace = owned() ? state.workspace : state.external?.workspace;
  const link = $("mermaidExport");
  if (!current || !workspace?.revision) { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); return; }
  link.removeAttribute("aria-disabled");
  link.href = `/api/flows/export-mermaid?${new URLSearchParams({ path: state.source, flow: current.id, revision: workspace.revision })}`;
  link.download = `${current.name.replace(/[\\/:*?"<>|]/g, "-")}.mmd`;
}
$("mermaidExport").addEventListener("click", async event => {
  if (dataDirty() || incomplete() || state.saving) { event.preventDefault(); if (await flushFlow()) { syncMermaidExport(); $("mermaidExport").click(); } }
});


async function init() {
  try {
    const tree = await api("/api/tree"); state.tree = tree.modules.flatMap((m) => m.features);
    $("requirementSelect").innerHTML = state.tree.map((entry) => `<option value="${escape(entry.path)}">${escape(entry.feature)}</option>`).join("");
    if (!state.path) state.path = tree.latestEntryPath || state.tree[0]?.path || "";
    if (!state.path) { $("emptyDescription").textContent = "先在需求目录中建立一项需求。"; state.error = "未找到需求"; renderStatus(); return; }
    await load(state.path, params.get("flow") || "", params.get("flowSource") || "");
    const requestedNode = params.get("node"), selected = flow()?.nodes.find(item => item.id === requestedNode);
    if (selected) {
      state.node = selected.id; state.edge = "";
      const point = center(selected); state.view.scale = Math.max(.7, state.view.scale);
      state.view.x = $("viewport").clientWidth / 2 - point.x * state.view.scale;
      state.view.y = $("viewport").clientHeight / 2 - point.y * state.view.scale;
      renderInspector(); renderCanvas(); renderStatus(); saveView();
    }
    params.delete("action");
    if (startupAction === "routes") await routeAudit.open();
    if (!embedded && editable()) {
      if (startupAction === "new") await openNew(); else if (startupAction === "link") await openLibrary("link"); else if (startupAction === "not-needed") openSettings("not-needed");
    }
  } catch (error) { state.error = error.message; renderStatus(); toast(error.message); }
  finally { initialized = true; }
}
workspaceBridge = installWorkspaceBridge({
  kind: "flow",
  getState() { const notes = annotations.getStatus?.() || {}; const dirty = state.dirty || !!notes.dirty || !!state.recovery; const saving = state.saving || !!notes.saving; const error = state.error || notes.error || (incomplete() && !flowRename ? contractDraft() ? contractDraft().error || "请补全未完成的参数" : sourceDraft() ? sourceDraft().error || "" : "请补全未完成的名称输入" : ""); const readonly = embedded || !state.canEdit || !owned(); return { path: state.path, flowId: state.flowId, sourcePath: state.source || state.path, routeAuditOpen: $("routeAuditDialog").open, dirty, saving, status: error ? "error" : state.busy ? "loading" : saving ? "saving" : dirty ? "pending" : readonly ? "readonly" : "saved", error }; },
  flush: guard,
  async activate(options = {}) {
    const { flowId = "", sourcePath = "", nodeId = "", action = "" } = options;
    const startupReplay = !initialized && !!action && action === startupAction;
    if (initialization) await initialization;
    if (!await guard()) return false;
    if ($("mermaidDialog").open) $("mermaidDialog").close();
    if (flowId) await choose(sourcePath || state.path, flowId);
    for (const name of ["fromPath", "fromFlow", "fromSource"]) if (Object.hasOwn(options, name)) {
      if (typeof options[name] === "string" && options[name]) params.set(name, options[name]); else params.delete(name);
    }
    if (Object.hasOwn(options, "zoom") && options.zoom !== "" && Number.isFinite(Number(options.zoom))) {
      const scale = Math.min(2.5, Math.max(MIN_FLOW_SCALE, Number(options.zoom))); params.set("zoom", String(scale)); zoom(scale);
    }
    const hasNode = Object.hasOwn(options, "node") || Object.hasOwn(options, "nodeId") && nodeId !== "";
    if (hasNode) {
      const selected = flow()?.nodes.find((item) => item.id === nodeId);
      state.node = selected?.id || ""; state.edge = "";
      if (nodeId) params.set("node", nodeId); else params.delete("node");
      if (selected && $("viewport").clientWidth && $("viewport").clientHeight) { const point = center(selected); state.view.x = $("viewport").clientWidth / 2 - point.x * state.view.scale; state.view.y = $("viewport").clientHeight / 2 - point.y * state.view.scale; }
    }
    for (const axis of ["x", "y"]) if (Object.hasOwn(options, axis) && options[axis] !== "" && Number.isFinite(Number(options[axis]))) { state.view[axis] = Number(options[axis]); params.set(axis, String(state.view[axis])); }
    render(); transform(); saveView();
    params.delete("action");
    if (!startupReplay) {
      if(action==="routes") await routeAudit.open();
      if (action === "new") await openNew(); else if (action === "link") await openLibrary("link"); else if (action === "not-needed") openSettings("not-needed");
    }
    workspaceBridge?.notify(); return true;
  },
});
initialization = init();

$("collapseFlowTree").addEventListener("click", () => {
  for (const item of state.workspace?.flows || []) collapsedFlowBranches.add(key(state.path,item.id));
  renderList();
});
$("expandFlowTree").addEventListener("click", () => {
  for (const item of state.workspace?.flows || []) collapsedFlowBranches.delete(key(state.path,item.id));
  renderList();
});

function setNodeAppearance(n, value) {
  delete n.supplement; delete n.variant;
  if (value === "blue") n.supplement = true;
  if (value === "branch") n.variant = "branch";
}

// Buffer appearance edits in a dialog; apply as one undoable workspace change.
let appearanceContext = null, appearanceLanes = [];
function renderAppearanceLanes() {
  $("appearanceLanes").innerHTML = appearanceLanes.map((lane,i) => `<fieldset class="appearance-lane" data-lane-index="${i}"><legend>泳道 ${i+1}</legend><label>名称<input data-lane-field="label" aria-label="泳道 ${i+1} 名称" maxlength="100" value="${escape(lane.label)}" required></label><div class="lane-dimensions">${[['x','横坐标'],['y','纵坐标'],['width','宽度'],['height','高度']].map(([field,label])=>`<label>${label}<input type="number" data-lane-field="${field}" aria-label="泳道 ${i+1} ${label}" min="${field==='width'||field==='height'?1:-100000}" max="100000" value="${lane[field]}" required></label>`).join('')}</div><button type="button" data-remove-lane="${i}" title="仅移除泳道边框，保留节点">移除泳道</button></fieldset>`).join('') || '<p class="muted">当前流程没有泳道。</p>';
  $("appearanceAddLane").disabled = appearanceLanes.length >= 12;
}
function readAppearanceLanes() {
  for (const row of $("appearanceLanes").querySelectorAll('[data-lane-index]')) {
    const lane = appearanceLanes[Number(row.dataset.laneIndex)];
    for (const input of row.querySelectorAll('[data-lane-field]')) lane[input.dataset.laneField] = input.dataset.laneField === 'label' ? input.value.trim() : input.value === '' ? NaN : Number(input.value);
  }
}
$("flowAppearanceButton").addEventListener('click',()=>{
  if (!graphEditable() || !flow()) return;
  appearanceContext = {flowId:flow().id,source:state.source,nodeId:node()?.id,edgeId:edge()?.id};
  appearanceLanes = copy(flow().lanes || []);
  $("appearanceNode").hidden = !node(); $("appearanceEdge").hidden = !edge();
  $("appearanceNodeStyle").value = node()?.variant === 'branch' ? 'branch' : node()?.supplement ? 'blue':'default';
  $("appearanceIssues").value = (node()?.issues || []).join(', ');
  $("appearanceEdgeStyle").value = edge()?.trace || 'default';
  $("appearanceError").textContent = ''; renderAppearanceLanes(); $("flowAppearanceDialog").showModal();
});
$("appearanceAddLane").addEventListener('click',()=>{
  readAppearanceLanes(); if(appearanceLanes.length>=12)return;
  const last=appearanceLanes.at(-1);
  appearanceLanes.push({id:uid(),label:`泳道 ${appearanceLanes.length+1}`,x:last&&Number.isFinite(last.x+last.width)?last.x+last.width:0,y:last?.y||0,width:300,height:last?.height||900});renderAppearanceLanes();
});
$("appearanceLanes").addEventListener('click',event=>{
  const button=event.target.closest('[data-remove-lane]');if(!button)return;
  readAppearanceLanes();appearanceLanes.splice(Number(button.dataset.removeLane),1);renderAppearanceLanes();
});
$("flowAppearanceForm").addEventListener('submit',event=>{
  event.preventDefault();readAppearanceLanes();
  if(!graphEditable() || flow()?.id!==appearanceContext?.flowId || state.source!==appearanceContext?.source){$("appearanceError").textContent='流程已切换，请关闭后重新打开。';return;}
  const issues=[...new Set($("appearanceIssues").value.toUpperCase().split(/[,，、\s]+/).filter(Boolean).map(v=>/^P\d$/.test(v)?`P0${v.slice(1)}`:v))];
  if(appearanceContext.nodeId && (issues.length>5 || issues.some(v=>!/^P[0-9]{2}$/.test(v)))){$("appearanceError").textContent='问题标记请用 P01 等格式，最多 5 个。';return;}
  if(appearanceLanes.some(l=>!l.label || [l.x,l.y,l.width,l.height].some(v=>!Number.isFinite(v)||Math.abs(v)>100000)||l.width<=0||l.height<=0)){$("appearanceError").textContent='请填写泳道名称及有效范围，宽高须大于 0。';return;}
  const next=copy(flow()), n=next.nodes.find(n=>n.id===appearanceContext.nodeId), e=next.edges.find(e=>e.id===appearanceContext.edgeId);
  if(n){setNodeAppearance(n, $("appearanceNodeStyle").value);if(issues.length)n.issues=issues;else delete n.issues;}
  if(e){if($("appearanceEdgeStyle").value==='default')delete e.trace;else e.trace=$("appearanceEdgeStyle").value;}
  if(appearanceLanes.length)next.lanes=copy(appearanceLanes);else delete next.lanes;
  $("flowAppearanceDialog").close();
  if(JSON.stringify(next)!==JSON.stringify(flow()))mutate(()=>{const current=flow();delete current.lanes;Object.assign(current,next);});
});

// Presentation preference only; never changes the flow model or canvas coordinates.
const flowPanelKey = "requirementsPortal.flowListWidth.v1";
const flowResize = $("flowListResize");
function setFlowListWidth(value) {
  const max = Math.max(180, Math.min(520, innerWidth - 320));
  const width = Math.max(180, Math.min(max, value));
  document.body.style.setProperty("--left-panel-width", `${width}px`);
  flowResize.setAttribute("aria-valuemax", String(max));
  flowResize.setAttribute("aria-valuenow", String(Math.round(width)));
  return width;
}
function persistFlowListWidth() {
  try { localStorage.setItem(flowPanelKey, flowResize.getAttribute("aria-valuenow")); } catch {}
}
try {
  const stored = Number(localStorage.getItem(flowPanelKey));
  setFlowListWidth(stored >= 180 ? stored : 264);
} catch { setFlowListWidth(264); }
flowResize.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault();
  flowResize.setPointerCapture(event.pointerId);
  const start = event.clientX, width = Number(flowResize.getAttribute("aria-valuenow"));
  const move = e => setFlowListWidth(width + e.clientX - start);
  const end = () => {
    flowResize.removeEventListener("pointermove", move);
    flowResize.removeEventListener("pointerup", end);
    flowResize.removeEventListener("pointercancel", end);
    flowResize.removeEventListener("lostpointercapture", end);
    persistFlowListWidth();
  };
  flowResize.addEventListener("pointermove", move);
  flowResize.addEventListener("pointerup", end);
  flowResize.addEventListener("pointercancel", end);
  flowResize.addEventListener("lostpointercapture", end);
});
flowResize.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const width = Number(flowResize.getAttribute("aria-valuenow"));
  setFlowListWidth(event.key === "Home" ? 180 : event.key === "End" ? 520 : width + (event.key === "ArrowRight" ? 10 : -10));
  persistFlowListWidth();
});
flowResize.addEventListener("dblclick", () => { setFlowListWidth(264); persistFlowListWidth(); });
window.addEventListener("resize", () => setFlowListWidth(Number(flowResize.getAttribute("aria-valuenow"))));

installFlowInspectorLayout();
