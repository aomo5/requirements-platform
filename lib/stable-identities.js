"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const parse5 = require("parse5"), css = require("css-select");
const { renderMarkdown } = require("./markdown");
const { decorateRequirementRules } = require("./requirement-rules");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const elementAttribute = "data-wb-element";
const elementId = /^el-[a-f0-9-]{36}$/;

// Source comments survive text edits, reordering and heading changes. They are
// metadata, not content hashes. Existing hashes become permanent IDs on import.
function prepareMarkdown(raw, file, { legacyIds = false } = {}) {
  const before = decorateRequirementRules(renderMarkdown(raw, { trackSource: true }), file).rules;
  const lines = raw.split(/\r?\n/), newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const used = new Set(before.filter(rule => rule.stable).map(rule => rule.blockId));
  for (const rule of before) {
    if (rule.stable || !Number.isInteger(rule.sourceLine)) continue;
    let id = legacyIds ? rule.blockId : `rule-${crypto.randomUUID()}`;
    if (used.has(id)) id = `rule-${crypto.randomUUID()}`;
    used.add(id);
    const marker = ` <!-- wb-rule:${id} -->`;
    const i = rule.sourceLine;
    lines[i] = rule.tag === "tr" ? lines[i].replace(/\|(\s*)$/, `${marker} |$1`) : lines[i] + marker;
  }
  const content = lines.join(newline);
  const after = decorateRequirementRules(renderMarkdown(content), file);
  if (JSON.stringify(before.map(r => [r.quote, r.heading])) !== JSON.stringify(after.rules.map(r => [r.quote, r.heading]))) throw new Error(`固定编号改变了需求正文：${file}`);
  return { content, ...after };
}
function atomicWrite(file, content, expected) {
  if (expected !== undefined && fs.readFileSync(file, "utf8") !== expected) throw Object.assign(new Error("文件已被其他编辑器修改，请重试"), { status: 409 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", fs.existsSync(file) ? fs.statSync(file).mode : 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function elements(html) {
  const document = parse5.parse(html, { sourceCodeLocationInfo: true });
  const all = [];
  function walk(node) { if (node.tagName) all.push(node); for (const child of node.childNodes || []) walk(child); if (node.content) walk(node.content); }
  walk(document); return { document, all };
}
const attribute = (node, name) => node.attrs?.find(item => item.name === name)?.value;
function stampElements(html) {
  const { all } = elements(html), counts = new Map(), edits = [];
  for (const node of all) { const id = attribute(node, elementAttribute); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  for (const node of all) {
    if (/^(html|head|body|script|style|meta|link|title|base|template)$/.test(node.tagName) || !node.sourceCodeLocation?.startTag) continue;
    const id = attribute(node, elementAttribute);
    if (id && elementId.test(id) && counts.get(id) === 1) continue;
    const value = `el-${crypto.randomUUID()}`;
    const loc = node.sourceCodeLocation.attrs?.[elementAttribute];
    if (loc) edits.push({ start: loc.startOffset, end: loc.endOffset, value: `${elementAttribute}="${value}"` });
    else {
      const start = node.sourceCodeLocation.startTag.startOffset + 1 + node.tagName.length;
      edits.push({ start, end: start, value: ` ${elementAttribute}="${value}"` });
    }
  }
  // Keep scripts, CSS, whitespace and original source formatting byte-for-byte.
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  return html;
}
const adapter = {
  isTag: node => !!node.tagName, getChildren: node => node.childNodes || [], getParent: node => node.parentNode,
  getSiblings: node => node.parentNode?.childNodes || [node], getName: node => node.tagName,
  getAttributeValue: attribute, hasAttrib: (node, name) => attribute(node, name) !== undefined,
  getText: node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(child => adapter.getText(child)).join(""),
  removeSubsets: nodes => nodes.filter(node => !nodes.some(other => { for (let p = node.parentNode; p; p = p.parentNode) if (p === other) return true; return false; })),
  existsOne: (test, nodes) => nodes.some(node => adapter.isTag(node) && (test(node) || adapter.existsOne(test, adapter.getChildren(node)))),
  findAll: (test, nodes) => nodes.flatMap(node => [...(adapter.isTag(node) && test(node) ? [node] : []), ...adapter.findAll(test, adapter.getChildren(node))]),
  findOne: (test, nodes) => { for (const node of nodes) { if (adapter.isTag(node) && test(node)) return node; const found = adapter.findOne(test, adapter.getChildren(node)); if (found) return found; } return null; },
  equals: (a, b) => a === b,
};
function resolveElement(html, selector) {
  try { const { document } = elements(html); const found = css.selectAll(selector, document, { adapter }); return found.length === 1 ? { id: attribute(found[0], elementAttribute), tag: found[0].tagName } : null; }
  catch { return null; }
}
function elementRecords(html) { return elements(html).all.filter(node => elementId.test(attribute(node, elementAttribute) || "")).map(node => ({ id: attribute(node, elementAttribute), tag: node.tagName })); }
module.exports = { sha, prepareMarkdown, atomicWrite, stampElements, resolveElement, elementRecords };
