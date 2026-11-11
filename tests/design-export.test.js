"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { unzipSync } = require("fflate");
const { exportOptions, fileNames, exportHtml, renderImages, createDesignExportHandler } = require("../lib/design-export");
const entry = { path: "00-测试/画板导出", feature: "画板导出" };
const board = { id: "one", name: "订单详情", platform: "Web", width: 390, height: 380, x: 0, y: 0, source: "", route: "", html: '<!doctype html><style>body{margin:0;background:#fff;color:#111;font:16px sans-serif}</style><h1>电费 0.40 元</h1><p>服务费 0.60 元</p>' };
function handler(render) {
  return createDesignExportHandler({ read: async p => { assert.equal(p, entry.path); return { entry }; } }, {
    root: "/tmp", publicRoot: "/tmp", render,
    sendJson(res, status, data) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(Buffer.from(JSON.stringify(data))); },
  });
}
async function request(exporter, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST"; req.headers = { host: "127.0.0.1:8125", origin: "http://127.0.0.1:8125", "content-type": "application/json", "x-design-client": "workbench-v1", ...headers };
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.body = data; } };
  await exporter(req, response, new URL("http://localhost/api/design/export?path=" + encodeURIComponent(entry.path)));
  return response;
}
test("export options enforce count, format, dimensions, scale and source boundaries", () => {
  assert.equal(exportOptions({ pages: [board], format: "png", scale: 2, transparent: true }, entry).transparent, true);
  assert.equal(exportOptions({ pages: [board], format: "pdf", scale: 3, transparent: true }, entry).scale, 1);
  for (const override of [{ pages: [] }, { pages: Array(21).fill(board) }, { format: "svg" }, { scale: 1.5 }, { pages: [{ ...board, width: 2560, height: 6000 }], scale: 3 }, { pages: [{ ...board, source: "../secret.html" }] }]) {
    assert.throws(() => exportOptions({ pages: [board], format: "png", scale: 1, ...override }, entry));
  }
});
test("filenames preserve platform and Unicode while avoiding paths and collisions", () => {
  assert.deepEqual(fileNames([board, board, { ...board, platform: "运营端" }], "png"), ["Web-订单详情.png", "Web-订单详情-2.png", "运营端-订单详情.png"]);
  assert.ok(fileNames([{ ...board, name: '../wrong/\nname' }], "jpg").every(name => !/[\/\\\n]/.test(name)));
  const long = fileNames([{ ...board, name: "中文画板😀".repeat(30) }], "png")[0];
  assert.ok(Buffer.byteLength(long) < 220); assert.doesNotThrow(() => encodeURIComponent(long));
});
test("HTML preserves route and removes inherited bases and refresh redirects", () => {
  const html = exportHtml({ ...board, html: '<base href="file:///etc/"><meta http-equiv="refresh" content="0;url=/api"><h1>页面</h1>', source: entry.path + "/原型设计/a.html", route: "#after" }, "http://localhost:8125");
  assert.doesNotMatch(html, /file:|http-equiv="refresh"/);
  assert.match(html, /http:\/\/localhost:8125\/preview\//);
  assert.match(html, /location.hash="#after"/);
});
test("single PNG downloads directly and multi-page export is a ZIP with distinct names", async () => {
  const exporter = handler(async ({ pages }) => pages.map((p, i) => Buffer.from("image-" + i)));
  const single = await request(exporter, { pages: [board], format: "png", scale: 2 });
  assert.equal(single.status, 200); assert.equal(single.headers["Content-Type"], "image/png");
  assert.equal(single.body.toString(), "image-0");
  const multiple = await request(exporter, { pages: [board, { ...board, id: "two" }], format: "jpg", scale: 1 });
  assert.equal(multiple.status, 200); assert.equal(multiple.headers["Content-Type"], "application/zip");
  const files = unzipSync(multiple.body);
  assert.deepEqual(Object.keys(files), ["Web-订单详情.jpg", "Web-订单详情-2.jpg"]);
  assert.equal(Buffer.from(files["Web-订单详情-2.jpg"]).toString(), "image-1");
});
test("HTML export requires no browser and retains a working source base", async () => {
  const response = await request(handler(() => { throw Error("browser must not run"); }), { pages: [board], format: "html", scale: 1 });
  assert.equal(response.status, 200); assert.match(response.body.toString(), /http:\/\/127.0.0.1:8125/);
});
test("invalid origin and bad requests are rejected before rendering; render failure allows retry", async () => {
  let calls = 0;
  const exporter = handler(async () => { calls++; if (calls === 1) throw Error("failed browser"); return [Buffer.from("ok")]; });
  const input = { pages: [board], format: "png", scale: 1 };
  assert.equal((await request(exporter, input, { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await request(exporter, { ...input, scale: 5 })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request(exporter, input)).status, 500);
  assert.equal((await request(exporter, input)).status, 200);
});
test("busy export rejects duplicate work without releasing the active slot", async () => {
  let release; const exporter = handler(() => new Promise(resolve => { release = resolve; }));
  const input = { pages: [board], format: "png", scale: 1 };
  const first = request(exporter, input);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request(exporter, input)).status, 429);
  assert.equal((await request(exporter, input)).status, 429);
  release([Buffer.from("ok")]); assert.equal((await first).status, 200);
});
test("installed Chrome renders scale-2 PNG, JPG and PDF", { skip: !process.env.WORKBENCH_EXPORT_BROWSER_TEST }, async () => {
  for (const format of ["png", "jpg", "pdf"]) {
    const [data] = await renderImages(exportOptions({ pages: [board], format, scale: 2 }, entry), { root: "/tmp", publicRoot: "/tmp", entry });
    if (format === "png") { assert.equal(data.subarray(1, 4).toString(), "PNG"); assert.equal(data.readUInt32BE(16), 780); assert.equal(data.readUInt32BE(20), 760); }
    if (format === "jpg") assert.equal(data.readUInt16BE(0), 0xffd8);
    if (format === "pdf") assert.equal(data.subarray(0, 5).toString(), "%PDF-");
  }
});
