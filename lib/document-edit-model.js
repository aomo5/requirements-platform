"use strict";
const { CliError, localOrigin } = require("./workbench-cli-client");
const FORMAT = "workbench-document-edit/v1";
const bytes = value => Buffer.byteLength(value);
function validate(b) {
  if (!b || b.format !== FORMAT || localOrigin(b.origin) !== b.origin || typeof b.entryPath !== "string"
    || b.entryPath.split("/").some(x => !x || x === "." || x === "..") || /[\\\x00-\x1f]/.test(b.entryPath)
    || typeof b.documentFile !== "string" || /[\\\x00-\x1f]/.test(b.documentFile)
    || !b.documentFile.startsWith(b.entryPath + "/") || b.documentFile.split("/").some(x => !x || x === ".." || x === ".")
    || !b.documentFile.endsWith(".md") || !Number.isInteger(b.base?.revision) || b.base.revision < 0
    || typeof b.base.content !== "string" || typeof b.draft?.content !== "string" || bytes(b.draft.content) > 2 * 1024 * 1024) {
    throw new CliError("文档草稿格式无效或正文超过 2 MB", 422);
  }
  return b;
}
function bundle(origin, entryPath, documentFile, data) {
  const content = data.editorContent ?? data.content ?? "";
  return validate({ format: FORMAT, origin, entryPath, documentFile, base: { revision: data.revision, content }, draft: { content } });
}
function diff(b) {
  validate(b); const before = b.base.content, after = b.draft.content;
  let start = 0, end = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end < Math.min(before.length, after.length) - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { changed: before !== after, beforeBytes: bytes(before), afterBytes: bytes(after),
    firstChangedLine: before.slice(0, start).split("\n").length,
    removed: before.slice(start, before.length - end).slice(0, 4000), added: after.slice(start, after.length - end).slice(0, 4000),
    truncated: Math.max(before.length, after.length) - start - end > 4000 };
}
module.exports = { validate, bundle, diff };
