# 需求平台 · Requirements Platform

自托管的产品研发工作台。在同一条需求下查看和关联需求文档、接口契约、流程图、设计画板、页面元素说明与测试记录。

- **需求与规格**支持 Markdown、规则段落锚点，以及 MySQL 模式下的在线编辑和版本恢复。
- **流程图**支持连线、泳道、子流程、公共模块、节点参数契约和 Mermaid 导入与导出。
- **设计画板**支持导入 HTML 原型、关联需求规则、记录元素说明及导出 HTML、PNG、JPG 或 PDF。
- **协作**支持团队账号、需求创建者权限、统一 CLI 和 AI 只读上下文。Gitee 企业版与 Apifox 可按需接入。

## 本地启动

需要 Node.js 22 或更新的 LTS 版本。在仓库根目录运行以下命令。

```sh
git clone https://github.com/aomo5/requirements-platform.git
cd requirements-platform
npm ci
npm start
```

打开 <http://127.0.0.1:8125>。首次启动会创建 `workspace/01-通用需求/`，可直接从页面新建需求。新增模块可在 `workspace/` 中创建形如 `02-模块名称` 的目录。需求与画板保存在本机，`workspace/` 默认被 Git 忽略。

想先体验已有的需求、流程和 HTML 原型，可以在停止服务后用虚构示例启动。

```sh
REQUIREMENTS_ROOT=./examples/workspace npm start
```

可以将 `examples/workspace/` 下的模块复制到自己的需求目录后再编辑。文件模式支持新建需求、预览 Markdown、编辑流程与画板。浏览器内编辑需求正文、归档与账号协作需要 MySQL。

## MySQL 与团队模式

使用 Docker Compose 启动独立的 MySQL 8.0。数据库监听本机 `13308`，密码首次启动时生成到 `.env`。

```sh
npm run db:start
npm run db:init
```

在 `.env` 中设置 `WORKBENCH_STORAGE=mysql` 后运行 `npm start`。`db:init` 用于空工作区。已有文件模式数据时，先按[数据迁移](#数据迁移)操作。数据库已有数据时，使用原来的数据卷和数据库密码。

团队使用前按[账号初始化](./ACCOUNT_ACCESS.md)创建第一个账号，再运行 `npm run serve:team`。通过局域网地址访问。按可信网络中的自托管工具部署。`npm start` 默认只监听 `127.0.0.1`。

| 配置 | 用途 |
| --- | --- |
| `REQUIREMENTS_ROOT` | 需求数据目录。默认使用仓库内的 `workspace/`。 |
| `PORT`、`HOST` | HTTP 端口和监听地址。默认 `8125`、`127.0.0.1`。 |
| `WORKBENCH_STORAGE` | `files` 或 `mysql`。 |
| `WORKBENCH_AUTH` | 设为 `required` 启用 MySQL 账号模式。 |
| `WORKBENCH_CHROMIUM_PATH` | 画板渲染用的 Chromium 路径。也可运行 `npx playwright-core install chromium`。HTML 导出无需浏览器。 |
| `WORKBENCH_SOURCE_ROOT` | 可选的 Git 源码目录。只在需求配置了路线源码核验时使用。 |

## CLI 与外部接入

- [统一 CLI](./WORKBENCH_CLI.md)用于需求、接口、规格、页面说明和测试关联。
- [流程 CLI](./FLOW_CLI.md)和[设计 CLI](./DESIGN_CLI.md)支持导出草稿、差异比较、预演和保存。批量写入需 MySQL。
- [外部接入](./INTEGRATIONS.md)介绍 Gitee 企业版同步和 Apifox 运行环境配置。

## 数据迁移

已有文件模式工作区时，停止工作台，确认 `REQUIREMENTS_ROOT` 和目标 MySQL 配置，使用一个全新的备份目录。示例 `.runtime/backup-before-mysql` 位于默认需求数据目录之外。

```sh
npm run db:start
node scripts/storage.js backup --output .runtime/backup-before-mysql
node scripts/storage.js migrate --backup .runtime/backup-before-mysql
node scripts/documents.js migrate --backup .runtime/backup-before-mysql
node scripts/documents.js migrate-supporting --backup .runtime/backup-before-mysql
node scripts/storage.js activate
npm start
```

持久数据包括需求目录与 MySQL 数据卷。停服可用 `npm run db:stop` 停止数据库，数据卷会保留。

## 测试

```sh
npm test
```

该命令运行不依赖 MySQL 的回归。数据库集成测试使用各用例声明的独立测试库和测试配置。

## 许可证

[MIT](./LICENSE)
