"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const file = path.join(__dirname, "../.env");
const config = [
  "WORKBENCH_STORAGE=files",
  "HOST=127.0.0.1",
  "DB_HOST=127.0.0.1",
  "DB_PORT=13308",
  "DB_NAME=requirements_workbench",
  "DB_USER=workbench",
  `DB_PASSWORD=${randomBytes(32).toString("hex")}`,
  `MYSQL_ROOT_PASSWORD=${randomBytes(32).toString("hex")}`,
  "",
].join("\n");

try {
  fs.writeFileSync(file, config, { mode: 0o600, flag: "wx" });
  console.log("已生成本机 .env 和独立的数据库密码。");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("沿用现有 .env。");
}
