# 团队工作台 CLI

Node.js 20.12 或更新版本。在仓库根目录使用 `npm run workbench -- ...`，同事电脑可安装单独的 npm 包，无需数据库配置、业务代码或工作台服务源码。

## 服务与安装

服务端使用 `npm run serve:team`（已运行时 `npm run restart:team`），监听局域网并强制启用工作台账号权限。先按 [README](./README.md) 初始化独立的 MySQL 工作台和首个账号。同事用浏览器打开 `http://服务器局域网IP:8125` 注册/登录；只有需求创建者可修改自己的需求，其他成员按现有规则查看。

在仓库根目录执行 `npm run cli:package -- --out .` 生成 `requirements-platform-cli-1.0.0.tgz`。同事可用以下命令安装。

```sh
npm install -g ./requirements-platform-cli-1.0.0.tgz
workbench config --url http://192.168.1.10:8125
workbench login
workbench whoami
workbench list
```

地址换成实际服务地址，防火墙允许同事连接该端口。账号在浏览器和 CLI 分别登录；CLI 各板块共用会话，退出也统一生效。配置保存默认服务；`--url` 临时指定、`WORKBENCH_URL` 环境变量优先于保存配置。草稿永远固定读取时的来源，不能用修改默认地址把旧草稿提交到另一实例。HTTP 模式用于可信局域网连接；HTTPS 需由服务部署提供对应 TLS 入口。

会话不保存密码，文件在当前用户的 `~/.config/requirements-workbench/flow-cli/`，按完整来源隔离，兼容原 flow/design CLI。安装包只有 CLI 所需脚本及库，不包含 `.env`、数据库账号、会话或原型/需求数据。依赖在安装时由 npm 取得。

## 流程与设计

```sh
workbench flow help
workbench design help
workbench flow pull --path '01-通用需求/功能名称' --out flow-draft.json
workbench design pull --path '01-通用需求/功能名称' --out design-draft.json
```

保持原有 `pull → patch/import → check → diff → apply --dry-run → apply` 工作流。详细操作见 [FLOW_CLI.md](./FLOW_CLI.md)、[DESIGN_CLI.md](./DESIGN_CLI.md)。不同成员使用各自的账号和草稿，服务端复核需求归属及版本。浏览器用于流程可读性、设计视觉和交互验收。

## 需求、接口与其他文档

`requirement` 对应需求文档、`interface` 对应接口契约、`spec` 对应规格索引、`task` 对应任务拆分；`page` 用 `--document 页面设计/页面名.md` 指定页面说明。也可用 `--document` 指定当前主题下的合法补充文档。

```sh
workbench interface pull --path '01-通用需求/功能名称' --out contract-draft.json
workbench interface export --file contract-draft.json --out contract-edit.md
# 编辑临时 Markdown，再导入草稿：
workbench interface import --file contract-draft.json --content contract-edit.md
workbench interface check --file contract-draft.json
workbench interface diff --file contract-draft.json
workbench interface apply --file contract-draft.json --dry-run
workbench interface apply --file contract-draft.json
workbench interface versions --path '01-通用需求/功能名称'
workbench interface version --path '01-通用需求/功能名称' --revision 1 --out contract-v1.md
workbench page pull --path '01-通用需求/功能名称' --document '页面设计/文章详情.md' --out page-note.json
```

缺失的配套文档可从版本 0 开始创建。`export`、历史版本导出及 `pull` 不覆盖已有文件。恢复旧内容时，将历史版本导入最新草稿，再预演、保存，生成新版本。需求段落 ID 由服务端在编辑时协调保留，不手工添加 `wb-rule` 标记。临时 Markdown 是编辑副本，正式文档仍在数据库。

`check` 是本地格式/大小检查；`apply --dry-run` 通过同一服务端保存逻辑做事务预演后回滚，不留历史。正式保存会回读核验，冲突退出 3，重新 pull 合并。若写入结果不确定，先回读，不自动重放。若服务确认保存但本地草稿在请求期间又被修改，会保留本地新内容并报告 `saved:true, verified:false, localBaselineUpdated:false`。

新建需求使用 `workbench requirement create --module '20-收费管理' --name '功能名称' --content original.md`，沿用工作台创建逻辑、归属和原始需求长度限制，不自动向 Gitee 发布。原有 Gitee 同步仍单独按其授权执行。

## 测试

```sh
workbench test list --path '01-通用需求/功能名称'
workbench test environments --path '01-通用需求/功能名称'
workbench test link --path '01-通用需求/功能名称' --input test-link.json
workbench test run --path '01-通用需求/功能名称' --link 关联ID --environment 已配置环境ID
workbench test result --path '01-通用需求/功能名称' --id 执行ID
workbench test runs --path '01-通用需求/功能名称'
workbench test unlink --path '01-通用需求/功能名称' --input test-unlink.json
```

关联参数示例（ID 从真实 Apifox 资源、当前测试列表及需求规则查询结果取得）：

```json
{"expectedRevision":0,"type":"scenario","projectId":"真实项目ID","branchId":"真实分支ID","resourceId":"真实场景ID","ruleIds":["真实规则ID"]}
```

取消关联：`{"expectedRevision":1,"linkId":"真实关联ID"}`。版本来自 `test list`。`type` 接受服务端支持的原生资源类型，资源由服务端回读核实。

测试执行只接受已关联资源 ID 和服务端已配置的受控环境 ID。Apifox 认证和环境配置留在服务器，同事电脑不需要配置执行器。CLI 不接收任意 shell 命令、URL 或数据库连接。`run` 返回 queued/running 不是通过，使用 `result` 查看后续状态、断言与原生报告。记录限最近 50 条；超出时应从原生报告或已有归档追溯。未知写入结果不自动重试测试执行。

## 验证

`npm run test:workbench-cli` 运行统一入口与共享客户端回归。`WORKBENCH_TEAM_CLI_DB_TEST=1 node --test tests/workbench-cli.test.js` 使用独立测试库随机前缀检查需求与接口预演、版本历史和稳定规则 ID，仅清理本次前缀。这些检查只使用测试数据。
