# 本机需求工作台设计 CLI

用于 MySQL 模式下的原生设计批量编辑。在仓库根目录使用 `npm run design -- help` 查询能力，命令和字段以 [设计 CLI](../../../../DESIGN_CLI.md) 为准。

## 入口与身份

以下命令在仓库根目录执行，也可使用 `node scripts/designs.js …`。输出文件放在用户选定的临时目录。示例使用 `/tmp`，请按环境替换并避免覆盖现有草稿。

```bash
npm run design -- help
npm run design -- whoami
npm run design -- list --path '01-协作工具/知识库投稿'
```

设计和流程 CLI 共用同一来源地址的登录态。缺少有效会话时，由用户在终端执行 `npm run design -- login`（也可使用 flow login）；密码交互不回显、不保存密码。`--password-stdin` 供受控自动化使用，不把密码写进命令行、聊天或文档。不要从浏览器获取 Cookie，不冒用数据库用户或绕过需求所有者权限。401 需要正常登录，403 需使用有权编辑的账号；不要靠改本地数据规避。

可用 `workbench config --url http://服务器局域网IP:8125` 保存局域网服务地址，或用 `--url` 临时指定；与统一 workbench CLI 共用登录。草稿记住来源地址，提交不能改投其他实例。

## 从当前设计开始

示例中的 `article-detail` 是假设已导入的画板。编辑已有设计时使用 list 返回的页面 ID。首次创建设计时先 pull，再从「整页制作、批量提交」中的 import 步骤开始。

```bash
npm run design -- pull --path '01-协作工具/知识库投稿' --out /tmp/design-draft.json
npm run design -- show --file /tmp/design-draft.json --page article-detail
npm run design -- html --file /tmp/design-draft.json --page article-detail --out /tmp/article-detail.html
```

草稿包含 `base`、`draft`、来源和流程页面引用上下文。编辑 `draft` 或使用下列命令，不修改 `base`、版本号和来源。它是暂存副本，不能放成工作台的新正式 JSON 源。输出路径已存在会拒绝覆盖；连续修改同一草稿使用 import/patch/note 的原文件即可，`--out` 可另存分支草稿。

## 页面说明与待设计页

页面目录直接来自 `workspace.pages`；跨页说明用 `workspace.overview`，单页说明用 `page.description`，均随设计保存与回滚。多状态的公共说明只保存一份，其他状态用 `descriptionPageId` 引用所有者，不能同时保存自己的 description，也不能链式引用。变更摘要仍使用 `changeSummary`。

```json
[
  {"op":"workspace.update","set":{"overview":"当前跨页路径与公共约定"}},
  {"op":"page.update","id":"article-detail","set":{"description":"# 文章详情\n\n当前字段、交互和异常。"}},
  {"op":"page.update","id":"article-detail-readonly","set":{"descriptionPageId":"article-detail"},"unset":["description"]}
]
```

仅有说明时用 `page.add` 建立 `status: planned`、空 HTML 的页面，并提供稳定 ID、名称、尺寸、位置；补图后沿用同一 ID，import 会置为 designed。待设计页不进入业务预览。

旧 `页面设计/*.md` 不再编辑；`design documents --path 主题` 查询迁移承接与历史。常规编辑不使用 migrations 参数。已有迁移的旧链接定位当前设计说明或只读历史，不从历史恢复独立页面模块。页面合并或删除前迁移有效 description 并重定向 descriptionPageId，保留有效元素说明、需求和流程关联。

## 整页制作、批量提交

新增页面先编写 HTML/CSS，再导入；更新页面优先从当前画板导出 HTML，保留 `data-wb-element` 标识后修改。

```bash
npm run design -- import --file /tmp/design-draft.json --page article-detail --html /tmp/article-detail.html --name '文章详情' --width 1440 --height 900 --platform Web --group '知识库'
npm run design -- check --file /tmp/design-draft.json
npm run design -- diff --file /tmp/design-draft.json
npm run design -- apply --file /tmp/design-draft.json --dry-run
npm run design -- apply --file /tmp/design-draft.json
```

- `import` 更新同 ID 的页面；新增页面必须给 `--name`，默认 1440×900。可指定 x/y、route、source、platform、group；多画板逐一导入同一草稿后一次 apply。
- `source` 如使用，应是当前主题下 `原型设计/*.html` 的逻辑路径；`route` 为 `#...`。画板 HTML 是副本，不会自动追踪 source 文件，import 也不会回写 source。
- `check` 检查结构与静态引用；`diff` 展示画板、元素说明和关联变化。检查结果不证明实际布局或交互正常。
- dry-run 使用当前服务端权限、版本和关联规则校验，不写数据库。apply 将设计与说明一起原子保存，再回读核对；无变化不产生新版本。
- 发生 409 时重新 pull 到另一个文件，比对后重新施加本次变更；不要替换版本号强推。网络请求结果不确定时先回读核对，不自动重放写入。若显示 saved=true、verified=false，按输出处理回读或本地基线问题，不能当成完全未保存。

## 局部改文案与样式

先通过稳定 ID 找元素，使用返回的文本槽序号和原始文本；不要把 DOM 顺序或 CSS 路径当作长期 ID。

```bash
npm run design -- elements --file /tmp/design-draft.json --page article-detail --match '确认'
npm run design -- patch --file /tmp/design-draft.json --ops /tmp/design-ops.json
```

操作文件是 JSON 数组。以下 ID、文本槽和 expected 须替换为 elements 的实际结果：

```json
[
  {"op":"element.text","pageId":"article-detail","id":"el-11111111-1111-4111-8111-111111111111","index":0,"expected":"确认","value":"确认提交"},
  {"op":"element.style","pageId":"article-detail","id":"el-11111111-1111-4111-8111-111111111111","property":"font-size","value":"14px"}
]
```

文本修改保留其他源码和子元素，并检查 expected，避免改错文本。简单样式使用支持的 17 项常见属性和值，value 为空字符串表示移除该行内属性；calc/var 等复杂值、布局、媒体查询和脚本逻辑从当前 HTML 修改后 import。运行时生成、源码里无法唯一定位的元素不强行静态修改，回到生成该元素的 HTML/脚本处理并在浏览器验证。

page.add/update/remove 可用于组合画板元数据操作；具体 schema 读 `DESIGN_CLI.md`。继续使用的画板保持既有 page ID；已淘汰画板迁移依赖后删除，不能为通过校验直接删业务内容。

## 元素说明与需求关联

```bash
npm run design -- note --file /tmp/design-draft.json --page article-detail --element el-11111111-1111-4111-8111-111111111111 --id note-confirm --text-file /tmp/confirm-note.txt
npm run design -- rules --path '01-协作工具/知识库投稿'
```

note 根据稳定元素 ID 创建或更新页面元素说明，更新时保留原需求关联。修改关联时，从 rules 返回值复制当前 `file`、`blockId`、`quote`、`heading`，用 `note.update` 的 `set.requirements` 保存；数组代表完整目标集合，保留仍有效的既有项。不要凭空编规则 ID 或用同义改写替代原引用。设计 CLI 不修改流程说明。

整页替换或删除元素前检查说明与需求关联。若锚点失效，保留原元素 ID 或将说明明确迁移到真实承接元素，不用清空说明来消除错误。已有历史问题的 warning 需要如实记录，本次新增断链应修正后提交。

## 合并后删除淘汰页面

先从本次拉取的版本确认删除范围和承接页面。工作台的原生画板与静态源原型是两份独立产物，清理一份不会自动清理另一份。

1. 检查旧页的流程节点引用、页面跳转、源文件、单文件原型的页面集合，以及元素说明和需求关联。有效内容迁到保留页；说明完全重复且需求关联已保留时才去重，保留独有的用户备注。
2. 有流程引用时，用 flow CLI 把 `pageId` 改挂到真实承接页面并保存。随后重新 `design pull` 取得最新引用上下文；不手改 `context.flowLinks` 伪造解除依赖，也不因旧链接存在就保留空壳画板。
3. 用 `page.remove` 删除淘汰画板，同批迁移或合并关联说明，按正常 check、diff、dry-run、apply 和回读流程保存。
4. 核对静态附件未被其他窗口改动，再删除已授权淘汰的 HTML 源稿，并同步原型页面集合和跳转。共享 CSS、脚本、仍被引用的资源及现状参考图不随旧页误删；不要用改名或移入隐藏目录代替用户要求的删除。
5. 在实际工作台同时检查“已保存画板”和“源原型”列表，再走通受影响的流程入口、详情页签、操作与返回路径。确认旧页不再参与当前交付，保留页的状态、对象归属和权限仍完整；只重跑受本次清理影响的验证。

## 验收与导出

apply 成功后用 `link` 获取工作台入口，在浏览器看保存后的设计，验证目标 viewport、关键状态和核心交互。日常设计写入通过 CLI 完成，浏览器主要用于视觉和交互验证。

```bash
npm run design -- link --path '01-协作工具/知识库投稿' --page article-detail
npm run design -- export --file /tmp/design-draft.json --page article-detail --format png --scale 2 --out /tmp/article-detail.png
npm run design -- export --file /tmp/design-draft.json --page article-detail --format html --out /tmp/article-review.html
```

export 导出的是草稿当前画板快照，不会先保存工作台。要导出最终版本，使用 apply 后更新的草稿，或重新 pull。支持 PNG/JPG/PDF/HTML；可用逗号选择多画板，或用 `--all` 选择全部。实际选择多张时输出后缀须为 `.zip`，只有一张时仍使用对应格式后缀。每次最多 20 张，图片单张 3200 万像素、总计 6400 万像素；PNG 可用 `--transparent`。

图片/PDF 由独立渲染环境生成，仅可读取当前主题原型附件和工作台公开 assets；不要依赖业务登录态、外网资源或真实接口副作用。HTML 导出保留当前工作台资源 base，不保证离线自包含；若要共享或离线归档，按用户范围处理引用资源。静态图片不能替代用户要求的可交互 H5。
