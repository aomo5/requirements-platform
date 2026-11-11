"use strict";

const parse5 = require("parse5");
const { resolveElement } = require("./stable-identities");

const ELEMENT_ID = /^el-[a-f0-9-]{36}$/;
const FORBIDDEN = /^(script|style|head|meta|link|base|title|noscript|template|html|body|xmp|iframe|noembed|noframes|plaintext)$/;
const STAMP_EXCLUDED = /^(html|head|body|script|style|meta|link|title|base|template)$/;
const STYLE_FIELDS = ["font-size", "font-weight", "line-height", "color", "text-align", "background-color", "border-color", "border-width", "border-style", "border-radius", "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "width", "height"];
const attribute = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const escapeText = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = value => escapeText(value).replace(/"/g, "&quot;");

class ElementEditError extends Error { constructor(message) { super(message); this.name = "ElementEditError"; this.status = 400; } }
function assert(test, message) { if (!test) throw new ElementEditError(message); }
function parse(html) {
  assert(typeof html === "string", "页面 HTML 必须是字符串");
  const document = parse5.parse(html, { sourceCodeLocationInfo: true }), all = [];
  function visit(node) { if (node.tagName) all.push(node); for (const child of node.childNodes || []) visit(child); if (node.content) visit(node.content); }
  visit(document);
  return all;
}
function find(html, id) {
  assert(ELEMENT_ID.test(id || ""), "元素 ID 无效");
  const matches = parse(html).filter(node => attribute(node, "data-wb-element") === id);
  assert(matches.length === 1, "元素 ID 不存在或不唯一，请重新读取页面");
  const node = matches[0];
  assert(!FORBIDDEN.test(node.tagName) && node.sourceCodeLocation?.startTag, "该元素不支持局部编辑");
  return node;
}

// Split only on declaration boundaries; existing strings, comments and functions
// remain opaque. The selected style attribute is the only rewritten source span.
function declarations(style, strict = false) {
  const parts = []; let start = 0, quote = "", comment = false, depth = 0;
  for (let i = 0; i < style.length; i++) {
    const char = style[i], next = style[i + 1];
    if (comment) { if (char === "*" && next === "/") { comment = false; i++; } continue; }
    if (quote) { if (char === "\\") i++; else if (char === quote) quote = ""; continue; }
    if (char === "/" && next === "*") { comment = true; i++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth++;
    else if (char === ")") { depth--; if (strict) assert(depth >= 0, "现有内联样式无法局部解析，请通过 page.update 的 html 编辑"); }
    else if (char === ";" && !depth) { parts.push(style.slice(start, i + 1)); start = i + 1; }
  }
  if (strict) assert(!quote && !comment && depth === 0, "现有内联样式无法局部解析，请通过 page.update 的 html 编辑");
  if (start < style.length) parts.push(style.slice(start));
  return parts.map(raw => {
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const match = cleaned.match(/^\s*([a-z-]+)\s*:\s*([\s\S]*?);?\s*$/i);
    return { raw, property: match?.[1].toLowerCase() || "", value: match?.[2].replace(/;\s*$/, "").trim() || "" };
  });
}
function styleValues(node) {
  const result = Object.fromEntries(STYLE_FIELDS.map(property => [property, ""])), priorities = new Set();
  for (const declaration of declarations(attribute(node, "style") || "")) {
    if (!STYLE_FIELDS.includes(declaration.property)) continue;
    const important = /\s*!important\s*$/i.test(declaration.value);
    if (priorities.has(declaration.property) && !important) continue;
    result[declaration.property] = declaration.value.replace(/\s*!important\s*$/i, "");
    if (important) priorities.add(declaration.property);
  }
  return result;
}
function listElements(html) {
  const all = parse(html), counts = new Map();
  for (const node of all) { const id = attribute(node, "data-wb-element"); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  return all.filter(node => !FORBIDDEN.test(node.tagName) && node.sourceCodeLocation?.startTag && ELEMENT_ID.test(attribute(node, "data-wb-element") || "")).map(node => ({
    id: attribute(node, "data-wb-element"), tag: node.tagName,
    ...(counts.get(attribute(node, "data-wb-element")) > 1 ? { duplicate: true } : {}),
    texts: (node.childNodes || []).flatMap((child, index) => child.nodeName === "#text" && child.value.trim() ? [{ index, text: child.value }] : []),
    styles: styleValues(node),
  }));
}
function identityProblems(html) {
  const all = parse(html), counts = new Map(), issues = [];
  for (const node of all) { const id = attribute(node, "data-wb-element"); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  for (const node of all) {
    if (STAMP_EXCLUDED.test(node.tagName) || !node.sourceCodeLocation?.startTag) continue;
    const id = attribute(node, "data-wb-element");
    if (!ELEMENT_ID.test(id || "")) issues.push({ code: "MISSING_ELEMENT_ID", id: id || "", offset: node.sourceCodeLocation.startOffset, tag: node.tagName });
    else if (counts.get(id) !== 1) issues.push({ code: "DUPLICATE_ELEMENT_ID", id, offset: node.sourceCodeLocation.startOffset, tag: node.tagName });
  }
  return issues;
}
function editText(html, id, index, expected, value) {
  const node = find(html, id), child = node.childNodes?.[index];
  assert(Number.isInteger(index) && index >= 0 && typeof expected === "string" && child?.nodeName === "#text" && child.value === expected, "文字来源已变化，请重新读取元素及文字槽位");
  assert(typeof value === "string" && value.length <= 10000 && !value.includes("\0"), "文字最多 10000 个字符，且不能含 NUL");
  if (expected === value) return html;
  const loc = child.sourceCodeLocation;
  assert(loc && Number.isInteger(loc.startOffset) && Number.isInteger(loc.endOffset), "该文字没有可编辑源码位置");
  return html.slice(0, loc.startOffset) + escapeText(value) + html.slice(loc.endOffset);
}

const length = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt))$/i;
const colorNames = new Set("transparent currentcolor black silver gray white maroon red purple fuchsia green lime olive yellow navy blue teal aqua orange rebeccapurple pink brown cyan magenta grey darkgray lightgray darkgrey lightgrey whitesmoke slategray slategrey darkslategray lightslategray gainsboro aliceblue antiquewhite beige bisque blanchedalmond blueviolet burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson darkblue darkcyan darkgoldenrod darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ghostwhite gold goldenrod greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategrey lightsteelblue lightyellow limegreen linen mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite oldlace olivedrab orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru plum powderblue rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna skyblue slateblue snow springgreen steelblue tan thistle tomato turquoise violet wheat yellowgreen aquamarine".split(" "));
function validColor(value) {
  if (colorNames.has(value.toLowerCase()) || /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return true;
  const rgb = value.match(/^(rgb|rgba)\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.]+%?))?\s*\)$/i);
  if (!rgb || (rgb[1].toLowerCase() === "rgba") !== (rgb[5] !== undefined)) return false;
  const validNumber = (text, max) => /^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(text) && Number.parseFloat(text) <= (text.endsWith("%") ? 100 : max);
  return rgb.slice(2, 5).every(value => validNumber(value, 255)) && (rgb[5] === undefined || validNumber(rgb[5], 1));
}
function validateStyle(property, value) {
  assert(STYLE_FIELDS.includes(property), "该样式暂不支持编辑");
  assert(typeof value === "string" && value.length <= 300, "样式值必须是最多 300 字符的字符串");
  value = value.trim();
  if (!value) return value;
  assert(!/url\s*\(|[;{}<>\\]|\/\*|[\x00-\x1f]/i.test(value), "样式值不允许 URL、转义或注入语法");
  const tokens = value.split(/\s+/), global = /^(inherit|initial|unset|revert|revert-layer)$/i.test(value);
  let valid = global;
  if (["color", "background-color", "border-color"].includes(property)) valid ||= validColor(value) || (property === "border-color" && tokens.length <= 4 && tokens.every(validColor));
  else if (property === "font-weight") valid ||= /^(normal|bold|bolder|lighter|[1-9]\d{0,2}|1000)$/i.test(value);
  else if (property === "text-align") valid ||= /^(left|right|center|justify|start|end|match-parent)$/i.test(value);
  else if (property === "border-style") valid ||= tokens.length <= 4 && tokens.every(token => /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i.test(token));
  else if (property === "border-width") valid ||= tokens.length <= 4 && tokens.every(token => (length.test(token) && !token.endsWith("%")) || /^(thin|medium|thick)$/i.test(token));
  else if (property === "border-radius") valid ||= tokens.length <= 4 && tokens.every(token => length.test(token));
  else if (property === "gap") valid ||= tokens.length <= 2 && tokens.every(token => length.test(token) || token === "normal");
  else if (property === "line-height") valid ||= length.test(value) || /^(normal|\d+(?:\.\d+)?|\.\d+)$/i.test(value);
  else if (property === "font-size") valid ||= length.test(value) || /^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i.test(value);
  else if (["width", "height"].includes(property)) valid ||= length.test(value) || /^(auto|min-content|max-content|fit-content|stretch)$/i.test(value);
  else valid ||= length.test(value);
  assert(valid, "不支持此样式值；局部样式编辑接受常见长度、颜色和枚举，复杂 CSS 请通过 page.update 的 html 编辑");
  return value;
}
function editStyle(html, id, property, value) {
  const node = find(html, id); value = validateStyle(property, value);
  const oldStyle = attribute(node, "style") || "", parts = declarations(oldStyle, true);
  const selected = parts.filter(part => part.property === property);
  if ((!value && !selected.length) || (selected.length === 1 && selected[0].value === `${value} !important`)) return html;
  const retained = parts.filter(part => part.property !== property).map(part => part.raw).join("");
  const style = value ? `${retained}${retained.trim() && !retained.trimEnd().endsWith(";") ? ";" : ""}${retained && !/\s$/.test(retained) ? " " : ""}${property}: ${value} !important;` : retained;
  const loc = node.sourceCodeLocation.attrs?.style;
  if (loc) return html.slice(0, loc.startOffset) + `style="${escapeAttribute(style)}"` + html.slice(loc.endOffset);
  const at = node.sourceCodeLocation.startTag.startOffset + 1 + node.tagName.length;
  return html.slice(0, at) + ` style="${escapeAttribute(style)}"` + html.slice(at);
}
function htmlFingerprint(html) { let hash = 2166136261; for (let i = 0; i < html.length; i++) { hash ^= html.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
function createPageNote(page, elementId, { id, text = "", requirements = [] }) {
  const node = find(page.html, elementId), selector = `[data-wb-element="${elementId}"]`;
  assert(resolveElement(page.html, selector), "元素不在可定位的页面内容中");
  const textContent = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(textContent).join("");
  const label = (attribute(node, "aria-label") || attribute(node, "placeholder") || attribute(node, "alt") || textContent(node) || attribute(node, "name") || node.tagName).replace(/\s+/g, " ").trim().slice(0, 160);
  return { id, target: { type: "page-element", pageId: page.id, route: page.route || "", anchor: { elementId, selector, tag: node.tagName, label, htmlHash: htmlFingerprint(page.html), contextHash: "", strength: "stable" } }, text, requirements: structuredClone(requirements) };
}

module.exports = { STYLE_FIELDS, ElementEditError, listElements, identityProblems, editText, editStyle, htmlFingerprint, createPageNote };
