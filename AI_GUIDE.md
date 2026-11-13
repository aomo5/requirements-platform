# AI 使用指南

在 Codex 中打开本仓库，按任务调用下面的技能。例如，把需求页面上的「复制给 AI」内容粘贴到会话，再提出要分析的问题。使用其他 AI 工具时，可将对应 `SKILL.md` 和它引用的资料交给助手。

| 技能 | 适用任务 |
| --- | --- |
| [workbench-cli](./.agents/skills/workbench-cli/SKILL.md) | 连接工作台，读取需求、规格和测试，按版本保存变更 |
| [prd-architect](./.agents/skills/prd-architect/SKILL.md) | 整理需求，更新当前版本，记录规则、验收条件和未决事项 |
| [flow-workbench](./.agents/skills/flow-workbench/SKILL.md) | 绘制和评审流程，核对条件、跨图承接、异步与结束范围 |
| [design-requirements-prototype](./.agents/skills/design-requirements-prototype/SKILL.md) | 制作原型，在设计中维护页面说明、画板和需求关联 |
| [interface-contract](./.agents/skills/interface-contract/SKILL.md) | 说明接口字段、状态、错误以及前后端的交接规则 |
| [task-splitter](./.agents/skills/task-splitter/SKILL.md) | 按可验收的交付范围拆分任务、依赖和验证步骤 |
| [workbench-design-system](./.agents/skills/workbench-design-system/SKILL.md) | 维护工作台的组件、画布交互和样式 token |

## 试读示例需求

按仓库 README 启动「知识库投稿」示例。打开该需求，点「复制给 AI」，将内容连同你的问题发给能访问该实例的助手。启用账号后生成的只读资料链接有效期为一小时。 [示例启动方式](./README.md#本地启动)

```text
使用 $flow-workbench 阅读「知识库投稿」。核对作者提交、编辑审核和发布之间的承接，分别说明审核通过和退回的结果。先给出评审结论。
```

## 在自己的实例上修改

告诉助手服务地址、需求主题、改动目标，以及要评审还是保存。如果实例启用了账号，先用自己的账号在终端登录。以下命令在仓库根目录运行。 [CLI 安装与连接](./WORKBENCH_CLI.md)

```sh
npm run workbench -- config --url http://127.0.0.1:8125
npm run workbench -- login
npm run workbench -- list
```

MySQL 模式下，批量修改通过 CLI 拉取最新版本，检查差异并预演，然后按任务授权保存和回读。页面说明、画板和关联在设计中维护。文件模式使用实例配置的资料目录和浏览器编辑能力。 [设计 CLI](./DESIGN_CLI.md) · [流程 CLI](./FLOW_CLI.md)
