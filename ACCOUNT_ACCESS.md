# 账号初始化

团队账号使用 MySQL。按 [README](./README.md) 初始化数据库或迁移现有工作区，再创建第一个账号。它会认领已有需求。其他成员注册后可以阅读团队需求，编辑自己创建的需求。

## 初始化首个账号

1. 在 `.env` 中设置 `WORKBENCH_STORAGE=mysql` 和 `WORKBENCH_AUTH=required`，使用 `npm start` 在本机启动。
2. 在仓库根目录创建 `.secrets/account-setup.json`，设置 `username`、`displayName` 和随机 `token`。可以用以下命令生成文件。把命令中的 `owner` 和 `维护者` 换成自己的账号和姓名。

   ```sh
   node -e 'const fs=require("node:fs");const crypto=require("node:crypto");fs.mkdirSync(".secrets",{recursive:true,mode:0o700});fs.writeFileSync(".secrets/account-setup.json",JSON.stringify({username:"owner",displayName:"维护者",token:crypto.randomBytes(32).toString("hex")}),{flag:"wx",mode:0o600})'
   ```

3. 在服务器本机打开 <http://127.0.0.1:8125/setup>，设置密码。初始化成功后会封闭入口并清除初始化配置。
4. 停止前台进程，运行 `npm run serve:team`。成员从局域网地址打开工作台并注册。调整配置后可用 `npm run restart:team` 重启，停服用 `node scripts/service.js stop`。

也可以使用 `node scripts/accounts-bootstrap.js`，从标准输入传入包含 `username`、`displayName` 和 `password` 的 JSON。不要把密码写进命令行参数、仓库或文档。

团队模式下，复制给 AI 的链接有一小时有效期，仅授权读取链接所列需求资料。把该链接作为临时访问凭证保管。
