# 文献阅读助手插件技术手册

> 面向 AI 查阅的简洁参考。插件 ID: `pdf-reader`，插件名「文献阅读助手」，版本 `2.0.0`，仅桌面端。

---

## 1. 概述

由原 pdf-reader 与 deepseek-sidebar 合并而来，包含两大功能模块：

1. **PdfReaderModule（PDF 阅读）**：右键 PDF 一键开始阅读，自动垂直分屏（左 PDF / 右笔记），自动提取 PDF 关键词写入笔记 frontmatter 作为 Obsidian 标签。阅读时选中文字可批注到笔记（callout 格式），支持 Ctrl/Command+多选批量批注。
2. **DeepSeekModule（DeepSeek 浮动窗口）**：以可拖拽浮动窗口嵌入 DeepSeek 网页聊天（webview），支持最小化，并提供「加载文件」按钮/命令，将当前正在阅读的 PDF 或 Markdown 笔记上传到 DeepSeek 聊天框。

模块编排见 `main.ts`，两个模块均实现 `PluginModule`（`load`/`unload`）生命周期。

---

## 2. 配置项

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `readingNoteFolder` | `string` | `"ReadingNotes"` | 是 | 阅读笔记存放的文件夹路径（相对于 vault 根目录），不存在则自动创建 |
| `deepseekUrl` | `string` | `"https://chat.deepseek.com"` | 是 | 嵌入浮动窗口的 DeepSeek 网页地址，修改后需重启插件或重新打开窗口生效 |

---

## 3. 核心 API / 方法

### 3.1 `startReading(pdfFile: TFile): Promise<void>`

**签名**：
```typescript
async startReading(pdfFile: TFile): Promise<void>
```

**参数**：
- `pdfFile` — 用户右键选择的 PDF 文件对象

**返回值**：无（`void`），副作用为打开分屏布局

**行为**：
1. 调用 `createReadingNote(pdfFile)` 创建/获取笔记文件
2. PDF 已打开时复用已有叶子（不重复打开），否则在左侧 tab 打开 PDF
3. 笔记已打开时聚焦现有叶子，否则在 PDF 右侧通过 `createLeafBySplit` 垂直分屏打开笔记
4. 焦点切换到笔记 leaf

**注意事项**：
- 笔记文件若已存在则不会重复创建，仅打开已有笔记
- PDF 或笔记已在任意叶子打开时不会重复打开新标签页，仅复用并聚焦对应叶子

---

### 3.2 `createReadingNote(pdfFile: TFile): Promise<TFile | null>`

**签名**：
```typescript
async createReadingNote(pdfFile: TFile): Promise<TFile | null>
```

**参数**：
- `pdfFile` — PDF 文件对象

**返回值**：创建或已存在的笔记 `TFile`，失败返回 `null`

**行为**：
1. 命名规则：优先 `{PDF文件名} 阅读.md`，存放于 `readingNoteFolder` 下；若该路径已被**其他 PDF** 的笔记占用（同名 PDF 冲突，以 frontmatter `pdf` 字段判别），按 `{文件名} 阅读 (n).md` 递增去重
   - `pdf` 字段与当前 PDF 路径不一致时，若旧链接文件已不存在且文件名一致（PDF 被移动/改名），判定为同一 PDF 直接复用，并自动把 frontmatter 的 `pdf` 字段修复为当前路径，避免重复新建
2. 调用 `extractPdfText` 提取全文 → `extractKeywords` 提取关键词
3. 生成 YAML frontmatter：`pdf`（源文件链接）、`created`（日期）、`tags`（关键词列表）
4. 正文写入三个引导问题：
   ```
   1.写出你的实验思路。

   2.从论文中获得的信息。

   3.发现的问题。
   ```

**注意事项**：
- 关键词提取失败时不写入 tags 字段，笔记仍正常创建
- 已存在笔记仅在确认属于同一 PDF（或无 `pdf` 字段的旧笔记）时复用，不会覆盖已有内容
- 目标路径被同名文件夹占用时返回 `null`

---

### 3.3 `handleAnnotation(): Promise<void>`

**签名**：
```typescript
private async handleAnnotation(): Promise<void>
```

**行为**：
1. 读取 `savedSelections` 中缓存的选区（点击浮动按钮「批注到笔记」触发）
2. 确保笔记已打开（复用已有 leaf 或在右侧新建）
3. 调用 `appendAnnotationsToNote` 将批注插入笔记光标位置：**优先经 CM6 编辑器 `replaceRange` 插入**（偏移与缓冲同源，无保存竞态），无编辑器（阅读模式）时回退为追加到文末
4. 写入失败时选区自动恢复，不丢失数据

**批注格式**（callout 块，多段选中合并为一个块，每段之间空行分隔并带独立页码引用）：
```markdown
> [!note] 批注
> {选中文字}
> [[{PDF路径}#page={页码}&selection={beginIndex},{beginOffset},{endIndex},{endOffset}|{PDF名}, 页面 {页码}]]
>
> 笔记：
```
- 链接目标使用 PDF 完整路径（`pdfFile.path`），避免同名文件歧义
- 选区定位失败时（跨页选区、文本层未渲染等），该段**不生成链接**，仅保留文字并输出 warn 日志
- 批注追加后，光标自动定位到「笔记：」行尾，便于继续输入

---

### 3.4 `extractKeywords(text: string): string[]`

**签名**：
```typescript
private extractKeywords(text: string): string[]
```

**参数**：
- `text` — PDF 全文文本

**返回值**：字符串数组，去重后的标签（空格转 `-`，移除特殊字符，最大长度 40）

**匹配模式**（按优先级，均可在原始文本或去空格文本上匹配）：
1. `/关键词[：:∶]?\s*([^\n。]+)/`
2. `/关键字[：:∶]?\s*([^\n。]+)/`
3. `/[Kk]eywords?[：:∶]?\s*([^\n。]+)/`

**停止标记**：`中图分类号`、`文献标识码`、`文章编号`、`DOI`、`分类号`、`收稿日期`、`修回日期`、`基金项目`、`Abstract`、`Keywords` 等，匹配到即截断（含内容起始处，`idx >= 0`）。

**分割符**：优先按 `；`、`;`、`，`、`,` 分割；分割结果不足 2 个时回退按空格分割。最终标签去重、去特殊字符、空格转 `-`、长度上限 40。

---

## 3. DeepSeek 模块 API

### 3.6 `getCurrentFileForUpload(): Promise<FileUploadData | null>`

**签名**：
```typescript
async getCurrentFileForUpload(): Promise<FileUploadData | null>
```

**行为**：获取当前活动文件的二进制数据用于上传（由 PdfReaderModule 提供，注入 DeepSeek 模块）：
- PDF 视图：读取 PDF 原始二进制（`application/pdf`）
- Markdown 视图：读取笔记文本并编码为 UTF-8（`text/markdown`）
- 其他情况：回退读取活动 `.md` 文件
- 无可用文件时返回 `null`

### 3.7 `addCurrentFileToChat(): Promise<void>`

**签名**：
```typescript
async addCurrentFileToChat(): Promise<void>
```

**行为**：将当前阅读文件上传到 DeepSeek 浮动窗口的聊天框：
1. 调用 `getCurrentFileForUpload` 获取文件数据，超过 100MB 上限则拒绝
2. ArrayBuffer → base64（分块转换，32KB/块避免栈溢出）
3. 分块注入 webview（8MB/块，写入每次上传独立的页面变量，避免超大 `executeJavaScript` 字符串阻塞主线程与并发污染），最后组装上传脚本（策略 A：找 `<input type="file">` 用 DataTransfer 赋值并触发 change；策略 B 兜底：在输入区模拟 dragover + drop）
4. 按返回结果提示：`success`（input 上传）/ `drop`（拖拽模拟）/ `not-found`（未找到上传入口，提示等待页面加载完成）

### 3.8 浮动窗口交互

- **打开/关闭**：左侧 Ribbon 机器人图标「打开 DeepSeek」，或命令「切换 DeepSeek 浮动窗口」（`toggle-deepseek-float`）切换显隐
- **拖拽**：按住标题栏（非按钮区域）拖动，拖动期间禁用 webview 指针事件；位置不钳制边界，面板可自由拖出 Obsidian 窗口范围（超出部分被视口裁剪），拖拽结束后恢复 transition
- **最小化**：标题栏「－」按钮隐藏窗口
- **加载文件**：标题栏「加载文件」按钮，或命令「将当前阅读文件上传到 DeepSeek 聊天框」（`deepseek-add-current-file`）
- **防丢失**：重新显示时若面板已完全移出 Obsidian 可视区域，会自动复位到默认位置（右上角）

---

## 4. 事件与钩子

| 事件 | 触发时机 | 携带数据 |
|------|----------|----------|
| `file-menu`（workspace） | 右键文件时 | `Menu` 对象 + `TFile`，仅 PDF 文件追加「开始阅读」菜单项 |
| `mouseup`（document） | 鼠标松开 | `MouseEvent`，检测 PDF 视图中的文字选区，显示浮动批注按钮；Ctrl/Command 键多选追加（切换 PDF 文件时自动清空多选缓存） |
| `mousedown`（document） | 鼠标按下 | 点击浮动按钮外部时隐藏按钮 |
| Ribbon 图标（插件） | 点击 | 切换 DeepSeek 浮动窗口显隐 |
| 命令（插件） | 执行 | `toggle-deepseek-float` 切换窗口；`deepseek-add-current-file` 上传当前文件到聊天框 |

---

## 5. 依赖关系

| 依赖 | 类型 | 说明 |
|------|------|------|
| `obsidian` | Obsidian API | `Plugin`, `TFile`, `Menu`, `WorkspaceLeaf`, `FileView`, `MarkdownView` 等 |
| `pdfjs-dist` | npm 包 | PDF 文本提取，内置 worker 通过 `WORKER_CODE` 注入，使用自定义 `CMapReaderFactory` |
| CMap 文件 | 本地资源 | `cmaps/` 目录下的 `.bcmap` 文件，用于中文 PDF 字符映射 |
| Electron `webview` | 运行时 | DeepSeek 浮动窗口使用 webview 标签（Electron 专有），Obsidian 桌面端可用 |

**环境要求**：`minAppVersion: 1.0.0`，仅桌面端（`isDesktopOnly: true`），需 Node.js `fs` 模块读取 CMap 文件；DeepSeek 窗口需联网。

---

## 6. 使用示例场景

### 场景 1：开始阅读 PDF

```
用户右键 PDF → 菜单「开始阅读」
  → 插件创建 ReadingNotes/{文件名} 阅读.md（含自动提取的关键词标签）
  → 左侧打开 PDF，右侧打开笔记
  → 用户在笔记中记录
```

### 场景 2：批注选中文字

```
用户在 PDF 视图中选中文字
  → 浮动按钮「批注到笔记」出现
  → 点击按钮 → 选中文字 + 页码链接追加到笔记
```

### 场景 3：Ctrl+多选批量批注

```
用户按住 Ctrl 在 PDF 中依次选择多段文字
  → 浮动按钮显示已选段数角标
  → 点击 → 所有段落合并为一个 callout 批注块一次性追加到笔记
```

### 场景 4：DeepSeek 浮动窗口 + 上传当前文件

```
用户点击 Ribbon 机器人图标（或执行命令）
  → DeepSeek 网页聊天在可拖拽浮动窗口中打开
  → 阅读 PDF / Markdown 时点击标题栏「加载文件」（或执行上传命令）
  → 当前文件自动上传到 DeepSeek 聊天框，直接与 AI 讨论
```

---

## 7. 常见问题与限制

- **CMap 依赖**：中文 PDF 文本提取依赖 `cmaps/` 下的字符映射文件，不可删除；路径按 `manifest.dir` 解析（Obsidian 1.7+），插件目录改名后仍可用。
- **文本提取范围**：仅提取 PDF 文本层内容，扫描版 PDF（纯图片）无法提取文字；页面提取并行执行，单页失败自动跳过其余页不受影响。
- **关键词提取**：依赖论文格式（「关键词：」行），非标准格式的 PDF 无法提取标签。
- **笔记覆盖**：`createReadingNote` 仅在笔记不存在（或属于其他 PDF 需去重）时写入初始内容，已存在的笔记不会更新 frontmatter。
- **非桌面端不可用**：`isDesktopOnly: true`，依赖 `fs.readFileSync` 与 Electron `webview`。
- **上传大小**：上传文件上限 100MB，超出会提示并拒绝。
- **上传入口依赖页面结构**：`addCurrentFileToChat` 依赖 DeepSeek 页面的文件上传元素（`<input type="file">` 或输入区拖拽），页面未加载完成或改版后可能失败，此时需手动上传。
