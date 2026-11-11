"use strict";

const fs = require("node:fs");
const path = require("node:path");
const parse5 = require("parse5");
const { zipSync } = require("fflate");
const { validatePages } = require("./design-store");
const ORIGIN = "https://workbench-export.invalid";
const MAX_PAGES = 20, MAX_PIXELS = 32000000, MAX_TOTAL_PIXELS = 64000000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function exportOptions(body, entry) {
  if (!body || !["png", "jpg", "pdf", "html"].includes(body.format)) fail("请选择 PNG、JPG、PDF 或 HTML 格式");
  if (![1, 2, 3].includes(body.scale)) fail("导出倍率须为 1×、2× 或 3×");
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > MAX_PAGES) fail(`每次请选择 1—${MAX_PAGES} 张画板`);
  const pages = validatePages(body.pages, entry);
  const raster = ["png", "jpg"].includes(body.format), scale = raster ? body.scale : 1;
  const pixels = pages.map(p => p.width * p.height * scale * scale);
  if (raster && (pixels.some(p => p > MAX_PIXELS) || pixels.reduce((a, b) => a + b, 0) > MAX_TOTAL_PIXELS)) fail("导出尺寸过大，请降低倍率或减少画板数量");
  return { pages, format: body.format, scale, transparent: body.format === "png" && body.transparent === true };
}

function fileNames(pages, format) {
  const used = new Set();
  return pages.map(page => {
    let base = [page.platform, page.group, page.name].filter(Boolean).join("-")
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-").replace(/^\.+|[. ]+$/g, "") || "画板";
    while (Buffer.byteLength(base) > 180) base = Array.from(base).slice(0, -1).join("");
    let name = `${base}.${format}`, index = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${index++}.${format}`;
    used.add(name.toLowerCase()); return name;
  });
}

function exportHtml(page, origin = ORIGIN) {
  const doc = parse5.parse(page.html), html = doc.childNodes.find(n => n.tagName === "html");
  const head = html.childNodes.find(n => n.tagName === "head");
  head.childNodes = head.childNodes.filter(n => n.tagName !== "base" && !(n.tagName === "meta" && n.attrs.some(a => a.name === "http-equiv" && a.value.toLowerCase() === "refresh")));
  const base = page.source ? `/preview/${encodeURI(page.source.slice(0, page.source.lastIndexOf("/") + 1))}` : "/";
  const fragment = parse5.parseFragment(`<base href="${origin}${base}">`);
  head.childNodes.unshift(...fragment.childNodes);
  if (page.route) {
    const script = parse5.parseFragment(`<script>location.hash=${JSON.stringify(page.route).replace(/</g, "\\u003c")};</script>`);
    head.childNodes.splice(fragment.childNodes.length, 0, ...script.childNodes);
  }
  return "<!doctype html>\n" + parse5.serialize(doc).replace(/^<!DOCTYPE html>\n?/i, "");
}

function browserLaunchOptions() {
  const candidates = [process.env.WORKBENCH_CHROMIUM_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
  const executablePath = candidates.find(p => fs.existsSync(p));
  return executablePath ? { executablePath, headless: true, chromiumSandbox: true } : { headless: true, chromiumSandbox: true };
}

const CSP = `default-src 'none'; script-src 'unsafe-inline' ${ORIGIN}; style-src 'unsafe-inline' ${ORIGIN}; img-src ${ORIGIN} data: blob:; font-src ${ORIGIN} data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri ${ORIGIN};`;
const MIME = { ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };

async function renderImages(options, { root, publicRoot, entry }) {
  const { chromium } = require("playwright-core");
  let browser;
  try { browser = await chromium.launch(browserLaunchOptions()); }
  catch { fail("导出服务无法启动浏览器，请安装 Chrome 或配置 WORKBENCH_CHROMIUM_PATH", 503); }
  const files = [];
  const deadline = setTimeout(() => { void browser.close(); }, 60000);
  try {
    for (const board of options.pages) {
      const context = await browser.newContext({ viewport: { width: board.width, height: board.height }, deviceScaleFactor: options.scale, serviceWorkers: "block", acceptDownloads: false });
      try {
        const tab = await context.newPage(), blocked = [];
        tab.setDefaultTimeout(12000);
        tab.on("dialog", dialog => dialog.dismiss());
        context.on("page", popup => { if (popup !== tab) void popup.close(); });
        const pageUrl = `${ORIGIN}/__board/${board.id}`;
        await context.route("**/*", async route => {
          const request = route.request(), u = new URL(request.url());
          if (u.origin === ORIGIN && u.pathname === `/__board/${board.id}` && request.isNavigationRequest()) {
            await route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: exportHtml(board) }); return;
          }
          try {
            if (u.origin !== ORIGIN || request.method() !== "GET") throw new Error("blocked");
            const pathname = decodeURIComponent(u.pathname);
            let allowed, target;
            if (pathname.startsWith(`/preview/${entry.path}/原型设计/`)) {
              allowed = fs.realpathSync(path.join(root, entry.path, "原型设计"));
              target = fs.realpathSync(path.resolve(root, pathname.slice("/preview/".length)));
            } else if (pathname.startsWith("/assets/")) {
              allowed = fs.realpathSync(path.join(publicRoot, "assets"));
              target = fs.realpathSync(path.resolve(publicRoot, pathname.slice(1)));
            } else throw new Error("blocked");
            if (!target.startsWith(allowed + path.sep) || !fs.statSync(target).isFile() || fs.statSync(target).size > 10000000) throw new Error("blocked");
            const contentType = MIME[path.extname(target).toLowerCase()];
            if (!contentType) throw new Error("blocked");
            await route.fulfill({ contentType, body: fs.readFileSync(target) });
          } catch { blocked.push(request.resourceType()); await route.abort(); }
        });
        await tab.goto(pageUrl + board.route, { waitUntil: "load", timeout: 15000 });
        await tab.emulateMedia({ media: "screen" });
        await tab.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        if (blocked.length || await tab.evaluate(() => [...document.images].some(image => !image.complete || !image.naturalWidth))) fail(`“${board.name}”有资源无法载入，请先将图片、字体或脚本归档到当前原型目录`, 422);
        const buffer = options.format === "pdf"
          ? await tab.pdf({ width: `${board.width}px`, height: `${board.height}px`, printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 }, pageRanges: "1" })
          : await tab.screenshot({ type: options.format === "jpg" ? "jpeg" : "png", ...(options.format === "jpg" ? { quality: 95 } : {}), animations: "disabled", scale: "device", omitBackground: options.transparent, timeout: 15000 });
        files.push(buffer);
      } finally { await context.close(); }
    }
  } finally { clearTimeout(deadline); await browser.close(); }
  return files;
}

function createDesignExportHandler(store, { root, publicRoot, sendJson, render = renderImages }) {
  let active = false;
  return async (req, res, url) => {
    let ownsSlot = false;
    try {
      if (req.method !== "POST") fail("导出仅支持 POST", 405);
      if (req.headers.origin !== `http://${req.headers.host}` || req.headers["x-design-client"] !== "workbench-v1") fail("不允许跨站导出", 403);
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) fail("请使用 JSON 请求", 415);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) fail("导出内容最多 4 MB", 413); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("导出参数不正确"); }
      const { entry } = await store.read(url.searchParams.get("path"));
      const options = exportOptions(body, entry);
      if (active) fail("已有画板正在导出，请稍后重试", 429);
      active = true; ownsSlot = true;
      const buffers = options.format === "html" ? options.pages.map(p => Buffer.from(exportHtml(p, `http://${req.headers.host}`))) : await render(options, { root, publicRoot, entry });
      const names = fileNames(options.pages, options.format), multiple = names.length > 1;
      const data = multiple ? Buffer.from(zipSync(Object.fromEntries(names.map((name, i) => [name, new Uint8Array(buffers[i])])), { level: 0 })) : buffers[0];
      if (data.length > 64 * 1024 * 1024) fail("导出文件超过 64 MB，请减少画板或降低倍率", 413);
      const filename = multiple ? fileNames([{ name: `${entry.feature || "画板"}-设计导出` }], "zip")[0] : names[0];
      const types = { png: "image/png", jpg: "image/jpeg", pdf: "application/pdf", html: "text/html; charset=utf-8" };
      res.writeHead(200, { "Content-Type": multiple ? "application/zip" : types[options.format], "Content-Disposition": `attachment; filename="design-export.${multiple ? "zip" : options.format}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    } catch (error) { sendJson(res, error.status || 500, { error: error.status ? error.message : "导出失败，请稍后重试；当前设计未修改" }); }
    finally { if (ownsSlot) active = false; }
  };
}

module.exports = { exportOptions, fileNames, exportHtml, renderImages, createDesignExportHandler };
