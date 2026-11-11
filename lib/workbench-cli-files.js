"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CliError } = require("./workbench-cli-client");

function parseArgs(argv, schema = {}) {
  const options = {}, command = argv.shift() || "help";
  const flags = new Set(schema.flags || ["dry-run", "password-stdin", "help"]);
  const keys = new Set(schema.keys || ["url", "username", "path", "file", "out", "ops", "flow", "node", "kind"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new CliError(`未知参数：${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) throw new CliError(`参数重复：${arg}`);
    if (flags.has(key)) options[key] = true;
    else if (keys.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
    else throw new CliError(`未知参数或缺少值：${arg}`);
  }
  return { command, options };
}
function required(options, name) {
  if (!options[name]) throw new CliError(`缺少 --${name}`);
  return options[name];
}
function readJson(file, { withSource = false } = {}) {
  let text;
  try { text = fs.readFileSync(file === "-" ? 0 : file, "utf8"); }
  catch { throw new CliError(`无法读取文件：${file}`); }
  if (Buffer.byteLength(text) > 12 * 1024 * 1024) throw new CliError("本地草稿最多 12 MB");
  try { const value = JSON.parse(text); return withSource ? { value, source: text } : value; }
  catch { throw new CliError(`JSON 格式不正确：${file}`); }
}
function writeFile(file, value, { exclusive = false, json = true, expectedContent } = {}) {
  const absolute = path.resolve(file), stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new CliError("输出目标必须是普通文件");
  const text = json ? JSON.stringify(value, null, 2) + "\n" : value;
  if (exclusive) { fs.writeFileSync(absolute, text, { flag: "wx", mode: 0o600 }); return; }
  const temporary = path.join(path.dirname(absolute), `.workbench-edit-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    if (expectedContent !== undefined && fs.readFileSync(absolute, "utf8") !== expectedContent) {
      throw new CliError("本地草稿已被修改，保留新内容，请重新 pull 到另一文件比对", 409);
    }
    fs.renameSync(temporary, absolute);
  } finally { fs.rmSync(temporary, { force: true }); }
}
async function promptLine(label, hidden = false) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError("交互登录需要终端；可用 --username 和 --password-stdin");
  if (!hidden) {
    const readline = require("node:readline/promises").createInterface({ input: process.stdin, output: process.stderr });
    try { return await readline.question(label); } finally { readline.close(); }
  }
  process.stderr.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause(); process.stderr.write("\n"); };
    const onData = chunk => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\u0003" || c === "\u0004") { cleanup(); reject(new CliError("已取消登录")); return; }
        if (c === "\r" || c === "\n") { cleanup(); resolve(value); return; }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " " && value.length < 128) value += c;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

module.exports = { parseArgs, required, readJson, writeFile, promptLine };
