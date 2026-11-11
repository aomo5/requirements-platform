"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDesignStore, validatePages } = require("../lib/design-store");
const { scanRequirements } = require("../lib/scan");

const pages = (count) => Array.from({ length: count }, (_, i) => ({
  platform: "Web 后台", group: `业务页面 ${Math.floor(i / 5)}`, id: `page-${i + 1}`, name: `页面 ${i + 1}`, width: 390, height: 844,
  x: i * 400, y: 0, html: `<h1>页面 ${i + 1}</h1>`, source: "", route: "",
}));

test("100 design pages are accepted; page 101 is rejected", () => {
  const entry = { path: "00-测试/画板数量" };
  assert.equal(validatePages(pages(100), entry).length, 100);
  assert.throws(() => validatePages(pages(101), entry), /最多保存 100 个页面/);
});

test("100 pages survive save, reload and requirement scanning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-page-limit-"));
  const entryPath = "00-测试/画板数量";
  const dir = path.join(root, entryPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "需求文档.md"), "# 画板数量\n");
  const find = (p) => scanRequirements(root).modules.flatMap(m => m.features).find(e => e.path === p);
  const store = createDesignStore(root, find);
  try {
    const saved = store.save(entryPath, 0, pages(100));
    assert.equal(saved.pages.length, 100);
    assert.equal(store.read(entryPath).workspace.pages.length, 100);
    assert.equal(store.read(entryPath).workspace.pages[99].group, "业务页面 19");
    assert.equal(find(entryPath).design.pages.length, 100);
    assert.throws(() => store.save(entryPath, saved.revision, pages(101)), /最多保存 100 个页面/);
    assert.equal(store.read(entryPath).workspace.revision, saved.revision);
    assert.equal(store.read(entryPath).workspace.pages.length, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
