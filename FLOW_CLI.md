# 流程 CLI

流程的日常读取、改图、移动节点、维护泳道和说明使用 CLI；浏览器用于最终画布检查。CLI 连接已运行的工作台服务，复用数据库、创建者权限与历史记录，不直接写 SQL、不修改迁移前 JSON。

在仓库根目录运行 `npm run flow -- help`。

## 登录一次

```sh
npm run flow -- login
npm run flow -- whoami
```

使用现有工作台账号，终端密码不回显。会话有效 7 天，不保存密码。会话按服务 origin 分隔，存于 `~/.config/requirements-workbench/flow-cli/`，目录 0700、文件 0600；`logout` 撤销当前 CLI 会话。自动化可使用 `login --username 账号 --password-stdin`，不把密码放命令参数、仓库或聊天。

默认连接 `http://127.0.0.1:8125`；`--url`、`WORKBENCH_URL` 或 `workbench config --url 地址` 可指定局域网服务。不同 origin 不共用会话，不跟随重定向发送凭据。不读取浏览器 Cookie、不冒充需求创建者。独立安装与团队连接见 [WORKBENCH_CLI.md](./WORKBENCH_CLI.md)。

## 整个需求的路线核验

流程页的「路线核验」和 CLI 共用同一份已保存的流程。默认清单从业务入口出发，为可达分支、模块返回、跨图交接和终点选择完整路线。切换到全部组合可以按序号访问任意一条有界路径。循环保留首轮、一次重入与仍待继续的结果。

```sh
node scripts/flows.js routes --path '01-协作工具/知识库投稿' --limit 10
node scripts/flows.js routes --path '01-协作工具/知识库投稿' --view all --offset 0 --detail
node scripts/flows.js routes --path '01-协作工具/知识库投稿' --mode current --review pending --test pending
node scripts/flows.js routes --path '01-协作工具/知识库投稿' --changes
```

页面列表从 1 编号，CLI 的 `--offset` 从 0 起。用 `--through`、`--node` 或 `--rule` 定位经过某流程、节点或已登记业务条件的完整路线。`review` 是个人结论，`test` 取受控业务实测证据。需求目录的 `路线核验规则.json` 记录源码基线、方法、场景断言和互斥条件。本地测试资料单列在场景详情。代码或图上的条件发生变化时，保留原版本记录，当前路线需重新核验。

## 批量编辑

```sh
node scripts/flows.js pull --path '01-协作工具/知识库投稿' --out /tmp/flow-draft.json
node scripts/flows.js show --file /tmp/flow-draft.json --flow article-review --node review
node scripts/flows.js patch --file /tmp/flow-draft.json --ops /tmp/flow-ops.json
node scripts/flows.js check --file /tmp/flow-draft.json
node scripts/flows.js diff --file /tmp/flow-draft.json
node scripts/flows.js apply --file /tmp/flow-draft.json --dry-run
node scripts/flows.js apply --file /tmp/flow-draft.json
```

`pull` 保存来源、主题路径、图与说明的双版本，以及基线 `base` 和可编辑 `draft`。输出文件已存在时拒绝覆盖，下一次选新文件。草稿只是临时编辑载体。`patch` 任何操作失败都不覆盖原草稿；`--out` 可写到新草稿。

操作示例（按实际 ID 调整）：

```json
[
  {"op":"node.update","flowId":"article-review","id":"review","set":{"label":"文章是否通过审核？"}},
  {"op":"edge.update","flowId":"article-review","id":"review-published","set":{"label":"审核通过","trace":"proposal"}},
  {"op":"note.add","id":"note-review","value":{"target":{"type":"flow-node","flowId":"article-review","nodeId":"review"},"text":"编辑确认内容符合发布规则后才发布。","requirements":[]}}
]
```

| 对象 | 操作 | 定位 |
| --- | --- | --- |
| 流程 | `flow.add/update/remove` | `id` |
| 节点、连线、泳道 | `node/edge/lane.add/update/remove` | `flowId` + `id` |
| 流程节点／边说明 | `note.add/update/remove` | 说明 `id` |
| 工作区 | `workspace.update` | 仅 applicability、reason、references |

新增用 `value`，更新用 `set` 和可选 `unset` 数组，删除仅填写定位。ID 为 1–80 位字母、数字、下划线、横线；不能更新 ID 或版本字段。已有说明用 `note.update` 保留 ID 与需求规则引用。节点改类型时显式 unset 不适用的语义字段。删除不自动级联，依赖边、说明与父子关系须同批处理。页面元素说明只原样透传。

原生字段以 `lib/flow-store.js` 为准：`supplement:true` 蓝色建议、`variant:"branch"` 紫色，边 `trace` 为 actual/proposal/branch。`input.source`、`output.target`、`parent` 使用 `{entryPath,flowId,nodeId}`；保留 endScope、eventType/eventPhase、gatewayMode。节点和泳道坐标可直接批量修改，不重排无关流程。

### 输入与返回参数表

所有节点可选 `contract:{inputs:[],outputs:[]}`，独立保存字段说明，不混入元素说明正文。`show --flow ... --node ...` 在 `node.contract` 中返回；`pull`、`diff`、`apply` 和版本恢复保留。节点复制及 AI 资料接口使用同一数据；承接位置继续由 `source`、`target`、`call.returns` 管理，不在参数表重复保存目标。

每行字段：

| 属性 | 要求 |
| --- | --- |
| `id` | 稳定行 ID，1–80 位字母、数字、下划线或横线；同组不重复 |
| `name`、`type` | 必填文本，各最多 120 字 |
| `required` | `required` 必需、`optional` 可选、`conditional` 条件必需 |
| `condition` | 条件必需时必填，最多 1000 字 |
| `source` | 来源／取值或沿用上下文，最多 1000 字 |
| `description` | 含义与结果边界，最多 2000 字 |

每组最多 50 行；输入和返回可使用相同 ID 描述同一字段。空表规范化为无 `contract`，旧节点无需迁移。未知属性、重复 ID、空名称／类型及缺少条件会阻止保存，不会静默丢弃。

```json
[
  {"op":"node.update","flowId":"main","id":"notify","set":{"contract":{
    "inputs":[{"id":"task-id","name":"id","type":"Long","required":"required","source":"原通知记录","description":"沿用原通知任务 ID"}],
    "outputs":[{"id":"latest-count","name":"latestNotifyTimes","type":"Integer","required":"conditional","condition":"锁内读取成功时","source":"锁内最新记录","description":"判断次数失配；不代表业务完成"}]
  }}}
]
```

更新 `contract` 时提交完整两组；删除使用 `unset:["contract"]`。Mermaid 导出带 `%% workbench-contract` 元数据，重新导入保留表格；不要删掉元数据后将外部 Mermaid 当成完整参数契约。

### 公共模块与同步调用

- 公共流程设置 `kind:"module"`，不得设置 `parent`。模块可有多个 `input` 入口；入口不固定 `source`，由调用点选定。
- 调用节点使用 `type:"call"`，其 `call` 保存目标入口及本调用方的返回映射。模块结果使用 `type:"return"`，不得带固定 `target/source` 或出边。不同调用方可以共享同一模块并返回各自的接收节点。
- 每个模块返回节点必须在 `returns` 中恰好映射一次，调用者的 `targetNodeId` 必须存在，且有从调用节点到接收节点的真实连线；调用节点的全部出线也必须被返回映射覆盖，修改映射时须同步清理过时出线。相同接收节点可以承接多个结果。模块可以调用其他模块，禁止直接或间接递归调用。
- 未配置 `call` 的调用节点可以保存为草稿，`check` 提示 `CALL_TARGET`；一旦配置，必须提供完整契约。跨需求的模块关系在 `apply --dry-run` 由服务端检查。新增失效关系阻止保存，基线已存在的失效关系保留警告。
- `call/return` 仅表达本次同步调用。异步投递、设备事件、定时扫描和后台任务继续使用现有事件及来源关系，不因进入公共模块变成同步等待。

```json
{
  "id": "validate-content",
  "type": "call",
  "label": "校验投稿内容",
  "x": 200,
  "y": 300,
  "call": {
    "entryPath": "01-协作工具/知识库投稿",
    "flowId": "content-validation",
    "nodeId": "entry",
    "returns": [
      {"outputNodeId": "valid", "targetNodeId": "submit-for-review"},
      {"outputNodeId": "invalid", "targetNodeId": "correct-submission"}
    ]
  }
}
```

假设在示例需求中新增公共模块 `content-validation`，`valid` 和 `invalid` 是模块内的 `return` 节点。`submit-for-review` 和 `correct-submission` 是调用方的接收节点。调用节点需要分别连到这两个接收节点。`workspace.references` 仍只负责流程列表关联，不代表模块调用。

### 公共定时流程的关联

- 调用处统一使用 `type:"output"` 与 `target:{entryPath,flowId,nodeId}`，沿用跨图出口形状、“承接节点”选择和“前往承接节点”操作；不单设恢复节点或等待模式。
- 公共定时入口的事件及内部查询逻辑表达周期、等待、到期筛选和后续执行。关联入口不等于立刻触发该任务，也不重置原任务次数。目标能力未实现或启用未核实，继续明确标注。
- 目标节点可以反向查看各跨图出口来源。CLI、普通保存均保护新失效引用，跨主题引用由服务端核验；Mermaid 沿用 `workbench-output` 元数据。
- 历史 `recovery` 字段只作兼容保留，已有关联使用同一承接操作，不再新增独立控件或标记。迁移旧等待结束点时设置 output/target 并显式移除 recovery/endScope；有业务动作及其他出线的节点不要为统一外观盲目改成出口。

## 校验与恢复

- `check` 复用字段校验，补充父子、输入输出、说明目标及可读性提示。新失效引用是错误，既有失效引用保留并警告；布局和条件提示仍需结合业务审阅，不等于执行仿真或业务验收。
- `diff` 展示规范化后的实际保存内容和字段前后值，保留未改 ID、顺序、位置、样式和说明。
- `apply --dry-run` 在服务端核对双版本、跨主题引用及说明，不改数据、历史或版本。
- `apply` 在同一 MySQL 事务保存图和流程说明；第二资源失败时第一资源及历史也回滚。任一版本冲突整批停止，不能只替换版本号重试旧草稿。
- 无变化不升版本；仅改图不重写说明历史。成功后自动回读比对，并更新本地基线。
- 请求超时可能已提交，应先重新读取核对，禁止自动重发。若已确认保存但回读失败，输出 `saved:true,verified:false` 并保留新基线；发现保存后的其他更新则提示重新 pull。
- 退出码：0 成功、1 参数／连接失败、2 校验或保存后核验未完成、3 版本冲突、4 未登录／无权限。

`versions --path ... [--kind flows|annotations]` 查询历史。首版回退使用当前版本上的明确反向修改，不提供无条件强制恢复。

`export-mermaid --file ... --flow ... --out ...` 复用原生序列化器，供阅读；Mermaid 不含完整布局、边 ID、样式和说明，不能作为无损覆盖草稿。`link --path ... --flow ... --node ...` 返回原生画布定位链接。

## 接口与验证

- `GET /api/flows/bundle?path=...` 同事务读取 `{workspace,annotations,canEdit,accessMode}`。
- `POST /api/flows/batch?path=...`：`{expectedRevision,expectedAnnotationsRevision,workspace,notes,dryRun?}`，返回 `{workspace,annotations,changed,dryRun?}`。
- 沿用登录、创建者、同源及 `X-Design-Client: workbench-v1` 校验，仅支持 MySQL。旧服务缺接口时更新本机服务，不回退直接写数据库。

`npm run test:flow-cli` 为定向检查；`WORKBENCH_FLOW_BATCH_DB_TEST=1 npm run test:flow-cli` 包含真实 MySQL 事务测试，仅创建并清理 `requirements_workbench_test` 随机前缀合成表。不要运行会清空共享测试库的旧全量存储测试。
