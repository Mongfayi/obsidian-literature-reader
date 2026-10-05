# 文献阅读助手插件技术手册

> 面向 AI 查阅的简洁参考。插件 ID: `pdf-reader`，插件名「文献阅读助手」，版本 `2.5.1`，`minAppVersion: 1.7.0`，仅桌面端（`isDesktopOnly: true`）。

---

## 1. 概述

由原 pdf-reader 与 deepseek-sidebar 合并而来，围绕「PDF 阅读 → 批注 → 笔记」一站式流程，集成 DeepSeek 浮动窗口与截图 OCR 批注。模块化结构：`main.ts` 仅做编排，功能下沉到 `modules/` 目录，各模块实现 `PluginModule`（`load`/`unload`）生命周期。

### 模块清单

| 模块 | 文件 | 职责 |
|------|------|------|
| PdfReaderModule | `modules/PdfReaderModule.ts` | 开始阅读（PDF 与 md 文献）、关键词提取、文字/截图/OCR 批注写入笔记（写入后聚焦目标笔记 `focusNoteLeaf`）、上传文件数据源 |
| DeepSeekModule | `modules/DeepSeekModule.ts` | DeepSeek 浮动窗口/工作区标签页（webview）、拖拽/最小化、上传当前文件到聊天框 |
| ScreenshotModule | `modules/ScreenshotModule.ts` | 截图批注：框选区域 → PDF 嵌入链接（无图片文件），注册自定义 EmbedCreator 实时渲染裁剪区 |
| ScreenshotHighlightModule | `modules/ScreenshotHighlightModule.ts` | 截图批注区域持久高亮（笔记 `&rect=` 链接驱动，黄色边框、内部不填充） |
| OcrModule | `modules/OcrModule.ts` | 截图 OCR 批注：框选 → 截取 canvas → LM Studio 视觉模型识别 → 写入笔记 |
| OcrService | `modules/OcrService.ts` | LM Studio OpenAI 兼容接口封装（模型列表、识别、文本清洗） |
| PdfHighlightModule | `modules/PdfHighlightModule.ts` | 文字选区持久高亮（笔记 `&selection=` 链接驱动） |
| OcrHighlightModule | `modules/OcrHighlightModule.ts` | OCR 区域持久高亮（笔记 `&ocr=` 链接驱动，不可交互） |
| PdfJumpModule | `modules/PdfJumpModule.ts` | 双向跳转：点击 PDF 高亮 → 笔记对应批注；点击笔记 PDF 链接 → PDF 对应位置（目标未打开时自动分屏） |
| AnnotationModeModule | `modules/AnnotationModeModule.ts` | 批注原文附带模式（测试功能）：工具条「附带原文」开关，默认关闭=只写链接（定位 + 用户输入）；开启=附带原文（原文 / 定位 / 笔记：）。按钮图标化，状态靠 tooltip 区分 |
| QuickTagModule | `modules/QuickTagModule.ts` | 快速添加标签：PDF / Markdown 工具条「标签」按钮 / 命令快捷键唤起选择器，词表取自设置里的 `quickTags`，把 `#标签 ` 插入笔记光标处；首次运行做一次性迁移 |
| MarkdownReadingModule | `modules/MarkdownReadingModule.ts` | Markdown 批注：来源笔记标记、工具条、浮动「批注到笔记」按钮、写入蓝框/纯链接；点击「定位」链接时接管导航（复用已打开的文献叶子，未打开则左侧分屏，不替换当前笔记）并**只点亮来源里对应的 `==…==`**（避免 Obsidian 原生按标题闪整节） |
| MarkdownAnnotationSync | `modules/MarkdownAnnotationSync.ts` | Markdown 批注配对记录：把「定位」链接 ↔ 来源 `==…==` 配对；点击链接时按记录还原批注位置，删除链接时同步撤销 `==` 包裹（保留正文文字） |
| linkLocator | `modules/linkLocator.ts` | 纯逻辑（无 Obsidian 依赖）：点击的 wikilink → 原文中的第几条链接、`==…==` 在全文中的序号、`<mark>` 文本核对 |
| TagSyncModule | `modules/TagSyncModule.ts` | 标签同步：词表改名落到笔记正文、安全删除标签（全库扫描 → 逐行预览 → 二次确认）。**不提供撤销**，因此失败会如实上报而非静默跳过 |
| tagVocabulary | `modules/tagVocabulary.ts` | 纯逻辑（无 Obsidian 依赖）：稳定 id 词表操作（改名/删除/移动/查重）、文本解析与序列化、正文标签替换/删除/扫描 |
| SettingsTab | `modules/SettingsTab.ts` | 统一设置面板（PDF / DeepSeek / OCR 三段） |
| BaseCropModeModule | `modules/BaseCropModeModule.ts` | 截图模式公共基类（框选交互、工具条按钮注入） |
| HighlightBase | `modules/HighlightBase.ts` | 持久高亮公共基类（事件挂载、防抖重建、渲染调度） |
| toolbarPoller | `modules/toolbarPoller.ts` | 共享 2s 轮询器 + 陈旧叶子清理 |

---

## 2. 配置项

定义于 `types.ts` 的 `PluginSettings`，默认值见 `DEFAULT_SETTINGS`。

| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `readingNoteFolder` | `string` | `"ReadingNotes"` | 阅读笔记存放文件夹（相对 vault 根），不存在自动创建 |
| `deepseekUrl` | `string` | `"https://chat.deepseek.com"` | DeepSeek 窗口/标签页网页地址，改后重开窗口或标签页生效 |
| `deepseekOpenMode` | `"floating" \| "tab"` | `"floating"` | 默认打开方式：Ribbon 图标与默认命令采用浮动窗口或工作区标签页 |
| `ocrServerUrl` | `string` | `"http://127.0.0.1:1234"` | LM Studio 服务器地址（OpenAI 兼容接口） |
| `ocrApiKey` | `string` | `""` | LM Studio API Key（开启 Require Authentication 时必填，密码型输入框） |
| `ocrModel` | `string` | `"paddleocr-vl-1.6"` | OCR 模型名，空 = 自动选择服务器视觉模型 |
| `ocrRequestTimeoutSec` | `number` | `120` | 单次 OCR 请求超时（秒，下限 10） |
| `ocrMaxTokens` | `number` | `8192` | 单次识别最大输出 token（下限 512） |
| `ocrPrompt` | `string` | `"OCR:"` | OCR 提示词（PaddleOCR-VL 用任务词如 `OCR:`） |
| `quickTags` | `TagDef[]` | `[]` | 标签定义列表（稳定 `id` + `name` + `description`）；标签的唯一真源，在设置面板「标签管理」中逐行编辑 |
| `pendingTagRenames` | `PendingRename[]` | `[]` | 待同步到笔记的改名（`{id, from, to}`）；用户改名瞬间登记，同步或「撤销改名」后清空 |
| `quickTagToolbarButton` | `boolean` | `true` | 是否在每个 PDF 视图工具条注入「标签」按钮；关闭后仅保留命令/快捷键入口 |

设置面板 500ms 防抖保存；关闭面板时冲刷未落盘修改。OCR 设置区含「测试连接」按钮（拉取 `/v1/models` 列出可用模型）。

---

## 3. 架构与编排（main.ts）

`LiteratureReaderPlugin` 仅负责设置加载、模块实例化与生命周期：

1. 创建 `PdfReaderModule`（其 `getCurrentFileForUpload` 注入 DeepSeek 上下文）
2. 创建 `PdfHighlightModule`，把 `highlightModule.refresh` 注入 `pdfModule.setRefreshHighlights`
3. 创建 `ScreenshotModule(ctx, pdfModule)`、`OcrModule(ctx, pdfModule)`
4. 创建 `OcrHighlightModule`，把 `ocrHighlightModule.refresh` 注入 `ocrModule.setHighlightRefresh`
5. 创建 `QuickTagModule(ctx, pdfModule)`（快速添加标签，复用 `pdfModule.getAnnotationTargetNote` 定位目标笔记）
6. 创建 `TagSyncModule(ctx)`（标签同步，并把实例传给设置面板用于渲染变更区）
7. 模块按顺序加载，**单个失败不拖垮其余**（try/catch 兜底）；卸载逆序
8. 注册统一设置面板 `UnifiedSettingTab`

模块通过 `ModuleContext`（`plugin` / `getSettings` / `saveSettings` / 可选 `getCurrentFileForUpload`）访问共享资源，避免直接耦合。

---

## 4. PdfReaderModule 核心 API

### 4.1 `startReading(sourceFile: TFile, noteFile?: TFile): Promise<void>`
「开始阅读」入口：把要读的文献与它的阅读笔记并排打开（左文献 / 右笔记，焦点给笔记）：
1. 笔记取 `noteFile`；未指定时 `createReadingNote(sourceFile)` 按命名模板创建/复用
2. 文献已打开则复用叶子，否则新 tab 打开
3. 笔记已打开则聚焦，否则在文献右侧 `createLeafBySplit('vertical')` 分屏打开
4. 焦点切到笔记

`sourceFile` 可以是 PDF，也可以是 Markdown（md 文献同样按模板建「{name} 阅读.md」）。
防重复键：传了 `noteFile` 时是「文献路径::笔记路径」，否则是文献路径。

### 4.1.1 `startReadingForNote(mdFile: TFile)`：右键 Markdown 的分流
`file-menu` 对 `.md` 也注册「开始阅读」，先判断这篇 md **是阅读笔记还是待读文献**：

| 情况 | 判据 | 行为 |
|------|------|------|
| 阅读笔记 | 位于 `readingNoteFolder` 内，或 basename 符合命名模板 | `resolveNoteSource` 找它对应的文献 → 打开文献 + 这篇笔记；文献是 md 时把它标记为「正在阅读的文献」；找不到文献只提示，不建笔记 |
| 待读文献 | 其余 md | 左边打开这篇 md，右边按模板创建/复用「{md 名} 阅读.md」，并把它标记为「正在阅读的文献」（选中它的文字即可批注进右侧笔记） |

判据**不能只看「有没有 pdf 字段」**：精读版章节原文（`reference/GWAS中文版/*.md`）同样带 pdf 字段，
但它们是要读的文献、不是笔记；按「在不在阅读笔记文件夹 / 名字像不像笔记」判断才分得开。

### 4.1.2 `resolveNoteSource(note)` / `isReadingNote(md)` / `setReadingSourceProvider(cb)`
- `resolveNoteSource`：frontmatter 的 `pdf` / `source` 字段（`getFirstLinkpathDest` → `vault.getAbstractFileByPath` 两级兜底，兼容无扩展名/相对路径/仅文件名），目标须是 pdf 或 md；都没有时按命名模板反查同名 PDF（与 ReadingNoteMarkerModule 同一套规则，同名不唯一返回 null，不猜）
- `isReadingNote`：md 在阅读笔记文件夹内，或 basename 匹配命名模板
- `setReadingSourceProvider`：main.ts 注入 `MarkdownReadingModule.setReadingSource(path)`，让「开始阅读」把左侧 md 设为批注来源

### 4.2 `createReadingNote(sourceFile: TFile): Promise<TFile | null>`
**命名规则**：`{文献文件名} 阅读.md`，存于 `readingNoteFolder`；同名冲突时按 `{文件名} 阅读 (n).md`（n=2..99）递增去重，全部占用返回 `null`。
文献可以是 PDF 或 Markdown，同一套流程（`resolveNotePath` 的去重与 `resolveNoteSource` 互为逆运算）。
- 通过 frontmatter `pdf`（PDF 文献）/ `source`（md 文献）字段判别归属；字段缺失的旧笔记沿用「存在即复用」
- 引用的路径失效且文件名一致时（文献被移动/改名），判定同一文献复用并**自动修复该字段**
- 目标路径被同名文件/文件夹占用时返回 `null`

**生成内容**：
- frontmatter：`pdf: "[[路径]]"`（PDF 文献）或 `source: "[[路径]]"`（md 文献）、`created: 日期`、`tags:`（仅 PDF 提取关键词，失败则省略）
- 正文：来自设置项 `readingNoteBodyTemplate`（默认空）
- 文本提取优先用 Obsidian 自带 `window.pdfjsLib`，缺失时回退内置 `pdfjs-dist` + 自定义 `CMapReaderFactory`（读取 `cmaps/` 目录）；逐页并行提取，单页失败跳过

### 4.3 批注入口（三个统一走 `getCursorNotePos`）

| 方法 | 触发 | 链接形式 |
|------|------|----------|
| `handleAnnotation()` | 浮动按钮「批注到笔记」（文字选区） | `&selection=bi,bo,ei,eo` |
| `annotateScreenshot(pdfFile, page, rect)` | 截图批注模块调用 | `![[...#page=N&rect=x1,y1,x2,y2]]`，页面链接同样带 `&rect=` 以便点击精确定位 |
| `annotateOcrText(pdfFile, text, page, ocrRect?)` | OCR 批注模块调用 | `&ocr=x,y,w,h`（无文本锚点） |

**`getCursorNotePos()`**：批注落点**跟随光标** —— 返回「最近获得焦点的笔记」及其编辑器光标位置，与当前焦点无关（在 PDF 里选中文字时焦点已转到 PDF，`getActiveViewOfType(MarkdownView)` 会返回 null，故用 `lastNotePath` 记录）。**没打开笔记时返回 null，调用方硬失败并提示，绝不自动创建/打开笔记，也不静默改写到他处。** 批注 callout 内原文链接始终用源 `pdfFile` 构造，跳转指向源 PDF。

**批注格式**（callout 块，自定义类型 `[!pdf-annotation]`，无标题；多段选中合并为一个块，段间空行分隔并带独立页码引用）：
```markdown
> [!pdf-annotation]
> {选中文字}
> [[{PDF路径}#page={页码}&selection={beginIndex},{beginOffset},{endIndex},{endOffset}|定位]]
>
> 笔记：
```
- 使用自定义 callout 类型 `[!pdf-annotation]`（不带标题），样式由 `styles.css` 控制：隐藏标题栏、内容区内边距清零、首尾元素 margin 清零，蓝色框紧贴批注内容
- 链接目标用 PDF 完整路径（`pdfFile.path`），避免同名歧义
- 选区定位失败（跨页/文本层未渲染）：`page=null`，仅写文字不附链接，输出 warn
- 无文本锚点（OCR / 标题等无 `data-idx` 文本）：`beginIndex=-1`，仅页码链接；OCR 附 `&ocr=x,y,w,h`
- 写入经 CM6 编辑器 `replaceRange`（落点 = 光标所在笔记）；入口硬校验：目标笔记未打开 / 处于阅读模式（无编辑器）时直接提示失败，不回退文末追加
- 写入后**焦点移动到被批注的笔记**（`PdfReaderModule.focusNoteLeaf`）：附带原文模式光标定位到「笔记：」行尾，只写链接模式光标停在链接后；写入失败选区自动恢复
- 粘贴修正（CalloutPasteModule）：在批注 callout 内粘贴多行文本时，自动改写为 callout 续行格式（首行原样衔接光标处、其余行补 `> ` 前缀、空行转 `>`），保证全部内容留在蓝框内；仅拦截 `[!pdf-annotation]`，callout 外与其他 blockquote 的粘贴不受影响
- 文本清洗：移除换行/控制字符/Unicode 换行符号，以及 PDF 私有区字符（U+E000–U+F8FF，无 ToUnicode 映射的字形占位符）

**「附带原文」关闭时的精简格式**（AnnotationModeModule 注入 `includeOriginalTextProvider`，默认关闭；测试功能，以后可能删除）：文字选中批注只写「定位」链接（无 callout、无「笔记：」提示行，光标停在链接后）；OCR 批注只写识别文字；截图批注只写图片嵌入。开启后三种批注均附带定位链接与「笔记：」提示行。**两种模式下写入完成后焦点都移动到目标笔记**（`focusNoteLeaf`：激活其叶子 + `editor.focus()`，只激活已打开的叶子、不新建分屏；找不到叶子或 `setActiveLeaf` 抛错时仅 warn，不影响批注写入结果）。

**历史旧笔记缩短**：命令 `shorten-pdf-annotation-links`（“将当前笔记中的 PDF 批注链接显示文字改为「定位」”）会读取当前 Markdown 笔记，将形如 `[[*.pdf#page=…|XXX, 页面 N]]` 的链接显示文字替换为 `定位`，不改变链接目标与定位参数，因此既有跳转/高亮功能不受影响。

### 4.4 `getCurrentFileForUpload(): Promise<FileUploadData | null>`
供 DeepSeek 上传：
- PDF 视图：读取二进制（`application/pdf`）
- Markdown 视图：读取文本编码 UTF-8（`text/markdown`）
- 其他：兜底活动 `.md` 文件；无可用文件返回 `null`

### 4.5 关键词提取 `extractKeywords(text): string[]`
- 正则（优先级）：`/关键词[：:∶]?/`、`/关键字[：:∶]?/`、`/[Kk]eywords?[：:∶]?/`，原始文本与去空格文本各试一次
- 停止标记：`中图分类号`、`文献标识码`、`文章编号`、`DOI`、`分类号`、`收稿日期`、`修回日期`、`基金项目`、`Abstract`、`Keywords` 等（含被空白打断的变体，紧凑文本定位后映射回原文）
- 分割符：优先 `；;，,`；结果不足 2 个回退空格分割
- 标签：空格转 `-`、去特殊字符、去重、长度上限 40

---

## 5. DeepSeek 浮动窗口 / 标签页（DeepSeekModule）

- **默认打开方式**：设置中 `deepseekOpenMode` 可选浮动窗口或标签页；Ribbon 机器人图标「打开 DeepSeek」按此方式打开
- **浮动窗口**：命令 `toggle-deepseek-float` 打开/隐藏
- **标签页**：命令 `open-deepseek-tab` 在工作区标签页打开，已打开则聚焦
- **拖拽**：按住标题栏（非按钮区）拖动，拖动期禁用 webview 指针事件；不钳制边界，可拖出 Obsidian 窗口（超出部分视口裁剪）
- **最小化**：标题栏「－」按钮
- **防丢失**：重新显示时若面板完全移出可视区域，复位到默认位置
- **加载文件**：标题栏「加载文件」按钮，或命令 `deepseek-add-current-file`
- **层级（z-index）**：浮窗默认 `z-index: 99999`（styles.css `.deepseek-float-container`），保证压过 PDF 批注/OCR 高亮层与页面内容；一旦有模态对话框（设置窗口、插件弹窗等）打开，`body:has(> .modal-container)` 规则把它降到 `40`——低于 Obsidian 模态层 `--layer-modal: 50`，对话框关闭后自动恢复，因此设置界面始终盖在浮窗之上

### `addCurrentFileToChat()`
1. `getCurrentFileForUpload` 取文件数据，超过 100MB 拒绝
2. ArrayBuffer → base64（32KB/块，避免栈溢出与内存峰值）
3. 分块注入 webview 页面变量（8MB/块，每次上传独立变量名防并发污染）
4. 组装上传脚本：策略 A 找 `<input type="file">` 用 DataTransfer 赋值触发 change；策略 B 兜底在输入区模拟 dragover + drop
5. 返回 `success` / `drop` / `not-found`

### guest 端注入脚本（`dom-ready` 时注入，页面刷新后自动重注入）

| 脚本 | 标识 | 作用 |
| --- | --- | --- |
| `POINTER_PROBE_SCRIPT` | `__ds_pointer_probe` | 指针无按键进入 webview 时经 console 回报宿主，宿主注入 mouseUp 消除卡死的滚动条拖拽 |
| `HTML_PREVIEW_COMPAT_SCRIPT` | `__ds_html_preview_fix` | 把 text/html 类型的 blob URL 改写为 `srcdoc`，修复 HTML 预览空白（见下） |

#### HTML 预览空白问题与修复（v2.5.0）

- **现象**：DeepSeek 网页端的 HTML 预览在浮动窗口里一片空白，换成 Edge 浏览器打开同一会话则正常。
- **根因**：DeepSeek 前端渲染预览时，桌面浏览器走 blob 分支
  `iframe.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))`，
  只有 Android / 不支持 `createObjectURL` 的环境才回退到 `iframe.srcdoc`；
  而 Obsidian 的 Electron `<webview>` 中**子框架导航到 `blob:` URL 会静默失败**——
  不触发 `load` 事件、`contentDocument` 停留在 `about:blank`，预览区因此空白。
  同一进程内普通窗口的 iframe 却正常，`srcdoc` 在 webview 中同样正常。
  （已实测：默认会话/`persist:vault-*` 分区/`webpreferences="sandbox=no"` 三种配置下 blob 子框架一律失败，故与分区和 sandbox 无关。）
- **修复**：局部改写 `URL.createObjectURL`（缓存 text/html blob 文本）与
  `HTMLIFrameElement.prototype.src`（命中缓存则改写为 `srcdoc`，失败时恢复原生访问器回退）。
  只拦截 `text/html` 类型的 blob，图片、下载等其他 blob 行为不变。
- **注意**：该脚本依赖 `dom-ready` 后注入，注入前若已开始生成预览需刷新一次页面。

---

## 6. 截图批注（ScreenshotModule）

继承 `BaseCropModeModule`。工具条按钮 `image-plus`（class `pdfreader-screenshot-button`），命令 `screenshot-annotate`。

**流程**：框选区域 → 屏幕坐标转 PDF 坐标（`pageView.getPagePoint` + `pdfjsLib.Util.normalizeRect`）→ 写入嵌入链接 `![[file.pdf#page=N&rect=x1,y1,x2,y2]]`（不产生图片文件）→ 触发 `ScreenshotHighlightModule.refresh` 在 PDF 上渲染黄色边框持久高亮（内部不填充）。

**自定义 EmbedCreator（CropEmbed）**：注册到 `app.embedRegistry`，当嵌入链接含 `rect`+`page` 时用 pdfjs 实时渲染裁剪区域为 PNG；无 rect 回退原始创建器。卸载时仅当注册表仍为本插件包装器才恢复，避免覆盖其他插件。

**PdfDocCache**：插件级 LRU + TTL（60s）缓存，同一 PDF 的多个裁剪嵌入共享 `PDFDocumentProxy`，并发请求共享加载 Promise；卸载时 `clear()` 销毁全部。

---

## 7. 截图 OCR 批注（OcrModule + OcrService）

继承 `BaseCropModeModule`。工具条按钮 `crop`（class `ocr-toolbar-button`），命令 `ocr-screenshot-annotate`。

**流程**：框选 → 截取 pdfjs 已渲染 canvas（裁剪可能抛错时降级整页 2x 渲染）→ 小区域等比放大（短边接近 512px，上限 4x）→ LM Studio 识别 → `pdfModule.annotateOcrText` 写入笔记（带归一化矩形 `&ocr=`）→ 触发 `OcrHighlightModule.refresh` 即时高亮。

**坐标**：归一化矩形（0-1，相对页面内边距框），在任意 await 前同步计算避免缩放偏移；换算到内边距框坐标系（`clientLeft/clientTop/clientWidth/clientHeight`）。

### OcrService（LM Studio OpenAI 兼容接口）
- 用 Obsidian `requestUrl`（主进程请求，无 CORS），自动注入 `Authorization: Bearer {apiKey}`
- `listModels()`：`GET /v1/models`
- `resolveModel(configured)`：配置优先；否则按优先级 `paddleocr-vl-1.6` > `qwen3-vl` > `paddleocr-vl-1.5`，再正则匹配 `ocr|vision|vl|qwen|llava|gemini`，最后取首个
- `ocrText()`：`POST /v1/chat/completions`，`image_url`(base64 dataURL) + `text`，`temperature:0`、`max_tokens`；PaddleOCR 模型 image 在前，否则 text 在前
- 仅 4xx 错误重试一次（交换 image/text 顺序）；超时/5xx 不重试
- 超时控制：`Promise.race` + `setTimeout`；`requestUrl` 不支持中止，超时后跟踪「僵尸请求」并附 no-op catch 防 unhandled rejection
- `sanitizeOcrText()`：清洗 HTML 标签、位置令牌、LaTeX 包装修饰、markdown 装饰、表格 `|`、HTML 实体、多余空白

---

## 8. 持久高亮（PdfHighlightModule / OcrHighlightModule / ScreenshotHighlightModule）

三者继承 `BasePdfHighlightModule`，共享同一套骨架：事件挂载、索引防抖重建（300ms）、视图渲染调度、笔记内容读取（优先编辑器缓冲，其次磁盘）。

**核心理念**：高亮由**笔记内容**驱动，而非内存状态。批注写入笔记时链接附带定位参数，模块扫描指向该 PDF 的笔记建立索引并渲染。

| 模块 | 监听渲染事件 | 扫描链接 | 渲染元素 |
|------|-------------|----------|----------|
| PdfHighlightModule | `textlayerrendered` | `#page=N&selection=bi,bo,ei,eo` | `.pdf-reader-highlight-layer` > `.pdf-reader-selection-highlight` |
| OcrHighlightModule | `pagerendered` | `#page=N&ocr=x,y,w,h` | `.ocr-highlight-layer` > `.ocr-crop-highlight`（`pointer-events:none`，不可点击） |
| ScreenshotHighlightModule | `pagerendered` | `#page=N&rect=x1,y1,x2,y2` | `.pdf-screenshot-highlight-layer` > `.pdf-screenshot-crop-highlight`（黄色边框、内部不填充） |

**索引来源**：`metadataCache` 不记录指向 PDF 的正文链接，故通过 `resolvedLinks` 反查链接到该 PDF 的笔记 → 读取笔记原文 → 正则提取链接参数。
- 优先读打开中编辑器缓冲（批注写入后可能未落盘）
- `metadataCache.changed` 仅重建受影响 PDF（过滤 `.pdf` 链接）；`deleted`/`rename` 触发全量重建
- 翻页/缩放重发渲染事件 → 自动重建高亮
- **删除同步**：笔记中删掉批注 → 300ms 防抖重建 → 高亮消失
- **即时高亮（显式覆盖层）**：批注写入后调用 `refresh(file, explicit)`，把显式选区/矩形记入 `explicitOverlay`（pdfPath → page → key），每次串行重建索引时并入并清理已被笔记内容确认的条目——即使 `resolvedLinks` 尚未收录新链接（首次批注到新笔记）或 metadataCache 落盘延迟，并发的 300ms 防抖重建也不会用「缺新条目」的索引覆盖掉刚批注的高亮；`deleted`/`rename` 全量重建时清空覆盖层
- **重建串行化**：同一 PDF 的重建按启动顺序执行（`rebuildIndexSerialized`），避免并发重建交错导致旧索引覆盖新索引
- **扫描失败保留旧索引**：`rebuildIndex` 中任何一篇笔记读取失败会置 `readFailed` 标志，此时**不覆盖** `indexCache` 里的旧索引（保留上次成功扫描结果 + console.warn，待下次重建修正），避免一次失败扫描把完整索引换成残缺索引导致高亮整篇消失
- **非破坏性渲染**：文本层未就绪（页面重渲染间隙）、选区计算不出矩形、或**索引尚未建成**（PDF 刚打开、重建仍在 300ms 防抖或笔记扫描中）时保留旧高亮层，只有真正产出矩形或权威索引为空时才替换/删除。瞬态空与权威空以 `indexCache` 中是否存在该 PDF 条目区分（`renderPageHighlights` 开头 `if (!index) return`；OCR/截图模块同款守卫）——改前该守卫缺失，pdf-search 等插件打开/跳转 PDF 时提前触发的 `textlayerrendered`/`pagerendered` 会按「空索引」删掉已显示的高亮，重建完成后若无后续渲染事件则高亮在本会话不再恢复（已修复）
- **挂载兜底**：PDF 叶子事件总线未就绪（视图异步加载中）时轮询重试挂载（最多 4s），避免错过页面首次 `textlayerrendered` 导致高亮在该叶子永不渲染
- PdfHighlight 矩形计算优先用文本项逐字符包围盒（`item.chars.r`），缺失回退 DOM Range；同行相邻项合并；零宽零高 span 跳过避免除零

---

## 9. 公共基类与工具

### BaseCropModeModule（截图模式基类）
- 工具条按钮注入（事件 + 轮询兜底，幂等；插到 `pageNumberEl` 之后）
- 进入/退出截图模式：crosshair 光标、不遮挡视图、框挂页面内随滚动移动
- 跨插件互斥：`window.__pdfCropExit`，避免两种模式同时激活导致一次拖拽触发两次
- 框选坐标锚定页面内边距框（减 `clientLeft/clientTop`），避免边框导致偏移
- 最小框选尺寸 8px，过小视为误触
- 子类实现 `onCropComplete(leaf, pageEl, pageRect)`：Screenshot 写链接、Ocr 截图识别

### BasePdfHighlightModule（高亮基类）
- 事件挂载（`layout-change`/`active-leaf-change` → attachToPdfLeaves）、索引防抖重建、渲染调度
- `renderEventName` / `rebuildIndex` / `renderPageHighlights` 由子类实现
- `readNoteContent`：优先编辑器缓冲，其次磁盘
- 陈旧叶子清理（`pruneStaleLeaves`）避免长期会话累积泄漏

### SharedPoller（toolbarPoller）
- 插件级共享 2s `setInterval`，截图/OCR/附带原文/快速标签等模块共用，任务全移除时自动停止
- `pruneStaleLeaves`：清理已关闭叶子在 Map/Set 中的陈旧缓存

---

## 10. 快速标签与标签同步（QuickTagModule / TagSyncModule）

标签以**结构化列表**存在插件设置 `quickTags` 中，每条是 `{ id, name, description }`：

```ts
{ id: "959a35a2-…", name: "符合", description: "与我的课题高度相关，需要关注" }
```

`id` 用 `newTagId()` 在创建时生成，此后**永不改变**；改名只改 `name`。

> **为什么稳定 id 是关键**：改名时程序知道「是这个标签改名了」，因为那是用户在设置面板上对某一行操作的**记录**，而不是对比新旧文本**推断**出来的。因此没有歧义、不需要描述指纹/行号配对/人工确认，`diffTagEntries` 那套启发式已整个删除。

### 10.1 存储与迁移（tagVocabulary.ts）

纯逻辑层，**不依赖 Obsidian API**，可单独打包测试。词表操作：

| 函数 | 作用 |
|------|------|
| `newTagId()` | 生成 id；优先 `crypto.randomUUID()`，不可用时回退时间戳+随机串 |
| `renameTag(tags, pending, id, name)` | 改名并登记待同步项；**同一标签连续改名折叠为一条**（保留最初 from、更新 to）；改回原名则撤销待办 |
| `removeTag(tags, pending, id)` | 删除标签，同时清掉它尚未同步的改名待办 |
| `moveTag(tags, id, delta)` | 上下移动，越界原样返回 |
| `findDuplicateName(tags, name, excludeId)` | 重名检测（忽略大小写与首尾空白） |

`parseTagText` / `formatTagText` 只用于**迁移与导出**（解析「标签名：描述」文本），不再是持久化格式。容错：行首 `#`、Markdown 列表符/引用符、全角 `：` 与半角 `:`；跳过空行、`%%` 注释、代码围栏、`---`；同名去重。

**一次性迁移**（`QuickTagModule.migrateTags()`，仅当 `quickTags` 为空时执行）：
1. 优先解析上一版设置里的文本框 `quickTagText`
2. 其次读更早的凡例文件 `凡例“#”.md`（常量 `LEGACY_VOCABULARY_FILE`）

迁移后为每条生成 id 并固定下来；凡例文件保持只读，不删不改。读盘前后都复查一次 `quickTags` 是否已被填充，避免覆盖用户在设置面板里刚做的编辑。

### 10.2 快速添加标签（QuickTagModule）

**目标定位** `resolveInsertTarget`，按优先级：

| 优先级 | 场景 | 行为 |
|--------|------|------|
| 1 | 焦点就在笔记里（按快捷键） | 直接用当前 `MarkdownView.editor` 的光标 |
| 2 | 焦点在 PDF 上（点工具条按钮） | 插到 **`lastNotePath`（最近获得焦点的笔记）** 的光标处 |
| 3 | 没有最近编辑的笔记 | **硬失败**并提示「请先把光标放到要添加标签的笔记里」 |

> **为什么必须有 `lastNotePath`**：点 PDF 工具条按钮时焦点**已经转到 PDF 上**，此刻 `getActiveViewOfType(MarkdownView)` 返回 `null`，拿不到任何编辑器。但用户的真实诉求是「标签接在我刚写完的那一行后面」—— 所以要在 `active-leaf-change` 时把最近获得焦点的笔记记下来（只在活动视图确实可编辑时更新，因此切到 PDF 不会把它冲掉）。编辑器失焦后仍保留光标，于是 `getEditorPosByPath(lastNotePath)` 读到的正是「我刚才写到哪儿了」。
>
> 早期实现把落点绑成「该 PDF 自己的阅读笔记」，这是**过度设计**：用户同时开着 A 笔记、点 B 的 PDF 标签按钮时会被要求先去打开 B 的笔记，而他要的其实是插到当前光标所在的 A 笔记。标签落点应当跟随**光标**，不是跟随 PDF 的归属关系。

**插入规则** `insertTag(pos, tag)`：在光标处插入 `#标签`，保证前后有空白以便识别 —— 前一字符是 `#` 时只补标签名（避免 `##` 变标题）；前一字符非空白且非行首时先补空格（`…定位]]#栽培` 不会被识别）；末尾留一个空格，光标停在其后。单次 `replaceRange`，`Ctrl+Z` 可一次撤销。位置在弹窗打开前捕获，插入前夹取到行内避免越界。

**入口**：PDF 工具条「标签」按钮（`setIcon(btn,'tags')`，插在 `pageNumberEl` 之后，可用 `quickTagToolbarButton` 关闭）＋ Markdown 编辑器顶部工具栏「标签」按钮（同样使用 `tags` 图标并复用 `openTagPicker()`）＋ 命令 `quick-add-tag`（在 设置 → 快捷键 中自行绑定）。

### 10.3 设置面板的标签编辑器

设置 → 文献阅读助手 → 标签管理，每行一个标签：`#` + 名称输入框 + 描述输入框 + `↑` `↓` `✕`，下方是「＋ 添加标签」。

- **名称输入**：每次 `input` 调 `renameTag()` 登记待同步项，并只重绘待同步区（**不重绘行本身**，否则会丢焦点）
- **名称失焦**：校验空名与重名，非法则 `revertTagName()` 回退到旧名（优先用待办里的 `from`）并提示
- **描述输入**：只更新 `description`，不产生任何笔记改写（描述从不写入笔记）
- **`✕`**：先从词表移除（非破坏性，含清掉其待办），再调 `tagSync.offerNoteCleanup(name)` —— 只有笔记里仍有引用时才弹删除确认

> `renameTag` 返回的是**新数组**，所以行内的 `input` 回调一律按 `id` 重新查找标签对象，不能持有旧的 `tag` 引用。

### 10.4 改名同步

`pendingTagRenames` 里的每条待办都精确对应一次改名，因此**不需要勾选与配对确认**。设置面板的待同步区提供：

- **同步到笔记** → `applyPendingRenames()`：`planEdits()` 扫描全库算出逐行预览 → 确认框（影响 ≥ `TYPING_CONFIRM_THRESHOLD`(10) 处时要求手打旧标签名）→ `execute()` 写入。**全部成功才清空待办**；有失败则保留待办并列出失败笔记，可重试

> **预览必须是行内差异**：`splitLineChange(before, after)` 求出公共前缀/后缀，确认框只把中间那段真正变化的标签标红加删除线、新名标绿，其余文字（批注链接、你写的内容）保持普通样式。早期版本给**整行**加删除线，看起来像是整条批注要被重写 —— 实际写入一直只动标签，但预览的呈现方式在误导用户。改名时公共前缀会吃掉标签的 `#`，需要把 `#` 还给两侧，才能显示成「#方向 → #forward」而不是「#方向 → forward」。
- **撤销改名** → `revertPendingRenames()`：把词表里的 `name` 改回 `from` 并清空待办，等价于「我改错了」

两者都能让词表与笔记重新一致。**没有提供「保留新名但不动旧笔记」**，因为那会让同一个标签在库里有两种写法。

### 10.5 安全删除标签

删除比改名危险，因此做成独立的多重护栏流程，**永不自动触发**：

1. **候选来自实际扫描**：`scanVaultTags()` 遍历全库正文标签并按出现次数排序。标签既已从词表删掉就不在词表里了，只列词表根本选不中它
2. **逐行预览**：`planEdits()` 给出每个文件的命中行 `before → after`
3. **二次确认**：影响 ≥ 10 处时要求手动输入标签名
4. **精确删除**：只删标签加一个相邻空白；匹配延伸到行尾时整段删除（不留行尾空格）；整行只有该标签时留下空行而**不删行**

### 10.6 改写引擎（无撤销）

- **边界保护**（`replaceTagInText` / `removeTagFromText` / `collectTagsFromText` 共用）：跳过 ``` / ~~~ 围栏代码块与反引号行内代码；标签前必须是行首或空白（`[[文件#标签]]` 这类标题引用**不会**被误伤）；标签后不能紧跟标签字符（`#方向性` 不会被当成 `#方向`）；不碰 frontmatter；排除配置目录
- **写入**：未打开的文件走 `vault.process()`（原子读改写，避免覆盖并发修改）；已打开的文件走编辑器 `setValue`，避免与未保存缓冲打架
- **不提供撤销**：旧版的「备份 + 一键还原」会把整篇笔记覆盖回同步前的全文，**连带抹掉同步之后新写的内容**，风险高于收益，已整体移除（连同备份文件）。因此 `execute()` 必须如实返回成功/失败清单，由调用方提示用户
- **失败处理**：任一文件写入失败即保留待办、列出失败路径；用户修正后可直接重试。若磁盘上残留旧版备份文件 `tag-sync-backup.json`（含笔记全文），已在 `.gitignore` 中排除，可手动删除

### 10.7 命令

| 命令 ID | 说明 |
|---------|------|
| `quick-add-tag` | 打开标签选择器，插入到笔记光标处 |
| `sync-tag-changes` | 有待同步改名时可用，打开设置页 |
| `delete-tag-from-notes` | 打开删除候选选择器 |

---

## 11. 命令与事件

### 命令
| 命令 ID | 名称 | 来源 |
|---------|------|------|
| `toggle-deepseek-float` | 切换 DeepSeek 浮动窗口 | DeepSeekModule |
| `open-deepseek-tab` | 在标签页打开 DeepSeek | DeepSeekModule |
| `deepseek-add-current-file` | 将当前阅读文件上传到 DeepSeek 聊天框 | DeepSeekModule |
| `screenshot-annotate` | 截图批注到笔记 | ScreenshotModule |
| `ocr-screenshot-annotate` | 截图 OCR 批注到笔记 | OcrModule |
| `quick-add-tag` | 快速添加标签（在笔记光标处插入凡例标签） | QuickTagModule |
| `sync-tag-changes` | 同步标签改名到笔记（有待同步变更时可用，打开设置页） | TagSyncModule |
| `delete-tag-from-notes` | 删除标签（从所有笔记中移除某个标签） | TagSyncModule |

### 事件 / 菜单
| 事件 | 触发时机 | 处理 |
|------|----------|------|
| `file-menu`（workspace） | 右键文件 | 追加「开始阅读」菜单项（PdfReaderModule）：PDF → 按模板建/复用笔记并并排打开；Markdown → 是阅读笔记就打开其文献，是待读文献就左 md / 右按模板建「{name} 阅读」；文件夹不加 |
| `mouseup`（document） | 鼠标松开 | PDF 文字选区检测，显示浮动批注按钮；Ctrl/Command 多选追加（切换 PDF 自动清空缓存） |
| `mousedown`（document） | 鼠标按下 | 点击浮动按钮外部隐藏 |
| `layout-change`/`active-leaf-change` | 布局/活动叶变化 | 各模块注入工具条按钮、高亮模块挂载叶子 |
| `metadataCache.changed` | 笔记修改 | 高亮模块防抖重建受影响 PDF 索引 |
| `metadataCache.deleted`/`vault.rename` | 笔记删除/重命名 | 高亮模块全量重建 |
| `textlayerrendered`/`pagerendered` | 页面渲染 | 高亮模块渲染单页高亮 |

---

## 12. 依赖关系

| 依赖 | 类型 | 说明 |
|------|------|------|
| `obsidian` | Obsidian API | `Plugin`/`TFile`/`Menu`/`WorkspaceLeaf`/`FileView`/`MarkdownView`/`requestUrl` 等 |
| `pdfjs-dist` | npm 包 | 拆为插件目录下独立的 `pdfjs-fallback.mjs` + `pdf.worker.min.mjs`（esbuild 产出），仅 Obsidian 未暴露 `window.pdfjsLib` 时经 `<script type="module">` 按需加载一次（footer 暴露 `window.__pdfReaderFallbackLib`）；自定义 `CMapReaderFactory` |
| Obsidian 自带 `pdfjsLib` | 运行时 | 文本提取优先使用（与视图字体/CMap 一致）；截图坐标转换用 `window.pdfjsLib` |
| CMap 文件 | 本地资源 | `cmaps/*.bcmap`，中文 PDF 字符映射；路径按 `manifest.dir`（1.7+）解析，目录改名仍可用 |
| Electron `webview` | 运行时 | DeepSeek 浮动窗口（桌面端专有） |
| LM Studio | 外部服务 | OCR 视觉模型，OpenAI 兼容接口；需用户本地启动并加载视觉模型 |

**环境要求**：`minAppVersion: 1.7.0`，仅桌面端；需 Node.js `fs` 读取 CMap；DeepSeek 窗口需联网；OCR 需 LM Studio 服务可达。

---

## 13. 使用示例场景

### 场景 1：开始阅读 PDF
```
右键 PDF → 「开始阅读」
  → 创建 ReadingNotes/{文件名} 阅读.md（含自动提取的关键词标签）
  → 左侧打开 PDF，右侧打开笔记
```

### 场景 1b：开始阅读 Markdown 文献
```
右键待读的 md → 「开始阅读」
  → 左：这篇 md 本身（并标记为「正在阅读的文献」）
  → 右：新建/复用 ReadingNotes/{md 名} 阅读.md（frontmatter 写 source）
选中左侧文字 → 浮动按钮「批注到笔记」→ 写入右侧那篇笔记
```

### 场景 1c：开始阅读已是阅读笔记的 md
```
右键 ReadingNotes 里的笔记（或名为「… 阅读」的 md）→ 「开始阅读」
  → 读 frontmatter 的 pdf / source 字段（旧笔记按命名模板反查）
  → 左侧打开其文献，右侧就是被右键的这篇笔记（不新建笔记）
找不到对应文献时只提示，不开标签页、不建笔记
```

### 场景 2：选中文字批注
```
PDF 中选中文字 → 浮动按钮「批注到笔记」出现
  → 点击 → 选中文字 + 页码链接以 callout 追加到笔记，光标定位到「笔记：」行尾
  → PDF 上对应文字持久高亮
```

### 场景 3：Ctrl 多选批量批注
```
按住 Ctrl 依次选择多段 → 浮动按钮显示段数角标
  → 点击 → 所有段落合并为一个 callout 块（段间空行 + 独立页码引用）追加到笔记
```

### 场景 4：截图批注（保留原图区域）
```
工具条「截图批注」(image-plus) → 框选区域
  → 笔记插入 ![[file.pdf#page=N&rect=...]]，自定义 EmbedCreator 实时渲染裁剪图
```

### 场景 5：截图 OCR 批注（扫描版 PDF）
```
工具条「截图 OCR 批注」(crop) → 框选区域
  → LM Studio 识别文字 → 识别文本 + 区域链接写入笔记
  → PDF 上对应区域持久高亮（不可点击）
```

### 场景 6：多篇 PDF 汇集到同一篇笔记
```
打开目标笔记（保持可编辑）→ 在任意 PDF 中选中文字批注
  → 批注一律写入「光标所在的那篇笔记」，callout 链接仍指向被批注的源 PDF，点击可跳回
  → 想汇集多篇 PDF 时，只要始终把同一篇笔记作为落点即可（无需任何开关）
```
反例：没打开任何笔记时批注会**硬失败**并提示，不会自动建笔记，也不会静默写到别处。

### 场景 7：DeepSeek 窗口/标签页 + 上传文件
```
Ribbon 机器人图标（按设置的默认方式）→ DeepSeek 浮动窗口或标签页
  → 浮动窗口标题栏/标签页右上角「加载文件」→ 当前 PDF/笔记自动上传到聊天框（上限 100MB）
```

---

## 14. 常见问题与限制

- **CMap 依赖**：中文 PDF 文本提取依赖 `cmaps/`，不可删除；目录改名后按 `manifest.dir` 重新解析仍可用
- **文本提取范围**：仅提取 PDF 文本层，扫描版 PDF 无法提取关键词；逐页并行，单页失败跳过
- **关键词提取**：依赖论文格式（「关键词：」行），非标准格式无法提取标签
- **笔记覆盖**：`createReadingNote` 仅在笔记不存在/需去重时写初始内容，已存在笔记不更新 frontmatter（除 pdf 字段失效修复）
- **批注定位**：跨页选区、文本层未渲染会回退为纯文字；无 `data-idx` 的文本（标题/图表标注）会回退为“页码链接 + 归一化矩形（`&ocr=`）”，由 OCR 高亮通道渲染持久矩形高亮；矩形计算失败时仅页码链接（`beginIndex=-1`）
- **PUA 字符**：无 ToUnicode 映射的字形会输出 Unicode 私有区字符（U+E000–U+F8FF，渲染为 □/⏎），批注文本清洗时移除
- **持久高亮**：依赖 `resolvedLinks` 反查 + 笔记原文正则；OCR/回退矩形高亮可点击跳转，仅笔记链接可跳转 PDF
- **删除同步**：笔记中删掉批注 callout → 300ms 防抖重建索引 → 高亮消失
- **OCR 服务**：需 LM Studio 启动并加载视觉模型；开启 Require Authentication 须填 API Key；`requestUrl` 不支持中止，超时后底层请求仍会跑完（跟踪为僵尸请求）
- **截图嵌入**：依赖未公开 `app.embedRegistry`，结构变化时降级跳过（链接仍写入，仅实时渲染不可用）
- **非桌面端不可用**：依赖 `fs.readFileSync` 与 Electron `webview`
- **上传大小**：上传文件上限 100MB，超出拒绝
- **上传入口依赖页面结构**：依赖 DeepSeek 页面 `<input type="file">` 或输入区拖拽，页面未加载/改版可能失败，需手动上传
- **批注落点**：跟随光标（最近获得焦点的笔记）。若焦点在 PDF 上则会话中最后一次编辑的笔记即落点；**没打开笔记时无法批注 / 加标签**（明确提示，不自动建笔记、不静默改写）
- **表格单元格就地编辑**：Live Preview 点击表格单元格时 Obsidian 会在 `td > .table-cell-wrapper` 里临时创建嵌套的 `TableCellEditor`（一套独立 CM6 编辑器），由于 `registerEditorExtension` 是全局注册，`showPanel` 面板会被一起塞进单元格、撑破笔记表格。`MarkdownReadingModule.isNestedEditorView()` 对这类嵌套编辑器不生成工具栏，`hideNestedPanelWrapper()` 连 `.cm-panels` 外壳一并隐藏（避免残留背景/下边框），`styles.css` 另有 `.table-cell-wrapper .cm-panels:has(> .pdfreader-md-toolbar)` 兜底 —— 用 `:has()` 收窄到自己的面板，不会隐藏别的插件注入到单元格里的面板

---

## 15. Markdown 批注（MarkdownReadingModule）

`MarkdownReadingModule` 把「批注到笔记」扩展到 Markdown 来源笔记，且遵守「会话级来源标记 + 光标目标」两个规则。

### 15.1 工具栏与来源标记

- 通过 `plugin.registerEditorExtension(showPanel.of(...))` 在编辑器中注入顶部工具栏；
- 只在「笔记编辑器」中注入：Obsidian 的 Live Preview 表格单元格就地编辑会创建嵌套 CM6 编辑器（`td > .table-cell-wrapper`），该编辑器由 `isNestedEditorView()` 识别后不生成工具栏按钮，并隐藏 CM6 生成的 `.cm-panels` 外壳；
- 工具栏按钮：`正在阅读`、`附带原文`、`标签`、目标提示 `目标：xxx.md`；按钮均为纯图标，复用 Obsidian `.clickable-icon`，与 PDF 工具条同尺寸/同悬停反馈，相同功能使用相同图标（附带原文 `link`、标签 `tags`），通过 tooltip 显示名称/状态；
- `正在阅读` 标记保存在模块内存 `sourcePath`，**不写 data.json、不写 frontmatter**；Obsidian 关闭/插件重载后自动清空；

### 15.2 浮动批注按钮

- 只在已标记的来源笔记中、选中文字后出现；
- 位置由 `window.getSelection()` 的 Range 计算，贴在选择文字最后一行的右上方；
- 点击一次只处理当前选区；来源笔记选中的文字自动包 `==`，已带 `==` 时不重复包裹；
- 目标笔记未打开/无编辑器时硬失败并提示。

### 15.3 写入格式

| 附带原文 | 写入目标笔记 |
|---|---|
| 开 | `> [!pdf-annotation]` 蓝框，包含原文、`[[来源#标题\|定位]]`、`笔记：`，焦点进目标笔记、光标停在「笔记：」行尾 |
| 关 | 只写 `[[来源#标题\|定位]]`，焦点进目标笔记、光标停在链接后 |

- 来源链接优先指向最近的 Markdown 标题，没有标题则指向整个文件；
- 目标笔记原文不再加 `==`；`==` 只出现在来源笔记。

### 15.4 目标落点改造

`PdfReaderModule` 原有的 `lastNotePath` 只记录最近一篇笔记；Markdown 来源笔记被标记后会抢占该位置。为此新增：

- `setAnnotationTargetExclusionProvider()`：被标记的来源笔记不参与目标跟踪；
- `recentNoteTargets` MRU 列表：当主落点被来源过滤或已失效时，回退到最近一篇未标记且有编辑器的笔记；
- `getCursorNotePos()` 仍保持原有 API，供批注/截图/OCR/标签复用。

### 15.5 删除「定位」链接时同步撤销来源高亮

来源链接本身只指向来源文件的标题，无法从链接文本直接定位到具体 `==...==`。因此：

- 创建 Markdown 批注时在 `PluginSettings.markdownAnnotationRecords` 中登记配对记录：目标链接文本、目标侧前后文上下文、来源高亮内部文字与偏移；
- `MarkdownAnnotationSync` 监听 `metadataCache.changed`，目标笔记中匹配不到记录链接时，视为链接已删除；
- 删除来源 `==` 包裹时只移除标记、保留正文文字；若来源笔记正在编辑器中打开，优先走编辑器缓冲，保证撤销可回到编辑器历史；
- 多个相同链接用目标上下文区分；目标上下文更新、笔记/来源重命名、目标文件删除均会维护配对记录。

### 15.6 点击「定位」链接：精确点亮批注，而不是闪整节

**问题**：链接带 `#标题` 子路径时，Obsidian 原生的「定位闪烁」按**整节**高亮，点一次「定位」会把来源文献（或章节笔记）的一整节都点亮：

- Live Preview：`MarkdownEditView.setEphemeralState` → `setHighlight`，区间取 `resolveSubpath` 的
  `start = 标题起点`、`end = 下一个标题起点`，即**从标题到下一个标题**，再调 `editor.addHighlights(…, 'is-flashing')`；
- 阅读模式：`MarkdownPreviewView.setEphemeralState` → `applyScrollDelayed(line, {highlight:true})`
  → `highlightEl(…|| section.el)` 给整个 `.markdown-preview-section` 加 `is-flashing`（3s 黄底）。

**做法**（`MarkdownReadingModule.handleAnnotationLinkClick`，document 捕获阶段）：

1. **判据只有一条：存在配对记录。** 只有「目标笔记 + 来源笔记（路径 + 子路径）」能在 `markdownAnnotationRecords` 里找到记录时才接管；Mod/中键、普通笔记链接、PDF 目标（交 `PdfJumpModule`）一律放行，保持 Obsidian 默认行为。因此用户自己手写的 `[[某笔记|定位]]`（显示文字恰好等于批注链接别名）不再被误接管；**没有配对记录的旧链接也不再接管**，回到 Obsidian 原生行为（按标题闪整节）；反过来，删掉某条配对记录就等于放弃对该链接的接管（记录存放在 data.json 的 `markdownAnnotationRecords` 里，没有界面入口，需要手工编辑；注意记录同时承担「删链接 → 撤销来源 `==`」的配对，清空会一并失去那个行为）。
2. `preventDefault + stopPropagation + stopImmediatePropagation` 完全接管点击（Obsidian 自带处理器检查 `defaultPrevented`，编辑器侧 `onEditorClick` 走了就不会再排 100ms 的 `openLinkText`）；
3. 用 `linkLocator` 把点击的锚点还原成**原文里的第几条 wikilink**（阅读模式用渲染顺序序号、Live Preview 用点击字符偏移），再用 `MarkdownAnnotationSync.resolveRecordForLink()` 按该序号 + 已登记上下文取出配对记录。**Live Preview 取链接原文用 `editor.getLine(pos.line)` + `findLinkAtColumn()` 直接读行文本**：光标在链接内部时链接会展开成原始 `[[…]]`，此时编辑器 token（`getClickableTokenAt`）可能丢掉别名甚至不是 `internal-link`，只靠 token 会把「定位」链接漏给 Obsidian 默认行为（表现为「在笔记当前窗口里跳转」）；token 只在行文本里没有完整 `[[…]]` 时作为兜底；
4. 用 `locateHighlightRange()` 在来源原文中定位记录对应的 `==…==`（含两侧 `==`）与其在全文高亮中的序号；
5. 导航（`openLiteratureLeaf()`，尽量不改变现有分屏）：来源笔记已打开 → `findLeafByPath` **复用那个标签**（不新建、不替换当前标签页）；未打开 → ① 同窗口主区域里已有的**空标签**（例如给文献预留的空栏）直接用来承载文献，不新增标签；② 笔记所在栏的**相邻栏**（同级分屏里离笔记最近、优先左侧那一栏，顺序取自分屏 `children`）用 `createLeafInParent(该栏的标签组, -1)` 在那一栏**新开一个标签**（与 pdf-plus 的 `createLeafInParent(leaf.parentSplit, -1)` 同一用法；公开类型写作 `WorkspaceSplit`，传入标签组即为该栏新增标签），落点不在同一栏时 `detach()` 退回；③ 笔记独占一栏时才 `createLeafBySplit(…, 'vertical', true)` 新开一栏（连笔记叶子都定位不到则 `getLeaf('tab')`）。随后 `setActiveLeaf(…, { focus: true })` 并 `openFile`（不带 `#标题`，因此不触发原生整节闪烁）；左右**侧边栏不算「一栏」**（`isSidebarLeaf()` 沿 parent 链识别 `WorkspaceSidedock`），不会被用来承载文献。**目的**：左右分屏（左文献 / 右笔记）时点「定位」不会再多分出第 3 栏，也不会占用笔记所在的标签；
6. `scrollSourceToHighlight(leaf, …)`：只操作**这个叶子**，轮询等待它就绪（最长 8 秒，与 `scrollToPdfAnchor` 同款；`flashRunId` 代次用于中止过期等待）—— 编辑模式用 `editor.scrollIntoView({from,to}, true)` + `editor.addHighlights(…, 'pdfreader-md-note-flash-mark')` 精确滚动并高亮该区间，阅读模式给渲染出的第 N 个 `<mark>` 加同一 class 并滚动（文本对不上时按内容核对，再不行才退回按序号）；定位不到高亮（已被删除/解析不一致）时退回闪标题。

> **闪烁 class 必须与 PdfJumpModule 不同名**（`pdfreader-md-note-flash-mark` vs `pdf-reader-note-flash-mark`）：Obsidian 原生的 `Editor.removeHighlights(className)` 是按 class 注销**整份**装饰的，两边同名时会互相打断 —— 点 PDF 高亮闪笔记 callout 的同时点了「定位」链接闪来源 `==`，先发生的那次闪烁会被后发生的清理抹掉。两者的视觉共用 styles.css 里的同一套 keyframes。

**为什么不用 `workspace.openLinkText()`**：它按 Obsidian 默认在**当前焦点窗格**打开，会把正在读的目标笔记替换掉，而旁边真正开着的文献窗格不会滚动。PDF 方向一直用「复用叶子 / 未打开则在左侧分屏 / 只滚动那一格」的协议，现在两个方向完全一致。

对照：**PDF 目标的「定位」链接没有这个问题**——Obsidian 的 PDF 视图对 `#page=N&selection=…` 用的就是逐字符选区高亮，`PdfJumpModule` 另加的持久高亮层也只覆盖该选区。

