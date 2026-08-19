# 文献阅读助手 (Obsidian Literature Reader)

一个面向文献阅读的 Obsidian 桌面端插件：PDF 一键阅读、批注到笔记、关键词自动提取、批注持久高亮、截图 OCR 批注，并集成 DeepSeek 浮动窗口。

> 插件 ID：`pdf-reader` · 仅桌面端（依赖 Electron / PDF.js）

## 功能特性

- **PDF 一键阅读**：右键任意 PDF →「开始阅读」，自动垂直分屏（左 PDF / 右笔记）
- **关键词自动提取**：阅读时自动提取 PDF 关键词写入笔记 frontmatter，作为 Obsidian 标签（似乎只适配了部分格式的文献）
- **批注到笔记**：选中文字即可批注（callout 格式），支持 `Ctrl/Cmd + 多选` 批量批注
- **批注持久高亮**：批注过的位置在 PDF 中持久高亮显示（可配置颜色与透明度）
- **高亮 ↔ 笔记双向跳转**：点击 PDF 中的高亮区域跳到笔记中对应批注；点击笔记中的 PDF 链接跳回 PDF 对应位置；目标文件未打开时自动分屏打开（笔记链接 → PDF 在笔记左侧打开；高亮 → 笔记在 PDF 右侧打开），不会覆盖当前页面
- **批注只写链接模式**（测试功能，以后可能删除）：PDF 工具条「附带原文」按钮，默认关闭；关闭时文字选中批注只写 PDF 链接（无 callout 包围框、无「笔记：」提示行），默认插入在笔记光标处（光标停在上一条批注链接附近时自动改在该链接之后），光标停在链接上方空行（文字写在链接上方），多次批注不会互相穿插；不影响 OCR / 截图批注
- **DeepSeek 浮动窗口**：可拖拽、可最小化的 DeepSeek 网页聊天窗口，支持一键上传当前 PDF / 笔记内容
- **截图 OCR 批注**：在 PDF 视图工具条点「截图 OCR 批注」按钮，框选区域用 LM Studio 视觉模型识别文字并批注到笔记，OCR 区域持久高亮（适合扫描版/无文本层 PDF）
- **文件管理器标记**：在左侧文件管理器中，已有阅读笔记的 PDF 会显示一个小图标；笔记创建/删除/重命名后自动更新

## 安装

### 手动安装

1. 下载`main.js`、`manifest.json`、`styles.css`（及 `cmaps/` 目录，仓库内已附带）
2. 放入 vault 的 `.obsidian/plugins/pdf-reader/` 目录
3. 重启 Obsidian，在「设置 → 第三方插件」中启用「文献阅读助手」

### 从源码构建

```bash
npm install
npm run build   # 产出 main.js，并自动复制 cmaps/
```

## 使用

1. 在文件管理器中右键一个 PDF →「开始阅读」
2. 阅读时选中文字 → 弹出批注菜单，写入右侧阅读笔记；按住 `Ctrl/Cmd` 可连续多选批量批注
3. 点击 PDF 中的高亮区域 → 跳到笔记中对应批注；点击笔记中的 `页面 N` 链接 → 跳回 PDF 对应位置（PDF 未打开时会在笔记左侧分屏打开）
4. 点击工具栏按钮或使用命令打开 DeepSeek 浮动窗口，「加载文件」可将当前 PDF / 笔记上传
5. 在 PDF 视图工具条点「截图 OCR 批注」按钮（crop 图标）→ 拖拽框选区域 → LM Studio 识别文字并写入笔记（需先在设置中配置 LM Studio 服务器地址）

## 设置项

| 参数 | 说明 |
|------|------|
| 阅读笔记文件夹 | 阅读笔记存放路径（相对 vault 根目录，默认 `ReadingNotes`） |
| 高亮颜色 / 透明度 | 批注持久高亮的外观 |
| DeepSeek 地址 | 嵌入浮动窗口的 DeepSeek 网页地址 |
| LM Studio 服务器地址 | OpenAI 兼容接口地址（默认 `http://127.0.0.1:1234`） |
| OCR 模型 | 留空自动选择服务器上的视觉模型 |
| 请求超时（秒） | 单次 OCR 请求超时时间（默认 120） |
| 最大输出令牌 | 单次识别请求最大输出长度（默认 8192） |
| OCR 提示词 | PaddleOCR-VL 用任务词如 `OCR:` |

## 安全说明

- **OCR API Key 以明文存储**：LM Studio API Key 保存在插件目录的 `data.json`（即 vault 的 `.obsidian/plugins/pdf-reader/data.json`）中，Obsidian 插件 API 不提供加密存储。
- 如果你的 vault 通过 iCloud / OneDrive / Syncthing / git 等同步，密钥会随之传播。建议：不使用 LM Studio 鉴权时留空该字段；使用鉴权时定期在 LM Studio 中轮换密钥，并考虑在同步配置中排除 `.obsidian/plugins/pdf-reader/data.json`（排除后需在本机重新填写一次）。
- 插件依赖 Electron 专有 `webview` 标签与部分 Obsidian 内部 API，**仅支持桌面端**（`manifest.json` 已声明 `isDesktopOnly: true`）。

## 技术说明

- 基于 [PDF.js](https://github.com/mozilla/pdf.js)（pdfjs-dist，Apache-2.0）、[pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）、[fflate](https://github.com/101arrowz/fflate)（MIT）
- `main.js` 由 esbuild 打包，PDF.js worker 内联；`cmaps/` 在构建时从 `node_modules/pdfjs-dist/cmaps` 自动复制

## 许可证

[MIT](LICENSE) © mongfayi

---

如果这个插件对你有帮助，欢迎请我喝杯咖啡 ☕

<img src="docs/sponsor.jpg" alt="赞赏码" width="295" />
