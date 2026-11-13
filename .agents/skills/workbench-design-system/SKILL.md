---
name: workbench-design-system
description: 为需求、流程、设计画布及同类工具型产品应用工作台设计系统：使用 Figma 编辑器语言、中文校准 token、组件状态和连续操作模式来设计、实现或检查界面。适用于本工作台和用户明确要求沿用这套规范的界面；不自动改造其他业务产品，不替代 Figma 文件操作工具。
---

# 工作台设计系统

以 Figma 编辑器的内容优先、上下文工具、紧凑层级和直接操作为方向；借鉴 Ant Design 的规范组织与可查询组件知识。按当前用户授权范围应用，已有业务端设计语言继续沿用。

## 先查规范再动手

本目录是规则和 token 的唯一维护源。`references/` 面向设计判断，`assets/tokens.json` 面向参数，生成的 CSS 和手册不单独修改。

1. 阅读目标项目的设计约定，确定是在改工作台外壳、业务页面还是仅补规范。先检查现有结构、样式和交互；不要以统一规范为由批量换肤。
2. 按任务查下面对应章节，明确当前对象、主要动作和离开后的返回位置，再做局部改动。
3. 使用语义 token；保留已有框架和组件。只有任务本身使用 Ant Design 时才查其实际版本 API，不为这套语言强制引入 antd。
4. 修改后检查真实渲染及受影响操作链。已有通过证据可复用；失败就修对应问题，不扩大成无止境全站审计。
5. 新决定若具有复用价值，同步更新规则、token 和手册；交付说明哪些是规范、哪些已在产品实施。没有修改实现，不能报告全站已符合。

## 按需读取

| 任务 | 参考 |
| --- | --- |
| 颜色、字体、间距、图标与动效 | [基础](references/foundations.md) 与 [tokens](assets/tokens.json) |
| 图标盒、点击区、图文间距、光学对齐 | [图标与间距](references/foundations.md#icons--图标与间距)，再查 [组件状态](references/components.md) |
| 按钮、输入、导航、浮层、反馈 | [组件](references/components.md) |
| 画布、统一页面说明、需求元素关联、新建、状态展开 | [交互模式](references/patterns.md) |
| 文案精简、键盘、验收、规范维护 | [质量与维护](references/quality.md) |
| 对照 Figma / Ant 的证据或精确参数 | [来源与取舍](references/sources.md) |

可在 skill 目录执行，输出为 JSON：

```sh
python3 scripts/design_system.py query button
python3 scripts/design_system.py query icons
python3 scripts/design_system.py query links
python3 scripts/design_system.py tokens text
python3 scripts/design_system.py validate
```

在 skill 目录生成 HTML 手册。更新平台的 token 时，用 `--css-out` 指向仓库的 `public/assets/workbench-tokens.css`，并一起核对生成结果。

```sh
python3 scripts/design_system.py build --out /absolute/path/workbench-design-system.html
```

## 必须保留的产品判断

- 用户的内容是中心。导航不逐项加常驻解释；删掉后不影响定位、判断、下一步的文字直接删除。必要限制、失败恢复、原文和备注保留。
- 按控件用途选择图标、文字或二者组合。明确的状态和辅助标识优先图标，例如“已写／待写”；紧凑工具操作也可用图标。新建、提交、确认、完成、关联、恢复等承担主要任务或明确结果的动作，使用清晰的文字按钮，不因存在对应图形就去掉按钮文字。图标提供可访问名称及悬停／聚焦提示；具体对象名称、字段值和必要风险保留。具体判断见组件规则。
- 正常文字默认 400；工具标题及选中项 500。不要把所有标题、标签、按钮都加深加粗，也不要将必要内容变成禁用灰。
- 展开同一对象用披露控件；返回不同来源用导航。不能把展开/收起做成返回箭头。
- 新建可逆对象先创建，再原位命名。普通编辑自动保存；失败、冲突和未完成输入保留内容。空白新草稿可取消。
- 需求、元素、状态和来源通过稳定标识关联。跨视图保留来源、选择、滚动和缩放；点击已有元素不进入新增选取。
- Figma 官方插件颜色、编辑器观察与本项目校准分开说明。没有测量证据，不声称字号、间距或所有行为精确复刻。
- 图标外框、实际图形、点击区域和组件间距分别校验。保持同源 SVG、token 和状态组件，不靠逐页加 margin 或缩小点击区修正对齐；SVG 描边值注明坐标单位，不能混写为屏幕像素。
- 设计手册中的样例为本地演示，不代表工作台已拥有完整 Figma 图层、自动布局、协作或组件引擎。
