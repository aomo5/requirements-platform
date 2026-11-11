"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBundle, applyOperations, checkBundle, diffBundle, payloadForApply, createPageNote, listElements } = require("../lib/design-edit-model");
const { stampElements, resolveElement } = require("../lib/stable-identities");
const { STYLE_FIELDS, editText, editStyle, htmlFingerprint } = require("../lib/design-element-edit");

const ID = "el-11111111-1111-4111-8111-111111111111";
const INNER = "el-22222222-2222-4222-8222-222222222222";
const OTHER = "el-33333333-3333-4333-8333-333333333333";
const ENTRY = "20-收费管理/测试设计";
const script = '<script>const sample = "<button>A & B</button>";\n window.x = `a  b`;</script>';
const HTML = `<!DOCTYPE html>\n<html><head><style>button {color:red}</style></head><body>\n<button data-wb-element='${ID}' class="main">确认 &amp; <span data-wb-element="${INNER}">订单</span> 完成</button>\n${script}\n</body></html>`;
function page(id = "p1", html = HTML) { return { id, name: "订单", width: 1280, height: 800, x: 0, y: 0, html, source: `${ENTRY}/原型设计/订单.html`, route: "#orders" }; }
function bundle(pages = [page()], notes = [], context = { flowLinks: [] }) {
  return createBundle("http://127.0.0.1:8125", ENTRY, { schemaVersion: 1, revision: 3, updatedAt: "2026-11-03", pages }, { schemaVersion: 1, revision: 4, updatedAt: "2026-11-03", notes }, context);
}
const textOp = (overrides = {}) => ({ op: "element.text", pageId: "p1", id: ID, index: 0, expected: "确认 & ", value: "提交 <&> ", ...overrides });
const note = (id = "n1", elementId = ID) => createPageNote(page(), elementId, { id, text: "保留说明", requirements: [] });

test("page change summary survives guarded CLI roundtrip without changing page content or element notes", () => {
  const original = bundle([page()], [note()]);
  const summary = "沿用：分账账户列表与原有筛选。\n新增：按账号展示设备费暂停状态。";
  const edited = applyOperations(original, [{ op: "page.update", id: "p1", set: { changeSummary: summary } }]);
  const payload = payloadForApply(edited);
  assert.equal(payload.pages[0].changeSummary, summary);
  assert.equal(payload.pages[0].html, original.base.workspace.pages[0].html);
  assert.deepEqual(payload.notes, original.base.annotations.notes);
  assert.equal(payload.expectedRevision, 3);
  assert.equal(createBundle(original.origin, ENTRY, { ...original.base.workspace, pages: payload.pages }, original.base.annotations).draft.workspace.pages[0].changeSummary, summary);
  assert.throws(() => applyOperations(original, [{ op: "page.update", id: "p1", set: { changeSummary: "长".repeat(4001) } }]));
  const cleared = applyOperations(edited, [{ op: "page.update", id: "p1", unset: ["changeSummary"] }]);
  assert.equal(payloadForApply(cleared).pages[0].changeSummary, undefined);
});

test("bundle is detached, deterministic, and produces revision guarded design payload", () => {
  const current = bundle(), snapshot = structuredClone(current);
  assert.deepEqual(checkBundle(current), { errors: [], warnings: [] });
  assert.deepEqual(diffBundle(current).changed, { design: false, annotations: false });
  const payload = payloadForApply(current);
  assert.equal(payload.expectedRevision, 3);
  assert.equal(payload.expectedAnnotationsRevision, 4);
  assert.deepEqual(payload.notes, []);
  payload.pages[0].name = "outside";
  assert.deepEqual(current, snapshot);
  current.draft.workspace.pages[0].name = "草稿";
  assert.equal(current.base.workspace.pages[0].name, "订单");
});

test("text editing escapes values and preserves descendants, scripts, formatting and stable IDs", () => {
  const current = bundle(), next = applyOperations(current, [textOp()]);
  const expected = HTML.replace("确认 &amp; ", "提交 &lt;&amp;&gt; ");
  assert.equal(next.draft.workspace.pages[0].html, expected);
  assert.equal(current.draft.workspace.pages[0].html, HTML);
  assert.ok(next.draft.workspace.pages[0].html.includes(script));
  assert.deepEqual(listElements(next.draft.workspace.pages[0].html).find(item => item.id === ID).texts, [{ index: 0, text: "提交 <&> " }, { index: 2, text: " 完成" }]);
  assert.deepEqual(resolveElement(expected, `[data-wb-element="${INNER}"]`), { id: INNER, tag: "span" });
  assert.equal(editText(HTML, ID, 0, "确认 & ", "确认 & "), HTML);
});

test("text edits require a unique ID and the exact decoded source slot and fail atomically", () => {
  const current = bundle(), snapshot = structuredClone(current);
  for (const bad of [textOp({ expected: "stale" }), textOp({ index: 1 }), textOp({ id: OTHER }), textOp({ value: "\0" })]) {
    assert.throws(() => applyOperations(current, [{ op: "page.update", id: "p1", set: { name: "未落盘" } }, bad]));
    assert.deepEqual(current, snapshot);
  }
  assert.throws(() => editText(`${HTML}<b data-wb-element="${ID}">重复</b>`, ID, 0, "确认 & ", "x"), /唯一/);
});

test("inline style edits preserve other declarations and all source outside the attribute", () => {
  const source = HTML.replace('class="main"', 'class="main" style=\'--hint:"a;b"; display:flex; color: red; color:blue !important; padding: 2px\'');
  const changed = editStyle(source, ID, "color", "#2563eb");
  assert.ok(changed.includes('--hint:&quot;a;b&quot;; display:flex; padding: 2px; color: #2563eb !important;'));
  assert.equal(changed.slice(changed.indexOf(">确认")), source.slice(source.indexOf(">确认")));
  assert.equal(changed.slice(0, changed.indexOf("style=")), source.slice(0, source.indexOf("style=")));
  assert.equal(listElements(changed).find(item => item.id === ID).styles.color, "#2563eb");
  assert.equal(editStyle(changed, ID, "color", "#2563eb"), changed);
  const removed = editStyle(changed, ID, "color", "");
  assert.equal(listElements(removed).find(item => item.id === ID).styles.color, "");
  assert.ok(removed.includes("display:flex"));
  assert.ok(removed.includes(script));
  assert.throws(() => editStyle(HTML.replace('class="main"', 'style="color:red; /*unfinished"'), ID, "color", "blue"), /无法局部解析/);
});

test("style editing supports the native 17 properties and rejects injected or complex values", () => {
  assert.equal(STYLE_FIELDS.length, 17);
  const values = ["16px", "600", "1.5", "rgba(0, 20, 255, 0.5)", "center", "transparent", "#ddd", "1px 2px", "solid", "8px 4px", "1rem", "2%", "0", ".5em", "8px 12px", "100%", "auto"];
  let html = HTML;
  STYLE_FIELDS.forEach((property, index) => { html = editStyle(html, ID, property, values[index]); });
  const styles = listElements(html).find(item => item.id === ID).styles;
  STYLE_FIELDS.forEach((property, index) => assert.equal(styles[property], values[index], property));
  for (const value of ["url(https://invalid.test)", "red;background:url(x)", "expression(alert(1))", "var(--color)", "calc(100% - 2px)", "red!important", "red/*x*/", "#xyz", "rgba(300,0,0,1)"]) assert.throws(() => editStyle(HTML, ID, "color", value));
  assert.throws(() => editStyle(HTML, ID, "position", "fixed"), /不支持/);
  assert.throws(() => editText(`<iframe data-wb-element="${ID}">fallback</iframe>`, ID, 0, "fallback", "<x>"), /不支持局部编辑/);
});

test("HTML patch stamps new IDs once; check, diff and payload never generate IDs", () => {
  let current = bundle([]);
  current = applyOperations(current, [{ op: "page.add", id: "p1", value: page("p1", "<main><button>新建</button></main>") }]);
  const html = current.draft.workspace.pages[0].html, snapshot = structuredClone(current);
  assert.equal(listElements(html).length, 2);
  for (let i = 0; i < 3; i++) { assert.equal(checkBundle(current).errors.length, 0); diffBundle(current); payloadForApply(current); }
  assert.deepEqual(current, snapshot);
  const updated = applyOperations(current, [{ op: "page.update", id: "p1", set: { html: `${html}<footer>新增</footer>` } }]);
  assert.equal(updated.draft.workspace.pages[0].source, `${ENTRY}/原型设计/订单.html`);
  assert.deepEqual(listElements(updated.draft.workspace.pages[0].html).slice(0, 2).map(item => item.id), listElements(html).map(item => item.id));
  const manual = structuredClone(updated); manual.draft.workspace.pages[0].html += "<aside>手工插入</aside>";
  assert.ok(checkBundle(manual).errors.some(error => error.code === "MISSING_ELEMENT_ID"));
  const manualBefore = structuredClone(manual); checkBundle(manual); diffBundle(manual); assert.deepEqual(manual, manualBefore);
});

test("page metadata, note timestamps and server versions are read only", () => {
  const original = note(); original.createdAt = "created"; original.updatedAt = "updated";
  const current = bundle([page()], [original]);
  for (const operation of [
    { op: "page.update", id: "p1", set: { id: "p2" } },
    { op: "page.update", id: "p1", set: { revision: 99 } },
    { op: "note.update", id: "n1", set: { createdAt: "later" } },
    { op: "page.update", id: "p1", unset: ["id"] },
    { op: "page.update", id: "p1", set: { name: "X" }, unset: ["name"] },
  ]) assert.throws(() => applyOperations(current, [operation]));
  const version = structuredClone(current); version.draft.workspace.revision++;
  assert.ok(checkBundle(version).errors.some(error => /不可修改/.test(error.message)));
  const timestamp = structuredClone(current); timestamp.draft.annotations.notes[0].updatedAt = "later";
  assert.ok(checkBundle(timestamp).errors.some(error => /服务端维护/.test(error.message)));
  const unknown = structuredClone(current); unknown.draft.workspace.pages[0].extra = true;
  assert.ok(checkBundle(unknown).errors.some(error => /不支持字段 extra/.test(error.message)));
});

test("design notes can be edited while flow notes are strictly passed through", () => {
  const flowNote = { id: "flow-note", target: { type: "flow-node", flowId: "flow1", nodeId: "node1" }, text: "流程说明", requirements: [] };
  const current = bundle([page()], [note(), flowNote]);
  const next = applyOperations(current, [{ op: "note.update", id: "n1", set: { text: "更新页面说明" } }]);
  assert.deepEqual(next.draft.annotations.notes[1], flowNote);
  for (const operation of [
    { op: "note.update", id: "flow-note", set: { text: "X" } },
    { op: "note.remove", id: "flow-note" },
    { op: "note.add", id: "new-flow-note", value: { ...flowNote, id: "new-flow-note" } },
    { op: "note.update", id: "n1", set: { target: flowNote.target } },
  ]) assert.throws(() => applyOperations(current, [operation]));
  for (const mutate of [draft => draft.annotations.notes.pop(), draft => { draft.annotations.notes[1].text = "改动"; }, draft => { draft.annotations.notes[0].target = flowNote.target; }]) {
    const manual = structuredClone(current); mutate(manual.draft);
    assert.ok(checkBundle(manual).errors.some(error => error.code === "FLOW_NOTE_READONLY"));
  }
});

test("referenced pages cannot be removed; a historical missing reference is only a warning", () => {
  const context = { flowLinks: [{ flowId: "f1", nodeId: "n1", pageId: "p1" }] };
  const current = bundle([page()], [], context);
  assert.throws(() => applyOperations(current, [{ op: "page.remove", id: "p1" }]), error => error.details.some(item => item.code === "FLOW_PAGE_REFERENCE"));
  const legacy = bundle([], [], context);
  assert.equal(checkBundle(legacy).errors.length, 0);
  assert.equal(checkBundle(legacy).warnings[0].code, "FLOW_PAGE_REFERENCE");
});

test("HTML replacement requires explicit note migration or deletion when an annotated element disappears", () => {
  const current = bundle([page()], [note()]);
  const html = `<p data-wb-element="${OTHER}">迁移目标</p>`;
  const replacement = { op: "page.update", id: "p1", set: { html } };
  assert.throws(() => applyOperations(current, [replacement]), error => error.details.some(item => item.code === "ORPHAN_NOTE"));
  const target = createPageNote(page("p1", html), OTHER, { id: "n1", text: "保留说明" }).target;
  const migrated = applyOperations(current, [replacement, { op: "note.update", id: "n1", set: { target } }]);
  assert.equal(migrated.draft.annotations.notes[0].target.anchor.elementId, OTHER);
  assert.equal(migrated.draft.annotations.notes[0].text, "保留说明");
  const removed = applyOperations(current, [{ op: "page.remove", id: "p1" }, { op: "note.remove", id: "n1" }]);
  assert.deepEqual(payloadForApply(removed).pages, []);
  assert.deepEqual(payloadForApply(removed).notes, []);
  const duplicated = HTML.replace("</body>", `<b data-wb-element="${ID}">副本</b></body>`);
  assert.throws(() => applyOperations(current, [{ op: "page.update", id: "p1", set: { html: duplicated } }]), error => error.details.some(item => item.code === "ORPHAN_NOTE"));
});

test("new orphan notes fail while historical missing elements remain visible as warnings", () => {
  const orphan = note(); orphan.target.pageId = "missing";
  const historical = bundle([page()], [orphan]);
  assert.equal(checkBundle(historical).errors.length, 0);
  assert.ok(checkBundle(historical).warnings.some(item => item.code === "ORPHAN_NOTE"));
  const current = bundle();
  assert.throws(() => applyOperations(current, [{ op: "note.add", id: orphan.id, value: orphan }]), error => error.details.some(item => item.code === "ORPHAN_NOTE"));
  const invalidSelector = note(); invalidSelector.target.anchor = { selector: "button[", tag: "button", label: "", htmlHash: htmlFingerprint(HTML), contextHash: "", strength: "stable" };
  assert.throws(() => applyOperations(current, [{ op: "note.add", id: "n1", value: invalidSelector }]));
});

test("legacy path annotations honor page fingerprints and require explicit rebinding after HTML changes", () => {
  const legacy = note();
  legacy.target.anchor = { selector: "body > button", tag: "button", label: "确认 & 订单 完成", htmlHash: htmlFingerprint(HTML), contextHash: "", strength: "path" };
  const current = bundle([page()], [legacy]);
  assert.equal(checkBundle(current).errors.length, 0);
  assert.throws(() => applyOperations(current, [textOp()]), error => error.details.some(item => item.code === "ORPHAN_NOTE"));
  const updatedHTML = editText(HTML, ID, 0, "确认 & ", "提交 <&> ");
  const stable = createPageNote(page("p1", updatedHTML), ID, { id: "n1", text: "保留说明" });
  const next = applyOperations(current, [textOp(), { op: "note.update", id: "n1", set: { target: stable.target } }]);
  assert.equal(next.draft.annotations.notes[0].target.anchor.strength, "stable");
});

test("created notes carry stable anchors, page route and the browser-compatible fingerprint", () => {
  const requirement = { file: `${ENTRY}/需求文档.md`, blockId: "rule-abc", quote: "用户确认订单", heading: "验收" };
  const item = createPageNote(page(), ID, { id: "note-new", text: "说明", requirements: [requirement] });
  assert.equal(item.target.anchor.htmlHash, htmlFingerprint(HTML));
  assert.equal(item.target.anchor.selector, `[data-wb-element="${ID}"]`);
  assert.equal(item.target.route, "#orders");
  assert.equal(item.target.anchor.label, "确认 & 订单 完成");
  item.requirements[0].quote = "changed copy";
  assert.equal(requirement.quote, "用户确认订单");
  assert.equal(checkBundle(applyOperations(bundle(), [{ op: "note.add", id: item.id, value: item }])).errors.length, 0);
});

test("diff reports changed page fields and HTML hashes without dumping source scripts", () => {
  const current = bundle(), next = applyOperations(current, [textOp(), { op: "page.update", id: "p1", set: { width: 1440 } }]);
  const diff = diffBundle(next), html = diff.changes.find(change => change.field === "html");
  assert.deepEqual(diff.changed, { design: true, annotations: false });
  assert.deepEqual(diff.summary.pages, { added: [], removed: [], updated: ["p1"] });
  assert.equal(html.before.length, HTML.length);
  assert.match(html.before.sha256, /^[a-f0-9]{64}$/);
  assert.equal(html.elementChanges[0].id, ID);
  assert.equal(diff.changes.find(change => change.field === "width").after, 1440);
  assert.ok(!JSON.stringify(diff).includes("window.x"));
  const added = diffBundle(applyOperations(bundle([]), [{ op: "page.add", id: "p1", value: page() }]));
  assert.equal(typeof added.changes[0].after.html, "object");
  assert.ok(!JSON.stringify(added).includes("window.x"));
  const long = bundle([page("p1", `<p data-wb-element="${ID}">${"a".repeat(10000)}</p>`)]);
  const shortened = applyOperations(long, [{ op: "element.text", pageId: "p1", id: ID, index: 0, expected: "a".repeat(10000), value: "short" }]);
  const longDiff = diffBundle(shortened);
  assert.ok(JSON.stringify(longDiff).length < 2000);
  assert.equal(longDiff.changes[0].elementChanges[0].before.texts[0].length, 10000);
});
