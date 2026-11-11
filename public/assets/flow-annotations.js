import { iconButton, iconButtons } from "./workbench-icons.js";
import { createAnnotationAutosave, annotationKey } from "./page-annotations.js";
const clone = (value) => JSON.parse(JSON.stringify(value));
const encode = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const isFlowTarget = (target) => target?.type === "flow-node" || target?.type === "flow-edge";
const targetKey = (target) => JSON.stringify([target?.type, target?.flowId, target?.nodeId || target?.edgeId]);
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => { const n = Math.random() * 16 | 0; return (char === "x" ? n : (n & 3 | 8)).toString(16); });

export function createFlowAnnotations(host) {
  const state = { open: false, path: "", workspace: { revision: 0, notes: [] }, canEdit: false, loading: false, composing: false, token: 0, selectedId: "", editor: null, guardBusy: false, viewer: null };
  const panel = document.createElement("aside"); panel.id = "elementNotesPanel"; panel.className = "element-notes-panel"; panel.hidden = true; panel.setAttribute("aria-label", "元素说明");
  panel.innerHTML = `<header class="notes-panel-heading"><strong>元素说明</strong><button id="notesClose" class="icon-button" type="button" aria-label="关闭元素说明">×</button></header><div class="notes-source"><span id="notesSource"></span><a id="notesSourceLink" hidden>回来源编辑</a></div><div class="notes-actions"><span id="notesSaveState" role="status"></span><button id="notesSave" class="primary" type="button" hidden>重试保存</button></div><div id="notesError" class="notes-error" role="alert" hidden></div><div id="notesRecovery" class="notes-recovery" hidden><button id="notesExportDraft" type="button">导出草稿</button><button id="notesReload" type="button">重新读取</button></div><div class="notes-target"><span id="notesSelection"></span><button id="notesAdd" type="button">添加说明</button><small id="notesTargetHint"></small></div><div id="notesList" class="notes-list" aria-label="当前流程元素说明"></div><div id="notesDetail" class="notes-detail" hidden><div class="notes-detail-heading"><strong id="notesDetailTarget"></strong><button id="notesLocate" class="text-button" type="button">定位</button></div><p id="notesDetached" class="notes-detached" hidden></p><div id="notesText" class="notes-text"></div><div class="notes-detail-actions"><button id="notesEdit" type="button">编辑正文</button><button id="notesRebind" type="button">关联当前元素</button><button id="notesDelete" class="danger" type="button">删除说明</button></div></div>`;
  document.body.append(panel);
  const inline = document.createElement("section"); inline.id = "selectionNotes"; inline.className = "selection-notes"; inline.setAttribute("aria-label", "所选元素说明");
  document.getElementById("nodeFields").before(inline);
  const editor = document.createElement("dialog"); editor.id = "elementNoteEditor"; editor.className = "element-note-editor"; editor.setAttribute("aria-labelledby", "elementNoteEditorTitle");
  editor.innerHTML = `<form id="elementNoteForm"><div class="dialog-heading"><h2 id="elementNoteEditorTitle">添加元素说明</h2><button id="noteEditorClose" type="button" class="icon-button" aria-label="完成编辑">×</button></div><p id="noteEditorTarget" class="muted"></p><label for="elementNoteText">说明正文</label><textarea id="elementNoteText" rows="12" maxlength="8000" placeholder="记录这个节点或连线的规则、条件和边界。"></textarea><div class="note-editor-meta"><span id="noteEditorCount">0 / 8000</span><span id="noteEditorSaveState" role="status">更改自动保存</span></div><p id="noteEditorError" class="form-error" role="alert" hidden></p><div class="dialog-actions"><button id="noteEditorCancel" type="button" hidden>取消新建</button><button id="noteEditorRetry" type="button" hidden>重试保存</button><button id="noteEditorApply" type="submit" class="primary">完成</button></div></form>`;
  document.body.append(editor);
  const viewer = document.createElement("dialog"); viewer.id = "elementNoteViewer"; viewer.className = "element-note-viewer"; viewer.setAttribute("aria-labelledby", "elementNoteViewerTitle");
  viewer.innerHTML = `<div class="dialog-heading"><h2 id="elementNoteViewerTitle">元素说明</h2><button id="noteViewerClose" type="button" class="icon-button" aria-label="关闭说明">×</button></div><p id="noteViewerTarget" class="muted"></p><div id="noteViewerText" class="note-viewer-text" tabindex="0" aria-label="说明全文"></div><div class="dialog-actions"><button id="noteViewerEdit" type="button">编辑</button><button id="noteViewerDone" class="primary" type="button">关闭</button></div>`;
  document.body.append(viewer);
  iconButton(viewer.querySelector('#noteViewerClose'), 'close', '关闭说明');
  let viewerOrigin = null, viewerEditing = false, previewFrame = null;

  iconButtons(panel, [["notesClose", "close", "关闭元素说明"], ["notesAdd", "plus", "添加说明"], ["notesLocate", "target", "定位元素"], ["notesEdit", "edit", "编辑正文"], ["notesRebind", "link", "关联当前元素"], ["notesDelete", "trash", "删除说明"]]);
  iconButton(editor.querySelector('#noteEditorClose'), 'close', '关闭编辑器');
  const confirm = document.createElement("dialog"); confirm.id = "elementNoteConfirm"; confirm.className = "element-note-confirm"; confirm.setAttribute("aria-labelledby", "noteConfirmTitle");
  confirm.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2 id="noteConfirmTitle"></h2></div><p id="noteConfirmText"></p><div class="dialog-actions"><button value="cancel">取消</button><button id="noteConfirmDiscard" value="discard" hidden>保留说明</button><button id="noteConfirmAccept" value="confirm" class="primary">继续</button></div></form>`;
  document.body.append(confirm);
  const $ = (id) => document.getElementById(id), context = () => host.getContext();
  const canEdit = () => state.canEdit && context().editableSource && !state.loading;
  const canBind = () => canEdit() && !!context().selection && (context().bindable || typeof context().flushFlow === "function");
  const note = () => state.workspace.notes.find((item) => item.id === state.selectedId);
  const editorRequirements = () => state.editor?.requirements || state.workspace.notes.find((n) => n.id === state.editor?.id)?.requirements || [];
  const editorHasContent = () => !!$("elementNoteText").value.trim() || editorRequirements().length > 0;
  const editorDirty = () => { if (!state.editor) return false; const current = state.workspace.notes.find((n) => n.id === state.editor.id); return !current || !editorHasContent() || annotationKey([{ id: state.editor.id, target: state.editor.target, text: $("elementNoteText").value.trim(), requirements: editorRequirements() }]) !== annotationKey([current]); };
  const dirty = () => state.composing || autosave.changed() || editorDirty();
  const cacheKey = () => `requirements:annotation-draft:flow:${state.path}:${context().flowId || ""}`;
  function persist() { if (!state.path || !context().editableSource) return; try { if (!dirty()) sessionStorage.removeItem(cacheKey()); else sessionStorage.setItem(cacheKey(), JSON.stringify({ workspace: state.workspace, baseline: autosave.baseline(), editor: state.editor, text: state.editor ? $("elementNoteText").value : "", selectedId: state.selectedId, flowId: context().flowId })); } catch {} }
  function getStatus() { const save = autosave.getStatus(), changed = dirty(), status = state.loading ? "loading" : save.error ? "error" : save.saving ? "saving" : changed ? "pending" : state.workspace.revision ? "saved" : "idle"; return { state: status, status, dirty: changed, saving: save.saving, error: save.error, revision: state.workspace.revision }; }
  let lastStatus = "";
  function notify() { const value = getStatus(), key = JSON.stringify(value); if (key === lastStatus) return; lastStatus = key; host.onStatusChange?.(value); window.dispatchEvent(new CustomEvent("workspace-save-state", { detail: value })); }
  const autosave = createAnnotationAutosave({ canSave: () => !state.composing, getWorkspace: () => state.workspace, setWorkspace: (value) => { state.workspace = value; }, request: (expectedRevision, notes) => request("PUT", { expectedRevision, notes }), onChange: () => { persist(); render(); }, onSaved: (received) => { if (state.editor && received.notes.some((n) => n.id === state.editor.id)) state.editor.existing = true; } });
  function targetInfo(target) { const ctx = context(), f = ctx.flows.find((item) => item.id === target.flowId); const item = target.type === "flow-node" ? f?.nodes.find((n) => n.id === target.nodeId) : f?.edges.find((e) => e.id === target.edgeId); return { exists: !!item, label: item ? item.label || "未命名连线" : target.type === "flow-node" ? "原节点已移除" : "原连线已移除", flowName: f?.name || "原流程已移除" }; }
  function visibleNotes() { const ctx = context(); return state.workspace.notes.filter((item) => isFlowTarget(item.target) && (item.target.flowId === ctx.flowId || !ctx.flows.some((f) => f.id === item.target.flowId))); }
  async function request(method = "GET", body) { const path = state.path; const response = await fetch(`/api/annotations?${new URLSearchParams({ path })}`, { method, cache: "no-store", headers: { Accept: "application/json", ...(method === "PUT" ? { "Content-Type": "application/json", "X-Design-Client": "workbench-v1" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) { const error = new Error(result.error || `说明读取失败（${response.status}）`); error.status = response.status; throw error; } return result; }
  function updateMarkers() {
    document.getElementById("elementNoteMarkers")?.remove();
    if (!state.open || state.path !== context().sourcePath || state.loading) return;
    const ctx = context(), layer = document.createElementNS("http://www.w3.org/2000/svg", "g"); layer.id = "elementNoteMarkers"; layer.setAttribute("pointer-events", "none"); layer.setAttribute("aria-hidden", "true");
    const groups = new Map(); for (const item of visibleNotes()) { if (item.target.flowId !== ctx.flowId) continue; const key = targetKey(item.target); if (!groups.has(key)) groups.set(key, { target: item.target, count: 0 }); groups.get(key).count++; }
    layer.innerHTML = [...groups.values()].map(({ target, count }) => { const point = host.markerPoint(target); return point ? `<g class="element-note-marker" transform="translate(${point.x} ${point.y})" pointer-events="none"><circle r="9"/><text text-anchor="middle" dominant-baseline="central">${count}</text></g>` : ""; }).join(""); document.getElementById("graph")?.append(layer);
  }
  function updatePreviewButtons() {
    for (const article of inline.querySelectorAll('.selection-note')) {
      const text = article.querySelector('.selection-note-text'), view = article.querySelector('[data-inline-view]');
      if (text && view && text.clientHeight) view.hidden = text.scrollHeight <= text.clientHeight + 1;
    }
  }
  function renderViewer() {
    if (!state.viewer) return;
    const current = state.viewer.path === state.path && state.workspace.notes.find(item => item.id === state.viewer.id);
    $("noteViewerTarget").textContent = current ? targetInfo(current.target).label : "原说明已移除或当前来源已切换";
    $("noteViewerText").textContent = current?.text || "该说明暂不可用。";
    $("noteViewerEdit").hidden = !current || !canEdit();
  }
  function openViewer(current, origin) {
    if (!current || editor.open) return;
    viewerOrigin = origin || document.activeElement;
    state.viewer = { id: current.id, path: state.path };
    renderViewer();
    if (!viewer.open) viewer.showModal();
    $("noteViewerClose").focus();
  }
  function renderInline() {
    const ctx = context(), save = autosave.getStatus();
    inline.hidden = !ctx.selection;
    if (!ctx.selection) { inline.replaceChildren(); return; }
    const ready = state.path === ctx.sourcePath && !state.loading;
    const items = ready ? visibleNotes().filter(item => targetKey(item.target) === targetKey(ctx.selection)) : [];
    const editing = ctx.inspectorEditing === true && canEdit();
    inline.innerHTML = `<div class="selection-notes-heading"><h3>说明</h3>${editing ? `<button type="button" data-inline-add ${!canBind() || !ready ? "disabled" : ""}>添加说明</button>` : ''}</div>` +
      (!ready ? '<p class="muted">正在读取说明…</p>' : save.error ? `<p class="form-error" role="alert">${encode(save.error)}</p><button type="button" data-inline-reload>重新读取</button>` : '') +
      (ready && !save.error && !items.length ? '<p class="muted">暂无说明</p>' : '') +
      items.map(item => `<article class="selection-note"><div class="selection-note-text">${encode(item.text)}</div><div class="selection-note-actions"><button type="button" class="text-button" data-inline-view="${encode(item.id)}" aria-haspopup="dialog" hidden>查看全文</button>${editing ? `<button type="button" class="text-button" data-inline-edit="${encode(item.id)}">编辑</button>` : ''}</div></article>`).join('');
    if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => { previewFrame = null; updatePreviewButtons(); });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(updatePreviewButtons).observe(inline);
  else window.addEventListener('resize', updatePreviewButtons);
  inline.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.inlineView) { const current = state.workspace.notes.find(item => item.id === button.dataset.inlineView); openViewer(current, button); }
    else if (button.hasAttribute("data-inline-add") && context().inspectorEditing === true) void openEditor();
    else if (button.hasAttribute("data-inline-reload")) { if (!dirty()) void load(false); else void toggle(button); }
    else if (button.dataset.inlineEdit && context().inspectorEditing === true) { const current = state.workspace.notes.find(item => item.id === button.dataset.inlineEdit); if (current) void openEditor(current); }
  });
  $("noteViewerClose").addEventListener("click", () => viewer.close());
  $("noteViewerDone").addEventListener("click", () => viewer.close());
  $("noteViewerEdit").addEventListener("click", () => {
    const current = state.viewer?.path === state.path && state.workspace.notes.find(item => item.id === state.viewer.id);
    if (!current || !canEdit()) return;
    viewerEditing = true; viewer.close(); void openEditor(current);
  });
  viewer.addEventListener("close", () => {
    const id = state.viewer?.id; state.viewer = null;
    if (viewerEditing) { viewerEditing = false; return; }
    const origin = viewerOrigin?.isConnected && viewerOrigin.getClientRects().length ? viewerOrigin : [...inline.querySelectorAll('[data-inline-view]')].find(button => button.dataset.inlineView === id && !button.hidden);
    origin?.focus({ preventScroll: true }); viewerOrigin = null;
  });
  function render() {
    const ctx = context(), save = autosave.getStatus(); panel.hidden = !state.open;
    for (const id of ["annotationsToggle", "annotationsEmbedToggle"]) { const button = $(id); if (button) { button.setAttribute("aria-pressed", String(state.open)); button.classList.toggle("active", state.open); button.dataset.tooltip = state.open ? "隐藏元素说明" : "显示元素说明"; } }
    notify(); renderInline(); renderViewer();
    $("notesSource").textContent = ctx.sourceName || "流程说明"; $("notesSourceLink").hidden = !ctx.reference; $("notesSourceLink").href = ctx.sourceUrl; $("notesSourceLink").target = ctx.embedded ? "_top" : "_self";
    const label = state.loading ? "加载中…" : state.composing ? "输入完成后自动保存" : save.error ? "自动保存未完成" : save.saving ? "正在自动保存…" : !canEdit() ? "只读" : dirty() ? state.editor && !editorHasContent() ? "正文为空，草稿已保留" : "等待自动保存…" : state.workspace.revision ? "已自动保存" : "更改自动保存";
    $("notesSaveState").textContent = label; $("noteEditorSaveState").textContent = label;
    $("notesSave").hidden = !save.error || !canEdit(); $("notesSave").disabled = save.saving || state.loading; $("notesError").hidden = !save.error; $("notesError").textContent = save.error;
    $("notesRecovery").hidden = !save.error; $("notesExportDraft").hidden = !dirty(); $("notesReload").disabled = save.saving;
    $("notesSelection").textContent = ctx.selection ? targetInfo(ctx.selection).label : "选择节点或连线"; $("notesAdd").disabled = !canBind() || state.workspace.notes.length >= 500;
    $("notesTargetHint").textContent = ctx.reference ? "关联流程的说明在来源需求中编辑。" : ctx.embedded ? "当前为只读预览。" : ctx.flowDirty || (ctx.selection && !ctx.bindable) ? "流程正在自动保存，完成后可关联说明。" : "";
    const items = visibleNotes(); if (!items.some((item) => item.id === state.selectedId)) state.selectedId = "";
    $("notesList").innerHTML = state.loading ? '<p class="notes-empty">正在读取元素说明…</p>' : items.length ? items.map((item) => { const info = targetInfo(item.target); return `<button class="note-list-item${item.id === state.selectedId ? " selected" : ""}" data-note-id="${encode(item.id)}" type="button"><strong>${encode(info.label)}</strong><span>${encode(item.text.slice(0, 64))}</span>${!info.exists ? '<small>关联已失效，正文仍保留</small>' : ""}</button>`; }).join("") : '<p class="notes-empty">当前流程还没有元素说明。</p>';
    const current = note(); $("notesDetail").hidden = !current;
    if (current) { const info = targetInfo(current.target); $("notesDetailTarget").textContent = info.label; $("notesText").textContent = current.text; $("notesDetached").hidden = info.exists; $("notesDetached").textContent = `${info.flowName} · 正文仍保留，可关联到当前选中的元素。`; $("notesLocate").disabled = !info.exists || current.target.flowId !== ctx.flowId; $("notesEdit").disabled = !canEdit(); $("notesDelete").disabled = !canEdit(); $("notesRebind").disabled = !canBind() || targetKey(current.target) === targetKey(ctx.selection); }
    $("elementNoteText").readOnly = !canEdit(); $("noteEditorCancel").hidden = !state.editor || editorHasContent(); $("noteEditorCancel").textContent = state.editor?.existing ? "恢复正文" : "取消新建";
    $("noteEditorRetry").hidden = !save.error; $("noteEditorRetry").disabled = save.saving;
    if (save.error && editor.open) { $("noteEditorError").hidden = false; $("noteEditorError").textContent = save.error; }
    updateMarkers();
  }
  function restoreEditorUI() { if (!state.editor) return; $("elementNoteEditorTitle").textContent = state.editor.existing ? "编辑元素说明" : "添加元素说明"; $("noteEditorTarget").textContent = targetInfo(state.editor.target).label; $("noteEditorCount").textContent = `${$("elementNoteText").value.length} / 8000`; if (!editor.open) editor.showModal(); }
  async function load(restore = true) {
    const token = ++state.token, path = context().sourcePath;
    let resumeDraft = false, cached; if (restore) { try { cached = JSON.parse(sessionStorage.getItem(`requirements:annotation-draft:flow:${path}:${context().flowId || ""}`) || "null"); } catch {} }
    state.path = path; state.loading = true; state.composing = false; state.canEdit = false; state.selectedId = ""; state.editor = null; state.workspace = { revision: 0, notes: [] }; render();
    if (!path) { state.loading = false; render(); return; }
    try { const data = await request(); if (token !== state.token || path !== context().sourcePath) return; if (!data.workspace || !Array.isArray(data.workspace.notes)) throw new Error("元素说明格式不可用"); state.canEdit = data.canEdit === true; autosave.reset(data.workspace); if (cached?.workspace && Array.isArray(cached.workspace.notes) && Array.isArray(cached.baseline) && state.canEdit && context().editableSource) { const stale = cached.workspace.revision !== data.workspace.revision; autosave.reset(cached.workspace, cached.baseline); state.selectedId = cached.selectedId || ""; if (cached.editor && cached.flowId === context().flowId) { state.editor = cached.editor; $("elementNoteText").value = cached.text || ""; restoreEditorUI(); } if (stale) autosave.fail("本地说明草稿对应旧版本，已保留；请重新读取后处理，不能自动覆盖。", 409); else resumeDraft = true; } }
    catch (error) { if (token === state.token) autosave.fail(error.message); }
    finally { if (token === state.token) { state.loading = false; if (resumeDraft && stageEditor()) autosave.mark(); render(); } }
  }
  function sync() { if (state.path !== context().sourcePath) { if (!dirty()) void load(); return; } render(); }
  async function refreshClean() {
    if (!state.path || state.loading || dirty() || autosave.getStatus().saving) return;
    const token = state.token, path = state.path;
    try {
      const data = await request();
      if (token !== state.token || path !== state.path || path !== context().sourcePath || dirty() || autosave.getStatus().saving) return;
      const focus = document.activeElement, start = focus === $("elementNoteText") ? focus.selectionStart : null, end = focus === $("elementNoteText") ? focus.selectionEnd : null;
      const current = state.editor && data.workspace.notes.find((n) => n.id === state.editor.id);
      state.canEdit = data.canEdit === true;
      if (state.editor) { if (current) { state.editor = { id: current.id, target: clone(current.target), requirements: clone(current.requirements || []), existing: true }; $("elementNoteText").value = current.text; } else { state.editor = null; editor.close(); } }
      autosave.reset(data.workspace); render();
      if (focus?.isConnected && !focus.disabled) { focus.focus({ preventScroll: true }); if (start !== null) focus.setSelectionRange?.(start, end); }
    } catch {}
  }
  function ask(title, text, accept = "继续") { $("noteConfirmTitle").textContent = title; $("noteConfirmText").textContent = text; $("noteConfirmAccept").textContent = accept; confirm.returnValue = "cancel"; confirm.showModal(); return new Promise((resolve) => confirm.addEventListener("close", () => resolve(confirm.returnValue), { once: true })); }
  function stageEditor() {
    if (state.composing) return false;
    if (!state.editor) return true;
    const text = $("elementNoteText").value.trim(), requirements = clone(editorRequirements()); if ((!text && !requirements.length) || text.length > 8000) { persist(); return false; }
    if (!canEdit()) return false;
    const next = { id: state.editor.id, target: clone(state.editor.target), text, requirements }, index = state.workspace.notes.findIndex((n) => n.id === next.id);
    if (index < 0) { if (state.workspace.notes.length >= 500) return false; state.workspace.notes.push(next); } else if (annotationKey([state.workspace.notes[index]]) !== annotationKey([next])) state.workspace.notes[index] = { ...state.workspace.notes[index], ...next };
    state.selectedId = next.id; persist(); return true;
  }
  async function flush(retry = false) { if (state.loading) return false; if (state.composing) { $("noteEditorError").textContent = "输入完成后会自动保存，请先完成当前文字输入。"; $("noteEditorError").hidden = false; persist(); return false; } if (!stageEditor()) { $("noteEditorError").textContent = "正文为空，草稿已保留；补充正文后会自动保存。"; $("noteEditorError").hidden = false; persist(); render(); return false; } const ok = await autosave.flush(retry); persist(); return ok && !dirty(); }
  async function ensureBindable() { if (context().bindable) return true; if (typeof context().flushFlow !== "function" || !await context().flushFlow()) return false; return context().bindable; }
  async function closeEditor() { if (!state.editor) { editor.close(); return true; } if (!await flush()) return false; state.editor = null; editor.close(); render(); return true; }
  async function openEditor(existing = null) { if (!canEdit() || (!existing && (!canBind() || !await ensureBindable()))) return; const target = existing?.target || context().selection; state.editor = { id: existing?.id || uuid(), target: clone(target), requirements: clone(existing?.requirements || []), existing: !!existing }; $("elementNoteText").value = existing?.text || ""; $("noteEditorError").hidden = true; restoreEditorUI(); persist(); render(); $("elementNoteText").focus(); }
  async function guard() { if (state.guardBusy) return false; state.guardBusy = true; try { if (!await closeEditor()) return false; return await flush(); } finally { state.guardBusy = false; } }
  async function beforeContextChange(sourcePath, flowId) { if (sourcePath === state.path && flowId === context().flowId) return true; return await guard(); }
  let toggleOrigin = null;
  async function toggle(origin = null) { if (state.open) { if (!await guard()) return; state.open = false; render(); (toggleOrigin?.getClientRects().length ? toggleOrigin : [$("annotationsToggle"), $("annotationsEmbedToggle")].find(el => el?.getClientRects().length))?.focus(); return; } toggleOrigin = origin || document.activeElement; state.open = true; render(); if (state.path !== context().sourcePath || !state.workspace.revision || autosave.getStatus().error) await load(); $("notesClose").focus(); }
  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.noteId) { if (!await flush()) return; state.selectedId = button.dataset.noteId; render(); return; }
    switch (button.id) {
      case "notesClose": await toggle(); break;
      case "notesAdd": await openEditor(); break;
      case "notesEdit": await openEditor(note()); break;
      case "notesSave": await flush(true); break;
      case "notesLocate": if (note()) host.locate(note().target); break;
      case "notesDelete": { if (!canEdit() || !note()) break; const current = note(); if (await ask("删除元素说明", "仅删除说明，节点或连线会保留。", "删除说明") !== "confirm") break; state.workspace.notes = state.workspace.notes.filter((item) => item.id !== current.id); state.selectedId = ""; persist(); autosave.mark(); render(); break; }
      case "notesRebind": if (canBind() && note() && await ensureBindable()) { note().target = clone(context().selection); persist(); autosave.mark(); render(); } break;
      case "notesReload": if (!dirty() || await ask("重新读取元素说明", "重新读取会放弃本机这份未保存说明草稿。", "重新读取") === "confirm") { autosave.clear(); try { sessionStorage.removeItem(cacheKey()); } catch {} await load(false); } break;
      case "notesExportDraft": { const url = URL.createObjectURL(new Blob([JSON.stringify({ entryPath: state.path, ...state.workspace, editor: state.editor, editorText: state.editor ? $("elementNoteText").value : "" }, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "元素说明-草稿.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break; }
    }
  });
  $("elementNoteForm").addEventListener("submit", (event) => { event.preventDefault(); void closeEditor(); });
  $("noteEditorClose").addEventListener("click", () => void closeEditor());
  $("noteEditorRetry").addEventListener("click", () => void flush(true));
  $("noteEditorCancel").addEventListener("click", () => { const stored = state.editor && state.workspace.notes.find((n) => n.id === state.editor.id); if (state.editor?.existing && stored) { $("elementNoteText").value = stored.text; } else { const id = state.editor?.id; state.workspace.notes = state.workspace.notes.filter((n) => n.id !== id); state.editor = null; editor.close(); } persist(); render(); });
  editor.addEventListener("cancel", (event) => { event.preventDefault(); void closeEditor(); });
  function editorInput(event) { if (event?.isComposing) state.composing = true; $("noteEditorCount").textContent = `${$("elementNoteText").value.length} / 8000`; $("noteEditorError").hidden = true; if (stageEditor()) autosave.mark(); else { persist(); render(); } }
  $("elementNoteText").addEventListener("compositionstart", () => { state.composing = true; autosave.clear(); persist(); render(); });
  $("elementNoteText").addEventListener("compositionend", () => { state.composing = false; editorInput(); });
  $("elementNoteText").addEventListener("input", editorInput);
  for (const id of ["annotationsToggle", "annotationsEmbedToggle"]) $(id)?.addEventListener("click", event => void toggle(event.currentTarget));
  document.addEventListener("keydown", (event) => { if (state.open && event.key === "Escape" && !document.querySelector("dialog[open]")) { event.preventDefault(); event.stopImmediatePropagation(); void toggle(); } });
  window.addEventListener("beforeunload", (event) => { persist(); if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("workspace-visible", () => void refreshClean());
  return { sync, renderMarkers: updateMarkers, guard, flush, getStatus, beforeContextChange, isDirty: dirty, isOpen: () => state.open };
}
