"use strict";

const fs = require("fs");
const path = require("path");
const { escapeHtml } = require("./markdown");

function normalizeFile(file) {
  if (typeof file !== "string" || !file || file.length > 2000 || file.includes("\\") || file.includes("\0")) return null;
  if (path.posix.isAbsolute(file) || /^[a-z]:/i.test(file)) return null;
  const normalized = path.posix.normalize(file);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")
    || normalized.split("/").some((part) => part.startsWith("."))) return null;
  return normalized;
}

function safeFile(root, file) {
  const normalized = normalizeFile(file);
  if (!normalized) return null;
  let cursor = root;
  try {
    for (const part of normalized.split("/")) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    return fs.statSync(cursor).isFile() ? cursor : null;
  } catch {
    return null;
  }
}

function allEntries(tree) {
  return (tree.modules || []).flatMap((module) => module.features || []);
}

function listedDocument(entry, file) {
  return Object.values(entry.docs || {}).includes(file)
    || (entry.pageDesigns || []).some((document) => document.path === file)
    || (entry.referenceDocuments || []).some(document => document.path === file);
}

function documentEntry(tree, file) {
  const normalized = normalizeFile(file);
  if (!normalized || !/\.md$/i.test(normalized)) return null;
  const entries = allEntries(tree);
  return entries.find((entry) => listedDocument(entry, normalized))
    || entries.filter((entry) => normalized.startsWith(`${entry.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0]
    || null;
}

function readableDocument(root, tree, file) {
  const normalized = normalizeFile(file);
  const entry = documentEntry(tree, normalized);
  if (entry?.documentFiles?.[normalized]?.storage === 'mysql' || entry?.document?.storage === 'mysql' && normalized === entry.docs?.requirement) return {file:normalized,fullPath:null,entry};
  const fullPath = entry && safeFile(root, normalized);
  return fullPath ? { file: normalized, fullPath, entry } : null;
}

function unescapeAttribute(value) {
  return value.replace(/&(amp|quot|lt|gt|#39);/g, (_, entity) => ({ amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'" }[entity]));
}

function rewriteDocumentLinks(html, { root, tree, sourceFile }) {
  const sourceEntry = documentEntry(tree, sourceFile);
  return html.replace(/<a href="([^"]*)"[^>]*>/g, (_, encodedHref) => {
    const href = unescapeAttribute(encodedHref).trim();
    // Old document links may name the author's loopback workbench. Keep
    // navigation on the reader's origin without rewriting the saved original.
    if (/^https?:/i.test(href)) {
      try { const url=new URL(href);
        if(['localhost','127.0.0.1','[::1]'].includes(url.hostname) && ['8125','8806'].includes(url.port)
          && (url.pathname==='/' || /^\/(?:design|flow)(?:\/|$)/.test(url.pathname) || /^\/(?:preview\/|download\/doc$)/.test(url.pathname)))
          return `<a href="${escapeHtml(url.pathname+url.search+url.hash)}">`;
      } catch { /* Leave malformed external links to the normal renderer. */ }
    }
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">`;
    }
    if (href.startsWith("#")) return `<a href="${escapeHtml(href)}">`;
    // Existing application links are already addressed to the portal.
    if (/^\/(?:#|(?:design|flow)(?:\?|$)|preview\/)/.test(href)) return `<a href="${escapeHtml(href)}">`;
    let target;
    const fragmentIndex = href.indexOf("#");
    const fragment = fragmentIndex >= 0 ? href.slice(fragmentIndex + 1) : "";
    const withoutFragment = fragmentIndex >= 0 ? href.slice(0, fragmentIndex) : href;
    const queryIndex = withoutFragment.indexOf("?");
    const filePart = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
    const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex) : "";
    try {
      if (!/^[a-z][a-z\d+.-]*:/i.test(filePart) && !filePart.startsWith("/")) {
        target = normalizeFile(path.posix.join(path.posix.dirname(sourceFile), decodeURIComponent(filePart)));
      }
    } catch { /* Malformed escaped paths are not clickable. */ }
    if (target && /\.md$/i.test(target)) {
      const document = readableDocument(root, tree, target);
      if (document && (listedDocument(document.entry, target) || document.entry.path === sourceEntry?.path)) {
        const params = new URLSearchParams({ path: document.entry.path, view: "doc", file: target });
        if (fragment) params.set("heading", fragment);
        return `<a href="${escapeHtml(`/#${params}`)}">`;
      }
    } else if (target) {
      const prototype = allEntries(tree).flatMap((entry) => entry.prototypes || []).find((item) => item.path === target);
      if (prototype && safeFile(root, target)) {
        const previewUrl = `${prototype.previewUrl}${query}${fragment ? `#${fragment}` : ""}`;
        return `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">`;
      }
    }
    return '<a aria-disabled="true" title="该本地文件不在可阅读的需求资料范围内">';
  });
}

module.exports = { readableDocument, rewriteDocumentLinks, listedDocument };
