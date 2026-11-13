---
name: workbench-cli
description: 通过统一 workbench CLI 维护需求工作台中的需求、接口契约、规格、任务、页面说明及测试关联与执行记录，或配置局域网服务与账号。适用于这些工作台板块的读取和更新；原生流程、设计的专业绘制仍使用对应技能，不直接写数据库。
---

# Workbench CLI

先读适用的项目规则，确认用户指定的服务地址、需求主题和当前存储方式。用 `workbench list` 核对主题路径，使用 `workbench help` 或仓库根目录的 `npm run workbench -- help` 核对当前能力。连接和命令示例见 [团队 CLI](../../../WORKBENCH_CLI.md)。

## 连接

仓库根目录可以运行 `npm run workbench -- …`，安装独立 CLI 包后可直接使用 `workbench …`。默认地址为 `http://127.0.0.1:8125`，可用 `config --url` 设置自己的服务。启用了团队账号时，用 CLI 正常登录，流程、设计和文档共用该会话。

MySQL 模式通过平台维护需求正文、文档历史及原子批量编辑。文件模式可按实际目录读取 Markdown，并通过浏览器编辑流程和设计。遇到缺少在线文档或批量接口的实例，按其当前能力选择路径。临时导出的 Markdown 和 JSON 仅用于草稿，已迁入 MySQL 的逻辑文件无需再建一份。

## 文档

板块名：requirement（需求）、interface（接口契约）、spec（规格）、task（任务）、document（其他补充文档，使用 `--document` 指定逻辑路径）。页面目录和说明属于 design 模型，使用 `workbench design` 维护，不再通过 page/document 写入 `页面设计/*.md`。旧 page 命令仅为兼容别名，迁移后的旧文档只读历史。

常规操作：`pull --path 主题 --out 临时草稿.json` → `export --file 草稿.json --out 临时正文.md` → 编辑正文 → `import --file 草稿.json --content 临时正文.md` → `check`、`diff` → `apply --file 草稿.json --dry-run` → `apply --file 草稿.json`。正文必须来自本次读取，不用旧本地文件覆盖在线新版本。

正文保留当前有效规则、必要来源、真实未决项及用户维护的有效内容。后续调整直接整合到对应章节；已确认的待确认项归入正式规则并移出清单，实施核验另列待办。旧评审和被替代内容通过版本记录追溯，不在正文重复追加；具体写作见 [现行版本与历史记录](../prd-architect/SKILL.md#现行版本与历史记录)。

清理正文前确认旧版本可读取，避免仅为追溯又附回历史全文。段落稳定 ID 由服务端协调，不手工注入 wb-rule 标记；合并、移动或删除段落后检查页面、流程及验收引用是否仍有效。关联需求变更时检查接口、规格、流程、页面等当前维护的资料是否需要同步，但每次仅修改已授权范围。小调整遵循[小范围变更与统一方案复用](../prd-architect/SKILL.md#小范围变更与统一方案复用)，只处理直接受影响的内容，不自动启动整套产物更新。

正式保存后检查 saved/verified。409 时重新 pull 到另一个文件合并，不修改版本号强推。连接中断先回读确认，不自动重试写入；保存已确认但本地更新失败时保留后续草稿，不重放旧版本。历史可用 versions/version 导出，再将所需内容导入最新草稿生成新版本。

## 测试

先 `test list --path 主题`、`test environments --path 主题` 查询当前关联、版本、环境和最近记录。link/unlink 通过 `--input 参数.json` 使用当前 expectedRevision 和真实资源 ID；验收规则 ID 从工作台当前规则取得。

仅在用户授权执行相应测试时使用 `test run --path 主题 --link 已关联ID --environment 已配置ID`。CLI 不接受自定义 shell、连接串或任意执行环境，执行器认证留在服务器。用演示主题或已配置的测试环境验证，不触发真实业务副作用。

run 返回排队/运行状态不等于通过，用 `test result --path 主题 --id 执行ID` 查询状态、断言及报告；不自动修改 Gitee 完成状态。未知执行结果先查询，不自动提交重复运行。验收环境及业务完成标准遵循工作区规则。

## 流程和设计

统一入口提供 `workbench flow ...`、`workbench design ...`。原生流程应用 flow-workbench 的语义核验；页面原型与页面说明应用 design-requirements-prototype 的源码取证、统一设计维护与视觉验收。页面说明、总说明随设计版本保存，尚无画板的页面先建待设计记录；不另维护页面模块或重复清单。浏览器用于保存后检查；导出图或结构校验不能代替业务、视觉及交互验收。
