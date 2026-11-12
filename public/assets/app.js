import {createTestUI} from './test-module.js';
import { mountAccount } from './accounts.js';
import {createGiteeSyncUI} from "./gitee-sync.js";
import { statusIndicator, controlHint, icon as workbenchIcon, iconButton, iconButtons } from "./workbench-icons.js";
import {createWorkspaceHost, workspaceHashFromUrl} from "./workspace-bridge.js";
import {createRequirementLinks} from "./requirement-links.js";
import {createDocumentEditor} from "./document-editor.js";
import {createEntryUI} from "./entry-create.js";
import {bindAiCopy, bindCopyButton} from "./ai-context.js";
import {resolvePreviewTarget, previewBridgeScript} from './preview-navigation.mjs';
(function () {
  "use strict";

  const DOC_LABELS = { spec: "规格索引", requirement: "需求文档", page: "页面说明", contract: "接口契约", task: "任务拆分", other: "补充说明" };
  const DOC_PRIORITY = ["spec", "requirement", "contract"];
  const NAVIGATION_PREFERENCES_KEY = "requirementsPortal.navigationPreferences.v1";
  const state = {
    tree: null, entry: null, selectedPath: "", selectedPrototypePath: "", previewQuery:"", previewBridgeToken:"", file: "", heading: "",
    filterText: "", activeView: "doc", docKey: "requirement", docRequestToken: 0,
    entryRequestToken: 0, previewRequestToken: 0, treeRequestToken: 0,
    editNewDocumentPath: "", docPositions: new Map(), editorOptions: {}, routeLocked: false, navigationIntent: 0, routeSnapshot: "", entryRefreshTimer: null,
    flowRequestToken: 0, flowPreviewToken: 0, selectedFlowId: "", selectedFlowSource: "", flowData: null, flowCatalog: [], flowCatalogError: "",
    archivedPaths: new Set(), collapsedModules: new Set(), showArchived: false,
    searchCollapsedModules: new Set(), treeScrollBeforeSearch: 0, outlineHidden: false, designNavigation: false, designReturn: null,
  };
  const nodes = {};
  for (const id of ["toggleDesignNavigation", "treeContainer", "treeMeta", "searchInput", "createEntryButton", "toggleArchivedButton", "archivedToggleLabel", "archivedCount", "documentSelect", "openDesignLink", "toggleOutlineButton", "docWorkspace", "previewWorkspace", "docStatus", "docOutline", "docEyebrow", "docTitle", "downloadDocLink", "docContent", "prototypeList", "previewFrame", "previewImage", "previewLabel", "previewEmpty", "openPreviewLink", "editPreviewLink", "annotationPreviewLink", "entryModule", "entryTitle", "entryGiteeLink", "entryGiteeStatus", "flowNavigation", "designSummary", "previewStage", "editorWorkspace", "editorFrames", "workspaceSaveState", "workspaceNotice", "designModeSwitch"]) nodes[id] = document.getElementById(id);
  nodes.layout = document.querySelector(".layout");
  nodes.documentStage = document.querySelector(".document-stage");
  for (const id of ["flowWorkspace", "flowList", "flowSummary", "flowStage", "flowEmpty", "flowFrame", "flowTitle", "flowSourceLabel", "flowApplicability", "openFlowLink", "openSourceFlowLink", "newFlowLink", "linkFlowLink", "flowCatalogNotice"]) nodes[id] = document.getElementById(id);

  const testUI=createTestUI(document.getElementById('testWorkspace'));
  const workspaceHost = createWorkspaceHost({container:nodes.editorFrames,
    onError(message) { nodes.workspaceNotice.textContent=message; nodes.workspaceNotice.classList.remove("hidden"); },
    onNavigate(hash) { void navigateHash(hash); },
    onState(kind, info) {
      if (info.path !== state.selectedPath) return;
      if(kind==="flow" && state.activeView==="flow") nodes.layout.classList.toggle("route-audit-open",!!info.routeAuditOpen);
      if (state.activeView===kind && !state.routeLocked) {
        if (kind==='design' && info.pageId) state.selectedPrototypePath=`design:${info.pageId}`;
        if (kind==='flow') { state.selectedFlowId=info.flowId||''; state.selectedFlowSource=info.sourcePath||state.selectedPath; }
        renderSaveState(); setHash(true);
      }
      if(state.activeView===kind) renderSaveState();
      if (!info.dirty && !info.saving && !info.error) {
        clearTimeout(state.entryRefreshTimer);
        const path=state.selectedPath;
        state.entryRefreshTimer=setTimeout(async()=>{
          try { const result=await fetchJson(`/api/entry?path=${encodeURIComponent(path)}`); if(path!==state.selectedPath)return; state.entry=result.entry; renderContentControls(); } catch { /* The active editor owns write failure feedback. */ }
        },350);
      }
    }
  });
  const requirementLinks = createRequirementLinks({content:nodes.docContent,workspace:nodes.docWorkspace,panel:document.getElementById('requirementLinksPanel'),onNavigate:navigateHash,
    onSelection(rule) {
      if(state.activeView!=='doc')return;
      if(rule){state.editorOptions.rule=rule.blockId;state.editorOptions.ruleFile=rule.file;}
      else {delete state.editorOptions.rule;delete state.editorOptions.ruleFile;}
      setHash(true);
    }
  });
  const documentEditor=createDocumentEditor({container:nodes.documentStage,readView:nodes.docContent,editButton:document.getElementById('editDocumentButton'),historyButton:document.getElementById('documentHistoryButton'),onStatus:()=>renderSaveState(),onRead:async()=>{await refreshEntrySummary();await loadCurrentDocument()}});
  bindCopyButton({ button: nodes.entryTitle, label: '复制需求名称', success: '已复制需求名称',
    getText: () => state.entry?.path === state.selectedPath ? state.entry.feature : '' });
  bindAiCopy({ button: document.getElementById('copyAiButton'), flush: canNavigate,
    getContext: () => state.entry && state.entry.path === state.selectedPath ? {
      path: state.selectedPath, name: state.entry.feature,
      flow: state.activeView === 'flow' ? state.selectedFlowId : '',
      source: state.selectedFlowSource || state.selectedPath,
    } : null });
  const giteeSyncUI=createGiteeSyncUI({getPath:()=>state.selectedPath,onChanged:async()=>{await loadTree();await refreshEntrySummary();renderContentControls();if(state.activeView==='doc')await loadCurrentDocument();}});
  createEntryUI({button:nodes.createEntryButton,getModules:()=>state.tree?.modules || [],getModule:()=>state.entry?.module,
    beforeCreate:canNavigate,onCreated:async entry=>{
      state.editNewDocumentPath=entry.path; state.filterText=''; nodes.searchInput.value=''; state.activeView='doc'; state.docKey='requirement';
      state.file=''; state.heading=''; state.editorOptions={}; state.selectedPrototypePath='';
      await loadTree({selectPath:entry.path,throwOnError:true});
    },onOpened:()=>documentEditor.focus()
  });
  function renderSaveState() {
    const docInfo=documentEditor?.getStatus();
    const info=state.activeView==='doc'&&docInfo?.editing?docInfo:workspaceHost.getState(state.activeView);
    const editing=['design','flow'].includes(state.activeView)||state.activeView==='doc'&&docInfo?.editing;
    const saveLabel=editing ? info?.error ? '保存未完成' : info?.saving ? '正在保存…' : info?.dirty ? '等待自动保存…' : info ? ({saved:'已自动保存',loading:'正在打开…',pending:'等待自动保存…',saving:'正在保存…',readonly:'只读'}[info.status] || '已自动保存') : '正在打开…' : '';
    nodes.workspaceSaveState.classList.toggle('has-error',!!info?.error);
    const saveIcon=info?.error?'help':info?.saving||info?.dirty||!info||['loading','pending','saving'].includes(info.status)?'history':info.status==='readonly'?'eye':'documentCheck';
    statusIndicator(nodes.workspaceSaveState,saveIcon,saveLabel,info?.error || '');
    nodes.openDesignLink.classList.toggle('hidden',editing);
    nodes.designModeSwitch.classList.toggle('hidden',!['design','preview'].includes(state.activeView));
    nodes.designModeSwitch.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.designMode===state.activeView)));
  }
  async function canNavigate() {
    if(state.activeView==='doc' && state.selectedPath) state.docPositions.set(`${state.selectedPath}|${getCurrentDocFile()}`,nodes.documentStage.scrollTop);
    const intent=++state.navigationIntent;
    if(!await documentEditor.flush())return false;
    const saved=await workspaceHost.flushAll();
    if(saved) nodes.workspaceNotice.classList.add('hidden');
    return saved && intent===state.navigationIntent;
  }
  async function showEditor() {
    resetPreview(); resetFlowWorkspace(false); renderTabs(); renderSaveState();
    if(!state.entry) return;
    const args={path:state.selectedPath,pageId:state.selectedPrototypePath.startsWith('design:')?state.selectedPrototypePath.slice(7):'',flowId:state.selectedFlowId,sourcePath:state.selectedFlowSource||state.selectedPath,...state.editorOptions};
    const kind=state.activeView,path=state.selectedPath;
    await workspaceHost.show(kind,args);
    if(kind!==state.activeView||path!==state.selectedPath)return;
    const current=workspaceHost.getState(kind);
    if(current?.path===path) {
      if(kind==='design'&&current.pageId)state.selectedPrototypePath=`design:${current.pageId}`;
      if(kind==='flow'){state.selectedFlowId=current.flowId||'';state.selectedFlowSource=current.sourcePath||path;}
    }
    state.editorOptions={}; setHash(true);
  }
  async function refreshEntrySummary() {
    if(!state.selectedPath)return;
    try { const path=state.selectedPath, payload=await fetchJson(`/api/entry?path=${encodeURIComponent(path)}`); if(path===state.selectedPath) state.entry=payload.entry; } catch {}
  }
  async function navigateHash(hash) {
    if(!await canNavigate()) {history.replaceState(null,'',`/#${state.routeSnapshot}`);return;}
    history.pushState(null,'',`/#${hash}`);loadHash();
    await openEntry(state.selectedPath||getDefaultEntryPath(),{fromHash:true,guarded:true});
  }
  const icons = {
    archive: '<path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/>',
    restore: '<path d="M4 8h16v12H4zM3 4h18v4H3zM9 15l3-3 3 3m-3-3v6"/>',
    file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
    frame: '<path d="M5 3v18M19 3v18M3 5h18M3 19h18"/>',
    image: '<path d="M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4"/><circle cx="16" cy="8" r="1"/>',
    flow: '<path d="M8 3h8v5H8zM8 16h8v5H8zM12 8v8M3 10h5v5H3zM16 10h5v5h-5zM8 12h8"/>',
  };
  function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`; }
  function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function formatDate(value) {
    const date = value && new Date(value);
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未同步";
  }
  function getAllEntries() { return (state.tree?.modules || []).flatMap((item) => item.features || []); }
  function findEntryInTree(relativePath) { return getAllEntries().find((item) => item.path === relativePath) || null; }
  function getDefaultEntryPath() {
    return getAllEntries().filter((item) => !state.archivedPaths.has(item.path)).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0]?.path || "";
  }
  function loadNavigationPreferences() {
    try {
      const prefs = JSON.parse(localStorage.getItem(NAVIGATION_PREFERENCES_KEY) || "{}");
      state.legacyArchivedPaths = new Set(Array.isArray(prefs.archivedPaths) ? prefs.archivedPaths : []);
      state.collapsedModules = new Set(Array.isArray(prefs.collapsedModules) ? prefs.collapsedModules : []);
      state.designNavigation = prefs.designNavigation === true;
      state.navigationHidden = prefs.navigationHidden === true;
      state.outlineHidden = prefs.outlineHidden === true;
    } catch { /* Storage preferences are optional. */ }
  }
  function saveNavigationPreferences() {
    try { localStorage.setItem(NAVIGATION_PREFERENCES_KEY, JSON.stringify({ archivedPaths: [...(state.legacyArchivedPaths || [])], collapsedModules: [...state.collapsedModules], designNavigation: state.designNavigation, navigationHidden: state.navigationHidden, outlineHidden: state.outlineHidden })); } catch { /* The workspace also works without local storage. */ }
  }
  function pruneNavigationPreferences() {
    const paths = new Set(getAllEntries().map((entry) => entry.path));
    const modules = new Set((state.tree?.modules || []).map((item) => item.module));
    state.archivedPaths = new Set([...state.archivedPaths].filter((path) => paths.has(path)));
    state.collapsedModules = new Set([...state.collapsedModules].filter((name) => modules.has(name)));
    saveNavigationPreferences();
  }
  function locationParams() {
    const params = new URLSearchParams();
    if (state.selectedPath) params.set("path", state.selectedPath);
    params.set("view", state.activeView);
    params.set("doc", state.docKey);
    if (state.file) params.set("file", state.file);
    if (state.heading) params.set("heading", state.heading);
    if (state.selectedPrototypePath) params.set("prototype", state.selectedPrototypePath);
    if (state.activeView === 'preview' && state.previewQuery) params.set('prototypeQuery',state.previewQuery);
    if (state.selectedFlowId) params.set("flow", state.selectedFlowId);
    if (state.selectedFlowSource && state.selectedFlowSource !== state.selectedPath) params.set("flowSource", state.selectedFlowSource);
    for (const [key,value] of Object.entries(state.editorOptions)) if(value) params.set(key,value);
    return params;
  }
  function setHash(replace = false) {
    const hash = locationParams().toString();
    if (location.hash.slice(1) !== hash) history[replace ? "replaceState" : "pushState"](null, "", `${location.pathname}${location.search}#${hash}`);
    state.routeSnapshot=hash; renderDesignLinks();
  }
  function loadHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    state.selectedPath = params.get("path") || "";
    state.activeView = ["preview", "flow", "design", "test"].includes(params.get("view")) ? params.get("view") : "doc";
    state.docKey = ["spec", "requirement", "page", "contract", "task", "other"].includes(params.get("doc")) ? params.get("doc") : "requirement";
    state.file = params.get("file") || "";
    state.heading = params.get("heading") || "";
    try { state.heading = decodeURIComponent(state.heading); } catch { /* Keep malformed anchors readable. */ }
    state.selectedPrototypePath = params.get("prototype") || (params.get("page") ? `design:${params.get("page")}` : "");
    state.previewQuery = params.get('prototypeQuery') || '';
    state.selectedFlowId = params.get("flow") || "";
    state.selectedFlowSource = params.get("flowSource") || state.selectedPath;
    state.editorOptions=Object.fromEntries(["node","zoom","x","y","fromPath","fromFlow","fromSource","flowReturn","action","notes","note","rule","ruleFile","inspector","historyDocument"].filter(key=>params.has(key)).map(key=>[key,params.get(key)]));
  }
  function designUrl(pageId = "") {
    const params=locationParams();params.set('view','design');params.delete('notes');params.delete('action');
    for(const key of ['note','rule','ruleFile'])params.delete(key);
    const page=pageId||(state.selectedPrototypePath.startsWith('design:')?state.selectedPrototypePath.slice(7):'');
    if(page)params.set('prototype',`design:${page}`);
    return `/#${params}`;
  }
  function renderDesignLinks() {
    nodes.openDesignLink.href = designUrl();
    nodes.editPreviewLink.href = designUrl();
    nodes.openFlowLink.href = flowUrl();
    nodes.newFlowLink.href = flowUrl({ action: "new", flowId: "" });
    nodes.linkFlowLink.href = flowUrl({ action: "link", flowId: "" });
  }
  function flowUrl({ action = "", source = "", flowId = state.selectedFlowId, embed = false } = {}) {
    const params = new URLSearchParams();
    if (source || state.selectedPath) params.set("path", source || state.selectedPath);
    if (flowId) params.set("flow", flowId);
    if (!source && flowId && state.selectedFlowSource && state.selectedFlowSource !== state.selectedPath) params.set("flowSource", state.selectedFlowSource);
    if (action) params.set("action", action);
    if (embed) params.set("embed", "1");
    if (state.selectedPath) params.set("return", locationParams().toString());
    if(embed) return `/flow?${params}`;
    params.delete("return");params.set("view","flow");return `/#${params}`;
  }
  async function writeArchive(url,method,body) {
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'归档保存失败，请重试');return result;
  }
  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }
  function updateArchiveControls() {
    const count = getAllEntries().filter((item) => state.archivedPaths.has(item.path)).length;
    if (!count) state.showArchived = false;
    nodes.archivedCount.textContent = String(count);
    nodes.archivedToggleLabel.textContent = state.showArchived ? "隐藏已归档" : "已归档";
    nodes.toggleArchivedButton.disabled = !count;
    nodes.toggleArchivedButton.setAttribute("aria-pressed", String(state.showArchived));
    nodes.toggleArchivedButton.classList.toggle("active", state.showArchived);
  }
  function renderTree() {
    const list = nodes.treeContainer, scroll = list.scrollTop, focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = ["moduleName", "entryPath", "archivePath"].find(key => focused?.dataset[key]), focusValue = focused?.dataset[focusKey];
    const focusModule = focused?.closest('.menu-section')?.querySelector('[data-module-name]')?.dataset.moduleName;
    const filter = state.filterText.trim().toLowerCase();
    const modules = state.tree?.modules || [];
    const allCount = getAllEntries().length;
    nodes.treeMeta.textContent = `${allCount} 项需求`;
    nodes.treeMeta.title = `目录更新 ${formatDate(state.tree?.generatedAt)} · Gitee 同步 ${formatDate(state.tree?.giteeStatusSyncedAt)}`;
    updateArchiveControls();
    let visibleCount = 0;
    nodes.treeContainer.innerHTML = modules.map((moduleNode) => {
      const features = (moduleNode.features || []).filter((feature) => (state.showArchived || !state.archivedPaths.has(feature.path)) && (!filter || [feature.path, feature.feature, feature.gitee?.ident, feature.gitee?.label, feature.writingStatus?.label].join(" ").toLowerCase().includes(filter)));
      if (!features.length) return "";
      visibleCount += features.length;
      const collapsed = (filter ? state.searchCollapsedModules : state.collapsedModules).has(moduleNode.module);
      return `<section class="menu-section${collapsed ? " collapsed" : ""}"><button class="menu-section-title" data-module-name="${escapeHtml(moduleNode.module)}" type="button" aria-expanded="${!collapsed}"><span class="menu-section-heading"><span class="menu-chevron" aria-hidden="true">${workbenchIcon('next')}</span><span>${escapeHtml(moduleNode.module)}</span></span><span class="module-count">${features.length}</span></button><div class="menu-section-body${collapsed ? " hidden" : ""}">${features.map((feature) => {
        const archived = state.archivedPaths.has(feature.path);
        const gitee = feature.gitee || {};
        const label = gitee.ident ? `${gitee.ident} · ${gitee.label || "待同步"}` : "Gitee 未关联";
        const written = Boolean(feature.docs?.requirement);
        const writingLabel = written ? "需求文档已写" : "需求文档待写";
        return `<div class="menu-item-row${archived ? " archived" : ""}"><button class="menu-item${feature.path === state.selectedPath ? " active" : ""}" data-entry-path="${escapeHtml(feature.path)}" type="button" aria-label="${escapeHtml(`${feature.feature}，${label}，${writingLabel}`)}"${feature.path === state.selectedPath ? ' aria-current="page"' : ""}><strong>${escapeHtml(feature.feature)}</strong><span class="menu-item-meta"><span class="status-dot status-${escapeHtml(gitee.state || "unlinked")}" aria-hidden="true"></span><span>${escapeHtml(label)}</span><span class="writing-state wb-status-icon" role="img" aria-label="${writingLabel}" data-tooltip="${writingLabel}" data-tooltip-on-focus>${workbenchIcon(written ? "documentCheck" : "documentEmpty")}</span></span></button><button class="archive-button icon-button" data-archive-path="${escapeHtml(feature.path)}" type="button" ${(feature.canEdit ?? state.tree?.canArchive) ? "" : "disabled"} title="${(feature.canEdit ?? state.tree?.canArchive) ? (archived ? "取消归档" : "归档") : "当前连接为只读"}" aria-label="${archived ? "取消归档" : "归档"}${escapeHtml(feature.feature)}">${icon(archived ? "restore" : "archive")}</button></div>`;
      }).join("")}</div></section>`;
    }).join("");
    for (const button of nodes.treeContainer.querySelectorAll('[data-archive-path]')) {
      const archived = state.archivedPaths.has(button.dataset.archivePath);
      const label = button.getAttribute('aria-label');
      iconButton(button, archived ? 'unarchive' : 'archive', label);
      button.dataset.tooltip = !button.disabled ? (archived ? '取消归档' : '归档') : '仅创建者可编辑';
    }
    if (!visibleCount) nodes.treeContainer.innerHTML = `<div class="empty-state small-empty">${filter ? "没有匹配的需求" : "暂无可见需求"}${filter ? '<button class="button" data-clear-search type="button">清除搜索</button>' : state.archivedPaths.size ? '<button class="button" data-show-archived type="button">查看已归档</button>' : '<button class="button" data-retry-tree type="button">刷新目录</button>'}</div>`;
    list.scrollTop = scroll;
    if (focusKey) {
      const buttons = [...list.querySelectorAll('button')];
      const target = buttons.find(button => button.dataset[focusKey] === focusValue && !button.closest('.hidden')) || buttons.find(button => button.dataset.moduleName === focusModule);
      target?.focus({preventScroll:true});
    }
    updateTreeTitleHints();
  }
  function updateTreeTitleHints() {
    for (const title of nodes.treeContainer.querySelectorAll('.menu-item strong')) {
      if (title.scrollWidth > title.clientWidth) title.dataset.tooltip = title.textContent;
      else delete title.dataset.tooltip;
    }
  }
  function updateTreeFilter(value) {
    const wasSearching = !!state.filterText.trim(), searching = !!value.trim();
    if (!wasSearching && searching) state.treeScrollBeforeSearch = nodes.treeContainer.scrollTop;
    state.filterText = value; state.searchCollapsedModules.clear();
    renderTree();
    nodes.treeContainer.scrollTop = !searching && wasSearching ? state.treeScrollBeforeSearch : 0;
  }
  function toggleModule(name) {
    const collapsed = state.filterText.trim() ? state.searchCollapsedModules : state.collapsedModules;
    if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
    if (!state.filterText.trim()) saveNavigationPreferences();
    renderTree();
  }
  function getDocuments(includeExternal = true) {
    const docs = DOC_PRIORITY.filter((key) => state.entry?.docs?.[key]).map((key) => ({ key, file: state.entry.docs[key], label: DOC_LABELS[key], downloadable: true }));
    for (const item of state.entry?.referenceDocuments || []) docs.push({key:"other",file:item.path,label:`资料 · ${item.name.replace(/\.md$/i, "")}`,downloadable:true});
    if (includeExternal && state.file && !docs.some((item) => item.file === state.file)) docs.push({ key: "other", file: state.file, label: state.file.split("/").pop().replace(/\.md$/i, ""), downloadable: false });
    return docs;
  }
  function getCurrentDocFile() { return state.file || (state.docKey === "page" ? state.entry?.pageDesigns?.[0]?.path : state.entry?.docs?.[state.docKey]) || ""; }
  function currentDocLabel() { return getDocuments().find((item) => item.file === getCurrentDocFile())?.label || DOC_LABELS[state.docKey] || "文档"; }
  function normalizeDocument() {
    if(state.entry && state.activeView==='doc' && (state.docKey==='page'||state.file.startsWith(state.entry.path+'/页面设计/'))){
      const file = state.file || state.entry.pageDesigns?.[0]?.path || state.entry.designDocuments?.[0]?.file;
      const mapping = state.entry.designDocuments?.find(document => document.file === file);
      state.activeView='design';state.docKey='requirement';state.file='';state.heading='';
      if(mapping?.pageId)state.selectedPrototypePath='design:'+mapping.pageId;
      if(file && (!mapping || mapping.target==='history'))state.editorOptions={historyDocument:file};
      else state.editorOptions={inspector:mapping?.pageId?'description':'overview'};
    }
    if (state.file && (!state.entry || !state.file.startsWith(`${state.entry.path}/`) || !/\.md$/i.test(state.file))) state.file = "";
    if (state.file) {
      const known = getDocuments(false).find((item) => item.file === state.file);
      if (known) state.docKey = known.key;
    }
  }
  function renderContentControls() {
    document.getElementById("entryOwner").textContent = state.tree?.accountsEnabled && state.entry ? (state.entry.owner ? `${state.entry.owner.displayName} · ${state.entry.canEdit ? "可编辑" : "只读"}` : "未分配创建者 · 只读") : "";
    nodes.entryTitle.disabled = !state.entry || state.entry.path !== state.selectedPath;
    const copyButton = document.getElementById('copyAiButton');
    copyButton.disabled = copyButton.getAttribute('aria-busy') === 'true' || !state.entry || state.entry.path !== state.selectedPath;
    void giteeSyncUI.refresh();
    renderDesignLinks();
    nodes.entryModule.textContent = state.entry?.module || "需求平台";
    nodes.entryTitle.textContent = state.entry?.feature || (state.selectedPath ? "加载需求…" : "选择需求");
    document.title = state.entry ? `${state.entry.feature} · 需求平台` : "需求平台";
    const gitee = state.entry?.gitee || {};
    nodes.entryGiteeLink.classList.add("hidden");
    nodes.entryGiteeStatus.classList.remove("hidden");
    nodes.entryGiteeStatus.textContent = state.entry ? `Gitee · ${gitee.label || (gitee.ident ? "待同步" : "未关联")}` : "";
    nodes.entryGiteeStatus.className = `gitee-status status-${gitee.state || "unlinked"}`;
    const href = gitee.url || gitee.link;
    if (href && /^https:\/\//i.test(href)) {
      nodes.entryGiteeLink.href = href;
      nodes.entryGiteeLink.textContent = `${gitee.ident || "Gitee"} · ${gitee.label || "待同步"}`;
      nodes.entryGiteeLink.className = `gitee-status status-${gitee.state || "unlinked"}`;
      nodes.entryGiteeStatus.classList.add("hidden");
    }
    const docs = getDocuments();
    nodes.documentSelect.innerHTML = docs.length ? docs.map((item) => `<option value="${escapeHtml(item.file)}">${escapeHtml(item.label)}</option>`).join("") : '<option value="">暂无文档</option>';
    nodes.documentSelect.disabled = !docs.length;
    const file = getCurrentDocFile();
    if (docs.some((item) => item.file === file)) nodes.documentSelect.value = file;
    else { nodes.documentSelect.insertAdjacentHTML("afterbegin", `<option value="">${escapeHtml(DOC_LABELS[state.docKey] || "文档")} · 待补充</option>`); nodes.documentSelect.value = ""; }
    const hasEntry = !!state.entry;
    const designCount = state.entry?.design?.pages?.length || 0;
    const sourceCount = state.entry?.prototypes?.length || 0;
    const flow = state.entry?.flow;
    const flowCount = (flow?.ownedCount || 0) + (flow?.referenceCount || 0);
    const activeStage = ["preview","design"].includes(state.activeView) ? "design" : ["flow","test"].includes(state.activeView) ? state.activeView : state.docKey;
    const stages = [
      { key: "spec", label: "规格", status: state.entry?.docs?.spec ? "已收录" : "待补充", available: !!state.entry?.docs?.spec },
      { key: "requirement", label: "需求", status: state.entry?.docs?.requirement ? "已收录" : "待补充", available: !!state.entry?.docs?.requirement },
      { key: "flow", label: "流程", status: flow?.applicability === "not-needed" ? "无需" : flowCount ? `${flowCount} 张图` : "可选", available: !!flowCount, optional: true },
      { key: "design", label: "设计", status: designCount ? `${designCount} 个页面` : sourceCount ? `${sourceCount} 份原型` : "待设计", available: !!(designCount || sourceCount) },
      { key: "contract", label: "接口", status: state.entry?.docs?.contract ? "已收录" : "待补充", available: !!state.entry?.docs?.contract },
    ];
    stages.push({key:"test",label:"测试",status:"",available:true});
    nodes.flowNavigation.innerHTML = stages.map((stage) => `<button type="button" class="flow-step${activeStage === stage.key ? " active" : ""}" data-stage="${stage.key}"${hasEntry ? "" : " disabled"}${activeStage === stage.key ? ' aria-current="step"' : ""}><span>${stage.label}</span><small class="${stage.optional ? "optional" : stage.available ? "available" : "missing"}">${hasEntry ? stage.status : "—"}</small></button>`).join("");
    renderLayoutPreferences(); renderSaveState();
  }
  function renderTabs() {
    if(state.activeView!=="flow")nodes.layout.classList.remove("route-audit-open");
    if(state.activeView!=="test")testUI.hide();
    if(state.activeView!=='doc')requirementLinks.reset();
    nodes.docWorkspace.classList.toggle("hidden", state.activeView !== "doc");
    nodes.previewWorkspace.classList.toggle("hidden", state.activeView !== "preview");
    nodes.flowWorkspace.classList.add("hidden");
    nodes.editorWorkspace.classList.toggle("hidden", !["design","flow"].includes(state.activeView));
    if(!["design","flow"].includes(state.activeView)) workspaceHost.hide();
    renderSaveState();
    renderLayoutPreferences();
  }
  function renderLayoutPreferences() {
    const design = state.activeView === 'design';
    const visible = design ? state.designNavigation : !state.navigationHidden;
    nodes.layout.classList.toggle('design-focused', !visible);
    nodes.toggleDesignNavigation.classList.remove('hidden');
    iconButton(nodes.toggleDesignNavigation, visible ? 'sidebar' : 'sidebarOpen', visible ? '隐藏需求目录' : '显示需求目录');
    nodes.toggleDesignNavigation.setAttribute('aria-pressed',String(visible));
    nodes.layout.classList.toggle("editor-active",["design","flow"].includes(state.activeView));
    nodes.docWorkspace.classList.toggle("outline-hidden", state.outlineHidden);
    iconButton(nodes.toggleOutlineButton, "outline", state.outlineHidden ? "显示文档大纲" : "隐藏文档大纲");
    nodes.toggleOutlineButton.setAttribute("aria-pressed", String(state.outlineHidden));
    nodes.toggleOutlineButton.classList.toggle("hidden", state.activeView !== "doc");
  }
  function setLinkEnabled(link, enabled) {
    link.classList.toggle("disabled", !enabled);
    link.setAttribute("aria-disabled", String(!enabled));
    if (enabled) link.removeAttribute("tabindex"); else { link.href = "#"; link.setAttribute("tabindex", "-1"); }
  }
  function renderDocEmpty(message, retry = false) {
    nodes.docEyebrow.textContent = DOC_LABELS[state.docKey] || "文档";
    nodes.docTitle.textContent = state.entry?.feature || "文档内容";
    nodes.downloadDocLink.removeAttribute("download");
    setLinkEnabled(nodes.downloadDocLink, false);
    nodes.docStatus.textContent = "";
    nodes.docOutline.className = "doc-outline empty-state";
    nodes.docOutline.textContent = "暂无大纲";
    nodes.docContent.className = "markdown-body empty-state";
    nodes.docContent.innerHTML = `<div class="empty-content">${icon("file")}<strong>${escapeHtml(message)}</strong><div class="empty-actions">${!retry && state.entry && (state.entry?.canEdit ?? state.tree?.canEditDocuments) && ['spec','requirement','contract'].includes(state.docKey)?'<button class="button button-primary" type="button" data-write-document>编写'+escapeHtml(DOC_LABELS[state.docKey])+'</button>':''}${retry ? '<button class="button" type="button" data-retry-document>重新加载</button>' : state.entry ? `<button class="button" type="button" data-stage="${getDocuments(false).find((item) => item.key !== state.docKey)?.key || "design"}">${getDocuments(false).some((item) => item.key !== state.docKey) ? "查看已有文档" : "查看设计与原型"}</button>` : '<button class="button" type="button" data-retry-tree>重新加载目录</button>'}<a class="button" href="${escapeHtml(designUrl())}">编辑设计</a></div></div>`;
  }
  async function createDocument(file,title){
    if(!await canNavigate())return;
    const p=state.selectedPath;
    const response=await fetch('/api/document?'+new URLSearchParams({path:p,file}),{method:'PUT',headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},body:JSON.stringify({expectedRevision:0,content:'# '+title+'\n',editor:true})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'文档创建失败');
    if(p!==state.selectedPath)return;
    state.file=file;state.editNewDocumentPath=p;await refreshEntrySummary();setHash();await loadCurrentDocument();
  }

  function buildOutline() {
    const headingIds = new Set();
    [...nodes.docContent.querySelectorAll("h1,h2,h3,h4,h5,h6")].forEach((heading, index) => {
      const base = heading.id || `doc-heading-${index + 1}`;
      let id = base, suffix = 2;
      while (headingIds.has(id)) id = `${base}-${suffix++}`;
      heading.id = id; headingIds.add(id);
    });
    const headings = [...nodes.docContent.querySelectorAll("h1, h2, h3")].map((heading, index) => {
      if (!heading.id) heading.id = `doc-heading-${index + 1}`;
      return { id: heading.id, level: Number(heading.tagName.slice(1)), text: heading.textContent.trim() };
    });
    nodes.docStatus.textContent = headings.length ? `${headings.length} 个章节` : "无章节标题";
    nodes.docOutline.className = headings.length ? "doc-outline" : "doc-outline empty-state";
    nodes.docOutline.innerHTML = headings.length ? headings.map((heading) => `<button class="outline-item level-${heading.level}" data-heading-id="${escapeHtml(heading.id)}" type="button">${escapeHtml(heading.text)}</button>`).join("") : "当前文档没有章节标题";
    if (state.heading) scrollToHeading(state.heading, false);
  }
  function scrollToHeading(id, smooth = true) {
    const heading = [...nodes.docContent.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((item) => item.id === id);
    if (!heading) return;
    heading.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
    nodes.docOutline.querySelectorAll(".outline-item").forEach((item) => item.classList.toggle("active", item.dataset.headingId === id));
  }
  async function loadCurrentDocument() {
    const token = ++state.docRequestToken;
    requirementLinks.reset();
    documentEditor.mount(null);
    normalizeDocument();
    renderContentControls(); renderTabs();
    if (!state.entry) return renderDocEmpty("请选择左侧需求");
    const entryPath = state.entry.path, file = getCurrentDocFile(), label = currentDocLabel();
    nodes.docEyebrow.textContent = label;
    nodes.docTitle.textContent = state.entry.feature;
    setLinkEnabled(nodes.downloadDocLink, false);
    if (!file) return renderDocEmpty(`尚未收录${DOC_LABELS[state.docKey] || "文档"}`);
    nodes.docOutline.className = "doc-outline empty-state";
    nodes.docOutline.textContent = "正在生成大纲…";
    nodes.docStatus.textContent = "加载中";
    nodes.docContent.className = "markdown-body loading-state";
    nodes.docContent.textContent = "正在加载文档…";
    try {
      const payload = await fetchJson(`/api/doc?path=${encodeURIComponent(entryPath)}&file=${encodeURIComponent(file)}`);
      if (token !== state.docRequestToken || state.selectedPath !== entryPath || state.activeView !== "doc") return;
      if(payload.redirect){history.replaceState(null,'',payload.redirect);loadHash();await openEntry(entryPath,{fromHash:true,guarded:true});return;}
      nodes.docEyebrow.textContent = label;
      nodes.docEyebrow.title = payload.file || file;
      nodes.docTitle.textContent = payload.title || state.entry.feature;
      const downloadable = getDocuments(false).some((item) => item.file === file);
      setLinkEnabled(nodes.downloadDocLink, downloadable);
      controlHint(nodes.downloadDocLink, downloadable ? "下载当前文档" : "当前补充文档仅支持阅读");
      if (downloadable) { nodes.downloadDocLink.href = `/download/doc?file=${encodeURIComponent(file)}`; nodes.downloadDocLink.setAttribute("download", file.split("/").pop()); }
      nodes.docContent.className = "markdown-body";
      nodes.docContent.innerHTML = payload.html || '<p class="text-secondary">文档为空。</p>';
      nodes.documentStage.scrollTop = state.docPositions.get(`${entryPath}|${file}`)||0;
      buildOutline();
      documentEditor.mount(payload,{startEditing:state.editNewDocumentPath===entryPath});
      if(state.editNewDocumentPath===entryPath)state.editNewDocumentPath='';
      void requirementLinks.mount({entry:state.entry,file,rules:payload.rules||[],focusRule:state.editorOptions.rule||''});
    } catch (error) {
      if (token !== state.docRequestToken || state.selectedPath !== entryPath || state.activeView !== "doc") return;
      renderDocEmpty(error.message || "文档加载失败", true);
    }
  }
  function resetPreview() {
    state.previewRequestToken += 1;
    state.previewBridgeToken = '';
    nodes.previewFrame.onload = null; nodes.previewFrame.onerror = null;
    nodes.previewFrame.classList.add("hidden"); nodes.previewFrame.removeAttribute("srcdoc"); nodes.previewFrame.src = "about:blank";
    nodes.previewImage.onload = null; nodes.previewImage.onerror = null;
    nodes.previewImage.classList.add("hidden"); nodes.previewImage.removeAttribute("src");
    nodes.previewFrame.style.width = ""; nodes.previewFrame.style.height = "";
    setLinkEnabled(nodes.openPreviewLink, false);
    nodes.editPreviewLink.classList.add("hidden"); nodes.annotationPreviewLink.classList.add("hidden");
    nodes.previewStage.classList.remove("saved-design-preview");
  }
  function previewMessage(message, retry = false) {
    nodes.previewEmpty.classList.remove("hidden");
    nodes.previewEmpty.innerHTML = `<div class="empty-content">${icon("frame")}<strong>${escapeHtml(message)}</strong><div class="empty-actions">${retry ? '<button type="button" class="button" data-retry-preview>重新加载</button>' : ""}<a class="button button-primary" href="${escapeHtml(designUrl())}">编辑设计</a></div></div>`;
  }
  function getPreviewItems() {
    return [...(state.entry?.design?.pages || []).filter(page=>page.status!=='planned').map((page) => ({ ...page, path: `design:${page.id}`, type: "design", updatedAt: state.entry.design.updatedAt })), ...(state.entry?.prototypes || [])];
  }
  function previewNavigationConfig() {
    return {origin:location.origin,entryPath:state.selectedPath,pages:(state.entry?.design?.pages||[]).map(({id,source})=>({id,source})),sources:(state.entry?.prototypes||[]).map(item=>item.path)};
  }
  window.addEventListener('message',event=>{
    const message=event.data;
    if(state.activeView!=='preview'||event.source!==nodes.previewFrame.contentWindow||!state.previewBridgeToken||message?.channel!=='prototype-navigation-v1'||message.token!==state.previewBridgeToken)return;
    const target=resolvePreviewTarget(message.href,previewNavigationConfig());if(!target)return;
    state.selectedPrototypePath=`design:${target.id}`;state.previewQuery=target.query;setHash();renderPrototypeList();
  });
  function savedPageHtml(page) {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    doc.querySelectorAll("base,meta[http-equiv='refresh' i]").forEach((node) => node.remove());
    const base = doc.createElement("base");
    const root = page.source?.startsWith(`${state.selectedPath}/`) ? page.source.slice(0, page.source.lastIndexOf("/") + 1) : `${state.selectedPath}/原型设计/`;
    base.href = `${location.origin}/preview/${root.split("/").map(encodeURIComponent).join("/")}`;
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none';";
    doc.head.prepend(base); doc.head.prepend(policy);
    state.previewBridgeToken=crypto.randomUUID();
    const navigation=doc.createElement('script');
    navigation.textContent=previewBridgeScript(previewNavigationConfig(),state.previewQuery,state.previewBridgeToken);
    base.after(navigation);
    if (page.route && page.route.startsWith("#")) {
      const route = doc.createElement("script");
      route.textContent = `location.hash=${JSON.stringify(page.route).replace(/</g, "\\u003c")};`;
      base.after(route);
    }
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  }
  async function renderPreviewState(current) {
    resetPreview();
    const token = state.previewRequestToken, entryPath = state.selectedPath;
    if (!current) {
      nodes.previewLabel.textContent = "选择页面预览";
      return previewMessage(state.entry ? "还没有设计页面" : "先选择一个需求");
    }
    nodes.previewLabel.textContent = current.type === "design" ? `${current.name} · ${current.width} × ${current.height}` : `${current.name} · ${current.type === "image" ? "图片" : "HTML 原型"}`;
    nodes.previewLabel.title = current.path;
    nodes.previewEmpty.classList.remove("hidden"); nodes.previewEmpty.textContent = "正在加载预览…";
    if (current.type === "design") {
      try {
        const payload = await fetchJson(`/api/design/page?path=${encodeURIComponent(entryPath)}&id=${encodeURIComponent(current.id)}`);
        if (token !== state.previewRequestToken || entryPath !== state.selectedPath || state.activeView !== "preview") return;
        const page = payload.page;
        if (!page || typeof page.html !== "string") throw new Error("画板内容不可用");
        nodes.previewStage.classList.add("saved-design-preview");
        nodes.previewFrame.style.width = `${page.width}px`; nodes.previewFrame.style.height = `${page.height}px`;
        nodes.previewFrame.srcdoc = savedPageHtml(page);
        nodes.previewFrame.classList.remove("hidden"); nodes.previewEmpty.classList.add("hidden");
        nodes.editPreviewLink.href = designUrl(current.id); nodes.editPreviewLink.classList.remove("hidden");
        nodes.annotationPreviewLink.href = `${designUrl(current.id)}&notes=1`; nodes.annotationPreviewLink.classList.remove("hidden");
        nodes.openPreviewLink.href = designUrl(current.id); setLinkEnabled(nodes.openPreviewLink, true);
        controlHint(nodes.openPreviewLink, "在新窗口编辑设计");
        nodes.openPreviewLink.setAttribute("aria-label", "在新窗口编辑设计");
      } catch (error) {
        if (token === state.previewRequestToken && entryPath === state.selectedPath) previewMessage(error.message || "画板加载失败", true);
      }
      return;
    }
    nodes.openPreviewLink.href = current.previewUrl; setLinkEnabled(nodes.openPreviewLink, true);
    controlHint(nodes.openPreviewLink, "新窗口打开源文件");
    nodes.openPreviewLink.setAttribute("aria-label", "新窗口打开源文件");
    if (current.type !== "image") {
      try {
        const response = await fetch(current.previewUrl, { method: "HEAD" });
        if (token !== state.previewRequestToken || entryPath !== state.selectedPath) return;
        if (!response.ok) throw new Error(`预览文件不可用（${response.status}）`);
      } catch (error) {
        if (token === state.previewRequestToken && entryPath === state.selectedPath) {
          setLinkEnabled(nodes.openPreviewLink, false);
          previewMessage(error.message || "预览文件加载失败", true);
        }
        return;
      }
    }
    const element = current.type === "image" ? nodes.previewImage : nodes.previewFrame;
    element.onload = () => { if (token === state.previewRequestToken && entryPath === state.selectedPath) nodes.previewEmpty.classList.add("hidden"); };
    element.onerror = () => { if (token === state.previewRequestToken && entryPath === state.selectedPath) { element.classList.add("hidden"); previewMessage("预览文件加载失败", true); } };
    if (current.type === "image") element.alt = current.name;
    element.classList.remove("hidden"); element.src = current.previewUrl;
  }
  function renderPrototypeList() {
    const items = getPreviewItems(), saved = items.filter((item) => item.type === "design"), source = items.filter((item) => item.type !== "design");
    nodes.designSummary.textContent = `${saved.length} 个已保存画板 · ${source.length} 份源文件`;
    if (items.length && !items.some((item) => item.path === state.selectedPrototypePath)) { state.selectedPrototypePath = items[0].path; setHash(true); }
    if (!items.length) state.selectedPrototypePath = "";
    const group = (label, groupItems) => `<div class="asset-group"><h3>${label}<span>${groupItems.length}</span></h3>${groupItems.length ? groupItems.map((item) => `<button type="button" class="prototype-button${item.path === state.selectedPrototypePath ? " active" : ""}" data-prototype-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}"${item.path === state.selectedPrototypePath ? ' aria-current="true"' : ""}>${icon(item.type === "image" ? "image" : "frame")}<span><strong>${escapeHtml(item.name)}</strong><small>${item.type === "design" ? `${item.width} × ${item.height}` : item.type === "image" ? "图片参考" : "HTML 原型"}</small></span></button>`).join("") : `<p class="asset-group-empty">${label === "已保存画板" ? '还没有画板 <a href="' + escapeHtml(designUrl()) + '">编辑设计</a>' : "暂无源原型"}</p>`}</div>`;
    nodes.prototypeList.innerHTML = group("已保存画板", saved) + group("源原型与图片", source);
    renderDesignLinks();
    void renderPreviewState(items.find((item) => item.path === state.selectedPrototypePath) || null);
  }
  function resetFlowWorkspace(clearData = true) {
    state.flowRequestToken += 1;
    state.flowPreviewToken += 1;
    nodes.flowFrame.onload = null; nodes.flowFrame.onerror = null;
    nodes.flowFrame.classList.add("hidden"); nodes.flowFrame.src = "about:blank";
    nodes.flowEmpty.classList.remove("hidden");
    nodes.openSourceFlowLink.classList.add("hidden");
    if (clearData) { state.flowData = null; state.flowCatalog = []; state.flowCatalogError = ""; }
  }
  function flowActions() {
    if (state.flowData?.canEdit === false) return `<a class="button" href="${escapeHtml(flowUrl())}">打开流程工作台</a>`;
    return `<a class="button button-primary" href="${escapeHtml(flowUrl({ action: "new", flowId: "" }))}">新建流程</a><a class="button" href="${escapeHtml(flowUrl({ action: "link", flowId: "" }))}">关联已有</a><a class="button" href="${escapeHtml(flowUrl({ action: "not-needed", flowId: "" }))}">本需求无需流程图</a>`;
  }
  function renderFlowEmpty(message, retry = false) {
    nodes.flowFrame.classList.add("hidden");
    nodes.flowEmpty.classList.remove("hidden");
    nodes.flowEmpty.innerHTML = `<div class="empty-content">${icon("flow")}<strong>${escapeHtml(message)}</strong><div class="empty-actions">${retry ? '<button class="button" data-retry-flows type="button">重新加载</button>' : ""}${state.entry ? flowActions() : '<button class="button" data-retry-tree type="button">刷新需求目录</button>'}</div></div>`;
  }
  function getFlowItems() {
    const workspace = state.flowData?.workspace;
    if (!workspace) return [];
    const owned = (workspace.flows || []).map((flow) => ({ ...flow, entryPath: state.selectedPath, feature: state.entry?.feature || "", owned: true, available: true }));
    const references = (workspace.references || []).map((reference) => {
      const flow = state.flowCatalog.find((item) => item.entryPath === reference.entryPath && item.id === reference.flowId);
      return flow ? { ...flow, owned: false, available: true } : { id: reference.flowId, entryPath: reference.entryPath, feature: findEntryInTree(reference.entryPath)?.feature || "来源需求", name: "关联流程图", owned: false, available: false };
    });
    return [...owned, ...references];
  }
  async function renderFlowSelection() {
    const previewToken = ++state.flowPreviewToken;
    nodes.flowFrame.onload = null; nodes.flowFrame.onerror = null;
    nodes.flowFrame.classList.add("hidden"); nodes.flowFrame.src = "about:blank";
    nodes.openSourceFlowLink.classList.add("hidden");
    const item = getFlowItems().find((flow) => flow.id === state.selectedFlowId && flow.entryPath === (state.selectedFlowSource || state.selectedPath));
    nodes.flowTitle.textContent = item?.name || "流程图";
    nodes.flowSourceLabel.textContent = item ? item.owned ? "本需求" : `关联自 ${item.feature}` : "可选资料";
    nodes.flowSourceLabel.title = item?.entryPath || "";
    renderDesignLinks();
    if (!item) return renderFlowEmpty(state.flowData?.workspace?.applicability === "not-needed" ? "本需求无需流程图" : "还没有流程图");
    if (!item.available) return renderFlowEmpty(state.flowCatalogError ? "关联流程暂未加载" : "关联流程已不可用，请检查来源", true);
    if (!item.owned) {
      nodes.openSourceFlowLink.href = flowUrl({ source: item.entryPath, flowId: item.id });
      nodes.openSourceFlowLink.classList.remove("hidden");
    }
    nodes.flowEmpty.classList.remove("hidden"); nodes.flowEmpty.textContent = "正在加载流程预览…";
    const expectedPath = state.selectedPath, expectedId = item.id, expectedSource = item.entryPath;
    const isCurrent = () => previewToken === state.flowPreviewToken && state.activeView === "flow" && expectedPath === state.selectedPath && expectedId === state.selectedFlowId && expectedSource === state.selectedFlowSource;
    const previewUrl = flowUrl({ source: item.entryPath, flowId: item.id, embed: true });
    try {
      const response = await fetch(previewUrl, { method: "HEAD" });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(`流程预览不可用（${response.status}）`);
    } catch (error) { if (isCurrent()) renderFlowEmpty(error.message || "流程预览加载失败", true); return; }
    nodes.flowFrame.onload = () => { if (isCurrent()) nodes.flowEmpty.classList.add("hidden"); };
    nodes.flowFrame.onerror = () => { if (isCurrent()) renderFlowEmpty("流程预览加载失败", true); };
    nodes.flowFrame.src = previewUrl;
    nodes.flowFrame.classList.remove("hidden");
  }
  function renderFlowList() {
    const workspace = state.flowData?.workspace, items = getFlowItems();
    const own = items.filter((item) => item.owned), references = items.filter((item) => !item.owned);
    if (!items.some((item) => item.id === state.selectedFlowId && item.entryPath === (state.selectedFlowSource || state.selectedPath))) {
      state.selectedFlowId = items[0]?.id || ""; state.selectedFlowSource = items[0]?.entryPath || state.selectedPath; setHash(true);
    }
    nodes.flowSummary.textContent = `${own.length} 张本需求图 · ${references.length} 张关联图`;
    const group = (label, flows) => `<div class="asset-group"><h3>${label}<span>${flows.length}</span></h3>${flows.length ? flows.map((flow) => `<button class="prototype-button${flow.id === state.selectedFlowId && flow.entryPath === state.selectedFlowSource ? " active" : ""}" type="button" data-flow-id="${escapeHtml(flow.id)}" data-flow-source="${escapeHtml(flow.entryPath)}" title="${escapeHtml(`${flow.name} · ${flow.entryPath}`)}">${icon("flow")}<span><strong>${escapeHtml(flow.name)}</strong><small>${escapeHtml(!flow.available ? "暂不可用" : !flow.owned ? flow.feature : flow.parent ? "子流程" : "本需求流程")}</small></span></button>`).join("") : `<p class="asset-group-empty">${label === "本需求流程" ? "暂无流程图" : "暂无关联"}</p>`}</div>`;
    nodes.flowList.innerHTML = group("本需求流程", own) + group("关联流程", references);
    nodes.newFlowLink.classList.toggle("hidden", state.flowData?.canEdit === false);
    nodes.linkFlowLink.classList.toggle("hidden", state.flowData?.canEdit === false);
    nodes.flowApplicability.classList.toggle("hidden", workspace?.applicability !== "not-needed");
    nodes.flowApplicability.textContent = workspace?.applicability === "not-needed" ? `本需求无需流程图${workspace.reason ? ` · ${workspace.reason}` : ""}` : "";
    nodes.flowCatalogNotice.classList.toggle("hidden", !state.flowCatalogError);
    nodes.flowCatalogNotice.innerHTML = state.flowCatalogError ? '关联目录暂未加载 <button class="text-button" data-retry-flows type="button">重试</button>' : "";
    void renderFlowSelection();
  }
  async function loadFlows() {
    resetFlowWorkspace();
    const token = state.flowRequestToken, entryPath = state.selectedPath;
    nodes.flowSummary.textContent = "加载中"; nodes.flowList.innerHTML = '<p class="empty-state small-empty">正在加载流程…</p>';
    nodes.flowTitle.textContent = "流程图"; nodes.flowSourceLabel.textContent = "可选资料";
    nodes.flowApplicability.classList.add("hidden"); nodes.flowCatalogNotice.classList.add("hidden");
    nodes.flowEmpty.textContent = "正在读取流程资料…";
    if (!state.entry) return renderFlowEmpty("先选择一个需求");
    const results = await Promise.allSettled([fetchJson(`/api/flows?path=${encodeURIComponent(entryPath)}`), fetchJson("/api/flows/catalog")]);
    if (token !== state.flowRequestToken || entryPath !== state.selectedPath || state.activeView !== "flow") return;
    const [local, catalog] = results;
    if (local.status !== "fulfilled" || !local.value.workspace) {
      nodes.flowSummary.textContent = "加载失败"; nodes.flowList.innerHTML = '<p class="empty-state small-empty">流程资料暂不可用</p>';
      return renderFlowEmpty(local.reason?.message || "流程资料加载失败", true);
    }
    state.flowData = local.value;
    state.flowCatalog = catalog.status === "fulfilled" && Array.isArray(catalog.value.flows) ? catalog.value.flows : [];
    state.flowCatalogError = catalog.status === "rejected" ? catalog.reason?.message || "目录加载失败" : "";
    const workspace = local.value.workspace;
    state.entry.flow = { revision: workspace.revision, updatedAt: workspace.updatedAt, applicability: workspace.applicability, ownedCount: workspace.flows?.length || 0, referenceCount: workspace.references?.length || 0 };
    renderContentControls(); renderFlowList();
  }
  async function selectStage(stage) {
    if (!state.entry || !await canNavigate()) return;
    const intent=state.navigationIntent;state.routeLocked=true;
    try {
      state.docRequestToken++;state.editorOptions={};nodes.workspaceNotice.classList.add('hidden');
      if(stage==='test'){state.activeView='test';setHash();renderContentControls();renderTabs();await testUI.show(state.selectedPath);return;}
      if(['flow','design','preview'].includes(stage)) {
        if(stage==='preview' && state.activeView==='design')state.designReturn={path:state.selectedPath,prototype:state.selectedPrototypePath};
        if(stage==='design' && state.activeView==='preview' && state.designReturn?.path===state.selectedPath)state.selectedPrototypePath=state.designReturn.prototype;
        state.activeView=stage; await refreshEntrySummary();
        if(intent!==state.navigationIntent)return;
        setHash();renderContentControls();renderTabs();
        if(stage==='preview') renderPrototypeList();else await showEditor();return;
      }
      state.activeView='doc';if(state.docKey!==stage)state.file='';state.docKey=stage;state.heading='';
      setHash();await loadCurrentDocument();
    } finally {if(intent===state.navigationIntent)state.routeLocked=false;}
  }
  async function clearCurrentEntry(message = "当前没有未归档的需求") {
    if(!await canNavigate()) return; workspaceHost.clearExcept("");
    state.entryRequestToken += 1; state.docRequestToken += 1; resetPreview(); resetFlowWorkspace();
    state.selectedPath = ""; state.selectedPrototypePath = ""; state.entry = null; state.file = ""; state.heading = "";
    state.selectedFlowId = ""; state.selectedFlowSource = "";
    setHash(true); renderTree(); renderContentControls(); renderTabs(); renderDocEmpty(message); renderPrototypeList();
    nodes.flowList.innerHTML = ""; nodes.flowSummary.textContent = ""; renderFlowEmpty("先选择一个需求");
  }
  async function openEntry(relativePath, { fromHash = false, replace = false, guarded = false } = {}) {
    if(!guarded && !await canNavigate()) return;
    workspaceHost.clearExcept(relativePath);
    const token = ++state.entryRequestToken; state.routeLocked=true;
    state.docRequestToken += 1; resetPreview(); resetFlowWorkspace();
    if (!fromHash && relativePath !== state.selectedPath) { state.file = ""; state.heading = ""; state.selectedPrototypePath = ""; state.selectedFlowId = ""; state.selectedFlowSource = relativePath; }
    state.selectedPath = relativePath; state.entry = findEntryInTree(relativePath);
    if (state.archivedPaths.has(relativePath)) state.showArchived = true;
    if (state.entry?.module) state.collapsedModules.delete(state.entry.module);
    normalizeDocument(); renderTree(); renderContentControls(); renderTabs();
    nodes.treeContainer.querySelector('.menu-item.active')?.scrollIntoView({block:'nearest',behavior:'instant'});
    setLinkEnabled(nodes.downloadDocLink, false);
    nodes.docOutline.className = "doc-outline empty-state"; nodes.docOutline.textContent = "正在准备文档…";
    nodes.docContent.className = "markdown-body loading-state"; nodes.docContent.textContent = "正在加载需求…";
    nodes.previewLabel.textContent = "正在加载需求…"; nodes.previewEmpty.classList.remove("hidden"); nodes.previewEmpty.textContent = "正在加载需求…";
    nodes.prototypeList.innerHTML = '<p class="empty-state">正在加载页面…</p>';
    nodes.flowSummary.textContent = "加载中"; nodes.flowList.innerHTML = '<p class="empty-state small-empty">正在加载流程…</p>'; nodes.flowEmpty.textContent = "正在加载需求…";
    if (!fromHash) setHash(replace);
    try {
      const payload = await fetchJson(`/api/entry?path=${encodeURIComponent(relativePath)}`);
      if (token !== state.entryRequestToken || relativePath !== state.selectedPath) return;
      state.entry = payload.entry; normalizeDocument(); renderContentControls(); renderTabs();
      if(state.activeView==="test")await testUI.show(state.selectedPath); else if (state.activeView === "preview") renderPrototypeList(); else if (["design","flow"].includes(state.activeView)) await showEditor(); else await loadCurrentDocument();
      setHash(true);
    } catch (error) {
      if (token !== state.entryRequestToken || relativePath !== state.selectedPath) return;
      state.entry = null; renderContentControls(); renderDocEmpty(error.message || "需求加载失败", true); previewMessage(error.message || "需求加载失败", true);
      renderFlowEmpty(error.message || "需求加载失败", true);
    } finally {if(token===state.entryRequestToken)state.routeLocked=false;}
  }
  async function loadTree({selectPath = '', throwOnError = false} = {}) {
    const token = ++state.treeRequestToken;
    nodes.createEntryButton.disabled = true;
    nodes.treeContainer.innerHTML = '<div class="empty-state small-empty">正在加载目录…</div>';
    try {
      let tree = await fetchJson("/api/tree");
      const migrationStatus=document.getElementById('archiveSyncStatus');
      migrationStatus.classList.add('hidden');
      if (!tree.accountsEnabled && tree.archiveStorage === 'mysql' && tree.canArchive && state.legacyArchivedPaths?.size) {
        try {
        const result = await writeArchive('/api/entry-state/import', 'POST', {paths:[...state.legacyArchivedPaths]});
        for(const path of [...result.imported,...result.skipped])state.legacyArchivedPaths.delete(path);
        saveNavigationPreferences();
        tree = await fetchJson('/api/tree');
        } catch(error) { migrationStatus.textContent='旧归档同步失败：'+error.message+'。刷新可重试，原记录已保留。'; migrationStatus.classList.remove('hidden'); }
      } else if(tree.archiveStorage==='mysql' && state.legacyArchivedPaths?.size) { migrationStatus.textContent='此浏览器有旧归档待同步，请在本机打开此地址。';migrationStatus.classList.remove('hidden'); }
      if (token !== state.treeRequestToken) return;
      state.tree = tree;
      state.archivedPaths = new Set(tree.modules.flatMap(m=>m.features).filter(e=>e.archiveState?.archived).map(e=>e.path));
      pruneNavigationPreferences(); renderTree();
      nodes.createEntryButton.classList.toggle('hidden', !tree.canCreate);
      if (selectPath && findEntryInTree(selectPath)) await openEntry(selectPath);
      else if (state.selectedPath && findEntryInTree(state.selectedPath)) await openEntry(state.selectedPath, { fromHash: true });
      else { const first = getDefaultEntryPath(); if (first) await openEntry(first, { replace: true }); else await clearCurrentEntry("还没有可展示的需求"); }
    } catch (error) {
      if (token !== state.treeRequestToken) return;
      nodes.treeContainer.innerHTML = `<div class="empty-state small-empty">${escapeHtml(error.message || "目录加载失败")}<button class="button" type="button" data-retry-tree>重新加载</button></div>`;
      renderDocEmpty("目录加载失败，请重试", true);
      if (throwOnError) throw error;
    } finally { if (token === state.treeRequestToken) nodes.createEntryButton.disabled = !state.tree?.canCreate; }
  }
  function bindEvents() {
    nodes.toggleDesignNavigation.addEventListener('click',()=>{if(state.activeView==='design')state.designNavigation=!state.designNavigation;else state.navigationHidden=!state.navigationHidden;saveNavigationPreferences();renderLayoutPreferences();});
    nodes.searchInput.addEventListener("input", () => updateTreeFilter(nodes.searchInput.value));
    new ResizeObserver(updateTreeTitleHints).observe(nodes.treeContainer);
    nodes.searchInput.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='Escape' && state.filterText){event.preventDefault();nodes.searchInput.value='';updateTreeFilter('');}
      if(event.key==='ArrowDown'){
        const first=nodes.treeContainer.querySelector('[data-module-name]');
        if(first){event.preventDefault();first.focus();}
      }
    });
    nodes.treeContainer.addEventListener('keydown',event=>{
      if(event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
      const button=event.target.closest('button'), section=button?.closest('.menu-section');
      if(!section)return;
      const heading=section.querySelector('[data-module-name]');
      const current=button.matches('[data-archive-path]') ? button.parentElement.querySelector('[data-entry-path]') : button;
      const rows=[...nodes.treeContainer.querySelectorAll('[data-module-name],[data-entry-path]')].filter(node=>!node.closest('.hidden'));
      const index=rows.indexOf(current);let next;
      if(event.key==='ArrowDown')next=rows[Math.min(rows.length-1,index+1)];
      else if(event.key==='ArrowUp')next=rows[Math.max(0,index-1)];
      else if(event.key==='Home')next=rows[0];
      else if(event.key==='End')next=rows.at(-1);
      else if(event.key==='ArrowLeft'){
        if(current!==heading)next=heading;
        else if(heading.getAttribute('aria-expanded')==='true')toggleModule(heading.dataset.moduleName);
      }else if(event.key==='ArrowRight' && current===heading){
        if(heading.getAttribute('aria-expanded')==='false')toggleModule(heading.dataset.moduleName);
        else next=section.querySelector('[data-entry-path]');
      }else return;
      event.preventDefault();
      if(next){next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});}
    });
    nodes.toggleOutlineButton.addEventListener("click", () => { state.outlineHidden = !state.outlineHidden; saveNavigationPreferences(); renderLayoutPreferences(); });
    nodes.toggleArchivedButton.addEventListener("click", async () => {
      state.showArchived = !state.showArchived; renderTree();
      if (!state.showArchived && state.archivedPaths.has(state.selectedPath)) { const next = getDefaultEntryPath(); if (next) await openEntry(next); else await clearCurrentEntry(); }
    });
    nodes.documentSelect.addEventListener("change", async () => {
      const nextFile=nodes.documentSelect.value;
      if(!await canNavigate()){nodes.documentSelect.value=getCurrentDocFile();return;}
      const item = getDocuments().find((doc) => doc.file === nodes.documentSelect.value);
      if (!item) return;
      state.docKey = item.key === "other" ? state.docKey : item.key; state.file = item.file; state.heading = ""; state.activeView = "doc";state.editorOptions={};
      setHash(); await loadCurrentDocument();
    });
    document.addEventListener("click", async (event) => {
      if (event.target.closest(".skip-link")) {
        event.preventDefault();
        const target = ["design","flow"].includes(state.activeView) ? nodes.editorFrames.querySelector("iframe:not(.hidden)") : state.activeView === "preview" ? nodes.previewStage : nodes.docContent;
        target.focus(); return;
      }
      const workspaceAnchor=event.target.closest('a[href]');
      if(workspaceAnchor && !workspaceAnchor.hasAttribute('download') && workspaceAnchor.target!=='_blank' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        const hash=workspaceHashFromUrl(workspaceAnchor.href);
        if(hash!==null) {event.preventDefault();await navigateHash(hash);return;}
      }
      const localAnchor = event.target.closest("a[href^='#']");
      if (localAnchor && nodes.docContent.contains(localAnchor)) {
        const href = localAnchor.getAttribute("href");
        if (href && !href.includes("path=")) {
          event.preventDefault();
          try { state.heading = decodeURIComponent(href.slice(1)); } catch { state.heading = href.slice(1); }
          setHash(); scrollToHeading(state.heading); return;
        }
      }
      const button = event.target.closest("button");
      if (!button) return;
      if(button.hasAttribute('data-write-document')){button.disabled=true;try{const names={spec:'规格索引',requirement:'需求文档',contract:'接口契约'};await createDocument(state.selectedPath+'/'+names[state.docKey]+'.md',names[state.docKey])}catch(e){button.disabled=false;nodes.docStatus.textContent=e.message}return;}
      if(button.dataset.designMode) {await selectStage(button.dataset.designMode);return;}
      if (button.dataset.entryPath) await openEntry(button.dataset.entryPath);
      else if (button.dataset.moduleName) {
        toggleModule(button.dataset.moduleName);
      } else if (button.dataset.archivePath) {
        const path = button.dataset.archivePath, archived = state.archivedPaths.has(path);
        if (!state.tree?.canArchive) return;
        button.disabled=true;
        try {
          const entry=findEntryInTree(path);
          entry.archiveState=await writeArchive('/api/entry-state?'+new URLSearchParams({path}), 'PUT', {expectedRevision:entry.archiveState?.revision||0,archived:!archived});
          if (archived) state.archivedPaths.delete(path); else state.archivedPaths.add(path);
          renderTree();
        } catch(error) { button.disabled=false; window.alert(error.message); return; }
        if (!archived && !state.showArchived && path === state.selectedPath) { const next = getDefaultEntryPath(); if (next) await openEntry(next); else await clearCurrentEntry(); }
      } else if (button.dataset.stage) await selectStage(button.dataset.stage);
      else if (button.dataset.flowId) { state.selectedFlowId = button.dataset.flowId; state.selectedFlowSource = button.dataset.flowSource || state.selectedPath; setHash(); renderFlowList(); }
      else if (button.dataset.prototypePath) { state.previewQuery=''; state.selectedPrototypePath = button.dataset.prototypePath; setHash(); renderPrototypeList(); }
      else if (button.dataset.headingId) {
        state.heading = button.dataset.headingId; setHash(); scrollToHeading(state.heading);
      } else if (button.hasAttribute("data-retry-tree")) await loadTree();
      else if (button.hasAttribute("data-retry-document")) { if (state.entry) await loadCurrentDocument(); else if (state.selectedPath) await openEntry(state.selectedPath, { fromHash: true }); else await loadTree(); }
      else if (button.hasAttribute("data-retry-preview")) { if (state.entry) renderPrototypeList(); else if (state.selectedPath) await openEntry(state.selectedPath, { fromHash: true }); }
      else if (button.hasAttribute("data-retry-flows")) { if (state.entry) await loadFlows(); else if (state.selectedPath) await openEntry(state.selectedPath, { fromHash: true }); else await loadTree(); }
      else if (button.hasAttribute("data-clear-search")) { nodes.searchInput.value = ""; updateTreeFilter(''); nodes.searchInput.focus(); }
      else if (button.hasAttribute("data-show-archived")) { state.showArchived = true; renderTree(); }
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); nodes.searchInput.focus(); nodes.searchInput.select(); }
    });
    const navigate = async () => {
      const requested=location.hash.slice(1);
      if(!await canNavigate()) {history.replaceState(null,'',`/#${state.routeSnapshot}`);return;}
      history.replaceState(null,'',`/#${requested}`);loadHash();renderTree();
      await openEntry(state.selectedPath||getDefaultEntryPath(),{fromHash:true,guarded:true});
    };
    // Hash changes cover links and browser history; pushState actions render explicitly.
    window.addEventListener("hashchange", navigate);
    window.addEventListener("beforeunload",event=>{if(workspaceHost.isDirty()||documentEditor.isDirty()){event.preventDefault();event.returnValue="";}});
  }
  async function bootstrap() {
    loadNavigationPreferences(); loadHash(); bindEvents(); renderContentControls(); renderTabs(); await loadTree();
  }
  void bootstrap().catch(error => {
    console.error('需求平台初始化失败', error);
    nodes.workspaceNotice.textContent = '工作台打开失败：' + (error.message || '请刷新重试');
    nodes.workspaceNotice.classList.remove('hidden');
    statusIndicator(nodes.workspaceSaveState, 'help', '打开失败', error.message || '请刷新重试');
  });
  mountAccount({flush:canNavigate}).catch(console.error);
})();

iconButtons(document, [
  ["openDesignLink", "edit", "编辑设计"],
  ["annotationPreviewLink", "link", "元素关联"],
  ["editPreviewLink", "edit", "编辑此页面"],
  ["downloadDocLink", "download", "下载当前文档"],
  ["openPreviewLink", "external", "新窗口打开预览"],
  ["newFlowLink", "plus", "新建流程"],
  ["linkFlowLink", "link", "关联已有流程"],
  ["openFlowLink", "edit", "编辑流程"],
  ["openSourceFlowLink", "external", "打开来源流程"]
]);
iconButton(document.querySelector('[data-design-mode="design"]'), 'grid', '画布');
iconButton(document.querySelector('[data-design-mode="preview"]'), 'play', '预览');
