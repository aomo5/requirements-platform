"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
// Assemble only the CLI dependency graph, never server state or local secrets.
function build(destination) {
  const root = path.resolve(__dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-cli-package-"));
  const seen = new Set();
  function copy(relative) {
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) throw Error("CLI 依赖越界");
    if (seen.has(relative)) return; seen.add(relative);
    const source = fs.readFileSync(full, "utf8"), to = path.join(dir, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, source);
    for (const m of source.matchAll(/(?:require\(|import\()\s*["'](\.[^"']+)["']/g)) {
      let next = path.resolve(path.dirname(full), m[1]);
      if (!path.extname(next)) next += ".js";
      copy(path.relative(root, next));
    }
  }
  try {
    for (const f of ["scripts/workbench.js", "scripts/flows.js", "scripts/designs.js"]) copy(f);
    const dependencies = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).dependencies;
    // CLI only uses export option validation. Rendering runs on the server.
    delete dependencies.mysql2; delete dependencies["playwright-core"];
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "requirements-platform-cli", version: "1.0.0", license: "MIT", private: true,
      bin: { workbench: "scripts/workbench.js" }, engines: { node: ">=20.12" }, dependencies }, null, 2));
    fs.chmodSync(path.join(dir, "scripts/workbench.js"), 0o755);
    fs.copyFileSync(path.join(root, "WORKBENCH_CLI.md"), path.join(dir, "README.md"));
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
    for (const name of ["WORKBENCH_CLI.md", "FLOW_CLI.md", "DESIGN_CLI.md"]) fs.copyFileSync(path.join(root, name), path.join(dir, name));
    const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", path.resolve(destination)], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw Error(result.stderr || "CLI 打包失败");
    const info = JSON.parse(result.stdout)[0];
    return { file: path.join(path.resolve(destination), info.filename), files: info.files.map(f => f.path), bytes: info.size };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--out") { console.error("使用 npm run cli:package -- --out 已存在输出目录"); process.exitCode = 1; }
  else try { console.log(JSON.stringify(build(argv[1]), null, 2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { build };
