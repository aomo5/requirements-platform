# 设计工作台 CLI

在仓库根目录运行 `npm run design -- help` 查看全部命令。

设计正式数据保存在工作台 MySQL，CLI JSON 是带版本基线的临时编辑草稿。原生画板 HTML 是快照，`source` 仅记录资源位置；原型文件和画板不会自动相互覆盖。

## 登录与读取

```sh
npm run design -- login
npm run design -- whoami
npm run design -- list --path '01-协作工具/知识库投稿'
npm run design -- pull --path '01-协作工具/知识库投稿' --out ./design-edit.json
```

与 flow CLI 共用正常账号会话，只需登录一次。默认本机地址 `http://127.0.0.1:8125`，可用 `--url`、`WORKBENCH_URL` 或 `workbench config --url 地址` 指定局域网服务，详见 [团队 CLI](./WORKBENCH_CLI.md)。会话沿用 `~/.config/requirements-workbench/flow-cli/` 的实例专属文件（目录 0700、文件 0600），不保存密码。不借用浏览器 Cookie 或直接写数据库。

`pull` 不覆盖已有文件。草稿固定来源实例及设计、说明两个版本，不受后续环境地址变化影响。

## 整页设计

在对应需求的 `原型设计/` 编写 HTML/CSS，再导入画板。修改已有画板时先导出当前 HTML，保留 `data-wb-element`；不要从旧 source 文件覆盖较新的画板。

```sh
npm run design -- html --file ./design-edit.json --page article-detail --out ./article-detail.html
# 编辑导出的 HTML/CSS，再更新同一画板 ID：
npm run design -- import --file ./design-edit.json --page article-detail --html ./article-detail.html
# 新增画板须给名称，默认 1440×900、位置 0/0：
npm run design -- import --file ./design-edit.json --page article-empty --name '文章空状态' --html ./article-empty.html --width 1440 --height 900 --x 1600 --y 0 --platform Web --group 知识库
```

导入会补齐缺失元素 ID，已有唯一 ID 保留。多次 `import` 可写入同一草稿，最后一次批量提交；新增画板请安排位置。`patch/import/note` 可加 `--out` 保留原草稿。

## 局部修改与说明

```sh
npm run design -- elements --file ./design-edit.json --page article-detail --match 提交
npm run design -- show --file ./design-edit.json --page article-detail --element el-实际编号
npm run design -- patch --file ./design-edit.json --ops ./design-ops.json
npm run design -- note --file ./design-edit.json --page article-detail --element el-实际编号 --id submit-note --text-file ./submit-note.txt
npm run design -- rules --path '01-协作工具/知识库投稿'
```

操作文件为 JSON 数组，元素 ID、文字槽位须采用 `elements` 的真实结果：

```json
[
  {"op":"element.text","pageId":"article-detail","id":"el-真实UUID","index":0,"expected":"提交","value":"确认提交"},
  {"op":"element.style","pageId":"article-detail","id":"el-真实UUID","property":"color","value":"#1677ff"},
  {"op":"workspace.update","set":{"overview":"作者投稿后进入编辑审核。"}},
  {"op":"page.update","id":"article-detail","set":{"description":"展示标题、摘要和审核状态。"}},
  {"op":"note.update","id":"submit-note","set":{"text":"检查必填字段后提交"}}
]
```

- `workspace.update` 用 `set.overview` 更新设计总说明。
- `page.add/update/remove` 按 `id` 操作。新增用 `value`，更新用 `set` 和可选 `unset`。`description` 保存页面说明，`descriptionPageId` 指定共用说明的页面，`status: "planned"` 登记待设计页面。
- `element.text`：只改指定直接子文本槽位，`index/expected` 必须匹配，保留子元素及脚本。动态生成且不在源 HTML 的元素应修改原型渲染逻辑。
- `element.style`：支持字号、字重、行高、颜色、文字对齐、背景色、边框颜色/宽度/样式/圆角、四边内边距、gap、width、height。设置内联 `!important`，空字符串清除属性；常见字面长度、颜色和枚举可用，复杂 CSS 用 HTML 编辑。
- `note.add/update/remove`：仅改页面元素说明，流程说明原样保留。快捷 `note` 自动构造稳定锚点并保留既有需求关联。`note.update` 的 `set.requirements` 可维护关联，从 `rules` 读取当前 `file/blockId/quote/heading`，不要编造 ID。
- 新增失效的流程页面引用、元素说明会阻止提交。删除或替换页面时，同批迁移或删除受影响页面说明；流程的页面关联通过 flow CLI 先调整。旧失效引用会报告，不自动清空。

## 检查与保存

```sh
npm run design -- check --file ./design-edit.json
npm run design -- diff --file ./design-edit.json
npm run design -- apply --file ./design-edit.json --dry-run
npm run design -- apply --file ./design-edit.json
npm run design -- versions --path '01-协作工具/知识库投稿'
```

`check` 校验结构和引用，`diff` 展示相对基线的变更，`dry-run` 在服务端核对当前版本、权限和需求关联但不写历史。正式 `apply` 在一个事务内保存画板与说明，回读核验并更新本地基线；无变化不增加版本。

409 时重新 `pull` 到新文件后合并，不替换版本号强推。连接中断可能使保存结果不确定，先回读核对，不自动重试。服务确认保存后回读失败，或本地草稿在请求期间被修改，会报告 `saved:true`、`verified:false`；保留后续本地修改，按提示重新读取比对。

## 导出与视觉验证

```sh
npm run design -- export --file ./design-edit.json --page article-detail --format png --scale 2 --out ./article-detail.png
npm run design -- export --file ./design-edit.json --all --format html --out ./design-pages.zip
npm run design -- link --path '01-协作工具/知识库投稿' --page article-detail
```

支持 PNG/JPG/PDF/HTML，多画板输出 ZIP，可用逗号指定多个 ID。导出当前草稿快照，不保存数据库、不覆盖已有文件。HTML 导出引用工作台资源地址，带资源时不是完全离线包；`html` 命令导出可再次导入的原始画板 HTML。

图片/PDF 复用独立 Chromium 渲染器。1×/2×/3× 作用于图片，透明背景仅 PNG。每次最多 20 张，单图 3200 万像素、总计 6400 万像素、文件最多 64 MB；缺资源或浏览器时明确报错。

结构检查、导出成功不等于设计验收。仍需在浏览器检查目标尺寸、布局、字体、实际路由/状态、核心交互、元素说明定位，再回填对应规格与页面说明。

退出码：0 成功，1 参数/连接，2 校验或保存后核验未完成，3 版本冲突，4 未登录/无权限。

## 接口与测试

- `GET /api/design/bundle?path=...` 同事务读取设计、说明、流程页面引用。
- `POST /api/design/batch?path=...` 接受 `expectedRevision`、`expectedAnnotationsRevision`、`pages`、`notes` 及可选 `overview`、`dryRun`。沿用同源、登录及需求创建者权限，请求上限为 12 MB。
- `npm run test:design-cli`：CLI、模型和事务边界测试。
- `WORKBENCH_DESIGN_BATCH_DB_TEST=1 node --test tests/design-batch.test.js`：真实测试库随机前缀，仅清理本次前缀。
- `WORKBENCH_EXPORT_BROWSER_TEST=1 node --test --test-name-pattern='installed Chrome' tests/design-export.test.js`：既有 Chrome 渲染 PNG/JPG/PDF 检查。
