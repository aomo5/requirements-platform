"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

class CliError extends Error {
  constructor(message, status = 0, details) { super(message); this.status = status; this.details = details; }
}

function localOrigin(value = "http://127.0.0.1:8125") {
  let url;
  try { url = new URL(value); } catch { throw new CliError("工作台地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("请指定工作台 HTTP(S) 根地址，例如 http://192.168.1.10:8125；不能含凭据、路径或查询参数");
  }
  return url.origin;
}

function privateFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
    throw new CliError("会话文件必须属于当前用户、为普通文件且权限为 0600");
  }
  return stat;
}

function writePrivateJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliError("会话目录不能是符号链接");
  fs.chmodSync(directory, 0o700);
  privateFile(file);
  const temporary = path.join(directory, `.session-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

class WorkbenchClient {
  constructor({ url = process.env.WORKBENCH_URL, configDir = process.env.WORKBENCH_CLI_CONFIG_DIR,
    fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    const directory = configDir || path.join(os.homedir(), ".config", "requirements-workbench", "flow-cli");
    const settingsFile = path.join(directory, "default.json");
    let saved;
    if (!url && privateFile(settingsFile)) {
      try { saved = JSON.parse(fs.readFileSync(settingsFile, "utf8")).origin; }
      catch { throw new CliError("默认服务配置损坏，请重新运行 workbench config --url 地址"); }
    }
    this.origin = localOrigin(url || saved);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.settingsFile = settingsFile;
    this.sessionFile = path.join(directory, crypto.createHash("sha256").update(this.origin).digest("hex").slice(0, 20) + ".json");
  }
  session() {
    if (!privateFile(this.sessionFile)) return null;
    let value;
    try { value = JSON.parse(fs.readFileSync(this.sessionFile, "utf8")); }
    catch { throw new CliError("CLI 会话文件损坏，请重新登录"); }
    if (value.origin !== this.origin || !/^[a-f0-9]{64}$/.test(value.token || "")) throw new CliError("CLI 会话文件无效，请重新登录");
    return value;
  }
  async request(route, { method = "GET", body, authenticated = true, raw = false, binary = false, timeoutMs = this.timeoutMs } = {}) {
    if (!route.startsWith("/api/") || route.startsWith("//")) throw new CliError("无效的工作台 API 路径");
    const session = authenticated ? this.session() : null;
    let response;
    try {
      response = await this.fetch(this.origin + route, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { Origin: this.origin, "X-Design-Client": "workbench-v1", "Content-Type": "application/json",
          ...(session ? { Cookie: `wb_session=${session.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(binary ? "导出未取得结果，当前设计未修改；请核对服务状态"
        : method === "GET" ? "无法读取工作台，请核对服务地址与运行状态"
        : "请求未取得确定结果；请先重新读取核对是否已保存，不要自动重试写入");
    }
    if (response.ok && binary) {
      const maximum = 64 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new CliError("导出超过 64 MB，请减少画板或降低倍率"); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maximum) throw new CliError("导出超过 64 MB，请减少画板或降低倍率");
          chunks.push(chunk);
        }
      } catch (error) { if (error instanceof CliError) throw error; throw new CliError("导出接收未完成，未写入本地文件"); }
      return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") || "",
        disposition: response.headers.get("content-disposition") || "" };
    }
    let result;
    try { result = await response.json(); }
    catch { throw new CliError(method !== "GET" && !binary
      ? "写入响应未完整读取，保存状态不确定；请先回读核对，不要自动重试写入"
      : "工作台未返回 JSON；请核对服务版本和地址", response.status); }
    if (!response.ok) {
      const hint = response.status === 401 ? "（请运行 flow login 或 design login 登录一次）"
        : response.status === 409 ? "（请重新 pull 并合并修改，不要替换版本号强推）" : "";
      throw new CliError((result.error || `HTTP ${response.status}`) + hint, response.status, result.details);
    }
    return raw ? { result, response } : result;
  }
  async login(username, password) {
    const { result, response } = await this.request("/api/auth/login", {
      method: "POST", body: { username, password }, authenticated: false, raw: true,
    });
    if (result.enabled === false) return { enabled: false, message: "当前服务未启用账号，不需要登录" };
    const cookie = response.headers.get("set-cookie") || "";
    const token = /(?:^|\s|,)wb_session=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1];
    if (!token || !result.user) throw new CliError("登录响应缺少有效会话，未保存凭据");
    writePrivateJson(this.sessionFile, { origin: this.origin, token, user: result.user });
    return { user: result.user, origin: this.origin, message: "已登录；复用工作台 7 天会话，不保存密码" };
  }
  async logout() {
    if (this.session()) await this.request("/api/auth/logout", { method: "POST", body: {} });
    fs.rmSync(this.sessionFile, { force: true });
    return { loggedOut: true };
  }
  whoami() { return this.request("/api/auth/session"); }
  configure() { writePrivateJson(this.settingsFile, { origin: this.origin }); return { origin: this.origin }; }

}

module.exports = { WorkbenchClient, CliError, localOrigin };
