import { icon, controlHint, iconButton, iconButtons } from "./workbench-icons.js";
import { createDesignDescriptions } from './design-description.js';
import { pageStates } from "./design-states.js";
import { clone, clamp, arrangePages, fitPages, blankHtml, createPageId, copyPages, samePages, createDesignEditHistory, uniquePageName, nextPagePosition } from "./design-model.js";
import { pageOrganization, pageGroups, bounds, intersects, movePages, organizePages, snapDelta, reorderPages, zoomAt, canvasWheel } from "./design-navigation.js";
import { createElementEditor } from "./design-elements.js";
import { createPageAnnotations } from "./page-annotations.js";
import { installWorkspaceBridge } from "./workspace-bridge.js";
import { createDesignExporter } from "./design-export.js";

const $ = (id) => document.getElementById(id);
iconButtons(document, [
  ["versionsButton", "history", "版本历史"],
  ["selectTool", "select", "选择", "V"],
  ["panTool", "hand", "拖动画布", "H"],
  ["arrangeButton", "grid", "整理选中"],
  ["fitButton", "expand", "适应全部", "Shift 1"],
  ["reviewLinkButton", "copy", "复制评审链接"],
  ["duplicateButton", "copy", "复制页面", "⌘/Ctrl D"],
  ["exportPageButton", "download", "导出画板"],
  ["deleteButton", "trash", "删除页面"],
  ["editButton", "code", "编辑 HTML"],
  ["previousPage", "previous", "上一页"],
  ["nextPage", "next", "下一页"],
  ["previewAnnotationsButton", "link", "元素关联"],
  ["returnFlowContext", "back", "返回流程节点"],
  ["undoButton", "undo", "撤销", "⌘/Ctrl Z"],
  ["redoButton", "redo", "重做", "⌘/Ctrl Shift Z"],
  ["importButton", "upload", "导入已有原型"],
  ["shortcutsButton", "help", "快捷键"],
  ["treeCollapseButton", "outline", "收起全部分组"],
  ["panelToggle", "sidebar", "隐藏面板", "Tab"],
  ["zoomOut", "minus", "缩小", "−"],
  ["zoomIn", "plus", "放大", "+"]
]);
const state = { path: "", entry: null, workspace: { revision: 0, pages: [] }, selected: "", selection: [], editable: false, accessMode: "local",
  dirty: false, busy: false, saving: false, saveError: "", conflict: false, change: 0, mode: "select", view: { x: 50, y: 100, scale: .7 }, request: 0, expanded: null };
// Expanded states belong to the current view, never to the saved workspace.
const canvasPages = () => state.expanded?.pages || state.workspace.pages;
const selected = () => canvasPages().find((page) => page.id === state.selected);
const buttons = ["saveButton", "addButton", "emptyAdd", "importButton", "arrangeButton"];
let editHistory = createDesignEditHistory(), savedPages = [], savedOverview = '', spaceMode = null;
let workspaceBridge = null, pageAnnotations = null, saveTimer, savePromise = null, editorTimer, editorTargetId = "", draftBaseRevision = null, draftBaseHash = null, savedHash = "";
let fieldDrafts = {}, htmlDrafts = {}, storageWarning = "";
let pageRename = null, importing = false, elementEditor = null, elementReturnView = null;
let designExporter = null, descriptions = null;
const composing = new Set();
const initialParams = new URLSearchParams(location.search);
const shell = initialParams.get("shell") === "1";
document.body.classList.toggle("workspace-shell", shell);
$("pageContextActions").append($("annotationsButton"));
$("historyActions").append($("undoButton"), $("redoButton"), $("versionsButton"));
if (shell) {
  $("historyActions").append($("saveButton"));
  $("statesContext").before($("returnFlowContext"));
}
for (const button of document.querySelectorAll('[data-close]:not(#returnCanvasButton):not(#descriptionDialog .dialog-actions button)')) iconButton(button, 'close', button.getAttribute('aria-label') || '关闭页面预览');
controlHint($('zoomLabel'), '还原到 100%');
controlHint($('fitSelectionButton'), '定位选中 · Shift 2');
let returnParams = initialParams.get("return") || "";
const rawFlowReturn = initialParams.get("flowReturn") || "";
let flowReturn = rawFlowReturn.startsWith("/flow?") && !/[\r\n]/.test(rawFlowReturn) ? rawFlowReturn : "";
function updateFlowReturn(value = "") {
  flowReturn = typeof value === "string" && value.startsWith("/flow?") && !/[\r\n]/.test(value) ? value : "";
  $("returnFlowContext").hidden = !flowReturn;
  if (flowReturn) $("returnFlowContext").href = flowReturn;
  else $("returnFlowContext").removeAttribute("href");
}
function portalUrl(view = "doc", doc = "requirement") {
  const params = new URLSearchParams({ path: state.path, view, doc });
  if (view === "preview" && savedPages.some((page) => page.id === state.selected)) params.set("prototype", `design:${state.selected}`);
  return `/#${params}`;
}
function syncLocation() {
  if (!state.entry || state.expanded) return;
  const params = new URLSearchParams({ path: state.path });
  if (state.selected) params.set("page", state.selected);
  if (returnParams) params.set("return", returnParams);
  if (flowReturn) params.set("flowReturn", flowReturn);
  if (shell) params.set("shell", "1");
  if (initialParams.get("embed") === "1") params.set("embed", "1");
  if (initialParams.get("standalone") === "1") params.set("standalone", "1");
  if (initialParams.get("shellToken")) params.set("shellToken", initialParams.get("shellToken"));
  history.replaceState(null, "", `/design?${params}`);
  if (!returnParams) $("portalLink").href = portalUrl("preview");
}
function pagesFingerprint(pages, overview = '') {
  if(overview) pages=[...pages,{overview}];
  const text = JSON.stringify(pages.map((page) => Object.fromEntries(Object.keys(page).sort().map((key) => [key, page[key]]))));
  let first = 2166136261, second = 5381;
  for (let index = 0; index < text.length; index++) { const value = text.charCodeAt(index); first = Math.imul(first ^ value, 16777619); second = Math.imul(second, 33) ^ value; }
  return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}
function resetHistory() { savedPages = copyPages(state.workspace.pages); savedOverview=state.workspace.overview||''; savedHash = pagesFingerprint(savedPages,savedOverview); editHistory = createDesignEditHistory(state.workspace); }
async function travelHistory(direction) {
  if (elementEditor?.pageId && !await elementEditor.flush()) return;
  if (!state.editable || state.busy || state.expanded) return;
  if (!finishPageRename()) return;
  const snapshot = editHistory[direction](); if (!snapshot) return;
  const pages=snapshot.pages;state.workspace.overview=snapshot.overview;
  const previous = selected();
  state.workspace.pages = pages;
  const ids = new Set(pages.map((page) => page.id));
  fieldDrafts = Object.fromEntries(Object.entries(fieldDrafts).filter(([key]) => ids.has(key.slice(0, key.lastIndexOf(":")))));
  htmlDrafts = Object.fromEntries(Object.entries(htmlDrafts).filter(([id]) => ids.has(id)));
  if (!pages.some((page) => page.id === state.selected)) {
    state.selected = previous ? pages.slice().sort((left, right) => Math.hypot(left.x - previous.x, left.y - previous.y) - Math.hypot(right.x - previous.x, right.y - previous.y))[0]?.id || "" : pages[0]?.id || "";
  }
  state.change++; state.dirty = !samePages(pages, savedPages) || (state.workspace.overview||'')!==savedOverview; persistDraft(); scheduleSave(); renderCanvas(); syncLocation();
}

let toastTimer;
function toast(message, error = false) {
  (document.querySelector("dialog[open]") || document.body).append($("toast"));
  $("toast").textContent = message; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, error ? 10000 : 3200);
}
async function api(action = "", options = {}, entryPath = state.path) {
  const response = await fetch(`/api/design${action}${action.includes("?") ? "&" : "?"}path=${encodeURIComponent(entryPath)}`, {
    ...options, headers: { "Content-Type": "application/json", "X-Design-Client": "workbench-v1", ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `请求失败：${response.status}`); error.status = response.status; throw error; }
  return result;
}
function dirty(delay = 600) {
  if (!editHistory.record(state.workspace)) return;
  state.dirty = !samePages(state.workspace.pages, savedPages) || (state.workspace.overview||'')!==savedOverview; state.change++; persistDraft(); scheduleSave(delay); renderStatus(); syncLocation();
}
function hasInputDraft() { return Object.keys(fieldDrafts).length > 0 || Object.keys(htmlDrafts).length > 0; }
function draftKey() { return `requirementsPortal.designDraft.v2:${encodeURIComponent(state.path)}`; }
function clearDraft() {
  for (const name of ["localStorage", "sessionStorage"]) try { window[name].removeItem(draftKey()); } catch { /* Storage may be unavailable in private contexts. */ }
}
function persistDraft() {
  if (!state.path || !state.entry || !state.editable) return;
  if (!state.dirty && !state.saving && !hasInputDraft() && !state.conflict) { clearDraft(); storageWarning = ""; return; }
  const text = JSON.stringify({ version: 2, path: state.path, baseRevision: draftBaseRevision ?? state.workspace.revision,
    baseHash: draftBaseHash ?? savedHash,
    pages: state.workspace.pages, overview:state.workspace.overview||'', selected: state.expanded?.selectedId || state.selected, fieldDrafts, htmlDrafts, updatedAt: Date.now() });
  for (const name of ["localStorage", "sessionStorage"]) {
    try { window[name].setItem(draftKey(), text); storageWarning = ""; return; } catch { /* Try the tab-local fallback before reporting a storage limit. */ }
  }
  storageWarning = "本机草稿空间不足，请保持页面打开并完成保存";
}
function readDraft() {
  let newest = null;
  for (const name of ["localStorage", "sessionStorage"]) try {
    const value = JSON.parse(window[name].getItem(draftKey()) || "null");
    if (value?.version === 2 && value.path === state.path && Number.isInteger(value.baseRevision)
      && Array.isArray(value.pages) && value.pages.length <= 120 && value.pages.every((page) => page && /^[a-zA-Z0-9_-]{1,80}$/.test(page.id)
        && typeof page.name === "string" && page.name.trim() && page.name.length <= 100 && typeof page.html === "string" && page.html.length <= 600000
        && Number.isInteger(page.width) && page.width >= 240 && page.width <= 2560 && Number.isInteger(page.height) && page.height >= 200 && page.height <= 6000
        && Number.isFinite(page.x) && Math.abs(page.x) <= 100000 && Number.isFinite(page.y) && Math.abs(page.y) <= 100000)
      && new Set(value.pages.map((page) => page.id)).size === value.pages.length && (!newest || value.updatedAt > newest.updatedAt)) newest = value;
  } catch { /* Corrupt or old browser drafts never replace a valid file. */ }
  return newest;
}
function inputProblem() {
  if (composing.size) return "输入完成后自动保存";
  const pendingFields = Object.keys(fieldDrafts).filter((key) => key !== (pageRename && `${pageRename.id}:name`));
  if (pendingFields.some((key) => key.endsWith(":route"))) return "预览路由须以 # 开头";
  if (pendingFields.length) return "请补全有效的页面名称、尺寸或位置";
  for (const html of Object.values(htmlDrafts)) { const error = htmlProblem(html); if (error) return error; }
  return "";
}
function saveStatus() {
  const notes = pageAnnotations?.getStatus?.() || {};
  const error = state.saveError || (composing.size ? "" : inputProblem()) || notes.error || storageWarning;
  const saving = state.saving || !!notes.saving;
  const pending = state.dirty || hasInputDraft() || !!notes.dirty || state.conflict;
  return { path: state.path, pageId: state.expanded?.selectedId || state.selected, dirty: pending, saving,
    status: error ? "error" : state.busy ? "loading" : saving ? "saving" : pending ? "pending" : !state.editable ? "readonly" : "saved", error };
}
function scheduleSave(delay = 600) {
  clearTimeout(saveTimer);
  if (state.dirty && state.editable && !state.busy && !state.saveError && !state.conflict) saveTimer = setTimeout(() => { void saveSnapshot(); }, delay);
}
// A request acknowledges only its immutable snapshot. Edits made while it is in
// flight stay in the workspace and become the next serialized request.
async function saveSnapshot() {
  if (savePromise) return savePromise;
  if (!state.editable || state.busy || state.conflict || state.saveError) return false;
  const path = state.path, request = state.request;
  savePromise = (async () => {
    while (state.dirty && !state.saveError && !state.conflict) {
      const pages = copyPages(state.workspace.pages), overview=state.workspace.overview||'', expectedRevision = state.workspace.revision;
      state.saving = true; renderStatus();
      try {
        const result = await api("", { method: "PUT", body: JSON.stringify({ expectedRevision, pages, overview }) }, path);
        if (path !== state.path || request !== state.request) return false;
        state.workspace.revision = result.workspace.revision; state.workspace.updatedAt = result.workspace.updatedAt;
        // Accept server-added element IDs only if that page was not edited while saving.
        for (const saved of result.workspace.pages) {
          const submitted = pages.find(p => p.id === saved.id), current = state.workspace.pages.find(p => p.id === saved.id);
          if (current && submitted && current.html === submitted.html) current.html = saved.html;
        }
        savedPages = copyPages(result.workspace.pages); savedOverview=result.workspace.overview||''; savedHash = pagesFingerprint(savedPages,savedOverview); draftBaseRevision = null; draftBaseHash = null;
        state.dirty = !samePages(state.workspace.pages, savedPages) || (state.workspace.overview||'')!==savedOverview; persistDraft();
      } catch (error) {
        if (path !== state.path || request !== state.request) return false;
        state.conflict = error.status === 409; draftBaseRevision = expectedRevision; draftBaseHash = savedHash;
        state.saveError = state.conflict ? "内容已在其他窗口更新，草稿已保留" : error.message;
        persistDraft(); toast(`${state.saveError}。请点击${state.conflict ? "处理冲突" : "重试保存"}。`, true);
        return false;
      } finally { if (path === state.path && request === state.request) { state.saving = false; persistDraft(); renderStatus(); } }
    }
    return !state.dirty && !state.saveError;
  })();
  try { return await savePromise; } finally { savePromise = null; renderStatus(); }
}
async function flushDesign() {
  if (elementEditor?.pageId && !await elementEditor.flush()) return false;
  finishNudge(); if(["pagePlatform","pageGroup"].includes(document.activeElement?.id))commitOrganization(document.activeElement.id); clearTimeout(saveTimer); clearTimeout(editorTimer);
  if (state.busy || composing.size) return false;
  if (!finishPageRename()) return false;
  applyEditorDraft();
  const problem = inputProblem();
  if (problem) { persistDraft(); renderStatus(); toast(problem, true); return false; }
  if (state.saveError || state.conflict) { renderStatus(); toast("保存尚未完成，请先处理顶部的保存提示", true); return false; }
  if (savePromise && !await savePromise) return false;
  return state.dirty ? saveSnapshot() : true;
}
async function flushAll() {
  if (!await flushDesign()) return false;
  if (pageAnnotations.flush && !await pageAnnotations.flush()) return false;
  return flushDesign();
}
function renderStatus() {
  designExporter?.update();
  const current = saveStatus(), status = $("saveState"); status.className = current.status === "error" ? "error" : current.dirty ? "dirty" : "";
  status.textContent = state.busy ? "正在加载…" : !state.editable ? "只读" : current.status === "error" ? "保存未完成" : current.saving ? "自动保存中…" : current.dirty ? "等待自动保存" : "已自动保存";
  status.title = current.error || "修改会自动保存到当前需求";
  for (const id of buttons) $(id).disabled = !state.entry || !state.editable || state.busy;
  $("saveButton").disabled ||= !current.dirty && !current.error || current.saving;
  $("saveButton").textContent = state.conflict ? "处理冲突" : current.error ? "重试保存" : "立即保存";
  $("saveButton").classList.toggle("primary", !!current.error);
  $("saveButton").title = current.error || "修改会自动保存，也可以立即保存";
  for (const id of ["addButton", "emptyAdd", "importButton"]) $(id).disabled ||= !!state.expanded || !!elementEditor?.pageId;
  $("importButton").disabled ||= importing;
  $("arrangeButton").disabled = selectionPages().length < 2 || state.busy || (!state.editable && !state.expanded);
  $("versionsButton").disabled = !state.entry || state.busy || !!state.expanded || !!elementEditor?.pageId;
  $("fitSelectionButton").disabled = !selected(); $("fitGroupButton").disabled = !selected();
  $("annotationsButton").disabled ||= state.selection.length > 1; $("reviewLinkButton").disabled ||= state.selection.length > 1;
  $("elementEditButton").disabled = !selected() || state.selection.length !== 1 || !state.editable || state.busy || !!state.expanded;
  $("elementEditButton").hidden = !!elementEditor?.pageId;
  $("previewButton").disabled = !selected() || selected().status==='planned'; $("mobilePreviewButton").disabled = $("previewButton").disabled;
  $("undoButton").disabled = (!editHistory.canUndo && !(elementEditor?.pageId && htmlDrafts[elementEditor.pageId] !== undefined)) || !state.editable || state.busy || !!state.expanded;
  $("redoButton").disabled = !editHistory.canRedo || !state.editable || state.busy || !!state.expanded;
  $("reviewLinkButton").disabled = !selected() || state.selection.length > 1 || !!state.expanded || state.busy;
  controlHint($("reviewLinkButton"), "复制评审链接");
  $("storageHint").textContent = state.accessMode === "team" ? "团队共享 · 自动保存" : state.editable ? "自动保存" : "只读访问 · 本机可编辑";
  $("editorSaveState").textContent = $("editorDialog").open ? inputProblem() || (state.saveError ? state.saveError : current.saving ? "自动保存中…" : htmlDrafts[editorTargetId] !== undefined || state.dirty ? "等待自动保存" : "已自动保存") : "";
  $("editorSaveState").classList.toggle("error", !composing.size && !!inputProblem() || !!state.saveError);
  document.title = `${current.dirty ? "* " : ""}${state.entry?.feature || "设计工作台"} · 设计工作台`;
  workspaceBridge?.notify();
}
function updateStateDisclosure() {
  const page = selected(), declared = pageStates(page);
  const count = state.expanded?.pages.length || (declared.length ? declared.length + Number(!declared.some(item => item.route === (page.route || ""))) : 0);
  const name = state.expanded?.parentName || page?.name || "";
  $("statesContext").hidden = !count;
  $("expandedPageName").textContent = name;
  $("pageStateCount").textContent = String(count);
  const toggle = $("collapseStatesButton");
  toggle.setAttribute("aria-expanded", String(!!state.expanded));
  controlHint(toggle, `${state.expanded ? "收起" : "展开"} ${name} 的页面状态`);
  toggle.disabled = state.busy;
}
function updateInspector() {
  descriptions?.update();
  updateStateDisclosure();
  document.body.classList.toggle("states-expanded", !!state.expanded);
  const page = selected(), disabled = !page || !state.editable || state.busy || !!state.expanded;
  $("annotationsButton").disabled = !page || state.busy;
  $("previewAnnotationsButton").disabled = !page || state.busy;
  for (const id of ["pageName", "pageWidth", "pageHeight", "pageX", "pageY", "pageRoute", "pagePreset", "editButton", "duplicateButton", "deleteButton"]) $(id).disabled = disabled;
  $("exportPageButton").disabled = !page || state.busy;
  for (const [id, field] of [["pageName", "name"], ["pageWidth", "width"], ["pageHeight", "height"], ["pageX", "x"], ["pageY", "y"], ["pageRoute", "route"], ["pageChangeSummary", "changeSummary"]]) {
    const input = $(id), draft = fieldDrafts[`${page?.id}:${field}`];
    if (document.activeElement !== input) input.value = draft ?? page?.[field] ?? "";
    input.setAttribute("aria-invalid", String(draft !== undefined && !composing.has(id)));
  }
  const preset = page ? `${page.width},${page.height}` : "custom";
  $("pagePreset").value = ["390,844", "1440,900", "768,1024"].includes(preset) ? preset : "custom";
  const declaredStates = pageStates(page);
  const count = state.expanded?.pages.length || (declaredStates.length ? declaredStates.length + Number(!declaredStates.some(item => item.route === (page.route || ""))) : 0);
  $("expandButton").hidden = !count || !!state.expanded; $("expandButton").disabled = state.busy;
  iconButton($("expandButton"), state.expanded ? "collapse" : "expand", state.expanded ? "收起页面状态" : `展开页面状态（${count}）`);
  $("expandButton").setAttribute("aria-expanded", String(!!state.expanded));
  $("expandButton").setAttribute("aria-controls", "canvas pageList");
  $("inspectorTitle").textContent = state.expanded ? page?.name || "状态预览" : "页面设置";
  $("inspectorHint").hidden = true; $("inspectorHint").textContent = "";
  $("stateTrigger").hidden = !state.expanded || !page?.trigger;
  $("stateTrigger").textContent = page?.trigger || "";
  const pages = selectionPages(), multi = pages.length > 1;
  $('pageChangeSettings').hidden = !page || multi || !!elementEditor?.pageId;
  $('pageChangeSummary').readOnly = disabled;
  if (!$('pageChangeSettings').hidden) {
    const summary = $('pageChangeSummary');
    summary.style.height = 'auto';
    summary.style.height = `${Math.min(320, Math.max(140, summary.scrollHeight))}px`;
  }
  $('inspectorTitle').textContent = multi ? `已选择 ${pages.length} 张画板` : page ? pageOrganization(page).label : '画布';
  $('pageSettings').hidden = multi || !page; $('organizationSettings').hidden = !page || !!state.expanded;
  $('multiSettings').hidden = !multi;
  const box = bounds(pages); $('selectionSummary').textContent = box ? `${Math.round(box.width)} × ${Math.round(box.height)}` : '';
  for (const [id,key] of [['pagePlatform','platform'],['pageGroup','group']]) {
    const values = new Set(pages.map(p => pageOrganization(p)[key]));
    const input=$(id); if(document.activeElement!==input)input.value=values.size===1?[...values][0]:'';
    input.placeholder=values.size>1?'多个值':'';input.disabled=disabled;
  }
  $('groupOptions').replaceChildren(...[...new Set(pageGroups(canvasPages()).map(g=>g.group))].map(name=>new Option(name,name)));
  for(const button of $('multiSettings').querySelectorAll('button'))button.disabled=disabled || button.dataset.organize?.startsWith('distribute') && pages.length<3;
  $('annotationsButton').disabled ||= multi; $('reviewLinkButton').disabled ||= multi;
  $('expandButton').hidden ||= multi || !!elementEditor?.pageId; $('previewButton').setAttribute('aria-label',multi?'预览选中画板':'页面预览');
  if (elementEditor?.pageId) { $('pageSettings').hidden = true; $('organizationSettings').hidden = true; $('multiSettings').hidden = true; $('inspectorTitle').textContent = '元素'; }

}
const selectionPages = () => canvasPages().filter(p => state.selection.includes(p.id));
const boardNodes = new Map(), boardContent = new WeakMap(), sectionNodes = new Map();
let renderFrame = 0, viewTimer, previewContext = null, previewIds = [], previewId = '', previewMode = 'fit', previewCompare = false, dragging = false;
let collapsed = new Set(), searchCollapsed = new Set(), dragTree = null;
let canvasGesture = null, viewRenderFrame = 0, navigationTimer;
const viewKey = () => `requirementsPortal.designView.v1:${state.path}`;
function captureView() {
  return { view: { ...state.view }, selection: [...state.selection], selected: state.selected, collapsed: [...collapsed], searchCollapsed: [...searchCollapsed], search: $('pageSearch').value,
    listScroll: $('pageList').scrollTop, inspectorScroll: document.querySelector('.right-panel').scrollTop, focus: document.activeElement?.id || '', mode: state.mode };
}
function rememberView() {
  if (!state.entry || state.expanded) return;
  clearTimeout(viewTimer); viewTimer = setTimeout(() => { try { sessionStorage.setItem(viewKey(), JSON.stringify(captureView())); } catch {} }, 150);
}
function restoreView(value) {
  if (!value || ![value.view?.x, value.view?.y, value.view?.scale].every(Number.isFinite) || value.view.scale <= 0) return false;
  const ids = new Set(canvasPages().map(p => p.id));
  state.view = { ...value.view }; state.selection = (value.selection || []).filter(id => ids.has(id));
  state.selected = ids.has(value.selected) ? value.selected : state.selection[0] || '';
  collapsed = new Set(value.collapsed || []); searchCollapsed = new Set(value.searchCollapsed || []); $('pageSearch').value = value.search || ''; setMode(value.mode || 'select');
  renderList(); syncSelection(); renderView();
  $('pageList').scrollTop = value.listScroll || 0; document.querySelector('.right-panel').scrollTop = value.inspectorScroll || 0;
  if (value.focus) $(value.focus)?.focus({ preventScroll: true });
  return true;
}
function ensureVisible(page) {
  if (!page) return;
  const { scale } = state.view, w = $('viewport').clientWidth, h = $('viewport').clientHeight;
  const x = page.x * scale + state.view.x, y = page.y * scale + state.view.y;
  const pw = page.width * scale, ph = page.height * scale, margin = 40;
  // A page already intersecting the view is left in place; large boards are not re-centered on every selection.
  if (x + pw < margin || x > w - margin) state.view.x += (w - pw) / 2 - x;
  if (y + ph < margin || y > h - 80) state.view.y += (h - ph - 80) / 2 - y;
  renderView();
}
function focusSelection() { if (selectionPages().length) focusPages(selectionPages()); }
function focusPages(pages) { state.view = fitPages(pages, $('viewport').clientWidth, $('viewport').clientHeight); renderView(); }
function syncSelection() {
  const ids = new Set(state.selection);
  for (const [id,node] of boardNodes) node.classList.toggle('selected', ids.has(id));
  for (const node of $('pageList').querySelectorAll('[data-page]')) {
    node.classList.toggle('selected', ids.has(node.dataset.page)); node.setAttribute('aria-pressed', String(ids.has(node.dataset.page)));
  }
  for (const node of $('pageList').querySelectorAll('[data-group-select]')) {
    const group = pageGroups(canvasPages()).find(g => g.key === node.dataset.groupSelect);
    const all = !!group && group.pages.every(p => ids.has(p.id));
    node.classList.toggle('selected', all); node.setAttribute('aria-pressed',String(all));
    node.closest('.group-row')?.classList.toggle('selected',all);
    node.classList.toggle('part-selected', !!group && group.pages.some(p => ids.has(p.id)));
  }
  updateInspector(); renderStatus(); syncLocation(); rememberView(); scheduleFrames();
}
async function setSelection(ids, primary = ids.at(-1) || '') {
  const leavingElements = !!elementEditor?.pageId && (ids.length !== 1 || primary !== elementEditor.pageId);
  if (leavingElements && !await finishElementEdit()) return false;
  if (pageRename && !finishPageRename()) return false;
  ids = [...new Set(ids)];
  if (state.selected === primary && ids.length === state.selection.length && ids.every((id,index)=>id === state.selection[index])) return true;
  state.selection = ids; state.selected = primary; syncSelection(); if(leavingElements) ensureVisible(selected());
  return true;
}
function select(id, { toggle = false } = {}) {
  if (!canvasPages().some(p => p.id === id)) return;
  const ids = toggle ? state.selection.includes(id) ? state.selection.filter(value => value !== id) : [...state.selection, id] : [id];
  return setSelection(ids, ids.includes(id) ? id : ids.at(-1) || '');
}
function selectGroup(group) { return setSelection(group.pages.map(p => p.id)); }
function pageListButton(page) {
  const button = document.createElement('button'), span = document.createElement('span');
  span.textContent = pageOrganization(page).label;
  if(page.status==='planned'){button.title='待设计';button.dataset.status='planned';}
  button.innerHTML = icon('frame');
  button.append(span); button.dataset.page = page.id;
  button.classList.toggle('selected', state.selection.includes(page.id)); button.setAttribute('aria-pressed', String(state.selection.includes(page.id)));
  button.title = page.status==='planned'?`${page.name} · 待设计`:`${page.name} · ${page.width} × ${page.height}`; button.setAttribute('aria-label', page.name);
  button.addEventListener('click', async event => { if (await select(page.id, { toggle: event.shiftKey || event.metaKey || event.ctrlKey })) ensureVisible(page); });
  button.addEventListener('dblclick', () => { if (state.editable && !state.busy && !state.expanded) beginPageRename(page.id); });
  enableTreeDrag(button, [page.id], 'page');
  button.addEventListener('dragover', e => { if (dragTree) { e.preventDefault(); button.classList.add('drop-target'); } });
  button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
  button.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); button.classList.remove('drop-target'); dropTree(page); });
  return button;
}
function enableTreeDrag(node, ids, type) {
  node.draggable = state.editable && !state.busy && !state.expanded && !elementEditor?.pageId;
  node.addEventListener('dragstart', e => {
    if (!node.draggable) return e.preventDefault();
    if (type === 'page' && state.selection.includes(ids[0])) ids = [...state.selection];
    dragTree = { ids, type }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ids.join(','));
  });
  node.addEventListener('dragend', () => { dragTree = null; document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target')); });
}
function dropTree(target, groupTarget = false) {
  if (!dragTree || !state.editable || state.busy || state.expanded) return;
  const {ids,type} = dragTree; dragTree = null;
  state.workspace.pages = reorderPages(state.workspace.pages, ids, target.id, type === 'group' ? null : pageOrganization(target));
  if (groupTarget) collapsed.delete(pageOrganization(target).key);
  dirty(); renderCanvas();
}
function renderList() {
  updateStateDisclosure();
  const list = $('pageList'), scroll = list.scrollTop;
  const active = list.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = ['page','groupSelect','disclosure','platform'].find(key => active?.dataset[key]);
  const focusValue = focusKey ? active.dataset[focusKey] : '';
  $('pageListTitle').textContent = state.expanded ? '页面状态' : `页面 · ${canvasPages().length}`;
  $('addButton').hidden = !!state.expanded; $('importButton').hidden = !!state.expanded;
  list.replaceChildren();
  const filter = $('pageSearch').value.trim().toLowerCase(), groups = pageGroups(canvasPages());
  const folded = filter ? searchCollapsed : collapsed;
  const matching = groups.filter(g => g.pages.some(p => `${g.platform} ${g.group} ${p.name}`.toLowerCase().includes(filter)));
  controlHint($('treeCollapseButton'), matching.length && matching.every(g=>folded.has(g.key)) ? '展开全部分组' : '收起全部分组');
  $('treeCollapseButton').disabled = !matching.length;
  const platforms = [...new Set(groups.map(g => g.platform))];
  let count = 0;
  for (const platform of platforms) {
    const relevant = groups.filter(g => g.platform === platform).map(g => ({...g, visible: g.pages.filter(p => `${g.platform} ${g.group} ${p.name}`.toLowerCase().includes(filter))})).filter(g => g.visible.length);
    if (!relevant.length) continue;
    const platformKey = `platform:${platform}`, section = document.createElement('section'), heading = document.createElement('button');
    heading.className = 'platform-heading'; heading.dataset.platform = platformKey; heading.setAttribute('aria-expanded', String(!folded.has(platformKey)));
    const platformLabel = document.createElement('span'); platformLabel.textContent = platform; heading.append(platformLabel);
    const number = document.createElement('small'); number.textContent = relevant.reduce((sum,g) => sum + g.pages.length,0); heading.append(number);
    heading.insertAdjacentHTML('beforeend',icon('next'));
    heading.onclick = () => { folded.has(platformKey) ? folded.delete(platformKey) : folded.add(platformKey); renderList(); rememberView(); };
    section.append(heading); list.append(section); count += relevant.length;
    if (folded.has(platformKey)) continue;
    for (const group of relevant) {
      const row = document.createElement('div'); row.className = 'group-row';
      const toggle = document.createElement('button'); toggle.className = 'group-toggle'; toggle.dataset.disclosure = group.key;
      iconButton(toggle,'next',`${folded.has(group.key) ? '展开' : '收起'} ${group.group}`); toggle.setAttribute('aria-expanded', String(!folded.has(group.key)));
      toggle.onclick = () => { folded.has(group.key) ? folded.delete(group.key) : folded.add(group.key); renderList(); rememberView(); };
      const name = document.createElement('button'); name.dataset.groupSelect = group.key; name.className = 'group-name';
      const label = document.createElement('span'); label.textContent = group.group; const count = document.createElement('small'); count.textContent = group.pages.length;
      name.append(label,count); name.title = `${group.platform} / ${group.group}`;
      const allSelected = group.pages.every(p => state.selection.includes(p.id));
      name.classList.toggle('selected',allSelected); name.setAttribute('aria-pressed',String(allSelected)); row.classList.toggle('selected',allSelected);
      name.classList.toggle('part-selected',group.pages.some(p=>state.selection.includes(p.id)));
      name.onclick = async () => { if (await selectGroup(group)) ensureVisible(group.pages[0]); };
      name.ondblclick = async () => { if (await selectGroup(group)) focusSelection(); };
      enableTreeDrag(name,group.pages.map(p => p.id),'group');
      row.addEventListener('dragover', e => { if(dragTree) {e.preventDefault(); row.classList.add('drop-target');} });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', e => { e.preventDefault(); dropTree(group.pages[0], true); });
      row.append(toggle,name); section.append(row);
      if (!folded.has(group.key)) {
        const children = document.createElement('div'); children.className = 'group-pages';
        for (const page of group.visible) children.append(pageListButton(page)); section.append(children);
      }
    }
  }
  if (!count) { const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = canvasPages().length ? '没有匹配的页面' : '还没有页面'; list.append(empty); }
  list.scrollTop = scroll;
  if (focusKey) [...list.querySelectorAll('button')].find(node=>node.dataset[focusKey] === focusValue)?.focus({preventScroll:true});
}
function renderSections(affected = null, pages = canvasPages()) {
  const groups = state.expanded ? [] : pageGroups(pages);
  const keys = new Set(groups.map(g => g.key));
  for (const [key,node] of sectionNodes) if (!keys.has(key)) { node.remove(); sectionNodes.delete(key); }
  for (const group of groups) {
    if (affected && !group.pages.some(p=>affected.has(p.id))) continue;
    let node = sectionNodes.get(group.key);
    if (!node) {
      node = document.createElement('div'); node.className = 'canvas-section';
      const title = document.createElement('button'); title.className = 'section-title';
      title.addEventListener('pointerdown', event => { if (event.button !== 0 || state.mode === 'pan' || spaceMode !== null || canvasGesture) return; const current = pageGroups(canvasPages()).find(g => g.key === node.dataset.group); if (!current) return; if (!event.shiftKey) selectGroup(current); beginBoardDrag(event, current.pages[0], title, true); });
      title.ondblclick = () => focusSelection(); node.append(title); sectionNodes.set(group.key,node); $('canvas').prepend(node);
    }
    node.dataset.group = group.key;
    const box = bounds(group.pages, 28); Object.assign(node.style,{left:`${box.x}px`,top:`${box.y - 54}px`,width:`${box.width}px`,height:`${box.height + 54}px`});
    node.querySelector('button').textContent = `${group.group}  ·  ${group.pages.length}`;
    node.querySelector('button').setAttribute('aria-label', `选择分组 ${group.group}，${group.pages.length} 张画板`);
  }
  updateSectionTitles(pages,affected);
}
function updateSectionTitles(pages = canvasPages(), affected = null) {
  const scale=state.view.scale, viewport=$('viewport').getBoundingClientRect();
  const boxes=pages.map(p=>({x:viewport.left+state.view.x+p.x*scale-2,y:viewport.top+state.view.y+p.y*scale-2,width:p.width*scale+4,height:p.height*scale+4}));
  const keys=affected ? new Set(pages.filter(p=>affected.has(p.id)).map(p=>pageOrganization(p).key)) : null;
  const nodes=[...sectionNodes.entries()].filter(([key])=>!keys||keys.has(key)).map(([,node])=>node);
  for(const node of nodes)node.querySelector('button').style.maxWidth=`${Math.max(100,Math.min(280,parseFloat(node.style.width)*scale))}px`;
  // Keep labels whole: a dense view may not have room between neighboring rows.
  // Measure in one batch and hide obstructed chrome without moving page content.
  const titles=nodes.map(node=>{const title=node.querySelector('button'),rect=title.getBoundingClientRect();return{title,hidden:boxes.some(box=>intersects(rect,box))};});
  for(const {title,hidden} of titles)title.classList.toggle('is-obscured',hidden);
}
function artboardNode(page) {
  const board = document.createElement('section'); board.className = 'artboard'; board.dataset.page = page.id;
  const title = document.createElement('div'); title.className = 'artboard-title';
  title.addEventListener('pointerdown', event => beginBoardDrag(event, canvasPages().find(p => p.id === board.dataset.page), title));
  const placeholder = document.createElement('div'); placeholder.className = 'artboard-placeholder'; placeholder.setAttribute('aria-hidden','true');
  const hit = document.createElement('div'); hit.className = 'artboard-hit';
  hit.addEventListener('dblclick', () => { if (state.selected === board.dataset.page) void startElementEdit(); });
  hit.addEventListener('pointerdown', event => beginBoardDrag(event, canvasPages().find(p => p.id === board.dataset.page), hit));
  board.append(title,placeholder,hit); updateBoard(board,page); return board;
}
function updateBoard(node,page) {
  positionNode(node,page); node.dataset.size = `${page.width} × ${page.height}`;
  node.classList.toggle('selected',state.selection.includes(page.id));
  node.classList.toggle('editing-elements',elementEditor?.pageId === page.id);
  node.querySelector('.artboard-title').textContent = pageOrganization(page).label;
  node.querySelector('.artboard-placeholder').textContent = `${page.name}\n${page.width} × ${page.height}`;
  const previous = boardContent.get(node);
  if (!previous || previous.html !== page.html || previous.route !== page.route || previous.source !== page.source) {
    node.querySelector('iframe')?.remove(); boardContent.set(node, {html:page.html,route:page.route,source:page.source});
  }
}
function scheduleFrames() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = 0; updateVisibleFrames(); });
}
function updateVisibleFrames() {
  if (dragging) return;
  const {x,y,scale} = state.view, w = $('viewport').clientWidth, h = $('viewport').clientHeight;
  const visible = {x:(-x-120)/scale,y:(-y-120)/scale,width:(w+240)/scale,height:(h+240)/scale};
  const candidates = scale < .045 ? [] : canvasPages().filter(p => intersects(p,visible)).sort((a,b) => {
    const priority = p => state.selection.includes(p.id) ? -1e12 : Math.hypot(p.x+p.width/2-(-x+w/2)/scale,p.y+p.height/2-(-y+h/2)/scale);
    return priority(a)-priority(b);
  }).slice(0,16);
  const active = new Set(candidates.map(p=>p.id));
  if (elementEditor?.pageId) active.add(elementEditor.pageId);
  for (const page of canvasPages()) {
    const node = boardNodes.get(page.id); if (!node) continue;
    let frame = node.querySelector('iframe');
    if (!active.has(page.id)) { frame?.remove(); continue; }
    if (!frame) {
      frame = document.createElement('iframe'); frame.setAttribute('sandbox','allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.tabIndex = -1;
      frame.title = page.name; node.querySelector('.artboard-hit').before(frame);
      if (elementEditor?.pageId === page.id) elementEditor.mount(frame,page); else frame.srcdoc = documentHtml(page, { passive: true });
    }
  }
}
function renderCanvas() {
  finishPageRename(true,false);
  const pages = canvasPages(), ids = new Set(pages.map(p=>p.id));
  if (!state.selection.includes(state.selected)) state.selection = state.selected ? [state.selected] : [];
  state.selection = state.selection.filter(id=>ids.has(id));
  for (const [id,node] of boardNodes) if (!ids.has(id)) {node.remove();boardNodes.delete(id);}
  for (const page of pages) {
    let node = boardNodes.get(page.id);
    if (!node) { node = artboardNode(page);boardNodes.set(page.id,node);$('canvas').append(node); } else updateBoard(node,page);
  }
  renderSections(); $('emptyCanvas').hidden = !!pages.length;
  renderList(); updateInspector(); renderStatus(); renderView();
}
function renderView() {
  if (viewRenderFrame) { cancelAnimationFrame(viewRenderFrame); viewRenderFrame = 0; }
  const {x,y,scale} = state.view;
  $('canvas').style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  $('canvas').style.setProperty('--inverse-scale',1/scale);
  $('canvas').classList.toggle('overview',scale < .045);
  $('canvas').classList.toggle('compact-labels',scale < .2);
  $('zoomLabel').textContent = `${Number((scale*100).toFixed(scale < .1 ? 1 : 0))}%`;
  updateSectionTitles();
  scheduleFrames(); rememberView();
}
function fit() { focusPages(canvasPages()); }
function focusPage(page) { if(page) focusPages([page]); }
function scheduleView() {
  if (!viewRenderFrame) viewRenderFrame = requestAnimationFrame(() => { viewRenderFrame = 0; renderView(); });
}
function zoom(amount, clientX, clientY, deferred = false) {
  const box = $('viewport').getBoundingClientRect();
  state.view = zoomAt(state.view,amount,(clientX ?? box.left+box.width/2)-box.left,(clientY ?? box.top+box.height/2)-box.top);
  if (deferred) scheduleView(); else renderView();
}
function navigateCanvas(event, clientX, clientY) {
  if (canvasGesture) return;
  const delta = canvasWheel(event,$('viewport').clientHeight);
  if (delta.zoom) zoom(state.view.scale * delta.factor,clientX,clientY,true);
  else { state.view.x -= delta.dx; state.view.y -= delta.dy; scheduleView(); }
  $('viewport').classList.add('navigating'); clearTimeout(navigationTimer);
  navigationTimer = setTimeout(()=>$('viewport').classList.remove('navigating'),120);
}
function drawGuides(guides) {
  $('snapGuides').replaceChildren();
  for (const guide of guides) {
    const line = document.createElement('i'), vertical = guide.axis === 'x', cross = vertical ? 'y' : 'x'; line.className=guide.axis;
    const start = Math.round(state.view[cross]+guide.from*state.view.scale)-8;
    line.style[vertical ? 'left' : 'top'] = `${Math.round(state.view[guide.axis]+guide.at*state.view.scale)}px`;
    line.style[vertical ? 'top' : 'left'] = `${start}px`;
    line.style[vertical ? 'height' : 'width'] = `${Math.round((guide.to-guide.from)*state.view.scale)+16}px`;
    $('snapGuides').append(line);
  }
}
function beginBoardDrag(event, page, node, group = false) {
  if (!page || event.button !== 0 || state.mode === 'pan' || spaceMode !== null || state.busy || canvasGesture) return;
  event.stopPropagation(); event.preventDefault(); $('viewport').focus({preventScroll:true});
  if (!group) {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {select(page.id,{toggle:true});return;}
    if (!state.selection.includes(page.id)) select(page.id);
  }
  // Finishing an element edit can be asynchronous; it must never drag the old page.
  if (elementEditor?.pageId || !state.editable && !state.expanded) return;
  renderView();
  const originals = selectionPages().map(p=>({...p})), ids = new Set(originals.map(p=>p.id));
  if (!originals.length || group && !ids.has(page.id)) return;
  const viewport = $('viewport'), scale = state.view.scale;
  const visible = {x:(-state.view.x-120)/scale,y:(-state.view.y-120)/scale,width:(viewport.clientWidth+240)/scale,height:(viewport.clientHeight+240)/scale};
  const others = canvasPages().filter(p=>!ids.has(p.id) && intersects(p,visible));
  const start={x:event.clientX,y:event.clientY};let moved=false, frame=0, pending=null, last=null, guides=[], positions=originals;
  node.setPointerCapture(event.pointerId); dragging=true; clearTimeout(saveTimer); viewport.classList.add('interacting');
  const applyMove = () => {
    frame=0; const e=pending; pending=null; if(!e)return;
    const dx=(e.clientX-start.x)/scale, dy=(e.clientY-start.y)/scale;
    if (!moved && Math.hypot(e.clientX-start.x,e.clientY-start.y)<3) return;
    moved=true; viewport.classList.add('board-dragging');
    const snapped=e.altKey || scale<.1 ? {dx,dy,guides:[]} : snapDelta(originals,others,dx,dy,6/scale,{previous:guides,maxDistance:240/scale});
    const draft=originals.map(p=>({...p}));movePages(draft,snapped.dx,snapped.dy);
    // At the coordinate limit, a guide must not claim an alignment clamping prevented.
    guides = draft[0]?.x-originals[0].x===snapped.dx && draft[0]?.y-originals[0].y===snapped.dy ? snapped.guides : [];
    // Preview coordinates stay outside the saved workspace until pointer release.
    // An autosave already in flight cannot capture an unfinished gesture.
    positions=draft;
    for(const p of draft)positionNode(boardNodes.get(p.id),p);
    const preview=new Map(draft.map(p=>[p.id,p]));
    renderSections(ids,canvasPages().map(p=>preview.get(p.id)||p));drawGuides(guides);
  };
  const move = e => {
    if(e.pointerId!==event.pointerId)return;
    pending=last={clientX:e.clientX,clientY:e.clientY,altKey:e.altKey};
    if(!frame) frame=requestAnimationFrame(applyMove);
  };
  const finish = cancelled => {
    if(canvasGesture?.finish !== finish)return;
    if(frame){cancelAnimationFrame(frame);frame=0;}
    if(!cancelled)applyMove();
    node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);node.removeEventListener('lostpointercapture',lost);
    canvasGesture=null;
    if(node.hasPointerCapture(event.pointerId))node.releasePointerCapture(event.pointerId);
    for(const p of cancelled ? originals : positions){const current=canvasPages().find(item=>item.id===p.id);current.x=p.x;current.y=p.y;positionNode(boardNodes.get(p.id),current);}
    dragging=false;viewport.classList.remove('interacting','board-dragging');drawGuides([]);renderSections(ids);
    const changed=originals.some(p=>{const current=canvasPages().find(item=>item.id===p.id);return p.x!==current.x||p.y!==current.y;});
    if(changed&&!state.expanded&&!cancelled)dirty();else scheduleSave();updateInspector();scheduleFrames();
  };
  const end = e => {if(e.pointerId===event.pointerId)finish(e.type==='pointercancel');};
  const lost = () => finish(true);
  canvasGesture={finish,modifiers:altKey=>{if(last){pending={...last,altKey};if(!frame)frame=requestAnimationFrame(applyMove);}}};
  node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);node.addEventListener('lostpointercapture',lost);
}

function documentHtml(page, { passive = false } = {}) {
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  if(page.status==='planned'){doc.head.innerHTML='<meta charset="utf-8"><style>body{margin:0;background:#fff;color:#888;font:14px/1.8 system-ui;display:grid;place-content:center;min-height:100vh;text-align:center}h2{font-size:20px;color:#333}</style>';doc.body.replaceChildren();const title=doc.createElement('h2');title.textContent=page.name;const status=doc.createElement('p');status.textContent='待设计';doc.body.append(title,status);}
  doc.querySelectorAll("base,meta[http-equiv='refresh' i]").forEach((node) => node.remove());
  // The hit layer blocks clicks, but cannot stop a prototype's async focus().
  // Keep focus inside the editor while thumbnails render during a drag. Full
  // previews and element editing remain interactive and use the original HTML.
  if (passive) doc.querySelectorAll("body,dialog").forEach(node => { node.inert = true; });
  const base = doc.createElement("base");
  base.href = page.source ? `${location.origin}/preview/${encodeURI(page.source.slice(0, page.source.lastIndexOf("/") + 1))}` : `${location.origin}/`;
  const policy = doc.createElement("meta"); policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none';";
  doc.head.prepend(base); doc.head.prepend(policy);
  if (passive) {
    // Native modal dialogs escape body inertness, including dialogs created by
    // a prototype after load. Isolate them before showModal can move focus.
    const isolation = doc.createElement("script");
    isolation.textContent = `(() => {
      const showModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function (...args) {
        this.inert = true;
        return Reflect.apply(showModal, this, args);
      };
    })();`;
    base.after(isolation);
  }
  if (page.route) {
    const script = doc.createElement("script"); script.textContent = `location.hash=${JSON.stringify(page.route).replace(/</g, "\\u003c")};`;
    base.after(script);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
function setElementMode(active) {
  document.body.classList.toggle('element-mode',active);
  $('elementInspector').hidden = !active; $('elementEditBar').hidden = !active;
}
async function startElementEdit() {
  if (elementEditor.pageId || !state.editable || state.busy || state.expanded || state.selection.length !== 1 || !selected()) return;
  if (!await flushDesign()) return;
  const page = selected(); elementReturnView = captureView(); elementEditor.open(page); setElementMode(true); setMode('select');
  boardNodes.get(page.id)?.querySelector('iframe')?.remove();
  renderCanvas(); focusPage(page);
}
async function finishElementEdit() {
  if (!elementEditor.pageId) return true;
  if (!await flushDesign()) return false;
  const id = elementEditor.pageId, navigation = captureView();
  const view = elementReturnView && {...elementReturnView, search:navigation.search, collapsed:navigation.collapsed, searchCollapsed:navigation.searchCollapsed, listScroll:navigation.listScroll};
  elementEditor.close(); elementReturnView = null; setElementMode(false);
  boardNodes.get(id)?.querySelector('iframe')?.remove(); renderCanvas(); if (view) restoreView(view); return true;
}
elementEditor = createElementEditor({
  getPage: () => state.workspace.pages.find(p => p.id === elementEditor?.pageId), documentHtml, toast,
  onPatch: (id, html) => {
    const page = state.workspace.pages.find(p => p.id === id); if (!page || !state.editable || state.busy) return;
    page.html = html;
    // Keep this rendering alive while the source changes; the bridge patches only
    // the selected node. Undo/redo and source edits still remount from source.
    const node = boardNodes.get(id); if (node) boardContent.set(node,{html,route:page.route,source:page.source});
    dirty();
  },
  onNavigate: (event, rect) => {
    navigateCanvas({deltaX:event.dx,deltaY:event.dy,ctrlKey:event.zoom},rect.left+event.x*state.view.scale,rect.top+event.y*state.view.scale);
  },
  onDraft: (id, html) => { if (html === null) delete htmlDrafts[id]; else htmlDrafts[id] = html; persistDraft(); renderStatus(); },
  onExit: finishElementEdit, onHistory: travelHistory, onSave: save,
});
$('elementEditButton').addEventListener('click', () => void startElementEdit());
pageAnnotations = createPageAnnotations({
  documentHtml,
  onStatusChange: () => renderStatus(),
  getContext: () => {
    const page = $("previewDialog").open ? canvasPages().find(p=>p.id===previewId) : selected(); if (!page) return null;
    const pageId = state.expanded?.selectedId || page.id;
    const basePage = state.workspace.pages.find(item => item.id === pageId) || page;
    return { entryPath: state.path, pageId, page: { ...page }, pageName: basePage.name, states: [{ name: "默认状态", route: basePage.route || "", width: basePage.width, height: basePage.height }, ...pageStates(basePage)].filter((item, index, all) => all.findLastIndex(other => other.route === item.route) === index), canEdit: state.editable, flushDesign,
      saved: !state.dirty && savedPages.some((item) => item.id === pageId) };
  },
});
function positionNode(node, page) {
  Object.assign(node.style, { left: `${page.x}px`, top: `${page.y}px`, width: `${page.width}px`, height: `${page.height}px` });
}
function setMode(mode) {
  state.mode = mode; $("viewport").classList.toggle("panning", mode === "pan");
  for (const [id, value] of [["selectTool", "select"], ["panTool", "pan"]]) { $(id).classList.toggle("active", mode === value); $(id).setAttribute("aria-pressed", String(mode === value)); }
}
$('viewport').addEventListener('pointerdown', event => {
  if (canvasGesture || ![0,1].includes(event.button) || event.target.closest('.canvas-tools,.zoom-controls,.canvas-navigation,.element-edit-bar,.panel-resize,input,select') || event.target.closest('button:not(.section-title)')) return;
  const pan=state.mode==='pan'||event.button===1;
  if (!pan && event.target.closest('.artboard,.section-title')) return;
  event.preventDefault();const node=$('viewport'), rect=node.getBoundingClientRect();node.focus({preventScroll:true});renderView();
  const start={x:event.clientX,y:event.clientY,view:{...state.view}}, initial=[...state.selection], primary=state.selected;
  let moved=false, frame=0, pending=null;node.setPointerCapture(event.pointerId);node.classList.toggle('dragging',pan);node.classList.add('interacting');
  const applyMove=()=>{
    frame=0;const e=pending;pending=null;if(!e)return;
    moved ||= Math.hypot(e.clientX-start.x,e.clientY-start.y)>3;
    if(!moved)return;
    if(pan){state.view.x=start.view.x+e.clientX-start.x;state.view.y=start.view.y+e.clientY-start.y;renderView();return;}
    const box={x:Math.min(start.x,e.clientX)-rect.left,y:Math.min(start.y,e.clientY)-rect.top,width:Math.abs(e.clientX-start.x),height:Math.abs(e.clientY-start.y)};
    const marquee=$('marquee');marquee.hidden=false;Object.assign(marquee.style,{left:`${box.x}px`,top:`${box.y}px`,width:`${box.width}px`,height:`${box.height}px`});
    const world={x:(box.x-state.view.x)/state.view.scale,y:(box.y-state.view.y)/state.view.scale,width:box.width/state.view.scale,height:box.height/state.view.scale};
    const ids=canvasPages().filter(p=>intersects(p,world)).map(p=>p.id);
    setSelection(event.shiftKey?[...new Set([...initial,...ids])]:ids);
  };
  const move=e=>{if(e.pointerId!==event.pointerId)return;pending={clientX:e.clientX,clientY:e.clientY};if(!frame)frame=requestAnimationFrame(applyMove);};
  const finish=cancelled=>{
    if(canvasGesture?.finish!==finish)return;
    if(frame){cancelAnimationFrame(frame);frame=0;}if(!cancelled)applyMove();
    node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);node.removeEventListener('lostpointercapture',lost);
    canvasGesture=null;node.classList.remove('dragging','interacting');$('marquee').hidden=true;
    if(node.hasPointerCapture(event.pointerId))node.releasePointerCapture(event.pointerId);
    if(cancelled){if(pan){state.view=start.view;renderView();}else setSelection(initial,primary);}
    else if(!pan&&!moved&&!event.shiftKey)setSelection([]);
    rememberView();
  };
  const end=e=>{if(e.pointerId===event.pointerId)finish(e.type==='pointercancel');};
  const lost=()=>finish(true);canvasGesture={finish};
  node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);node.addEventListener('lostpointercapture',lost);
});
$('viewport').addEventListener('wheel', event=>{
  if(event.target.closest('.canvas-tools,.zoom-controls,.canvas-navigation,.element-edit-bar,input,select'))return;
  event.preventDefault();navigateCanvas(event,event.clientX,event.clientY);
},{passive:false});
window.addEventListener('blur',()=>canvasGesture?.finish(true));
document.addEventListener('visibilitychange',()=>{if(document.hidden)canvasGesture?.finish(true);});
window.addEventListener('keyup',event=>{if(event.key==='Alt')canvasGesture?.modifiers?.(event.altKey);});

function organizeSelection(action) {
  if ((!state.editable && !state.expanded)||state.busy) return;
  const pages=selectionPages(), snapshot=pages.map(p=>({...p}));
  try { organizePages(pages,action); }
  catch(error){for(const p of snapshot)Object.assign(pages.find(item=>item.id===p.id),p);toast(error.message,true);return;}
  if(!state.expanded)dirty();renderCanvas();
}
function focusGroup() {
  const page=selected();if(!page)return;
  const group=pageGroups(canvasPages()).find(g=>g.key===pageOrganization(page).key);
  if(group){selectGroup(group);focusSelection();}
}
function setPanelsHidden(hidden) {
  document.body.classList.toggle('panels-hidden',hidden);
  $('panelToggle').setAttribute('aria-pressed',String(hidden));
  iconButton($('panelToggle'),hidden?'sidebarOpen':'sidebar',hidden?'显示面板':'隐藏面板','Tab');
  $('viewport').focus({preventScroll:true});scheduleFrames();
}
$('panelToggle').addEventListener('click',()=>setPanelsHidden(!document.body.classList.contains('panels-hidden')));
$('fitSelectionButton').addEventListener('click',focusSelection);
$('fitGroupButton').addEventListener('click',focusGroup);
$('viewPreset').addEventListener('change',event=>{
  const action=event.target.value;event.target.value='';
  if(action==='all')fit();else if(action==='selection')focusSelection();else if(action==='group')focusGroup();else if(action)zoom(Number(action));
});
$('treeCollapseButton').addEventListener('click',()=>{
  const filter=$('pageSearch').value.trim().toLowerCase(), folded=filter?searchCollapsed:collapsed;
  const groups=pageGroups(canvasPages()).filter(g=>g.pages.some(p=>`${g.platform} ${g.group} ${p.name}`.toLowerCase().includes(filter))), all=groups.every(g=>folded.has(g.key));
  for(const group of groups) { all?folded.delete(group.key):folded.add(group.key); if(all)folded.delete(`platform:${group.platform}`); }
  renderList();rememberView();
});
$('pageList').addEventListener('scroll',rememberView,{passive:true});
for(const button of document.querySelectorAll('[data-organize]'))button.addEventListener('click',()=>organizeSelection(button.dataset.organize));
function commitOrganization(id) {
  if(!state.editable||state.busy||state.expanded||composing.has(id))return;
  const input=$(id), field=id==='pagePlatform'?'platform':'group', value=input.value.trim();
  const pages=selectionPages();if(!value){input.value=pages[0]?pageOrganization(pages[0])[field]:'';return;}
  if(pages.every(page=>pageOrganization(page)[field]===value))return;
  for(const page of pages){const meta=pageOrganization(page);page.platform=meta.platform;page.group=meta.group;page[field]=value;}
  if(pages[0])collapsed.delete(pageOrganization(pages[0]).key);
  dirty();renderCanvas();
}
for(const id of ['pagePlatform','pageGroup']) {
  $(id).addEventListener('change',()=>commitOrganization(id));
  $(id).addEventListener('blur',()=>commitOrganization(id));
  $(id).addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();commitOrganization(id);}});
  $(id).addEventListener('compositionstart',()=>composing.add(id));
  $(id).addEventListener('compositionend',()=>composing.delete(id));
}
const layoutKey='requirementsPortal.designLayout.v1';
function applyPanelWidth(side,width){
  const max=Math.max(180,Math.min(420,innerWidth*.36));width=clamp(width,180,max);
  document.body.style.setProperty(side==='left'?'--left-panel-width':'--right-panel-width',`${width}px`);
  const handle=$(side==='left'?'leftResize':'rightResize');handle.setAttribute('aria-valuenow',String(Math.round(width)));scheduleFrames();
}
function savePanelWidths(){try{localStorage.setItem(layoutKey,JSON.stringify({left:parseFloat(getComputedStyle(document.body).getPropertyValue('--left-panel-width')),right:parseFloat(getComputedStyle(document.body).getPropertyValue('--right-panel-width'))}));}catch{}}
try{const prefs=JSON.parse(localStorage.getItem(layoutKey)||'{}');for(const side of ['left','right'])if(Number.isFinite(prefs[side]))applyPanelWidth(side,prefs[side]);}catch{}
for(const side of ['left','right']){
  const handle=$(side==='left'?'leftResize':'rightResize');
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;event.preventDefault();handle.setPointerCapture(event.pointerId);
    const start=event.clientX,width=parseFloat(getComputedStyle(document.body).getPropertyValue(side==='left'?'--left-panel-width':'--right-panel-width'));
    const move=e=>applyPanelWidth(side,width+(e.clientX-start)*(side==='left'?1:-1));
    const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);savePanelWidths();};
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  });
  handle.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();event.stopPropagation();
    const width=parseFloat(getComputedStyle(document.body).getPropertyValue(side==='left'?'--left-panel-width':'--right-panel-width'));
    applyPanelWidth(side,width+(event.key==='ArrowRight'?10:-10)*(side==='left'?1:-1));savePanelWidths();
  });
}

async function loadWorkspace(entryPath, requestedPage = "") {
  elementEditor?.close(); elementReturnView = null; setElementMode(false);
  if(state.entry && !state.expanded)try{sessionStorage.setItem(viewKey(),JSON.stringify(captureView()));}catch{}
  clearTimeout(viewTimer);
  clearTimeout(saveTimer); clearTimeout(editorTimer);
  const request = ++state.request; state.path = entryPath; state.entry = null; state.editable = false; state.accessMode = "local"; state.dirty = false;
  state.busy = true; state.saving = false; state.saveError = ""; state.conflict = false;
  fieldDrafts = {}; htmlDrafts = {}; editorTargetId = ""; draftBaseRevision = null; draftBaseHash = null; composing.clear(); storageWarning = "";
  state.expanded = null; state.selection = []; collapsed = new Set(); searchCollapsed = new Set(); spaceMode = null; setMode("select"); $("pageSearch").value = "";
  state.workspace = { revision: 0, pages: [] }; state.selected = ""; resetHistory(); renderCanvas();
  $("featureTitle").textContent = "正在加载…";
  try {
    const result = await api(); if (request !== state.request) return;
    state.entry = result.entry; state.workspace = result.workspace; state.editable = result.canEdit; state.accessMode = result.accessMode || "local";
    state.selected = state.workspace.pages.find((page) => page.id === requestedPage)?.id || state.workspace.pages[0]?.id || "";
    resetHistory();
    const draft = state.editable ? readDraft() : null;
    if (draft) {
      const revisionMatches = draft.baseRevision === state.workspace.revision && typeof draft.baseHash === "string" && draft.baseHash === savedHash;
      state.workspace.pages = copyPages(draft.pages);
      if(typeof draft.overview==='string')state.workspace.overview=draft.overview;
      fieldDrafts = draft.fieldDrafts && typeof draft.fieldDrafts === "object" && !Array.isArray(draft.fieldDrafts) ? draft.fieldDrafts : {};
      htmlDrafts = draft.htmlDrafts && typeof draft.htmlDrafts === "object" && !Array.isArray(draft.htmlDrafts) ? draft.htmlDrafts : {};
      const ids = new Set(state.workspace.pages.map((page) => page.id));
      fieldDrafts = Object.fromEntries(Object.entries(fieldDrafts).filter(([key, value]) => typeof value === "string" && ids.has(key.slice(0, key.lastIndexOf(":")))));
      htmlDrafts = Object.fromEntries(Object.entries(htmlDrafts).filter(([key, value]) => ids.has(key) && typeof value === "string"));
      state.selected = state.workspace.pages.find((page) => page.id === (requestedPage || draft.selected))?.id || state.workspace.pages[0]?.id || "";
      editHistory.record(state.workspace); state.dirty = !samePages(state.workspace.pages, savedPages) || (state.workspace.overview||'')!==savedOverview;
      if (!revisionMatches) {
        state.conflict = true; draftBaseRevision = draft.baseRevision; draftBaseHash = typeof draft.baseHash === "string" ? draft.baseHash : "unknown";
        state.saveError = "已保存版本已变化，本机草稿已恢复，自动保存已暂停";
      } else toast("已恢复本机未保存的草稿");
    }
    $("featureTitle").textContent = state.entry.feature; $("featureTitle").title = state.entry.path;
    const previous = new URLSearchParams(returnParams);
    if (previous.get("path") !== state.path) returnParams = "";
    $("requirementLink").href = portalUrl(); $("portalLink").href = returnParams ? `/#${new URLSearchParams(returnParams)}` : portalUrl("preview");
    $("specLink").href = portalUrl("doc", "spec"); $("contractLink").href = portalUrl("doc", "contract");
    $("flowLink").href = flowReturn || `/#${new URLSearchParams({ path: state.path, view: "flow" })}`;
    $("flowLink").textContent = flowReturn ? "返回流程" : "流程";
    updateFlowReturn(flowReturn);

    state.busy = false; state.selection = state.selected ? [state.selected] : [];
    collapsed = new Set(pageGroups(canvasPages()).filter(g => !g.pages.some(p => p.id === state.selected)).map(g => g.key));
    let view = null; try { view = JSON.parse(sessionStorage.getItem(viewKey()) || 'null'); } catch {}
    renderCanvas();
    if (!(view && (!requestedPage || requestedPage === view.selected) && restoreView(view))) requestedPage && selected() ? focusPage(selected()) : fit();
    syncLocation();
    for (const id of Object.keys(htmlDrafts)) applyHtmlDraft(id);
    persistDraft(); scheduleSave();
  } catch (error) {
    if (request !== state.request) return;
    state.busy = false; $("featureTitle").textContent = "设计加载失败"; $("saveState").textContent = "加载失败";
    $("saveState").className = "error"; toast(error.message, true);
  }
}
async function save() {
  if (!state.editable || state.busy) return false;
  if (state.conflict) { $("conflictMessage").textContent = state.saveError; $("conflictDialog").showModal(); return false; }
  state.saveError = ""; storageWarning = ""; renderStatus();
  if (!await flushDesign()) return false;
  if (pageAnnotations.flush && !await pageAnnotations.flush(true)) return false;
  return flushDesign();
}
function canCreatePage() {
  if (!state.entry || !state.editable || state.busy || state.expanded) return false;
  if (state.workspace.pages.length >= 120) { toast("最多保存 120 个页面", true); return false; }
  return finishPageRename();
}
function insertPage({ name, html, source = "", width, height }) {
  if (!canCreatePage()) return;
  const pages = state.workspace.pages, anchor = selected() || pages.at(-1);
  width ??= anchor?.width || 390; height ??= anchor?.height || 844;
  name = uniquePageName(pages, name);
  const page = { id: createPageId(), name, width, height, ...nextPagePosition(pages, width, height, anchor), html: html ?? blankHtml(name), status:html?'designed':'planned', source, route: "" };
  pages.push(page); state.selected = page.id; $("pageSearch").value = ""; setMode("select");
  dirty(); renderCanvas(); focusPage(page);
  $("pageList").querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  $("viewport").focus({ preventScroll: true });
}
function openNew() { insertPage({ name: "新页面" }); }
function openPrototypePicker() {
  if (!canCreatePage() || importing) return;
  const picker = $("prototypePicker");
  if (picker.matches(":popover-open")) { picker.hidePopover(); return; }
  picker.replaceChildren();
  const sources = state.entry.prototypes.filter((item) => item.type === "html");
  if (!sources.length) {
    const empty = document.createElement("p"); empty.textContent = "当前需求还没有 HTML 原型"; picker.append(empty);
  }
  for (const item of sources) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = item.name;
    button.addEventListener("click", () => importPrototype(item)); picker.append(button);
  }
  const bounds = $("importButton").getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - Math.min(320, innerWidth - 16) - 8))}px`;
  picker.style.top = `${Math.min(bounds.bottom + 6, innerHeight - 100)}px`;
  picker.style.maxHeight = `${Math.max(80, innerHeight - bounds.bottom - 20)}px`;
  picker.showPopover(); picker.querySelector("button")?.focus();
}
async function importPrototype(item) {
  if (!canCreatePage() || importing) return;
  const entryPath = state.path, request = state.request, anchor = selected();
  $("prototypePicker").hidePopover(); importing = true; renderStatus();
  try {
    const result = await api(`/source?file=${encodeURIComponent(item.path)}`, {}, entryPath);
    if (state.path !== entryPath || state.request !== request) return;
    insertPage({ name: item.name.replace(/\.html?$/i, ""), html: result.html, source: item.path, width: anchor?.width || 390, height: anchor?.height || 844 });
  } catch (error) { if (state.path === entryPath && state.request === request) toast(error.message, true); }
  finally { importing = false; renderStatus(); }
}
$("prototypePicker").addEventListener("toggle", () => $("importButton").setAttribute("aria-expanded", String($("prototypePicker").matches(":popover-open"))));
$("prototypePicker").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); $("prototypePicker").hidePopover(); $("importButton").focus(); }
});
function beginPageRename(id = state.selected) {
  if (!state.editable || state.busy || state.expanded) return;
  if (pageRename?.id === id) { pageRename.input.focus(); return; }
  if (!finishPageRename()) return;
  const page = state.workspace.pages.find((item) => item.id === id); if (!page) return;
  select(id);
  const meta=pageOrganization(page); for(const folded of [collapsed,searchCollapsed]) { folded.delete(meta.key);folded.delete(`platform:${meta.platform}`); } renderList();
  const button = Array.from($("pageList").querySelectorAll("[data-page]")).find((item) => item.dataset.page === id); if (!button) return;
  const row = document.createElement("div"), input = document.createElement("input");
  row.className = "page-name-editor selected"; row.dataset.page = id; row.setAttribute("aria-current", "true");
  input.id = "pageRenameInput"; input.maxLength = 100; input.setAttribute("aria-label", "重命名页面"); input.value = fieldDrafts[`${id}:name`] ?? page.name;
  row.append(button.querySelector("svg"), input); button.replaceWith(row); pageRename = { id, input };
  input.addEventListener("input", () => { fieldDrafts[`${id}:name`] = input.value; persistDraft(); renderStatus(); });
  input.addEventListener("compositionstart", () => composing.add("pageRenameInput"));
  input.addEventListener("compositionend", () => {
    composing.delete("pageRenameInput"); fieldDrafts[`${id}:name`] = input.value; persistDraft(); renderStatus();
    if (document.activeElement !== input) finishPageRename();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || composing.has("pageRenameInput")) return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); finishPageRename(event.key === "Enter");
      const row = Array.from($("pageList").querySelectorAll("[data-page]")).find((item) => item.dataset.page === id); row?.focus();
    }
  });
  input.addEventListener("blur", () => finishPageRename()); input.focus(); input.select();
}
function finishPageRename(commit = true, render = true) {
  if (!pageRename) return true;
  if (composing.has("pageRenameInput")) return false;
  const { id, input } = pageRename; pageRename = null;
  const page = state.workspace.pages.find((item) => item.id === id), name = input.value.trim();
  delete fieldDrafts[`${id}:name`];
  if (commit && page && name && name.length <= 100 && page.name !== name) {
    page.name = name; dirty();
    const board = Array.from($("canvas").children).find((item) => item.dataset.page === id);
    if (board) { board.querySelector(".artboard-title").textContent = name; board.querySelector("iframe")?.setAttribute("title", name); }
  }
  persistDraft(); if (render) {
    if (page && input.parentElement?.dataset.page === id) input.parentElement.replaceWith(pageListButton(page));
    renderList();renderSections();updateInspector(); renderStatus();
  }
  return true;
}
$("pageSettings").addEventListener("submit", (event) => event.preventDefault());
for (const [id, field, min, max] of [["pageName", "name"], ["pageRoute", "route"], ["pageChangeSummary", "changeSummary"], ["pageWidth", "width", 240, 2560], ["pageHeight", "height", 200, 6000], ["pageX", "x", -100000, 100000], ["pageY", "y", -100000, 100000]]) {
  const input = $(id);
  const apply = () => {
    const page = selected(); if (!page || !state.editable || state.busy || state.expanded) return;
    const key = `${page.id}:${field}`, raw = input.value;
    fieldDrafts[key] = raw;
    if (composing.has(id)) { persistDraft(); renderStatus(); return; }
    const value = ["name", "route", "changeSummary"].includes(field) ? raw.trim() : Number(raw);
    const valid = field === "changeSummary" ? value.length <= 4000 : field === "name" ? value.length > 0 && value.length <= 100 : field === "route" ? value.length <= 500 && (!value || value.startsWith("#")) : raw.trim() !== "" && Number.isInteger(value) && value >= min && value <= max;
    input.setAttribute("aria-invalid", String(!valid));
    if (valid) {
      delete fieldDrafts[key];
      if (page[field] !== value) { page[field] = value; dirty(); }
      const node = Array.from($("canvas").children).find((item) => item.dataset.page === page.id);
      if (node) { positionNode(node, page); node.dataset.size = `${page.width} × ${page.height}`; node.querySelector(".artboard-title").textContent = page.name; }
      if (field === "name") renderList();
      if (node) updateBoard(node, page); renderSections(); scheduleFrames();
      updateInspector();
    }
    persistDraft(); renderStatus();
  };
  input.addEventListener("compositionstart", () => { composing.add(id); });
  input.addEventListener("compositionend", () => { composing.delete(id); apply(); });
  input.addEventListener("input", apply);
}
$("pagePreset").addEventListener("change", () => {
  if (!selected() || state.expanded || $("pagePreset").value === "custom") return;
  delete fieldDrafts[`${selected().id}:width`]; delete fieldDrafts[`${selected().id}:height`];
  [selected().width, selected().height] = $("pagePreset").value.split(",").map(Number); dirty(); renderCanvas(); focusPage(selected());
});
function openEditor() {
  if (!selected() || !state.editable || state.busy || state.expanded) return;
  editorTargetId = selected().id;
  $("htmlEditor").value = htmlDrafts[editorTargetId] ?? selected().html;
  $("editorPreview").srcdoc = documentHtml(selected()); $("editorDialog").showModal(); renderStatus();
}
function htmlProblem(html) {
  if (typeof html !== "string" || !html.trim()) return "HTML 为空，草稿已保留；补全后会自动保存";
  if (html.length > 600000) return "单页内容最多 600000 字符，请拆分页面";
  try { if (!new DOMParser().parseFromString(html, "text/html").body) return "HTML 无法读取，请检查内容"; }
  catch { return "HTML 无法读取，请检查内容"; }
  return "";
}
function applyHtmlDraft(id) {
  const html = htmlDrafts[id], page = state.workspace.pages.find((item) => item.id === id);
  if (html === undefined) return true;
  if (!page || htmlProblem(html) || composing.has("htmlEditor")) return false;
  delete htmlDrafts[id];
  if (page.html !== html) { page.html = html; page.status='designed'; dirty(0); renderCanvas(); }
  if (id === editorTargetId && $("editorDialog").open) $("editorPreview").srcdoc = documentHtml(page);
  persistDraft(); renderStatus(); return true;
}
function applyEditorDraft() {
  if (composing.has("htmlEditor")) return false;
  for (const id of Object.keys(htmlDrafts)) applyHtmlDraft(id);
  return !Object.keys(htmlDrafts).length;
}
function editorInput() {
  if (!editorTargetId || !state.editable) return;
  htmlDrafts[editorTargetId] = $("htmlEditor").value; persistDraft(); renderStatus(); clearTimeout(editorTimer);
  if (!composing.has("htmlEditor")) editorTimer = setTimeout(() => applyHtmlDraft(editorTargetId), 600);
}
async function closeEditor() {
  if (!await flushDesign()) return false;
  $("editorDialog").close(); return true;
}
$("refreshEditor").addEventListener("click", () => { if (applyHtmlDraft(editorTargetId)) $("editorPreview").srcdoc = documentHtml(state.workspace.pages.find((page) => page.id === editorTargetId)); });
$("applyHtml").addEventListener("click", closeEditor);
$("htmlEditor").addEventListener("input", editorInput);
$("htmlEditor").addEventListener("compositionstart", () => { composing.add("htmlEditor"); clearTimeout(editorTimer); });
$("htmlEditor").addEventListener("compositionend", () => { composing.delete("htmlEditor"); editorInput(); });
$("htmlEditor").addEventListener("keydown", (event) => {
  if (event.key === "Tab") { event.preventDefault(); const editor = event.target; editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); editorInput(); }
});
$("editorDialog").addEventListener("close", () => $("editorPreview").srcdoc = "");
function exportPage(page) {
  if (!page) return;
  const url = URL.createObjectURL(new Blob([documentHtml(page)], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${page.name.replace(/[\\/:*?"<>|]/g, "-")}.html`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("exportButton").addEventListener("click", () => exportPage({ ...selected(), html: $("htmlEditor").value }));
designExporter = createDesignExporter({
  getContext: () => ({ path: state.path, pages: canvasPages().map(page => ({ ...page, html: htmlDrafts[page.id] ?? page.html })), selectedIds: [...state.selection], loading: state.busy }),
  beforeOpen: async () => !elementEditor?.pageId || await elementEditor.flush(),
  toast,
});
$("exportPageButton").addEventListener("click", () => void designExporter.open());
function sizePreview() {
  const page=canvasPages().find(p=>p.id===previewId);if(!page)return;
  if(previewCompare){sizeComparison();return;}
  const area=$('previewScroll'), scale=previewMode==='actual'?1:Math.min(1,Math.max(1,area.clientWidth-40)/page.width,Math.max(1,area.clientHeight-40)/Math.min(page.height,1000));
  Object.assign($('previewSurface').style,{width:`${page.width*scale}px`,height:`${page.height*scale}px`});
  Object.assign($('fullPreview').style,{width:`${page.width}px`,height:`${page.height}px`,transform:`scale(${scale})`});
  $('previewFit').setAttribute('aria-pressed',String(previewMode==='fit'));$('previewActual').setAttribute('aria-pressed',String(previewMode==='actual'));
}
function renderPreview() {
  const page=canvasPages().find(p=>p.id===previewId);if(!page)return;
  const index=previewIds.indexOf(page.id);
  $('previewCompare').hidden=(previewContext?.selection.length||0)<2;
  $('previewCompare').setAttribute('aria-pressed',String(previewCompare));
  $('previewSurface').hidden=previewCompare;$('previewCompareGrid').hidden=!previewCompare;
  $('previewAnnotationsButton').disabled=previewCompare;
  $('previewCompareGrid').replaceChildren();
  if(previewCompare){
    $('previewFit').setAttribute('aria-pressed','false');$('previewActual').setAttribute('aria-pressed','false');
    $('fullPreview').srcdoc='';
    const start=Math.floor(index/4)*4, ids=previewIds.slice(start,start+4);
    $('previewTitle').textContent=`并排对比 · ${start+1}—${start+ids.length} / ${previewIds.length}`;
    for(const id of ids){const p=canvasPages().find(item=>item.id===id);if(!p)continue;
      const item=document.createElement('section');item.className='compare-item';item.dataset.page=id;
      const title=document.createElement('h3');title.textContent=p.name;
      const surface=document.createElement('div');surface.className='compare-surface';
      const frame=document.createElement('iframe');frame.title=p.name;frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.srcdoc=documentHtml(p);
      surface.append(frame);item.append(title,surface);$('previewCompareGrid').append(item);
    }
    $('previousPage').disabled=start===0;$('nextPage').disabled=start+4>=previewIds.length;sizeComparison();return;
  }
  $('previewTitle').textContent=`${page.name} · ${index+1} / ${previewIds.length}`;
  $('fullPreview').srcdoc=documentHtml(page);sizePreview();$('previewScroll').scrollTo(0,0);
  $('previousPage').disabled=index<=0;$('nextPage').disabled=index===previewIds.length-1;
}
async function openPreview() {
  if(selected()?.status==='planned'){await descriptions.open(selected().id);return;}
  if(!selected() || elementEditor?.pageId && !await elementEditor.flush())return;
  if(!$('previewDialog').open){
    previewCompare=false;previewContext=captureView();previewIds=(state.selection.length>1?selectionPages():canvasPages()).map(p=>p.id);previewId=state.selected;
    $('previewDialog').showModal();
  }
  renderPreview();
}
for(const [id,mode] of [['previewFit','fit'],['previewActual','actual']])$(id).addEventListener('click',()=>{previewCompare=false;previewMode=mode;renderPreview();});

function sizeComparison(){
  const count=$('previewCompareGrid').children.length, columns=Math.min(2,count), width=Math.max(100,($('previewScroll').clientWidth-40-(columns-1)*20)/columns);
  for(const item of $('previewCompareGrid').children){const page=canvasPages().find(p=>p.id===item.dataset.page);if(!page)continue;
    const scale=Math.min(1,width/page.width);Object.assign(item.querySelector('.compare-surface').style,{width:`${page.width*scale}px`,height:`${page.height*scale}px`});
    Object.assign(item.querySelector('iframe').style,{width:`${page.width}px`,height:`${page.height}px`,transform:`scale(${scale})`});
  }
}
$('previewCompare').addEventListener('click',()=>{previewCompare=!previewCompare;if(previewCompare)previewId=previewIds[0];renderPreview();});
function openStates() {
  if (state.expanded || state.busy) return;
  const page = selected(), declared = pageStates(page);
  if (!page) return;
  if (!declared.length) { toast("此页面尚未声明可展开的状态。需在原型中补齐业务状态和弹窗的独立预览入口。", true); return; }
  const baseState = declared.find(item => item.route === (page.route || ""));
  const items = [baseState || { id: "base", name: "基础页面", route: page.route || "", width: page.width, height: page.height }, ...declared.filter(item => item.route !== (page.route || ""))];
  $("pageSearch").value = "";
  const viewport = $("viewport");
  const averageWidth = items.reduce((sum, item) => sum + item.width, 0) / items.length;
  const averageHeight = items.reduce((sum, item) => sum + item.height, 0) / items.length;
  const columns = Math.max(1, Math.min(items.length, Math.ceil(Math.sqrt(items.length * (averageHeight + 100) * Math.max(120, viewport.clientWidth - 80) / ((averageWidth + 100) * Math.max(160, viewport.clientHeight - 160))))));
  state.expanded = { parentName: page.name, selectedId: page.id, view: { ...state.view }, mode: state.mode, selection: [...state.selection], collapsed: [...collapsed], search: $("pageSearch").value,
    listScrollTop: $("pageList").scrollTop,
    pages: arrangePages(items.map((item, index) => ({ ...page,
      id: `${page.id}::state:${index}:${item.id}`, name: `${String(index + 1).padStart(2, "0")} ${item.name}`,
      route: item.route, trigger: item.trigger, width: item.width, height: item.height })), columns) };
  state.selected = state.expanded.pages[0].id;
  setMode("pan"); renderCanvas();
  // Expansion opens with the full inventory; a list selection focuses one state.
  state.view = fitPages(canvasPages(), viewport.clientWidth, viewport.clientHeight); renderView();
  $("pageList").scrollTop = 0; viewport.focus({ preventScroll: true });
}
function closeStates() {
  if (!state.expanded) return;
  const previous = state.expanded; state.expanded = null;
  $("pageSearch").value = "";
  state.selected = previous.selectedId; state.selection = previous.selection || [previous.selectedId]; collapsed = new Set(previous.collapsed || []); $("pageSearch").value = previous.search || ""; state.view = previous.view;
  setMode(previous.mode); renderCanvas(); $("pageList").scrollTop = previous.listScrollTop;
  $("viewport").focus({ preventScroll: true });
}
$("expandButton").addEventListener("click", () => state.expanded ? closeStates() : openStates());
$("collapseStatesButton").addEventListener("click", () => {
  if (state.expanded) closeStates(); else openStates();
  $("collapseStatesButton").focus({ preventScroll: true });
});
for (const [id, direction] of [["previousPage", -1], ["nextPage", 1]]) $(id).addEventListener("click", () => {
  const next = previewIds[previewCompare ? Math.floor(previewIds.indexOf(previewId)/4)*4 + direction*4 : previewIds.indexOf(previewId) + direction];
  if (next) { previewId=next; renderPreview(); }
});
$('previewDialog').addEventListener('close', () => {
  $('fullPreview').srcdoc='';$('previewCompareGrid').replaceChildren(); if(previewContext)restoreView(previewContext);previewContext=null;
});
async function openVersions() {
  if (state.expanded || state.busy) return;
  $("versionsList").textContent = "正在读取版本…"; $("versionsDialog").showModal();
  try {
    const result = await api("/versions"); $("versionsList").replaceChildren();
    if (!result.versions.length) $("versionsList").textContent = "保存后会在这里保留版本。";
    for (const version of result.versions) {
      const row = document.createElement("div"); row.className = "version-row";
      const label = document.createElement("div"), small = document.createElement("small");
      label.textContent = `版本 ${version.revision} · ${version.pageCount} 个页面`;
      small.textContent = new Date(version.updatedAt).toLocaleString("zh-CN", { hour12: false }); label.append(small);
      const button = document.createElement(version.current ? "span" : "button");
      if (version.current) { button.className = "version-current"; button.textContent = "当前版本"; }
      else { button.textContent = "恢复"; button.setAttribute("aria-label", `恢复版本 ${version.revision}`); button.disabled = !state.editable; }
      button.addEventListener("click", async () => {
        if (!await flushAll() || !await confirmAction("恢复保存版本", `恢复到版本 ${version.revision}？当前版本仍然保留。`, "恢复版本")) return;
        button.disabled = true; state.busy = true; renderStatus();
        try {
          const result = await api("/restore", { method: "POST", body: JSON.stringify({ expectedRevision: state.workspace.revision, revision: version.revision }) });
          state.workspace = result.workspace; state.selected = state.workspace.pages[0]?.id || ""; state.dirty = false; resetHistory(); persistDraft(); syncLocation();
          $("versionsDialog").close(); renderCanvas(); fit(); toast(`已恢复，并保存为版本 ${result.workspace.revision}`);
        } catch (error) { button.disabled = false; toast(error.message, true); }
        finally { state.busy = false; renderStatus(); updateInspector(); }
      });
      row.append(label, button); $("versionsList").append(row);
    }
    await descriptions.historyList($('versionsList'));
  } catch (error) { $("versionsList").textContent = error.message; }
}
function duplicatePage() {
  if (state.expanded || !state.editable || state.busy || !selectionPages().length) return;
  const originals=selectionPages();
  if(state.workspace.pages.length+originals.length>120)return toast('最多保存 120 个页面，当前选择无法全部复制',true);
  if(!finishPageRename())return;
  const copies=[];
  for(const original of originals){const page={...original,id:createPageId(),name:uniquePageName([...state.workspace.pages,...copies],`${original.name.slice(0,94)} 副本`),...nextPagePosition([...state.workspace.pages,...copies],original.width,original.height,original)};if(original.description || original.descriptionPageId){page.descriptionPageId=original.descriptionPageId||original.id;delete page.description;}copies.push(page);}
  state.workspace.pages.push(...copies);state.selection=copies.map(p=>p.id);state.selected=copies[0].id;$('pageSearch').value='';
  dirty();renderCanvas();focusSelection();
}
async function deleteSelection() {
  if(state.expanded||!state.editable||state.busy)return;
  const pages=selectionPages();if(!pages.length)return;
  if(!await confirmAction('删除页面',`删除选中的 ${pages.length} 张画板？已有需求和流程引用将标记为目标缺失，可通过撤销或版本恢复。`,'删除页面'))return;
  const ids=new Set(pages.map(p=>p.id));
  const dependents=state.workspace.pages.filter(p=>!ids.has(p.id)&&ids.has(p.descriptionPageId));
  if(dependents.length){toast('此页面的说明仍被其他状态共用，请先合并页面或调整说明来源',true);return;}
  state.workspace.pages=state.workspace.pages.filter(p=>!ids.has(p.id));state.selection=[];state.selected='';
  for(const id of ids){delete htmlDrafts[id];for(const key of Object.keys(fieldDrafts))if(key.startsWith(`${id}:`))delete fieldDrafts[key];}
  dirty();renderCanvas();
}
$('duplicateButton').addEventListener('click',duplicatePage);$('multiDuplicate').addEventListener('click',duplicatePage);
$('deleteButton').addEventListener('click',deleteSelection);$('multiDelete').addEventListener('click',deleteSelection);
$("requirementSelect").addEventListener("change", async (event) => {
  const input = event.target, nextPath = input.value; input.disabled = true;
  try {
    if (state.busy || !await flushAll()) { input.value = state.path; return; }
    if (pageAnnotations.close && !await pageAnnotations.close()) { input.value = state.path; return; }
    await loadWorkspace(nextPath);
  } finally { input.disabled = false; }
});
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", async () => {
  if (button.dataset.close === "editorDialog") { await closeEditor(); return; }
  $(button.dataset.close).close();
});
$("editorDialog").addEventListener("cancel", (event) => {
  event.preventDefault(); void closeEditor();
});
function confirmAction(title, message, action) {
  const dialog = $("designConfirmDialog"), previous = document.activeElement;
  if (dialog.open) return Promise.resolve(false);
  $("designConfirmTitle").textContent = title; $("designConfirmMessage").textContent = message; $("designConfirmAccept").textContent = action;
  return new Promise((resolve) => {
    const finish = (ok) => { dialog.removeEventListener("cancel", cancel); $("designConfirmCancel").removeEventListener("click", decline); $("designConfirmAccept").removeEventListener("click", accept); dialog.close(); previous?.focus?.(); resolve(ok); };
    const cancel = (event) => { event.preventDefault(); finish(false); }, decline = () => finish(false), accept = () => finish(true);
    dialog.addEventListener("cancel", cancel); $("designConfirmCancel").addEventListener("click", decline); $("designConfirmAccept").addEventListener("click", accept);
    dialog.showModal(); $("designConfirmCancel").focus();
  });
}
$("downloadDraft").addEventListener("click", () => {
  const draft = { path: state.path, baseRevision: draftBaseRevision ?? state.workspace.revision, baseHash: draftBaseHash ?? savedHash, pages: state.workspace.pages, fieldDrafts, htmlDrafts };
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "设计工作台-本机草稿.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("retryConflict").addEventListener("click", async () => {
  state.busy = true; renderStatus();
  try {
    const result = await api();
    if (!samePages(result.workspace.pages, state.workspace.pages) || (result.workspace.overview||'')!==(state.workspace.overview||'')) { $("conflictMessage").textContent = "已保存内容仍有其他修改，未覆盖。可下载本机草稿，或读取已保存版本继续编辑。"; return; }
    state.workspace.revision = result.workspace.revision; state.workspace.updatedAt = result.workspace.updatedAt;
    savedPages = copyPages(result.workspace.pages); savedOverview=result.workspace.overview||''; savedHash = pagesFingerprint(savedPages,savedOverview); state.dirty = false; state.conflict = false; state.saveError = ""; draftBaseRevision = null; draftBaseHash = null;
    persistDraft(); $("conflictDialog").close();
  } catch (error) { $("conflictMessage").textContent = error.message; }
  finally { state.busy = false; renderStatus(); }
});
$("reloadDesign").addEventListener("click", async () => {
  state.busy = true; renderStatus();
  try {
    const result = await api();
    state.workspace = result.workspace; state.editable = result.canEdit; state.dirty = false; state.conflict = false; state.saveError = "";
    fieldDrafts = {}; htmlDrafts = {}; draftBaseRevision = null; draftBaseHash = null;
    if ($("editorDialog").open) $("editorDialog").close(); editorTargetId = "";
    state.selected = state.workspace.pages.find((page) => page.id === state.selected)?.id || state.workspace.pages[0]?.id || "";
    resetHistory(); clearDraft(); $("conflictDialog").close(); renderCanvas(); syncLocation();
  } catch (error) { $("conflictMessage").textContent = error.message; }
  finally { state.busy = false; renderStatus(); updateInspector(); }
});
$("saveButton").addEventListener("click", save); $("versionsButton").addEventListener("click", openVersions); $("previewButton").addEventListener("click", openPreview); $("mobilePreviewButton").addEventListener("click", openPreview);
$("annotationsButton").addEventListener("click", async () => { if (!elementEditor?.pageId || await flushDesign()) await pageAnnotations.open(); });
$("previewAnnotationsButton").addEventListener("click", pageAnnotations.open);
$("addButton").addEventListener("click", () => openNew()); $("emptyAdd").addEventListener("click", () => openNew()); $("importButton").addEventListener("click", openPrototypePicker);
$("editButton").addEventListener("click", openEditor); $("fitButton").addEventListener("click", fit);
$("arrangeButton").addEventListener("click", () => organizeSelection("tidy"));
$("selectTool").addEventListener("click", () => setMode("select")); $("panTool").addEventListener("click", () => setMode("pan"));
$("zoomOut").addEventListener("click", () => zoom(state.view.scale / 1.2)); $("zoomIn").addEventListener("click", () => zoom(state.view.scale * 1.2)); $("zoomLabel").addEventListener("click", () => zoom(1));
$("undoButton").addEventListener("click", () => travelHistory("undo"));
$("redoButton").addEventListener("click", () => travelHistory("redo"));
$("shortcutsButton").addEventListener("click", () => $("shortcutsDialog").showModal());
$("pageSearch").addEventListener("input", () => { finishPageRename(); searchCollapsed.clear(); renderList(); rememberView(); });
$("pageList").addEventListener("keydown", async (event) => {
  if (event.target.closest("input")) return;
  if (event.key === ' ' || event.key === 'Enter') { event.stopPropagation(); return; }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const items = Array.from($("pageList").querySelectorAll("[data-page], [data-group-select], [data-platform]")); if (!items.length) return;
  event.preventDefault(); event.stopPropagation();
  const active = document.activeElement;
  const row = active?.closest('.group-row'), group = row?.querySelector('[data-group-select]'), toggle = row?.querySelector('[data-disclosure]');
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const expand = event.key === 'ArrowRight', disclosure = toggle || (active?.dataset.platform ? active : null);
    if (disclosure) {
      const open = disclosure.getAttribute('aria-expanded') === 'true';
      if (open !== expand) disclosure.click();
      else if (expand) (row ? row.nextElementSibling?.querySelector('[data-page]') : active.nextElementSibling?.querySelector('[data-group-select]'))?.focus();
      else active.closest('section')?.querySelector('[data-platform]')?.focus();
    } else if (!expand) active.closest('.group-pages')?.previousElementSibling?.querySelector('[data-group-select]')?.focus();
    return;
  }
  const index = items.indexOf(group || active);
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : clamp(index + (event.key === "ArrowDown" ? 1 : -1), 0, items.length - 1);
  const next = items[nextIndex]; next.focus(); if(next.dataset.page && await select(next.dataset.page, {toggle:event.shiftKey})) ensureVisible(selected());
});
$("reviewLinkButton").addEventListener("click", async () => {
  if (!selected() || state.expanded || !await flushAll() || !state.workspace.revision) return;
  const params = new URLSearchParams({ path: state.path, view: "preview", prototype: `design:${state.selected}` });
  const url = `${location.origin}/#${params}`;
  try { await navigator.clipboard.writeText(url); toast("已复制已保存页面的评审链接"); }
  catch { $("reviewLinkInput").value = url; $("reviewLinkDialog").showModal(); $("reviewLinkInput").select(); }
});
window.addEventListener("beforeunload", (event) => { persistDraft(); const current = saveStatus(); if (current.dirty || current.saving) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", persistDraft);
document.addEventListener("visibilitychange", () => { if (document.hidden) { persistDraft(); void flushDesign(); } });
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (canvasGesture) {
    if (event.key === 'Escape') { event.preventDefault(); canvasGesture.finish(true); }
    else if (event.key === 'Alt') canvasGesture.modifiers?.(event.altKey);
    else event.preventDefault();
    return;
  }
  const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey, dialog = document.querySelector("dialog[open]");
  const typing = event.target.closest("input,textarea,select,[contenteditable='true']");
  if (modifier && key === "s") { event.preventDefault(); if (!dialog || dialog === $("editorDialog")) void save(); return; }
  if (dialog) return;
  if (modifier && key === "k") { event.preventDefault(); $("pageSearch").focus(); $("pageSearch").select(); return; }
  if (typing || event.altKey) return;
  if (elementEditor?.pageId) {
    if (modifier && (key === "z" || key === "y")) { event.preventDefault(); travelHistory(key === "y" || event.shiftKey ? "redo" : "undo"); return; }
    if (key === "escape") { event.preventDefault(); void finishElementEdit(); return; }
    if (!modifier && ["arrowup","arrowdown","arrowleft","arrowright","enter"].includes(key) || modifier && ["a","d"].includes(key)) return;
  }
  if(key === "tab" && (event.target === $("viewport") || document.body.classList.contains("panels-hidden"))) {event.preventDefault();setPanelsHidden(!document.body.classList.contains("panels-hidden"));return;}
  if(modifier && key === "a") {event.preventDefault();setSelection(canvasPages().map(p=>p.id));return;}
  if (key === "f2" && !modifier) { event.preventDefault(); beginPageRename(); return; }
  if (modifier && (key === "z" || key === "y")) {
    event.preventDefault(); travelHistory(key === "y" || event.shiftKey ? "redo" : "undo"); return;
  }
  if (modifier && key === "d") { event.preventDefault(); duplicatePage(); return; }
  if (modifier && !["+", "=", "-"].includes(key)) return;
  if (key === "v" || key === "h") { setMode(key === "v" ? "select" : "pan"); return; }
  if (key === " " && event.target.closest("button,a")) return;
  if (key === " " && !event.repeat) { event.preventDefault(); spaceMode = state.mode; setMode("pan"); return; }
  if (event.shiftKey && (event.code === "Digit1" || key === "1" || key === "!")) { event.preventDefault(); fit(); return; }
  if (event.shiftKey && (event.code === "Digit2" || key === "2" || key === "@")) { event.preventDefault(); focusSelection(); return; }
  if (key === "+" || key === "=") { event.preventDefault(); zoom(state.view.scale * 1.2); return; }
  if (key === "-") { event.preventDefault(); zoom(state.view.scale / 1.2); return; }
  if (key === "enter" && !event.target.closest("button,a")) { event.preventDefault(); openPreview(); return; }
  if (key === "escape" && !state.expanded) {setSelection([]);return;}
  if (key === "escape" && state.expanded) { event.preventDefault(); closeStates(); return; }
  if (key === "?") { event.preventDefault(); $("shortcutsDialog").showModal(); return; }
  const movement = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
  if (movement && selected() && state.editable && !state.busy && !state.expanded && !event.target.closest("button,a")) {
    event.preventDefault(); const step = event.shiftKey ? 10 : 1;
    if(!nudgePending) {clearTimeout(saveTimer);nudgePending=true;}
    movePages(selectionPages(),movement[0]*step,movement[1]*step);
    for(const page of selectionPages()) positionNode(boardNodes.get(page.id),page);
    renderSections();updateInspector();

  }
});
function releaseSpace() { if (spaceMode !== null) { const mode = spaceMode; spaceMode = null; setMode(mode); } }
window.addEventListener("keyup", (event) => { if (event.key === " ") releaseSpace(); });
window.addEventListener("blur", releaseSpace);
let nudgePending=false;
function finishNudge(){if(nudgePending){nudgePending=false;dirty();}}
window.addEventListener('keyup',event=>{if(event.key.startsWith('Arrow'))finishNudge();});
window.addEventListener('blur',finishNudge);
window.addEventListener('resize',()=>{scheduleFrames();if($('previewDialog').open)sizePreview();});
window.addEventListener('workspace-visible',()=>{scheduleFrames();$('viewport').focus({preventScroll:true});});
async function openAnnotationsForContext({ noteId, note, requirement, rule, ruleFile } = {}) {
  let source = requirement;
  if (!source && rule) {
    try {
      const response = await fetch(`/api/requirement-rules?${new URLSearchParams({ path: state.path })}`, { cache: "no-store" });
      const catalog = await response.json(); if (!response.ok) throw new Error(catalog.error || "需求原文读取失败");
      source = (catalog.rules || []).find((item) => item.blockId === rule && (!ruleFile || item.file === ruleFile));
      if (!source || source.ambiguous) {
        if (noteId || note) source = { file: ruleFile || "需求文档.md", blockId: rule, quote: "", heading: "需求原文" };
        else { toast(source?.ambiguous ? "这条原文有重复内容，暂不能唯一定位，请先在需求中区分。" : "这条需求原文已变化，请返回需求重新选择。", true); return false; }
      }
    } catch (error) { toast(error.message, true); return false; }
  }
  await pageAnnotations.open({ noteId: noteId || note || "", requirement: source });
  return true;
}
workspaceBridge = installWorkspaceBridge({
  kind: "design", getState: saveStatus, flush: flushAll,
  activate: async ({ pageId, notes, noteId, note, requirement, rule, ruleFile, inspector, historyDocument, flowReturn: returnFlow = "" }) => {
    if (!state.entry || !await flushAll()) return false;
    if (pageId && !state.workspace.pages.some((page) => page.id === pageId)) return false;
    if (!await pageAnnotations.close()) return false;
    // Let the cached frame and closed modal leave their previous layout before
    // mounting another sandboxed preview; otherwise the nested preview can paint blank.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if ($("editorDialog").open) $("editorDialog").close();
    if ($("previewDialog").open) $("previewDialog").close();
    if (state.expanded) closeStates();
    updateFlowReturn(returnFlow);
    if (pageId && pageId !== state.selected) { select(pageId); ensureVisible(selected()); }
    if (historyDocument) await descriptions.history(historyDocument);
    else if (inspector) await descriptions.open(inspector==='description'?state.selected:'');
    if (notes === "1" || noteId || note || requirement || rule) return await openAnnotationsForContext({ noteId, note, requirement, rule, ruleFile });
    return true;
  },
});
async function start() {
  try {
    const response = await fetch("/api/tree"); if (!response.ok) throw new Error("无法读取需求目录");
    const tree = await response.json(); $("requirementSelect").replaceChildren();
    let first = "";
    for (const module of tree.modules) {
      const group = document.createElement("optgroup"); group.label = module.module;
      for (const entry of module.features) { if (!first) first = entry.path; group.append(new Option(entry.feature, entry.path)); }
      $("requirementSelect").append(group);
    }
    const requested = new URLSearchParams(location.search).get("path");
    const exists = Array.from($("requirementSelect").options).some((option) => option.value === requested);
    const entryPath = exists ? requested : first;
    if (entryPath) { $("requirementSelect").value = entryPath; await loadWorkspace(entryPath, initialParams.get("page") || ""); if (initialParams.get("notes") === "1" || initialParams.get("note") || initialParams.get("rule")) await openAnnotationsForContext({ note: initialParams.get("note"), rule: initialParams.get("rule"), ruleFile: initialParams.get("ruleFile") }); }
    else { $("featureTitle").textContent = "暂无需求"; $("saveState").textContent = "请先在需求目录建立功能"; }
  } catch (error) { $("featureTitle").textContent = "工作台加载失败"; toast(error.message, true); }
}
descriptions=createDesignDescriptions({state,selected,api,dirty,flush:flushDesign,render:renderCanvas,toast});
start().then(async()=>{if(initialParams.get('historyDocument'))await descriptions.history(initialParams.get('historyDocument'));else if(initialParams.get('inspector'))await descriptions.open(initialParams.get('inspector')==='description'?state.selected:'');});

$('mergePageButton').addEventListener('click',async()=>{
 if(!selected()||!state.editable||state.busy||state.expanded)return;
 if(!await flushDesign())return;
 const source=selected(),dialog=document.createElement('dialog');dialog.className='document-version-dialog';
 const title=document.createElement('h2');title.textContent='合并页面';
 const text=document.createElement('p');text.textContent='先在目标页补齐原字段和记录。合并将迁移需求依据、流程绑定及页面入口，再移除当前页；历史版本保留。';
 const label=document.createElement('label');label.textContent='保留的目标页面';const select=document.createElement('select');select.setAttribute('aria-label','保留的目标页面');
 for(const p of state.workspace.pages.filter(p=>p.id!==source.id))select.append(new Option(p.name,p.id));
 const error=document.createElement('p');error.setAttribute('role','alert');const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>dialog.close();
 const submit=document.createElement('button');submit.textContent='合并并删除当前页';submit.className='primary';
 dialog.append(title,text,label,select,error,cancel,submit);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());
 submit.onclick=async()=>{submit.disabled=true;try{await api('/merge',{method:'POST',body:JSON.stringify({expectedRevision:state.workspace.revision,sourceId:source.id,targetId:select.value})});state.dirty=false;const u=new URL(location.href);u.searchParams.set('page',select.value);u.searchParams.set('standalone','1');location.href=u.href;}catch(e){error.textContent=e.message;submit.disabled=false;}};dialog.showModal();
});
