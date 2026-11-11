"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { escapeHtml, renderMarkdown } = require("./markdown");
const { findEntryByPath } = require("./scan");
const { readableDocument } = require("./document-links");

const MAX_QUOTE_LENGTH = 4000;
const MAX_HEADING_LENGTH = 1000;

function decodeText(value) {
  return value.replace(/&(amp|quot|lt|gt|#39|nbsp|#\d+|#x[a-f\d]+);/gi, (match, entity) => {
    const named = { amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'", nbsp: " " };
    if (Object.hasOwn(named, entity.toLowerCase())) return named[entity.toLowerCase()];
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function plainText(html) {
  // The input is our Markdown renderer's HTML, never an arbitrary document.
  return decodeText(html.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ").trim();
}

function decorateRequirementRules(html, file) {
  const headings = [], counts = new Map(), idCounts = new Map(), rules = [];
  const decorated = html.replace(/<(h[1-6]|p|li|tr)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (block, tag, attributes = "", content) => {
    const level = /^h([1-6])$/.exec(tag)?.[1];
    const existingId = /\bid="([^"]*)"/.exec(attributes)?.[1];
    const marker = /<span data-wb-rule-id="(rule-[a-zA-Z0-9_-]{1,75})" hidden><\/span>/.exec(content)?.[1];
    content = content.replace(/<span data-wb-rule-id="rule-[a-zA-Z0-9_-]{1,75}" hidden><\/span>/g, "");
    let quote;
    if (tag === "tr") {
      // Column labels provide context but are not requirement statements.
      if (/<th(?:\s|>)/.test(content)) return block;
      quote = [...content.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map((cell) => plainText(cell[1])).join(" | ");
    } else quote = plainText(content);
    if (level) {
      headings.length = Number(level) - 1;
      headings[Number(level) - 1] = { title: quote, id: decodeText(existingId || "") };
      return block;
    }
    if (!quote || quote.length > MAX_QUOTE_LENGTH) return block;
    const context = headings.filter(Boolean);
    const heading = context.at(-1)?.title.slice(0, MAX_HEADING_LENGTH) || "";
    const headingId = context.at(-1)?.id || "";
    const digest = crypto.createHash("sha256").update(JSON.stringify([context.map((item) => item.title), quote])).digest("hex");
    const occurrence = (counts.get(digest) || 0) + 1;
    counts.set(digest, occurrence);
    const blockId = marker || `rule-${digest}${occurrence > 1 ? `-${occurrence}` : ""}`;
    idCounts.set(blockId, (idCounts.get(blockId) || 0) + 1);
    const sourceLine = /data-wb-source-line="(\d+)"/.exec(attributes)?.[1];
    rules.push({ file, blockId, quote, heading, headingId, ...(marker ? { stable: true } : {}), ...(sourceLine === undefined ? {} : { sourceLine: Number(sourceLine), tag }) });
    // Keep existing heading anchors used by document links and the outline.
    const anchor = existingId ? `<span id="${blockId}" class="requirement-rule-anchor" aria-hidden="true"></span>` : "";
    const idAttribute = existingId ? "" : ` id="${blockId}"`;
    return `<${tag}${attributes}${idAttribute} data-rule-id="${escapeHtml(blockId)}">${anchor}${content}</${tag}>`;
  });
  // Duplicate text within the same heading context cannot identify a source
  // reliably. Keep each block addressable, but never offer it as a new link.
  for (const rule of rules) {
    const digest = rule.blockId.slice(5).replace(/-\d+$/, "");
    if (idCounts.get(rule.blockId) > 1 || !rule.stable && counts.get(digest) > 1) rule.ambiguous = true;
  }
  return { html: decorated, rules };
}

function rulesError(status, message) { const error = new Error(message); error.status = status; return error; }

function readRequirementRules(root, tree, entryPath) {
  if (typeof entryPath !== "string" || !entryPath || entryPath.length > 999 || entryPath.includes("\\")
    || /[\x00-\x1f]/.test(entryPath) || path.posix.isAbsolute(entryPath)
    || path.posix.normalize(entryPath) !== entryPath || entryPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw rulesError(400, "请选择有效的关联需求");
  }
  const entry = findEntryByPath(tree, entryPath);
  if (!entry) throw rulesError(404, "需求不存在");
  const file = entry.docs?.requirement;
  if (!file) return { file: null, rules: [] };
  const document = readableDocument(root, tree, file);
  if (!document || document.entry.path !== entry.path || file !== `${entry.path}/需求文档.md`) {
    throw rulesError(403, "主需求文档不可读取或包含符号链接");
  }
  const raw = fs.readFileSync(document.fullPath, "utf8");
  return { file: document.file, ...decorateRequirementRules(renderMarkdown(raw), document.file) };
}

module.exports = { decorateRequirementRules, readRequirementRules, MAX_QUOTE_LENGTH, MAX_HEADING_LENGTH };
