"use strict";
const fs = require("fs"), path = require("path");
const envFile = process.env.WORKBENCH_ENV_FILE || path.join(__dirname, "../.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
function ensureWorkspace() {
  const root = path.resolve(process.env.REQUIREMENTS_ROOT || path.join(__dirname, "../workspace"));
  if (!process.env.REQUIREMENTS_ROOT && !fs.existsSync(root)) {
    fs.mkdirSync(path.join(root, "01-通用需求"), { recursive: true, mode: 0o700 });
  }
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error("需求目录不存在：" + root);
  return fs.realpathSync(root);
}
function databaseConfig() {
  if (!process.env.DB_PASSWORD) throw new Error("缺少独立数据库配置，请运行 npm run db:start");
  if (!/^requirements_workbench(?:_[a-z0-9_]+)?$/.test(process.env.DB_NAME || "")) throw new Error("工作台必须使用 requirements_workbench 独立库或其测试库");
  return { host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 13308), database: process.env.DB_NAME,
    user: process.env.DB_USER || "workbench", password: process.env.DB_PASSWORD, connectionLimit: 4, charset: "utf8mb4",
    waitForConnections: true, enableKeepAlive: true, connectTimeout: 5000, multipleStatements: false };
}
module.exports = { databaseConfig, ensureWorkspace };
