# 来源与取舍

## sources · 来源与取舍

核对日期：2026-10-16。规范引用用于说明设计依据，不把第三方的全部规格视为已采用。

| 来源 | 可确认的内容 | 本系统处理 |
| --- | --- | --- |
| [Ant Design 色彩](https://ant.design/docs/spec/colors-cn/) | 基础色板与产品语义的分层方式 | 借鉴结构，使用本系统色值 |
| [Ant Design 介绍](https://ant.design/docs/spec/introduce-cn/) | 设计指引、模式、资源与实现共同组成体系 | 规范、样例、token、skill 同源维护 |
| 本地 antd skill 与 CLI design.md | 写组件前查询 API、示例、token 与规范 | 提供本系统的按需查询脚本；不自动采用 antd 组件视觉 |
| [Figma 语义颜色](https://developers.figma.com/docs/plugins/css-variables/) | 插件公开语义 token：背景、文本、图标、边框，以及层级和交互修饰 | 借鉴命名和用途；品牌蓝及深蓝采用公开值，中文文字作校准 |
| [Figma UI3 设计过程](https://www.figma.com/blog/our-approach-to-designing-ui3/) | 内容优先，结合实际工作流迭代控件 | 优先真实操作与必要值的可见性，精简不能增加无意义步骤 |
| [Figma UI3 界面重构](https://www.figma.com/blog/behind-our-redesign-ui3/) | 围绕作品与任务安排界面 | 画布中心、上下文属性、紧凑工具 |
| [Figma Pattern Library](https://www.figma.com/blog/figma-pattern-library/) | 统一不同图标按钮为组件及状态；间距、圆角与颜色使用同源变量 | 同一 SVG 注册表、点击区域与状态组件；参数和规则共同维护 |
| [Figma tooltip 组件教程](https://help.figma.com/hc/en-us/articles/22690735962263-Create-a-tooltip-component-set) | 提示按内容适配，覆盖不同位置，限制长度避免遮挡 | 提示随图标出现，支持悬停与聚焦，短动作名称加实际快捷键 |

### 参数与证据边界

公开插件浅色文字 token 包含主文字 #000000e5、次级 #00000080、三级/禁用 #0000004d。它们不是本项目的全部文字颜色，也不证明当前 Figma 编辑器每个控件都使用同样数值。

本项目保留主文字 #383838、次级 #707070、工具 12px/20px/400 等中文校准；尺寸、圆角、间距和字重为明确的本地决策。深蓝白字按钮用于提升小字可读性。未获取当前编辑器的全量实测属性，不使用“像素级完全一致”的表述。

2026-10-16 图标补充：将 SVG 坐标系、显示盒、实际图形与点击区域分开记录。当前 24 viewBox / 16px 显示 / stroke-width=1.5（SVG 单位）、32/36/44px 点击区和 4/8px 组间距沿用已确认实现，不将本地参数标为 Figma 官方数值。Figma 教程中的示例字号、padding 与圆角属于教学样例，不直接作为编辑器实测 token。

### 与旧规范的关系

保留此前已验证的操作语义：需求与元素往返、自动保存、原位新建、状态展开、移除重复说明。1.0 将分散规则整理成体系，随后已按用户授权应用到工作台外壳和相关控件，当前确认版本作为维护基线。旧对比页面和阶段截图退出常规原型列表，完整归档保留。业务原型继续沿用各端的设计语言。

不使用 Figma 标识作为本系统品牌，不暗示 Figma 或 Ant Design 官方提供或背书。可视手册中的布局和例子为本项目自行实现。
