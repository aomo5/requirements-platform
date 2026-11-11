import { iconButton, iconButtons } from "./workbench-icons.js";
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = () => crypto.randomUUID?.() || `note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function htmlFingerprint(html) { let h = 2166136261; for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); }

// Runs only in a disposable, sandboxed rendering copy. Never serialized into a saved page.
export function annotationBridge(config) {
  let picking = false, items = [], show = true, active = "", layer = null, highlight = null, scheduled = false, pickingId = "", pendingBinding = null;
  const identities = new Map();
  const send = (type, data = {}) => parent.postMessage({ channel: "element-spec-v1", token: config.token, type, ...data }, "*");
  const label = (el) => {
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
    const associatedLabels = Array.from(el.labels || []).map((item) => item.textContent || "").join(" ").trim();
    return (el.getAttribute("aria-label") || labelledBy || associatedLabels || el.getAttribute("placeholder") || el.getAttribute("alt") || el.textContent || el.getAttribute("name") || el.tagName.toLowerCase()).replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const legacyFieldLabel = (anchor) => ["input", "select", "textarea"].includes(anchor.tag) && anchor.label === anchor.tag;
  function target(el) { if (!(el instanceof Element)) return null; const item = el.closest("button,a,input,select,textarea,[role=button]") || el; return /^(html|body|script|style|head|meta|link)$/i.test(item.tagName) || layer?.contains(item) ? null : item; }
  function unique(selector) { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } }
  function stableSelector(el) {
    const permanent = el.getAttribute("data-wb-element");
    if (permanent && /^el-[a-f0-9-]{36}$/.test(permanent) && unique(`[data-wb-element="${permanent}"]`)) return `[data-wb-element="${permanent}"]`;
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const name of ["data-testid", "data-test", "data-key", "data-id", "name"]) { const value = el.getAttribute(name); if (!value) continue; const selector = `${el.tagName.toLowerCase()}[${name}="${CSS.escape(value)}"]`; if (unique(selector)) return selector; }
    // Script-rendered controls can expose durable business keys even when they
    // are absent from the static HTML. Never use a row index or visible wording.
    const action = el.getAttribute("data-action");
    if (action) {
      let selector = `${el.tagName.toLowerCase()}[data-action="${CSS.escape(action)}"]`;
      for (const name of ["data-page", "data-target", "data-key", "data-id", "data-group-id", "data-meter-id"]) {
        const value = el.getAttribute(name); if (value) selector += `[${name}="${CSS.escape(value)}"]`;
      }
      if (unique(selector)) return selector;
    }
    return "";
  }
  function contextHash(el) {
    const row = el.closest("tr,[role=row],li,[data-key],[data-id]") || el.parentElement;
    const text = row ? [row.tagName, row.id, row.getAttribute("data-key") || row.getAttribute("data-id") || "", (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)].join("|") : "";
    let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0");
  }
  function anchor(el) {
    let selector = stableSelector(el), strength = "path";
    if (selector) strength = "stable";
    else { const path = []; let cursor = el, prefix = "html"; while (cursor && cursor !== document.documentElement && path.length < 24) { const siblings = Array.from(cursor.parentElement?.children || []).filter((sibling) => sibling.tagName === cursor.tagName); path.unshift(`${cursor.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(cursor) + 1})`); cursor = cursor.parentElement; const stable = cursor && stableSelector(cursor); if (stable) { prefix = stable; break; } } selector = `${prefix} > ${path.join(" > ")}`; }
    return { ...(selector.startsWith("[data-wb-element=") ? { elementId: el.getAttribute("data-wb-element") } : {}), selector, tag: el.tagName.toLowerCase(), label: label(el), htmlHash: config.htmlHash, strength, contextHash: strength === "path" ? contextHash(el) : "" };
  }
  const targetSignature = (t) => JSON.stringify([t.type, t.pageId, t.route || "", t.anchor.selector, t.anchor.tag, t.anchor.label, t.anchor.htmlHash, t.anchor.strength, t.anchor.contextHash || ""]);
  function resolve(item) {
    if ((item.target.route || "") !== location.hash) return { status: "other-state" };
    const a = item.target.anchor;
    if (a.strength === "path" && a.htmlHash !== config.htmlHash) return { status: "changed" };
    let found; try { found = document.querySelectorAll(a.selector); } catch { return { status: "changed" }; }
    if (found.length !== 1) return { status: "changed" };
    const el = found[0]; if (el.tagName.toLowerCase() !== a.tag || a.strength !== "stable" && label(el) !== a.label && !legacyFieldLabel(a)) return { status: "changed" };
    if (a.strength === "path") {
      if (a.contextHash && contextHash(el) !== a.contextHash) return { status: "changed" };
      const signature = targetSignature(item.target), prior = identities.get(item.id);
      if (prior?.signature === signature && prior.el !== el) return { status: "changed" };
      if (!prior || prior.signature !== signature) identities.set(item.id, { signature, el });
    }
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.display === "none" || style.visibility === "hidden") return { status: "hidden", el };
    return { status: "attached", el, rect };
  }
  function outline(el) {
    if (!highlight) return;
    if (!el) { highlight.hidden = true; return; }
    const r = el.getBoundingClientRect(); highlight.hidden = false;
    Object.assign(highlight.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  function paint() {
    scheduled = false; if (!layer) return;
    for (const mark of layer.querySelectorAll(".element-spec-pin")) mark.remove();
    const states = [];
    items.forEach((item, index) => {
      const result = resolve(item); states.push({ id: item.id, status: result.status });
      if (show && result.rect && result.rect.bottom > 0 && result.rect.top < innerHeight && result.rect.right > 0 && result.rect.left < innerWidth) {
        const pin = document.createElement("span"); pin.className = "element-spec-pin"; pin.textContent = String(index + 1);
        Object.assign(pin.style, { position: "fixed", top: `${Math.max(1, result.rect.top - 8)}px`, left: `${Math.min(innerWidth - 22, Math.max(1, result.rect.right - 10))}px`, width: "20px", height: "20px", borderRadius: "50%", background: item.id === active ? config.colors.action : config.colors.secondary, color: "#fff", border: "2px solid #fff", font: "500 11px/16px system-ui", boxSizing: "border-box", textAlign: "center", boxShadow: "0 1px 4px #0002", pointerEvents: "none" });
        layer.append(pin);
      }
      if (!picking && item.id === active) outline(show ? result.el : null);
    });
    if (!picking && (!active || !show)) outline(null);
    send("positions", { states, route: location.hash });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(paint); } }
  function cancelPick() { const wasPicking = picking; picking = false; outline(null); if (wasPicking) send("pick-ended"); schedule(); }
  window.addEventListener("message", (event) => {
    const msg = event.data; if (event.source !== parent || !msg || msg.channel !== "element-spec-v1" || msg.token !== config.token) return;
    if (msg.type === "sync") { items = Array.isArray(msg.notes) ? msg.notes.slice(0, 500) : []; show = !!msg.show; active = msg.active || ""; schedule(); }
    if (msg.type === "ping") { send("ready", { route: location.hash }); schedule(); }
    if (msg.type === "confirm-rebind" && pendingBinding?.id === msg.id) { identities.set(msg.id, pendingBinding.binding); pendingBinding = null; schedule(); }
    if (msg.type === "pick") { pickingId = typeof msg.noteId === "string" ? msg.noteId : ""; picking = !!msg.enabled; outline(null); }
    if (msg.type === "locate") { const item = items.find((note) => note.id === msg.id); if (!item) return; active = item.id; if (location.hash !== (item.target.route || "")) location.hash = item.target.route || ""; requestAnimationFrame(() => { const found = resolve(item); found.el?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); outline(found.el); schedule(); }); }
  });
  for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"]) window.addEventListener(name, (event) => { if (!picking) return; event.preventDefault(); event.stopImmediatePropagation(); }, true);
  window.addEventListener("click", (event) => {
    if (!picking) return; event.preventDefault(); event.stopImmediatePropagation(); const el = target(event.target); if (!el) return;
    const value = anchor(el); if (!value.selector || value.selector.length > 1000 || !unique(value.selector)) { send("pick-error", { message: "该元素无法可靠定位，请选择它所属的控件。" }); return; }
    const priorNote = items.find((item) => item.id === pickingId); if (priorNote) pendingBinding = { id: pickingId, binding: { el, signature: targetSignature({ ...priorNote.target, route: location.hash, anchor: value }) } };
    picking = false; outline(null); send("picked", { anchor: value, route: location.hash }); schedule();
  }, true);
  window.addEventListener("pointermove", (event) => { if (picking) outline(target(event.target)); }, true);
  window.addEventListener("keydown", (event) => { if (!picking) return; if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancelPick(); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule); window.addEventListener("hashchange", () => { cancelPick(); schedule(); });
  document.addEventListener("DOMContentLoaded", () => {
    const host = document.createElement("div"); host.setAttribute("data-element-spec-overlay", "");
    host.style.cssText = "position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;";
    const root = host.attachShadow({ mode: "closed" }); layer = document.createElement("div"); layer.style.cssText = "pointer-events:none;position:fixed;inset:0;"; root.append(layer);
    highlight = document.createElement("div"); highlight.hidden = true; highlight.style.cssText = `position:fixed;border:2px solid ${config.colors.accent};border-radius:3px;box-sizing:border-box;pointer-events:none;background:transparent;`; layer.append(highlight); document.documentElement.append(host);
    new MutationObserver((changes) => { if (changes.some((change) => change.target !== host && !host.contains(change.target))) schedule(); }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(document.body);
    schedule();
  }, { once: true });
}


const annotationTarget = (target) => {
  if (target?.type === "page-element") { const a = target.anchor || {}; return { type: target.type, pageId: target.pageId, route: target.route || "", anchor: { ...(a.elementId ? { elementId: a.elementId } : {}), selector: a.selector, tag: a.tag, label: a.label, htmlHash: a.htmlHash, contextHash: a.contextHash || "", strength: a.strength } }; }
  return target?.type === "flow-node" ? { type: target.type, flowId: target.flowId, nodeId: target.nodeId } : { type: target?.type, flowId: target?.flowId, edgeId: target?.edgeId };
};
export const requirementReference = (value) => ({ file: String(value.file || ""), blockId: String(value.blockId || ""), quote: String(value.quote ?? value.text ?? ""), heading: String(value.heading || "") });
const requirementsOf = (note) => (Array.isArray(note?.requirements) ? note.requirements : []).map(requirementReference);
const sameRequirement = (a, b) => a.file === b.file && a.blockId === b.blockId;
export const annotationPayload = (notes) => notes.map((note) => ({ id: note.id, target: annotationTarget(note.target), text: (note.text || "").trim(), requirements: requirementsOf(note) }));
export const annotationKey = (notes) => JSON.stringify(annotationPayload(notes));

// One request at a time; acknowledge only the submitted snapshot, never later input.
export function createAnnotationAutosave({ getWorkspace, setWorkspace, request, canSave = () => true, onChange = () => {}, onSaved = () => {} }) {
  let savedNotes = [], saving = false, pending = null, timer = null, failure = "", conflict = false, generation = 0;
  const changed = () => !!getWorkspace() && annotationKey(getWorkspace().notes) !== annotationKey(savedNotes);
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function reset(workspace, baseline = workspace.notes) { generation++; clear(); setWorkspace(workspace); savedNotes = clone(baseline); failure = ""; conflict = false; saving = false; pending = null; onChange(); }
  function fail(message, status = 0) { clear(); failure = message; conflict = status === 409; onChange(); }
  function mark(delay = 600) { clear(); onChange(); if (failure || !changed() || !canSave()) return; timer = setTimeout(() => { timer = null; if (canSave()) void flush(); }, delay); }
  async function flush(retry = false) {
    clear();
    if (!canSave()) return false;
    if (pending) return await pending;
    if (retry) { failure = ""; conflict = false; }
    if (failure) return false;
    if (!changed()) { onChange(); return true; }
    const currentGeneration = generation;
    pending = (async () => {
      saving = true; onChange();
      try {
        while (changed() && !failure && canSave()) {
          const workspace = getWorkspace(), snapshot = annotationPayload(workspace.notes), submitted = annotationKey(snapshot);
          const result = await request(workspace.revision, snapshot);
          if (currentGeneration !== generation) return false;
          if (!result.workspace || !Array.isArray(result.workspace.notes)) throw new Error("说明保存结果不可用");
          const current = getWorkspace(), received = result.workspace;
          const sent = new Map(snapshot.map((note) => [note.id, note])), returned = new Map(received.notes.map((note) => [note.id, note]));
          const notes = annotationKey(current.notes) === submitted ? received.notes : current.notes.map((note) => {
            const before = sent.get(note.id), after = returned.get(note.id);
            return before && after && annotationKey([note]) === annotationKey([before]) ? after : note;
          });
          savedNotes = clone(received.notes); setWorkspace({ ...received, notes });
          onSaved(received, snapshot); onChange();
        }
        return !failure && !changed();
      } catch (err) {
        if (currentGeneration === generation) { failure = `${err.message}。当前说明草稿已保留。${err.status === 409 ? "请先重新读取服务端内容；不会自动覆盖。" : "可重试保存。"}`; conflict = err.status === 409; }
        return false;
      } finally { if (currentGeneration === generation) { saving = false; pending = null; onChange(); } }
    })();
    return await pending;
  }
  return { mark, flush, reset, fail, clear, changed, baseline: () => clone(savedNotes), getStatus: () => ({ saving, error: failure, conflict }) };
}

export function createPageAnnotations({ getContext, documentHtml, onStatusChange }) {
  const dialog = document.createElement("dialog"); dialog.className = "element-notes-dialog"; dialog.id = "elementNotesDialog"; dialog.setAttribute("aria-labelledby", "enTitle");
  dialog.innerHTML = `<header class="element-notes-header"><div><h2 id="enTitle">元素关联</h2><span id="enPageName"></span><select id="enState" aria-label="页面状态" hidden></select></div><div class="element-notes-actions"><span id="enAutoState" role="status"></span><button id="enToggle" aria-pressed="true">显示标记</button><button id="enPick" class="primary">添加说明</button><button id="enClose">完成</button></div></header><div id="enHint" class="element-notes-hint" role="status"></div><div class="element-notes-layout"><section class="element-notes-preview"><div id="enFrameSize"><iframe id="enFrame" title="页面元素说明预览" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div></section><aside class="element-notes-panel"><div class="element-notes-panel-heading"><strong id="enCount">当前页面</strong><button id="enReload" class="text-button">重新读取</button></div><div id="enPendingRule" class="element-pending-rule" hidden></div><div id="enOriginActions" class="element-notes-edit-actions" hidden><a id="enReturnRule">返回需求原文</a><button id="enContinueRule" type="button">继续关联此需求</button></div><div id="enList" class="element-notes-list"></div><form id="enForm" hidden><div class="element-notes-target"><strong id="enTarget"></strong><span id="enTargetStatus"></span></div><section class="element-requirements"><div class="element-requirements-heading"><strong>需求依据</strong><button type="button" id="enLinkRule" class="text-button" aria-expanded="false" aria-controls="enRulePicker">关联需求</button></div><div id="enRequirements"></div><div id="enRulePicker" hidden><label class="sr-only" for="enRuleSearch">搜索需求原文或章节</label><input id="enRuleSearch" type="search" placeholder="搜索需求原文或章节" autocomplete="off"><div id="enRuleResults"></div><button type="button" id="enRulePickerClose" class="text-button">收起</button></div></section><label for="enText">补充说明 <span class="element-optional">选填</span></label><textarea id="enText" maxlength="8000" rows="4" placeholder="交互规则或例外情况"></textarea><p id="enSaveState" role="status"></p><div class="element-notes-edit-actions"><button type="button" id="enRebind">重新关联元素</button><button type="button" id="enDelete" class="danger">删除</button></div><div class="element-notes-edit-actions"><button type="button" id="enCancel">完成编辑</button><button type="submit" id="enSave" class="primary" hidden>重试保存</button></div></form><div id="enError" class="element-notes-error" role="alert" hidden></div></aside></div>`;
  iconButtons(dialog, [["enClose", "close", "完成并关闭"], ["enReload", "refresh", "重新读取"], ["enReturnRule", "back", "返回需求原文"], ["enLinkRule", "link", "关联需求"], ["enRulePickerClose", "up", "收起需求选择"], ["enRebind", "target", "重新关联元素"], ["enDelete", "trash", "删除关联与备注"]]);
  document.body.append(dialog);
  const confirmation = document.createElement("dialog"); confirmation.className = "element-notes-confirm"; confirmation.setAttribute("aria-labelledby", "enConfirmTitle");
  confirmation.innerHTML = '<form method="dialog"><h2 id="enConfirmTitle"></h2><p></p><div class="dialog-actions"><button value="cancel" autofocus>取消</button><button value="confirm" class="primary"></button></div></form>';
  document.body.append(confirmation);
  confirmation.addEventListener("cancel", (event) => { event.preventDefault(); confirmation.close("cancel"); });
  let confirmationPending = false;
  function confirmAction(title, message, label, destructive = false) {
    if (confirmationPending) return Promise.resolve(false);
    confirmationPending = true; const previousFocus = document.activeElement;
    confirmation.querySelector("h2").textContent = title; confirmation.querySelector("p").textContent = message;
    const accept = confirmation.querySelector('[value="confirm"]'); accept.textContent = label; accept.classList.toggle("destructive", destructive);
    confirmation.returnValue = "cancel"; confirmation.showModal(); confirmation.querySelector('[value="cancel"]').focus();
    return new Promise((resolve) => confirmation.addEventListener("close", () => { confirmationPending = false; if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus(); resolve(confirmation.returnValue === "confirm"); }, { once: true }));
  }
  const $ = (id) => dialog.querySelector(`#${id}`);
  let ctx = null, workspace = null, canEdit = false, loading = false, composing = false, token = "", picking = false, rebind = false, shown = true, ready = false, frameLost = false, selectedId = "", draft = null, statuses = {}, currentRoute = "", generation = 0, lastStatus = "", rules = [], rulesLoaded = false, rulesError = "", pendingRequirement = null, originRequirement = null, requestedNoteId = "", locateId = "", startingPick = false, switchingState = false, restoreStateFocus = false;
  const resetPage = document.createElement("button"); resetPage.id = "enResetPage"; resetPage.className = "text-button"; iconButton(resetPage, "refresh", "回到原页面"); resetPage.hidden = true; $("enHint").after(resetPage);
  const pageNotes = () => (workspace?.notes || []).filter((n) => n.target.type === "page-element" && n.target.pageId === ctx?.pageId);
  const editable = () => canEdit && !!ctx?.canEdit && !loading;
  const mayPick = () => editable() && ready && (ctx?.saved || typeof ctx?.flushDesign === "function");
  const draftValid = () => !!draft && (!!$("enText").value.trim() || requirementsOf(draft).length > 0);
  const draftDirty = () => { if (!draft) return false; const note = workspace?.notes.find((n) => n.id === draft.id); return !note || !!draft.rebound || !draftValid() || annotationKey([{ ...draft, text: $("enText").value }]) !== annotationKey([note]); };
  const dirty = () => composing || autosave.changed() || draftDirty();
  const cacheKey = () => ctx ? `requirements:annotation-draft:page:${ctx.entryPath}:${ctx.pageId}:${ctx.page.route || ""}` : "";
  function persist() { if (!ctx || !workspace || !canEdit || !ctx.canEdit) return; try { if (!dirty()) sessionStorage.removeItem(cacheKey()); else sessionStorage.setItem(cacheKey(), JSON.stringify({ workspace, baseline: autosave.baseline(), draft, text: $("enText").value, selectedId })); } catch {} }
  function getStatus() { const save = autosave.getStatus(), changed = dirty(); const status = loading ? "loading" : save.error ? "error" : save.saving ? "saving" : changed ? "pending" : workspace?.revision ? "saved" : "idle"; return { state: status, status, dirty: changed, saving: save.saving, error: save.error, revision: workspace?.revision || 0 }; }
  function notify() { const value = getStatus(), key = JSON.stringify(value); if (key === lastStatus) return; lastStatus = key; onStatusChange?.(value); window.dispatchEvent(new CustomEvent("workspace-save-state", { detail: value })); }
  const autosave = createAnnotationAutosave({ canSave: () => !composing, getWorkspace: () => workspace, setWorkspace: (value) => { workspace = value; }, request: (expectedRevision, notes) => api({ method: "PUT", headers: { "Content-Type": "application/json", "X-Design-Client": "workbench-v1" }, body: JSON.stringify({ expectedRevision, notes }) }), onChange: () => { persist(); if (dialog.open) { controls(); renderList(); } else notify(); }, onSaved: (received) => { const saved = draft && received.notes.find((n) => n.id === draft.id); if (!saved) return; draft.existing = true; selectedId = draft.id; if (draft.rebound && annotationKey([{ ...draft, text: saved.text }]) === annotationKey([saved])) { send("confirm-rebind", { id: draft.id }); draft.rebound = false; } } });
  const send = (type, extra = {}) => { if (dialog.open) $("enFrame").contentWindow?.postMessage({ channel: "element-spec-v1", token, type, ...extra }, "*"); };
  const statusLabel = (id) => {
    const route = pageNotes().find(note => note.id === id)?.target.route || "";
    const name = ctx?.states?.find(item => item.route === route)?.name || route || "默认状态";
    return statuses[id] === "changed" ? `${name} · 元素待核对` : statuses[id] === "hidden" ? `${name} · 元素不可见` : name;
  };
  function error(message = "") { $("enError").textContent = message; $("enError").hidden = !message; }
  async function api(options) { const path = ctx.entryPath, res = await fetch(`/api/annotations?${new URLSearchParams({ path })}`, { cache: "no-store", ...options }); const data = await res.json(); if (!res.ok) { const err = new Error(data.error || "说明读取失败"); err.status = res.status; throw err; } return data; }
  function sync() { send("sync", { notes: pageNotes().map(({ id, target }) => ({ id, target })), show: shown, active: selectedId }); }
  function controls() {
    const save = autosave.getStatus(), status = getStatus();
    iconButton($("enPick"), picking ? "close" : pendingRequirement ? "target" : "plus", picking ? "取消选取" : pendingRequirement ? "选择元素" : "添加关联");
    iconButton($("enToggle"), shown ? "eye" : "eyeOff", "显示标记"); $("enToggle").dataset.tooltip = shown ? "隐藏标记" : "显示标记"; $("enPick").disabled = !mayPick(); $("enToggle").setAttribute("aria-pressed", String(shown));
    $("enHint").textContent = frameLost ? "页面已跳转，回到原页面后可继续定位说明。" : picking ? pendingRequirement ? "点击页面元素，关联当前需求 · Esc 取消选取" : "点击需要关联的元素 · Esc 取消选取" : !ctx?.saved ? "页面设计保存后可添加或重新关联说明；已有说明仍可查看。" : !canEdit || !ctx?.canEdit ? "只读查看 · 页面交互保持可用" : "";
    $("enHint").hidden = !$("enHint").textContent;
    $("enState").disabled = loading || !ready || composing || switchingState;
    resetPage.hidden = !frameLost;
    $("enOriginActions").hidden = !originRequirement;
    if (originRequirement) $("enReturnRule").href = requirementUrl(originRequirement);
    $("enContinueRule").hidden = !canEdit || !ctx?.canEdit;
    $("enContinueRule").disabled = !mayPick() || picking || !!pendingRequirement || referenceStatus(originRequirement || {}) !== "current";
    $("enText").readOnly = !editable(); $("enRebind").disabled = !mayPick(); $("enDelete").disabled = !editable() || picking; $("enCancel").disabled = loading; $("enClose").disabled = loading; $("enReload").disabled = loading || save.saving; $("enToggle").disabled = !ready;
    $("enDelete").hidden = !draft?.existing || !canEdit || !ctx?.canEdit; $("enSave").hidden = !save.error || !editable(); $("enSave").disabled = loading || save.saving; $("enRebind").hidden = !canEdit || !ctx?.canEdit;
    $("enLinkRule").disabled = !editable() || requirementsOf(draft).length >= 12;
    $("enCancel").textContent = draft && !draftValid() ? draft.existing ? "恢复内容" : "取消新建" : "完成编辑";
    const label = loading ? "读取中…" : composing ? "输入完成后自动保存" : save.error ? "自动保存未完成" : save.saving ? "正在自动保存…" : status.dirty ? draft && !draftValid() ? "关联需求或填写说明后自动保存" : "等待自动保存…" : workspace?.revision ? "已自动保存" : "更改自动保存";
    $("enSaveState").textContent = label; $("enSaveState").hidden = !(draft && !draftValid()); $("enAutoState").textContent = loading ? "读取中…" : save.error ? "保存失败" : save.saving ? "保存中…" : composing ? "输入中" : status.dirty ? "待保存" : workspace?.revision ? "已保存" : "自动保存";
    if (save.error) error(save.error); notify();
  }
  function renderList() {
    const focusId = document.activeElement?.dataset.noteId;
    const notes = pageNotes(); $("enCount").textContent = `关联元素 · ${notes.length}`;
    $("enList").innerHTML = notes.length ? notes.map((n, index) => `<button type="button" data-note-id="${escape(n.id)}" aria-pressed="${selectedId === n.id}" class="element-note-item${selectedId === n.id ? " active" : ""}"><span class="element-note-number">${index + 1}</span><span><strong>${escape(n.target.anchor.label || n.target.anchor.tag)}</strong><small data-note-status="${escape(n.id)}">${escape(statusLabel(n.id))}</small><span class="element-note-summary">${requirementsOf(n).length ? `<span class="element-rule-count">${requirementsOf(n).length} 条需求依据${requirementsOf(n).some((ref) => referenceStatus(ref) === "changed") ? " · 待核对" : ""}</span>` : ""}${escape((n.text || "").slice(0, 140))}${(n.text || "").length > 140 ? "…" : ""}</span></span></button>`).join("") : '<div class="element-notes-empty">暂无关联</div>';
    if (focusId) [...$("enList").querySelectorAll("[data-note-id]")].find(el => el.dataset.noteId === focusId)?.focus({preventScroll:true});
    controls(); sync();
  }
  function setDraft(note, text = note?.text || "") { draft = note ? { ...clone(note), requirements: requirementsOf(note), existing: !!note.existing } : null; $("enForm").hidden = !draft; $("enText").value = text; if (draft) { $("enTarget").textContent = draft.target.anchor.label || draft.target.anchor.tag; $("enTargetStatus").textContent = draft.existing ? statusLabel(draft.id) : "新选中的元素"; } setRulePicker(false); renderRequirements(); controls(); }
  function stageDraft() {
    if (composing) return false;
    if (!draft) return true;
    const text = $("enText").value.trim(); if (!draftValid() || text.length > 8000) { persist(); controls(); return false; }
    const note = { id: draft.id, target: clone(draft.target), text, requirements: requirementsOf(draft) }, index = workspace?.notes.findIndex((n) => n.id === note.id);
    if (!workspace || index < 0 && workspace.notes.length >= 500) { error("每个需求最多 500 条元素说明。"); return false; }
    if (index < 0) workspace.notes.push(note); else if (annotationKey([workspace.notes[index]]) !== annotationKey([note])) workspace.notes[index] = { ...workspace.notes[index], ...note };
    selectedId = draft.id; persist(); return true;
  }
  function changed(event) { if (event?.isComposing) composing = true; const valid = stageDraft(); persist(); if (valid) autosave.mark(); else controls(); }
  async function flush(retry = false) { if (!dialog.open) return true; if (loading) return false; if (composing) { error("输入完成后会自动保存，请先完成当前文字输入。"); persist(); return false; } stopPick(); if (draft && !draft.existing && !draftValid()) { selectedId = ""; setDraft(null); renderList(); } if (!stageDraft()) { error("请关联一条需求或填写补充说明，当前草稿已保留。"); return false; } const ok = await autosave.flush(retry); persist(); return ok && !dirty(); }
  async function ensureSavedPage() { if (ctx?.saved) return true; if (typeof ctx?.flushDesign !== "function" || !await ctx.flushDesign()) return false; const next = getContext(); if (!next?.saved || next.pageId !== ctx.pageId || next.entryPath !== ctx.entryPath) return false; const replaced = next.page.html !== ctx.page.html; ctx = next; if (replaced) { ready = false; token = uuid(); $("enFrame").srcdoc = inject(ctx.page); controls(); return false; } controls(); return true; }
  function fitPreview() { if (!dialog.open || !ctx?.page) return; const wrapper = $("enFrameSize"), preview = wrapper.parentElement; if (!preview) return; const style = getComputedStyle(preview), available = preview.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0); const scale = window.innerWidth <= 760 && available > 0 ? Math.min(1, available / ctx.page.width) : 1; wrapper.style.width = `${ctx.page.width * scale}px`; wrapper.style.height = `${ctx.page.height * scale}px`; $("enFrame").style.width = `${ctx.page.width}px`; $("enFrame").style.height = `${ctx.page.height}px`; $("enFrame").style.transformOrigin = "top left"; $("enFrame").style.transform = scale === 1 ? "none" : `scale(${scale})`; }
  function stopPick(cancelPending = false) { const wasPicking = picking; picking = false; rebind = false; if (cancelPending) { pendingRequirement = null; renderPendingRequirement(); } if (wasPicking) send("pick", { enabled: false }); controls(); }
  function referenceStatus(ref) { if (!rulesLoaded) return "unknown"; const current = rules.find((rule) => sameRequirement(rule, ref)); return current && !current.ambiguous && current.quote === ref.quote && current.heading === ref.heading ? "current" : "changed"; }
  function requirementUrl(ref) { return `/#${new URLSearchParams({ path: ctx.entryPath, view: "doc", doc: "requirement", file: ref.file, rule: ref.blockId })}`; }
  function referenceCard(ref, index, removable = false) { const status = referenceStatus(ref); return `<article class="element-rule-card${status === "changed" ? " changed" : ""}"><div><span>${escape(ref.heading || "需求原文")}</span>${removable && editable() ? `<button type="button" data-remove-rule="${index}" title="解除需求关联" aria-label="解除需求关联">×</button>` : ""}</div><p>${escape(ref.quote)}</p>${status === "changed" ? '<small class="element-rule-warning">原文已变化，待核对</small>' : status === "unknown" ? '<small>原文暂未核验</small>' : ""}<a class="rule-source-action" href="${escape(requirementUrl(ref))}" aria-label="查看需求原文">查看需求原文</a></article>`; }
  function decorateRequirementActions(root) {
    for (const button of root.querySelectorAll('[data-remove-rule]')) iconButton(button, 'unlink', '解除需求关联');
    for (const link of root.querySelectorAll('.rule-source-action')) iconButton(link, 'external', '查看需求原文');
    iconButton(root.querySelector('[data-cancel-pending]'), 'close', '取消关联');
  }
  function renderRequirements() { $("enRequirements").innerHTML = requirementsOf(draft).map((ref, index) => referenceCard(ref, index, true)).join("") || '<p class="element-rule-empty">暂无需求依据</p>'; decorateRequirementActions($('enRequirements')); }
  function renderPendingRequirement() { $("enPendingRule").hidden = !pendingRequirement; $("enPendingRule").innerHTML = pendingRequirement ? `<div class="element-pending-heading"><strong>正在关联这条需求</strong><button type="button" data-cancel-pending class="text-button">取消</button></div>${referenceCard(pendingRequirement, 0)}` : ""; decorateRequirementActions($("enPendingRule")); }
  async function loadRules() { const request = generation; rulesError = ""; try { const res = await fetch(`/api/requirement-rules?${new URLSearchParams({ path: ctx.entryPath })}`, { cache: "no-store" }); const data = await res.json(); if (!res.ok) throw new Error(data.error || "需求原文读取失败"); if (request !== generation || !dialog.open) return; rules = (Array.isArray(data.rules) ? data.rules : []).map((value) => ({ ...requirementReference(value), ambiguous: value.ambiguous === true })); rulesLoaded = true; } catch (err) { if (request !== generation) return; rulesError = err.message; rulesLoaded = false; } if (request === generation && dialog.open) { renderRequirements(); renderPendingRequirement(); renderRuleResults(); renderList(); controls(); } }
  function setRulePicker(open) {
    $("enRulePicker").hidden = !open;
    $("enLinkRule").setAttribute("aria-expanded", String(open));
    $("enLinkRule").dataset.tooltip = open ? "收起需求选择" : "关联需求";
  }
  function renderRuleResults() { const query = $("enRuleSearch").value.trim().toLocaleLowerCase(), linked = requirementsOf(draft); const matches = rules.filter((rule) => !query || `${rule.heading} ${rule.quote}`.toLocaleLowerCase().includes(query)); $("enRuleResults").innerHTML = rulesError ? `<p class="element-rule-empty">${escape(rulesError)}</p>` : !rulesLoaded ? '<p class="element-rule-empty">正在读取需求…</p>' : matches.length ? matches.slice(0, 80).map((rule) => { const index = rules.indexOf(rule), exists = linked.some((ref) => sameRequirement(ref, rule)); return `<button type="button" data-add-rule="${index}" class="element-rule-option" ${exists || rule.ambiguous ? "disabled" : ""}><strong>${escape(rule.heading || "需求原文")}${exists ? " · 已关联" : rule.ambiguous ? " · 同文重复，无法唯一定位" : ""}</strong><span>${escape(rule.quote)}</span></button>`; }).join("") + (matches.length > 80 ? '<p class="element-rule-empty">输入关键词继续缩小范围</p>' : "") : '<p class="element-rule-empty">没有找到相符的需求原文</p>'; }
  async function beginRequirementPick() { if (!pendingRequirement || startingPick || !mayPick() || picking || loading) return; startingPick = true; try { if (!await flush() || !await ensureSavedPage()) return; selectedId = ""; setDraft(null); picking = true; rebind = false; send("pick", { enabled: true }); controls(); } finally { startingPick = false; } }
  function renderStatePicker() {
    const states = [...(ctx?.states || [])];
    if (!states.some(item => item.route === currentRoute)) states.push({ name: currentRoute || "默认状态", route: currentRoute });
    const key = JSON.stringify(states.map(item => [item.route, item.name]));
    if ($("enState").dataset.options !== key) {
      $("enState").innerHTML = states.map(item => `<option value="${escape(item.route)}">${escape(item.name)}</option>`).join("");
      $("enState").dataset.options = key;
    }
    $("enState").hidden = states.length < 2; $("enState").value = currentRoute;
  }
  function previewRoute(route, noteId = "") {
    const variant = ctx.states?.find(item => item.route === route);
    currentRoute = route; ctx.page = { ...ctx.page, route, width: variant?.width || ctx.page.width, height: variant?.height || ctx.page.height };
    ready = false; frameLost = false; statuses = {}; token = uuid(); locateId = noteId;
    renderStatePicker(); controls(); fitPreview(); $("enFrame").srcdoc = inject(ctx.page);
    $("enFrameSize").parentElement.scrollTo(0, 0);
  }
  function locateNote(note) {
    selectedId = note.id; setDraft({ ...note, existing: true }); renderList(); $("enForm").scrollTop = 0;
    const item = [...$("enList").querySelectorAll("[data-note-id]")].find(el => el.dataset.noteId === note.id);
    if (item) {
      const target = item.getBoundingClientRect(), list = $("enList").getBoundingClientRect();
      if (target.top < list.top) $("enList").scrollTop += target.top - list.top;
      else if (target.bottom > list.bottom) $("enList").scrollTop += target.bottom - list.bottom;
    }
    if (currentRoute !== (note.target.route || "")) previewRoute(note.target.route || "", note.id);
    else { locateId = note.id; if (ready) { send("locate", { id: locateId }); locateId = ""; } }
  }
  function locateRequestedNote() {
    if (!requestedNoteId || !workspace) return;
    const note = pageNotes().find(value => value.id === requestedNoteId); requestedNoteId = "";
    if (!note) { error("这条元素关联已不存在，当前页面仍可查看。"); return; }
    locateNote(note);
  }

  async function load(restore = true) {
    const request = generation; let cached; if (restore) { try { cached = JSON.parse(sessionStorage.getItem(cacheKey()) || "null"); } catch {} } loading = true; controls(); error();
    try { const result = await api(); if (request !== generation || !dialog.open) return; canEdit = result.canEdit; statuses = {}; autosave.reset(result.workspace); if (canEdit && cached?.workspace && Array.isArray(cached.workspace.notes) && Array.isArray(cached.baseline)) { const stale = cached.workspace.revision !== result.workspace.revision; autosave.reset(cached.workspace, cached.baseline); selectedId = cached.selectedId || ""; if (cached.draft) setDraft(cached.draft, cached.text || ""); if (stale) autosave.fail("本地说明草稿对应旧版本，已保留；请重新读取后处理，不能自动覆盖。", 409); else if (stageDraft()) autosave.mark(); } renderList(); }
    catch (err) { if (request !== generation || !dialog.open) return; workspace = null; canEdit = false; autosave.fail(err.message, err.status); }
    finally { if (request === generation) { loading = false; controls(); locateRequestedNote(); if (pendingRequirement) void beginRequirementPick(); } }
  }
  async function refreshClean() {
    if (!dialog.open || !ctx || loading || dirty() || autosave.getStatus().saving) return;
    const request = generation;
    try {
      const result = await api();
      if (request !== generation || !dialog.open || dirty() || autosave.getStatus().saving) return;
      const focus = document.activeElement, start = focus === $("enText") ? focus.selectionStart : null, end = focus === $("enText") ? focus.selectionEnd : null;
      const current = draft && result.workspace.notes.find((n) => n.id === draft.id);
      canEdit = result.canEdit === true;
      if (draft) { if (current) setDraft({ ...current, existing: true }); else { selectedId = ""; setDraft(null); } }
      autosave.reset(result.workspace); renderList(); void loadRules();
      if (focus?.isConnected && !focus.disabled) { focus.focus({ preventScroll: true }); if (start !== null) focus.setSelectionRange?.(start, end); }
    } catch {}
  }
  function inject(page) { const doc = new DOMParser().parseFromString(documentHtml(page), "text/html"), script = doc.createElement("script"); script.textContent = `(${annotationBridge.toString()})(${JSON.stringify({ token, htmlHash: htmlFingerprint(page.html), colors: { action: getComputedStyle(document.documentElement).getPropertyValue("--wb-action-primary").trim(), accent: getComputedStyle(document.documentElement).getPropertyValue("--wb-accent").trim(), secondary: getComputedStyle(document.documentElement).getPropertyValue("--wb-text-secondary").trim() } }).replace(/</g, "\\u003c")});`; const policy = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]'); if (policy) policy.after(script); else doc.head.prepend(script); return `<!doctype html>\n${doc.documentElement.outerHTML}`; }
  async function open(options = {}) { const next = getContext(); if (!next?.page || dialog.open) return; generation++; ctx = next; workspace = null; canEdit = false; loading = false; composing = false; token = uuid(); picking = false; ready = false; frameLost = false; shown = true; selectedId = ""; draft = null; statuses = {}; rules = []; rulesLoaded = false; rulesError = ""; originRequirement = options.requirement?.blockId ? requirementReference(options.requirement) : null; requestedNoteId = typeof options.noteId === "string" ? options.noteId : ""; pendingRequirement = requestedNoteId ? null : originRequirement; locateId = ""; currentRoute = ctx.page.route || ""; $("enPageName").textContent = ctx.pageName || ctx.page.name; renderStatePicker(); $("enForm").hidden = true; setRulePicker(false); $("enRuleSearch").value = ""; $("enList").textContent = "正在读取关联…"; error(); dialog.showModal(); renderPendingRequirement(); controls(); fitPreview(); $("enFrame").srcdoc = inject(ctx.page); await Promise.all([load(), loadRules()]); }
  function cleanupClosedDialog() {
    // A native close event is queued; a cached workspace can reopen before it arrives.
    if (dialog.open || !token) return;
    persist(); generation++; picking = false; ready = false; token = ""; draft = null; pendingRequirement = null; originRequirement = null; requestedNoteId = ""; locateId = ""; $("enFrame").srcdoc = ""; notify();
  }
  async function close() { if (!await flush()) return false; stopPick(); dialog.close(); cleanupClosedDialog(); return true; }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!$("enRulePicker").hidden) { setRulePicker(false); $("enLinkRule").focus(); } else if (picking) { stopPick(true); $("enPick").focus(); } else void close(); });
  dialog.addEventListener("close", cleanupClosedDialog);
  $("enClose").addEventListener("click", close);
  resetPage.addEventListener("click", () => { stopPick(); ready = false; frameLost = false; token = uuid(); statuses = {}; $("enFrame").srcdoc = inject(ctx.page); controls(); });
  $("enFrame").addEventListener("load", () => { if (!dialog.open) return; ready = false; picking = false; rebind = false; statuses = {}; controls(); send("ping"); const currentToken = token; setTimeout(() => { if (dialog.open && currentToken === token && !ready) { frameLost = true; for (const el of $("enList").querySelectorAll("[data-note-status]")) el.textContent = "当前预览页面已跳转"; if (draft) $("enTargetStatus").textContent = "当前预览页面已跳转"; controls(); } }, 900); });
  $("enToggle").addEventListener("click", () => { shown = !shown; controls(); sync(); });
  $("enPick").addEventListener("click", async () => { if (picking) { stopPick(true); return; } if (pendingRequirement) { await beginRequirementPick(); return; } if (!mayPick() || !await flush() || !await ensureSavedPage()) return; selectedId = ""; setDraft(null); picking = true; rebind = false; send("pick", { enabled: true }); controls(); });
  $("enContinueRule").addEventListener("click", async () => {
    if (!originRequirement || !mayPick() || referenceStatus(originRequirement) !== "current" || !await flush()) return;
    pendingRequirement = originRequirement; renderPendingRequirement(); await beginRequirementPick();
  });
  $("enRebind").addEventListener("click", async () => { if (!mayPick() || !draft || !await flush() || !await ensureSavedPage()) return; picking = true; rebind = true; send("pick", { enabled: true, noteId: draft.id }); controls(); });
  $("enText").addEventListener("compositionstart", () => { composing = true; autosave.clear(); persist(); controls(); });
  $("enText").addEventListener("compositionend", () => { composing = false; changed(); });
  $("enText").addEventListener("input", changed);
  $("enCancel").addEventListener("click", async () => { if (draft && !draftValid()) { const stored = workspace?.notes.find((n) => n.id === draft.id); if (draft.existing && stored) setDraft({ ...stored, existing: true }); else { workspace.notes = workspace.notes.filter((n) => n.id !== draft.id); setDraft(null); selectedId = ""; } persist(); renderList(); return; } if (!await flush()) return; stopPick(); setDraft(null); selectedId = ""; renderList(); });
  $("enList").addEventListener("click", async (event) => { const id = event.target.closest("[data-note-id]")?.dataset.noteId; if (!id || !await flush()) return; const note = pageNotes().find((n) => n.id === id); if (!note) return; stopPick(); locateNote(note); });
  $("enState").addEventListener("change", async () => {
    if (switchingState) return;
    const route = $("enState").value; restoreStateFocus = true; switchingState = true; controls();
    try {
      if (!await flush()) { restoreStateFocus = false; renderStatePicker(); return; }
      selectedId = ""; setDraft(null); error(); previewRoute(route); renderList();
    } finally { switchingState = false; controls(); }
  });
  $("enPendingRule").addEventListener("click", (event) => { if (event.target.closest("[data-cancel-pending]")) stopPick(true); });
  $("enLinkRule").addEventListener("click", () => { if (!draft || !editable()) return; setRulePicker($("enRulePicker").hidden); if (!$("enRulePicker").hidden) { renderRuleResults(); $("enRuleSearch").focus(); } });
  $("enRuleSearch").addEventListener("input", renderRuleResults);
  $("enRulePickerClose").addEventListener("click", () => { setRulePicker(false); $("enLinkRule").focus(); });
  $("enRuleResults").addEventListener("click", (event) => { const button = event.target.closest("[data-add-rule]"); if (!button || !draft || !editable()) return; const rule = rules[Number(button.dataset.addRule)]; if (!rule || rule.ambiguous || requirementsOf(draft).length >= 12 || requirementsOf(draft).some((ref) => sameRequirement(ref, rule))) return; draft.requirements = [...requirementsOf(draft), rule]; setRulePicker(false); error(); renderRequirements(); changed(); $("enText").focus(); });
  $("enRequirements").addEventListener("click", (event) => { const button = event.target.closest("[data-remove-rule]"); if (!button || !draft || !editable()) return; const index = Number(button.dataset.removeRule); if (!Number.isInteger(index) || index < 0 || index >= requirementsOf(draft).length) return; draft.requirements = requirementsOf(draft).filter((_, i) => i !== index); if (!draftValid()) { workspace.notes = workspace.notes.filter((note) => note.id !== draft.id); selectedId = ""; setDraft(null); renderList(); autosave.mark(); } else { renderRequirements(); changed(); } });
  $("enForm").addEventListener("submit", async (event) => { event.preventDefault(); await flush(true); });
  $("enDelete").addEventListener("click", async () => { if (!editable() || !draft?.existing || !await confirmAction("删除元素关联", "删除这条元素关联及补充说明？页面和需求原文保留。", "删除关联", true)) return; const id = draft.id; workspace.notes = workspace.notes.filter((n) => n.id !== id); selectedId = ""; setDraft(null); error(); persist(); renderList(); autosave.mark(); });
  $("enReload").addEventListener("click", async () => { if (dirty() && !await confirmAction("重新读取元素说明", "重新读取会放弃本机这份未保存说明草稿。", "重新读取", true)) return; autosave.clear(); try { sessionStorage.removeItem(cacheKey()); } catch {} stopPick(); selectedId = ""; setDraft(null); await load(false); });
  window.addEventListener("message", (event) => {
    const msg = event.data; if (!dialog.open || !token || event.source !== $("enFrame").contentWindow || !msg || msg.channel !== "element-spec-v1" || msg.token !== token) return;
    if (msg.type === "ready") { ready = true; frameLost = false; currentRoute = typeof msg.route === "string" ? msg.route : ""; renderStatePicker(); controls(); sync(); if (restoreStateFocus) { restoreStateFocus = false; $("enState").focus({preventScroll:true}); } if (locateId) { send("locate", { id: locateId }); locateId = ""; } if (pendingRequirement) void beginRequirementPick(); }
    if (msg.type === "pick-ended") { const wasPicking = picking; picking = false; rebind = false; if (wasPicking && pendingRequirement) { pendingRequirement = null; renderPendingRequirement(); } controls(); }
    if (msg.type === "pick-error") error(typeof msg.message === "string" ? msg.message : "请选择页面元素");
    if (msg.type === "positions" && Array.isArray(msg.states)) { statuses = Object.fromEntries(msg.states.filter((s) => typeof s.id === "string" && ["changed", "hidden", "other-state", "attached"].includes(s.status)).map((s) => [s.id, s.status])); currentRoute = typeof msg.route === "string" ? msg.route : ""; renderStatePicker(); for (const el of $("enList").querySelectorAll("[data-note-status]")) el.textContent = statusLabel(el.dataset.noteStatus); if (draft?.existing) $("enTargetStatus").textContent = statusLabel(draft.id); }
    if (msg.type === "picked" && picking && mayPick()) { const a = msg.anchor; if (!a || typeof a.selector !== "string" || a.selector.length > 1000 || !a.selector || typeof a.label !== "string" || a.label.length > 160 || typeof a.tag !== "string" || a.tag.length > 32 || !["stable", "path"].includes(a.strength) || a.htmlHash !== htmlFingerprint(ctx.page.html) || typeof msg.route !== "string" || (msg.route && !msg.route.startsWith("#")) || msg.route.length > 500) { error("元素定位信息无效，请重新选择。"); stopPick(); return; } const target = { type: "page-element", pageId: ctx.pageId, route: msg.route, anchor: a }; if (rebind && draft) { draft.target = target; draft.rebound = true; $("enTarget").textContent = a.label || a.tag; $("enTargetStatus").textContent = "重新关联正在自动保存"; } else { const existing = pageNotes().find((note) => note.target.route === target.route && note.target.anchor.selector === a.selector && note.target.anchor.tag === a.tag && (a.strength === "stable" && note.target.anchor.strength === "stable" || note.target.anchor.label === a.label || ["input", "select", "textarea"].includes(a.tag) && note.target.anchor.label === a.tag) && (a.strength === "stable" && note.target.anchor.strength === "stable" || a.htmlHash === note.target.anchor.htmlHash && (a.contextHash || "") === (note.target.anchor.contextHash || ""))); const requirements = requirementsOf(existing); if (pendingRequirement && !requirements.some((ref) => sameRequirement(ref, pendingRequirement))) { if (requirements.length >= 12) { error("这个元素已关联 12 条需求，请先解除一条后再关联。"); stopPick(); return; } requirements.push(pendingRequirement); } selectedId = existing?.id || ""; setDraft(existing ? { ...existing, target, requirements, existing: true } : { id: uuid(), target, text: "", requirements, existing: false }); } pendingRequirement = null; renderPendingRequirement(); picking = false; rebind = false; changed(); $("enText").focus(); }
  });
  dialog.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void flush(true); } });
  window.addEventListener("beforeunload", (event) => { persist(); if (dialog.open && dirty()) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("workspace-visible", () => void refreshClean());
  window.addEventListener("resize", fitPreview); if (typeof ResizeObserver !== "undefined") { const preview = $("enFrameSize").parentElement; if (preview) new ResizeObserver(fitPreview).observe(preview); }
  return { open, close, flush, getStatus, hasDraft: () => dialog.open && dirty(), isDirty: () => dialog.open && dirty() };
}
