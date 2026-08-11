# 文献阅读助手 (Obsidian Literature Reader)

一个面向科研文献阅读的 Obsidian 桌面端插件：PDF 一键阅读、批注到笔记、关键词自动提取、批注持久高亮，并集成 DeepSeek 浮动窗口。

> 插件 ID：`pdf-reader` · 仅桌面端（依赖 Electron / PDF.js）

## 功能特性

- **PDF 一键阅读**：右键任意 PDF →「开始阅读」，自动垂直分屏（左 PDF / 右笔记）
- **关键词自动提取**：阅读时自动提取 PDF 关键词写入笔记 frontmatter，作为 Obsidian 标签
- **批注到笔记**：选中文字即可批注（callout 格式），支持 `Ctrl/Cmd + 多选` 批量批注
- **批注持久高亮**：批注过的位置在 PDF 中持久高亮显示（可配置颜色与透明度）
- **DeepSeek 浮动窗口**：可拖拽、可最小化的 DeepSeek 网页聊天窗口，支持一键上传当前 PDF / 笔记内容

## 安装

### 手动安装

1. 在 Releases 页面下载最新 `main.js`、`manifest.json`、`styles.css`（及 `cmaps/` 目录，仓库内已附带）
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
3. 点击工具栏按钮或使用命令打开 DeepSeek 浮动窗口，「加载文件」可将当前 PDF / 笔记上传

## 设置项

| 参数 | 说明 |
|------|------|
| 阅读笔记文件夹 | 阅读笔记存放路径（相对 vault 根目录，默认 `ReadingNotes`） |
| 高亮颜色 / 透明度 | 批注持久高亮的外观 |
| DeepSeek 地址 | 嵌入浮动窗口的 DeepSeek 网页地址 |

## 技术说明

- 基于 [PDF.js](https://github.com/mozilla/pdf.js)（pdfjs-dist，Apache-2.0）、[pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）、[fflate](https://github.com/101arrowz/fflate)（MIT）
- `main.js` 由 esbuild 打包，PDF.js worker 内联；`cmaps/` 在构建时从 `node_modules/pdfjs-dist/cmaps` 自动复制

## 许可证

[MIT](LICENSE) © mongfayi

---

如果这个插件对你有帮助，欢迎请我喝杯咖啡 ☕

![赞赏码](docs/sponsor.jpg)