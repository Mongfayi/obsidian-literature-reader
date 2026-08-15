# 文献阅读助手插件技术手册

> 面向 AI 查阅的简洁参考。插件 ID: `pdf-reader`，插件名「文献阅读助手」，版本 `2.4.0`，`minAppVersion: 1.7.0`，仅桌面端（`isDesktopOnly: true`）。

---

## 1. 概述

由原 pdf-reader 与 deepseek-sidebar 合并而来，围绕「PDF 阅读 → 批注 → 笔记」一站式流程，集成 DeepSeek 浮动窗口与截图 OCR 批注。模块化结构：`main.ts` 仅做编排，功能下沉到 `modules/` 目录，各模块实现 `PluginModule`（`load`/`unload`）生命周期。

### 模块清单

| 模块 | 文件 | 职责 |
|------|------|------|
| PdfReaderModule | `modules/PdfReaderModule.ts` | 开始阅读、关键词提取、文字/截图/OCR 批注写入笔记、上传文件数据源 |
| DeepSeekModule | `modules/DeepSeekModule.ts` | DeepSeek 浮动窗口（webview）、拖拽/最小化、上传当前文件到聊天框 |
| ScreenshotModule | `modules/ScreenshotModule.ts` | 截图批注：框选区域 → PDF 嵌入链接（无图片文件），注册自定义 EmbedCreator 实时渲染裁剪区 |
| OcrModule | `modules/OcrModule.ts` | 截图 OCR 批注：框选 → 截取 canvas → LM Studio 视觉模型识别 → 写入笔记 |
| OcrService | `modules/OcrService.ts` | LM Studio OpenAI 兼容接口封装（模型列表、识别、文本清洗） |
| PdfHighlightModule | `modules/PdfHighlightModule.ts` | 文字选区持久高亮（笔记 `&selection=` 链接驱动） |
| OcrHighlightModule | `modules/OcrHighlightModule.ts` | OCR 区域持久高亮（笔记 `&ocr=` 链接驱动，不可交互） |
| MainArticleModule | `modules/MainArticleModule.ts` | 主文献批注汇集：开启后所有批注写入主文献笔记 |
| PdfJumpModule | `modules/PdfJumpModule.ts` | 双向跳转：点击 PDF 高亮 → 笔记对应批注；点击笔记 PDF 链接 → PDF 对应位置（目标未打开时自动分屏） |
| AnnotationModeModule | `modules/AnnotationModeModule.ts` | 批注原文附带模式（测试功能）：工具条「附带原文」开关，默认关闭=文字批注只写链接 |
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
| `deepseekUrl` | `string` | `"https://chat.deepseek.com"` | DeepSeek 浮动窗口网页地址，改后需重启插件/重开窗口 |
| `ocrServerUrl` | `string` | `"http://127.0.0.1:1234"` | LM Studio 服务器地址（OpenAI 兼容接口） |
| `ocrApiKey` | `string` | `""` | LM Studio API Key（开启 Require Authentication 时必填，密码型输入框） |
| `ocrModel` | `string` | `"paddleocr-vl-1.6"` | OCR 模型名，空 = 自动选择服务器视觉模型 |
| `ocrRequestTimeoutSec` | `number` | `120` | 单次 OCR 请求超时（秒，下限 10） |
| `ocrMaxTokens` | `number` | `8192` | 单次识别最大输出 token（下限 512） |
| `ocrPrompt` | `string` | `"OCR:"` | OCR 提示词（PaddleOCR-VL 用任务词如 `OCR:`） |

设置面板 500ms 防抖保存；关闭面板时冲刷未落盘修改。OCR 设置区含「测试连接」按钮（拉取 `/v1/models` 列出可用模型）。

---

## 3. 架构与编排（main.ts）

`LiteratureReaderPlugin` 仅负责设置加载、模块实例化与生命周期：

1. 创建 `PdfReaderModule`（其 `getCurrentFileForUpload` 注入 DeepSeek 上下文）
2. 创建 `PdfHighlightModule`，把 `highlightModule.refresh` 注入 `pdfModule.setRefreshHighlights`
3. 创建 `ScreenshotModule(ctx, pdfModule)`、`OcrModule(ctx, pdfModule)`
4. 创建 `OcrHighlightModule`，把 `ocrHighlightModule.refresh` 注入 `ocrModule.setHighlightRefresh`
5. 创建 `MainArticleModule(ctx, pdfModule)`（其内部把重定向解析器注入 `pdfModule.setRedirectResolver`）
6. 模块按顺序加载，**单个失败不拖垮其余**（try/catch 兜底）；卸载逆序
7. 注册统一设置面板 `UnifiedSettingTab`

模块通过 `ModuleContext`（`plugin` / `getSettings` / `saveSettings` / 可选 `getCurrentFileForUpload`）访问共享资源，避免直接耦合。

---

## 4. PdfReaderModule 核心 API

### 4.1 `startReading(pdfFile: TFile): Promise<void>`
右键菜单「开始阅读」入口：
1. `createReadingNote(pdfFile)` 创建/获取笔记
2. PDF 已打开则复用叶子，否则新 tab 打开
3. 笔记已打开则聚焦，否则在 PDF 右侧 `createLeafBySplit('vertical')` 分屏打开
4. 焦点切到笔记

### 4.2 `createReadingNote(pdfFile: TFile): Promise<TFile | null>`
**命名规则**：`{PDF文件名} 阅读.md`，存于 `readingNoteFolder`；同名 PDF 冲突时按 `{文件名} 阅读 (n).md`（n=2..99）递增去重，全部占用返回 `null`。
- 通过 frontmatter `pdf` 字段判别归属；字段缺失的旧笔记沿用「存在即复用」
- 引用的旧 PDF 路径失效且文件名一致时（PDF 被移动/改名），判定同一 PDF 复用并**自动修复 pdf 字段**
- 目标路径被同名文件/文件夹占用时返回 `null`

**生成内容**：
- frontmatter：`pdf: "[[路径]]"`、`created: 日期`、`tags:`（关键词列表，提取失败则省略）
- 正文：三个引导问题（实验思路 / 获得的信息 / 发现的问题）
- 文本提取优先用 Obsidian 自带 `window.pdfjsLib`，缺失时回退内置 `pdfjs-dist` + 自定义 `CMapReaderFactory`（读取 `cmaps/` 目录）；逐页并行提取，单页失败跳过

### 4.3 批注入口（三个统一走 `resolveTargetNote`）

| 方法 | 触发 | 链接形式 |
|------|------|----------|
| `handleAnnotation()` | 浮动按钮「批注到笔记」（文字选区） | `&selection=bi,bo,ei,eo` |
| `annotateScreenshot(pdfFile, page, rect)` | 截图批注模块调用 | `![[...#page=N&rect=x1,y1,x2,y2]]` |
| `annotateOcrText(pdfFile, text, page, ocrRect?)` | OCR 批注模块调用 | `&ocr=x,y,w,h`（无文本锚点） |

**`resolveTargetNote(pdfFile)`**：先查 `redirectResolver`（MainArticleModule 注入），命中→写入主文献笔记；否则回退 `ensureNoteOpen`（源 PDF 对应笔记）。批注 callout 内原文链接始终用源 `pdfFile` 构造，跳转指向源 PDF。

**批注格式**（callout 块，自定义类型 `[!pdf-annotation]`，无标题；多段选中合并为一个块，段间空行分隔并带独立页码引用）：
```markdown
> [!pdf-annotation]
> {选中文字}
> [[{PDF路径}#page={页码}&selection={beginIndex},{beginOffset},{endIndex},{endOffset}|{PDF名}, 页面 {页码}]]
>
> 笔记：
```
- 使用自定义 callout 类型 `[!pdf-annotation]`（不带标题），样式由 `styles.css` 控制：隐藏标题栏、内容区内边距清零、首尾元素 margin 清零，蓝色框紧贴批注内容
- 链接目标用 PDF 完整路径（`pdfFile.path`），避免同名歧义
- 选区定位失败（跨页/文本层未渲染）：`page=null`，仅写文字不附链接，输出 warn
- 无文本锚点（OCR / 标题等无 `data-idx` 文本）：`beginIndex=-1`，仅页码链接；OCR 附 `&ocr=x,y,w,h`
- 写入优先经 CM6 编辑器 `replaceRange`（光标位置），无编辑器（阅读模式）回退文末追加
- 写入后光标自动定位到「笔记：」行尾；写入失败选区自动恢复
- 文本清洗：移除换行/控制字符/Unicode 换行符号，以及 PDF 私有区字符（U+E000–U+F8FF，无 ToUnicode 映射的字形占位符）

**「附带原文」关闭时的链接-only 格式**（AnnotationModeModule 注入 `includeOriginalTextProvider`，默认关闭；测试功能，以后可能删除）：文字选中批注只写链接、无 callout、无「笔记：」提示行；插入锚点默认在笔记光标处，光标行/其后两行内存在链接-only 链接行时改在该链接之后插入（避免插进上一条批注的文字与链接之间）；链接上方留空行放光标（文字在上、链接在下）。OCR（`beginIndex<0`）与截图批注不受该开关影响。

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

## 5. DeepSeek 浮动窗口（DeepSeekModule）

- **打开/关闭**：Ribbon 机器人图标「打开 DeepSeek」，或命令 `toggle-deepseek-float`
- **拖拽**：按住标题栏（非按钮区）拖动，拖动期禁用 webview 指针事件；不钳制边界，可拖出 Obsidian 窗口（超出部分视口裁剪）
- **最小化**：标题栏「－」按钮
- **防丢失**：重新显示时若面板完全移出可视区域，复位到默认位置
- **加载文件**：标题栏「加载文件」按钮，或命令 `deepseek-add-current-file`

### `addCurrentFileToChat()`
1. `getCurrentFileForUpload` 取文件数据，超过 100MB 拒绝
2. ArrayBuffer → base64（32KB/块，避免栈溢出与内存峰值）
3. 分块注入 webview 页面变量（8MB/块，每次上传独立变量名防并发污染）
4. 组装上传脚本：策略 A 找 `<input type="file">` 用 DataTransfer 赋值触发 change；策略 B 兜底在输入区模拟 dragover + drop
5. 返回 `success` / `drop` / `not-found`

---

## 6. 截图批注（ScreenshotModule）

继承 `BaseCropModeModule`。工具条按钮 `image-plus`（class `pdfreader-screenshot-button`），命令 `screenshot-annotate`。

**流程**：框选区域 → 屏幕坐标转 PDF 坐标（`pageView.getPagePoint` + `pdfjsLib.Util.normalizeRect`）→ 写入嵌入链接 `![[file.pdf#page=N&rect=x1,y1,x2,y2]]`（不产生图片文件）。

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

## 8. 持久高亮（PdfHighlightModule / OcrHighlightModule）

二者继承 `BasePdfHighlightModule`，共享同一套骨架：事件挂载、索引防抖重建（300ms）、视图渲染调度、笔记内容读取（优先编辑器缓冲，其次磁盘）。

**核心理念**：高亮由**笔记内容**驱动，而非内存状态。批注写入笔记时链接附带定位参数，模块扫描指向该 PDF 的笔记建立索引并渲染。

| 模块 | 监听渲染事件 | 扫描链接 | 渲染元素 |
|------|-------------|----------|----------|
| PdfHighlightModule | `textlayerrendered` | `#page=N&selection=bi,bo,ei,eo` | `.pdf-reader-highlight-layer` > `.pdf-reader-selection-highlight` |
| OcrHighlightModule | `pagerendered` | `#page=N&ocr=x,y,w,h` | `.ocr-highlight-layer` > `.ocr-crop-highlight`（`pointer-events:none`，不可点击） |

**索引来源**：`metadataCache` 不记录指向 PDF 的正文链接，故通过 `resolvedLinks` 反查链接到该 PDF 的笔记 → 读取笔记原文 → 正则提取链接参数。
- 优先读打开中编辑器缓冲（批注写入后可能未落盘）
- `metadataCache.changed` 仅重建受影响 PDF（过滤 `.pdf` 链接）；`deleted`/`rename` 触发全量重建
- 翻页/缩放重发渲染事件 → 自动重建高亮
- **删除同步**：笔记中删掉批注 → 300ms 防抖重建 → 高亮消失
- 即时高亮：批注写入后调用 `refresh(file, explicit)`，把显式选区/矩形直接并入索引，规避落盘延迟
- PdfHighlight 矩形计算优先用文本项逐字符包围盒（`item.chars.r`），缺失回退 DOM Range；同行相邻项合并；零宽零高 span 跳过避免除零

---

## 9. 主文献批注汇集（MainArticleModule）

工具条按钮 `bookmark`（class `pdfreader-main-article-button`），命令 `toggle-main-article`「设为/取消主文献」。

- 点击按钮切换：同路径→取消；否则设为新主文献（替换原值）。反馈靠按钮高亮 + tooltip
- 开启后，所有批注入口（文字/截图/OCR）经 `resolveTargetNote` 重定向写入**主文献笔记**；callout 内原文链接仍指向被批注的源 PDF（点击跳回源页）
- 状态为**会话级（内存）**，重载插件清除
- 工具条注入范式与截图/OCR 一致：`layout-change`/`active-leaf-change` + 共享 2s 轮询兜底，经 `toolbar.pageNumberEl.after(btn)` 插入

---

## 10. 公共基类与工具

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
- 插件级共享 2s `setInterval`，截图/OCR/主文献三模块共用，任务全移除时自动停止
- `pruneStaleLeaves`：清理已关闭叶子在 Map/Set 中的陈旧缓存

---

## 11. 命令与事件

### 命令
| 命令 ID | 名称 | 来源 |
|---------|------|------|
| `toggle-deepseek-float` | 切换 DeepSeek 浮动窗口 | DeepSeekModule |
| `deepseek-add-current-file` | 将当前阅读文件上传到 DeepSeek 聊天框 | DeepSeekModule |
| `screenshot-annotate` | 截图批注到笔记 | ScreenshotModule |
| `ocr-screenshot-annotate` | 截图 OCR 批注到笔记 | OcrModule |
| `toggle-main-article` | 设为/取消主文献（批注汇集到本篇笔记） | MainArticleModule |

### 事件 / 菜单
| 事件 | 触发时机 | 处理 |
|------|----------|------|
| `file-menu`（workspace） | 右键文件 | PDF 追加「开始阅读」菜单项（PdfReaderModule） |
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
| `pdfjs-dist` | npm 包 | 内置 worker 经 `WORKER_CODE` 注入（blob URL，卸载 revoke）；自定义 `CMapReaderFactory` |
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

### 场景 6：主文献批注汇集
```
工具条「主文献」(bookmark) 设为当前 PDF
  → 此后从任意 PDF 批注都写入主文献笔记，callout 链接仍指向源 PDF 可跳回
```

### 场景 7：DeepSeek 浮动窗口 + 上传文件
```
Ribbon 机器人图标 → DeepSeek 浮动窗口
  → 标题栏「加载文件」→ 当前 PDF/笔记自动上传到聊天框（上限 100MB）
```

---

## 14. 常见问题与限制

- **CMap 依赖**：中文 PDF 文本提取依赖 `cmaps/`，不可删除；目录改名后按 `manifest.dir` 重新解析仍可用
- **文本提取范围**：仅提取 PDF 文本层，扫描版 PDF 无法提取关键词；逐页并行，单页失败跳过
- **关键词提取**：依赖论文格式（「关键词：」行），非标准格式无法提取标签
- **笔记覆盖**：`createReadingNote` 仅在笔记不存在/需去重时写初始内容，已存在笔记不更新 frontmatter（除 pdf 字段失效修复）
- **批注定位**：跨页选区、文本层未渲染、无 `data-idx` 的文本（标题/图表标注）会回退为纯文字或仅页码链接（`beginIndex=-1`），不生成 selection 锚点
- **PUA 字符**：无 ToUnicode 映射的字形会输出 Unicode 私有区字符（U+E000–U+F8FF，渲染为 □/⏎），批注文本清洗时移除
- **持久高亮**：依赖 `resolvedLinks` 反查 + 笔记原文正则；OCR 高亮矩形 `pointer-events:none` 不可点击，仅笔记链接可跳转 PDF
- **删除同步**：笔记中删掉批注 callout → 300ms 防抖重建索引 → 高亮消失
- **OCR 服务**：需 LM Studio 启动并加载视觉模型；开启 Require Authentication 须填 API Key；`requestUrl` 不支持中止，超时后底层请求仍会跑完（跟踪为僵尸请求）
- **截图嵌入**：依赖未公开 `app.embedRegistry`，结构变化时降级跳过（链接仍写入，仅实时渲染不可用）
- **非桌面端不可用**：依赖 `fs.readFileSync` 与 Electron `webview`
- **上传大小**：上传文件上限 100MB，超出拒绝
- **上传入口依赖页面结构**：依赖 DeepSeek 页面 `<input type="file">` 或输入区拖拽，页面未加载/改版可能失败，需手动上传
- **主文献状态**：会话级（内存），重载插件清除
