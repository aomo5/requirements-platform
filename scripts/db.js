"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = {
  start: ["up", "-d", "--wait", "db"],
  status: ["ps", "db"],
  stop: ["stop", "db"],
}[process.argv[2]];
if (!args) {
  console.error("使用 start / status / stop");
  process.exit(1);
}

const hasPlugin = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const command = hasPlugin ? "docker" : "docker-compose";
const result = spawnSync(command, [...(hasPlugin ? ["compose"] : []), ...args], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
});
if (result.error) console.error("请安装 Docker 和 Docker Compose。");
process.exitCode = result.status ?? 1;
