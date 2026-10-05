"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => LiteratureReaderPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian20 = require("obsidian");

// modules/noteNaming.ts
var DEFAULT_NOTE_NAME_TEMPLATE = "{name} \u9605\u8BFB";
function renderNoteBaseName(pdfBasename, template) {
  const tpl = isValidNameTemplate(template) ? template : DEFAULT_NOTE_NAME_TEMPLATE;
  return tpl.split("{name}").join(pdfBasename);
}
function isValidNameTemplate(template) {
  return typeof template === "string" && template.includes("{name}");
}
function buildNoteBaseRegex(template) {
  const tpl = isValidNameTemplate(template) ? template : DEFAULT_NOTE_NAME_TEMPLATE;
  const escaped = tpl.split("{name}").map(escapeRegExp).join("(.+)");
  return new RegExp(`^${escaped}(?: \\((\\d+)\\))?$`);
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sanitizeLinkAlias(label) {
  return (label ?? "").replace(/[\r\n\u2028\u2029]/g, " ").replace(/[[\]|]/g, "").trim();
}

// types.ts
var DEFAULT_SETTINGS = {
  readingNoteFolder: "ReadingNotes",
  deepseekUrl: "https://chat.deepseek.com",
  deepseekOpenMode: "floating",
  ocrServerUrl: "http://127.0.0.1:1234",
  ocrApiKey: "",
  ocrModel: "paddleocr-vl-1.6",
  ocrRequestTimeoutSec: 120,
  ocrMaxTokens: 8192,
  ocrPrompt: "OCR:",
  // 与旧版本遗留 data.json 及 README 承诺一致的经典黄色高亮
  highlightColor: "#FFFF00",
  highlightOpacity: 0.4,
  annotationIncludeOriginalText: false,
  annotationLinkLabel: "\u5B9A\u4F4D",
  annotationPromptLine: "> \u7B14\u8BB0\uFF1A",
  readingNoteNameTemplate: DEFAULT_NOTE_NAME_TEMPLATE,
  // 默认为空：新建阅读笔记正文仅含 frontmatter，不留预设板块
  readingNoteBodyTemplate: "",
  ocrMinSidePx: 512,
  ocrMaxUpscaleFactor: 4,
  ocrSanitizeOutput: true,
  fileMarkerEnabled: true,
  wordCountFixEnabled: true,
  searchIgnoreLinks: false,
  quickTags: [],
  pendingTagRenames: [],
  quickTagToolbarButton: true,
  markdownAnnotationRecords: [],
  deepseekWindowGeometry: null
};

// modules/PdfReaderModule.ts
var import_obsidian = require("obsidian");

// modules/pdfjsLoader.ts
var fallbackPdfjsPromise = null;
function resolvePluginDir(pluginDir) {
  return (pluginDir ?? "pdf-reader").split("/").pop() ?? "pdf-reader";
}
function loadFallbackPdfjs(pluginDirName, adapter) {
  if (fallbackPdfjsPromise)
    return fallbackPdfjsPromise;
  const base = `.obsidian/plugins/${resolvePluginDir(pluginDirName)}`;
  const libUrl = adapter.getResourcePath(`${base}/pdfjs-fallback.mjs`);
  const workerUrl = adapter.getResourcePath(`${base}/pdf.worker.min.mjs`);
  fallbackPdfjsPromise = (async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = libUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`\u52A0\u8F7D pdfjs-fallback.mjs \u5931\u8D25: ${libUrl}`));
      document.head.appendChild(script);
    });
    const lib = window.__pdfReaderFallbackLib;
    if (!lib?.getDocument) {
      throw new Error("pdfjs-fallback.mjs \u5DF2\u52A0\u8F7D\u4F46\u672A\u66B4\u9732 __pdfReaderFallbackLib");
    }
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  })();
  fallbackPdfjsPromise.catch(() => {
    fallbackPdfjsPromise = null;
  });
  return fallbackPdfjsPromise;
}
async function loadPdfjsLib(plugin) {
  const appPdfjs = window.pdfjsLib;
  if (appPdfjs?.getDocument)
    return appPdfjs;
  return loadFallbackPdfjs(
    resolvePluginDir(plugin.manifest.dir),
    plugin.app.vault.adapter
  );
}

// modules/PdfReaderModule.ts
var LINE_BREAK_THRESHOLD = 5;
var PdfReaderModule = class {
  constructor(ctx) {
    this.floatingBtn = null;
    this.floatingBadge = null;
    this.trackedRange = null;
    this.followTimerId = null;
    this.savedSelections = [];
    this.currentPdfPath = null;
    this.refreshHighlights = null;
    this.refreshRectHighlights = null;
    this.includeOriginalTextProvider = null;
    this.startingPdfs = /* @__PURE__ */ new Set();
    this.ctx = ctx;
    this.lastNotePath = null;
    this.lastNoteEditor = null;
    this.annotationTargetExclusionProvider = null;
    this.recentNoteTargets = [];
    this.readingSourceProvider = null;
  }
  /** 批注回链 PDF 的链接显示文字（可配置，默认「定位」；写入用户笔记正文） */
  get linkLabel() {
    const v = sanitizeLinkAlias(this.ctx.getSettings().annotationLinkLabel);
    return v ? v : DEFAULT_SETTINGS.annotationLinkLabel;
  }
  /** 批注 callout 末尾提示行（可配置；强制以 '>' 开头以维持 callout 块格式） */
  get notePrompt() {
    const v = this.ctx.getSettings().annotationPromptLine;
    const raw = v && v.trim() ? v.trim() : DEFAULT_SETTINGS.annotationPromptLine;
    return raw.startsWith(">") ? raw : `> ${raw}`;
  }
  /** 注入批注后的高亮刷新回调 */
  setRefreshHighlights(cb) {
    this.refreshHighlights = cb;
  }
  /** 注入无文本锚点批注的矩形高亮刷新回调 */
  setRefreshRectHighlights(cb) {
    this.refreshRectHighlights = cb;
  }
  /** 注入批注原文附带模式提供者（工具栏「附带原文」切换；默认关闭=不附带原文） */
  setIncludeOriginalTextProvider(provider) {
    this.includeOriginalTextProvider = provider;
  }
  /** 注入“不作为批注目标”的笔记过滤器（由 MarkdownReadingModule 注入）。 */
  setAnnotationTargetExclusionProvider(provider) {
    this.annotationTargetExclusionProvider = provider;
  }
  /** 注入「把某篇 md 标记为正在阅读的文献」入口（由 MarkdownReadingModule 注入） */
  setReadingSourceProvider(provider) {
    this.readingSourceProvider = provider;
  }
  load() {
    const plugin = this.ctx.plugin;
    plugin.registerEvent(
      plugin.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof import_obsidian.TFile))
          return;
        if (file.extension === "pdf") {
          menu.addItem((item) => {
            item.setTitle("\u5F00\u59CB\u9605\u8BFB").setIcon("book-open").onClick(async () => {
              await this.startReading(file);
            });
          });
          return;
        }
        if (file.extension === "md") {
          menu.addItem((item) => {
            item.setTitle("\u5F00\u59CB\u9605\u8BFB").setIcon("book-open").onClick(async () => {
              await this.startReadingForNote(file);
            });
          });
        }
      })
    );
    plugin.addCommand({
      id: "shorten-pdf-annotation-links",
      name: `\u5C06\u5F53\u524D\u7B14\u8BB0\u4E2D\u7684 PDF \u6279\u6CE8\u94FE\u63A5\u663E\u793A\u6587\u5B57\u6539\u4E3A\u300C${this.linkLabel}\u300D`,
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== "md")
          return false;
        if (!checking) {
          void this.shortenPdfAnnotationLinks(file);
        }
        return true;
      }
    });
    this.initFloatingButton();
    plugin.registerDomEvent(document, "mouseup", (evt) => {
      if (evt.button !== 0)
        return;
      this.handlePdfMouseUp(evt);
    });
    plugin.registerDomEvent(document, "mousedown", (evt) => {
      if (evt.button !== 0)
        return;
      if (!this.floatingBtn)
        return;
      const target = evt.target;
      if (this.floatingBtn.contains(target))
        return;
      if (target instanceof Element && target.closest(".menu"))
        return;
      this.hideFloatingButton();
    });
    plugin.registerDomEvent(document, "scroll", () => this.repositionFloatingButton(), { capture: true });
    plugin.registerDomEvent(window, "resize", () => this.repositionFloatingButton());
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.trackActiveNote()));
    this.trackActiveNote();
  }
  unload() {
    this.removeFloatingButton();
    this.savedSelections = [];
    this.currentPdfPath = null;
  }
  // ========== 获取当前活动文件二进制数据（供 DeepSeek 上传） ==========
  /**
   * 获取当前活动文件的二进制数据用于上传：
   *  - PDF 视图：读取 PDF 原始二进制（非文本提取）
   *  - Markdown 视图：读取笔记内容并编码为 UTF-8
   *  - 其他：尝试读取活动 .md 文件
   * 无可用文件时返回 null
   */
  async getCurrentFileForUpload() {
    const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
    if (!activeLeaf)
      return null;
    const view = activeLeaf.view;
    if (view.getViewType() === "pdf") {
      const pdfFile = view.file;
      if (!pdfFile)
        return null;
      try {
        const data = await this.ctx.plugin.app.vault.readBinary(pdfFile);
        return { data, name: pdfFile.name, mimeType: "application/pdf" };
      } catch (e) {
        console.error("[PdfReader] \u8BFB\u53D6 PDF \u4E8C\u8FDB\u5236\u5931\u8D25:", e);
        return null;
      }
    }
    if (view instanceof import_obsidian.MarkdownView) {
      const file2 = view.file;
      if (!file2)
        return null;
      const text = view.getMode() === "source" && view.editor ? view.editor.getValue() : await this.ctx.plugin.app.vault.read(file2);
      return {
        data: new TextEncoder().encode(text).buffer,
        name: file2.name,
        mimeType: "text/markdown"
      };
    }
    const file = this.ctx.plugin.app.workspace.getActiveFile();
    if (file && file.extension === "md") {
      const text = await this.ctx.plugin.app.vault.read(file);
      return {
        data: new TextEncoder().encode(text).buffer,
        name: file.name,
        mimeType: "text/markdown"
      };
    }
    return null;
  }
  /**
   * 把当前笔记中已有 PDF 批注链接的冗长显示文字（如“XXX, 页面 12”）批量改成短标签。
   * 只改链接的显示文字，不改变链接目标，因此原有跳转/高亮功能不受影响。
   */
  async shortenPdfAnnotationLinks(file) {
    const label = this.linkLabel;
    try {
      const content = await this.ctx.plugin.app.vault.read(file);
      const updated = content.replace(
        /\[\[([^\]|]+?\.pdf#[^\]|]*?)\|[^\]|]*?[,，]\s*页面\s*\d+\]\]/g,
        (_match, target) => `[[${target}|${label}]]`
      );
      if (updated === content) {
        new import_obsidian.Notice("\u5F53\u524D\u7B14\u8BB0\u4E2D\u6CA1\u6709\u627E\u5230\u53EF\u7F29\u77ED\u7684 PDF \u6279\u6CE8\u94FE\u63A5");
        return;
      }
      await this.ctx.plugin.app.vault.modify(file, updated);
      new import_obsidian.Notice(`\u5DF2\u5C06\u8BE5\u7B14\u8BB0\u4E2D\u7684 PDF \u6279\u6CE8\u94FE\u63A5\u663E\u793A\u6587\u5B57\u6539\u4E3A\u300C${label}\u300D`);
    } catch (e) {
      console.error("[PdfReader] \u7F29\u77ED\u6279\u6CE8\u94FE\u63A5\u5931\u8D25:", e);
      new import_obsidian.Notice("\u7F29\u77ED\u6279\u6CE8\u94FE\u63A5\u5931\u8D25");
    }
  }
  // ========== 开始阅读主流程 ==========
  /**
   * 开始阅读：把「要读的文献」与它的阅读笔记并排打开（左文献 / 右笔记，焦点给笔记）。
   *
   * @param sourceFile 要读的文献：PDF 或 Markdown 都可以
   * @param noteFile 右侧笔记；省略时按命名模板创建/复用 —— 右键 Markdown 笔记
   *                 （它自己就是某篇文献的笔记）这类入口必须显式传入那一篇
   */
  async startReading(sourceFile, noteFile) {
    const guardKey = noteFile ? `${sourceFile.path}::${noteFile.path}` : sourceFile.path;
    if (this.startingPdfs.has(guardKey))
      return;
    this.startingPdfs.add(guardKey);
    try {
      const targetNote = noteFile ?? await this.createReadingNote(sourceFile);
      if (!targetNote)
        return;
      let sourceLeaf = this.findLeafByPath(sourceFile.path);
      if (!sourceLeaf) {
        sourceLeaf = this.ctx.plugin.app.workspace.getLeaf("tab");
        await sourceLeaf.openFile(sourceFile);
      }
      const noteLeaf = this.findLeafByPath(targetNote.path);
      if (noteLeaf) {
        this.ctx.plugin.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
      } else if (sourceLeaf) {
        const rightLeaf = this.ctx.plugin.app.workspace.createLeafBySplit(sourceLeaf, "vertical", false);
        await rightLeaf.openFile(targetNote);
        this.ctx.plugin.app.workspace.setActiveLeaf(rightLeaf, { focus: true });
      }
    } catch (error) {
      console.error("[PdfReader] \u5F00\u59CB\u9605\u8BFB\u5931\u8D25:", error);
    } finally {
      this.startingPdfs.delete(guardKey);
    }
  }
  /**
   * 右键 Markdown 的「开始阅读」，按「这篇 md 是阅读笔记还是待读文献」分流：
   *
   *  1. 阅读笔记（在阅读笔记文件夹内，或名字就是模板命名的「{name} 阅读」）
   *     → 打开它对应的文献 + 这篇笔记，不再另建笔记；
   *  2. 其余 md 一律当作**要阅读的文献**：左边打开它，右边创建/复用
   *     「{md 名} 阅读.md」，并把它标记为「正在阅读的文献」——
   *     选中它的文字就能批注进右侧笔记，与 PDF 那套流程一致。
   *
   * 判据不能只看「有没有 pdf 字段」：精读版章节原文（reference/GWAS中文版/*.md）
   * 同样带 pdf 字段，但它们是要读的文献，不是笔记。
   */
  async startReadingForNote(mdFile) {
    if (this.isReadingNote(mdFile)) {
      const source = this.resolveNoteSource(mdFile);
      if (!source) {
        new import_obsidian.Notice(`\u300C${mdFile.basename}\u300D\u662F\u4E00\u7BC7\u9605\u8BFB\u7B14\u8BB0\uFF0C\u4F46\u6CA1\u627E\u5230\u5B83\u5BF9\u5E94\u7684\u6587\u732E
\u53EF\u5728 frontmatter \u91CC\u52A0 pdf / source \u5B57\u6BB5\u91CD\u65B0\u5173\u8054`);
        return;
      }
      await this.startReading(source, mdFile);
      if (source.extension === "md")
        this.markReadingSource(source);
      return;
    }
    await this.startReading(mdFile);
    this.markReadingSource(mdFile);
  }
  /** md 是否为「阅读笔记」：位于阅读笔记文件夹内，或名字已符合命名模板 */
  isReadingNote(mdFile) {
    const folderPath = (0, import_obsidian.normalizePath)(this.ctx.getSettings().readingNoteFolder);
    if (folderPath && mdFile.path.startsWith(folderPath + "/"))
      return true;
    return buildNoteBaseRegex(this.ctx.getSettings().readingNoteNameTemplate).test(mdFile.basename);
  }
  /** 把某篇 md 标记为「正在阅读的文献」（标记入口由 MarkdownReadingModule 注入） */
  markReadingSource(file) {
    this.readingSourceProvider?.(file.path);
  }
  /**
   * 解析笔记关联的文献（PDF 或 Markdown）：
   *  1. frontmatter 的 `pdf: "[[路径]]"`（PDF 笔记）或 `source: "[[路径]]"`（md 文献笔记）；
   *  2. 无该字段的旧笔记：按命名模板反查同名 PDF（与 ReadingNoteMarkerModule 同一套规则）。
   * 都解析不到返回 null。
   */
  resolveNoteSource(note) {
    const linked = this.extractNoteSourceField(note);
    if (linked) {
      const candidates = [linked, linked.split("#")[0].trim()];
      for (const candidate of candidates) {
        if (!candidate)
          continue;
        const direct = this.ctx.plugin.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(candidate));
        if (direct instanceof import_obsidian.TFile && (direct.extension === "pdf" || direct.extension === "md"))
          return direct;
        const dest = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(candidate, note.path);
        if (dest instanceof import_obsidian.TFile && (dest.extension === "pdf" || dest.extension === "md"))
          return dest;
      }
    }
    return this.findPdfByNoteName(note);
  }
  /** 读取 frontmatter 的 pdf / source 字段并取出其中的路径（`"[[路径]]"` 与纯路径都支持） */
  extractNoteSourceField(note) {
    const fm = this.ctx.plugin.app.metadataCache.getFileCache(note)?.frontmatter;
    const pick = (value) => {
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw !== "string")
        return null;
      const m = raw.match(/\[\[(.+?)\]\]/);
      const path = (m ? m[1] : raw).split("|")[0].trim();
      return path || null;
    };
    return pick(fm?.pdf) ?? pick(fm?.source);
  }
  /**
   * 旧笔记兜底（没有 pdf / source 字段）：笔记位于阅读笔记文件夹内、且名字符合命名模板时，
   * 把模板里的 {name} 部分当作 PDF 文件名，在库中找唯一同名 PDF。
   * 同名 PDF 有多个时不猜（返回 null），避免把笔记配到别的文献上。
   */
  findPdfByNoteName(note) {
    const folderPath = (0, import_obsidian.normalizePath)(this.ctx.getSettings().readingNoteFolder);
    if (folderPath && !note.path.startsWith(folderPath + "/"))
      return null;
    const m = note.basename.match(buildNoteBaseRegex(this.ctx.getSettings().readingNoteNameTemplate));
    if (!m)
      return null;
    const matches = this.ctx.plugin.app.vault.getFiles().filter((f) => f.extension === "pdf" && f.basename === m[1]);
    return matches.length === 1 ? matches[0] : null;
  }
  /** 查找已打开指定文件的叶子，未打开返回 null */
  findLeafByPath(path) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!result && leaf.view instanceof import_obsidian.FileView && leaf.view.file?.path === path) {
        result = leaf;
      }
    });
    return result;
  }
  // ========== 阅读笔记创建 ==========
  async createReadingNote(sourceFile) {
    const folderPath = this.ctx.getSettings().readingNoteFolder;
    const folder = this.ctx.plugin.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof import_obsidian.TFile) {
      new import_obsidian.Notice(`\u9605\u8BFB\u7B14\u8BB0\u6587\u4EF6\u5939\u88AB\u540C\u540D\u6587\u4EF6\u5360\u7528\uFF1A${folderPath}`);
      return null;
    }
    if (!folder) {
      try {
        await this.ctx.plugin.app.vault.createFolder(folderPath);
      } catch (e) {
        console.error("[PdfReader] \u521B\u5EFA\u9605\u8BFB\u7B14\u8BB0\u6587\u4EF6\u5939\u5931\u8D25:", e);
        new import_obsidian.Notice("\u521B\u5EFA\u9605\u8BFB\u7B14\u8BB0\u6587\u4EF6\u5939\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E");
        return null;
      }
    }
    const notePath = await this.resolveNotePath(sourceFile, folderPath);
    if (!notePath) {
      new import_obsidian.Notice(`\u65E0\u6CD5\u521B\u5EFA\u9605\u8BFB\u7B14\u8BB0\uFF1A${sourceFile.basename} \u5B58\u5728\u8FC7\u591A\u540C\u540D\u7B14\u8BB0\u51B2\u7A81`);
      return null;
    }
    const noteFile = this.ctx.plugin.app.vault.getAbstractFileByPath(notePath);
    if (noteFile instanceof import_obsidian.TFile)
      return noteFile;
    if (noteFile instanceof import_obsidian.TFolder)
      return null;
    const initialContent = await this.generateNoteContent(sourceFile);
    return await this.ctx.plugin.app.vault.create(notePath, initialContent);
  }
  /**
   * 解析阅读笔记路径（文件名来自可配置模板，{name} = 文献文件名）：
   *  - 优先「渲染(模板).md」，不存在则返回
   *  - 已存在且属于同一文献（frontmatter pdf / source 字段一致或缺失）时复用
   *  - 属于其他文献（同名文献冲突）时，按「渲染(模板) (n).md」递增去重
   *  - 所有候选都被其他文献占用时返回 null（调用方应终止并提示，避免写错笔记）
   */
  async resolveNotePath(sourceFile, folderPath) {
    const baseName = renderNoteBaseName(sourceFile.basename, this.ctx.getSettings().readingNoteNameTemplate);
    const basePath = (0, import_obsidian.normalizePath)(`${folderPath}/${baseName}.md`);
    const base = this.ctx.plugin.app.vault.getAbstractFileByPath(basePath);
    if (base instanceof import_obsidian.TFile && await this.belongsToSource(base, sourceFile)) {
      return basePath;
    }
    if (!base) {
      return basePath;
    }
    for (let n = 2; n <= 99; n++) {
      const candidate = (0, import_obsidian.normalizePath)(`${folderPath}/${baseName} (${n}).md`);
      const existing = this.ctx.plugin.app.vault.getAbstractFileByPath(candidate);
      if (existing instanceof import_obsidian.TFile && await this.belongsToSource(existing, sourceFile)) {
        return candidate;
      }
      if (!existing) {
        return candidate;
      }
    }
    return null;
  }
  /** 笔记 frontmatter 里记录文献路径的字段名：PDF 用 pdf，其余（md 文献）用 source */
  sourceFieldName(sourceFile) {
    return sourceFile.extension === "pdf" ? "pdf" : "source";
  }
  /** 判断笔记是否属于指定文献（读取 frontmatter 的 pdf / source 字段） */
  async belongsToSource(noteFile, sourceFile) {
    try {
      const content = await this.ctx.plugin.app.vault.read(noteFile);
      const match = content.match(/^(?:pdf|source):\s*["']?\[\[(.+?)\]\]["']?/m);
      if (!match)
        return true;
      const linked = match[1];
      if (linked === sourceFile.path)
        return true;
      if (!(this.ctx.plugin.app.vault.getAbstractFileByPath(linked) instanceof import_obsidian.TFile)) {
        const linkedName = linked.split("/").pop();
        if (linkedName === sourceFile.name) {
          await this.repairSourceField(noteFile, sourceFile);
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn("[PdfReader] \u8BFB\u53D6\u7B14\u8BB0 frontmatter \u5931\u8D25\uFF0C\u6309\u540C\u4E00\u6587\u732E\u5904\u7406:", e);
      return true;
    }
  }
  /** 仅替换 frontmatter 中的文献字段（pdf / source）为当前路径，不触碰笔记正文 */
  replaceSourceField(content, newPath, field = "pdf") {
    const lines = content.split("\n");
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (i === 0 && t === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && t === "---")
        break;
      if (inFrontmatter && new RegExp(`^${field}:`).test(lines[i])) {
        lines[i] = `${field}: "[[${newPath}]]"`;
        break;
      }
    }
    return lines.join("\n");
  }
  async repairSourceField(noteFile, sourceFile) {
    const field = this.sourceFieldName(sourceFile);
    try {
      await this.ctx.plugin.app.vault.process(noteFile, (data) => {
        const fixed = this.replaceSourceField(data, sourceFile.path, field);
        if (fixed !== data) {
          console.log(`[PdfReader] \u4FEE\u590D\u7B14\u8BB0 ${noteFile.path} \u7684 ${field} \u5B57\u6BB5 \u2192 ${sourceFile.path}`);
        }
        return fixed;
      });
    } catch (e) {
      console.warn("[PdfReader] \u4FEE\u590D\u6587\u732E\u5B57\u6BB5\u5931\u8D25:", e);
    }
  }
  async generateNoteContent(sourceFile) {
    const now = /* @__PURE__ */ new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    let tags = [];
    if (sourceFile.extension === "pdf") {
      try {
        const text = await this.extractPdfText(sourceFile);
        console.log(`[PdfReader] \u6210\u529F\u63D0\u53D6PDF\u6587\u672C\uFF0C\u603B\u957F\u5EA6: ${text.length} \u5B57\u7B26`);
        tags = this.extractKeywords(text);
        console.log(`[PdfReader] \u5173\u952E\u8BCD\u63D0\u53D6\u7ED3\u679C: ${tags.length > 0 ? tags.join(", ") : "\u672A\u627E\u5230\u5173\u952E\u8BCD"}`);
      } catch (e) {
        console.warn("[PdfReader] \u63D0\u53D6PDF\u5173\u952E\u8BCD\u5931\u8D25\uFF0C\u5C06\u751F\u6210\u4E0D\u5E26 tags \u7684\u7B14\u8BB0:", e);
      }
    }
    let frontmatter = `---
${this.sourceFieldName(sourceFile)}: "[[${sourceFile.path}]]"
created: ${date}`;
    if (tags.length > 0) {
      frontmatter += `
tags:
${tags.map((t) => `  - ${t}`).join("\n")}`;
    }
    frontmatter += "\n---\n";
    const body = (this.ctx.getSettings().readingNoteBodyTemplate || "").replace(/\r\n/g, "\n");
    return frontmatter + body + "\n";
  }
  // ========== PDF 文本提取 ==========
  async extractPdfText(pdfFile) {
    const arrayBuffer = await this.ctx.plugin.app.vault.readBinary(pdfFile);
    const appPdfjs = window.pdfjsLib;
    if (appPdfjs?.getDocument) {
      const loadingTask2 = appPdfjs.getDocument({
        data: arrayBuffer,
        cMapUrl: "/lib/pdfjs/cmaps/",
        cMapPacked: true
      });
      return await this.extractTextFromDocument(loadingTask2);
    }
    const fs = require("fs");
    class PluginCMapReaderFactory {
      constructor({ baseUrl, isCompressed }) {
        this.baseUrl = baseUrl;
        this.isCompressed = isCompressed;
      }
      async fetch({ name }) {
        const url = this.baseUrl + name + (this.isCompressed ? ".bcmap" : "");
        const urlPath = url.startsWith("file:///") ? url.slice(8) : url;
        const data = fs.readFileSync(urlPath);
        return {
          cMapData: new Uint8Array(data),
          isCompressed: this.isCompressed
        };
      }
    }
    const vaultPath = this.ctx.plugin.app.vault.adapter.getBasePath();
    const pluginDir = (this.ctx.plugin.manifest.dir ?? "pdf-reader").split("/").pop() ?? "pdf-reader";
    const cMapBaseUrl = "file:///" + vaultPath.replace(/\\/g, "/") + "/.obsidian/plugins/" + pluginDir + "/cmaps/";
    const lib = await loadPdfjsLib(this.ctx.plugin);
    const loadingTask = lib.getDocument({
      data: arrayBuffer,
      cMapUrl: cMapBaseUrl,
      cMapPacked: true,
      useWorkerFetch: false,
      isEvalSupported: false,
      CMapReaderFactory: PluginCMapReaderFactory
    });
    return await this.extractTextFromDocument(loadingTask);
  }
  /** 从加载任务中分批提取文本（两套 pdfjs 共用）：每批并行、批间串行，限制同时在内存中的页面数 */
  async extractTextFromDocument(loadingTask) {
    const pdf = await loadingTask.promise;
    const parts = new Array(pdf.numPages).fill(null);
    const BATCH_SIZE = 32;
    try {
      for (let start = 1; start <= pdf.numPages; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, pdf.numPages);
        const results = await Promise.allSettled(
          Array.from(
            { length: end - start + 1 },
            (_, k) => pdf.getPage(start + k).then((page) => page.getTextContent()).then((textContent) => this.formatPageText(textContent.items))
          )
        );
        for (let k = 0; k < results.length; k++) {
          const result = results[k];
          if (result.status === "fulfilled") {
            parts[start - 1 + k] = result.value;
          } else {
            console.warn(`[PdfReader] \u7B2C ${start + k} \u9875\u6587\u672C\u63D0\u53D6\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7:`, result.reason);
          }
        }
      }
    } finally {
      pdf.destroy();
    }
    let fullText = "";
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== null)
        fullText += parts[i] + "\n";
    }
    return fullText;
  }
  /** 将单页文本项按行/空格规则拼接为页面文本（与逐页串行时的输出一致） */
  formatPageText(items) {
    let pageText = "";
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      if (j > 0) {
        const prev = items[j - 1];
        const prevY = prev.transform ? prev.transform[5] : null;
        const currY = item.transform ? item.transform[5] : null;
        if (prevY !== null && currY !== null && Math.abs(prevY - currY) > LINE_BREAK_THRESHOLD) {
          pageText += "\n";
        } else {
          const curChar = prev.str.charAt(prev.str.length - 1) || "";
          const nextChar = item.str.charAt(0) || "";
          if (this.needSpaceBetween(curChar, nextChar)) {
            pageText += " ";
          }
        }
      }
      pageText += item.str;
    }
    return pageText;
  }
  isCJK(ch) {
    const cp = ch.codePointAt(0);
    if (!cp)
      return false;
    return cp >= 11904 && cp <= 12031 || cp >= 12288 && cp <= 12351 || cp >= 13312 && cp <= 19903 || cp >= 19968 && cp <= 40959 || cp >= 63744 && cp <= 64255 || cp >= 65280 && cp <= 65519 || cp >= 131072 && cp <= 191471;
  }
  needSpaceBetween(left, right) {
    if (!left || !right)
      return false;
    if (this.isCJK(left) && this.isCJK(right))
      return false;
    return true;
  }
  // ========== 关键词提取 ==========
  extractKeywords(text) {
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const stopMarkers = [
      "\u4E2D\u56FE\u5206\u7C7B\u53F7",
      "\u6587\u732E\u6807\u8BC6\u7801",
      "\u6587\u7AE0\u7F16\u53F7",
      "DOI",
      "doi",
      "\u5206\u7C7B\u53F7",
      "\u6536\u7A3F\u65E5\u671F",
      "\u4FEE\u56DE\u65E5\u671F",
      "\u57FA\u91D1\u9879\u76EE",
      "\u6458\u8981",
      "Abstract",
      "abstract",
      "Keywords",
      "keywords",
      // 英文期刊关键词经常换行后直接接正文一级标题，需要在标题处截断
      "Introduction",
      "Materials and methods",
      "Results",
      "Discussion",
      "Conclusions",
      "References",
      "Acknowledgements",
      "\u5F15\u8A00",
      "\u6750\u6599\u4E0E\u65B9\u6CD5",
      "\u7ED3\u679C",
      "\u8BA8\u8BBA",
      "\u7ED3\u8BBA",
      "\u53C2\u8003\u6587\u732E",
      "\u81F4\u8C22"
    ];
    const compactedText = text.replace(/\s+/g, "");
    const isCjkChar = (ch) => ch.length > 0 && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
    const normalizeKeywordFragment = (s) => {
      let out = s.replace(
        /[\uFF01-\uFF5E]/g,
        (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)
      );
      const tokens = out.split(/\s+/);
      const merged = [];
      for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i];
        while (i + 1 < tokens.length) {
          const next = tokens[i + 1];
          const nextIsSingle = /^[A-Za-z0-9]$/.test(next);
          const tokenEndsAlnum = /[A-Za-z0-9]$/.test(token);
          const acronymPrefix = /^[A-Z]$/.test(token) && /^[A-Z0-9]/.test(next);
          if (nextIsSingle && tokenEndsAlnum || acronymPrefix) {
            token += next;
            i++;
            continue;
          }
          break;
        }
        merged.push(token);
      }
      return merged.join(" ").replace(/\s*-\s*/g, "-").replace(/(?<=[A-Za-z0-9])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g, "").replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[A-Za-z0-9])/g, "");
    };
    const isSingleEnglishKeywordLine = (line) => {
      const t = line.trim();
      if (!t || t.length > 60)
        return false;
      if (!/^[A-Za-z][A-Za-z0-9 .()\-–—×]*$/.test(t))
        return false;
      if (/(?:19|20)\d{2}/.test(t))
        return false;
      const compact = t.replace(/\s+/g, "").toLowerCase();
      return !stopMarkers.some((m) => m.replace(/\s+/g, "").toLowerCase() === compact);
    };
    const isKeywordContinuationLine = (line) => {
      const t = line.trim();
      if (!t)
        return false;
      if (/(?:19|20)\d{2}/.test(t))
        return false;
      if (/^[a-z]/.test(t))
        return true;
      if (/[。？！?!]/.test(t) || /\./.test(t))
        return false;
      const compactCjk = t.replace(
        /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
        ""
      );
      if (/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(compactCjk))
        return compactCjk.length <= 6;
      if (!/[；;，,、·•‧・]/.test(t))
        return false;
      const parts = t.split(/[；;，,、·•‧・]/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length < 2)
        return false;
      return Math.max(...parts.map((s) => s.length)) <= 15;
    };
    const extendKeywordContent = (source, match) => {
      let content = match[1].trim();
      const singleKeywordMode = !/[；;，,、·•‧・]/.test(content) && !/\s/.test(content) && /^[A-Za-z][A-Za-z0-9()\-]*$/.test(content);
      const rest = source.slice((match.index ?? 0) + match[0].length);
      const lines = rest.split("\n");
      const maxLines = singleKeywordMode ? 10 : 2;
      for (let i = 1; i <= maxLines && i < lines.length; i++) {
        const line = lines[i].trim();
        if (singleKeywordMode) {
          if (!isSingleEnglishKeywordLine(line))
            break;
          content += "\uFF1B" + line;
          continue;
        }
        if (!isKeywordContinuationLine(line))
          break;
        const firstSegment = line.split(/[；;，,、·•‧・]/)[0].trim();
        const existingKeywords = content.split(/[；;，,、·•‧・\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
        if (!/^[；;，,、·•‧・]/.test(line) && existingKeywords.some((k) => k.length > 0 && firstSegment.startsWith(k) && firstSegment.length > k.length)) {
          break;
        }
        const prev = content.charAt(content.length - 1);
        const next = line.charAt(0);
        content += isCjkChar(prev) && isCjkChar(next) ? line : "\n" + line;
      }
      return content;
    };
    const tryOnText = (source, pattern) => {
      const match = source.match(pattern);
      if (match && match[1].trim()) {
        let content = extendKeywordContent(source, match);
        const compactedContent = content.replace(/\s+/g, "");
        for (const marker of stopMarkers) {
          let idx = content.indexOf(marker);
          if (idx < 0) {
            idx = compactedContent.indexOf(marker);
            if (idx >= 0) {
              let nonWs = 0;
              let mapped = false;
              for (let c = 0; c < content.length; c++) {
                if (/\s/.test(content[c]))
                  continue;
                if (nonWs === idx) {
                  idx = c;
                  mapped = true;
                  break;
                }
                nonWs++;
              }
              if (!mapped)
                idx = -1;
            }
          }
          if (idx >= 0) {
            const lineStart = content.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
            content = content.substring(0, lineStart > 0 ? lineStart : idx).trim();
            break;
          }
        }
        return content;
      }
      return "";
    };
    const patterns = [
      /关[ \t\u3000]*键[ \t\u3000]*词\s*[：:∶]?\s*([^\n。]+)/,
      /关[ \t\u3000]*键[ \t\u3000]*字\s*[：:∶]?\s*([^\n。]+)/,
      /[Kk]ey\s*words?\s*[：:∶]?\s*([^\n。]+)/,
      /[Ii]ndex\s+[Tt]erms\s*[—–\-:：]?\s*([^\n。]+)/
    ];
    let keywordsStr = "";
    for (const pattern of patterns) {
      keywordsStr = tryOnText(text, pattern);
      if (keywordsStr)
        break;
      keywordsStr = tryOnText(compactedText, pattern);
      if (keywordsStr) {
        keywordsStr = keywordsStr.replace(/\s+/g, "");
        break;
      }
    }
    if (!keywordsStr)
      return [];
    keywordsStr = keywordsStr.replace(/[\uE000-\uF8FF]/g, "\uFF1B").replace(/\u00A0/g, " ").trim();
    if (!/[；;，,、·•‧・]/.test(keywordsStr) && /[ \t\u3000]{2,}/.test(keywordsStr)) {
      keywordsStr = keywordsStr.replace(/[ \t\u3000]{2,}/g, "\uFF1B").replace(
        /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000](?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
        ""
      );
    }
    let rawKeywords = keywordsStr.split(/[；;，,、·•‧・]/).map((k) => k.trim()).filter((k) => k.length > 0);
    const hasPunctuationSeparator = /[；;，,、·•‧・]/.test(keywordsStr);
    if (!hasPunctuationSeparator && rawKeywords.length <= 2) {
      const spaceSplit = keywordsStr.split(/\s+/).map((k) => k.trim()).filter((k) => k.length > 0);
      if (spaceSplit.length > rawKeywords.length) {
        rawKeywords = spaceSplit;
      }
    } else {
      rawKeywords = rawKeywords.map(
        (k) => k.replace(
          /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
          ""
        )
      );
    }
    const MAX_TAG_LENGTH = 40;
    const tags = rawKeywords.map((k) => {
      return normalizeKeywordFragment(k).replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    }).filter((k) => k.length > 0 && k.length <= MAX_TAG_LENGTH);
    return [...new Set(tags)];
  }
  // ========== 浮动批注按钮 ==========
  initFloatingButton() {
    this.floatingBtn = document.createElement("div");
    this.floatingBtn.className = "pdf-annotate-floating-btn";
    Object.assign(this.floatingBtn.style, {
      position: "fixed",
      zIndex: "9999",
      padding: "6px 14px",
      background: "var(--interactive-accent)",
      color: "var(--text-on-accent)",
      borderRadius: "6px",
      cursor: "pointer",
      fontSize: "13px",
      fontWeight: "500",
      boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
      display: "none",
      userSelect: "none",
      transition: "opacity 0.15s",
      whiteSpace: "nowrap"
    });
    const label = document.createElement("span");
    label.textContent = "\u6279\u6CE8\u5230\u7B14\u8BB0";
    this.floatingBtn.appendChild(label);
    const badge = document.createElement("sup");
    badge.style.marginLeft = "4px";
    badge.style.fontSize = "11px";
    badge.style.fontWeight = "700";
    badge.style.color = "var(--text-on-accent)";
    badge.style.display = "none";
    this.floatingBadge = badge;
    this.floatingBtn.appendChild(badge);
    document.body.appendChild(this.floatingBtn);
    this.ctx.plugin.registerDomEvent(this.floatingBtn, "click", () => {
      this.handleAnnotation();
      this.hideFloatingButton();
    });
    this.ctx.plugin.registerDomEvent(this.floatingBtn, "mouseenter", () => {
      if (this.floatingBtn)
        this.floatingBtn.style.opacity = "0.85";
    });
    this.ctx.plugin.registerDomEvent(this.floatingBtn, "mouseleave", () => {
      if (this.floatingBtn)
        this.floatingBtn.style.opacity = "1";
    });
  }
  removeFloatingButton() {
    this.stopFollowTimer();
    this.trackedRange = null;
    if (this.floatingBtn) {
      this.floatingBtn.remove();
      this.floatingBtn = null;
      this.floatingBadge = null;
    }
  }
  /** 显示浮动按钮并锚定到指定文字选区旁 */
  showFloatingButton(range) {
    if (!this.floatingBtn)
      return;
    if (!range) {
      this.hideFloatingButton();
      return;
    }
    this.trackedRange = range;
    this.floatingBtn.style.display = "block";
    if (this.floatingBadge) {
      if (this.savedSelections.length > 1) {
        this.floatingBadge.textContent = `${this.savedSelections.length}`;
        this.floatingBadge.style.display = "inline";
      } else {
        this.floatingBadge.style.display = "none";
      }
    }
    this.repositionFloatingButton();
    if (this.followTimerId === null) {
      this.followTimerId = window.setInterval(() => this.repositionFloatingButton(), 200);
    }
  }
  /**
   * 根据锚定选区的当前视口位置更新按钮坐标，
   * 使按钮在滚动/缩放/布局变化时持续跟着文字移动。
   * 视口可见性用「整段选区包围盒」判断：只要选区还有任何部分可见，
   * 按钮就保持显示（末行滚出视口时按钮会贴住可视区边缘，滚回后自动回到末行锚点）；
   * 整段选区滚出视口时仅隐藏按钮（保留选区，滚回自动重现）；
   * 选区节点全部失效（textLayer 重建）时才完整收起并清理。
   */
  repositionFloatingButton() {
    const btn = this.floatingBtn;
    if (!btn || !this.trackedRange)
      return;
    const anchor = this.getLastRowRect(this.trackedRange);
    const whole = this.getRangeViewportRect(this.trackedRange);
    const rect = anchor ?? whole;
    const probe = whole ?? anchor;
    if (!rect || !probe) {
      this.hideFloatingButton();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (probe.bottom <= 0 || probe.top >= vh || probe.right <= 0 || probe.left >= vw) {
      if (btn.style.display !== "none") {
        btn.style.display = "none";
      }
      return;
    }
    if (btn.style.display === "none") {
      btn.style.display = "block";
    }
    const btnW = btn.offsetWidth || 80;
    const btnH = btn.offsetHeight || 30;
    let left = rect.right - btnW / 2 + btnW / 4;
    left = Math.max(10, Math.min(left, vw - btnW - 10));
    let top = rect.top - btnH - 8;
    if (top < 10)
      top = Math.min(rect.bottom + 8, vh - btnH - 10);
    top = Math.max(10, Math.min(top, vh - btnH - 10));
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;
  }
  /** 按钮定位锚点：多行勾选取「最底行」包围盒；失败则退化为整段选区包围盒 */
  getSelectionAnchorRect(range) {
    return this.getLastRowRect(range) ?? this.getRangeViewportRect(range);
  }
  /**
   * 取选区几何上最靠下的一行文本的包围盒（按钮呈现于勾选内容的末行右上角）。
   * 先在有效行框中选 bottom 最大的行框作为参考，再把与它垂直重叠过半的
   * 行框并入同一行（兼容跨行内联元素、上下标等同一视觉行的碎片）；
   * 取不到有效行框时返回 null，由调用方走整选区兜底。
   *
   * 必须排除零宽矩形（width=0 的插入符边界伪影）：Chrome 会在选区终点
   * 恰落在某行/某页首个文本节点的行首时追加这种矩形（典型场景：拖选
   * 越过分栏或页尾，浏览器把选区终点吸附到下一页首行行首）。若不排除，
   * 这类矩形会参与行框竞选并污染锚点，导致按钮出现在下一页左上角
   * （视口上常表现为左下角）等错误位置。
   */
  getLastRowRect(range) {
    let valid = [];
    try {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width === 0 || r.height === 0)
          continue;
        valid.push(r);
      }
    } catch (e) {
      return null;
    }
    if (valid.length === 0)
      return null;
    let ref = valid[0];
    for (const r of valid) {
      if (r.bottom > ref.bottom)
        ref = r;
    }
    let left = ref.left;
    let top = ref.top;
    let right = ref.right;
    let bottom = ref.bottom;
    for (const r of valid) {
      if (!this.sameVisualRow(r, ref))
        continue;
      if (r.left < left)
        left = r.left;
      if (r.top < top)
        top = r.top;
      if (r.right > right)
        right = r.right;
      if (r.bottom > bottom)
        bottom = r.bottom;
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }
  /** 两个行框是否属于视觉上同一行（垂直方向重叠超过较矮者的半高） */
  sameVisualRow(a, b) {
    const overlapBottom = Math.min(a.bottom, b.bottom);
    const overlapTop = Math.max(a.top, b.top);
    const overlap = overlapBottom - overlapTop;
    if (overlap <= 0)
      return false;
    return overlap > 0.5 * Math.min(a.height, b.height);
  }
  /**
   * 取整个选区在当前视口中的包围盒（多行锚点失效时的兜底）。
   * 逐行矩形取并集可避免跨行选区被空白行框撑大；
   * 零宽插入符矩形一并排除（同 getLastRowRect），否则纯插入符选区
   * 会把按钮锚到插入符位置；选区已被移除（节点失效）等异常情况返回 null。
   */
  getRangeViewportRect(range) {
    try {
      const rects = range.getClientRects();
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width === 0 || r.height === 0)
          continue;
        if (r.left < left)
          left = r.left;
        if (r.top < top)
          top = r.top;
        if (r.right > right)
          right = r.right;
        if (r.bottom > bottom)
          bottom = r.bottom;
      }
      if (left !== Infinity) {
        return new DOMRect(left, top, right - left, bottom - top);
      }
      const bbox = range.getBoundingClientRect();
      if (bbox && (bbox.width > 0 || bbox.height > 0))
        return bbox;
      const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer?.parentElement ?? null;
      if (startEl) {
        const er = startEl.getBoundingClientRect();
        if (er.width > 0 || er.height > 0)
          return er;
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  stopFollowTimer() {
    if (this.followTimerId !== null) {
      window.clearInterval(this.followTimerId);
      this.followTimerId = null;
    }
  }
  /**
   * 清空浏览器原生文字选区（PDF 文本层上的紫色高亮）。
   *
   * 选区是「批注按钮存在」的视觉凭证，两者必须同生共死：
   *  - 只隐藏按钮而不清选区，pdf.js 文本框上的紫色高亮会一直留在页面上，
   *    看上去像批注没有生效；
   *  - 更关键的是 handlePdfMouseUp 的 150ms 延迟回调会读到仍然存在的选区，
   *    把刚清空的 savedSelections 又填回去并把按钮重新显示 —— 这是
   *    「点击『批注到笔记』后紫色区域和按钮都不消失」的直接原因。
   *
   * 放在隐藏按钮之前调用：先清选区，延迟回调走 isCollapsed 分支直接返回，
   * 按钮就不会被重新显示。
   */
  clearNativeSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0)
      return;
    const node = sel.anchorNode ?? sel.focusNode;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    if (!el?.closest(".textLayer"))
      return;
    sel.removeAllRanges();
  }
  hideFloatingButton() {
    const wasActive = this.trackedRange !== null || this.floatingBtn?.style.display === "block";
    if (wasActive)
      this.clearNativeSelection();
    this.stopFollowTimer();
    this.trackedRange = null;
    if (this.floatingBtn) {
      this.floatingBtn.style.display = "none";
    }
  }
  // ========== PDF 选区检测 ==========
  /**
   * 鼠标松开后延迟检测 PDF 选区，决定是否弹出「批注到笔记」按钮。
   *
   * 活动视图不是 PDF 时**在排定时器之前**就返回：这个回调挂在 document 上，
   * 用户在任何视图里松开鼠标都会进来（编辑 Markdown 笔记时尤其频繁），
   * 而选区与按钮都只属于 PDF 文本层，非 PDF 视图既不可能有选区也没有必要延迟 150ms。
   * 直接返回前的 `hideFloatingButton()` 保留了原来的语义（切走视图要收起按钮），
   * 它内部有 wasActive 保护，不会误清笔记自己的选区。
   */
  handlePdfMouseUp(evt) {
    const activeLeafNow = this.ctx.plugin.app.workspace.activeLeaf;
    if (!activeLeafNow || activeLeafNow.view.getViewType() !== "pdf") {
      this.hideFloatingButton();
      return;
    }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        this.hideFloatingButton();
        return;
      }
      const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
      if (!activeLeaf || activeLeaf.view.getViewType() !== "pdf") {
        this.hideFloatingButton();
        return;
      }
      const pdfFile = activeLeaf.view.file;
      if (!pdfFile) {
        this.hideFloatingButton();
        return;
      }
      if (this.currentPdfPath !== pdfFile.path) {
        this.savedSelections = [];
        this.currentPdfPath = pdfFile.path;
      }
      const text = sel.toString().trim();
      const selectionInfo = this.getPdfSelectionInfo();
      const entry = selectionInfo ? { text, ...selectionInfo } : { text, page: null, beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 0 };
      if (evt.ctrlKey || evt.metaKey) {
        this.savedSelections.push(entry);
      } else {
        this.savedSelections = [entry];
      }
      if (this.savedSelections.length > 0) {
        const range = sel.rangeCount > 0 ? sel.getRangeAt(sel.rangeCount - 1).cloneRange() : null;
        if (range) {
          this.showFloatingButton(range);
        }
      }
    }, 150);
  }
  getPdfSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0)
      return null;
    try {
      const range = sel.getRangeAt(0);
      const startPageDiv = this.findPageDiv(range.startContainer);
      const endPageDiv = this.findPageDiv(range.endContainer);
      if (!startPageDiv || !endPageDiv)
        return null;
      if (startPageDiv !== endPageDiv)
        return null;
      const startEl = startPageDiv;
      const endEl = endPageDiv;
      const pageNumber = parseInt(startEl.dataset.pageNumber || "1");
      const startTextLayer = startEl.querySelector(".textLayer");
      const endTextLayer = endEl === startEl ? startTextLayer : endEl.querySelector(".textLayer");
      const textSpans = startTextLayer?.querySelectorAll("span[data-idx]") ?? [];
      const startSpan = startTextLayer ? this.findParentTextSpan(range.startContainer, startTextLayer) : null;
      const endSpan = endTextLayer ? this.findParentTextSpan(range.endContainer, endTextLayer) : null;
      if (textSpans.length === 0 || !startSpan || !endSpan) {
        const fallbackRect = this.computeSelectionOcrRect(range, startPageDiv);
        return {
          page: pageNumber,
          beginIndex: -1,
          beginOffset: 0,
          endIndex: -1,
          endOffset: 0,
          ...fallbackRect ? { ocrRect: fallbackRect } : {}
        };
      }
      const textDivFirstIdx = parseInt(
        textSpans[0].getAttribute("data-idx") || "0"
      );
      const beginIndex = parseInt(startSpan.getAttribute("data-idx") || "0") - textDivFirstIdx;
      const endIndex = parseInt(endSpan.getAttribute("data-idx") || "0") - textDivFirstIdx;
      const beginOffset = this.computeOffsetInSpan(
        startSpan,
        range.startContainer,
        range.startOffset
      );
      const endOffset = this.computeOffsetInSpan(
        endSpan,
        range.endContainer,
        range.endOffset
      );
      return { page: pageNumber, beginIndex, beginOffset, endIndex, endOffset };
    } catch (e) {
      console.error("[PdfReader] \u83B7\u53D6PDF\u9009\u62E9\u4FE1\u606F\u5931\u8D25:", e);
      return null;
    }
  }
  /**
   * 计算无 data-idx 文本选区的归一化矩形（0-1，相对页面内边距框）。
   * 用于标题/图表标注等文本层锚点缺失时的矩形持久高亮。
   */
  computeSelectionOcrRect(range, pageDiv) {
    try {
      const rect = range.getBoundingClientRect();
      const pageRect = pageDiv.getBoundingClientRect();
      const ox = pageRect.left + pageDiv.clientLeft;
      const oy = pageRect.top + pageDiv.clientTop;
      const pw = pageDiv.clientWidth;
      const ph = pageDiv.clientHeight;
      if (!pw || !ph || !rect.width || !rect.height)
        return null;
      const clamp012 = (n) => Math.min(1, Math.max(0, n));
      return {
        x: clamp012((rect.left - ox) / pw),
        y: clamp012((rect.top - oy) / ph),
        w: clamp012(rect.width / pw),
        h: clamp012(rect.height / ph)
      };
    } catch (e) {
      console.warn("[PdfReader] \u8BA1\u7B97\u9009\u533A\u56DE\u9000\u77E9\u5F62\u5931\u8D25:", e);
      return null;
    }
  }
  /** 向上查找承载页码的页面容器（pdf.js 的 .page[data-page-number]） */
  findPageDiv(node) {
    let current = node;
    while (current && current !== document) {
      const el = current;
      if (el.dataset?.pageNumber !== void 0) {
        return el;
      }
      current = current.parentNode;
    }
    return null;
  }
  /** 向上查找选区端点所在的带 data-idx 的文本 span（文本锚点的最小单位） */
  findParentTextSpan(node, textLayer) {
    let current = node instanceof HTMLElement ? node : node.parentElement;
    while (current && current !== textLayer) {
      if (current.tagName === "SPAN" && current.hasAttribute("data-idx")) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  computeOffsetInSpan(span, container, offset) {
    if (container === span) {
      let totalOffset = 0;
      for (let i = 0; i < offset; i++) {
        const child = span.childNodes[i];
        totalOffset += child.textContent?.length || 0;
      }
      return totalOffset;
    }
    if (container.nodeType === Node.TEXT_NODE && container.parentElement === span) {
      return offset;
    }
    if (container.nodeType === Node.TEXT_NODE) {
      let current = container.parentElement;
      let totalOffset = offset;
      while (current && current !== span) {
        let sibling = current.previousSibling;
        while (sibling) {
          totalOffset += sibling.textContent?.length || 0;
          sibling = sibling.previousSibling;
        }
        current = current.parentElement;
      }
      return totalOffset;
    }
    return offset;
  }
  // ========== 批注写入笔记 ==========
  // ========== 截图 OCR 批注入口（供 pdf-ocr 插件调用） ==========
  /**
   * 把外部传入的文本（如截图 OCR 识别结果）作为批注写入当前 PDF 的阅读笔记。
   * 「附带原文」开启时写入“识别文字 + 页码/区域定位链接 + 笔记：”；
   * 关闭时只写入识别文字。
   * 无文本层锚点（beginIndex=-1）：链接仅带页码，不生成 selection 锚点。
   * ocrRect 提供时，「附带原文」开启下的链接附加 &ocr=x,y,w,h（归一化矩形），供 pdf-ocr 渲染持久高亮。
   * @returns 是否成功写入（笔记创建失败返回 false）
   */
  async annotateOcrText(pdfFile, text, page, ocrRect) {
    const target = this.getCursorNotePos();
    if (!target) {
      new import_obsidian.Notice("OCR \u6279\u6CE8\u5199\u5165\u5931\u8D25\uFF1A\u8BF7\u5148\u628A\u5149\u6807\u653E\u5230\u8981\u6279\u6CE8\u7684\u7B14\u8BB0\u91CC");
      return false;
    }
    const selections = [{
      text,
      page,
      beginIndex: -1,
      beginOffset: 0,
      endIndex: -1,
      endOffset: 0,
      ocrRect
    }];
    try {
      if (this.shouldIncludeOriginalText()) {
        await this.appendAnnotationsToNote(target.noteFile, selections, pdfFile);
      } else {
        await this.appendLinksOnly(target.noteFile, selections, pdfFile, true);
      }
      return true;
    } catch (e) {
      console.error("[PdfReader] OCR \u6279\u6CE8\u5199\u5165\u5931\u8D25:", e);
      new import_obsidian.Notice("OCR \u6279\u6CE8\u5199\u5165\u5931\u8D25");
      return false;
    }
  }
  /**
   * 把截图区域作为批注写入当前 PDF 的阅读笔记：
   * 不保存图片文件，插入 PDF 嵌入链接（![[file.pdf#page=N&rect=...]]），
   * 由 ScreenshotModule 注册的自定义 EmbedCreator 实时渲染裁剪区域。
   * @param rect PDF 空间坐标 [x1, y1, x2, y2]
   * @returns 是否成功写入
   */
  async annotateScreenshot(pdfFile, page, rect) {
    const target = this.getCursorNotePos();
    if (!target) {
      new import_obsidian.Notice("\u622A\u56FE\u6279\u6CE8\u5931\u8D25\uFF1A\u8BF7\u5148\u628A\u5149\u6807\u653E\u5230\u8981\u6279\u6CE8\u7684\u7B14\u8BB0\u91CC");
      return false;
    }
    const noteFile = target.noteFile;
    try {
      const rectStr = rect.join(",");
      const embedLink = `![[${pdfFile.path}#page=${page}&rect=${rectStr}]]`;
      if (!this.shouldIncludeOriginalText()) {
        const newline = String.fromCharCode(10);
        const start = target.editor.posToOffset({ line: target.line, ch: target.ch });
        const inserted = newline + embedLink + newline;
        target.editor.replaceRange(inserted, { line: target.line, ch: target.ch });
        target.editor.setCursor(target.editor.offsetToPos(start + inserted.length));
        this.focusNoteLeaf(noteFile);
        return true;
      }
      const pageLink = `[[${pdfFile.path}#page=${page}&rect=${rectStr}|${this.linkLabel}]]`;
      const prompt = this.notePrompt;
      const block = `> [!pdf-annotation]
> ${embedLink}
> ${pageLink}
${prompt}`;
      const annotation = "\n" + block + "\n";
      target.editor.replaceRange(annotation, { line: target.line, ch: target.ch });
      const promptLine = target.line + annotation.split("\n").length - 2;
      await this.focusNotePrompt(noteFile, prompt, promptLine);
      return true;
    } catch (e) {
      console.error("[PdfReader] \u622A\u56FE\u6279\u6CE8\u5199\u5165\u5931\u8D25:", e);
      new import_obsidian.Notice("\u622A\u56FE\u6279\u6CE8\u5199\u5165\u5931\u8D25");
      return false;
    }
  }
  async handleAnnotation() {
    if (this.savedSelections.length === 0)
      return;
    const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
    if (!activeLeaf || activeLeaf.view.getViewType() !== "pdf")
      return;
    const pdfFile = activeLeaf.view.file;
    if (!pdfFile)
      return;
    const selections = [...this.savedSelections];
    this.savedSelections = [];
    const target = this.getCursorNotePos();
    if (!target) {
      this.savedSelections = selections;
      new import_obsidian.Notice("\u6279\u6CE8\u5931\u8D25\uFF1A\u8BF7\u5148\u628A\u5149\u6807\u653E\u5230\u8981\u6279\u6CE8\u7684\u7B14\u8BB0\u91CC\uFF08\u53F3\u952E PDF \u2192\u300C\u5F00\u59CB\u9605\u8BFB\u300D\u53EF\u6253\u5F00\u5BF9\u5E94\u7B14\u8BB0\uFF09");
      return;
    }
    try {
      await this.appendAnnotationsToNote(target.noteFile, selections, pdfFile, this.shouldIncludeOriginalText());
      this.refreshHighlights?.(
        pdfFile,
        selections.filter((sel) => sel.beginIndex >= 0)
      );
      this.refreshRectHighlights?.(
        pdfFile,
        // 一次遍历同时完成「过滤无文本锚点且有归一化矩形」与「取字段」：
        // 让 sel.page / sel.ocrRect 在类型上收窄为必填（语义与原来 filter + map 完全一致）
        selections.flatMap((sel) => {
          const rect = sel.ocrRect;
          if (sel.beginIndex >= 0 || !rect || sel.page === null)
            return [];
          return [{ page: sel.page, rect }];
        })
      );
    } catch (e) {
      this.savedSelections = [...selections, ...this.savedSelections];
      console.error("[PdfReader] \u6279\u6CE8\u5199\u5165\u5931\u8D25\uFF0C\u9009\u533A\u5DF2\u6062\u590D:", e);
    }
  }
  /** 当前文字批注是否附带原文（工具栏「附带原文」关闭时不附带，只写链接） */
  shouldIncludeOriginalText() {
    if (this.includeOriginalTextProvider != null)
      return this.includeOriginalTextProvider();
    return this.ctx.getSettings().annotationIncludeOriginalText === true;
  }
  async appendAnnotationsToNote(noteFile, selections, pdfFile, includeOriginalText = true) {
    if (!includeOriginalText) {
      await this.appendLinksOnly(noteFile, selections, pdfFile);
      return;
    }
    const notePrompt = this.notePrompt;
    const items = selections.map((sel) => {
      const flatText = sel.text.replace(
        /[\r\n\u000B\u000C\u2028\u2029\u21B5\u23CE\u240D\u2424\u2937\u0000-\u0008\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g,
        ""
      );
      if (sel.page === null) {
        return `> ${flatText}`;
      }
      if (sel.beginIndex < 0) {
        const rectParam = sel.ocrRect ? `&ocr=${fmtRectNum(sel.ocrRect.x)},${fmtRectNum(sel.ocrRect.y)},${fmtRectNum(sel.ocrRect.w)},${fmtRectNum(sel.ocrRect.h)}` : "";
        const link2 = `[[${pdfFile.path}#page=${sel.page}${rectParam}|${this.linkLabel}]]`;
        return `> ${flatText}
> ${link2}`;
      }
      const selectionParam = `${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
      const link = `[[${pdfFile.path}#page=${sel.page}&selection=${selectionParam}|${this.linkLabel}]]`;
      return `> ${flatText}
> ${link}`;
    });
    if (selections.some((sel) => sel.page === null)) {
      console.warn("[PdfReader] \u90E8\u5206\u9009\u533A\u5B9A\u4F4D\u5931\u8D25\uFF0C\u6279\u6CE8\u672A\u9644\u539F\u6587\u94FE\u63A5");
    }
    const block = `> [!pdf-annotation]
${items.join("\n> \n")}
${notePrompt}`;
    const annotation = "\n" + block + "\n";
    const cursorPos = this.getNoteCursorEditorPos(noteFile);
    if (!cursorPos)
      throw new Error("\u6279\u6CE8\u76EE\u6807\u7B14\u8BB0\u6CA1\u6709\u53EF\u7528\u7684\u7F16\u8F91\u5668");
    cursorPos.editor.replaceRange(annotation, {
      line: cursorPos.line,
      ch: cursorPos.ch
    });
    const promptLine = cursorPos.line + annotation.split("\n").length - 2;
    await this.focusNotePrompt(noteFile, notePrompt, promptLine);
  }
  /**
   * 「附带原文」关闭时的批注形式：
   * 只写 PDF 链接，并把光标停在链接后，让用户直接按“定位 我打字的内容”的正序记录。
   * 多重批注时所有「定位」按钮在同一行排列，如“定位 定位 定位”。
   * 不再使用旧版“在链接上方留空行、笔记写在链接上方”的逆序机制。
   * OCR 批注传入 ocrTextOnly=true 时只写识别文字、不写定位链接。
   * 定位失败（page=null）的选区无链接可写，保留拍平文字行兜底，避免批注静默丢失。
   */
  async appendLinksOnly(noteFile, selections, pdfFile, ocrTextOnly = false) {
    const flatten = (text) => text.replace(
      /[\r\n\u000B\u000C\u2028\u2029\u21B5\u23CE\u240D\u2424\u2937\u0000-\u0008\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g,
      ""
    );
    const lines = selections.map((sel) => {
      if (sel.page === null) {
        return flatten(sel.text);
      }
      if (sel.beginIndex < 0) {
        if (ocrTextOnly)
          return flatten(sel.text);
        const rectParam = sel.ocrRect ? `&ocr=${fmtRectNum(sel.ocrRect.x)},${fmtRectNum(sel.ocrRect.y)},${fmtRectNum(sel.ocrRect.w)},${fmtRectNum(sel.ocrRect.h)}` : "";
        return `[[${pdfFile.path}#page=${sel.page}${rectParam}|${this.linkLabel}]]`;
      }
      const selectionParam = `${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
      return `[[${pdfFile.path}#page=${sel.page}&selection=${selectionParam}|${this.linkLabel}]]`;
    });
    if (lines.length === 0)
      return;
    const cursorPos = this.getNoteCursorEditorPos(noteFile);
    if (!cursorPos)
      throw new Error("\u6279\u6CE8\u76EE\u6807\u7B14\u8BB0\u6CA1\u6709\u53EF\u7528\u7684\u7F16\u8F91\u5668");
    const editor = cursorPos.editor;
    const startLine = cursorPos.line;
    const startCh = cursorPos.ch;
    const content = lines.join(" ");
    if (ocrTextOnly) {
      const newline = String.fromCharCode(10);
      const inserted = newline + content + newline;
      const start = editor.posToOffset({ line: startLine, ch: startCh });
      editor.replaceRange(inserted, { line: startLine, ch: startCh });
      editor.setCursor(editor.offsetToPos(start + inserted.length));
    } else {
      const inserted = content + " ";
      editor.replaceRange(inserted, { line: startLine, ch: startCh });
      editor.setCursor({ line: startLine, ch: startCh + inserted.length });
    }
    this.focusNoteLeaf(noteFile);
  }
  /** 找到承载指定笔记的 Markdown 叶子（与当前焦点无关：笔记在后台标签页时也能找到） */
  findNoteLeaf(noteFile) {
    let targetLeaf = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof import_obsidian.MarkdownView && leaf.view.file?.path === noteFile.path) {
        targetLeaf = leaf;
      }
    });
    return targetLeaf;
  }
  /**
   * 激活笔记叶子（后台标签页切到前台）。
   * 绝不抛出：聚焦失败不得让调用方误判为批注写入失败（如叶子位于独立窗口时 setActiveLeaf 可能抛错）。
   * @returns 成功激活的叶子；未找到或激活失败返回 null
   */
  activateNoteLeaf(noteFile) {
    const leaf = this.findNoteLeaf(noteFile);
    if (!leaf)
      return null;
    try {
      this.ctx.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
      return leaf;
    } catch (e) {
      console.warn("[PdfReader] \u6FC0\u6D3B\u6279\u6CE8\u76EE\u6807\u7B14\u8BB0\u5931\u8D25:", e);
      return null;
    }
  }
  /**
   * 批注写入后把焦点移到被批注的笔记，让用户直接继续输入（关附带原文时只写链接，光标已停在链接后）。
   * 只激活已打开的叶子，不新建分屏：批注经编辑器缓冲写入，该笔记的叶子必定已存在。
   * @returns 是否成功聚焦
   */
  focusNoteLeaf(noteFile) {
    const leaf = this.activateNoteLeaf(noteFile);
    if (!leaf)
      return false;
    const view = leaf.view;
    if (view instanceof import_obsidian.MarkdownView)
      this.focusNoteEditor(view);
    return true;
  }
  /** 把键盘焦点交给笔记编辑器；绝不抛出（阅读模式无编辑器、视图未就绪时静默跳过） */
  focusNoteEditor(view) {
    try {
      view.editor?.focus?.();
    } catch (e) {
      console.warn("[PdfReader] \u805A\u7126\u6279\u6CE8\u76EE\u6807\u7B14\u8BB0\u7F16\u8F91\u5668\u5931\u8D25:", e);
    }
  }
  /**
   * 聚焦笔记中刚写入批注的提示行（如「> 笔记：」）。
   * @param exactLine 提示行的精确行号（replaceRange 后缓冲已同步）。
   * 批注必定经编辑器缓冲写入（落点已在入口校验），已无「写文件末尾」的追加路径。
   * 精确行定位避免了旧实现的缺陷：从文末向上找「最后一个」提示行，
   * 当批注插入在文件中部时会把光标带到文档末尾的旧批注上，导致后续输入写错位置。
   */
  async focusNotePrompt(noteFile, prompt, exactLine = null) {
    const leaf = this.activateNoteLeaf(noteFile);
    if (!leaf)
      return;
    const view = leaf.view;
    if (!(view instanceof import_obsidian.MarkdownView))
      return;
    const editor = view.editor;
    if (!editor)
      return;
    this.focusNoteEditor(view);
    if (exactLine !== null && exactLine >= 0 && exactLine <= editor.lastLine()) {
      const text = editor.getLine(exactLine);
      if (text.includes(prompt)) {
        editor.setCursor({ line: exactLine, ch: text.length });
        return;
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const lastLine = editor.lastLine();
      for (let line = lastLine; line >= 0; line--) {
        const text = editor.getLine(line);
        if (text.includes(prompt)) {
          editor.setCursor({ line, ch: text.length });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  /**
   * 获取笔记编辑器中光标位置；仅在编辑器可用（source 模式）时返回。
   * 返回 null 表示无编辑器，调用方应回退为文末追加。
   *
   * 遍历所有叶子查找该笔记并读取其光标，**与当前焦点无关**：
   * 焦点在 PDF 上时也能拿到笔记缓冲里的光标位置（快速添加标签工具条入口依赖此特性）。
   */
  /** 记录当前获得焦点的笔记（阅读模式没有编辑器，不记录） */
  trackActiveNote() {
    const view = this.ctx.plugin.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (view?.editor && view.file) {
      const file = view.file;
      if (this.isAnnotationTargetExcluded(file))
        return;
      const entry = {
        editor: view.editor,
        file,
        containerEl: view.containerEl
      };
      this.lastNotePath = file.path;
      this.lastNoteEditor = entry;
      const rest = this.recentNoteTargets.filter((item) => item.file.path !== file.path);
      rest.unshift(entry);
      this.recentNoteTargets = rest.slice(0, 10);
    }
  }
  isAnnotationTargetExcluded(file) {
    if (this.annotationTargetExclusionProvider == null)
      return false;
    try {
      return this.annotationTargetExclusionProvider(file) === true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }
  /**
   * 光标所在的笔记与位置 —— 批注 / 截图 / OCR / 标签统一的落点。
   *
   * 语义是「我刚才在写的那篇笔记」，与当前焦点无关（焦点通常在 PDF 上）。
   * 编辑器失焦后仍保留光标，所以这就是用户最后停留的位置。
   * @returns 没打开笔记、或该笔记处于阅读模式时返回 null；调用方必须提示用户，不得静默改写到别处
   */
  getCursorNotePos() {
    const primaryPath = this.lastNotePath;
    const primaryFile = primaryPath ? this.ctx.plugin.app.vault.getAbstractFileByPath(primaryPath) : null;
    if (primaryFile instanceof import_obsidian.TFile && this.isAnnotationTargetExcluded(primaryFile) === false) {
      const pos = this.getCursorPosForTarget(primaryFile);
      return pos ? { noteFile: primaryFile, ...pos } : null;
    }
    for (const entry of this.recentNoteTargets) {
      if (this.isAnnotationTargetExcluded(entry.file))
        continue;
      const file = this.ctx.plugin.app.vault.getAbstractFileByPath(entry.file.path);
      if (file instanceof import_obsidian.TFile) {
        const pos = this.getCursorPosForTarget(file, entry);
        if (pos)
          return { noteFile: file, ...pos };
      }
    }
    return null;
  }
  getCursorPosForTarget(file, cachedEntry) {
    const pos = this.getNoteCursorEditorPos(file);
    if (pos)
      return pos;
    const fallback = cachedEntry ?? this.recentNoteTargets.find((item) => item.file.path === file.path) ?? (this.lastNoteEditor?.file.path === file.path ? this.lastNoteEditor : null);
    if (fallback?.containerEl.isConnected) {
      try {
        const cursor = fallback.editor.getCursor();
        return { editor: fallback.editor, line: cursor.line, ch: cursor.ch };
      } catch (e) {
        console.warn(e);
      }
    }
    return null;
  }
  getNoteCursorEditorPos(noteFile) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result !== null)
        return;
      if (leaf.view instanceof import_obsidian.MarkdownView && leaf.view.file?.path === noteFile.path) {
        const editor = leaf.view.editor;
        if (!editor)
          return;
        const cursor = editor.getCursor();
        result = { editor, line: cursor.line, ch: cursor.ch };
      }
    });
    return result;
  }
};
function fmtRectNum(n) {
  return Number(n.toFixed(4)).toString();
}

// modules/MarkdownReadingModule.ts
var import_obsidian3 = require("obsidian");
var import_view = require("@codemirror/view");

// modules/MarkdownAnnotationSync.ts
var import_obsidian2 = require("obsidian");
var CONTEXT_BEFORE = 100;
var CONTEXT_AFTER = 160;
var MarkdownAnnotationSync = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.syncTimers = /* @__PURE__ */ new Map();
    this.syncingTargets = /* @__PURE__ */ new Set();
    this.initialSyncTimer = null;
  }
  /** 批注创建成功后登记配对记录 */
  record(sourceFile, targetFile, link, linkStartOffset, highlight, targetEditor) {
    const content = targetEditor.getValue();
    const linkEnd = linkStartOffset + link.length;
    const innerLink = link.replace(/^\[\[/, "").replace(/\]\]$/, "");
    const pipeIndex = innerLink.indexOf("|");
    const rawTarget = pipeIndex >= 0 ? innerLink.slice(0, pipeIndex) : innerLink;
    const rawLabel = pipeIndex >= 0 ? innerLink.slice(pipeIndex + 1) : "";
    const parsedTarget = (0, import_obsidian2.parseLinktext)(rawTarget);
    const record = {
      id: newMarkdownAnnotationId(),
      targetPath: targetFile.path,
      sourcePath: sourceFile.path,
      linkText: link,
      sourceSubpath: parsedTarget.subpath,
      linkLabel: rawLabel || this.ctx.getSettings().annotationLinkLabel,
      targetBefore: content.slice(Math.max(0, linkStartOffset - CONTEXT_BEFORE), linkStartOffset),
      targetAfter: content.slice(linkEnd, Math.min(content.length, linkEnd + CONTEXT_AFTER)),
      highlightText: highlight.innerText,
      sourceStartOffset: highlight.startOffset,
      createdAt: Date.now()
    };
    this.getRecords().push(record);
    void this.saveSafely();
  }
  /**
   * 是否存在指向给定来源（路径 + 子路径）的配对记录。
   *
   * 这是判断「点击的链接是否本插件生成的『定位』链接」的**唯一**判据
   * （见 `MarkdownReadingModule.takeOverLocatorClick`）：只有登记过的链接才接管导航，
   * 用户手写的同名链接、以及没有配对记录的旧链接都保持 Obsidian 原生行为。
   */
  hasRecordForSource(targetPath, sourcePath, subpath) {
    if (targetPath.length === 0 || sourcePath.length === 0)
      return false;
    return this.getRecords().some(
      (record) => record.targetPath === targetPath && record.sourcePath === sourcePath && record.sourceSubpath === subpath
    );
  }
  /**
   * 找到「定位」链接对应的配对记录。
   *
   * 同一链接文本可能在目标笔记里出现多次（同一处批注被重复插入链接），
   * 因此用「第几次出现」（occurrenceIndex，从 0 起）+ 记录里登记的前后文上下文
   * 把记录与出现位置一一配对；无法配对时退回该链接文本的第一条记录。
   */
  resolveRecordForLink(targetPath, linkText, occurrenceIndex, targetContent) {
    const records = this.getRecords().filter(
      (record) => record.targetPath === targetPath && record.linkText === linkText
    );
    if (records.length === 0)
      return null;
    if (records.length === 1 || targetContent == null || occurrenceIndex < 0)
      return records[0];
    const occurrences = this.findLinkOccurrences(targetContent, linkText);
    if (occurrenceIndex >= occurrences.length)
      return records[0];
    const { matched, removed } = this.matchRecordsToOccurrences(records, occurrences);
    const hit = matched.find((pair) => pair.occurrence === occurrences[occurrenceIndex]);
    return hit?.record ?? removed[0] ?? records[0];
  }
  /**
   * 在来源笔记内容中定位配对记录对应的 `==…==` 范围（含两侧 `==`）。
   * 点击「定位」链接时用它把「只指向标题的链接」还原成真正被批注的那段文字。
   */
  locateHighlightRange(content, record) {
    return this.findWrappedRange(content, record);
  }
  handleRename(file, oldPath) {
    if (file instanceof import_obsidian2.TFile === false || file.extension !== "md")
      return;
    const app = this.ctx.plugin.app;
    let changed = false;
    for (const record of this.getRecords()) {
      const targetChanged = record.targetPath === oldPath;
      const sourceChanged = record.sourcePath === oldPath;
      if (targetChanged) {
        record.targetPath = file.path;
        changed = true;
      }
      if (sourceChanged) {
        record.sourcePath = file.path;
        changed = true;
        const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
        if (sourceFile instanceof import_obsidian2.TFile && sourceFile.extension === "md") {
          record.linkText = app.fileManager.generateMarkdownLink(
            sourceFile,
            record.targetPath,
            record.sourceSubpath || void 0,
            record.linkLabel || void 0
          );
        }
      }
    }
    if (changed)
      void this.saveSafely();
  }
  handleDelete(file) {
    if (file instanceof import_obsidian2.TFile === false || file.extension !== "md")
      return;
    const sourceRecordIds = /* @__PURE__ */ new Set();
    let hasTargetRecord = false;
    for (const record of this.getRecords()) {
      if (record.sourcePath === file.path)
        sourceRecordIds.add(record.id);
      if (record.targetPath === file.path)
        hasTargetRecord = true;
    }
    if (sourceRecordIds.size > 0) {
      this.deleteRecords(sourceRecordIds);
      void this.saveSafely();
    }
    if (hasTargetRecord)
      this.schedule(file.path);
  }
  schedule(targetPath) {
    const existing = this.syncTimers.get(targetPath);
    if (existing != null)
      window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.syncTimers.delete(targetPath);
      void this.syncTarget(targetPath);
    }, 300);
    this.syncTimers.set(targetPath, timer);
  }
  startInitialSync(delay = 800) {
    if (this.initialSyncTimer != null)
      window.clearTimeout(this.initialSyncTimer);
    this.initialSyncTimer = window.setTimeout(() => {
      this.initialSyncTimer = null;
      void this.syncAll();
    }, delay);
  }
  unload() {
    if (this.initialSyncTimer != null) {
      window.clearTimeout(this.initialSyncTimer);
      this.initialSyncTimer = null;
    }
    for (const timer of this.syncTimers.values())
      window.clearTimeout(timer);
    this.syncTimers.clear();
    this.syncingTargets.clear();
  }
  async syncAll() {
    const targets = new Set(this.getRecords().map((record) => record.targetPath));
    for (const targetPath of targets) {
      await this.syncTarget(targetPath);
    }
  }
  /**
   * 读取目标笔记当前内容，并与配对记录中的链接做匹配。
   * 匹配不到链接的记录视为“链接已被删除”，随后撤销来源笔记中的高亮。
   */
  async syncTarget(targetPath) {
    if (this.syncingTargets.has(targetPath))
      return;
    this.syncingTargets.add(targetPath);
    try {
      const targetRecords = this.getRecords().filter((record) => record.targetPath === targetPath);
      if (targetRecords.length === 0)
        return;
      const app = this.ctx.plugin.app;
      const file = app.vault.getAbstractFileByPath(targetPath);
      let content = null;
      if (file instanceof import_obsidian2.TFile && file.extension === "md") {
        content = await this.readMarkdownContent(file);
      }
      if (content == null) {
        if (file instanceof import_obsidian2.TFile)
          return;
        await this.removeSourceHighlights(targetRecords);
        this.deleteRecords(new Set(targetRecords.map((record) => record.id)));
        await this.saveSafely();
        return;
      }
      const groups = /* @__PURE__ */ new Map();
      for (const record of targetRecords) {
        const group = groups.get(record.linkText) ?? [];
        group.push(record);
        groups.set(record.linkText, group);
      }
      const removed = [];
      let changed = false;
      for (const [linkText, group] of groups) {
        const occurrences = this.findLinkOccurrences(content, linkText);
        const result = this.matchRecordsToOccurrences(group, occurrences);
        for (const { record, occurrence } of result.matched) {
          if (record.targetBefore !== occurrence.before || record.targetAfter !== occurrence.after) {
            record.targetBefore = occurrence.before;
            record.targetAfter = occurrence.after;
            changed = true;
          }
        }
        removed.push(...result.removed);
      }
      if (removed.length > 0) {
        await this.removeSourceHighlights(removed);
        this.deleteRecords(new Set(removed.map((record) => record.id)));
        changed = true;
      }
      if (changed)
        await this.saveSafely();
    } catch (e) {
      console.warn("[MarkdownAnnotationSync] \u540C\u6B65 Markdown \u6279\u6CE8\u9AD8\u4EAE\u5931\u8D25:", e);
    } finally {
      this.syncingTargets.delete(targetPath);
    }
  }
  async readMarkdownContent(file) {
    try {
      if (this.ctx.readNoteContent != null) {
        return await this.ctx.readNoteContent(file, { editorMode: "source" });
      }
      return await this.ctx.plugin.app.vault.cachedRead(file);
    } catch (e) {
      console.warn("[MarkdownAnnotationSync] \u8BFB\u53D6\u6279\u6CE8\u76EE\u6807\u7B14\u8BB0\u5931\u8D25:", e);
      return null;
    }
  }
  findLinkOccurrences(content, linkText) {
    const result = [];
    if (linkText.length === 0)
      return result;
    let index = content.indexOf(linkText);
    while (index !== -1) {
      const end = index + linkText.length;
      result.push({
        start: index,
        end,
        before: content.slice(Math.max(0, index - CONTEXT_BEFORE), index),
        after: content.slice(end, Math.min(content.length, end + CONTEXT_AFTER))
      });
      index = content.indexOf(linkText, end);
    }
    return result;
  }
  matchRecordsToOccurrences(records, occurrences) {
    const pairs = [];
    for (const record of records) {
      for (let i = 0; i < occurrences.length; i++) {
        pairs.push({
          record,
          occurrence: occurrences[i],
          occurrenceIndex: i,
          score: this.contextMatchScore(record, occurrences[i])
        });
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.record.createdAt - b.record.createdAt);
    const usedOccurrences = /* @__PURE__ */ new Set();
    const matchedRecords = /* @__PURE__ */ new Set();
    const matched = [];
    for (const pair of pairs) {
      if (usedOccurrences.has(pair.occurrenceIndex) || matchedRecords.has(pair.record))
        continue;
      usedOccurrences.add(pair.occurrenceIndex);
      matchedRecords.add(pair.record);
      matched.push({ record: pair.record, occurrence: pair.occurrence });
    }
    return {
      matched,
      removed: records.filter((record) => matchedRecords.has(record) === false)
    };
  }
  contextMatchScore(record, occurrence) {
    let score = this.commonSuffixLength(record.targetBefore, occurrence.before) + this.commonPrefixLength(record.targetAfter, occurrence.after);
    if (record.targetBefore.length > 0 && occurrence.before.endsWith(record.targetBefore))
      score += 1e4;
    if (record.targetAfter.length > 0 && occurrence.after.startsWith(record.targetAfter))
      score += 1e4;
    return score;
  }
  commonSuffixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let count = 0;
    while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count])
      count++;
    return count;
  }
  commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let count = 0;
    while (count < max && a[count] === b[count])
      count++;
    return count;
  }
  getRecords() {
    const settings = this.ctx.getSettings();
    if (!Array.isArray(settings.markdownAnnotationRecords)) {
      settings.markdownAnnotationRecords = [];
    }
    return settings.markdownAnnotationRecords;
  }
  deleteRecords(ids) {
    if (ids.size === 0)
      return;
    const records = this.getRecords();
    this.ctx.getSettings().markdownAnnotationRecords = records.filter((record) => ids.has(record.id) === false);
  }
  async removeSourceHighlights(records) {
    for (const record of records) {
      await this.removeSourceHighlight(record);
    }
  }
  async removeSourceHighlight(record) {
    const app = this.ctx.plugin.app;
    const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
    if (sourceFile instanceof import_obsidian2.TFile === false || sourceFile.extension !== "md")
      return;
    const editor = this.findMarkdownEditor(sourceFile);
    if (editor != null) {
      const content = editor.getValue();
      const range = this.findWrappedRange(content, record);
      if (range == null)
        return;
      const inner = content.slice(range.start + 2, range.end - 2);
      editor.replaceRange(inner, editor.offsetToPos(range.start), editor.offsetToPos(range.end));
      return;
    }
    try {
      await app.vault.process(sourceFile, (data) => {
        const range = this.findWrappedRange(data, record);
        if (range == null)
          return data;
        return data.slice(0, range.start) + data.slice(range.start + 2, range.end - 2) + data.slice(range.end);
      });
    } catch (e) {
      console.warn("[MarkdownAnnotationSync] \u64A4\u9500\u6765\u6E90\u9AD8\u4EAE\u5931\u8D25:", e);
    }
  }
  findMarkdownEditor(file) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result != null)
        return;
      if (leaf.view instanceof import_obsidian2.MarkdownView && leaf.view.file?.path === file.path) {
        const editor = leaf.view.editor;
        if (editor != null)
          result = editor;
      }
    });
    return result;
  }
  /** 在来源内容中定位 `==...==`。优先按当时记录的原文精确匹配，内容变动后按偏移就近兜底。 */
  findWrappedRange(content, record) {
    const wrapped = "==" + record.highlightText + "==";
    let exactStart = -1;
    let search = content.indexOf(wrapped);
    while (search !== -1) {
      if (exactStart === -1 || Math.abs(search - record.sourceStartOffset) < Math.abs(exactStart - record.sourceStartOffset)) {
        exactStart = search;
      }
      search = content.indexOf(wrapped, search + wrapped.length);
    }
    if (exactStart !== -1)
      return { start: exactStart, end: exactStart + wrapped.length };
    const expected = record.sourceStartOffset;
    if (expected >= 0 && content.startsWith("==", expected)) {
      const close = content.indexOf("==", expected + 2);
      if (close !== -1)
        return { start: expected, end: close + 2 };
    }
    const searchStart = Math.max(0, expected - 200);
    const searchEnd = Math.min(content.length, expected + Math.max(record.highlightText.length, 20) + 400);
    let best = null;
    let index = content.indexOf("==", searchStart);
    while (index !== -1 && index < searchEnd) {
      const close = content.indexOf("==", index + 2);
      if (close !== -1 && this.isRelatedHighlight(content.slice(index + 2, close), record.highlightText)) {
        const candidate = { start: index, end: close + 2 };
        if (best == null || Math.abs(candidate.start - expected) < Math.abs(best.start - expected)) {
          best = candidate;
        }
      }
      index = content.indexOf("==", index + 2);
    }
    return best;
  }
  /** 仅当附近 `==...==` 的内部文字与记录原文明显相关时，才允许按偏移兜底删除。 */
  isRelatedHighlight(candidate, original) {
    if (candidate.length === 0 || original.length === 0)
      return false;
    if (candidate.includes(original) || original.includes(candidate))
      return true;
    const minLength = Math.min(candidate.length, original.length);
    return this.commonPrefixLength(candidate, original) >= Math.min(8, Math.ceil(minLength * 0.6));
  }
  async saveSafely() {
    try {
      await this.ctx.saveSettings();
    } catch (e) {
      console.error("[MarkdownAnnotationSync] \u4FDD\u5B58 Markdown \u6279\u6CE8\u914D\u5BF9\u8BB0\u5F55\u5931\u8D25:", e);
    }
  }
};
function newMarkdownAnnotationId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// modules/linkLocator.ts
function stripLinkDecorations(linktext) {
  return linktext.replace(/^\[\[/, "").replace(/\]\]$/, "");
}
function extractLinkLabel(linktext) {
  const clean = stripLinkDecorations(linktext);
  const pipe = clean.indexOf("|");
  return pipe >= 0 ? clean.slice(pipe + 1).trim() : "";
}
function collectRawLinks(content, href) {
  const result = [];
  if (href.length === 0)
    return result;
  const needle = "[[" + href;
  let index = content.indexOf(needle);
  while (index !== -1) {
    const close = content.indexOf("]]", index + 2);
    if (close === -1)
      break;
    result.push({ text: content.slice(index, close + 2), start: index, end: close + 2 });
    index = content.indexOf(needle, close + 2);
  }
  return result;
}
function pickClickedLink(content, info) {
  const links = collectRawLinks(content, info.href);
  if (links.length === 0)
    return null;
  let hit = null;
  if (info.clickOffset != null) {
    const offset = info.clickOffset;
    hit = links.find((link) => offset >= link.start && offset <= link.end) ?? null;
  } else if (info.occurrence >= 0 && info.occurrence < links.length) {
    hit = links[info.occurrence];
  }
  if (hit == null)
    return null;
  let sameTextIndex = 0;
  for (const link of links) {
    if (link === hit)
      break;
    if (link.text === hit.text)
      sameTextIndex++;
  }
  return { text: hit.text, sameTextIndex };
}
function countHighlightPairsBefore(content, offset) {
  let count = 0;
  let index = content.indexOf("==");
  while (index !== -1 && index < offset) {
    const close = content.indexOf("==", index + 2);
    if (close === -1)
      break;
    count++;
    index = content.indexOf("==", close + 2);
  }
  return count;
}
function findLinkAtColumn(lineText, ch) {
  let index = lineText.indexOf("[[");
  while (index !== -1) {
    const close = lineText.indexOf("]]", index + 2);
    if (close === -1)
      break;
    const end = close + 2;
    if (ch >= index && ch <= end)
      return { text: lineText.slice(index, end), start: index, end };
    index = lineText.indexOf("[[", end);
  }
  return null;
}
function normalizeHighlightText(text) {
  return text.replace(/[*_`~]/g, "").replace(/\s+/g, "");
}
function countPrecedingSameLinks(container, anchor, href) {
  if (container == null || href.length === 0)
    return -1;
  let count = 0;
  for (const candidate of Array.from(container.querySelectorAll("a.internal-link"))) {
    if (candidate === anchor)
      return count;
    const candidateHref = candidate.getAttribute("data-href") ?? candidate.getAttribute("href") ?? "";
    if (candidateHref === href)
      count++;
  }
  return -1;
}

// modules/MarkdownReadingModule.ts
var NOTE_FLASH_MARK_CLASS = "pdfreader-md-note-flash-mark";
var NOTE_FLASH_MS = 1100;
var SOURCE_FLASH_WAIT_MS = 8e3;
var SOURCE_FLASH_POLL_MS = 120;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var MarkdownReadingModule = class {
  constructor(ctx, pdfModule, quickTagModule) {
    // ========== 「定位」链接 → 来源笔记精确闪烁 ==========
    /**
     * 「定位」链接点击接管（document 捕获阶段）。
     *
     * 本插件写入目标笔记的「定位」链接都带 `#标题` 子路径。若交给 Obsidian 默认处理，
     * 打开来源笔记时原生定位闪烁会把**整节**点亮：
     *  - Live Preview：`MarkdownEditView.setHighlight` 用 resolveSubpath 给出的
     *    `start = 标题起点`、`end = 下一个标题起点` 调 `addHighlights(…, 'is-flashing')`；
     *  - 阅读模式：`MarkdownPreviewView.setEphemeralState` → `applyScrollDelayed(line, {highlight:true})`
     *    → `highlightEl(节容器)` 给整个 `.markdown-preview-section` 加 `is-flashing`。
     *
     * 因此这里接管导航：自行打开来源笔记（**不带子路径**，绕开原生整节闪烁），
     * 再用配对记录精确点亮被批注的那段 `==…==`；没有配对记录时退回闪标题。
     *
     * 与 PdfJumpModule 一致：Obsidian 自带链接处理器检查 `defaultPrevented`，只有在捕获阶段
     * `preventDefault + stopPropagation` 才能完全接管；Mod/中键等仍交还默认行为。
     */
    this.handleAnnotationLinkClick = (evt) => {
      if (evt.button !== 0)
        return;
      if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey)
        return;
      const target = evt.target;
      if (target instanceof Element === false)
        return;
      const anchor = target.closest("a.internal-link");
      if (anchor != null) {
        const href = (anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "").split("|")[0].trim();
        if (href.length === 0)
          return;
        const leaf2 = this.findLeafContaining(anchor);
        const view2 = leaf2?.view instanceof import_obsidian3.MarkdownView ? leaf2.view : null;
        const notePath = view2?.file?.path ?? this.ctx.plugin.app.workspace.getActiveFile()?.path ?? "";
        this.takeOverLocatorClick(evt, {
          linktext: href,
          href,
          label: (anchor.textContent ?? "").trim(),
          notePath,
          occurrence: countPrecedingSameLinks(view2?.contentEl ?? null, anchor, href),
          clickOffset: null
        }, leaf2);
        return;
      }
      const inEditorLink = target.closest(".cm-hmd-internal-link, .cm-link");
      if (inEditorLink == null)
        return;
      const leaf = this.findLeafContaining(target);
      if (leaf == null || leaf.view instanceof import_obsidian3.MarkdownView === false)
        return;
      const view = leaf.view;
      const editMode = view.editMode;
      if (editMode?.sourceMode)
        return;
      const editor = view.editor;
      if (editor == null || typeof editor.posAtMouse !== "function")
        return;
      let pos = null;
      let token = null;
      try {
        pos = editor.posAtMouse?.(evt) ?? null;
        token = pos != null ? editor.getClickableTokenAt(pos) : null;
      } catch (e) {
        console.warn("[MarkdownReading] \u8BFB\u53D6\u7F16\u8F91\u5668\u94FE\u63A5 token \u5931\u8D25:", e);
      }
      if (pos == null)
        return;
      const raw = findLinkAtColumn(editor.getLine(pos.line), pos.ch);
      let linktext = raw?.text ?? null;
      if (linktext == null) {
        if (token == null || token.type !== "internal-link")
          return;
        linktext = String(token.text ?? "");
      }
      if (linktext.length === 0)
        return;
      this.takeOverLocatorClick(evt, {
        linktext,
        href: stripLinkDecorations(linktext).split("|")[0].trim(),
        label: extractLinkLabel(linktext),
        notePath: view.file?.path ?? "",
        occurrence: -1,
        clickOffset: editor.posToOffset(pos)
      }, leaf);
    };
    this.ctx = ctx;
    this.pdfModule = pdfModule;
    this.quickTagModule = quickTagModule;
    this.sourcePath = null;
    this.floatingBtn = null;
    this.trackedRange = null;
    this.followTimerId = null;
    this.pendingSelection = null;
    this.suppressCheckUntil = 0;
    this.toolbarViews = /* @__PURE__ */ new Map();
    this.flashRunId = 0;
    this.sourceFlashTimer = null;
    this.sourceFlashEl = null;
    this.sourceFlashEditor = null;
    this.annotationSync = new MarkdownAnnotationSync(ctx);
  }
  load() {
    const plugin = this.ctx.plugin;
    this.pdfModule.setAnnotationTargetExclusionProvider(
      (file) => file.path === this.sourcePath
    );
    plugin.registerEditorExtension(import_view.showPanel.of((view) => this.createEditorToolbar(view)));
    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.refreshAllToolbars()));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.onWorkspaceChanged()));
    plugin.registerEvent(plugin.app.workspace.on("file-open", () => this.onWorkspaceChanged()));
    plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
      if (this.sourcePath === oldPath)
        this.sourcePath = file.path;
      this.annotationSync.handleRename(file, oldPath);
      this.refreshAllToolbars();
    }));
    plugin.registerEvent(plugin.app.vault.on("delete", (file) => {
      if (this.sourcePath === file.path)
        this.sourcePath = null;
      this.annotationSync.handleDelete(file);
      this.refreshAllToolbars();
    }));
    plugin.registerEvent(plugin.app.metadataCache.on("changed", (file) => {
      if (file.extension === "md")
        this.annotationSync.schedule(file.path);
    }));
    plugin.addCommand({
      id: "markdown-toggle-reading-source",
      name: "\u6807\u8BB0/\u53D6\u6D88\u5F53\u524D\u7B14\u8BB0\u4E3A\u6B63\u5728\u9605\u8BFB\u7684\u6587\u732E",
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (file == null || file.extension !== "md")
          return false;
        if (checking === false)
          this.toggleReadingSource(file.path);
        return true;
      }
    });
    plugin.addCommand({
      id: "markdown-annotate-selection",
      name: "\u5C06\u5F53\u524D\u9009\u4E2D\u7684\u6587\u5B57\u6279\u6CE8\u5230\u7B14\u8BB0\uFF08Markdown\uFF09",
      checkCallback: (checking) => {
        const view = plugin.app.workspace.getActiveViewOfType(import_obsidian3.MarkdownView);
        if (view == null || view.editor == null || view.file == null)
          return false;
        if (this.sourcePath !== view.file.path)
          return false;
        if (view.editor.somethingSelected() === false)
          return false;
        if (checking === false)
          void this.annotateActiveSelection();
        return true;
      }
    });
    this.initFloatingButton();
    plugin.registerDomEvent(document, "click", this.handleAnnotationLinkClick, true);
    plugin.registerDomEvent(document, "mouseup", (evt) => {
      if (evt.button !== 0)
        return;
      this.scheduleSelectionCheck();
    });
    plugin.registerDomEvent(document, "mousedown", (evt) => {
      if (evt.button !== 0)
        return;
      const target = evt.target;
      if (this.floatingBtn != null && this.floatingBtn.contains(target))
        return;
      if (target instanceof Element && target.closest(".menu") != null)
        return;
      this.hideFloatingButton();
    });
    plugin.registerDomEvent(document, "scroll", () => this.repositionFloatingButton(), { capture: true });
    plugin.registerDomEvent(window, "resize", () => this.repositionFloatingButton());
    this.annotationSync.startInitialSync();
    this.refreshAllToolbars();
  }
  unload() {
    this.sourcePath = null;
    this.pdfModule.setAnnotationTargetExclusionProvider(null);
    this.removeFloatingButton();
    this.clearSourceFlash();
    this.flashRunId++;
    this.annotationSync.unload();
    this.toolbarViews.clear();
  }
  // ========== 编辑器顶部工具栏 ==========
  createEditorToolbar(view) {
    const dom = document.createElement("div");
    dom.className = "pdfreader-md-toolbar";
    if (this.isNestedEditorView(view)) {
      dom.style.display = "none";
      return {
        dom,
        top: true,
        mount: () => this.hideNestedPanelWrapper(dom),
        destroy: () => {
        }
      };
    }
    const markBtn = document.createElement("div");
    markBtn.addClass("clickable-icon");
    markBtn.addClass("pdfreader-md-toolbar-btn");
    markBtn.addClass("pdfreader-md-mark-btn");
    (0, import_obsidian3.setIcon)(markBtn, "book-open");
    (0, import_obsidian3.setTooltip)(markBtn, "\u6807\u8BB0/\u53D6\u6D88\uFF1A\u5F53\u524D\u7B14\u8BB0\u662F\u6B63\u5728\u9605\u8BFB\u7684\u6587\u732E");
    markBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const info = this.getEditorFileInfo(view);
      if (info == null)
        return;
      this.toggleReadingSource(info.file.path);
    });
    const originalBtn = document.createElement("div");
    originalBtn.addClass("clickable-icon");
    originalBtn.addClass("pdfreader-md-toolbar-btn");
    originalBtn.addClass("pdfreader-md-original-btn");
    (0, import_obsidian3.setIcon)(originalBtn, "link");
    (0, import_obsidian3.setTooltip)(originalBtn, "\u5F00\u542F\u540E\uFF1A\u76EE\u6807\u7B14\u8BB0\u84DD\u6846\u4E2D\u5305\u542B\u9009\u4E2D\u7684\u539F\u6587\uFF1B\u5173\u95ED\u540E\uFF1A\u53EA\u5199\u6765\u6E90\u94FE\u63A5");
    originalBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.toggleIncludeOriginalText();
    });
    const tagBtn = document.createElement("div");
    tagBtn.addClass("clickable-icon");
    tagBtn.addClass("pdfreader-md-toolbar-btn");
    tagBtn.addClass("pdfreader-md-tag-btn");
    (0, import_obsidian3.setIcon)(tagBtn, "tags");
    (0, import_obsidian3.setTooltip)(tagBtn, "\u5FEB\u901F\u6DFB\u52A0\u6807\u7B7E\n\u5728\u9605\u8BFB\u7B14\u8BB0\u5149\u6807\u5904\u63D2\u5165\u51E1\u4F8B\u4E2D\u7684\u6807\u7B7E");
    tagBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.quickTagModule.openTagPicker();
    });
    const targetEl = document.createElement("span");
    targetEl.className = "pdfreader-md-toolbar-target";
    dom.append(markBtn, originalBtn, tagBtn, targetEl);
    this.toolbarViews.set(dom, view);
    this.applyToolbarState(dom, view);
    return {
      dom,
      top: true,
      destroy: () => {
        this.toolbarViews.delete(dom);
      }
    };
  }
  /**
   * 判断 EditorView 是否是 Obsidian 内部的「嵌套编辑器」。
   *
   * 典型场景：Live Preview 里点击表格单元格后临时创建的 TableCellEditor，
   * 它的 .cm-editor 挂在 <td> 的 .table-cell-wrapper 中，而整个表格又位于外层笔记
   * 编辑器的 .cm-editor 内。这类编辑器不应出现笔记工具栏。
   */
  isNestedEditorView(view) {
    const parent = view.dom.parentElement;
    if (parent == null)
      return false;
    if (parent.closest(".table-cell-wrapper") != null)
      return true;
    return parent.closest(".cm-editor") != null;
  }
  /**
   * 嵌套编辑器里连 CM6 为面板生成的 .cm-panels 外壳一起隐藏：
   * 只把面板自身 display:none 的话，外壳的背景/下边框仍会在单元格里留下一条横线。
   */
  hideNestedPanelWrapper(dom) {
    const wrapper = dom.parentElement;
    if (wrapper == null)
      return;
    if (wrapper.classList.contains("cm-panels") && wrapper.childElementCount <= 1) {
      wrapper.style.display = "none";
    } else {
      dom.style.display = "none";
    }
  }
  /** 从 CM6 state 里拿到当前编辑器对应的 TFile 与 Obsidian Editor。 */
  getEditorFileInfo(view) {
    try {
      const info = view.state.field(import_obsidian3.editorInfoField);
      const file = info?.file;
      const editor = info?.editor;
      if (file instanceof import_obsidian3.TFile && file.extension === "md" && editor != null) {
        return { file, editor };
      }
    } catch (e) {
    }
    return null;
  }
  refreshAllToolbars() {
    this.toolbarViews.forEach((view, dom) => this.applyToolbarState(dom, view));
    const activeFile = this.ctx.plugin.app.workspace.getActiveFile();
    if (activeFile == null || activeFile.path !== this.sourcePath) {
      this.hideFloatingButton();
    }
  }
  applyToolbarState(dom, view) {
    const info = this.getEditorFileInfo(view);
    if (info == null) {
      dom.style.display = "none";
      return;
    }
    dom.style.display = "";
    const markBtn = dom.querySelector(".pdfreader-md-mark-btn");
    const originalBtn = dom.querySelector(".pdfreader-md-original-btn");
    const targetEl = dom.querySelector(".pdfreader-md-toolbar-target");
    const isSource = this.sourcePath === info.file.path;
    const includeOriginal = this.pdfModule.shouldIncludeOriginalText();
    if (markBtn != null)
      markBtn.classList.toggle("is-active", isSource);
    if (originalBtn != null)
      originalBtn.classList.toggle("is-active", includeOriginal);
    if (targetEl != null) {
      const target = this.pdfModule.getCursorNotePos();
      if (target == null) {
        targetEl.textContent = "\u6279\u6CE8\u76EE\u6807\uFF1A\u672A\u6307\u5B9A";
        targetEl.classList.add("is-empty");
      } else {
        targetEl.textContent = "\u6279\u6CE8\u76EE\u6807\uFF1A" + target.noteFile.basename;
        targetEl.classList.remove("is-empty");
      }
    }
    dom.classList.toggle("is-source-note", isSource);
  }
  /**
   * 由「开始阅读」调用：直接把某篇笔记标记为正在阅读的文献（不切换、不取消）。
   * 用于右键 md →「开始阅读」时，把左边那篇被当作文献阅读的 md 设为批注来源。
   */
  setReadingSource(path) {
    if (this.sourcePath === path)
      return;
    this.sourcePath = path;
    this.hideFloatingButton();
    this.refreshAllToolbars();
  }
  toggleReadingSource(path) {
    if (this.sourcePath === path) {
      this.sourcePath = null;
    } else {
      this.sourcePath = path;
    }
    this.hideFloatingButton();
    this.refreshAllToolbars();
  }
  toggleIncludeOriginalText() {
    const settings = this.ctx.getSettings();
    settings.annotationIncludeOriginalText = settings.annotationIncludeOriginalText === false;
    void this.ctx.saveSettings().catch((e) => {
      console.error("[MarkdownReading] \u4FDD\u5B58\u300C\u9644\u5E26\u539F\u6587\u300D\u5F00\u5173\u5931\u8D25:", e);
    });
    this.refreshAllToolbars();
  }
  /**
   * 判断点击的链接是否本插件生成的「定位」链接；是则接管导航并跳转来源批注。
   *
   * **判据只有一条：存在配对记录。** 只有「目标笔记 + 来源笔记 + 子路径」能在
   * `markdownAnnotationRecords` 里找到记录时才接管，因此：
   *  - 用户自己手写的 `[[某笔记|定位]]`（显示文字恰好等于批注链接别名）不再被误接管；
   *  - 没有配对记录的旧链接（本插件早期版本写入、或记录被清空过）不再接管，
   *    回到 Obsidian 原生行为（按标题闪整节），不再退化为「闪标题」；
   *  - PDF 目标交 PdfJumpModule、普通笔记链接，一律保持 Obsidian 默认行为。
   *
   * 反过来，删掉某条配对记录就等于放弃对该链接的接管（记录存在
   * `settings.markdownAnnotationRecords`，即本插件 data.json 里）。
   * 注意记录同时承担「删链接 → 撤销来源 `==`」的配对，清空记录会一并失去那个行为。
   *
   * `sourceLeaf` 是点击所在的叶子（即笔记自己）：来源笔记尚未打开时在它的左侧分屏打开。
   */
  takeOverLocatorClick(evt, info, sourceLeaf) {
    if (info.linktext.length === 0 || info.href.length === 0 || info.notePath.length === 0)
      return;
    const parsed = (0, import_obsidian3.parseLinktext)(info.href);
    const targetFile = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(parsed.path, info.notePath);
    if (targetFile instanceof import_obsidian3.TFile === false || targetFile.extension !== "md")
      return;
    if (this.annotationSync.hasRecordForSource(info.notePath, targetFile.path, parsed.subpath) === false) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
    void this.jumpToSourceHighlight(targetFile, parsed.subpath, info, sourceLeaf).catch((e) => {
      console.error("[MarkdownReading] \u8DF3\u8F6C\u6765\u6E90\u6279\u6CE8\u5931\u8D25:", e);
    });
  }
  /**
   * 打开来源笔记并精确点亮批注：
   * 用「点击的那个 wikilink 原文 + 它在同类链接中的序号」从配对记录里找到记录，
   * 再在来源笔记原文中定位记录对应的 `==…==`，最后导航到来源笔记并滚动点亮
   * （不带 `#标题`，因此不会触发 Obsidian 的原生整节闪烁）。
   *
   * 导航：来源笔记已打开 → 复用那个标签并滚动它；未打开 → 见 `openLiteratureLeaf()`
   * （优先复用已有的空标签，其次在相邻栏新开标签，最后才新开一栏）。
   * 任何情况下都不会占用/替换正在读的笔记标签，也不会平白多分一栏。
   */
  async jumpToSourceHighlight(targetFile, subpath, info, sourceLeaf) {
    const app = this.ctx.plugin.app;
    const noteContent = await this.readNoteContentByPath(info.notePath);
    const clicked = noteContent != null ? pickClickedLink(noteContent, info) : null;
    const record = clicked != null ? this.annotationSync.resolveRecordForLink(info.notePath, clicked.text, clicked.sameTextIndex, noteContent) : null;
    let highlight = null;
    if (record != null) {
      const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
      if (sourceFile instanceof import_obsidian3.TFile && sourceFile.extension === "md") {
        const sourceContent = await this.readNoteContentByPath(sourceFile.path);
        const range = sourceContent != null ? this.annotationSync.locateHighlightRange(sourceContent, record) : null;
        if (sourceContent != null && range != null) {
          highlight = {
            startOffset: range.start,
            endOffset: range.end,
            text: record.highlightText,
            markIndex: countHighlightPairsBefore(sourceContent, range.start)
          };
        }
      }
    }
    const existingLeaf = this.findLeafByPath(targetFile.path);
    const leaf = existingLeaf ?? this.openLiteratureLeaf(targetFile, sourceLeaf);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await leaf.openFile(targetFile);
    await this.scrollSourceToHighlight(leaf, { path: targetFile.path, subpath, highlight });
  }
  /** 读取笔记原文（优先打开中的编辑器缓冲，其次磁盘缓存） */
  async readNoteContentByPath(path) {
    const app = this.ctx.plugin.app;
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof import_obsidian3.TFile === false || file.extension !== "md")
      return null;
    try {
      if (this.ctx.readNoteContent != null) {
        return await this.ctx.readNoteContent(file, { editorMode: "source" });
      }
      return await app.vault.cachedRead(file);
    } catch (e) {
      console.warn("[MarkdownReading] \u8BFB\u53D6\u7B14\u8BB0\u5185\u5BB9\u5931\u8D25:", path, e);
      return null;
    }
  }
  onWorkspaceChanged() {
    this.refreshAllToolbars();
  }
  /**
   * 在来源笔记所在叶子里滚动到批注位置并点亮：
   *  - 有配对记录 → 只高亮记录对应的 `==…==`（编辑模式经原生 addHighlights 精确到区间，
   *    阅读模式给渲染出的 `<mark>` 加 class）
   *  - 没有记录 → 退回闪烁标题（仍比 Obsidian 原生「整节闪烁」精确）
   *
   * 与 `PdfJumpModule.scrollToPdfAnchor` 同构：轮询等待视图就绪（来源叶子可能刚被打开，
   * 编辑器缓冲或阅读模式渲染出的 `<mark>` 需要时间同步），且只操作传入的叶子 ——
   * 文献开在旁边的窗格时滚动的是那一格，当前正在读的笔记不受影响。
   */
  async scrollSourceToHighlight(leaf, flash) {
    const runId = ++this.flashRunId;
    const headingName = flash.subpath.startsWith("#") ? decodeURIComponent(flash.subpath.slice(1)) : "";
    const deadline = Date.now() + SOURCE_FLASH_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.flashRunId !== runId)
        return;
      const view2 = leaf.view;
      if (view2 instanceof import_obsidian3.MarkdownView && view2.file?.path === flash.path) {
        if (view2.containerEl.isConnected === false)
          return;
        if (await this.tryFlashExactHighlight(view2, flash.highlight))
          return;
        if (flash.highlight == null && this.flashSourceHeading(view2, headingName))
          return;
      }
      await sleep(SOURCE_FLASH_POLL_MS);
    }
    const view = leaf.view;
    if (view instanceof import_obsidian3.MarkdownView && view.file?.path === flash.path) {
      this.flashSourceHeading(view, headingName);
    }
  }
  /** 闪烁来源笔记的标题；返回是否已找到并点亮 */
  flashSourceHeading(view, headingName) {
    const el = this.findHeadingElement(view.contentEl, headingName, view.getMode());
    if (el == null)
      return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    this.flashElement(el);
    return true;
  }
  /** 精确点亮来源 `==…==`（滚动到该处并闪烁）；返回 true 表示已点亮 */
  async tryFlashExactHighlight(view, highlight) {
    if (highlight == null)
      return false;
    const editor = view.getMode() === "source" ? view.editor : null;
    if (editor != null) {
      const lastLine = editor.lastLine();
      const docEnd = editor.posToOffset({ line: lastLine, ch: editor.getLine(lastLine).length });
      if (docEnd < highlight.endOffset)
        return false;
      const from = editor.offsetToPos(Math.max(0, Math.min(highlight.startOffset, docEnd)));
      const to = editor.offsetToPos(Math.max(0, Math.min(highlight.endOffset, docEnd)));
      editor.scrollIntoView({ from, to }, true);
      this.flashEditorRange(editor, from, to);
      return true;
    }
    const marks = view.contentEl.querySelectorAll("mark");
    if (marks.length === 0)
      return false;
    const expected = normalizeHighlightText(highlight.text);
    const matches = (text) => {
      const actual = normalizeHighlightText(text);
      return actual.length > 0 && (actual === expected || actual.includes(expected));
    };
    const indexed = marks[highlight.markIndex] ?? null;
    let el = indexed;
    if (expected.length > 0 && (indexed == null || matches(indexed.textContent ?? "") === false)) {
      el = Array.from(marks).find((mark) => matches(mark.textContent ?? "")) ?? indexed;
    }
    if (el == null)
      return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    this.flashElement(el);
    return true;
  }
  findHeadingElement(container, headingName, mode) {
    if (mode === "preview") {
      const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (headingName.length === 0)
        return headings[0] ?? null;
      for (const heading of Array.from(headings)) {
        const headingText = (heading.dataset.heading ?? heading.textContent ?? "").trim();
        if (headingText === headingName || headingText.includes(headingName))
          return heading;
      }
      return null;
    }
    const lines = container.querySelectorAll(".cm-line");
    if (headingName.length === 0)
      return lines[0] ?? null;
    for (const line of Array.from(lines)) {
      const text = (line.textContent ?? "").trim();
      if (line.classList.contains("HyperMD-header") && text.includes(headingName))
        return line;
      const match = /^#{1,6}\s*(.*)$/.exec(text);
      if (match != null && match[1].includes(headingName))
        return line;
      if (text.startsWith("#") && text.includes(headingName))
        return line;
    }
    return null;
  }
  flashElement(el) {
    this.clearSourceFlash();
    el.removeClass(NOTE_FLASH_MARK_CLASS);
    void el.offsetWidth;
    el.addClass(NOTE_FLASH_MARK_CLASS);
    this.sourceFlashEl = el;
    this.sourceFlashTimer = window.setTimeout(() => {
      this.sourceFlashTimer = null;
      this.clearSourceFlash();
    }, NOTE_FLASH_MS);
  }
  /**
   * 编辑器模式下精确点亮文本区间（与 PdfJumpModule 共用原生 Editor.addHighlights）。
   * 高亮挂在编辑器 state 上，滚动重绘不丢失，也不会把光标移进链接导致 Live Preview 展开。
   */
  flashEditorRange(editor, from, to) {
    const capable = editor;
    if (typeof capable.addHighlights !== "function")
      return;
    this.clearSourceFlash();
    try {
      capable.removeHighlights?.(NOTE_FLASH_MARK_CLASS);
      capable.addHighlights([{ from, to }], NOTE_FLASH_MARK_CLASS, true, true);
    } catch (e) {
      console.warn("[MarkdownReading] \u70B9\u4EAE\u6765\u6E90\u9AD8\u4EAE\u5931\u8D25:", e);
      return;
    }
    this.sourceFlashEditor = editor;
    this.sourceFlashTimer = window.setTimeout(() => {
      this.sourceFlashTimer = null;
      this.clearSourceFlash();
    }, NOTE_FLASH_MS);
  }
  clearSourceFlash() {
    if (this.sourceFlashTimer != null) {
      window.clearTimeout(this.sourceFlashTimer);
      this.sourceFlashTimer = null;
    }
    if (this.sourceFlashEl != null) {
      if (this.sourceFlashEl.isConnected)
        this.sourceFlashEl.removeClass(NOTE_FLASH_MARK_CLASS);
      this.sourceFlashEl = null;
    }
    const editor = this.sourceFlashEditor;
    this.sourceFlashEditor = null;
    if (editor != null) {
      try {
        editor.removeHighlights?.(NOTE_FLASH_MARK_CLASS);
      } catch {
      }
    }
  }
  findLeafContaining(node) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result == null && leaf.view.containerEl.contains(node))
        result = leaf;
    });
    return result;
  }
  /** 查找已打开指定笔记的叶子（含其它标签页/分屏/弹出窗口），与 PdfJumpModule 同款 */
  findLeafByPath(path) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result == null && leaf.view instanceof import_obsidian3.MarkdownView && leaf.view.file?.path === path) {
        result = leaf;
      }
    });
    return result;
  }
  /**
   * 来源笔记还没打开时，挑一个**已有的标签**来承载它，避免把界面继续分屏成 3 栏：
   *  1. 同一个窗口主区域里已有的空标签（例如给文献预留的空栏）→ 直接开进去，不新增标签；
   *  2. 笔记所在栏的相邻栏（左右/上下分屏的另一栏）→ 就在那一栏新开一个标签；
   *  3. 都没有（笔记独占一栏）→ 在笔记左侧新开一栏（与 PDF 模式一致）。
   * 三条路都不会占用/替换笔记所在的标签。
   */
  openLiteratureLeaf(targetFile, sourceLeaf) {
    const workspace = this.ctx.plugin.app.workspace;
    const noteGroup = sourceLeaf?.parent ?? null;
    const emptyLeaf = this.findEmptyMainLeaf(sourceLeaf, noteGroup);
    if (emptyLeaf != null)
      return emptyLeaf;
    const neighbour = this.findNeighbourLeaf(sourceLeaf, noteGroup);
    if (neighbour != null) {
      const tab = this.createTabInGroup(neighbour.parent);
      if (tab != null)
        return tab;
    }
    if (sourceLeaf != null)
      return workspace.createLeafBySplit(sourceLeaf, "vertical", true);
    return workspace.getLeaf("tab");
  }
  /**
   * 在指定栏（标签组）末尾新开一个标签。
   * 公开类型把 parent 写成 `WorkspaceSplit`，但传入标签组就是在那一栏新增标签
   * （同 pdf-plus 的 `createLeafInParent(leaf.parentSplit, -1)` 用法）。
   * 落点不在同一栏或调用失败时撤销并返回 null，由调用方退回分屏。
   */
  createTabInGroup(group) {
    try {
      const tab = this.ctx.plugin.app.workspace.createLeafInParent(
        group,
        -1
      );
      if (tab == null)
        return null;
      if (tab.parent === group)
        return tab;
      tab.detach();
    } catch (e) {
      console.warn("[MarkdownReading] \u5728\u76F8\u90BB\u680F\u65B0\u5F00\u6807\u7B7E\u5931\u8D25\uFF0C\u6539\u4E3A\u5206\u5C4F:", e);
    }
    return null;
  }
  /** 主区域里已有的空标签（排除笔记所在栏与左右侧边栏，侧边栏不能用来承载文献） */
  findEmptyMainLeaf(sourceLeaf, noteGroup) {
    const workspace = this.ctx.plugin.app.workspace;
    const root = sourceLeaf?.getRoot() ?? workspace.rootSplit;
    let result = null;
    workspace.iterateAllLeaves((leaf) => {
      if (result != null)
        return;
      if (leaf.getRoot() !== root)
        return;
      if (this.isSidebarLeaf(leaf))
        return;
      if (noteGroup != null && leaf.parent === noteGroup)
        return;
      if (leaf.view.getViewType() === "empty")
        result = leaf;
    });
    return result;
  }
  /** 与笔记所在栏同级（同一分屏内）的相邻栏：多栏时优先笔记左侧、离笔记最近的那一栏 */
  findNeighbourLeaf(sourceLeaf, noteGroup) {
    if (sourceLeaf == null || noteGroup == null)
      return null;
    const split = noteGroup.parent;
    if (split == null)
      return null;
    const groups = split.children;
    if (Array.isArray(groups)) {
      const noteIndex = groups.indexOf(noteGroup);
      for (let i = noteIndex - 1; i >= 0; i--) {
        const leaf = this.findLeafInGroup(groups[i], sourceLeaf);
        if (leaf != null)
          return leaf;
      }
      for (let i = noteIndex + 1; i < groups.length; i++) {
        const leaf = this.findLeafInGroup(groups[i], sourceLeaf);
        if (leaf != null)
          return leaf;
      }
      return null;
    }
    const workspace = this.ctx.plugin.app.workspace;
    const root = sourceLeaf.getRoot();
    let result = null;
    workspace.iterateAllLeaves((leaf) => {
      if (result != null)
        return;
      if (leaf.getRoot() !== root)
        return;
      if (this.isSidebarLeaf(leaf))
        return;
      if (leaf.parent === noteGroup)
        return;
      const group = leaf.parent;
      if (group.parent !== split)
        return;
      result = leaf;
    });
    return result;
  }
  /** 取指定栏（标签组）里的一个叶子；异窗口叶子与侧边栏不算 */
  findLeafInGroup(group, reference) {
    const root = reference.getRoot();
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result != null)
        return;
      if (leaf.parent !== group)
        return;
      if (leaf.getRoot() !== root)
        return;
      if (this.isSidebarLeaf(leaf))
        return;
      result = leaf;
    });
    return result;
  }
  /** 叶子是否位于左右侧边栏：侧边栏不是「分屏的一栏」，不能用来承载文献 */
  isSidebarLeaf(leaf) {
    let item = leaf.parent;
    while (item != null) {
      if (item instanceof import_obsidian3.WorkspaceSidedock)
        return true;
      item = item.parent ?? null;
    }
    return false;
  }
  // ========== 浮动批注按钮 ==========
  initFloatingButton() {
    const btn = document.createElement("div");
    btn.className = "pdfreader-md-annotate-floating-btn";
    btn.textContent = "\u6279\u6CE8\u5230\u7B14\u8BB0";
    btn.addEventListener("mousedown", (evt) => evt.preventDefault());
    btn.addEventListener("click", () => {
      const snapshot = this.pendingSelection;
      this.suppressCheckUntil = Date.now() + 800;
      this.hideFloatingButton();
      if (snapshot != null)
        void this.annotateSelection(snapshot);
    });
    document.body.appendChild(btn);
    this.floatingBtn = btn;
  }
  removeFloatingButton() {
    this.stopFollowTimer();
    this.trackedRange = null;
    this.pendingSelection = null;
    if (this.floatingBtn != null) {
      this.floatingBtn.remove();
      this.floatingBtn = null;
    }
  }
  scheduleSelectionCheck() {
    window.setTimeout(() => this.checkSelectionForFloatingButton(), 150);
  }
  checkSelectionForFloatingButton() {
    if (Date.now() < this.suppressCheckUntil)
      return;
    const plugin = this.ctx.plugin;
    const leaf = plugin.app.workspace.activeLeaf;
    const view = leaf?.view;
    if (view instanceof import_obsidian3.MarkdownView === false) {
      this.hideFloatingButton();
      return;
    }
    const file = view.file;
    const editor = view.editor;
    if (file == null || editor == null || file.extension !== "md") {
      this.hideFloatingButton();
      return;
    }
    if (this.sourcePath !== file.path) {
      this.hideFloatingButton();
      return;
    }
    if (editor.somethingSelected() === false) {
      this.hideFloatingButton();
      return;
    }
    const text = editor.getSelection();
    if (text.trim().length === 0) {
      this.hideFloatingButton();
      return;
    }
    const selection = window.getSelection();
    if (selection == null || selection.rangeCount === 0 || selection.isCollapsed) {
      this.hideFloatingButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    if (element == null || element.closest(".cm-content") == null) {
      this.hideFloatingButton();
      return;
    }
    const sel = editor.listSelections()[0];
    if (sel == null) {
      this.hideFloatingButton();
      return;
    }
    let from = sel.anchor;
    let to = sel.head;
    if (to.line < from.line || to.line === from.line && to.ch < from.ch) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    this.pendingSelection = { file, editor, text, from, to };
    this.showFloatingButton(range.cloneRange());
  }
  showFloatingButton(range) {
    const btn = this.floatingBtn;
    if (btn == null)
      return;
    this.trackedRange = range;
    btn.classList.add("is-visible");
    this.repositionFloatingButton();
    if (this.followTimerId == null) {
      this.followTimerId = window.setInterval(() => this.repositionFloatingButton(), 200);
    }
  }
  hideFloatingButton() {
    this.stopFollowTimer();
    this.trackedRange = null;
    this.pendingSelection = null;
    if (this.floatingBtn != null) {
      this.floatingBtn.classList.remove("is-visible");
    }
  }
  stopFollowTimer() {
    if (this.followTimerId != null) {
      window.clearInterval(this.followTimerId);
      this.followTimerId = null;
    }
  }
  repositionFloatingButton() {
    const btn = this.floatingBtn;
    const range = this.trackedRange;
    if (btn == null || range == null)
      return;
    const rect = this.getRangeAnchorRect(range);
    if (rect == null) {
      this.hideFloatingButton();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
      btn.classList.remove("is-visible");
      return;
    }
    btn.classList.add("is-visible");
    const btnW = btn.offsetWidth || 96;
    const btnH = btn.offsetHeight || 30;
    let left = rect.right - btnW / 2 + btnW / 4;
    left = Math.max(10, Math.min(left, vw - btnW - 10));
    let top = rect.top - btnH - 8;
    if (top < 10)
      top = Math.min(rect.bottom + 8, vh - btnH - 10);
    top = Math.max(10, Math.min(top, vh - btnH - 10));
    btn.style.left = Math.round(left) + "px";
    btn.style.top = Math.round(top) + "px";
  }
  getRangeAnchorRect(range) {
    try {
      const rects = range.getClientRects();
      let anchor = null;
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width === 0 || rect.height === 0)
          continue;
        if (anchor == null || rect.bottom > anchor.bottom)
          anchor = rect;
      }
      if (anchor != null)
        return anchor;
      const bbox = range.getBoundingClientRect();
      if (bbox.width > 0 || bbox.height > 0)
        return bbox;
    } catch (e) {
      return null;
    }
    return null;
  }
  // ========== 批注写入 ==========
  annotateActiveSelection() {
    const plugin = this.ctx.plugin;
    const view = plugin.app.workspace.getActiveViewOfType(import_obsidian3.MarkdownView);
    if (view == null || view.editor == null || view.file == null)
      return;
    const editor = view.editor;
    const file = view.file;
    if (this.sourcePath !== file.path) {
      return;
    }
    if (editor.somethingSelected() === false) {
      return;
    }
    const sel = editor.listSelections()[0];
    if (sel == null)
      return;
    let from = sel.anchor;
    let to = sel.head;
    if (to.line < from.line || to.line === from.line && to.ch < from.ch) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    void this.annotateSelection({
      file,
      editor,
      text: editor.getSelection(),
      from,
      to
    });
  }
  async annotateSelection(snapshot) {
    if (this.sourcePath !== snapshot.file.path) {
      return;
    }
    const target = this.pdfModule.getCursorNotePos();
    if (target == null) {
      return;
    }
    const includeOriginal = this.pdfModule.shouldIncludeOriginalText();
    const prompt = this.pdfModule.notePrompt;
    const link = this.buildSourceLink(snapshot.file, target.noteFile, snapshot.from);
    let insertion;
    try {
      if (includeOriginal) {
        insertion = this.appendCalloutToTarget(snapshot, target, link, prompt);
      } else {
        insertion = this.appendLinkToTarget(snapshot, target, link);
      }
    } catch (e) {
      console.error("[MarkdownReading] \u6279\u6CE8\u5199\u5165\u76EE\u6807\u7B14\u8BB0\u5931\u8D25:", e);
      return;
    }
    let highlight = null;
    try {
      highlight = this.wrapSourceSelection(snapshot);
    } catch (e) {
      console.error("[MarkdownReading] \u6765\u6E90\u7B14\u8BB0\u9AD8\u4EAE\u5931\u8D25:", e);
    }
    if (highlight != null) {
      this.annotationSync.record(snapshot.file, target.noteFile, link, insertion.linkStartOffset, highlight, target.editor);
    }
    if (insertion.promptLine != null) {
      try {
        await this.pdfModule.focusNotePrompt(target.noteFile, prompt, insertion.promptLine);
      } catch (e) {
        console.warn(e);
      }
    } else {
      this.pdfModule.focusNoteLeaf(target.noteFile);
    }
  }
  appendCalloutToTarget(snapshot, target, link, prompt) {
    const flatText = this.flattenForCallout(snapshot.text);
    const prefix = "> [!pdf-annotation]\n> " + flatText + "\n> ";
    const block = prefix + link + "\n" + prompt;
    const annotation = "\n" + block + "\n";
    const startOffset = target.editor.posToOffset({ line: target.line, ch: target.ch });
    target.editor.replaceRange(annotation, { line: target.line, ch: target.ch });
    return {
      promptLine: target.line + annotation.split("\n").length - 2,
      // annotation = 首个换行 + prefix + link + …
      linkStartOffset: startOffset + 1 + prefix.length
    };
  }
  appendLinkToTarget(snapshot, target, link) {
    const inserted = link + " ";
    const linkStartOffset = target.editor.posToOffset({ line: target.line, ch: target.ch });
    target.editor.replaceRange(inserted, { line: target.line, ch: target.ch });
    target.editor.setCursor({ line: target.line, ch: target.ch + inserted.length });
    return { promptLine: null, linkStartOffset };
  }
  /** 生成指回来源笔记的链接；优先最近一个标题，没有标题则指向整个文件。 */
  buildSourceLink(sourceFile, targetFile, from) {
    const app = this.ctx.plugin.app;
    const headings = app.metadataCache.getFileCache(sourceFile)?.headings ?? [];
    let headingPath = "";
    for (const heading of headings) {
      if (heading.position.start.line > from.line)
        break;
      headingPath = "#" + heading.heading;
    }
    const subpath = headingPath.length > 0 ? headingPath : void 0;
    return app.fileManager.generateMarkdownLink(sourceFile, targetFile.path, subpath, this.pdfModule.linkLabel);
  }
  /** 把多行选区压成适合放进 callout 单行的原文。 */
  flattenForCallout(text) {
    let normalized = text.replace(/\r\n?/g, "\n");
    const trimmed = normalized.trim();
    if (trimmed.startsWith("==") && trimmed.endsWith("==") && trimmed.length >= 4) {
      normalized = trimmed.slice(2, -2);
    }
    return normalized.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join(" ");
  }
  /** 来源笔记：在选中文字两边加 ==。已经高亮时不重复添加。 */
  wrapSourceSelection(snapshot) {
    const editor = snapshot.editor;
    const text = snapshot.text.replace(/\r\n?/g, "\n");
    if (text.length === 0)
      return null;
    if (this.isAlreadyHighlighted(editor, snapshot.from, snapshot.to, text))
      return null;
    const startOffset = editor.posToOffset(snapshot.from);
    const wrapped = "==" + text + "==";
    editor.replaceRange(wrapped, snapshot.from, snapshot.to);
    editor.setCursor(editor.offsetToPos(startOffset + wrapped.length));
    return {
      startOffset,
      endOffset: startOffset + wrapped.length,
      innerText: text
    };
  }
  isAlreadyHighlighted(editor, from, to, text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("==") && trimmed.endsWith("=="))
      return true;
    const fromOffset = editor.posToOffset(from);
    const toOffset = editor.posToOffset(to);
    const lastLine = editor.lastLine();
    const docLength = editor.posToOffset({ line: lastLine, ch: editor.getLine(lastLine).length });
    const before = editor.getRange(editor.offsetToPos(Math.max(0, fromOffset - 2)), from);
    const after = editor.getRange(to, editor.offsetToPos(Math.min(docLength, toOffset + 2)));
    return before === "==" && after === "==";
  }
};

// modules/DeepSeekModule.ts
var import_obsidian4 = require("obsidian");
var DeepSeekModule = class {
  constructor(ctx) {
    this.floatingWindow = null;
    this.ctx = ctx;
  }
  load() {
    const plugin = this.ctx.plugin;
    plugin.registerView(DEEPSEEK_TAB_VIEW_TYPE, (leaf) => new DeepSeekTabView(leaf, this.ctx));
    this.floatingWindow = new DeepSeekFloatingWindow(this.ctx);
    plugin.addRibbonIcon("bot", "\u6253\u5F00 DeepSeek", () => {
      void this.openDefault();
    });
    plugin.addCommand({
      id: "toggle-deepseek-float",
      name: "\u5207\u6362 DeepSeek \u6D6E\u52A8\u7A97\u53E3",
      callback: () => this.floatingWindow?.toggle()
    });
    plugin.addCommand({
      id: "open-deepseek-tab",
      name: "\u5728\u6807\u7B7E\u9875\u6253\u5F00 DeepSeek",
      callback: () => {
        void this.openTab();
      }
    });
    plugin.addCommand({
      id: "deepseek-add-current-file",
      name: "\u5C06\u5F53\u524D\u9605\u8BFB\u6587\u4EF6\u4E0A\u4F20\u5230 DeepSeek \u804A\u5929\u6846",
      callback: () => {
        void this.addCurrentFileToChat();
      }
    });
  }
  unload() {
    this.floatingWindow?.destroy();
    this.floatingWindow = null;
    this.ctx.plugin.app.workspace.detachLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
  }
  /** 按设置中的默认打开方式打开：浮动窗口或标签页 */
  async openDefault() {
    if (this.ctx.getSettings().deepseekOpenMode === "tab") {
      await this.openTab();
      return;
    }
    this.floatingWindow?.toggle();
  }
  /** 在 Obsidian 工作区以标签页打开 DeepSeek；已打开则聚焦并刷新地址 */
  async openTab() {
    const leaves = this.ctx.plugin.app.workspace.getLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
    if (leaves.length > 0) {
      const leaf2 = leaves[0];
      const view = leaf2.view;
      if (view instanceof DeepSeekTabView)
        view.refreshUrlIfChanged();
      await this.ctx.plugin.app.workspace.revealLeaf(leaf2);
      return;
    }
    const leaf = this.ctx.plugin.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DEEPSEEK_TAB_VIEW_TYPE, active: true });
    await this.ctx.plugin.app.workspace.revealLeaf(leaf);
  }
  /** 取当前工作区中第一个已打开的 DeepSeek 标签页视图 */
  getTabView() {
    const leaves = this.ctx.plugin.app.workspace.getLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
    if (leaves.length === 0)
      return null;
    const view = leaves[0].view;
    return view instanceof DeepSeekTabView ? view : null;
  }
  /**
   * 把当前阅读文件上传到 DeepSeek 聊天框：
   * 优先使用当前激活的 DeepSeek 标签页；若默认打开方式为标签页则用已打开标签页；
   * 否则使用浮动窗口（懒创建并显示）。
   */
  async addCurrentFileToChat() {
    const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
    if (activeLeaf?.view instanceof DeepSeekTabView) {
      await activeLeaf.view.addCurrentFileToChat();
      return;
    }
    const tab = this.getTabView();
    if (tab && this.ctx.getSettings().deepseekOpenMode === "tab") {
      await tab.addCurrentFileToChat();
      return;
    }
    await this.floatingWindow?.addCurrentFileToChat();
  }
};
var DEEPSEEK_TAB_VIEW_TYPE = "deepseek-tab-view";
var DeepSeekTabView = class extends import_obsidian4.ItemView {
  constructor(leaf, ctx) {
    super(leaf);
    this.ctx = ctx;
    this.host = null;
  }
  getViewType() {
    return DEEPSEEK_TAB_VIEW_TYPE;
  }
  getDisplayText() {
    return "DeepSeek";
  }
  getIcon() {
    return "bot";
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("deepseek-tab-view");
    const content = this.contentEl.createDiv({ cls: "deepseek-tab-webview" });
    this.host = new DeepSeekFloatingWindow(this.ctx);
    this.host.attachToTab(content);
    this.addAction("upload", "\u52A0\u8F7D\u5F53\u524D\u6587\u4EF6\u5230 DeepSeek", () => {
      void this.addCurrentFileToChat();
    });
  }
  async onClose() {
    this.host = null;
  }
  /** 供模块命令调用：把当前阅读文件上传到此标签页 */
  async addCurrentFileToChat() {
    await this.host?.addCurrentFileToChat();
  }
  /** 设置中 DeepSeek URL 改变后刷新标签页 webview */
  refreshUrlIfChanged() {
    this.host?.refreshTabWebview();
  }
};
var MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
var MIN_WINDOW_WIDTH = 320;
var MIN_WINDOW_HEIGHT = 400;
var RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
var LEFT_BUTTON_MASK = 1;
var POINTER_PROBE_TOKEN = "__DS_PTR_UP_ENTER__";
var POINTER_PROBE_SCRIPT = `
(function() {
    if (window.__ds_pointer_probe) return;
    window.__ds_pointer_probe = true;
    var report = function() { console.log('${POINTER_PROBE_TOKEN}'); };
    document.addEventListener('mouseover', function(ev) {
        if (!ev.relatedTarget && ev.buttons === 0) report();
    }, true);
    document.addEventListener('mouseout', function(ev) {
        // \u6307\u9488\u79BB\u5F00 guest \u6587\u6863\uFF1B\u6807\u8BB0\u79BB\u5F00\u72B6\u6001\uFF0C\u91CD\u65B0\u8FDB\u5165\u540E\u7684\u9996\u4E2A mousemove \u8D70 report
        if (!ev.relatedTarget) window.__ds_ptr_outside = true;
    }, true);
    document.addEventListener('mousemove', function(ev) {
        if (window.__ds_ptr_outside) {
            window.__ds_ptr_outside = false;
            if (ev.buttons === 0) report();
        }
    }, true);
})();
`.trim();
var HTML_PREVIEW_COMPAT_SCRIPT = `
(function() {
    if (window.__ds_html_preview_fix) return;
    window.__ds_html_preview_fix = true;

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;

    // blob URL -> HTML \u6587\u672C \u7684\u7F13\u5B58\uFF08\u53EA\u8BB0\u5F55 text/html \u7C7B\u578B\uFF09
    var htmlBlobText = new Map();

    var origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
        var url = origCreate(obj);
        try {
            if (obj instanceof Blob && /text\\/html/i.test(obj.type || '')) {
                htmlBlobText.set(url, obj.text().catch(function() { return null; }));
            }
        } catch (e) {}
        return url;
    };

    var origRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function(url) {
        try { htmlBlobText.delete(url); } catch (e) {}
        return origRevoke(url);
    };

    var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (!desc || !desc.set || !desc.get) return;

    // \u6062\u590D\u539F\u751F src \u8BBF\u95EE\u5668\u7684\u515C\u5E95\u8DEF\u5F84
    var restore = function(frame, value) {
        try {
            Object.defineProperty(HTMLIFrameElement.prototype, 'src', desc);
            frame.src = value;
        } catch (e) {}
    };

    var custom = {
        configurable: true,
        enumerable: desc.enumerable,
        get: function() { return desc.get.call(this); },
        set: function(value) {
            var self = this;
            try {
                var pending = htmlBlobText.get(value);
                if (pending) {
                    htmlBlobText.delete(value);
                    pending.then(function(text) {
                        // \u62FF\u4E0D\u5230\u6587\u672C\u5C31\u9000\u56DE\u539F\u751F\u884C\u4E3A\uFF0C\u907F\u514D\u5F71\u54CD\u5176\u4ED6\u7528\u9014
                        if (typeof text !== 'string' || !text.length) {
                            restore(self, value);
                            return;
                        }
                        try {
                            self.removeAttribute('src');
                            self.srcdoc = text;
                        } catch (e) {
                            restore(self, value);
                        }
                    });
                    return;
                }
            } catch (e) {}
            return desc.set.call(this, value);
        },
    };
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', custom);
})();
`.trim();
var DeepSeekFloatingWindow = class {
  constructor(ctx) {
    this.container = null;
    this.content = null;
    this.webview = null;
    this.isVisible = false;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    /** 正在进行的边缘缩放清理函数（挂 document 级监听；销毁窗口时兜底调用） */
    this.resizeCleanup = null;
    /** 宿主页面最近一次观察到的鼠标按键掩码（webview 区域收不到宿主事件，用于推断窗口外松开左键） */
    this.lastHostButtons = 0;
    /** 当前 webview 实际加载的网址，用于检测设置变更后是否需要重建 */
    this.currentUrl = "";
    this.ctx = ctx;
  }
  /**
   * 按当前设置创建 webview 并挂上就绪/探测监听。
   * 独立成方法是为了支持「改了网址就重建」：webview 的 src 只在创建时读取一次，
   * 之后 hide/show 复用同一个元素，因此改设置后必须重建才会生效。
   */
  buildWebview(content) {
    const url = this.ctx.getSettings().deepseekUrl;
    const wv = content.createEl("webview", {
      attr: {
        src: url,
        style: "width: 100%; height: 100%; border: none;",
        allowpopups: ""
      }
    });
    this.webview = wv;
    this.currentUrl = url;
    wv.addEventListener("dom-ready", () => {
      void this.injectPointerProbe();
      void this.injectHtmlPreviewCompat();
    });
    wv.addEventListener("console-message", (e) => {
      const msg = e?.message;
      if (typeof msg === "string" && msg.indexOf(POINTER_PROBE_TOKEN) !== -1) {
        this.endStuckWebviewDrag();
      }
    });
  }
  /** 标签页视图复用：把 webview 挂到指定容器，复用后续上传逻辑而不创建浮动窗口。 */
  attachToTab(content) {
    this.content = content;
    this.container = content;
    this.buildWebview(content);
  }
  /** 标签页视图在设置 URL 变更后调用，重建 webview。 */
  refreshTabWebview() {
    this.refreshWebviewIfUrlChanged();
  }
  /** 设置里的网址变了就重建 webview；只在网址确实变化时重建，避免丢失聊天页面状态。 */
  refreshWebviewIfUrlChanged() {
    if (!this.content)
      return;
    const url = this.ctx.getSettings().deepseekUrl;
    if (url === this.currentUrl)
      return;
    this.webview?.remove();
    this.webview = null;
    this.buildWebview(this.content);
  }
  createWindow() {
    const container = document.body.createDiv({ cls: "deepseek-float-container" });
    const titleBar = container.createDiv({ cls: "deepseek-float-titlebar" });
    const titleLeft = titleBar.createDiv({ cls: "deepseek-float-title-left" });
    titleLeft.innerHTML = "<span>DeepSeek</span>";
    const titleRight = titleBar.createDiv({ cls: "deepseek-float-title-right" });
    const addFileBtn = titleRight.createEl("button", {
      cls: "deepseek-float-add-file"
    });
    addFileBtn.textContent = "\u52A0\u8F7D\u6587\u4EF6";
    addFileBtn.title = "\u5C06\u5F53\u524D\u9605\u8BFB\u7684\u6587\u4EF6\u4E0A\u4F20\u5230\u804A\u5929\u6846";
    addFileBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.addCurrentFileToChat();
    });
    const minimizeBtn = titleRight.createEl("button", { cls: "deepseek-float-minimize" });
    minimizeBtn.textContent = "\uFF0D";
    minimizeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hide();
    });
    const content = container.createDiv({ cls: "deepseek-float-content" });
    this.content = content;
    this.buildWebview(content);
    this.applySavedGeometry(container);
    for (const dir of RESIZE_DIRECTIONS) {
      const handle = container.createDiv({ cls: `deepseek-float-resize deepseek-float-resize-${dir}` });
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        this.beginResize(e, dir);
      });
    }
    titleBar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button"))
        return;
      this.isDragging = true;
      const rect = container.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      container.style.cursor = "grabbing";
      container.style.transition = "none";
      content.style.pointerEvents = "none";
    });
    const onMouseMove = (e) => {
      if (!this.isDragging)
        return;
      container.style.left = e.clientX - this.dragOffset.x + "px";
      container.style.top = e.clientY - this.dragOffset.y + "px";
    };
    const onMouseUp = () => {
      if (this.isDragging) {
        this.isDragging = false;
        container.style.cursor = "";
        container.style.transition = "";
        content.style.pointerEvents = "";
        this.persistGeometry();
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    this.ctx.plugin.register(() => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    });
    const trackHostMouse = (e) => {
      const prev = this.lastHostButtons;
      this.lastHostButtons = e.buttons;
      const hadLeft = (prev & LEFT_BUTTON_MASK) !== 0;
      const hasLeft = (e.buttons & LEFT_BUTTON_MASK) !== 0;
      if (hasLeft && e.type === "mousemove" && !this.isDragging && !this.resizeCleanup) {
        this.forwardPointerToWebview(e);
      }
      const leftReleased = e.type === "mouseup" && e.button === 0 || hadLeft && !hasLeft;
      if (!leftReleased)
        return;
      if (e.type !== "mouseup") {
        onMouseUp();
        this.resizeCleanup?.();
      }
      this.endStuckWebviewDrag(e);
    };
    document.addEventListener("mousemove", trackHostMouse, true);
    document.addEventListener("mouseup", trackHostMouse, true);
    this.ctx.plugin.register(() => {
      document.removeEventListener("mousemove", trackHostMouse, true);
      document.removeEventListener("mouseup", trackHostMouse, true);
    });
    this.container = container;
  }
  show() {
    if (!this.container)
      this.createWindow();
    if (!this.container)
      return;
    this.refreshWebviewIfUrlChanged();
    this.container.style.display = "flex";
    const rect = this.container.getBoundingClientRect();
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
      this.resetGeometryStyles(this.container);
      this.clearGeometry();
    }
    this.isVisible = true;
  }
  hide() {
    if (!this.container)
      return;
    this.container.style.display = "none";
    this.isVisible = false;
  }
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }
  destroy() {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    this.container?.remove();
    this.container = null;
    this.content = null;
    this.webview = null;
  }
  // ========== 窗口几何：持久化与恢复 ==========
  /** 恢复保存的窗口几何（非法或缺省时保持 CSS 默认值） */
  applySavedGeometry(container) {
    const geom = this.ctx.getSettings().deepseekWindowGeometry;
    if (!isValidGeometry(geom))
      return;
    container.style.width = `${geom.width}px`;
    container.style.height = `${geom.height}px`;
    container.style.left = `${geom.left}px`;
    container.style.top = `${geom.top}px`;
    container.style.right = "auto";
  }
  /** 把当前窗口几何写入设置并落盘 */
  persistGeometry() {
    if (!this.container)
      return;
    const rect = this.container.getBoundingClientRect();
    const geom = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    };
    if (!isValidGeometry(geom))
      return;
    try {
      this.ctx.getSettings().deepseekWindowGeometry = geom;
      void this.ctx.saveSettings().catch((e) => {
        console.error("[DeepSeek] \u4FDD\u5B58\u7A97\u53E3\u51E0\u4F55\u5931\u8D25:", e);
      });
    } catch (e) {
      console.error("[DeepSeek] \u5199\u5165\u7A97\u53E3\u51E0\u4F55\u5931\u8D25:", e);
    }
  }
  /** 清除持久化几何（面板被拖出视口复位时调用） */
  clearGeometry() {
    try {
      this.ctx.getSettings().deepseekWindowGeometry = null;
      void this.ctx.saveSettings().catch((e) => {
        console.error("[DeepSeek] \u6E05\u9664\u7A97\u53E3\u51E0\u4F55\u5931\u8D25:", e);
      });
    } catch (e) {
      console.error("[DeepSeek] \u6E05\u9664\u7A97\u53E3\u51E0\u4F55\u5931\u8D25:", e);
    }
  }
  /** 清空全部内联几何样式，回退到 CSS 默认定位与尺寸 */
  resetGeometryStyles(container) {
    container.style.left = "";
    container.style.top = "";
    container.style.right = "";
    container.style.width = "";
    container.style.height = "";
  }
  // ========== 边缘缩放 ==========
  /**
   * 开始边缘缩放：按方向在 document 上挂一次性 move/up 监听。
   * 8 个方向复用同一套数学：n/s 改高度，e/w 改宽度，w/n 同时平移 left/top，
   * 全程从起始矩形推导（绝对量），避免累积误差；尺寸钳制到最小值。
   */
  beginResize(e, dir) {
    if (e.button !== 0)
      return;
    const container = this.container;
    const content = this.content;
    if (!container || !content)
      return;
    e.preventDefault();
    const startRect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    let resized = false;
    container.style.transition = "none";
    content.style.pointerEvents = "none";
    const MIN_W = MIN_WINDOW_WIDTH;
    const MIN_H = MIN_WINDOW_HEIGHT;
    const onMouseMove = (ev) => {
      resized = true;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let width = startRect.width;
      let height = startRect.height;
      let left = startRect.left;
      let top = startRect.top;
      if (dir.includes("e")) {
        width = Math.max(MIN_W, startRect.width + dx);
      }
      if (dir.includes("s")) {
        height = Math.max(MIN_H, startRect.height + dy);
      }
      if (dir.includes("w")) {
        width = Math.max(MIN_W, startRect.width - dx);
        left = startRect.right - width;
      }
      if (dir.includes("n")) {
        height = Math.max(MIN_H, startRect.height - dy);
        top = startRect.bottom - height;
      }
      container.style.width = `${Math.round(width)}px`;
      container.style.height = `${Math.round(height)}px`;
      container.style.right = "auto";
      container.style.left = `${Math.round(left)}px`;
      container.style.top = `${Math.round(top)}px`;
    };
    const finish = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", finish);
      container.style.transition = "";
      content.style.pointerEvents = "";
      this.resizeCleanup = null;
      if (resized)
        this.persistGeometry();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", finish);
    this.resizeCleanup = finish;
  }
  // ========== webview 拖拽跟随与卡死修复 ==========
  /**
   * 把宿主侧指针事件坐标映射到 webview 视口内并钳制到边缘
   * （指针拖出 webview 范围时钉在边缘，与原生滚动条拖出轨道端点钉住的行为一致）。
   * 窗口隐藏或 webview 未就绪时返回 null。
   */
  mapToWebview(e) {
    if (!this.isVisible || !this.webview)
      return null;
    const rect = this.webview.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0))
      return null;
    return {
      x: Math.round(Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 1)),
      y: Math.round(Math.min(Math.max(e.clientY - rect.top, 0), rect.height - 1))
    };
  }
  /**
   * 按住左键期间，把宿主侧观察到的指针移动转投为 webview 输入事件。
   * webview（OOPIF）在指针离开其范围后收不到任何鼠标事件，guest 内已开始的
   * 滚动条/文本选择拖拽会因此中断；转投带左键按下状态的 mouseMove 让拖拽继续跟随。
   * 拖拽未激活时这些事件无副作用（无配套 mousedown，不会触发点击/选择/滚动）。
   */
  forwardPointerToWebview(e) {
    if (!this.isVisible || !this.webview)
      return;
    const rect = this.webview.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0))
      return;
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    const x = rawX < 0 || rawX > rect.width - 1 ? Math.round(rect.width - 1) : Math.round(rawX);
    const y = Math.round(Math.min(Math.max(rawY, 0), rect.height - 1));
    try {
      this.webview.sendInputEvent({
        type: "mouseMove",
        x,
        y,
        button: "left",
        // sendInputEvent 的 WebMouseEvent 转换器不解析 buttons 字段，
        // 按住左键必须用 modifiers 表达，guest 收到的 DOM 事件 buttons 才是 1
        modifiers: ["leftButtonDown"]
      });
    } catch {
    }
  }
  /**
   * 向 webview 注入一次浏览器级 mouseUp，终结 guest 页面中卡住的滚动条/文本选择拖拽。
   * guest 未处于拖拽状态时，单独的 mouseUp 无副作用（click 需要成对的 mousedown+mouseup）。
   * 坐标取当前指针位置映射到 webview 视口内（指针在 webview 外时钳制到边缘），
   * 无指针信息时落在左上角（滚动条在右缘，左上角不会命中交互元素）。
   */
  endStuckWebviewDrag(e) {
    if (!this.isVisible || !this.webview)
      return;
    const pt = e ? this.mapToWebview(e) : { x: 1, y: 1 };
    if (!pt)
      return;
    try {
      this.webview.sendInputEvent({
        type: "mouseUp",
        x: pt.x,
        y: pt.y,
        button: "left",
        buttons: 0,
        clickCount: 1
      });
    } catch {
    }
  }
  /** 注入 guest 端指针探测脚本（幂等，dom-ready 时调用；页面刷新后需重注入） */
  async injectPointerProbe() {
    if (!this.webview)
      return;
    try {
      await this.webview.executeJavaScript(POINTER_PROBE_SCRIPT);
    } catch (e) {
      console.warn("[DeepSeek] \u6CE8\u5165\u6307\u9488\u63A2\u6D4B\u811A\u672C\u5931\u8D25:", e);
    }
  }
  /**
   * 注入 guest 端 HTML 预览兼容脚本（幂等，dom-ready 时调用；页面刷新后需重注入）。
   * 修复：webview 中子框架无法导航到 blob: URL，导致 DeepSeek 的 HTML 预览一片空白。
   */
  async injectHtmlPreviewCompat() {
    if (!this.webview)
      return;
    try {
      await this.webview.executeJavaScript(HTML_PREVIEW_COMPAT_SCRIPT);
    } catch (e) {
      console.warn("[DeepSeek] \u6CE8\u5165 HTML \u9884\u89C8\u517C\u5BB9\u811A\u672C\u5931\u8D25:", e);
    }
  }
  // ========== 上传当前文件到聊天框 ==========
  async addCurrentFileToChat() {
    if (!this.container) {
      this.createWindow();
      this.show();
    }
    if (!this.webview) {
      new import_obsidian4.Notice("DeepSeek \u7A97\u53E3\u672A\u5C31\u7EEA");
      return;
    }
    if (!this.ctx.getCurrentFileForUpload) {
      new import_obsidian4.Notice("\u65E0\u6CD5\u83B7\u53D6\u6587\u4EF6");
      return;
    }
    const fetchingNotice = new import_obsidian4.Notice("\u6B63\u5728\u8BFB\u53D6\u6587\u4EF6\u2026", 0);
    let fileData = null;
    try {
      fileData = await this.ctx.getCurrentFileForUpload();
    } catch (e) {
      console.error("[DeepSeek] \u83B7\u53D6\u6587\u4EF6\u5931\u8D25:", e);
      fetchingNotice.hide();
      new import_obsidian4.Notice("\u83B7\u53D6\u6587\u4EF6\u5931\u8D25");
      return;
    }
    fetchingNotice.hide();
    if (!fileData) {
      new import_obsidian4.Notice("\u672A\u627E\u5230\u6B63\u5728\u9605\u8BFB\u7684\u6587\u4EF6");
      return;
    }
    const sizeMB = (fileData.data.byteLength / 1024 / 1024).toFixed(1);
    if (fileData.data.byteLength > MAX_UPLOAD_BYTES) {
      new import_obsidian4.Notice(`\u6587\u4EF6\u8FC7\u5927\uFF08${sizeMB}MB\uFF09\uFF0C\u4E0A\u9650 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`, 6e3);
      return;
    }
    const base64 = arrayBufferToBase64(fileData.data);
    const uploadingNotice = new import_obsidian4.Notice(`\u6B63\u5728\u4E0A\u4F20 ${fileData.name}\uFF08${sizeMB}MB\uFF09\u2026`, 0);
    try {
      const result = await this.uploadViaWebview(base64, fileData);
      uploadingNotice.hide();
      if (result === "not-found") {
        new import_obsidian4.Notice("\u672A\u627E\u5230 DeepSeek \u6587\u4EF6\u4E0A\u4F20\u5165\u53E3\uFF0C\u8BF7\u786E\u4FDD\u9875\u9762\u5DF2\u52A0\u8F7D\u5B8C\u6210", 6e3);
      } else if (result === "success") {
        new import_obsidian4.Notice(`\u5DF2\u4E0A\u4F20 ${fileData.name}`);
      } else if (result === "drop") {
        new import_obsidian4.Notice(`\u5DF2\u901A\u8FC7\u62D6\u62FD\u4E0A\u4F20 ${fileData.name}`);
      } else {
        new import_obsidian4.Notice(`\u4E0A\u4F20\u7ED3\u679C: ${result}`);
      }
    } catch (e) {
      uploadingNotice.hide();
      console.error("[DeepSeek] \u6587\u4EF6\u4E0A\u4F20\u5931\u8D25:", e);
      new import_obsidian4.Notice("\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u6216\u624B\u52A8\u4E0A\u4F20", 6e3);
    }
  }
  /**
   * 分块将 base64 注入 webview 页面变量，避免单次 executeJavaScript
   * 携带超大字符串导致主线程长时间阻塞；最后一步统一组装上传。
   */
  async uploadViaWebview(base64, fileData) {
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const varName = `__ds_upload_b64_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.webview.executeJavaScript(`window[${JSON.stringify(varName)}] = '';`);
    try {
      for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
        const chunk = base64.slice(i, i + CHUNK_SIZE);
        await this.webview.executeJavaScript(
          `(function(){ window[${JSON.stringify(varName)}] += ${JSON.stringify(chunk)}; })();`
        );
      }
      const script = this.buildUploadScript(fileData.name, fileData.mimeType, varName);
      return await this.webview.executeJavaScript(script);
    } finally {
      try {
        await this.webview.executeJavaScript(`(function(){ delete window[${JSON.stringify(varName)}]; })();`);
      } catch (e) {
      }
    }
  }
  /**
   * 构造上传脚本：
   *  1. 从 window[varName] 取回 base64 → Uint8Array → File 对象
   *  2. 策略 A：找 <input type="file">，用 DataTransfer 赋值并触发 change
   *  3. 策略 B（兜底）：在聊天输入区域模拟 dragover + drop 事件
   * 返回 'success' / 'drop' / 'not-found'
   */
  buildUploadScript(filename, mimeType, varName) {
    const escapedName = JSON.stringify(filename);
    const escapedMime = JSON.stringify(mimeType);
    const escapedVar = JSON.stringify(varName);
    return `
(function() {
    try {
        var b64 = window[${escapedVar}] || '';
        var filename = ${escapedName};
        var mimeType = ${escapedMime};

        // base64 \u2192 Uint8Array
        var byteChars = atob(b64);
        var len = byteChars.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            bytes[i] = byteChars.charCodeAt(i);
        }
        var file = new File([bytes], filename, { type: mimeType });
        b64 = null;
        byteChars = null;

        // \u7B56\u7565 A\uFF1A\u901A\u8FC7 <input type="file"> \u4E0A\u4F20
        var inputs = document.querySelectorAll('input[type="file"]');
        for (var j = 0; j < inputs.length; j++) {
            var input = inputs[j];
            try {
                var dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return 'success';
            } catch (e) {
                // \u8BE5 input \u4E0D\u652F\u6301\uFF0C\u7EE7\u7EED\u5C1D\u8BD5\u4E0B\u4E00\u4E2A
            }
        }

        // \u7B56\u7565 B\uFF1A\u6A21\u62DF\u62D6\u62FD\u653E\u7F6E\uFF08drag-drop\uFF09
        var dropZone = document.querySelector('textarea')
            || document.querySelector('div[contenteditable="true"]')
            || document.querySelector('[class*="upload"]')
            || document.querySelector('[class*="input"]');
        if (dropZone) {
            var dt2 = new DataTransfer();
            dt2.items.add(file);
            try {
                dropZone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt2, bubbles: true }));
                dropZone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt2, bubbles: true }));
                dropZone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true }));
                return 'drop';
            } catch (e) {
                // DragEvent \u6784\u9020\u53EF\u80FD\u5931\u8D25\uFF0C\u5FFD\u7565
            }
        }

        return 'not-found';
    } catch (e) {
        return 'error: ' + (e && e.message ? e.message : e);
    } finally {
        // \u91CA\u653E\u5BBF\u4E3B\u5206\u5757\u6CE8\u5165\u7684 base64\uFF08\u7EA6\u4E3A\u6587\u4EF6\u4F53\u79EF\u7684 4/3\uFF09\u3002deepseek \u9875\u9762\u662F\u5E38\u9A7B SPA\uFF0C
        // \u53D8\u91CF\u7559\u5728 window \u4E0A\u4F1A\u968F\u6BCF\u6B21\u4E0A\u4F20\u7D2F\u79EF\uFF08100MB \u6587\u4EF6 \u2248 133MB \u5E38\u9A7B\u5B57\u7B26\u4E32\uFF09\uFF0C
        // \u800C\u5BBF\u4E3B\u4FA7\u7684 fileData \u65E9\u5DF2\u91CA\u653E \u2014\u2014 \u8868\u73B0\u4E3A DeepSeek \u5B50\u8FDB\u7A0B\u5185\u5B58\u53EA\u6DA8\u4E0D\u843D\u3002
        try { delete window[${escapedVar}]; } catch (e) {}
    }
})();
        `.trim();
  }
};
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32766;
  let out = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let binary = "";
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j]);
    }
    out += btoa(binary);
  }
  return out;
}
function isValidGeometry(g) {
  if (!g)
    return false;
  const nums = [g.left, g.top, g.width, g.height];
  return nums.every((n) => Number.isFinite(n)) && g.width > 50 && g.height > 50;
}

// modules/PdfHighlightModule.ts
var import_obsidian5 = require("obsidian");

// modules/toolbarPoller.ts
var SharedPoller = class {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.tasks = /* @__PURE__ */ new Set();
    /** 门控：返回 false 时本轮跳过全部任务（如无打开的 PDF 视图、窗口隐藏时零开销） */
    this.gate = null;
  }
  /** 注册轮询任务，返回移除函数 */
  add(task) {
    this.tasks.add(task);
    return () => this.remove(task);
  }
  /** 设置轮询门控（插件加载时调用一次；返回 false 时本轮 tick 直接跳过） */
  setGate(gate) {
    this.gate = gate;
  }
  /** 启动定时器（已有定时器或没有任务时不重复启动；幂等） */
  start() {
    if (this.timer !== null || this.tasks.size === 0)
      return;
    this.timer = window.setInterval(() => {
      if (this.gate && !this.gate())
        return;
      if (document.hidden)
        return;
      for (const task of this.tasks) {
        try {
          task();
        } catch (e) {
          console.error("[pdf-reader] \u5DE5\u5177\u6761\u8F6E\u8BE2\u4EFB\u52A1\u5931\u8D25:", e);
        }
      }
    }, this.intervalMs);
  }
  remove(task) {
    this.tasks.delete(task);
    if (this.tasks.size === 0 && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
};
var toolbarPoller = new SharedPoller(2e3);
function pruneStaleLeaves(app, entries) {
  const openLeaves = /* @__PURE__ */ new Set();
  app.workspace.iterateAllLeaves((leaf) => openLeaves.add(leaf));
  if (entries instanceof Set) {
    for (const leaf of entries) {
      if (!openLeaves.has(leaf))
        entries.delete(leaf);
    }
  } else {
    for (const leaf of [...entries.keys()]) {
      if (!openLeaves.has(leaf))
        entries.delete(leaf);
    }
  }
}

// modules/HighlightBase.ts
var BasePdfHighlightModule = class {
  constructor(ctx) {
    /** pdfPath → 高亮索引（索引类型由子类定义） */
    this.indexCache = /* @__PURE__ */ new Map();
    /** 已挂载事件监听的叶子（避免重复挂载） */
    this.attachedLeaves = /* @__PURE__ */ new Set();
    /** 事件总线尚未就绪、等待重试挂载的叶子 */
    this.attachRetries = /* @__PURE__ */ new Set();
    /** 重建索引的防抖定时器 */
    this.rebuildTimer = null;
    /** 防抖窗口内待重建的 PDF：'full' = 全量重建（删除/重命名路径），string[] = 局部重建路径集，null = 无待办 */
    this.pendingRebuild = null;
    /**
     * 显式高亮覆盖层：批注写入后、笔记内容尚未确认（resolvedLinks 未收录新链接 /
     * metadataCache 落盘延迟）期间的显式条目（pdfPath → page → 条目 key）。
     * 每次重建索引都会并入覆盖层并清理已被笔记内容确认的条目，
     * 确保并发的防抖重建不会用「缺新条目」的索引覆盖掉刚批注的高亮。
     */
    this.explicitOverlay = /* @__PURE__ */ new Map();
    /** 每个 PDF 的重建串行链：同一 PDF 的重建按序执行，避免并发交错旧索引覆盖新索引 */
    this.rebuildChains = /* @__PURE__ */ new Map();
    this.ctx = ctx;
  }
  load() {
    const app = this.ctx.plugin.app;
    this.ctx.plugin.registerEvent(
      app.workspace.on("layout-change", () => this.attachToPdfLeaves())
    );
    this.ctx.plugin.registerEvent(
      app.workspace.on("active-leaf-change", () => this.attachToPdfLeaves())
    );
    this.ctx.plugin.registerEvent(
      app.workspace.on("file-open", (file) => {
        if (file && file.extension === "pdf") {
          this.scheduleRebuildForPdfs([file.path]);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("changed", (file) => {
        const links = app.metadataCache.resolvedLinks[file.path];
        if (!links)
          return;
        const affected = Object.keys(links).filter((t) => t.endsWith(".pdf"));
        if (affected.length > 0) {
          this.scheduleRebuildForPdfs(affected);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("resolve", (file) => {
        const links = app.metadataCache.resolvedLinks[file.path];
        if (!links)
          return;
        const affected = Object.keys(links).filter((t) => t.endsWith(".pdf"));
        if (affected.length > 0) {
          this.scheduleRebuildForPdfs(affected);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("deleted", () => this.scheduleRebuild())
    );
    this.ctx.plugin.registerEvent(
      app.vault.on("rename", () => this.scheduleRebuild())
    );
    this.attachToPdfLeaves();
    this.scheduleRebuild();
  }
  unload() {
    this.cleanupHighlightLayers();
    this.attachedLeaves.clear();
    this.attachRetries.clear();
    this.indexCache.clear();
    this.explicitOverlay.clear();
    this.rebuildChains.clear();
    this.pendingRebuild = null;
    if (this.rebuildTimer !== null) {
      window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }
  /** 清理本插件插入 PDF 页面的持久高亮 DOM 层，避免插件卸载后残留 */
  cleanupHighlightLayers() {
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      leaf.view.containerEl.querySelectorAll(
        ".pdf-reader-highlight-layer, .pdf-screenshot-highlight-layer, .ocr-highlight-layer"
      ).forEach((el) => el.remove());
    });
  }
  /**
   * 串行化执行 rebuildIndex：同一 PDF 的重建按启动顺序依次执行，
   * 并在索引写回后并入「显式覆盖层」。并发重建交错时，后启动的重建
   * 一定读到最新的笔记内容；覆盖层保证刚批注、尚未被笔记内容确认的
   * 显式条目不会因任何一次重建而丢失。
   */
  rebuildIndexSerialized(pdfPath) {
    const prev = this.rebuildChains.get(pdfPath) ?? Promise.resolve();
    const next = prev.catch(() => {
    }).then(async () => {
      await this.rebuildIndex(pdfPath);
      const index = this.indexCache.get(pdfPath);
      if (index !== void 0) {
        this.mergeExplicitOverlay(pdfPath, index);
      }
    });
    this.rebuildChains.set(pdfPath, next);
    return next;
  }
  /** 记录一条「尚未被笔记内容确认」的显式高亮条目（批注写入后立即调用） */
  trackExplicitEntry(pdfPath, page, key) {
    if (!Number.isInteger(page))
      return;
    let pages = this.explicitOverlay.get(pdfPath);
    if (!pages) {
      pages = /* @__PURE__ */ new Map();
      this.explicitOverlay.set(pdfPath, pages);
    }
    const keys = pages.get(page) ?? /* @__PURE__ */ new Set();
    keys.add(key);
    pages.set(page, keys);
  }
  /**
   * 把显式覆盖层并入刚重建的索引，并清理已被笔记内容确认的条目：
   *  - key 已存在于索引（笔记内容已包含该批注）→ 移出覆盖层
   *  - key 不存在（resolvedLinks 尚未收录笔记 / 笔记未落盘）→ 并入索引兜底
   */
  mergeExplicitOverlay(pdfPath, index) {
    const pages = this.explicitOverlay.get(pdfPath);
    if (!pages)
      return;
    for (const [page, keys] of pages) {
      for (const key of keys) {
        if (this.applyExplicitEntry(index, page, key)) {
          keys.delete(key);
        }
      }
      if (keys.size === 0)
        pages.delete(page);
    }
    if (pages.size === 0)
      this.explicitOverlay.delete(pdfPath);
  }
  /** 全部（已打开视图的 PDF）重建并重渲染 */
  scheduleRebuild() {
    this.scheduleTimer("full");
  }
  /**
   * 精确重建指定 PDF 并重渲染（编辑单篇笔记的常规路径）：
   * 只重建受影响且可能打开的 PDF，避免每次笔记编辑都全量重扫所有打开的 PDF。
   * 防抖窗口内多次请求会合并路径；已被全量请求（'full'）覆盖时维持全量。
   */
  scheduleRebuildForPdfs(pdfPaths) {
    const open = this.getOpenPdfPaths();
    const filtered = pdfPaths.filter((p) => open.has(p));
    if (filtered.length === 0)
      return;
    this.scheduleTimer(filtered);
  }
  /** 统一防抖调度：合并窗口内请求，'full' 请求优先且不可被局部请求降级 */
  scheduleTimer(request) {
    if (this.rebuildTimer !== null)
      window.clearTimeout(this.rebuildTimer);
    if (request === "full" || this.pendingRebuild === "full") {
      this.pendingRebuild = "full";
    } else if (this.pendingRebuild === null) {
      this.pendingRebuild = request;
    } else {
      this.pendingRebuild = [.../* @__PURE__ */ new Set([...this.pendingRebuild, ...request])];
    }
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      const pending = this.pendingRebuild;
      this.pendingRebuild = null;
      if (pending === "full" || !pending) {
        this.explicitOverlay.clear();
        this.rebuildAllIndexes().then(() => this.renderAllOpenPdfs());
      } else {
        this.rebuildAndRender(pending);
      }
    }, 300);
  }
  /** 只重建指定 PDF 的索引并渲染对应视图（未打开的 PDF 渲染为空操作） */
  async rebuildAndRender(pdfPaths) {
    for (const path of pdfPaths) {
      await this.rebuildIndexSerialized(path);
    }
    for (const path of pdfPaths) {
      this.renderForPdf(path);
    }
  }
  /** 重建所有「当前有视图打开」的 PDF 索引 */
  async rebuildAllIndexes() {
    const openPdfPaths = this.getOpenPdfPaths();
    for (const path of openPdfPaths) {
      await this.rebuildIndexSerialized(path);
    }
    for (const path of [...this.indexCache.keys()]) {
      if (!openPdfPaths.has(path) && !this.ctx.plugin.app.vault.getAbstractFileByPath(path)) {
        this.indexCache.delete(path);
      }
    }
  }
  getOpenPdfPaths() {
    const paths = /* @__PURE__ */ new Set();
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === "pdf") {
        const file = leaf.view.file;
        if (file)
          paths.add(file.path);
      }
    });
    return paths;
  }
  attachToPdfLeaves() {
    pruneStaleLeaves(this.ctx.plugin.app, this.attachedLeaves);
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      if (this.attachedLeaves.has(leaf))
        return;
      const viewer = leaf.view.viewer;
      const eventBus = viewer?.child?.pdfViewer?.eventBus;
      if (!eventBus) {
        this.retryAttachPdfLeaf(leaf);
        return;
      }
      this.attachedLeaves.add(leaf);
      const onRendered = (data) => {
        const pdfFile2 = leaf.view.file;
        if (!pdfFile2)
          return;
        this.renderPageHighlights(pdfFile2.path, data?.source);
      };
      eventBus.on(this.renderEventName, onRendered);
      this.ctx.plugin.register(() => {
        eventBus.off(this.renderEventName, onRendered);
        this.attachedLeaves.delete(leaf);
      });
      const pdfFile = leaf.view.file;
      if (pdfFile) {
        this.scheduleRebuildForPdfs([pdfFile.path]);
      }
    });
  }
  /**
   * 事件总线未就绪时的延迟重试：PDF 视图组件（viewer.child.pdfViewer）是异步
   * 加载的，layout-change / active-leaf-change 可能在其就绪前触发，导致挂载被
   * 跳过且不再有事件补挂。轮询最多 4 秒（40 × 100ms），就绪后重跑 attachToPdfLeaves。
   */
  retryAttachPdfLeaf(leaf) {
    if (this.attachRetries.has(leaf))
      return;
    this.attachRetries.add(leaf);
    let tries = 0;
    const timer = window.setInterval(() => {
      tries++;
      const viewer = leaf.view.viewer;
      const eventBus = viewer?.child?.pdfViewer?.eventBus;
      if (eventBus || tries >= 40) {
        window.clearInterval(timer);
        this.attachRetries.delete(leaf);
        if (eventBus)
          this.attachToPdfLeaves();
      }
    }, 100);
    this.ctx.plugin.register(() => {
      window.clearInterval(timer);
      this.attachRetries.delete(leaf);
    });
  }
  renderForPdf(pdfPath) {
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const pdfFile = leaf.view.file;
      if (!pdfFile || pdfFile.path !== pdfPath)
        return;
      const viewer = leaf.view.viewer;
      const pdfViewer = viewer?.child?.pdfViewer?.pdfViewer;
      if (!pdfViewer)
        return;
      for (const pageView of pdfViewer._pages ?? []) {
        if (pageView?.div)
          this.renderPageHighlights(pdfPath, pageView);
      }
    });
  }
  renderAllOpenPdfs() {
    for (const path of this.getOpenPdfPaths()) {
      this.renderForPdf(path);
    }
  }
  /** 读取笔记内容：优先打开中的编辑器缓冲，其次磁盘（共享缓存可用时复用一次读取） */
  async readNoteContent(sourceFile) {
    if (this.ctx.readNoteContent) {
      return await this.ctx.readNoteContent(sourceFile);
    }
    const app = this.ctx.plugin.app;
    let editorContent = null;
    app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (editorContent !== null)
        return;
      const view = leaf.view;
      if (view.file?.path === sourceFile.path && view.editor) {
        editorContent = view.editor.getValue();
      }
    });
    if (editorContent !== null)
      return editorContent;
    return await app.vault.read(sourceFile);
  }
};

// modules/PdfHighlightModule.ts
var PdfHighlightModule = class extends BasePdfHighlightModule {
  constructor(ctx) {
    super(ctx);
  }
  get renderEventName() {
    return "textlayerrendered";
  }
  /**
   * 刷新指定 PDF 的高亮：
   *  - 刚批注写入的选区先记入「显式覆盖层」（笔记可能尚未落盘 / resolvedLinks
   *    尚未收录新链接），由串行重建统一并入索引，规避写入延迟实现即时高亮
   *  - 再从笔记内容重建索引（覆盖层条目会被笔记内容确认并自动清理）
   *  - 最后重渲染所有已打开该 PDF 的视图
   */
  refresh(pdfFile, explicitSelections) {
    const pdfPath = pdfFile.path;
    if (explicitSelections && explicitSelections.length > 0) {
      for (const sel of explicitSelections) {
        if (sel.page === null)
          continue;
        this.trackExplicitEntry(pdfPath, sel.page, this.selectionId(sel));
      }
    }
    this.rebuildIndexSerialized(pdfPath).then(() => {
      this.renderForPdf(pdfPath);
    });
  }
  /** 覆盖层条目并入文本选区索引；返回 true 表示已被笔记内容确认（移出覆盖层） */
  applyExplicitEntry(index, page, key) {
    const selections = index.get(page);
    if (selections?.has(key))
      return true;
    const set = selections ?? /* @__PURE__ */ new Set();
    set.add(key);
    index.set(page, set);
    return false;
  }
  /**
   * 重建单个 PDF 的索引。
   * 注意：Obsidian 的 metadataCache 不记录指向 PDF 的正文链接（cache.links 为空，getBacklinksForFile
   * 也不返回），因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再直接读取笔记原文提取 selection 链接。
   */
  async rebuildIndex(pdfPath) {
    const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof import_obsidian5.TFile))
      return;
    const newIndex = /* @__PURE__ */ new Map();
    const app = this.ctx.plugin.app;
    let readFailed = false;
    for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (!links[pdfPath])
        continue;
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof import_obsidian5.TFile))
        continue;
      try {
        const content = await this.readNoteContent(sourceFile);
        this.extractLinksFromContent(content, pdfFile, sourcePath, newIndex);
      } catch (e) {
        readFailed = true;
        console.warn("[PdfHighlight] \u8BFB\u53D6\u7B14\u8BB0\u5931\u8D25:", sourcePath, e);
      }
    }
    if (readFailed && this.indexCache.has(pdfPath))
      return;
    this.indexCache.set(pdfPath, newIndex);
  }
  /** 从笔记原文中提取指向指定 PDF 的 selection 链接并写入索引 */
  extractLinksFromContent(content, pdfFile, sourcePath, index) {
    const app = this.ctx.plugin.app;
    const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&selection=([\d,\s-]+)/g;
    let m;
    while ((m = linkRegex.exec(content)) !== null) {
      const linkpath = m[1].trim();
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (target !== pdfFile)
        continue;
      const page = parseInt(m[2], 10);
      const parts = m[3].split(",").map((s) => parseInt(s.trim(), 10));
      if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
        continue;
      const selections = index.get(page) ?? /* @__PURE__ */ new Set();
      selections.add(`${parts[0]},${parts[1]},${parts[2]},${parts[3]}`);
      index.set(page, selections);
    }
  }
  selectionId(sel) {
    return `${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
  }
  /** 渲染单页的高亮覆盖层（textlayerrendered 时调用，缩放/翻页会重发事件 → 自动重建） */
  renderPageHighlights(pdfPath, pageView) {
    if (!pageView?.div)
      return;
    const pageNumber = parseInt(pageView.div.dataset.pageNumber, 10) || 0;
    const index = this.indexCache.get(pdfPath);
    const selections = index?.get(pageNumber);
    if (!index)
      return;
    const textLayerBuilder = pageView.textLayer;
    const textLayer = textLayerBuilder?.textLayer;
    const textDivs = textLayer?.textDivs ?? [];
    if (!textLayer || textDivs.length === 0)
      return;
    if (!selections || selections.size === 0) {
      pageView.div.querySelector(".pdf-reader-highlight-layer")?.remove();
      return;
    }
    const textContentItems = textLayer.textContentItems ?? [];
    const firstIdx = parseInt(textDivs[0].getAttribute("data-idx") || "0", 10) || 0;
    const pageDivRect = pageView.div.getBoundingClientRect();
    const pageGeom = {
      box: {
        left: pageDivRect.left + pageView.div.clientLeft,
        top: pageDivRect.top + pageView.div.clientTop,
        width: pageView.div.clientWidth,
        height: pageView.div.clientHeight
      },
      viewBox: pageView.pdfPage?.view ?? [0, 0, 0, 0]
    };
    const rectsBySelection = [];
    let totalRects = 0;
    for (const selectionStr of selections) {
      const [bi, bo, ei, eo] = selectionStr.split(",").map((s) => parseInt(s, 10));
      if (Number.isNaN(bi) || Number.isNaN(bo) || Number.isNaN(ei) || Number.isNaN(eo))
        continue;
      const rects = this.computeMergedHighlightRects(
        textContentItems,
        textDivs,
        bi + firstIdx,
        bo,
        ei + firstIdx,
        eo,
        pageGeom
      );
      if (rects.length > 0) {
        rectsBySelection.push({ sel: selectionStr, rects });
        totalRects += rects.length;
      }
    }
    if (totalRects === 0)
      return;
    pageView.div.querySelector(".pdf-reader-highlight-layer")?.remove();
    const layerEl = this.getOrCreateHighlightLayer(pageView);
    for (const { sel, rects } of rectsBySelection) {
      for (const rect of rects) {
        this.placeRectInPage(rect, pageView, layerEl, pageNumber, sel);
      }
    }
  }
  getOrCreateHighlightLayer(pageView) {
    const pageDiv = pageView.div;
    const existing = pageDiv.querySelector(".pdf-reader-highlight-layer");
    if (existing)
      return existing;
    const layerEl = pageDiv.createDiv("pdf-reader-highlight-layer");
    layerEl.setAttr("data-main-rotation", String(pageView.viewport?.rotation ?? 0));
    const pdfjsLib = window.pdfjsLib;
    if (pdfjsLib?.setLayerDimensions && pageView.viewport) {
      try {
        pdfjsLib.setLayerDimensions(layerEl, pageView.viewport);
        return layerEl;
      } catch (e) {
        console.warn("[PdfHighlight] setLayerDimensions \u5931\u8D25\uFF0C\u56DE\u9000\u4E3A\u767E\u5206\u6BD4\u5B9A\u4F4D:", e);
      }
    }
    layerEl.setCssStyles({ width: "100%", height: "100%" });
    return layerEl;
  }
  /**
   * 计算选区覆盖的矩形列表（PDF 坐标，Y 轴向上）。
   * 优先使用文本项的逐字符包围盒（chars），缺失时回退文本层 div 的屏幕视觉盒。
   * 同行相邻项合并为一个矩形。
   */
  computeMergedHighlightRects(items, textDivs, beginIndex, beginOffset, endIndex, endOffset, pageGeom) {
    const results = [];
    let merged = null;
    if (endOffset === 0 && endIndex > beginIndex) {
      endIndex--;
      endOffset = items[endIndex]?.str?.length ?? 0;
    }
    for (let i = Math.max(0, beginIndex); i <= Math.min(endIndex, items.length - 1); i++) {
      const item = items[i];
      const textDiv = textDivs[i];
      if (!item?.str)
        continue;
      const rect = this.computeRectForItem(item, textDiv, i, beginIndex, beginOffset, endIndex, endOffset, pageGeom);
      if (!rect)
        continue;
      if (!merged) {
        merged = rect;
      } else if (this.areRectsMergeable(merged, rect)) {
        merged = this.mergeRects(merged, rect);
      } else {
        results.push(merged);
        merged = rect;
      }
    }
    if (merged)
      results.push(merged);
    return results;
  }
  computeRectForItem(item, textDiv, index, beginIndex, beginOffset, endIndex, endOffset, pageGeom) {
    const chars = item.chars;
    if (chars && chars.length >= item.str.length) {
      const firstCharIdx = chars.findIndex((c) => c?.c === item.str.charAt(0));
      const lastCharIdx = chars.findLastIndex((c) => c?.c === item.str.charAt(item.str.length - 1));
      if (firstCharIdx < 0 || lastCharIdx < 0)
        return null;
      const trimmed = chars.slice(firstCharIdx, lastCharIdx + 1);
      const from = index === beginIndex ? beginOffset : 0;
      const to = (index === endIndex ? Math.min(endOffset, trimmed.length) : trimmed.length) - 1;
      if (from > trimmed.length - 1 || to < 0)
        return null;
      const cFrom = trimmed[from];
      const cTo = trimmed[to];
      return [
        Math.min(cFrom.r[0], cTo.r[0]),
        Math.min(cFrom.r[1], cTo.r[1]),
        Math.max(cFrom.r[2], cTo.r[2]),
        Math.max(cFrom.r[3], cTo.r[3])
      ];
    }
    if (!textDiv)
      return null;
    const pr = textDiv.getBoundingClientRect();
    if (!pr.width || !pr.height)
      return null;
    let sx0 = pr.left, sx1 = pr.right;
    const divLen = textDiv.textContent?.length ?? 0;
    if (index === beginIndex && beginOffset > 0 || index === endIndex && endOffset < divLen) {
      try {
        const range = textDiv.ownerDocument.createRange();
        if (index === beginIndex && beginOffset > 0) {
          range.setStart(textDiv.firstChild ?? textDiv, Math.min(beginOffset, divLen));
        } else {
          range.setStartBefore(textDiv);
        }
        if (index === endIndex && endOffset < divLen) {
          range.setEnd(textDiv.lastChild ?? textDiv, Math.min(endOffset, divLen));
        } else {
          range.setEndAfter(textDiv);
        }
        const rr = range.getBoundingClientRect();
        if (rr.width > 0) {
          sx0 = rr.left;
          sx1 = rr.right;
        }
      } catch (e) {
      }
    }
    const [pageX, pageY, pageMaxX, pageMaxY] = pageGeom.viewBox;
    const pageWidth = pageMaxX - pageX;
    const pageHeight = pageMaxY - pageY;
    const { left: boxLeft, top: boxTop, width: boxW, height: boxH } = pageGeom.box;
    if (!pageWidth || !pageHeight || !boxW || !boxH)
      return null;
    return [
      pageX + (sx0 - boxLeft) / boxW * pageWidth,
      pageY + pageHeight - (pr.bottom - boxTop) / boxH * pageHeight,
      pageX + (sx1 - boxLeft) / boxW * pageWidth,
      pageY + pageHeight - (pr.top - boxTop) / boxH * pageHeight
    ];
  }
  /** 两个矩形中心 Y 接近（同一行）时视为可合并 */
  areRectsMergeable(rect1, rect2) {
    const y1 = (rect1[1] + rect1[3]) / 2;
    const y2 = (rect2[1] + rect2[3]) / 2;
    const h1 = Math.abs(rect1[3] - rect1[1]);
    const h2 = Math.abs(rect2[3] - rect2[1]);
    return Math.abs(y1 - y2) < Math.max(h1, h2) * 0.5;
  }
  mergeRects(rect1, rect2) {
    return [
      Math.min(rect1[0], rect2[0]),
      Math.min(rect1[1], rect2[1]),
      Math.max(rect1[2], rect2[2]),
      Math.max(rect1[3], rect2[3])
    ];
  }
  /**
   * 将 PDF 坐标矩形放置到页面的高亮层中（百分比定位，Y 轴翻转）。
   * rect: [left, bottom, right, top]（PDF 坐标，Y 向上）
   * 附带 data-pdf-jump-* 属性供 PdfJumpModule 识别点击目标（跳回笔记对应批注）。
   */
  placeRectInPage(rect, pageView, layerEl, pageNumber, selectionStr) {
    const viewBox = pageView.pdfPage?.view;
    if (!viewBox || viewBox.length < 4)
      return;
    const pageX = viewBox[0];
    const pageY = viewBox[1];
    const pageWidth = viewBox[2] - viewBox[0];
    const pageHeight = viewBox[3] - viewBox[1];
    if (!pageWidth || !pageHeight)
      return;
    const rectEl = layerEl.createDiv("pdf-reader-selection-highlight");
    rectEl.setAttr("data-pdf-jump-page", String(pageNumber));
    rectEl.setAttr("data-pdf-jump-selection", selectionStr);
    rectEl.setCssStyles({
      left: `${100 * (rect[0] - pageX) / pageWidth}%`,
      top: `${100 * (viewBox[3] - rect[3] + viewBox[1] - pageY) / pageHeight}%`,
      // 防御：任何路径产生反向/非法矩形时钳制为非负，避免 CSS 负高度
      // 被丢弃后高亮塌缩成细线
      width: `${Math.max(0, 100 * (rect[2] - rect[0]) / pageWidth)}%`,
      height: `${Math.max(0, 100 * (rect[3] - rect[1]) / pageHeight)}%`
    });
  }
};

// modules/ScreenshotModule.ts
var import_obsidian7 = require("obsidian");

// modules/BaseCropModeModule.ts
var import_obsidian6 = require("obsidian");
var MIN_CROP_SIZE = 8;
var BaseCropModeModule = class {
  constructor(ctx) {
    /** 已注入工具条按钮的叶子 */
    this.toolbarLeaves = /* @__PURE__ */ new Set();
    /** 各叶子工具条按钮（激活态高亮用） */
    this.cropButtons = /* @__PURE__ */ new Map();
    /**
     * 忙碌标志：识别/写入进行中时禁止再次进入截图模式，并禁用工具条按钮。
     * 由子类用 setBusy() 置位（如 OCR 识别期间）。
     */
    this.busy = false;
    /** 轮询任务移除函数（卸载时注销共享轮询） */
    this.removePollTask = null;
    /** 截图模式激活的视图容器（非 null = 截图模式中） */
    this.cropRoot = null;
    /** 截图模式对应的叶子 */
    this.cropLeaf = null;
    /** 截图模式监听器（供取消时移除） */
    this.cropPointerDown = null;
    this.cropKeyDown = null;
    /** pointercancel 监听器（拖拽被系统打断时清理拖拽状态） */
    this.cropPointerCancel = null;
    /** window blur 监听器（窗口失焦时退出截图模式，避免光标/捕获悬挂） */
    this.cropWindowBlur = null;
    /** 当前拖拽状态（非 null = 正在框选） */
    this.dragState = null;
    /** 忙碌期间再次进入截图模式时的提示（子类可覆写） */
    this.busyNotice = "\u6B63\u5728\u5904\u7406\u4E0A\u4E00\u6B21\u6846\u9009\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5";
    this.ctx = ctx;
  }
  load() {
    const plugin = this.ctx.plugin;
    plugin.registerEvent(
      plugin.app.workspace.on("layout-change", () => this.injectToolbarButtons())
    );
    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", () => this.injectToolbarButtons())
    );
    this.removePollTask = toolbarPoller.add(() => this.injectToolbarButtons());
    toolbarPoller.start();
    plugin.addCommand({
      id: this.commandId,
      name: this.commandName,
      checkCallback: (checking) => {
        const ws = plugin.app.workspace;
        const recent = ws.getMostRecentLeaf();
        const leaf = recent && recent.view.getViewType() === "pdf" ? recent : ws.getLeavesOfType("pdf")[0];
        if (!leaf)
          return false;
        if (!checking)
          this.startCropMode(leaf);
        return true;
      }
    });
    this.injectToolbarButtons();
    plugin.register(() => {
      for (const btn of this.cropButtons.values()) {
        btn.remove();
      }
      this.cropButtons.clear();
      this.toolbarLeaves.clear();
    });
  }
  unload() {
    this.removePollTask?.();
    this.removePollTask = null;
    this.cancelCropMode();
    this.toolbarLeaves.clear();
    this.cropButtons.clear();
  }
  // ========== 工具条按钮 ==========
  injectToolbarButtons() {
    pruneStaleLeaves(this.ctx.plugin.app, this.toolbarLeaves);
    pruneStaleLeaves(this.ctx.plugin.app, this.cropButtons);
    if (this.cropRoot && !this.cropRoot.isConnected) {
      this.cancelCropMode();
    }
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const viewer = leaf.view.viewer;
      const toolbar = viewer?.child?.toolbar;
      if (!toolbar)
        return;
      const pageNumberEl = toolbar.pageNumberEl;
      if (!pageNumberEl || !pageNumberEl.parentElement)
        return;
      const existing = pageNumberEl.parentElement.querySelector("." + this.buttonClass);
      if (existing) {
        this.cropButtons.set(leaf, existing);
        this.toolbarLeaves.add(leaf);
        return;
      }
      const stale = this.cropButtons.get(leaf);
      if (stale && !stale.isConnected) {
        stale.remove();
        this.toolbarLeaves.delete(leaf);
        this.cropButtons.delete(leaf);
      }
      const btn = document.createElement("div");
      btn.addClass("clickable-icon");
      btn.addClass(this.buttonClass);
      (0, import_obsidian6.setIcon)(btn, this.buttonIcon);
      (0, import_obsidian6.setTooltip)(btn, this.buttonTooltip);
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (this.busy)
          return;
        this.cropButtons.set(leaf, btn);
        this.startCropMode(leaf);
      });
      pageNumberEl.after(btn);
      this.toolbarLeaves.add(leaf);
      this.cropButtons.set(leaf, btn);
      if (this.busy) {
        btn.toggleClass("is-disabled", true);
        btn.setAttribute("aria-disabled", "true");
      }
      if (this.cropLeaf === leaf && this.cropRoot) {
        btn.addClass("is-active");
      }
    });
  }
  // ========== 截图模式 ==========
  /**
   * 置位/清除忙碌态：忙碌时禁用所有工具条按钮并拒绝再次进入截图模式。
   * 必须在 finally 中清除，否则按钮会永久禁用。
   */
  setBusy(busy) {
    this.busy = busy;
    for (const btn of this.cropButtons.values()) {
      btn.toggleClass("is-disabled", busy);
      btn.setAttribute("aria-disabled", busy ? "true" : "false");
    }
    if (busy)
      this.cancelCropMode();
  }
  /** 当前是否处于忙碌态（子类可查询） */
  get isBusy() {
    return this.busy;
  }
  /** 进入/退出截图模式：不遮挡视图，在页面上拖拽框选，可随时滚动页面 */
  startCropMode(leaf) {
    if (this.busy) {
      new import_obsidian6.Notice(this.busyNotice);
      return;
    }
    if (this.cropRoot) {
      if (this.cropLeaf === leaf) {
        this.cancelCropMode();
        return;
      }
      this.cancelCropMode();
    }
    const g = window;
    if (typeof g.__pdfCropExit === "function") {
      g.__pdfCropExit();
      g.__pdfCropExit = null;
    }
    const root = leaf.view.containerEl;
    if (!root)
      return;
    const win = root.ownerDocument.defaultView;
    if (!win)
      return;
    root.addClass(this.selectingClass);
    this.cropButtons.get(leaf)?.addClass("is-active");
    this.cropRoot = root;
    this.cropLeaf = leaf;
    g.__pdfCropExit = () => this.cancelCropMode();
    const onPointerDown = (e) => {
      if (e.button !== 0)
        return;
      if (this.dragState)
        return;
      const target = e.target;
      const pageEl = target.closest?.("[data-page-number]");
      if (!pageEl || !pageEl.isConnected)
        return;
      if (!this.cropRoot || !this.cropRoot.contains(pageEl))
        return;
      e.preventDefault();
      this.startDrag(win, e, pageEl);
    };
    const onKeyDown = (evt) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.cancelCropMode();
      }
    };
    const onPointerCancel = (evt) => {
      if (this.dragState && evt.pointerId === this.dragState.pointerId) {
        this.cancelDrag();
      }
    };
    const onWindowBlur = () => {
      this.cancelCropMode();
    };
    this.cropPointerDown = onPointerDown;
    this.cropKeyDown = onKeyDown;
    this.cropPointerCancel = onPointerCancel;
    this.cropWindowBlur = onWindowBlur;
    win.addEventListener("pointerdown", onPointerDown, true);
    win.addEventListener("keydown", onKeyDown, true);
    win.addEventListener("pointercancel", onPointerCancel, true);
    win.addEventListener("blur", onWindowBlur);
  }
  /** 开始一次框选拖拽：框挂页面内，坐标全程锚定页面（页面滚动不漂移） */
  startDrag(win, e, pageEl) {
    this.cancelDrag();
    const pr0 = pageEl.getBoundingClientRect();
    const ox0 = pr0.left + pageEl.clientLeft;
    const oy0 = pr0.top + pageEl.clientTop;
    const pw0 = pageEl.clientWidth;
    const ph0 = pageEl.clientHeight;
    const downPX = clampCoord(e.clientX - ox0, pw0);
    const downPY = clampCoord(e.clientY - oy0, ph0);
    const pointerId = e.pointerId;
    try {
      pageEl.setPointerCapture(pointerId);
    } catch (e2) {
    }
    const boxEl = pageEl.createDiv(this.boxClass);
    Object.assign(boxEl.style, {
      left: `${downPX}px`,
      top: `${downPY}px`,
      width: "0px",
      height: "0px"
    });
    const move = (evt) => {
      if (evt.pointerId !== pointerId)
        return;
      evt.preventDefault();
      const pr = pageEl.getBoundingClientRect();
      const ox = pr.left + pageEl.clientLeft;
      const oy = pr.top + pageEl.clientTop;
      const px = clampCoord(evt.clientX - ox, pageEl.clientWidth);
      const py = clampCoord(evt.clientY - oy, pageEl.clientHeight);
      Object.assign(boxEl.style, {
        left: `${Math.min(downPX, px)}px`,
        top: `${Math.min(downPY, py)}px`,
        width: `${Math.abs(px - downPX)}px`,
        height: `${Math.abs(py - downPY)}px`
      });
    };
    const up = (evt) => {
      if (evt.pointerId !== pointerId)
        return;
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerup", up, true);
      if (this.dragState)
        this.dragState = null;
      const box = boxEl.getBoundingClientRect();
      boxEl.remove();
      const width = box.width;
      const height = box.height;
      if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
        new import_obsidian6.Notice("\u6846\u9009\u533A\u57DF\u8FC7\u5C0F\uFF0C\u5DF2\u53D6\u6D88");
        return;
      }
      const pr = pageEl.getBoundingClientRect();
      const pageRect = {
        x: box.left - pr.left,
        y: box.top - pr.top,
        width,
        height
      };
      const leaf = this.cropLeaf;
      this.cancelCropMode();
      void this.onCropComplete(leaf, pageEl, pageRect);
    };
    this.dragState = { pageEl, boxEl, pointerId, downPX, downPY, move, up };
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerup", up, true);
  }
  /** 取消当前拖拽（保留截图模式） */
  cancelDrag() {
    if (!this.dragState)
      return;
    const { pageEl, boxEl, pointerId, move, up } = this.dragState;
    this.dragState = null;
    boxEl.remove();
    try {
      pageEl.releasePointerCapture(pointerId);
    } catch (e) {
    }
    const win = boxEl.ownerDocument.defaultView;
    win?.removeEventListener("pointermove", move, true);
    win?.removeEventListener("pointerup", up, true);
  }
  cancelCropMode() {
    this.cancelDrag();
    if (this.cropRoot) {
      const win = this.cropRoot.ownerDocument.defaultView;
      this.cropRoot.removeClass(this.selectingClass);
      if (this.cropPointerDown) {
        win?.removeEventListener("pointerdown", this.cropPointerDown, true);
        this.cropPointerDown = null;
      }
      if (this.cropKeyDown) {
        win?.removeEventListener("keydown", this.cropKeyDown, true);
        this.cropKeyDown = null;
      }
      if (this.cropPointerCancel) {
        win?.removeEventListener("pointercancel", this.cropPointerCancel, true);
        this.cropPointerCancel = null;
      }
      if (this.cropWindowBlur) {
        win?.removeEventListener("blur", this.cropWindowBlur);
        this.cropWindowBlur = null;
      }
      this.cropRoot = null;
    }
    if (this.cropLeaf) {
      this.cropButtons.get(this.cropLeaf)?.removeClass("is-active");
    }
    this.cropLeaf = null;
    const g = window;
    if (g.__pdfCropExit) {
      g.__pdfCropExit = null;
    }
  }
};
function clampCoord(value, size) {
  if (size <= 0)
    return 0;
  return Math.min(Math.max(value, 0), size);
}

// modules/ScreenshotModule.ts
var ScreenshotModule = class extends BaseCropModeModule {
  constructor(ctx, pdfModule) {
    super(ctx);
    /** 截图批注写入后的高亮刷新回调（由主入口注入 ScreenshotHighlightModule.refresh） */
    this.refreshHighlights = null;
    /**
     * pdfjs 获取器（模块创建时绑定本插件上下文）。
     * 独立成函数是给 CropEmbed 用的：嵌入创建器只拿到 Obsidian 的嵌入上下文，
     * 拿不到插件实例与 manifest.dir，无法自行定位插件目录做回退加载。
     */
    this.pdfjsResolver = null;
    /** 原始 PDF EmbedCreator（注册自定义裁剪嵌入前保存，卸载时恢复） */
    this.originalPdfEmbedCreator = null;
    /** 本插件注册的包装创建器（用于卸载时校验注册表归属，避免覆盖其他插件） */
    this.wrappedPdfEmbedCreator = null;
    this.buttonClass = "pdfreader-screenshot-button";
    this.selectingClass = "pdf-screenshot-selecting";
    this.boxClass = "pdf-screenshot-box";
    this.buttonIcon = "image-plus";
    this.buttonTooltip = "\u622A\u56FE\u6279\u6CE8\u5230\u7B14\u8BB0";
    this.commandId = "screenshot-annotate";
    this.commandName = "\u622A\u56FE\u6279\u6CE8\u5230\u7B14\u8BB0";
    this.pdfModule = pdfModule;
  }
  /** 注入截图批注高亮刷新回调（批注成功后触发即时渲染） */
  setHighlightRefresh(cb) {
    this.refreshHighlights = cb;
  }
  load() {
    super.load();
    this.registerCropEmbedCreator();
  }
  unload() {
    super.unload();
    this.restoreCropEmbedCreator();
    pdfDocCache.clear();
  }
  // ========== 框选完成 → 截图批注 ==========
  async onCropComplete(leaf, pageDiv, pageRect) {
    try {
      await this.doCaptureScreenshot(leaf, pageDiv, pageRect);
    } catch (e) {
      console.error("[Screenshot] \u622A\u56FE\u6279\u6CE8\u5931\u8D25:", e);
      new import_obsidian7.Notice(`\u622A\u56FE\u6279\u6CE8\u5931\u8D25: ${e.message}`);
    }
  }
  async doCaptureScreenshot(leaf, pageDiv, pageRect) {
    if (!leaf)
      return;
    const pageNum = parseInt(pageDiv.dataset?.pageNumber ?? "0", 10) || 0;
    if (pageNum <= 0) {
      new import_obsidian7.Notice("\u65E0\u6CD5\u786E\u5B9A\u622A\u56FE\u9875\u7801");
      return;
    }
    const file = leaf.view.file;
    if (!file) {
      new import_obsidian7.Notice("\u65E0\u6CD5\u8BC6\u522B\u5F53\u524D PDF \u6587\u4EF6");
      return;
    }
    let rect = null;
    try {
      rect = await this.screenToPdfRect(leaf, pageDiv, pageRect);
    } catch (e) {
      console.warn("[Screenshot] \u5750\u6807\u8F6C\u6362\u5931\u8D25:", e);
    }
    if (!rect) {
      new import_obsidian7.Notice("\u5750\u6807\u8F6C\u6362\u5931\u8D25\uFF0C\u65E0\u6CD5\u751F\u6210\u622A\u56FE\u5D4C\u5165");
      return;
    }
    const notice = new import_obsidian7.Notice("\u6B63\u5728\u5199\u5165\u622A\u56FE\u6279\u6CE8\u2026", 0);
    try {
      const ok = await this.pdfModule.annotateScreenshot(file, pageNum, rect);
      notice.hide();
      if (ok) {
        this.refreshHighlights?.(file, [{ page: pageNum, rect }]);
        new import_obsidian7.Notice("\u622A\u56FE\u6279\u6CE8\u5DF2\u5199\u5165\u7B14\u8BB0");
      }
    } catch (e) {
      notice.hide();
      new import_obsidian7.Notice(`\u622A\u56FE\u6279\u6CE8\u5931\u8D25: ${e.message}`);
    }
  }
  /**
   * 屏幕坐标（pageDiv 边框框相对）→ PDF 空间坐标 [x1, y1, x2, y2]。
   * 使用 pdfjs pageView.getPagePoint 进行视口→PDF 坐标转换，
   * 与 pdf-plus 的矩形选择实现一致。
   */
  async screenToPdfRect(leaf, pageDiv, pageRect) {
    const child = leaf.view.viewer?.child;
    const pageNum = parseInt(pageDiv.dataset?.pageNumber ?? "0", 10);
    const pageView = child?.getPage?.(pageNum);
    if (!pageView?.getPagePoint)
      return null;
    const style = getComputedStyle(pageDiv);
    const bl = parseFloat(style.borderLeftWidth) || 0;
    const bt = parseFloat(style.borderTopWidth) || 0;
    const pl = parseFloat(style.paddingLeft) || 0;
    const pt = parseFloat(style.paddingTop) || 0;
    const left = pageRect.x - bl - pl;
    const top = pageRect.y - bt - pt;
    const right = left + pageRect.width;
    const bottom = top + pageRect.height;
    const pdfjsLib = await (this.pdfjsResolver ? this.pdfjsResolver() : Promise.resolve(window.pdfjsLib));
    const points = [
      ...pageView.getPagePoint(left, bottom),
      ...pageView.getPagePoint(right, top)
    ];
    const rect = pdfjsLib?.Util?.normalizeRect ? pdfjsLib.Util.normalizeRect(points) : [
      Math.min(points[0], points[2]),
      Math.min(points[1], points[3]),
      Math.max(points[0], points[2]),
      Math.max(points[1], points[3])
    ];
    return rect.map((n) => Math.round(n));
  }
  // ========== 自定义 PDF 嵌入创建器（rect 参数渲染裁剪区域） ==========
  /**
   * 注册自定义 PDF EmbedCreator：当嵌入链接含 rect 参数时，用 pdfjs 实时渲染裁剪区域，
   * 不产生图片文件。无 rect 参数时回退到原始创建器。
   */
  registerCropEmbedCreator() {
    const app = this.ctx.plugin.app;
    this.pdfjsResolver = () => loadPdfjsLib(this.ctx.plugin);
    try {
      this.originalPdfEmbedCreator = app.embedRegistry?.embedByExtension?.["pdf"];
    } catch (e) {
      console.warn("[Screenshot] embedRegistry \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u88C1\u526A\u5D4C\u5165\u6CE8\u518C:", e);
      return;
    }
    if (!this.originalPdfEmbedCreator) {
      console.warn("[Screenshot] \u672A\u627E\u5230\u5185\u7F6E PDF \u5D4C\u5165\u521B\u5EFA\u5668\uFF0C\u8DF3\u8FC7\u88C1\u526A\u5D4C\u5165\u6CE8\u518C");
      return;
    }
    this.wrappedPdfEmbedCreator = (ctx, file, subpath) => {
      const params = new URLSearchParams(subpath.startsWith("#") ? subpath.slice(1) : subpath);
      if (params.has("rect") && params.has("page")) {
        const pageNumber = parseInt(params.get("page"));
        const rect = params.get("rect").split(",").map((n) => parseFloat(n));
        if (Number.isInteger(pageNumber) && rect.length === 4 && rect.every((n) => !isNaN(n))) {
          return new CropEmbed(ctx, file, pageNumber, rect, this.pdfjsResolver ?? void 0);
        }
      }
      return this.originalPdfEmbedCreator ? this.originalPdfEmbedCreator(ctx, file, subpath) : null;
    };
    app.embedRegistry.unregisterExtension("pdf");
    app.embedRegistry.registerExtension("pdf", this.wrappedPdfEmbedCreator);
  }
  /** 恢复原始 PDF EmbedCreator；仅当注册表中仍为本插件包装器时恢复，避免覆盖其他插件 */
  restoreCropEmbedCreator() {
    const app = this.ctx.plugin.app;
    if (!this.originalPdfEmbedCreator)
      return;
    if (app.embedRegistry.embedByExtension["pdf"] !== this.wrappedPdfEmbedCreator) {
      this.originalPdfEmbedCreator = null;
      this.wrappedPdfEmbedCreator = null;
      return;
    }
    app.embedRegistry.unregisterExtension("pdf");
    app.embedRegistry.registerExtension("pdf", this.originalPdfEmbedCreator);
    this.originalPdfEmbedCreator = null;
    this.wrappedPdfEmbedCreator = null;
  }
};
var CropEmbed = class extends import_obsidian7.Component {
  constructor(ctx, file, pageNumber, pdfRect, resolvePdfjs) {
    super();
    this.file = file;
    this.pageNumber = pageNumber;
    this.pdfRect = pdfRect;
    this.resolvePdfjs = resolvePdfjs;
    this.app = ctx.app;
    this.containerEl = ctx.containerEl;
    this.containerEl.addClass("pdf-crop-embed");
  }
  async loadFile() {
    this.showStatus("\u52A0\u8F7D\u4E2D\u2026");
    try {
      const dataUrl = await this.renderCropRegion();
      this.containerEl.empty();
      this.containerEl.createEl("img", { attr: { src: dataUrl } });
    } catch (e) {
      console.error("[Screenshot] PDF \u88C1\u526A\u5D4C\u5165\u6E32\u67D3\u5931\u8D25:", e);
      this.showError();
    }
  }
  showStatus(text) {
    this.containerEl.empty();
    this.containerEl.createEl("div", { text, cls: "pdf-crop-embed-loading" });
  }
  showError() {
    this.containerEl.empty();
    this.containerEl.createEl("div", { text: "PDF \u622A\u56FE\u52A0\u8F7D\u5931\u8D25", cls: "pdf-crop-embed-error" });
  }
  /** 加载 PDF → 渲染整页 → 裁剪目标区域 → 返回 PNG dataURL */
  async renderCropRegion() {
    const pdfjs = await this.loadPdfjs();
    const doc = await pdfDocCache.get(this.file, this.app, () => this.loadPdfjs());
    const page = await doc.getPage(this.pageNumber);
    const fullCanvas = await this.renderFullPage(page, pdfjs);
    return this.cropToRect(fullCanvas, page, pdfjs);
  }
  /**
   * 取得渲染用 pdfjs：优先宿主自带的 window.pdfjsLib，缺失时回退插件自带的副本。
   * 编辑模式（Live Preview）下打开笔记、且当前没有 PDF 视图时，宿主不会暴露 pdfjsLib，
   * 这里必须走回退，否则渲染直接抛错、嵌入区显示「PDF 截图加载失败」。
   */
  loadPdfjs() {
    if (this.resolvePdfjs)
      return this.resolvePdfjs();
    const appPdfjs = window.pdfjsLib;
    if (appPdfjs?.getDocument)
      return Promise.resolve(appPdfjs);
    return Promise.reject(new Error("pdfjs \u4E0D\u53EF\u7528\uFF1A\u672A\u6CE8\u5165\u83B7\u53D6\u5668\u4E14\u5BBF\u4E3B\u672A\u66B4\u9732 window.pdfjsLib"));
  }
  /** 以 2x 缩放渲染整页到离屏 canvas */
  async renderFullPage(page, _pdfjs) {
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }
  /** 从整页 canvas 中裁剪 PDF 空间矩形对应的像素区域 */
  cropToRect(source, page, _pdfjs) {
    const [minX, minY, maxX, maxY] = page.view;
    const pageWidth = maxX - minX;
    const pageHeight = maxY - minY;
    const ratioX = source.width / pageWidth;
    const ratioY = source.height / pageHeight;
    const srcLeft = (this.pdfRect[0] - minX) * ratioX;
    const srcTop = (maxY - this.pdfRect[3]) * ratioY;
    const srcWidth = (this.pdfRect[2] - this.pdfRect[0]) * ratioX;
    const srcHeight = (this.pdfRect[3] - this.pdfRect[1]) * ratioY;
    const result = document.createElement("canvas");
    result.width = Math.max(1, Math.round(srcWidth));
    result.height = Math.max(1, Math.round(srcHeight));
    const ctx = result.getContext("2d");
    ctx.drawImage(source, srcLeft, srcTop, srcWidth, srcHeight, 0, 0, result.width, result.height);
    return result.toDataURL("image/png");
  }
};
var PdfDocCache = class {
  constructor(ttlMs = 6e4) {
    /** 缓存条目：pdfPath → { doc, evictTimer } */
    this.cache = /* @__PURE__ */ new Map();
    /** 加载中的 Promise（防止并发重复加载同一文件） */
    this.pending = /* @__PURE__ */ new Map();
    /** 在途加载代数；clear() 时递增，用于丢弃清空后才完成的加载 */
    this.generation = 0;
    this.ttlMs = ttlMs;
  }
  /**
   * 获取或加载 PDF 文档代理；并发请求共享同一加载 Promise。
   * @param resolvePdfjs pdfjs 获取器（宿主暴露则直接用，缺失时回退插件自带副本）
   */
  async get(file, app, resolvePdfjs) {
    const path = file.path;
    const cached = this.cache.get(path);
    if (cached) {
      window.clearTimeout(cached.evictTimer);
      cached.evictTimer = window.setTimeout(() => this.evict(path), this.ttlMs);
      return cached.doc;
    }
    const loading = this.pending.get(path);
    if (loading)
      return loading;
    const generation = this.generation;
    const promise = (async () => {
      const buffer = await app.vault.readBinary(file);
      const pdfjs = await resolvePdfjs();
      const task = pdfjs.getDocument({
        data: buffer,
        cMapPacked: true,
        cMapUrl: "/lib/pdfjs/cmaps/",
        // Obsidian 内置 pdf.js 5.x 需要显式提供这些资源路径；
        // 尤其是 wasmUrl，否则 JPEG2000（JPX）等图片解码会失败，
        // 导致截图嵌入只渲染出文字、丢失图片。
        wasmUrl: "/lib/pdfjs/wasm/",
        iccUrl: "/lib/pdfjs/iccs/",
        standardFontDataUrl: "/lib/pdfjs/standard_fonts/"
      });
      const doc = await task.promise;
      if (generation !== this.generation) {
        doc.destroy().catch(() => {
        });
        throw new Error("PDF cache was cleared during load");
      }
      const evictTimer = window.setTimeout(() => this.evict(path), this.ttlMs);
      this.cache.set(path, { doc, evictTimer });
      return doc;
    })();
    this.pending.set(path, promise);
    const removePending = () => {
      if (this.pending.get(path) === promise) {
        this.pending.delete(path);
      }
    };
    promise.then(removePending, removePending);
    return promise;
  }
  /** 淘汰并销毁指定 PDF 的缓存文档 */
  evict(path) {
    const entry = this.cache.get(path);
    if (!entry)
      return;
    this.cache.delete(path);
    entry.doc.destroy().catch(() => {
    });
  }
  /** 清空全部缓存（插件卸载时调用） */
  clear() {
    this.generation++;
    for (const { doc, evictTimer } of this.cache.values()) {
      window.clearTimeout(evictTimer);
      doc.destroy().catch(() => {
      });
    }
    this.cache.clear();
    this.pending.clear();
  }
};
var pdfDocCache = new PdfDocCache();

// modules/ScreenshotHighlightModule.ts
var import_obsidian8 = require("obsidian");
var ScreenshotHighlightModule = class extends BasePdfHighlightModule {
  constructor(ctx) {
    super(ctx);
  }
  get renderEventName() {
    return "pagerendered";
  }
  /**
   * 刷新指定 PDF 的截图批注高亮：
   *  - 刚批注写入的条目先记入「显式覆盖层」
   *  - 再从笔记内容重建索引
   *  - 最后重渲染所有已打开该 PDF 的视图
   */
  refresh(pdfFile, explicit) {
    const pdfPath = pdfFile.path;
    if (explicit && explicit.length > 0) {
      for (const e of explicit) {
        this.trackExplicitEntry(pdfPath, e.page, rectKey(e.rect));
      }
    }
    this.rebuildIndexSerialized(pdfPath).then(() => {
      this.renderForPdf(pdfPath);
    });
  }
  /** 覆盖层条目并入截图矩形索引；返回 true 表示已被笔记内容确认（移出覆盖层） */
  applyExplicitEntry(index, page, key) {
    const pageMap = index.get(page);
    if (pageMap?.has(key))
      return true;
    const rect = parseRectKey(key);
    if (!rect)
      return false;
    const map = pageMap ?? /* @__PURE__ */ new Map();
    map.set(key, rect);
    index.set(page, map);
    return false;
  }
  /**
   * 重建单个 PDF 的索引。
   * 与其它高亮模块一致：通过 resolvedLinks 反查链接到该 PDF 的笔记，
   * 再读取笔记原文提取 rect 链接。
   */
  async rebuildIndex(pdfPath) {
    const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof import_obsidian8.TFile))
      return;
    const newIndex = /* @__PURE__ */ new Map();
    const app = this.ctx.plugin.app;
    let readFailed = false;
    for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (!links[pdfPath])
        continue;
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof import_obsidian8.TFile))
        continue;
      try {
        const content = await this.readNoteContent(sourceFile);
        this.extractRectLinks(content, pdfFile, sourcePath, newIndex);
      } catch (e) {
        readFailed = true;
        console.warn("[ScreenshotHighlight] \u8BFB\u53D6\u7B14\u8BB0\u5931\u8D25:", sourcePath, e);
      }
    }
    if (readFailed && this.indexCache.has(pdfPath))
      return;
    this.indexCache.set(pdfPath, newIndex);
  }
  /** 从笔记原文中提取指向指定 PDF 的 rect 嵌入链接并写入索引 */
  extractRectLinks(content, pdfFile, sourcePath, index) {
    const app = this.ctx.plugin.app;
    const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&rect=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = linkRegex.exec(content)) !== null) {
      const linkpath = m[1].trim();
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (target !== pdfFile)
        continue;
      const page = parseInt(m[2], 10);
      const parts = m[3].split(",").map((s) => parseFloat(s.trim()));
      if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
        continue;
      const [a, b, c, d] = parts;
      const rect = {
        x1: Math.min(a, c),
        y1: Math.min(b, d),
        x2: Math.max(a, c),
        y2: Math.max(b, d)
      };
      const pageMap = index.get(page) ?? /* @__PURE__ */ new Map();
      pageMap.set(rectKey([rect.x1, rect.y1, rect.x2, rect.y2]), rect);
      index.set(page, pageMap);
    }
  }
  /** 渲染单页的截图批注高亮层（pagerendered 时调用） */
  renderPageHighlights(pdfPath, pageView) {
    if (!pageView?.div)
      return;
    const pageDiv = pageView.div;
    const pageNumber = parseInt(pageDiv.dataset.pageNumber ?? "0", 10) || 0;
    const index = this.indexCache.get(pdfPath);
    if (!index)
      return;
    const pageMap = index.get(pageNumber);
    if (!pageMap || pageMap.size === 0) {
      pageDiv.querySelector(".pdf-screenshot-highlight-layer")?.remove();
      return;
    }
    const view = pageView.pdfPage?.view;
    if (!view || view.length < 4)
      return;
    const [minX, minY, maxX, maxY] = view;
    const pageWidth = maxX - minX;
    const pageHeight = maxY - minY;
    if (pageWidth <= 0 || pageHeight <= 0)
      return;
    pageDiv.querySelector(".pdf-screenshot-highlight-layer")?.remove();
    const layerEl = pageDiv.createDiv("pdf-screenshot-highlight-layer");
    for (const h of pageMap.values()) {
      const rectEl = layerEl.createDiv("pdf-screenshot-crop-highlight");
      rectEl.setAttr("data-pdf-jump-page", String(pageNumber));
      rectEl.setAttr("data-pdf-jump-rect", rectKey([h.x1, h.y1, h.x2, h.y2]));
      Object.assign(rectEl.style, {
        left: `${(100 * (h.x1 - minX) / pageWidth).toFixed(3)}%`,
        top: `${(100 * (maxY - h.y2) / pageHeight).toFixed(3)}%`,
        width: `${(100 * (h.x2 - h.x1) / pageWidth).toFixed(3)}%`,
        height: `${(100 * (h.y2 - h.y1) / pageHeight).toFixed(3)}%`
      });
    }
  }
};
function rectKey(rect) {
  return rect.map((n) => Number(n.toFixed(4))).join(",");
}
function parseRectKey(key) {
  const parts = key.split(",").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p)))
    return null;
  const [x1, y1, x2, y2] = parts;
  return { x1, y1, x2, y2 };
}

// modules/OcrModule.ts
var import_obsidian10 = require("obsidian");

// modules/OcrService.ts
var import_obsidian9 = require("obsidian");
var OcrService = class {
  constructor(baseUrl, apiKey) {
    /** 是否清洗 OCR 输出（默认开启）；关闭时原样保留模型返回文本 */
    this.sanitizeOutput = true;
    /** 超时后仍在运行的底层请求（requestUrl 不支持中止，仅跟踪以防 unhandled rejection） */
    this.zombieRequest = null;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey ?? "";
  }
  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/+$/, "");
  }
  setApiKey(key) {
    this.apiKey = key;
  }
  setSanitizeOutput(value) {
    this.sanitizeOutput = value;
  }
  /** 拉取服务器可用模型列表 */
  async listModels() {
    const res = await this.request({
      url: `${this.baseUrl}/v1/models`,
      method: "GET"
    }, 1e4);
    const data = res.json;
    const models = data?.data ?? [];
    return models.map((m) => typeof m === "string" ? m : m?.id ?? "").filter(Boolean);
  }
  /** 自动选择模型：设置指定 → 视觉模型按优先级（推荐 paddleocr-vl-1.6 优先） */
  async resolveModel(configured) {
    if (configured.trim())
      return configured.trim();
    const models = await this.listModels();
    if (models.length === 0)
      throw new Error("\u670D\u52A1\u5668\u672A\u8FD4\u56DE\u4EFB\u4F55\u6A21\u578B");
    const priority = ["paddleocr-vl-1.6", "qwen3-vl", "paddleocr-vl-1.5"];
    for (const key of priority) {
      const hit = models.find((id) => id.includes(key));
      if (hit)
        return hit;
    }
    const preferred = models.find((m) => /ocr|vision|vl|qwen|llava|gemini/i.test(m));
    if (preferred)
      return preferred;
    const preview = models.slice(0, 10).join(", ") + (models.length > 10 ? " \u2026" : "");
    throw new Error(
      `\u670D\u52A1\u5668\u4E0A\u672A\u627E\u5230\u89C6\u89C9\u6A21\u578B\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u624B\u52A8\u586B\u5199\u300COCR \u6A21\u578B\u300D\u3002\u53EF\u7528\u6A21\u578B\uFF1A${preview}`
    );
  }
  /**
   * 识别截图图像中的文字（纯文本输出）
   * @param imageDataUrl data:image/jpeg;base64,...
   * @returns 识别文本（可能为空字符串）与停止原因
   */
  async ocrText(imageDataUrl, model, prompt, timeoutSec, maxTokens) {
    const isPaddleOcr = /paddleocr-vl/i.test(model);
    try {
      return await this.requestChatWithImageUrl(
        prompt,
        imageDataUrl,
        model,
        timeoutSec,
        maxTokens,
        isPaddleOcr
      );
    } catch (e) {
      if (!isRetryableHttpError(e))
        throw e;
      try {
        return await this.requestChatWithImageUrl(
          prompt,
          imageDataUrl,
          model,
          timeoutSec,
          maxTokens,
          !isPaddleOcr
        );
      } catch (e2) {
        throw new Error(`${e.message}\uFF08\u91CD\u8BD5\u4ECD\u5931\u8D25: ${e2.message}\uFF09`);
      }
    }
  }
  async requestChatWithImageUrl(prompt, imageDataUrl, model, timeoutSec, maxTokens, imageFirst) {
    const imgPart = { type: "image_url", image_url: { url: imageDataUrl } };
    const textPart = { type: "text", text: prompt };
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: imageFirst ? [imgPart, textPart] : [textPart, imgPart]
        }
      ],
      temperature: 0,
      max_tokens: maxTokens
    };
    const res = await this.request({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, timeoutSec * 1e3);
    const choice = res.json?.choices?.[0];
    const raw = choice?.message?.content ?? "";
    return {
      text: this.sanitizeOutput ? sanitizeOcrText(raw) : raw,
      finishReason: choice?.finish_reason ?? null
    };
  }
  /** 基于 requestUrl 的请求；超过 timeoutMs 抛超时错误 */
  async request(params, timeoutMs) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        reject(new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)}s\uFF09`));
      }, timeoutMs);
    });
    const headers = { ...params.headers ?? {} };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const requestPromise = (async () => {
      const res = await (0, import_obsidian9.requestUrl)({
        throw: false,
        ...params,
        headers
      });
      if (res.status < 200 || res.status >= 300) {
        const errText = typeof res.text === "string" ? res.text.slice(0, 300) : "";
        throw new Error(`HTTP ${res.status} ${errText}`);
      }
      return res;
    })();
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("\u8BF7\u6C42\u8D85\u65F6")) {
        this.trackZombie(requestPromise);
      }
      throw e;
    } finally {
      if (timer !== null)
        window.clearTimeout(timer);
    }
  }
  /** 跟踪超时后仍在进行的底层请求，附加 catch 防止 unhandled rejection */
  trackZombie(promise) {
    if (this.zombieRequest && this.zombieRequest !== promise) {
      console.warn("[OcrService] \u68C0\u6D4B\u5230\u7D2F\u79EF\u7684\u50F5\u5C38\u8BF7\u6C42\uFF08\u524D\u4E00\u6B21\u8D85\u65F6\u8BF7\u6C42\u4ECD\u5728\u8FDB\u884C\uFF09");
      this.zombieRequest.catch(() => {
      });
    }
    this.zombieRequest = promise;
    promise.finally(() => {
      if (this.zombieRequest === promise) {
        this.zombieRequest = null;
      }
    });
    promise.catch(() => {
    });
  }
};
function isRetryableHttpError(err) {
  const m = /^HTTP (\d{3})/.exec(err.message ?? "");
  if (!m)
    return false;
  const status = Number(m[1]);
  return status === 400 || status === 422;
}
function sanitizeOcrText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[\u21B5\u23CE\u240D\u2424\u2937\u2028\u2029]/g, "\n").replace(/<[^>]*>/g, " ").replace(/<\|[^|]*\|>/g, " ").replace(/\\[()[\]]/g, " ").replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1").replace(/\\times/g, "\xD7").replace(/\\pm/g, "\xB1").replace(/\\leq/g, "\u2264").replace(/\\geq/g, "\u2265").replace(/\\neq/g, "\u2260").replace(/\\approx/g, "\u2248").replace(/\\rightarrow|\\to/g, "\u2192").replace(/\\cdot/g, "\xB7").replace(/^\s*(?:\[\d+\]\s*)+$/gm, " ").replace(/```[\s\S]*?```/g, " ").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s{0,3}(?:[-*_]){3,}\s*$/gm, "").replace(/\*\*|__/g, "").replace(/(^|[^\w])\*([^\s*][^*]*)\*([^\w]|$)/g, "$1$2$3").replace(/^\s*>\s?/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/\|/g, " ").replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => {
    switch (m) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&amp;":
        return "&";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      case "&nbsp;":
        return " ";
      default:
        return " ";
    }
  }).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// modules/OcrModule.ts
var OcrModule = class extends BaseCropModeModule {
  constructor(ctx, pdfModule) {
    super(ctx);
    this.buttonClass = "ocr-toolbar-button";
    this.selectingClass = "ocr-selecting";
    this.boxClass = "ocr-crop-box";
    this.buttonIcon = "crop";
    this.buttonTooltip = "\u622A\u56FE OCR \u6279\u6CE8\u5230\u7B14\u8BB0";
    this.commandId = "ocr-screenshot-annotate";
    this.commandName = "\u622A\u56FE OCR \u6279\u6CE8\u5230\u7B14\u8BB0";
    this.busyNotice = "\u6B63\u5728\u8BC6\u522B\u4E2D\uFF0C\u8BF7\u7B49\u8BC6\u522B\u5B8C\u6210\u540E\u518D\u6846\u9009";
    /** 高亮模块刷新回调（批注成功后触发即时高亮），由 main.ts 注入 */
    this.refreshHighlights = null;
    this.pdfModule = pdfModule;
    this.service = new OcrService(this.ctx.getSettings().ocrServerUrl, this.ctx.getSettings().ocrApiKey);
  }
  setHighlightRefresh(cb) {
    this.refreshHighlights = cb;
  }
  // ========== 框选完成 → 截图 OCR 批注 ==========
  async onCropComplete(leaf, pageDiv, pageRect) {
    this.setBusy(true);
    try {
      await this.doCaptureAndAnnotate(leaf, pageDiv, pageRect);
    } catch (e) {
      console.error("[Ocr] \u622A\u56FE\u6279\u6CE8\u5931\u8D25:", e);
      new import_obsidian10.Notice(`\u622A\u56FE\u6279\u6CE8\u5931\u8D25: ${e.message}`);
    } finally {
      this.setBusy(false);
    }
  }
  async doCaptureAndAnnotate(leaf, pageDiv, pageRect) {
    if (!leaf)
      return;
    const pageNum = parseInt(pageDiv.dataset?.pageNumber ?? "0", 10) || 0;
    if (pageNum <= 0) {
      new import_obsidian10.Notice("\u65E0\u6CD5\u786E\u5B9A\u622A\u56FE\u9875\u7801");
      return;
    }
    const bl = pageDiv.clientLeft;
    const bt = pageDiv.clientTop;
    const pw = pageDiv.clientWidth;
    const ph = pageDiv.clientHeight;
    const ocrRect = pw > 0 && ph > 0 ? {
      x: clamp01((pageRect.x - bl) / pw),
      y: clamp01((pageRect.y - bt) / ph),
      w: clamp01(pageRect.width / pw),
      h: clamp01(pageRect.height / ph)
    } : null;
    let imageDataUrl = null;
    const cropOpts = this.cropOptions();
    const canvas = pageDiv.querySelector("canvas");
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      try {
        imageDataUrl = cropFromCanvas(canvas, pageRect, pageDiv, cropOpts);
      } catch (e) {
        console.warn("[Ocr] \u753B\u5E03\u88C1\u526A\u5931\u8D25\uFF0C\u5C1D\u8BD5\u515C\u5E95\u6E32\u67D3:", e);
      }
    }
    if (!imageDataUrl) {
      try {
        const proxy = this.getPdfDocumentProxy(leaf);
        if (!proxy)
          throw new Error("\u65E0\u6CD5\u83B7\u53D6 PDF \u6587\u6863\u4EE3\u7406");
        imageDataUrl = await this.renderCropFallback(proxy, pageNum, pageRect, pageDiv, cropOpts);
      } catch (e) {
        console.warn("[Ocr] \u622A\u56FE\u515C\u5E95\u6E32\u67D3\u5931\u8D25:", e);
        new import_obsidian10.Notice("\u9875\u9762\u5C1A\u672A\u6E32\u67D3\uFF0C\u8BF7\u6EDA\u52A8\u89C6\u56FE\u540E\u91CD\u8BD5");
        return;
      }
    }
    if (!imageDataUrl)
      return;
    const ok = await this.ocrAndAnnotate(leaf, imageDataUrl, pageNum, ocrRect);
    if (ok && ocrRect && this.pdfModule.shouldIncludeOriginalText()) {
      const file = leaf.view.file;
      if (file) {
        this.refreshHighlights?.(file, [{ page: pageNum, rect: ocrRect }]);
      }
    }
  }
  /** 兼容不同 Obsidian/pdfjs 内部结构，多路径获取 PDFDocumentProxy */
  getPdfDocumentProxy(leaf) {
    const v = leaf.view.viewer;
    return v?.child?.pdfViewer?.pdfDocument ?? v?.child?.pdfDocument ?? v?.pdfDocument ?? null;
  }
  // ========== OCR + 批注 ==========
  async ocrAndAnnotate(leaf, imageDataUrl, pageNum, ocrRect) {
    const file = leaf.view.file;
    if (!file) {
      new import_obsidian10.Notice("\u65E0\u6CD5\u8BC6\u522B\u5F53\u524D PDF \u6587\u4EF6");
      return false;
    }
    const settings = this.ctx.getSettings();
    this.service.setBaseUrl(settings.ocrServerUrl);
    this.service.setApiKey(settings.ocrApiKey);
    this.service.setSanitizeOutput(settings.ocrSanitizeOutput !== false);
    let model;
    try {
      model = await this.service.resolveModel(settings.ocrModel);
    } catch (e) {
      new import_obsidian10.Notice(`\u9009\u62E9 OCR \u6A21\u578B\u5931\u8D25: ${e.message}`);
      return false;
    }
    const notice = new import_obsidian10.Notice("OCR \u8BC6\u522B\u4E2D\u2026", 0);
    try {
      const { text, finishReason } = await this.service.ocrText(
        imageDataUrl,
        model,
        settings.ocrPrompt,
        settings.ocrRequestTimeoutSec,
        settings.ocrMaxTokens
      );
      notice.hide();
      if (finishReason === "length") {
        new import_obsidian10.Notice(
          "OCR \u8F93\u51FA\u5DF2\u8FBE\u300C\u6700\u5927\u8F93\u51FA\u4EE4\u724C\u300D\u4E0A\u9650\uFF0C\u8BC6\u522B\u6587\u672C\u53EF\u80FD\u88AB\u622A\u65AD\uFF08\u53EF\u5728\u8BBE\u7F6E\u4E2D\u8C03\u5927\u8BE5\u503C\uFF0C\u6216\u7F29\u5C0F\u6846\u9009\u8303\u56F4\uFF09",
          8e3
        );
      }
      if (!text.trim()) {
        new import_obsidian10.Notice("\u672A\u8BC6\u522B\u5230\u6587\u5B57\uFF0C\u8BF7\u8C03\u6574\u6846\u9009\u533A\u57DF\u540E\u91CD\u8BD5");
        return false;
      }
      const ok = await this.pdfModule.annotateOcrText(file, text, pageNum, ocrRect ?? void 0);
      if (ok) {
        new import_obsidian10.Notice("OCR \u6279\u6CE8\u5DF2\u5199\u5165\u7B14\u8BB0");
      }
      return ok;
    } catch (e) {
      notice.hide();
      new import_obsidian10.Notice(`OCR \u5931\u8D25: ${e.message}`);
      return false;
    }
  }
  /** 从设置读取截图放大参数（非法值回退默认；minSidePx<=0 表示关闭放大） */
  cropOptions() {
    const s = this.ctx.getSettings();
    const minSidePx = Math.max(0, Math.floor(Number(s.ocrMinSidePx) || 0));
    const maxScale = Math.min(8, Math.max(1, Number(s.ocrMaxUpscaleFactor) || 4));
    return { minSidePx, maxScale };
  }
  // ========== 兜底整页渲染（canvas 缺失时） ==========
  async renderCropFallback(proxy, pageNum, pageRect, pageDiv, cropOpts = { minSidePx: 512, maxScale: 4 }) {
    const page = await proxy.getPage(pageNum);
    const scale = 2;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03");
    await page.render({ canvasContext: ctx, viewport, background: "white" }).promise;
    if (!pageDiv) {
      return canvas.toDataURL("image/jpeg", 0.92);
    }
    const pr = pageDiv.getBoundingClientRect();
    const dpr = canvas.width / pr.width;
    const sx = pageRect.x * dpr;
    const sy = pageRect.y * dpr;
    const sw = pageRect.width * dpr;
    const sh = pageRect.height * dpr;
    return cropCanvasRegion(canvas, sx, sy, sw, sh, cropOpts);
  }
};
function cropFromCanvas(canvas, pageRect, pageDiv, cropOpts) {
  const canvasRect = canvas.getBoundingClientRect();
  const pr = pageDiv.getBoundingClientRect();
  const dprX = canvas.width / canvasRect.width;
  const dprY = canvas.height / canvasRect.height;
  const sx = (pageRect.x - (canvasRect.left - pr.left)) * dprX;
  const sy = (pageRect.y - (canvasRect.top - pr.top)) * dprY;
  const sw = pageRect.width * dprX;
  const sh = pageRect.height * dprY;
  return cropCanvasRegion(canvas, sx, sy, sw, sh, cropOpts);
}
function cropCanvasRegion(source, sx, sy, sw, sh, cropOpts) {
  const cx = Math.max(0, sx);
  const cy = Math.max(0, sy);
  const cw = Math.min(sw, source.width - cx);
  const ch = Math.min(sh, source.height - cy);
  if (cw < 1 || ch < 1)
    throw new Error("\u622A\u56FE\u533A\u57DF\u8D85\u51FA\u9875\u9762\u8303\u56F4");
  let scale = 1;
  if (cropOpts.minSidePx > 0) {
    const minSide = Math.min(cw, ch);
    scale = Math.min(
      Math.max(1, cropOpts.maxScale),
      Math.max(1, cropOpts.minSidePx / minSide)
    );
  }
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const ctx = out.getContext("2d");
  if (!ctx)
    throw new Error("\u65E0\u6CD5\u521B\u5EFA\u622A\u56FE\u753B\u5E03");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, cx, cy, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.92);
}
function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

// modules/OcrHighlightModule.ts
var import_obsidian11 = require("obsidian");
var OcrHighlightModule = class extends BasePdfHighlightModule {
  constructor(ctx) {
    super(ctx);
  }
  get renderEventName() {
    return "pagerendered";
  }
  /**
   * 刷新指定 PDF 的高亮：
   *  - 刚批注写入的条目先记入「显式覆盖层」（笔记可能尚未落盘 / resolvedLinks
   *    尚未收录新链接），由串行重建统一并入索引，规避 metadataCache 落盘延迟
   *  - 再从笔记内容重建索引（覆盖层条目会被笔记内容确认并自动清理）
   *  - 最后重渲染所有已打开该 PDF 的视图
   */
  refresh(pdfFile, explicit) {
    const pdfPath = pdfFile.path;
    if (explicit && explicit.length > 0) {
      for (const e of explicit) {
        this.trackExplicitEntry(pdfPath, e.page, rectKey2(e.rect));
      }
    }
    this.rebuildIndexSerialized(pdfPath).then(() => {
      this.renderForPdf(pdfPath);
    });
  }
  /** 覆盖层条目并入 OCR 矩形索引；返回 true 表示已被笔记内容确认（移出覆盖层） */
  applyExplicitEntry(index, page, key) {
    const pageMap = index.get(page);
    if (pageMap?.has(key))
      return true;
    const rect = parseRectKey2(key);
    if (!rect)
      return false;
    const map = pageMap ?? /* @__PURE__ */ new Map();
    map.set(key, { nx: rect.x, ny: rect.y, nw: rect.w, nh: rect.h });
    index.set(page, map);
    return false;
  }
  /**
   * 重建单个 PDF 的索引。
   * 与 PdfHighlightModule 同：metadataCache 不记录指向 PDF 的正文链接，
   * 因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再读取笔记原文提取 ocr 链接。
   */
  async rebuildIndex(pdfPath) {
    const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof import_obsidian11.TFile))
      return;
    const newIndex = /* @__PURE__ */ new Map();
    const app = this.ctx.plugin.app;
    let readFailed = false;
    for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (!links[pdfPath])
        continue;
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof import_obsidian11.TFile))
        continue;
      try {
        const content = await this.readNoteContent(sourceFile);
        this.extractOcrLinks(content, pdfFile, sourcePath, newIndex);
      } catch (e) {
        readFailed = true;
        console.warn("[OcrHighlight] \u8BFB\u53D6\u7B14\u8BB0\u5931\u8D25:", sourcePath, e);
      }
    }
    if (readFailed && this.indexCache.has(pdfPath))
      return;
    this.indexCache.set(pdfPath, newIndex);
  }
  /** 从笔记原文中提取指向指定 PDF 的 ocr 链接并写入索引 */
  extractOcrLinks(content, pdfFile, sourcePath, index) {
    const app = this.ctx.plugin.app;
    const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&ocr=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = linkRegex.exec(content)) !== null) {
      const linkpath = m[1].trim();
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (target !== pdfFile)
        continue;
      const page = parseInt(m[2], 10);
      const parts = m[3].split(",").map((s) => parseFloat(s.trim()));
      if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
        continue;
      const [nx, ny, nw, nh] = parts;
      const pageMap = index.get(page) ?? /* @__PURE__ */ new Map();
      pageMap.set(rectKey2({ x: nx, y: ny, w: nw, h: nh }), { nx, ny, nw, nh });
      index.set(page, pageMap);
    }
  }
  /** 渲染单页的高亮层（pagerendered 时调用，缩放/翻页会重发事件 → 自动重建） */
  renderPageHighlights(pdfPath, pageView) {
    if (!pageView?.div)
      return;
    const pageDiv = pageView.div;
    const pageNumber = parseInt(pageDiv.dataset.pageNumber ?? "0", 10) || 0;
    const index = this.indexCache.get(pdfPath);
    if (!index)
      return;
    const pageMap = index.get(pageNumber);
    if (!pageMap || pageMap.size === 0) {
      pageDiv.querySelector(".ocr-highlight-layer")?.remove();
      return;
    }
    pageDiv.querySelector(".ocr-highlight-layer")?.remove();
    const layerEl = pageDiv.createDiv("ocr-highlight-layer");
    for (const h of pageMap.values()) {
      const rectEl = layerEl.createDiv("ocr-crop-highlight");
      rectEl.setAttr("data-pdf-jump-page", String(pageNumber));
      rectEl.setAttr("data-pdf-jump-ocr", rectKey2({ x: h.nx, y: h.ny, w: h.nw, h: h.nh }));
      Object.assign(rectEl.style, {
        left: `${(h.nx * 100).toFixed(3)}%`,
        top: `${(h.ny * 100).toFixed(3)}%`,
        width: `${(h.nw * 100).toFixed(3)}%`,
        height: `${(h.nh * 100).toFixed(3)}%`
      });
    }
  }
};
function rectKey2(r) {
  return `${Number(r.x.toFixed(4))},${Number(r.y.toFixed(4))},${Number(r.w.toFixed(4))},${Number(r.h.toFixed(4))}`;
}
function parseRectKey2(key) {
  const parts = key.split(",").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p)))
    return null;
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

// modules/AnnotationModeModule.ts
var import_obsidian12 = require("obsidian");
var AnnotationModeModule = class {
  constructor(ctx, pdfModule) {
    /** 已注入按钮的叶子 → 按钮元素 */
    this.toolbarButtons = /* @__PURE__ */ new Map();
    /** 本模块创建过的全部按钮（含多标签页下未进 map 的隐藏按钮），用于卸载清理 */
    this.createdButtons = /* @__PURE__ */ new Set();
    /** 轮询任务移除函数（卸载时注销共享轮询） */
    this.removePollTask = null;
    this.ctx = ctx;
    this.pdfModule = pdfModule;
  }
  load() {
    const plugin = this.ctx.plugin;
    this.pdfModule.setIncludeOriginalTextProvider(
      () => this.ctx.getSettings().annotationIncludeOriginalText === true
    );
    plugin.registerEvent(
      plugin.app.workspace.on("layout-change", () => {
        this.injectToolbarButtons();
        this.refreshAllButtonStates();
      })
    );
    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", () => {
        this.injectToolbarButtons();
        this.refreshAllButtonStates();
      })
    );
    this.removePollTask = toolbarPoller.add(() => {
      this.injectToolbarButtons();
      this.refreshAllButtonStates();
    });
    toolbarPoller.start();
    plugin.addCommand({
      id: "toggle-include-original-text",
      name: "\u5207\u6362\u300C\u9644\u5E26\u539F\u6587\u300D\u6279\u6CE8\u6A21\u5F0F\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5F00\u542F\u65F6\u6279\u6CE8\u5305\u542B\u539F\u6587\uFF09",
      checkCallback: (checking) => {
        const leaf = plugin.app.workspace.activeLeaf;
        if (!leaf || leaf.view.getViewType() !== "pdf")
          return false;
        if (!checking)
          this.toggleMode();
        return true;
      }
    });
    this.injectToolbarButtons();
    plugin.register(() => {
      for (const btn of this.createdButtons) {
        btn.remove();
      }
      this.createdButtons.clear();
      this.toolbarButtons.clear();
    });
  }
  unload() {
    this.removePollTask?.();
    this.removePollTask = null;
    this.toolbarButtons.clear();
    this.createdButtons.clear();
  }
  // ========== 模式状态 ==========
  /** 切换「附带原文」开关，同步写入设置并持久化 */
  toggleMode() {
    const settings = this.ctx.getSettings();
    settings.annotationIncludeOriginalText = !settings.annotationIncludeOriginalText;
    void this.ctx.saveSettings().catch((e) => {
      console.error("[AnnotationMode] \u4FDD\u5B58\u300C\u9644\u5E26\u539F\u6587\u300D\u5F00\u5173\u5931\u8D25:", e);
    });
    this.refreshAllButtonStates();
  }
  // ========== 工具条按钮 ==========
  injectToolbarButtons() {
    pruneStaleLeaves(this.ctx.plugin.app, this.toolbarButtons);
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const viewer = leaf.view.viewer;
      const toolbar = viewer?.child?.toolbar;
      if (!toolbar)
        return;
      const pageNumberEl = toolbar.pageNumberEl;
      if (!pageNumberEl || !pageNumberEl.parentElement)
        return;
      const existing = pageNumberEl.parentElement.querySelector(".pdfreader-annotation-mode-button");
      if (existing) {
        this.toolbarButtons.set(leaf, existing);
        return;
      }
      const stale = this.toolbarButtons.get(leaf);
      if (stale && !stale.isConnected) {
        stale.remove();
        this.toolbarButtons.delete(leaf);
      }
      const btn = document.createElement("div");
      btn.addClass("clickable-icon");
      btn.addClass("pdfreader-annotation-mode-button");
      (0, import_obsidian12.setIcon)(btn, "link");
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.toggleMode();
      });
      pageNumberEl.after(btn);
      this.toolbarButtons.set(leaf, btn);
      this.createdButtons.add(btn);
      this.applyButtonState(btn);
    });
  }
  /**
   * 重算所有按钮激活态（开关切换 / 工具条重建后）：
   * 直接扫描各叶子当前可见工具条上的按钮，不依赖可能指向隐藏标签页按钮的 map。
   */
  refreshAllButtonStates() {
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const viewer = leaf.view.viewer;
      const toolbar = viewer?.child?.toolbar;
      const pageNumberEl = toolbar?.pageNumberEl;
      if (!pageNumberEl?.parentElement)
        return;
      const btn = pageNumberEl.parentElement.querySelector(".pdfreader-annotation-mode-button");
      if (btn)
        this.applyButtonState(btn);
    });
  }
  /** 按当前开关切换激活态与提示文案（提示中的链接标签跟随设置） */
  applyButtonState(btn) {
    const on = this.ctx.getSettings().annotationIncludeOriginalText === true;
    const label = this.ctx.getSettings().annotationLinkLabel || "\u5B9A\u4F4D";
    btn.toggleClass("is-active", on);
    if (on) {
      (0, import_obsidian12.setTooltip)(btn, `\u9644\u5E26\u539F\u6587\u5DF2\u5F00\u542F\uFF08\u70B9\u51FB\u5173\u95ED\uFF09
\u6587\u5B57\uFF1A\u539F\u6587 / ${label} / \u7B14\u8BB0\uFF1A
OCR\uFF1A\u8BC6\u522B\u6587\u5B57 / ${label} / \u7B14\u8BB0\uFF1A
\u622A\u56FE\uFF1A\u56FE\u7247 / ${label} / \u7B14\u8BB0\uFF1A`);
    } else {
      (0, import_obsidian12.setTooltip)(btn, `\u9644\u5E26\u539F\u6587\u5DF2\u5173\u95ED\uFF08\u9ED8\u8BA4\uFF0C\u70B9\u51FB\u5F00\u542F\uFF09
\u6587\u5B57\uFF1A\u4EC5${label}
OCR\uFF1A\u4EC5\u8BC6\u522B\u6587\u5B57
\u622A\u56FE\uFF1A\u4EC5\u56FE\u7247`);
    }
  }
};

// modules/CalloutPasteModule.ts
var import_view2 = require("@codemirror/view");
var CALLOUT_MARKER_RE = /^>\s*\[!pdf-annotation\]/;
var QUOTE_PREFIX_RE = /^>\s?/;
var CalloutPasteModule = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  load() {
    this.ctx.plugin.registerEditorExtension(
      import_view2.EditorView.domEventHandlers({
        paste: (event, view) => this.handlePaste(event, view)
      })
    );
  }
  /** registerEditorExtension 由插件卸载时自动清理，无需显式注销 */
  unload() {
  }
  /** 命中批注 callout 内的多行粘贴时返回 true（已接管插入）；否则 false 放行默认行为 */
  handlePaste(event, view) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text || !text.includes("\n"))
      return false;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    if (!isInsideAnnotationCallout(view.state.doc, line.number))
      return false;
    event.preventDefault();
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const insert = normalized.split("\n").map((l, i) => {
      const stripped = stripQuote(l);
      if (i === 0)
        return stripped;
      return stripped ? "> " + stripped : ">";
    }).join("\n");
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      scrollIntoView: true,
      userEvent: "input.paste"
    });
    return true;
  }
};
function isInsideAnnotationCallout(doc, lineNo) {
  for (let l = lineNo; l >= 1; l--) {
    const text = doc.line(l).text;
    if (!text.trim())
      return false;
    if (CALLOUT_MARKER_RE.test(text))
      return true;
  }
  return false;
}
function stripQuote(line) {
  return line.replace(QUOTE_PREFIX_RE, "");
}

// modules/QuickTagModule.ts
var import_obsidian13 = require("obsidian");

// modules/tagVocabulary.ts
var LEGACY_VOCABULARY_FILE = "\u51E1\u4F8B\u201C#\u201D.md";
function newTagId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function")
    return c.randomUUID();
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function renameTag(tags, pending, id, newName) {
  const target = tags.find((t) => t.id === id);
  if (!target)
    return { tags, pending };
  const nextTags = tags.map((t) => t.id === id ? { ...t, name: newName } : t);
  const nextPending = pending.map((p) => ({ ...p }));
  const idx = nextPending.findIndex((p) => p.id === id);
  const from = idx >= 0 ? nextPending[idx].from : target.name;
  if (from === newName) {
    if (idx >= 0)
      nextPending.splice(idx, 1);
  } else if (idx >= 0) {
    nextPending[idx] = { id, from, to: newName };
  } else {
    nextPending.push({ id, from, to: newName });
  }
  return { tags: nextTags, pending: nextPending };
}
function removeTag(tags, pending, id) {
  return {
    tags: tags.filter((t) => t.id !== id),
    pending: pending.filter((p) => p.id !== id)
  };
}
function moveTag(tags, id, delta) {
  const i = tags.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= tags.length)
    return tags;
  const next = [...tags];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
function findDuplicateName(tags, name, excludeId) {
  const key = name.trim().toLowerCase();
  if (!key)
    return null;
  return tags.find((t) => t.id !== excludeId && t.name.trim().toLowerCase() === key) ?? null;
}
function splitLineChange(before, after) {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p])
    p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s])
    s++;
  let prefix = before.slice(0, p);
  let removed = before.slice(p, before.length - s);
  let added = after.slice(p, after.length - s);
  if (prefix.endsWith("#") && removed && added && !removed.startsWith("#")) {
    prefix = prefix.slice(0, -1);
    removed = `#${removed}`;
    added = `#${added}`;
  }
  return { prefix, removed, added, suffix: before.slice(before.length - s) };
}
function parseTagText(text) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, index) => {
    let line = raw.trim();
    if (!line)
      return;
    if (line.startsWith("%%"))
      return;
    if (line.startsWith("```"))
      return;
    if (/^-{3,}$/.test(line))
      return;
    line = line.replace(/^>\s*/, "").replace(/^[-*+]\s+/, "").replace(/^#+\s*/, "").trim();
    if (!line)
      return;
    const sep = line.search(/[：:]/);
    const name = (sep >= 0 ? line.slice(0, sep) : line).trim();
    const description = sep >= 0 ? line.slice(sep + 1).trim() : "";
    if (!name)
      return;
    const key = name.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    entries.push({ name, description, line: index });
  });
  return entries;
}
function mapLines(text, fn) {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence)
      continue;
    lines[i] = fn(lines[i]);
  }
  return lines.join("\n");
}
function outsideInlineCode(line, fn) {
  if (!line.includes("`"))
    return fn(line);
  const parts = line.split("`");
  for (let i = 0; i < parts.length; i += 2)
    parts[i] = fn(parts[i]);
  return parts.join("`");
}
function applyTagOps(text, ops) {
  const root = { children: /* @__PURE__ */ new Map(), op: null };
  let usable = 0;
  for (const op of ops) {
    if (!op.from)
      continue;
    let node = root;
    for (const ch of op.from) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: /* @__PURE__ */ new Map(), op: null };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.op = op;
    usable++;
  }
  if (usable === 0)
    return { text, count: 0 };
  const TAG_CHAR = /[\p{L}\p{N}_\-\/]/u;
  let count = 0;
  const out = mapLines(text, (line) => outsideInlineCode(line, (seg) => {
    let result = "";
    let i = 0;
    while (i < seg.length) {
      const c = seg.charAt(i);
      const atLead = i === 0 || /\s/.test(seg.charAt(i - 1));
      if (c !== "#" || !atLead) {
        result += c;
        i++;
        continue;
      }
      let node = root;
      let best = null;
      let j = i + 1;
      while (j < seg.length) {
        const next = node.children.get(seg.charAt(j));
        if (!next)
          break;
        node = next;
        j++;
        const after = j < seg.length ? seg.charAt(j) : "";
        if (node.op && !(after && TAG_CHAR.test(after))) {
          best = { op: node.op, end: j };
        }
      }
      if (!best) {
        result += c;
        i++;
        continue;
      }
      count++;
      if (best.op.to === null) {
        let end = best.end;
        const endsLine = end >= seg.length || seg.charAt(end) === "\r";
        if (!endsLine && /\s/.test(seg.charAt(end))) {
          end++;
          const restIsEmpty = end >= seg.length || /\s/.test(seg.charAt(end));
          if (restIsEmpty && result.endsWith(" "))
            result = result.slice(0, -1);
        } else if (endsLine && result.endsWith(" ")) {
          result = result.slice(0, -1);
        }
        i = end;
      } else {
        result += `#${best.op.to}`;
        i = best.end;
      }
    }
    return result;
  }));
  return { text: out, count };
}
function collectTagsFromText(text) {
  const counts = /* @__PURE__ */ new Map();
  mapLines(text, (line) => {
    outsideInlineCode(line, (seg) => {
      const re = /(?:^|\s)#([\p{L}\p{N}_\-\/]+)/gu;
      let m;
      while ((m = re.exec(seg)) !== null) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      return seg;
    });
    return line;
  });
  return counts;
}

// modules/QuickTagModule.ts
var QuickTagSuggestModal = class extends import_obsidian13.SuggestModal {
  constructor(app, items, onChoose) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.emptyStateText = "\u6CA1\u6709\u5339\u914D\u7684\u6807\u7B7E";
    this.setPlaceholder("\u8F93\u5165\u6807\u7B7E\u540D\u7B5B\u9009\u2026");
    this.setInstructions([
      { command: "\u2191\u2193", purpose: "\u9009\u62E9" },
      { command: "\u21B5", purpose: "\u63D2\u5165\u6807\u7B7E" },
      { command: "esc", purpose: "\u53D6\u6D88" }
    ]);
  }
  getSuggestions(query) {
    const q = query.trim();
    if (!q)
      return this.items;
    const search = (0, import_obsidian13.prepareFuzzySearch)(q);
    const scored = [];
    for (const item of this.items) {
      const byName = search(item.name);
      if (byName) {
        scored.push({ item, score: byName.score + 100 });
        continue;
      }
      const byDesc = item.description ? search(item.description) : null;
      if (byDesc)
        scored.push({ item, score: byDesc.score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
  }
  renderSuggestion(item, el) {
    el.addClass("pdfreader-quick-tag-suggestion");
    el.createDiv({ cls: "pdfreader-quick-tag-name", text: `#${item.name}` });
    if (item.description) {
      el.createDiv({ cls: "pdfreader-quick-tag-desc", text: item.description });
    }
  }
  onChooseSuggestion(item) {
    this.onChoose(item);
  }
};
var QuickTagModule = class {
  constructor(ctx, pdfModule) {
    /** 已注入按钮的叶子 → 按钮元素 */
    this.toolbarButtons = /* @__PURE__ */ new Map();
    /** 本模块创建过的全部按钮（含多标签页下未进 map 的隐藏按钮），用于卸载清理 */
    this.createdButtons = /* @__PURE__ */ new Set();
    /** 轮询任务移除函数（卸载时注销共享轮询） */
    this.removePollTask = null;
    this.ctx = ctx;
    this.pdfModule = pdfModule;
  }
  load() {
    const plugin = this.ctx.plugin;
    void this.migrateTags();
    plugin.registerEvent(
      plugin.app.workspace.on("layout-change", () => this.injectToolbarButtons())
    );
    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", () => this.injectToolbarButtons())
    );
    this.removePollTask = toolbarPoller.add(() => this.injectToolbarButtons());
    toolbarPoller.start();
    plugin.addCommand({
      id: "quick-add-tag",
      name: "\u5FEB\u901F\u6DFB\u52A0\u6807\u7B7E\uFF08\u5728\u7B14\u8BB0\u5149\u6807\u5904\u63D2\u5165\u51E1\u4F8B\u6807\u7B7E\uFF09",
      checkCallback: (checking) => {
        if (!this.hasTarget())
          return false;
        if (!checking)
          this.openTagPicker();
        return true;
      }
    });
    this.injectToolbarButtons();
    plugin.register(() => {
      for (const btn of this.createdButtons) {
        btn.remove();
      }
      this.createdButtons.clear();
      this.toolbarButtons.clear();
    });
  }
  unload() {
    this.removePollTask?.();
    this.removePollTask = null;
    this.toolbarButtons.clear();
    this.createdButtons.clear();
  }
  // ========== 入口可用性 ==========
  /** 命令是否可用：存在可写入的笔记（即光标所在笔记）时可用 */
  hasTarget() {
    return this.pdfModule.getCursorNotePos() !== null;
  }
  // ========== 目标定位 ==========
  /**
   * 解析插入目标：**光标所在的那篇笔记**，与批注 / 截图 / OCR 落点规则完全一致
   * （统一复用 PdfReaderModule.getCursorNotePos）。
   * 没打开笔记时返回可直接展示给用户的错误原因。
   */
  resolveInsertTarget() {
    const pos = this.pdfModule.getCursorNotePos();
    if (!pos) {
      return { error: "\u8BF7\u5148\u628A\u5149\u6807\u653E\u5230\u8981\u6DFB\u52A0\u6807\u7B7E\u7684\u7B14\u8BB0\u91CC" };
    }
    const base = pos.noteFile.path.split("/").pop() ?? "";
    return {
      mode: "cursor",
      editor: pos.editor,
      line: pos.line,
      ch: pos.ch,
      noteName: base.replace(/\.md$/, "")
    };
  }
  // ========== 词表 ==========
  /** 当前词表：直接取设置里的标签列表，因此在设置里改完立即生效 */
  loadTagEntries() {
    return this.ctx.getSettings().quickTags ?? [];
  }
  /**
   * 首次升级时的一次性迁移，把标签搬进带稳定 id 的 `quickTags`：
   *  1. 优先用上一版设置里的文本框内容（quickTagText）
   *  2. 其次读更早的凡例文件（LEGACY_VOCABULARY_FILE）
   * 两条路径都只在 `quickTags` 为空时执行；迁移后 id 由 `newTagId()` 生成并从此固定。
   * 凡例文件本身保持只读，不删不改，仍可作为文档与备份继续存在。
   *
   * 迁移成功后（以及发现遗留字段与已有词表并存时）会清除 `quickTagText` /
   * `quickTagApplied`，使迁移成为真正的一次性操作 —— 详见下方注释。
   */
  async migrateTags() {
    const settings = this.ctx.getSettings();
    if ((settings.quickTags ?? []).length > 0) {
      if (settings.quickTagText !== void 0 || settings.quickTagApplied !== void 0) {
        delete settings.quickTagText;
        delete settings.quickTagApplied;
        await this.ctx.saveSettings();
        console.log("[QuickTag] \u5DF2\u6E05\u7406\u65E7\u7248\u6807\u7B7E\u9057\u7559\u5B57\u6BB5\uFF08quickTagText / quickTagApplied\uFF09");
      }
      return;
    }
    let entries = parseTagText(settings.quickTagText ?? "");
    if (entries.length === 0) {
      const file = this.ctx.plugin.app.vault.getAbstractFileByPath(LEGACY_VOCABULARY_FILE);
      if (file instanceof import_obsidian13.TFile) {
        try {
          entries = parseTagText(await this.ctx.plugin.app.vault.cachedRead(file));
        } catch (e) {
          console.error("[QuickTag] \u8BFB\u53D6\u51E1\u4F8B\u6587\u4EF6\u5931\u8D25:", e);
          return;
        }
      }
    }
    if (entries.length === 0)
      return;
    if ((settings.quickTags ?? []).length > 0)
      return;
    settings.quickTags = entries.map((e) => ({
      id: newTagId(),
      name: e.name,
      description: e.description
    }));
    delete settings.quickTagText;
    delete settings.quickTagApplied;
    await this.ctx.saveSettings();
    console.log(`[QuickTag] \u5DF2\u8FC1\u79FB ${entries.length} \u4E2A\u6807\u7B7E\u5230\u7A33\u5B9A id \u5B58\u50A8`);
  }
  // ========== 主流程 ==========
  /** 打开标签选择器并把选中标签插入光标所在笔记（PDF / Markdown 工具条共用） */
  openTagPicker() {
    const items = this.loadTagEntries();
    if (items.length === 0) {
      new import_obsidian13.Notice("\u5FEB\u901F\u6807\u7B7E\uFF1A\u8FD8\u6CA1\u6709\u6807\u7B7E\uFF0C\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u6587\u732E\u9605\u8BFB\u52A9\u624B \u2192 \u6807\u7B7E\u7BA1\u7406 \u4E2D\u6DFB\u52A0");
      return;
    }
    const target = this.resolveInsertTarget();
    if ("error" in target) {
      new import_obsidian13.Notice(`\u5FEB\u901F\u6807\u7B7E\uFF1A${target.error}`);
      return;
    }
    new QuickTagSuggestModal(this.ctx.plugin.app, items, (item) => {
      try {
        this.insertTag(target, item.name);
        const where = target.noteName ? ` \u5230\u300C${target.noteName}\u300D` : "";
        new import_obsidian13.Notice(`\u5DF2\u63D2\u5165 #${item.name}${where}`, 1500);
      } catch (e) {
        console.error("[QuickTag] \u63D2\u5165\u6807\u7B7E\u5931\u8D25:", e);
        new import_obsidian13.Notice("\u5FEB\u901F\u6807\u7B7E\uFF1A\u63D2\u5165\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u7B14\u8BB0\u5904\u4E8E\u7F16\u8F91\u6A21\u5F0F");
      }
    }).open();
  }
  /**
   * 在光标处插入 `#标签`，并保证标签前后有空白以便 Obsidian 正确识别：
   *  - 前一字符是 `#`：只补标签名，避免拼成 `##` 被解析为标题
   *  - 前一字符非空白且非行首：先补一个空格（`…定位]#栽培` 不会被识别为标签）
   *  - 末尾统一留一个空格，光标停在其后，便于继续输入或再打一个标签
   * 与笔记中现有的 `[[…|定位]] #栽培 ` 写法保持一致。
   */
  insertTag(pos, tag) {
    const { editor } = pos;
    const lineText = pos.line <= editor.lastLine() ? editor.getLine(pos.line) : "";
    const ch = Math.max(0, Math.min(pos.ch, lineText.length));
    const before = ch > 0 ? lineText.charAt(ch - 1) : "";
    let text;
    if (before === "#") {
      text = `${tag} `;
    } else if (before === "" || /\s/.test(before)) {
      text = `#${tag} `;
    } else {
      text = ` #${tag} `;
    }
    const from = { line: pos.line, ch };
    editor.replaceRange(text, from);
    editor.setCursor({ line: pos.line, ch: ch + text.length });
  }
  // ========== 工具条按钮 ==========
  injectToolbarButtons() {
    if (this.ctx.getSettings().quickTagToolbarButton === false) {
      for (const btn of this.createdButtons)
        btn.remove();
      this.createdButtons.clear();
      this.toolbarButtons.clear();
      return;
    }
    pruneStaleLeaves(this.ctx.plugin.app, this.toolbarButtons);
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const viewer = leaf.view.viewer;
      const toolbar = viewer?.child?.toolbar;
      if (!toolbar)
        return;
      const pageNumberEl = toolbar.pageNumberEl;
      if (!pageNumberEl || !pageNumberEl.parentElement)
        return;
      const existing = pageNumberEl.parentElement.querySelector(".pdfreader-quick-tag-button");
      if (existing) {
        this.toolbarButtons.set(leaf, existing);
        return;
      }
      const stale = this.toolbarButtons.get(leaf);
      if (stale && !stale.isConnected) {
        stale.remove();
        this.toolbarButtons.delete(leaf);
      }
      const btn = document.createElement("div");
      btn.addClass("clickable-icon");
      btn.addClass("pdfreader-quick-tag-button");
      (0, import_obsidian13.setIcon)(btn, "tags");
      (0, import_obsidian13.setTooltip)(btn, "\u5FEB\u901F\u6DFB\u52A0\u6807\u7B7E\n\u5728\u9605\u8BFB\u7B14\u8BB0\u5149\u6807\u5904\u63D2\u5165\u51E1\u4F8B\u4E2D\u7684\u6807\u7B7E");
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.openTagPicker();
      });
      pageNumberEl.after(btn);
      this.toolbarButtons.set(leaf, btn);
      this.createdButtons.add(btn);
    });
  }
};

// modules/TagSyncModule.ts
var import_obsidian14 = require("obsidian");
var TYPING_CONFIRM_THRESHOLD = 10;
function applyOps(text, ops) {
  return applyTagOps(text, ops);
}
function buildPreview(oldText, ops, limit = 3) {
  const after = applyOps(oldText, ops).text;
  const a = oldText.split("\n");
  const b = after.split("\n");
  const out = [];
  for (let i = 0; i < a.length && out.length < limit; i++) {
    if (a[i] !== b[i])
      out.push({ line: i + 1, ...splitLineChange(a[i], b[i]) });
  }
  return out;
}
var TagChangeConfirmModal = class extends import_obsidian14.Modal {
  constructor(app, opts) {
    super(app);
    this.typed = "";
    this.opts = opts;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.opts.title });
    for (const line of this.opts.summary) {
      contentEl.createEl("p", { text: line });
    }
    const list = contentEl.createDiv({ cls: "pdfreader-tag-preview-list" });
    for (const edit of this.opts.files) {
      const box = list.createDiv({ cls: "pdfreader-tag-preview-file" });
      box.createDiv({
        cls: "pdfreader-tag-preview-path",
        text: `${edit.file.path}  \uFF08${edit.count} \u5904\uFF09`
      });
      for (const p of edit.preview) {
        const row = box.createDiv({ cls: "pdfreader-tag-preview-row" });
        row.createDiv({ cls: "pdfreader-tag-preview-line", text: `\u7B2C ${p.line} \u884C` });
        const diff = row.createDiv({ cls: "pdfreader-tag-preview-diff" });
        if (p.prefix)
          diff.createSpan({ text: p.prefix });
        if (p.removed) {
          diff.createSpan({ cls: "pdfreader-tag-preview-removed", text: p.removed });
        }
        if (p.removed && p.added) {
          diff.createSpan({ cls: "pdfreader-tag-preview-arrow", text: "\u2192" });
        }
        if (p.added) {
          diff.createSpan({ cls: "pdfreader-tag-preview-added", text: p.added });
        }
        if (p.suffix)
          diff.createSpan({ text: p.suffix });
      }
      if (edit.count > edit.preview.length) {
        box.createDiv({
          cls: "pdfreader-tag-preview-more",
          text: `\u2026 \u53E6\u6709 ${edit.count - edit.preview.length} \u5904\u672A\u663E\u793A`
        });
      }
    }
    const buttons = contentEl.createDiv({ cls: "pdfreader-tag-modal-buttons" });
    const confirmBtn = buttons.createEl("button", {
      text: this.opts.confirmLabel,
      cls: "mod-warning"
    });
    const cancelBtn = buttons.createEl("button", { text: "\u53D6\u6D88" });
    if (this.opts.requireTyping) {
      const label = this.opts.requireTyping;
      contentEl.createEl("p", {
        cls: "pdfreader-tag-typing-hint",
        text: `\u5F71\u54CD\u8303\u56F4\u8F83\u5927\uFF0C\u8BF7\u8F93\u5165\u6807\u7B7E\u540D\u300C${label}\u300D\u4EE5\u786E\u8BA4\uFF1A`
      });
      const input = contentEl.createEl("input", { type: "text" });
      input.addClass("pdfreader-tag-typing-input");
      contentEl.appendChild(buttons);
      input.addEventListener("input", () => {
        this.typed = input.value.trim();
        confirmBtn.toggleClass("is-disabled", this.typed !== label);
      });
      confirmBtn.toggleClass("is-disabled", true);
    }
    confirmBtn.addEventListener("click", () => {
      if (this.opts.requireTyping && this.typed !== this.opts.requireTyping) {
        new import_obsidian14.Notice(`\u8BF7\u8F93\u5165\u300C${this.opts.requireTyping}\u300D\u4EE5\u786E\u8BA4`);
        return;
      }
      this.close();
      this.opts.onConfirm();
    });
    cancelBtn.addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
};
var TagPickModal = class extends import_obsidian14.SuggestModal {
  constructor(app, usages, onPick) {
    super(app);
    this.usages = usages;
    this.onPick = onPick;
    this.emptyStateText = "\u6CA1\u6709\u5339\u914D\u7684\u6807\u7B7E";
    this.setPlaceholder("\u8F93\u5165\u6807\u7B7E\u540D\u7B5B\u9009\u2026");
    this.setInstructions([
      { command: "\u2191\u2193", purpose: "\u9009\u62E9" },
      { command: "\u21B5", purpose: "\u67E5\u770B\u5F71\u54CD\u8303\u56F4" },
      { command: "esc", purpose: "\u53D6\u6D88" }
    ]);
  }
  getSuggestions(query) {
    const q = query.trim();
    if (!q)
      return this.usages;
    const search = (0, import_obsidian14.prepareFuzzySearch)(q);
    return this.usages.map((u) => ({ u, m: search(u.tag) })).filter((r) => r.m).sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0)).map((r) => r.u);
  }
  renderSuggestion(usage, el) {
    el.addClass("pdfreader-quick-tag-suggestion");
    el.createDiv({ cls: "pdfreader-quick-tag-name", text: `#${usage.tag}` });
    el.createDiv({
      cls: "pdfreader-quick-tag-desc",
      text: `\u51FA\u73B0\u5728 ${usage.fileCount} \u7BC7\u7B14\u8BB0\uFF0C\u5171 ${usage.occurrences} \u5904`
    });
  }
  onChooseSuggestion(usage) {
    this.onPick(usage.tag);
  }
};
var TagSyncModule = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  get app() {
    return this.ctx.plugin.app;
  }
  load() {
    const plugin = this.ctx.plugin;
    plugin.addCommand({
      id: "sync-tag-changes",
      name: "\u540C\u6B65\u6807\u7B7E\u6539\u540D\u5230\u7B14\u8BB0",
      checkCallback: (checking) => {
        if (!this.hasPendingRenames())
          return false;
        if (!checking)
          this.openSettingsTab();
        return true;
      }
    });
    plugin.addCommand({
      id: "delete-tag-from-notes",
      name: "\u5220\u9664\u6807\u7B7E\uFF08\u4ECE\u6240\u6709\u7B14\u8BB0\u4E2D\u79FB\u9664\u67D0\u4E2A\u6807\u7B7E\uFF09",
      callback: () => void this.openDeletePicker()
    });
  }
  unload() {
  }
  // ========== 待同步改名（供设置面板使用） ==========
  /**
   * 待同步到笔记的改名。
   * 这些条目是用户在设置面板里改名的瞬间由 renameTag() 登记的，
   * 不是对比新旧词表推断出来的 —— 因此不存在歧义，也无需人工确认配对。
   */
  getPendingRenames() {
    return this.ctx.getSettings().pendingTagRenames ?? [];
  }
  /** 是否有待同步的改名 */
  hasPendingRenames() {
    return this.getPendingRenames().length > 0;
  }
  /** 仅供设置面板拉取同步入口 */
  openSettingsTab() {
    const setting = this.app.setting;
    if (setting?.open && setting?.openTabById) {
      setting.open();
      setting.openTabById(this.ctx.plugin.manifest.id);
    } else {
      new import_obsidian14.Notice("\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u6587\u732E\u9605\u8BFB\u52A9\u624B \u2192 \u6807\u7B7E\u7BA1\u7406 \u4E2D\u540C\u6B65\u6807\u7B7E\u6539\u540D");
    }
  }
  // ========== 改名同步 ==========
  /**
   * 把待同步的改名落到笔记正文，成功后清空待办。
   * 与旧版不同：这里不需要勾选与配对确认，因为每条待办都精确对应一个 id 的一次改名。
   */
  async applyPendingRenames() {
    const pending = this.getPendingRenames().map((p) => ({ ...p, to: p.to.trim() })).filter((p) => p.from !== p.to && p.to !== "");
    if (pending.length === 0) {
      await this.clearPendingRenames();
      return;
    }
    const ops = pending.map((p) => ({ from: p.from, to: p.to }));
    const summary = pending.map((p) => `#${p.from} \u2192 #${p.to}`).join("\u3001");
    const edits = await this.planEdits(ops);
    const total = edits.reduce((sum, e) => sum + e.count, 0);
    if (edits.length === 0) {
      new import_obsidian14.Notice("\u6CA1\u6709\u7B14\u8BB0\u5305\u542B\u8FD9\u4E9B\u65E7\u6807\u7B7E\u540D\uFF0C\u5F85\u529E\u5DF2\u6E05\u7A7A");
      await this.clearPendingRenames();
      return;
    }
    new TagChangeConfirmModal(this.app, {
      title: "\u540C\u6B65\u6807\u7B7E\u6539\u540D\u5230\u7B14\u8BB0",
      summary: [
        `\u5C06\u6267\u884C\uFF1A${summary}`,
        `\u5F71\u54CD ${edits.length} \u7BC7\u7B14\u8BB0\uFF0C\u5171 ${total} \u5904\u3002\u53EA\u6539\u5199\u6807\u7B7E\u672C\u8EAB \u2014\u2014 \u6279\u6CE8\u94FE\u63A5\u4E0E\u4F60\u5199\u7684\u6587\u5B57\u4FDD\u6301\u539F\u6837\uFF0C\u4E5F\u4E0D\u4F1A\u589E\u5220\u4EFB\u4F55\u4E00\u884C\u3002`,
        "\u6B64\u64CD\u4F5C\u76F4\u63A5\u6539\u5199\u7B14\u8BB0\u539F\u6587\uFF0C\u65E0\u6CD5\u64A4\u9500\uFF0C\u8BF7\u5148\u786E\u8BA4\u9884\u89C8\u5185\u5BB9\u65E0\u8BEF\u3002"
      ],
      files: edits,
      requireTyping: total >= TYPING_CONFIRM_THRESHOLD ? pending[0].from : void 0,
      confirmLabel: "\u786E\u8BA4\u540C\u6B65",
      onConfirm: () => {
        void (async () => {
          const { changed, failed } = await this.execute(edits, ops);
          if (failed.length > 0) {
            new import_obsidian14.Notice(
              `\u6807\u7B7E\u6539\u540D\u90E8\u5206\u5931\u8D25\uFF1A\u6210\u529F ${changed} \u7BC7\uFF0C\u5931\u8D25 ${failed.length} \u7BC7\uFF08${failed.join("\u3001")}\uFF09
\u5931\u8D25\u7684\u7B14\u8BB0\u4FDD\u7559\u65E7\u6807\u7B7E\u540D\uFF0C\u5F85\u529E\u672A\u6E05\u7A7A\uFF0C\u53EF\u91CD\u8BD5`,
              8e3
            );
          } else {
            await this.clearPendingRenames();
            new import_obsidian14.Notice(`\u6807\u7B7E\u6539\u540D\u5B8C\u6210\uFF1A${changed} \u7BC7\u7B14\u8BB0 / ${total} \u5904`);
          }
        })();
      }
    }).open();
  }
  /**
   * 撤销改名：把词表里的名字改回旧名，并清空待办。
   * 等价于「我改错了」—— 词表与笔记重新一致，不留悬空状态。
   */
  async revertPendingRenames() {
    const settings = this.ctx.getSettings();
    const pending = [...settings.pendingTagRenames ?? []];
    for (const p of pending) {
      const tag = settings.quickTags.find((t) => t.id === p.id);
      if (tag)
        tag.name = p.from;
    }
    settings.pendingTagRenames = [];
    await this.ctx.saveSettings();
    const names = pending.map((p) => `#${p.to} \u2192 #${p.from}`).join("\u3001");
    new import_obsidian14.Notice(pending.length > 0 ? `\u5DF2\u64A4\u9500\u6539\u540D\uFF1A${names}` : "\u6CA1\u6709\u5F85\u64A4\u9500\u7684\u6539\u540D");
  }
  /** 清空待同步改名（同步完成后调用） */
  async clearPendingRenames() {
    const settings = this.ctx.getSettings();
    settings.pendingTagRenames = [];
    await this.ctx.saveSettings();
  }
  // ========== 删除标签 ==========
  /** 打开删除候选选择器：扫描全库列出实际出现的标签 */
  async openDeletePicker() {
    new import_obsidian14.Notice("\u6B63\u5728\u626B\u63CF\u5168\u5E93\u6807\u7B7E\u2026");
    const usages = await this.scanVaultTags();
    if (usages.length === 0) {
      new import_obsidian14.Notice("\u6CA1\u6709\u5728\u4EFB\u4F55\u7B14\u8BB0\u4E2D\u53D1\u73B0\u6B63\u6587\u6807\u7B7E");
      return;
    }
    new TagPickModal(this.app, usages, (tag) => void this.confirmDeleteFromNotes(tag)).open();
  }
  /** 删除前的逐行预览与确认（设置面板删除标签行后也复用此入口） */
  async confirmDeleteFromNotes(tag) {
    const ops = [{ from: tag, to: null }];
    const edits = await this.planEdits(ops);
    const total = edits.reduce((sum, e) => sum + e.count, 0);
    if (edits.length === 0) {
      new import_obsidian14.Notice(`\u6CA1\u6709\u7B14\u8BB0\u5305\u542B #${tag}`);
      return;
    }
    this.showDeleteConfirm([tag], tag, null, edits, total, tag);
  }
  /**
   * 标签刚被移出词表时调用：只有笔记里仍有引用才弹出确认框，否则静默返回。
   * 供设置面板的「✕」按钮使用 —— 从词表删除本身不改笔记，清理笔记是另一件需要确认的事。
   */
  async offerNoteCleanup(tag) {
    await this.offerNoteCleanupForNames([tag]);
  }
  /**
   * 同上，但一次检查多个候选名 —— 删除一个「改过名、尚未同步」的标签时，
   * 笔记里可能同时存在旧名与新名（改名尚未落到正文），两处都要查。
   * 命中多个候选名时只弹一次确认框，否则用户要连续确认两次、第二次的标签名还对不上。
   */
  async offerNoteCleanupForNames(candidates) {
    const names = [...new Set(candidates.filter((n) => !!n))];
    if (names.length === 0)
      return;
    const seen = /* @__PURE__ */ new Set();
    const all = [];
    let total = 0;
    for (const name of names) {
      const edits = await this.planEdits([{ from: name, to: null }]);
      for (const edit of edits) {
        total += edit.count;
        if (seen.has(edit.file.path))
          continue;
        seen.add(edit.file.path);
        all.push(edit);
      }
    }
    if (total === 0)
      return;
    this.showDeleteConfirm(
      names,
      names.join(" / "),
      `\u7B14\u8BB0\u4E2D\u8FD8\u6709\u8FD9\u4E9B\u540D\u5B57\u7684\u5F15\u7528\uFF1A${names.map((n) => `#${n}`).join("\u3001")}`,
      all,
      total,
      names[0]
    );
  }
  /**
   * 删除确认框：逐行预览 + 大范围时要求手打标签名。
   * @param names 本次要删除的所有标签名（改名未同步时可能是旧名 + 新名两个）
   * @param label 展示用的名字（提示文案）
   * @param vocabNote 来自词表删除时的补充说明行
   * @param typingToken 需要手打的字样；为空表示无需手打
   */
  showDeleteConfirm(names, label, vocabNote, edits, total, typingToken) {
    const ops = names.map((from) => ({ from, to: null }));
    new TagChangeConfirmModal(this.app, {
      title: `\u5220\u9664\u6807\u7B7E #${label}`,
      summary: [
        vocabNote ?? `\u5C06\u4ECE ${edits.length} \u7BC7\u7B14\u8BB0\u4E2D\u79FB\u9664 #${label}\uFF0C\u5171 ${total} \u5904\u3002`,
        "\u53EA\u4F1A\u5220\u6389\u6807\u7B7E\u672C\u8EAB\u548C\u4E00\u4E2A\u76F8\u90BB\u7A7A\u683C\uFF0C\u4E0D\u4F1A\u5220\u9664\u8BE5\u884C\u7684\u5176\u4ED6\u5185\u5BB9\uFF0C\u4E5F\u4E0D\u4F1A\u5220\u884C\u3002",
        "\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\uFF0C\u8BF7\u5148\u786E\u8BA4\u9884\u89C8\u5185\u5BB9\u65E0\u8BEF\u3002"
      ],
      files: edits,
      requireTyping: total >= TYPING_CONFIRM_THRESHOLD ? typingToken : void 0,
      confirmLabel: `\u5220\u9664 ${total} \u5904`,
      onConfirm: () => {
        void (async () => {
          const { changed, failed } = await this.execute(edits, ops);
          new import_obsidian14.Notice(
            failed.length > 0 ? `\u5DF2\u4ECE ${changed} \u7BC7\u7B14\u8BB0\u4E2D\u5220\u9664 #${label}\uFF0C${failed.length} \u7BC7\u5931\u8D25\uFF1A${failed.join("\u3001")}` : `\u5DF2\u4ECE ${changed} \u7BC7\u7B14\u8BB0\u4E2D\u5220\u9664 #${label}\uFF08\u5171 ${total} \u5904\uFF09`,
            failed.length > 0 ? 8e3 : 4e3
          );
        })();
      }
    }).open();
  }
  // ========== 扫描 ==========
  /** 扫描全库正文标签，返回按出现次数降序的候选列表 */
  async scanVaultTags() {
    const byTag = /* @__PURE__ */ new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isExcluded(file.path))
        continue;
      let text;
      try {
        text = await this.readFileText(file);
      } catch {
        continue;
      }
      for (const [tag, count] of collectTagsFromText(text)) {
        const slot = byTag.get(tag) ?? { files: /* @__PURE__ */ new Set(), count: 0 };
        slot.files.add(file.path);
        slot.count += count;
        byTag.set(tag, slot);
      }
    }
    return [...byTag.entries()].map(([tag, v]) => ({ tag, fileCount: v.files.size, occurrences: v.count })).sort((a, b) => b.occurrences - a.occurrences || a.tag.localeCompare(b.tag));
  }
  // ========== 改写引擎 ==========
  /** 排除插件配置目录（.obsidian 内的 md 不应被改写） */
  isExcluded(path) {
    const configDir = this.app.vault.configDir;
    return !!configDir && (path === configDir || path.startsWith(`${configDir}/`));
  }
  /** 查找某文件已打开的 Markdown 视图（用于走编辑器缓冲读写） */
  findView(file) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found)
        return;
      const view = leaf.view;
      if (view instanceof import_obsidian14.MarkdownView && view.file?.path === file.path)
        found = view;
    });
    return found;
  }
  /** 读取文件当前文本：编辑器缓冲优先，保证未保存的修改也被纳入 */
  async readFileText(file) {
    const view = this.findView(file);
    if (view?.editor)
      return view.editor.getValue();
    return await this.app.vault.cachedRead(file);
  }
  /** 扫描全库，算出每个待改写文件及其逐行预览 */
  async planEdits(ops) {
    const edits = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isExcluded(file.path))
        continue;
      let text;
      try {
        text = await this.readFileText(file);
      } catch {
        continue;
      }
      const { count } = applyOps(text, ops);
      if (count === 0)
        continue;
      edits.push({ file, count, preview: buildPreview(text, ops) });
    }
    return edits;
  }
  /**
   * 执行改写：逐个文件写入。
   * 未打开的文件走 vault.process()（原子读改写，避免覆盖并发修改）；
   * 已打开的文件走编辑器 setValue，避免与未保存缓冲打架。
   *
   * 注意：本插件**不提供撤销**（旧版的备份+还原会无条件覆盖整篇笔记，
   * 把同步之后新写的内容一并抹掉，风险高于收益）。因此这里把失败如实报出来，
   * 由调用方提示用户，而不是静默跳过。
   */
  async execute(edits, ops) {
    let changed = 0;
    const failed = [];
    for (const edit of edits) {
      const view = this.findView(edit.file);
      if (view?.editor) {
        const before = view.editor.getValue();
        const { text: after, count } = applyOps(before, ops);
        if (count === 0 || after === before)
          continue;
        try {
          view.editor.setValue(after);
          changed++;
        } catch (e) {
          console.error(`[TagSync] \u6539\u5199\u5931\u8D25\uFF1A${edit.file.path}`, e);
          failed.push(edit.file.path);
        }
      } else {
        let before = "";
        let after = "";
        try {
          await this.app.vault.process(edit.file, (data) => {
            before = data;
            after = applyOps(data, ops).text;
            return after;
          });
        } catch (e) {
          console.error(`[TagSync] \u6539\u5199\u5931\u8D25\uFF1A${edit.file.path}`, e);
          failed.push(edit.file.path);
          continue;
        }
        if (after === before)
          continue;
        changed++;
      }
    }
    return { changed, failed };
  }
};

// modules/PdfJumpModule.ts
var import_obsidian15 = require("obsidian");
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var NOTE_FLASH_MARK_CLASS2 = "pdf-reader-note-flash-mark";
var NOTE_FLASH_MS2 = 1100;
var PdfJumpModule = class {
  constructor(ctx) {
    /** pdfPath → 跳转索引 */
    this.indexCache = /* @__PURE__ */ new Map();
    /**
     * 每个 PDF 一条重建串行链。
     *
     * 点击路径会同步触发重建，与防抖路径可能并发；rebuildIndex 内部有多次 await，
     * 两个并发调用各自读到不同时刻的笔记内容，**后完成的那个写入 indexCache**，
     * 与启动顺序无关 —— 结果可能是刚写入的批注链接查不到。
     * HighlightBase 有同样的机制，这里此前缺失。
     */
    this.rebuildChains = /* @__PURE__ */ new Map();
    /** 索引重建防抖定时器 */
    this.rebuildTimer = null;
    /** 防抖窗口内待重建的 PDF：'full' = 全量，string[] = 局部路径集，null = 无待办 */
    this.pendingRebuild = null;
    /** 编辑器内高亮提醒：递增令牌，保证旧的清除定时器不会抹掉新一轮高亮 */
    this.noteFlashToken = 0;
    this.noteFlashClearTimer = null;
    /** 当前持有编辑器内高亮的编辑器（用于到期/卸载时按 class 注销） */
    this.noteFlashEditor = null;
    /** 阅读模式高亮提醒：当前闪烁的链接元素与清除定时器 */
    this.lastReadingFlashEl = null;
    this.readingFlashClearTimer = null;
    // ========== 笔记链接 → PDF ==========
    /**
     * 笔记链接点击拦截（document 捕获阶段）：
     *  - 阅读模式/渲染视图：`a.internal-link` 的 data-href 含完整链接目标（path#subpath）
     *  - Live Preview：经编辑器内部 token API 取点击位置的链接文本
     * 仅接管目标为 PDF 的链接；Mod/右键等交还 Obsidian 默认行为。
     */
    this.handleNoteLinkClick = (evt) => {
      if (evt.button !== 0)
        return;
      if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey)
        return;
      const target = evt.target;
      if (!target || !(target instanceof Element))
        return;
      let linktext = null;
      let sourcePath = "";
      const anchor = target.closest("a.internal-link");
      if (anchor) {
        linktext = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
        const leaf = this.findLeafContaining(anchor);
        sourcePath = leaf?.view instanceof import_obsidian15.MarkdownView ? leaf.view.file?.path ?? "" : this.ctx.plugin.app.workspace.getActiveFile()?.path ?? "";
      } else {
        const inEditorLink = target.closest(".cm-hmd-internal-link, .cm-link");
        if (!inEditorLink)
          return;
        const leaf = this.findLeafContaining(target);
        if (!leaf || !(leaf.view instanceof import_obsidian15.MarkdownView))
          return;
        const editMode = leaf.view.editMode;
        if (editMode?.sourceMode)
          return;
        const editor = leaf.view.editor;
        if (!editor || typeof editor.getClickableTokenAt !== "function")
          return;
        try {
          const pos = editor.posAtMouse(evt);
          const token = pos != null ? editor.getClickableTokenAt(pos) : null;
          if (!token || token.type !== "internal-link")
            return;
          linktext = token.text;
          sourcePath = leaf.view.file?.path ?? "";
        } catch (e) {
          console.warn("[PdfJump] \u8BFB\u53D6\u7F16\u8F91\u5668\u94FE\u63A5 token \u5931\u8D25:", e);
          return;
        }
      }
      if (!linktext)
        return;
      const hashIdx = linktext.indexOf("#");
      const pathPart = (hashIdx >= 0 ? linktext.slice(0, hashIdx) : linktext).trim();
      const fragment = hashIdx >= 0 ? linktext.slice(hashIdx) : "";
      const pdfFile = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(pathPart, sourcePath);
      if (!(pdfFile instanceof import_obsidian15.TFile) || pdfFile.extension !== "pdf")
        return;
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
      const sourceLeaf = this.findLeafContaining(target) ?? this.ctx.plugin.app.workspace.activeLeaf;
      void this.jumpToPdf(pdfFile, fragment, sourceLeaf).catch((e) => {
        console.error("[PdfJump] \u8DF3\u8F6C PDF \u5931\u8D25:", e);
        new import_obsidian15.Notice("\u8DF3\u8F6C PDF \u5931\u8D25");
      });
    };
    // ========== PDF 高亮 → 笔记 ==========
    /**
     * PDF 高亮点击（document 冒泡阶段委托）：
     * 高亮矩形（文本选区 / OCR 区域）带 data-pdf-jump-page 与
     * data-pdf-jump-selection / data-pdf-jump-ocr 属性，点击后经索引
     * 找到笔记中的批注位置并跳转；多个笔记命中时弹出菜单选择。
     */
    this.handleHighlightClick = async (evt) => {
      try {
        if (evt.button !== 0)
          return;
        if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey)
          return;
        const target = evt.target;
        if (!target || !(target instanceof Element))
          return;
        const jumpEl = target.closest("[data-pdf-jump-page]");
        if (!jumpEl)
          return;
        const leaf = this.findLeafContaining(jumpEl);
        if (!leaf || leaf.view.getViewType() !== "pdf")
          return;
        const pdfFile = leaf.view.file;
        if (!pdfFile)
          return;
        const page = parseInt(jumpEl.getAttribute("data-pdf-jump-page") || "", 10);
        const sel = jumpEl.getAttribute("data-pdf-jump-selection");
        const ocr = jumpEl.getAttribute("data-pdf-jump-ocr");
        const rect = jumpEl.getAttribute("data-pdf-jump-rect");
        const key = sel ? `s:${sel}` : ocr ? `o:${this.normalizeOcrKey(ocr)}` : rect ? `r:${this.normalizeRectKey(rect)}` : null;
        if (!Number.isInteger(page) || !key)
          return;
        let occurrences = this.indexCache.get(pdfFile.path)?.get(page)?.get(key);
        if (!occurrences || occurrences.length === 0) {
          try {
            await this.rebuildIndexSerialized(pdfFile.path);
          } catch (e) {
            console.error("[PdfJump] \u91CD\u5EFA\u8DF3\u8F6C\u7D22\u5F15\u5931\u8D25:", e);
            new import_obsidian15.Notice("\u8DF3\u8F6C\u7D22\u5F15\u91CD\u5EFA\u5931\u8D25");
            return;
          }
          occurrences = this.indexCache.get(pdfFile.path)?.get(page)?.get(key);
        }
        if (!occurrences || occurrences.length === 0) {
          new import_obsidian15.Notice("\u672A\u5728\u7B14\u8BB0\u4E2D\u627E\u5230\u5BF9\u5E94\u7684\u6279\u6CE8\u94FE\u63A5");
          return;
        }
        const byNote = /* @__PURE__ */ new Map();
        for (const occ of occurrences) {
          if (!byNote.has(occ.notePath))
            byNote.set(occ.notePath, occ);
        }
        const notes = [...byNote.values()];
        if (notes.length === 1) {
          void this.jumpToNoteOccurrence(pdfFile, leaf, notes[0]).catch((e) => {
            console.error("[PdfJump] \u8DF3\u8F6C\u6279\u6CE8\u5931\u8D25:", e);
            new import_obsidian15.Notice("\u8DF3\u8F6C\u6279\u6CE8\u5931\u8D25");
          });
        } else {
          const menu = new import_obsidian15.Menu();
          for (const occ of notes) {
            const noteFile = this.ctx.plugin.app.vault.getAbstractFileByPath(occ.notePath);
            menu.addItem(
              (item) => item.setTitle(noteFile instanceof import_obsidian15.TFile ? noteFile.basename : occ.notePath).onClick(() => {
                void this.jumpToNoteOccurrence(pdfFile, leaf, occ).catch((e) => {
                  console.error("[PdfJump] \u8DF3\u8F6C\u6279\u6CE8\u5931\u8D25:", e);
                  new import_obsidian15.Notice("\u8DF3\u8F6C\u6279\u6CE8\u5931\u8D25");
                });
              })
            );
          }
          menu.showAtMouseEvent(evt);
        }
      } catch (e) {
        console.error("[PdfJump] PDF \u9AD8\u4EAE\u8DF3\u8F6C\u5931\u8D25:", e);
        new import_obsidian15.Notice("PDF \u9AD8\u4EAE\u8DF3\u8F6C\u5931\u8D25");
      }
    };
    /** PDF 高亮矩形脉冲提醒：当前闪烁元素与清除定时器（同一时刻只保留一个） */
    this.lastJumpFlashEl = null;
    this.jumpFlashTimer = null;
    this.ctx = ctx;
  }
  load() {
    const app = this.ctx.plugin.app;
    this.ctx.plugin.registerEvent(
      app.workspace.on("file-open", (file) => {
        if (file && file.extension === "pdf") {
          this.scheduleRebuildForPdfs([file.path]);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("changed", (file) => {
        const links = app.metadataCache.resolvedLinks[file.path];
        if (!links)
          return;
        const affected = Object.keys(links).filter((t) => t.endsWith(".pdf"));
        if (affected.length > 0) {
          this.scheduleRebuildForPdfs(affected);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("resolve", (file) => {
        const links = app.metadataCache.resolvedLinks[file.path];
        if (!links)
          return;
        const affected = Object.keys(links).filter((t) => t.endsWith(".pdf"));
        if (affected.length > 0) {
          this.scheduleRebuildForPdfs(affected);
        }
      })
    );
    this.ctx.plugin.registerEvent(
      app.metadataCache.on("deleted", () => this.scheduleRebuild())
    );
    this.ctx.plugin.registerEvent(
      app.vault.on("rename", () => this.scheduleRebuild())
    );
    this.ctx.plugin.registerDomEvent(document, "click", this.handleNoteLinkClick, true);
    this.ctx.plugin.registerDomEvent(document, "click", this.handleHighlightClick);
    this.scheduleRebuild();
  }
  unload() {
    this.indexCache.clear();
    this.pendingRebuild = null;
    if (this.rebuildTimer !== null) {
      window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.clearNoteFlashState();
  }
  /** 清理两种笔记模式下的高亮提醒状态（定时器 + 编辑器/阅读模式残留 class） */
  clearNoteFlashState() {
    if (this.noteFlashClearTimer !== null) {
      window.clearTimeout(this.noteFlashClearTimer);
      this.noteFlashClearTimer = null;
    }
    if (this.readingFlashClearTimer !== null) {
      window.clearTimeout(this.readingFlashClearTimer);
      this.readingFlashClearTimer = null;
    }
    this.clearEditorNoteFlash();
    if (this.lastReadingFlashEl?.isConnected) {
      this.lastReadingFlashEl.removeClass(NOTE_FLASH_MARK_CLASS2);
    }
    this.lastReadingFlashEl = null;
    this.noteFlashToken++;
    if (this.jumpFlashTimer !== null) {
      window.clearTimeout(this.jumpFlashTimer);
      this.jumpFlashTimer = null;
    }
    if (this.lastJumpFlashEl?.isConnected) {
      this.lastJumpFlashEl.removeClass("pdf-reader-jump-flash");
    }
    this.lastJumpFlashEl = null;
  }
  /** 移除编辑器内的跳转定位高亮（Obsidian addHighlights 按 class 注销） */
  clearEditorNoteFlash() {
    const editor = this.noteFlashEditor;
    this.noteFlashEditor = null;
    if (!editor)
      return;
    try {
      editor.removeHighlights?.(NOTE_FLASH_MARK_CLASS2);
    } catch {
    }
  }
  // ========== 索引维护 ==========
  /** 全部重建（删除/重命名等路径级变更） */
  scheduleRebuild() {
    this.scheduleTimer("full");
  }
  /** 精确重建指定 PDF（笔记编辑的常规路径），防抖合并 */
  /** 当前已打开的 PDF 路径集合 */
  getOpenPdfPaths() {
    const paths = /* @__PURE__ */ new Set();
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === "pdf") {
        const file = leaf.view.file;
        if (file)
          paths.add(file.path);
      }
    });
    return paths;
  }
  scheduleRebuildForPdfs(pdfPaths) {
    const open = this.getOpenPdfPaths();
    const filtered = pdfPaths.filter((p) => open.has(p));
    if (filtered.length === 0)
      return;
    this.scheduleTimer(filtered);
  }
  scheduleTimer(request) {
    if (this.rebuildTimer !== null)
      window.clearTimeout(this.rebuildTimer);
    if (request === "full" || this.pendingRebuild === "full") {
      this.pendingRebuild = "full";
    } else if (this.pendingRebuild === null) {
      this.pendingRebuild = request;
    } else {
      this.pendingRebuild = [.../* @__PURE__ */ new Set([...this.pendingRebuild, ...request])];
    }
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      const pending = this.pendingRebuild;
      this.pendingRebuild = null;
      if (pending === "full" || !pending) {
        this.rebuildAllIndexes();
      } else {
        this.rebuildIndexes(pending);
      }
    }, 300);
  }
  async rebuildAllIndexes() {
    const paths = /* @__PURE__ */ new Set();
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === "pdf") {
        const file = leaf.view.file;
        if (file)
          paths.add(file.path);
      }
    });
    for (const path of paths) {
      await this.rebuildIndex(path);
    }
    for (const path of [...this.indexCache.keys()]) {
      if (!paths.has(path) && !this.ctx.plugin.app.vault.getAbstractFileByPath(path)) {
        this.indexCache.delete(path);
      }
    }
  }
  async rebuildIndexes(pdfPaths) {
    for (const path of pdfPaths) {
      await this.rebuildIndex(path);
    }
  }
  /**
   * 重建单个 PDF 的跳转索引。
   * metadataCache 不记录指向 PDF 的正文链接，因此通过 resolvedLinks 反查
   * 链接到该 PDF 的笔记，再读取笔记原文提取带页码/锚点的链接并记录行号。
   */
  /** 串行化入口：同一 PDF 的重建排队执行，避免旧结果覆盖新结果 */
  rebuildIndexSerialized(pdfPath) {
    const prev = this.rebuildChains.get(pdfPath) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(() => this.rebuildIndex(pdfPath));
    this.rebuildChains.set(pdfPath, next.catch(() => void 0));
    void next.finally(() => {
      if (this.rebuildChains.get(pdfPath) === next)
        this.rebuildChains.delete(pdfPath);
    });
    return next;
  }
  async rebuildIndex(pdfPath) {
    const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof import_obsidian15.TFile))
      return;
    const newIndex = /* @__PURE__ */ new Map();
    const app = this.ctx.plugin.app;
    for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (!links[pdfPath])
        continue;
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof import_obsidian15.TFile))
        continue;
      try {
        const content = await this.readNoteContent(sourceFile);
        this.extractOccurrences(content, pdfFile, sourcePath, newIndex);
      } catch (e) {
        console.warn("[PdfJump] \u8BFB\u53D6\u7B14\u8BB0\u5931\u8D25:", sourcePath, e);
      }
    }
    this.indexCache.set(pdfPath, newIndex);
  }
  /** 从笔记原文提取指向指定 PDF 的批注链接并写入索引 */
  extractOccurrences(content, pdfFile, sourcePath, index) {
    const app = this.ctx.plugin.app;
    const selRegex = /\[\[([^\]#|]+?)#page=(\d+)&selection=([\d,\s-]+)/g;
    const ocrRegex = /\[\[([^\]#|]+?)#page=(\d+)&ocr=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
    const rectRegex = /\[\[([^\]#|]+?)#page=(\d+)&rect=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
    this.scanMatches(content, selRegex, pdfFile, sourcePath, index, (m) => {
      const sel = this.normalizeSelectionKey(m[3]);
      if (!sel)
        return null;
      const linktext = `${m[1].trim()}#page=${m[2]}&selection=${sel}`;
      return { page: parseInt(m[2], 10), key: `s:${sel}`, linktext };
    });
    this.scanMatches(content, ocrRegex, pdfFile, sourcePath, index, (m) => {
      const ocr = this.normalizeOcrKey(m[3]);
      if (!ocr)
        return null;
      const linktext = `${m[1].trim()}#page=${m[2]}&ocr=${ocr}`;
      return { page: parseInt(m[2], 10), key: `o:${ocr}`, linktext };
    });
    this.scanMatches(content, rectRegex, pdfFile, sourcePath, index, (m) => {
      const rect = this.normalizeRectKey(m[3]);
      if (!rect)
        return null;
      const linktext = `${m[1].trim()}#page=${m[2]}&rect=${rect}`;
      return { page: parseInt(m[2], 10), key: `r:${rect}`, linktext };
    });
  }
  /** 通用扫描：解析链接、校验目标 PDF、计算行/列并写入索引 */
  scanMatches(content, regex, pdfFile, sourcePath, index, makeEntry) {
    const app = this.ctx.plugin.app;
    let m;
    let scanned = 0;
    let line = 0;
    let lineStart = 0;
    const advanceTo = (idx) => {
      for (let i = scanned; i < idx; i++) {
        if (content.charCodeAt(i) === 10) {
          line++;
          lineStart = i + 1;
        }
      }
      scanned = idx;
    };
    while ((m = regex.exec(content)) !== null) {
      const linkpath = m[1].trim();
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (target !== pdfFile)
        continue;
      const entry = makeEntry(m);
      if (!entry || !Number.isInteger(entry.page))
        continue;
      advanceTo(m.index);
      const ch = m.index - lineStart;
      const closeIdx = content.indexOf("]]", m.index);
      const endCh = closeIdx >= 0 ? closeIdx + 2 : ch + m[0].length;
      const pageIndex = index.get(entry.page) ?? /* @__PURE__ */ new Map();
      const list = pageIndex.get(entry.key) ?? [];
      list.push({ notePath: sourcePath, line, ch, endCh, linktext: entry.linktext });
      pageIndex.set(entry.key, list);
      index.set(entry.page, pageIndex);
    }
  }
  /** 读取笔记内容：优先打开中的编辑器缓冲（仅编辑模式，缓冲与磁盘一致），其次磁盘（共享缓存） */
  async readNoteContent(sourceFile) {
    if (this.ctx.readNoteContent) {
      return await this.ctx.readNoteContent(sourceFile, { editorMode: "source" });
    }
    const app = this.ctx.plugin.app;
    let editorContent = null;
    app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (editorContent !== null)
        return;
      const view = leaf.view;
      if (view.file?.path === sourceFile.path && view.getMode() === "source" && view.editor) {
        editorContent = view.editor.getValue();
      }
    });
    if (editorContent !== null)
      return editorContent;
    return await app.vault.read(sourceFile);
  }
  /**
   * 跳转到 PDF 的指定位置：
   *  - PDF 已打开 → 聚焦现有叶子并应用 subpath（原生页码/选区高亮）
   *  - 未打开 → 在来源叶子（笔记）的左侧分屏打开
   *  - 打开后轮询持久高亮层，滚动到具体锚点并闪烁提示
   */
  async jumpToPdf(pdfFile, fragment, sourceLeaf) {
    const app = this.ctx.plugin.app;
    const existingLeaf = this.findLeafByPath(pdfFile.path);
    let leaf;
    if (existingLeaf) {
      leaf = existingLeaf;
    } else if (sourceLeaf) {
      leaf = app.workspace.createLeafBySplit(sourceLeaf, "vertical", true);
    } else {
      leaf = app.workspace.getLeaf(false);
    }
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await leaf.openFile(pdfFile, { eState: { subpath: fragment }, active: true });
    const parsed = this.parseFragment(fragment);
    if (parsed) {
      this.scrollToPdfAnchor(leaf, parsed);
    }
  }
  /** 解析 #page=N&selection=… / #page=N&ocr=… / #page=N&rect=… 片段 */
  parseFragment(fragment) {
    const m = fragment.match(/^#page=(\d+)(?:&(selection|ocr|rect)=([\d.,\s-]+))?/);
    if (!m)
      return null;
    const page = parseInt(m[1], 10);
    if (!Number.isInteger(page))
      return null;
    let key = null;
    if (m[2] === "selection") {
      const sel = this.normalizeSelectionKey(m[3] ?? "");
      if (!sel)
        return null;
      key = `s:${sel}`;
    } else if (m[2] === "ocr") {
      const ocr = this.normalizeOcrKey(m[3] ?? "");
      if (!ocr)
        return null;
      key = `o:${ocr}`;
    } else if (m[2] === "rect") {
      const rect = this.normalizeRectKey(m[3] ?? "");
      if (!rect)
        return null;
      key = `r:${rect}`;
    }
    return { page, key };
  }
  /**
   * 等待目标页面的持久高亮渲染后滚动到锚点并闪烁提示。
   * 轮询 8 秒：PDF 首次打开时索引/高亮层需要时间构建。
   */
  async scrollToPdfAnchor(leaf, parsed) {
    if (!parsed.key)
      return;
    const selAttr = parsed.key.startsWith("s:") ? parsed.key.slice(2) : null;
    const ocrAttr = parsed.key.startsWith("o:") ? parsed.key.slice(2) : null;
    const rectAttr = parsed.key.startsWith("r:") ? parsed.key.slice(2) : null;
    const deadline = Date.now() + 8e3;
    while (Date.now() < deadline) {
      if (leaf.view.getViewType() !== "pdf")
        return;
      const pageEl = leaf.view.containerEl.querySelector(
        `[data-page-number="${parsed.page}"]`
      );
      const targetEl = pageEl?.querySelector(
        selAttr ? `[data-pdf-jump-selection="${selAttr}"]` : ocrAttr ? `[data-pdf-jump-ocr="${ocrAttr}"]` : rectAttr ? `[data-pdf-jump-rect="${rectAttr}"]` : ""
      ) ?? null;
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
        this.flashElement(targetEl);
        return;
      }
      await sleep2(120);
    }
  }
  /** 跳转到笔记中的批注位置：未打开时在 PDF 叶子右侧分屏打开 */
  async jumpToNoteOccurrence(pdfFile, pdfLeaf, occ) {
    const app = this.ctx.plugin.app;
    const noteFile = app.vault.getAbstractFileByPath(occ.notePath);
    if (!(noteFile instanceof import_obsidian15.TFile))
      return;
    let noteLeaf = this.findLeafByPath(occ.notePath);
    if (!noteLeaf) {
      noteLeaf = app.workspace.createLeafBySplit(pdfLeaf, "vertical", false);
      await noteLeaf.openFile(noteFile);
    }
    app.workspace.setActiveLeaf(noteLeaf, { focus: true });
    await this.scrollNoteToOccurrence(noteLeaf, occ);
  }
  /** 滚动笔记到批注行：编辑模式经编辑器，阅读模式定位渲染出的链接锚点 */
  async scrollNoteToOccurrence(noteLeaf, occ) {
    const view = noteLeaf.view;
    if (!(view instanceof import_obsidian15.MarkdownView))
      return;
    const editor = view.getMode() === "source" ? view.editor : null;
    if (editor) {
      for (let i = 0; i < 30 && editor.lastLine() < occ.line; i++) {
        await sleep2(100);
      }
      if (editor.lastLine() >= occ.line) {
        const lineText = editor.getLine(occ.line);
        const targetCh = Math.min(occ.ch, lineText.length);
        const linkEndCh = Math.min(this.resolveLinkEndCh(occ, lineText, targetCh), lineText.length);
        editor.scrollIntoView(
          {
            from: { line: occ.line, ch: targetCh },
            to: { line: occ.line, ch: linkEndCh }
          },
          true
        );
        this.flashNoteInEditor(editor, occ);
      }
      return;
    }
    const container = view.previewMode?.containerEl ?? view.contentEl;
    for (let i = 0; i < 30; i++) {
      const el = this.findRenderedNoteLink(container, occ);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        this.flashNoteLinkInReadingView(el);
        return;
      }
      await sleep2(100);
    }
  }
  /**
   * 在编辑器（Live Preview / 源码模式）中只高亮目标链接本身（而非整行），
   * 不把光标移入链接内，避免 Obsidian Live Preview 将短链接「定位」展开为完整 wikilink。
   *
   * 使用 Obsidian 原生 Editor.addHighlights（未写入官方 d.ts，核心的搜索结果 /
   * 大纲跳转闪烁即由它实现）。高亮由 mark decoration 挂在编辑器 state 上，
   * 随文本渲染、天然与链接对齐，不受缩放/内边距/可读行宽影响，且按 class
   * 注册进 state 后可精确注销，滚动重绘也不会丢失。
   *
   * 弃用的旧方案（自定义 CM StateField + registerEditorExtension + effect 分发）
   * 依赖插件动态注入编辑器状态，实测 effect 会被静默忽略，导致编辑模式下
   * 高亮提醒完全不显示。
   */
  flashNoteInEditor(editor, occ) {
    const capable = editor;
    if (typeof capable.addHighlights !== "function") {
      console.warn("[PdfJump] \u5F53\u524D Obsidian \u7248\u672C\u7F3A\u5C11 Editor.addHighlights\uFF0C\u65E0\u6CD5\u70B9\u4EAE\u7B14\u8BB0\u8DF3\u8F6C\u9AD8\u4EAE");
      return;
    }
    const lineText = editor.getLine(occ.line);
    const targetCh = Math.min(occ.ch, lineText.length);
    const endCh = Math.max(targetCh, Math.min(this.resolveLinkEndCh(occ, lineText, targetCh), lineText.length));
    if (endCh <= targetCh)
      return;
    const token = ++this.noteFlashToken;
    try {
      capable.removeHighlights?.(NOTE_FLASH_MARK_CLASS2);
      capable.addHighlights(
        [{ from: { line: occ.line, ch: targetCh }, to: { line: occ.line, ch: endCh } }],
        NOTE_FLASH_MARK_CLASS2,
        true,
        true
      );
    } catch (e) {
      console.warn("[PdfJump] \u70B9\u4EAE\u7B14\u8BB0\u8DF3\u8F6C\u9AD8\u4EAE\u5931\u8D25:", e);
      return;
    }
    this.noteFlashEditor = editor;
    if (this.noteFlashClearTimer !== null)
      window.clearTimeout(this.noteFlashClearTimer);
    this.noteFlashClearTimer = window.setTimeout(() => {
      this.noteFlashClearTimer = null;
      if (this.noteFlashToken !== token)
        return;
      this.clearEditorNoteFlash();
    }, NOTE_FLASH_MS2);
  }
  /** 计算链接在行内的终点列：行内实时扫描 "]]" 优先（不受索引陈旧影响），退化用索引记录值 */
  resolveLinkEndCh(occ, lineText, targetCh) {
    if (lineText.slice(targetCh, targetCh + 2) === "[[") {
      const close = lineText.indexOf("]]", targetCh + 2);
      if (close >= 0)
        return close + 2;
    }
    if (typeof occ.endCh === "number" && occ.endCh > targetCh)
      return occ.endCh;
    return Math.min(targetCh + 1, lineText.length);
  }
  /** 阅读模式下的链接闪烁：与编辑模式共用同一套样式（pdf-reader-note-flash-mark），保证效果一致 */
  flashNoteLinkInReadingView(el) {
    if (this.lastReadingFlashEl && this.lastReadingFlashEl !== el && this.lastReadingFlashEl.isConnected) {
      this.lastReadingFlashEl.removeClass(NOTE_FLASH_MARK_CLASS2);
    }
    el.removeClass(NOTE_FLASH_MARK_CLASS2);
    void el.offsetWidth;
    el.addClass(NOTE_FLASH_MARK_CLASS2);
    this.lastReadingFlashEl = el;
    if (this.readingFlashClearTimer !== null)
      window.clearTimeout(this.readingFlashClearTimer);
    this.readingFlashClearTimer = window.setTimeout(() => {
      this.readingFlashClearTimer = null;
      if (this.lastReadingFlashEl?.isConnected) {
        this.lastReadingFlashEl.removeClass(NOTE_FLASH_MARK_CLASS2);
      }
      this.lastReadingFlashEl = null;
    }, NOTE_FLASH_MS2);
  }
  /** 在阅读模式渲染内容中查找与批注链接匹配的锚点 */
  findRenderedNoteLink(container, occ) {
    const expect = occ.linktext.replace(/\s+/g, "");
    const anchors = container.querySelectorAll("a.internal-link");
    for (const a of Array.from(anchors)) {
      const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      if (href.split("|")[0].replace(/\s+/g, "") === expect) {
        return a;
      }
    }
    return null;
  }
  // ========== 工具 ==========
  /** 选区 key 规范化：parseInt 后拼接，与高亮层 data-pdf-jump-selection 一致 */
  normalizeSelectionKey(s) {
    const parts = s.split(",").map((p) => parseInt(p.trim(), 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
      return "";
    return parts.join(",");
  }
  /** OCR 矩形 key 规范化：4 位小数去尾零，与笔记写入的 fmtRectNum 及高亮层一致 */
  normalizeOcrKey(s) {
    const parts = s.split(",").map((p) => Number(Number(p.trim()).toFixed(4)));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
      return "";
    return parts.join(",");
  }
  /** 截图矩形 key 规范化：4 位小数去尾零，与截图高亮层 data-pdf-jump-rect 一致 */
  normalizeRectKey(s) {
    const parts = s.split(",").map((p) => Number(Number(p.trim()).toFixed(4)));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p)))
      return "";
    return parts.join(",");
  }
  /** 闪烁提示元素（连续点击同一高亮时动画重播：先移除 class 强制重排再加回） */
  flashElement(el) {
    if (this.jumpFlashTimer !== null)
      window.clearTimeout(this.jumpFlashTimer);
    if (this.lastJumpFlashEl?.isConnected && this.lastJumpFlashEl !== el) {
      this.lastJumpFlashEl.removeClass("pdf-reader-jump-flash");
    }
    this.lastJumpFlashEl = el;
    el.removeClass("pdf-reader-jump-flash");
    void el.offsetWidth;
    el.addClass("pdf-reader-jump-flash");
    this.jumpFlashTimer = window.setTimeout(() => {
      this.jumpFlashTimer = null;
      if (this.lastJumpFlashEl?.isConnected) {
        this.lastJumpFlashEl.removeClass("pdf-reader-jump-flash");
      }
      this.lastJumpFlashEl = null;
    }, 2400);
  }
  /** 查找包含指定节点的叶子 */
  findLeafContaining(node) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!result && leaf.view.containerEl.contains(node)) {
        result = leaf;
      }
    });
    return result;
  }
  /** 查找已打开指定文件的叶子 */
  findLeafByPath(path) {
    let result = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!result && leaf.view instanceof import_obsidian15.FileView && leaf.view.file?.path === path) {
        result = leaf;
      }
    });
    return result;
  }
};

// modules/ReadingNoteMarkerModule.ts
var import_obsidian16 = require("obsidian");
var ReadingNoteMarkerModule = class {
  constructor(ctx) {
    /** 已有阅读笔记的文献路径集合（PDF 或 md 文献） */
    this.sourcePathsWithNotes = /* @__PURE__ */ new Set();
    /** 文献路径被多少篇笔记引用，用于增量刷新时安全移除 */
    this.sourceContributionCounts = /* @__PURE__ */ new Map();
    /** 各文件管理器叶子的 MutationObserver，用于 DOM 动态重建后重新装饰 */
    this.observers = [];
    /** PDF basename → 同名 PDF 路径列表，用于旧笔记命名兜底 */
    this.pdfsByBasename = /* @__PURE__ */ new Map();
    /** 每个 Markdown 笔记当前贡献的 PDF 路径，便于增量更新时精确移除 */
    this.noteContributions = /* @__PURE__ */ new Map();
    /** 增量刷新（单笔记）的待处理队列与定时器 */
    this.pendingNotePaths = /* @__PURE__ */ new Set();
    this.noteRefreshTimer = null;
    /** 命名模板正则缓存，避免每次重建都重新构造 */
    this.nameRegexCache = null;
    this.nameTemplateCache = "";
    // ========== 监听与防抖 ==========
    /** 文件管理器虚拟滚动/重建时，只需要重新装饰，不重建索引 */
    this.decorateAllDebounced = (0, import_obsidian16.debounce)(() => {
      this.decorateAll();
    }, 100, true);
    /** 文件/笔记变化时，重建索引并重新装饰 */
    this.scheduleRefresh = (0, import_obsidian16.debounce)(async () => {
      try {
        await this.rebuildIndex();
        this.decorateAll();
      } catch (e) {
        console.error("[ReadingNoteMarker] \u5237\u65B0\u9605\u8BFB\u7B14\u8BB0\u6807\u8BB0\u5931\u8D25:", e);
      }
    }, 200, true);
    this.ctx = ctx;
  }
  load() {
    const plugin = this.ctx.plugin;
    plugin.app.workspace.onLayoutReady(() => {
      void this.scheduleRefresh();
      this.watchExplorers();
    });
    plugin.registerEvent(plugin.app.vault.on("create", () => this.scheduleRefresh()));
    plugin.registerEvent(plugin.app.vault.on("delete", () => this.scheduleRefresh()));
    plugin.registerEvent(plugin.app.vault.on("rename", () => this.scheduleRefresh()));
    plugin.registerEvent(plugin.app.metadataCache.on("changed", (file) => {
      if (file.extension === "md")
        this.scheduleNoteRefresh(file.path);
    }));
    plugin.registerEvent(plugin.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => {
      this.watchExplorers();
      this.decorateAll();
    }));
    plugin.register(() => {
      this.decorateAllDebounced.cancel();
      this.scheduleRefresh.cancel();
      this.clearNoteRefreshTimer();
      this.disconnectObservers();
      this.clearAll();
      this.sourcePathsWithNotes.clear();
      this.sourceContributionCounts.clear();
      this.noteContributions.clear();
    });
  }
  unload() {
    this.decorateAllDebounced.cancel();
    this.scheduleRefresh.cancel();
    this.clearNoteRefreshTimer();
    this.disconnectObservers();
    this.clearAll();
    this.sourcePathsWithNotes.clear();
    this.sourceContributionCounts.clear();
    this.noteContributions.clear();
  }
  // ========== 索引建立 ==========
  /** 标记开关（设置为 false 时隐藏全部标记） */
  markerEnabled() {
    return this.ctx.getSettings().fileMarkerEnabled !== false;
  }
  /**
   * 重建「文献路径 -> 已有阅读笔记」索引。
   * 优先使用 frontmatter 的 pdf 字段（PDF 文献）或 source 字段（md 文献）；
   * 旧 PDF 笔记无该字段时按命名模板在阅读笔记文件夹内兜底。
   * 全量重建只在文献/笔记结构性变化时执行；普通 Markdown 编辑走增量 refreshNote。
   */
  async rebuildIndex() {
    const nextPdfsByBasename = /* @__PURE__ */ new Map();
    for (const file of this.ctx.plugin.app.vault.getFiles()) {
      if (file.extension !== "pdf")
        continue;
      const arr = nextPdfsByBasename.get(file.basename) ?? [];
      arr.push(file.path);
      nextPdfsByBasename.set(file.basename, arr);
    }
    this.pdfsByBasename = nextPdfsByBasename;
    const next = /* @__PURE__ */ new Set();
    const nextContributions = /* @__PURE__ */ new Map();
    const nextCounts = /* @__PURE__ */ new Map();
    for (const note of this.ctx.plugin.app.vault.getMarkdownFiles()) {
      const contributions = this.computeNoteContributions(note);
      nextContributions.set(note.path, contributions);
      for (const sourcePath of contributions) {
        next.add(sourcePath);
        nextCounts.set(sourcePath, (nextCounts.get(sourcePath) ?? 0) + 1);
      }
    }
    this.sourcePathsWithNotes = next;
    this.sourceContributionCounts = nextCounts;
    this.noteContributions = nextContributions;
  }
  /** 计算单个笔记当前贡献的文献路径集合 */
  computeNoteContributions(note) {
    const sourcePath = this.extractSourcePath(note);
    if (sourcePath)
      return /* @__PURE__ */ new Set([sourcePath]);
    const folderPath = (0, import_obsidian16.normalizePath)(this.ctx.getSettings().readingNoteFolder);
    const inReadingFolder = !folderPath || note.path.startsWith(folderPath + "/");
    if (!inReadingFolder)
      return /* @__PURE__ */ new Set();
    const m = note.basename.match(this.getNameRegex());
    if (!m)
      return /* @__PURE__ */ new Set();
    const matches = this.pdfsByBasename.get(m[1]);
    return matches?.length === 1 ? /* @__PURE__ */ new Set([matches[0]]) : /* @__PURE__ */ new Set();
  }
  /** 获取命名模板正则（带缓存，避免每个笔记重复构造） */
  getNameRegex() {
    const template = this.ctx.getSettings().readingNoteNameTemplate;
    if (!this.nameRegexCache || this.nameTemplateCache !== template) {
      this.nameRegexCache = buildNoteBaseRegex(template);
      this.nameTemplateCache = template;
    }
    return this.nameRegexCache;
  }
  /** 增量刷新单个 Markdown 笔记对文献标记的贡献 */
  refreshNote(note) {
    const old = this.noteContributions.get(note.path);
    if (old) {
      for (const sourcePath of old) {
        const count = (this.sourceContributionCounts.get(sourcePath) ?? 1) - 1;
        if (count <= 0) {
          this.sourceContributionCounts.delete(sourcePath);
          this.sourcePathsWithNotes.delete(sourcePath);
        } else {
          this.sourceContributionCounts.set(sourcePath, count);
        }
      }
    }
    const contributions = this.computeNoteContributions(note);
    this.noteContributions.set(note.path, contributions);
    for (const sourcePath of contributions) {
      const count = this.sourceContributionCounts.get(sourcePath) ?? 0;
      this.sourceContributionCounts.set(sourcePath, count + 1);
      this.sourcePathsWithNotes.add(sourcePath);
    }
  }
  /** 批量增量刷新：合并 200ms 内变化的笔记，避免连续输入触发大量重复计算 */
  scheduleNoteRefresh(notePath) {
    this.pendingNotePaths.add(notePath);
    if (this.noteRefreshTimer !== null)
      return;
    this.noteRefreshTimer = window.setTimeout(() => {
      this.noteRefreshTimer = null;
      const paths = [...this.pendingNotePaths];
      this.pendingNotePaths.clear();
      for (const path of paths) {
        const note = this.ctx.plugin.app.vault.getAbstractFileByPath(path);
        if (note instanceof import_obsidian16.TFile) {
          try {
            this.refreshNote(note);
          } catch (e) {
            console.error("[ReadingNoteMarker] \u589E\u91CF\u5237\u65B0\u7B14\u8BB0\u6807\u8BB0\u5931\u8D25:", path, e);
          }
        }
      }
      this.decorateAll();
    }, 200);
  }
  clearNoteRefreshTimer() {
    if (this.noteRefreshTimer !== null) {
      window.clearTimeout(this.noteRefreshTimer);
      this.noteRefreshTimer = null;
    }
    this.pendingNotePaths.clear();
  }
  /**
   * 从笔记 frontmatter 中解析关联文献路径，返回文献在库中的路径；解析不到返回 null。
   * `pdf: "[[path]]"` 是 PDF 文献笔记、`source: "[[path]]"` 是 md 文献笔记
   * （见 PdfReaderModule.sourceFieldName）。
   * 字段值按「字面路径优先、锚点截断兜底」两步解析（与 PdfReaderModule.resolveNoteSource 同一套）：
   *  1. 整段原文（去别名、保留 #）按库内完整路径精确匹配——文件名本身含 #（如「6V#4S」）时
   *     唯一能命中的方式，wikilink 语法没有 # 的转义写法；
   *  2. 命不中再按 Obsidian 链接惯例截掉 #锚点，wikilink/纯路径均可，省略 .md 扩展名时
   *     走 metadataCache 链接解析，保证解析结果能与文件行的 data-path 对上。
   * 两步都失败时返回 null，让调用方继续走命名模板兜底（旧版返回原样字符串会把兜底短路掉）。
   */
  extractSourcePath(note) {
    const fm = this.ctx.plugin.app.metadataCache.getFileCache(note)?.frontmatter;
    const raw = fm?.pdf ?? fm?.source;
    if (typeof raw !== "string")
      return null;
    const m = raw.match(/\[\[(.+?)\]\]/);
    const linktext = (m ? m[1] : raw.trim()) || "";
    const literal = linktext.split("|")[0].trim();
    if (!literal)
      return null;
    const direct = this.ctx.plugin.app.vault.getAbstractFileByPath((0, import_obsidian16.normalizePath)(literal));
    if (direct instanceof import_obsidian16.TFile)
      return direct.path;
    const path = literal.split("#")[0].trim();
    if (path) {
      if (this.ctx.plugin.app.vault.getAbstractFileByPath((0, import_obsidian16.normalizePath)(path)) instanceof import_obsidian16.TFile) {
        return (0, import_obsidian16.normalizePath)(path);
      }
      const dest = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(path, note.path);
      if (dest instanceof import_obsidian16.TFile)
        return dest.path;
    }
    return null;
  }
  // ========== 文件管理器 DOM 装饰 ==========
  /** 遍历所有文件管理器叶子，重新装饰所有文献行（PDF 与 md 文献）；关闭开关时清空标记 */
  decorateAll() {
    if (!this.markerEnabled()) {
      this.clearAll();
      return;
    }
    for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType("file-explorer")) {
      const container = leaf.view.containerEl;
      if (!container)
        continue;
      container.querySelectorAll(".nav-file-title[data-path]").forEach((el) => this.decorateEl(el));
    }
  }
  /** 装饰单个文件管理器行：有笔记的文献（PDF 或 md 文献）加 class + 小图标 */
  decorateEl(el) {
    const path = el.getAttribute("data-path") || "";
    const lower = path.toLowerCase();
    const hasNote = (lower.endsWith(".pdf") || lower.endsWith(".md")) && this.sourcePathsWithNotes.has(path);
    el.toggleClass("pdf-reader-has-note", hasNote);
    let marker = el.querySelector(":scope > .pdf-reader-has-note-marker");
    if (hasNote) {
      if (!marker) {
        marker = el.createSpan({ cls: "pdf-reader-has-note-marker" });
        (0, import_obsidian16.setIcon)(marker, "file-check");
        (0, import_obsidian16.setTooltip)(marker, "\u5DF2\u6709\u9605\u8BFB\u7B14\u8BB0");
        const content = el.querySelector(".nav-file-title-content");
        if (content) {
          content.before(marker);
        } else {
          el.prepend(marker);
        }
      }
    } else {
      marker?.remove();
    }
  }
  /** 清理所有文件管理器行上的标记 */
  clearAll() {
    for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType("file-explorer")) {
      const container = leaf.view.containerEl;
      if (!container)
        continue;
      container.querySelectorAll(".pdf-reader-has-note-marker").forEach((el) => el.remove());
      container.querySelectorAll(".nav-file-title.pdf-reader-has-note").forEach((el) => el.removeClass("pdf-reader-has-note"));
    }
  }
  /** 为每个文件管理器叶子挂 MutationObserver，处理虚拟化/重建 */
  watchExplorers() {
    this.disconnectObservers();
    for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType("file-explorer")) {
      const container = leaf.view.containerEl;
      if (!container)
        continue;
      const observer = new MutationObserver(() => this.decorateAllDebounced());
      observer.observe(container, { subtree: true, childList: true });
      this.observers.push(observer);
    }
  }
  disconnectObservers() {
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
  }
};

// modules/WordCountFixModule.ts
var import_obsidian17 = require("obsidian");
var LATIN_CLASS = "A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B4\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16F1-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006\u3031-\u3035\u303B\u303C\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6E5\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AD\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
var CJK_CLASS = "\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u4E00-\u9FD5\uAC00-\uD7A3\uA960-\uA97C\uD7B0-\uD7C6";
var EXTRA_CLASS = "\\u0B80-\\u0BFF\\uAC00-\\uD7A3\\uA960-\\uA97C\\uD7B0-\\uD7C6";
var WORD_RE = new RegExp(
  // 字符类中的两个引号：U+0027 直引号与 U+2019 弯引号（don't / don’t 均为 1 词）
  "(?:[0-9]+(?:(?:,|\\.)[0-9]+)*|[\\-'\\u2019" + LATIN_CLASS + EXTRA_CLASS + "])+|[" + CJK_CLASS + "]",
  "g"
);
function countWords(text) {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}
function stripFrontmatter(text) {
  if (!text.startsWith("---"))
    return text;
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}
function stripImagesAndLinks(text) {
  return text.replace(/!\[\[[^\]]*\]\]/g, "").replace(/!\[[^\]]*\]\([^)\n]*\)/g, "").replace(/!\[[^()[\]\n]{100,}\)/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, display) => {
    if (display !== void 0 && display !== "")
      return display;
    const beforeHash = target.split("#");
    const visible = (beforeHash[0] || beforeHash[1] || "").trim();
    const base = visible.split("/").pop() || "";
    return base.replace(/\.[A-Za-z]{1,8}$/, "");
  }).replace(/\[([^\]]*)\]\([^)\n]*\)/g, "$1").replace(/<https?:\/\/[^>\s]+>/g, "").replace(/https?:\/\/[^\s<>)]+/g, "");
}
var WORD_SEGMENT_RE = /^\s*[\d,，.\s]*\d[\d,，.\s]*(?:个\s*词|词|words?)\s*$/i;
var NUMBER_PREFIX_RE = /^(\s*)([\d,，]+)([\s\S]*)$/;
var MAY_NEED_STRIP = ["![[", "![", "[[", "](", "http"];
function mayNeedStripping(text) {
  for (const needle of MAY_NEED_STRIP) {
    if (text.indexOf(needle) >= 0)
      return true;
  }
  return false;
}
var WordCountFixModule = class {
  constructor(ctx) {
    /** 状态栏容器 */
    this.statusBarEl = null;
    this.observer = null;
    /** 上次写入的文本（避免 observer 自触发死循环） */
    this.lastApplied = "";
    /** 被修改元素的原生文本，unload/关闭开关时恢复 */
    this.originalText = "";
    /** 统计缓存：相同输入文本直接复用结果（光标移动等场景零重算） */
    this.cacheInput = null;
    this.cacheCount = 0;
    /** 阅读模式异步读取后的写入令牌，防止竞态覆盖新状态 */
    this.asyncToken = 0;
    /** 在原生 200ms 防抖之上再缓冲一层，合并连续编辑触发的多次更新 */
    this.scheduleFix = (0, import_obsidian17.debounce)(() => this.applyFix(), 250, true);
    this.ctx = ctx;
  }
  load() {
    this.ctx.plugin.app.workspace.onLayoutReady(() => {
      this.statusBarEl = document.querySelector(".status-bar");
      if (!this.statusBarEl)
        return;
      this.observer = new MutationObserver(() => this.scheduleFix());
      this.observer.observe(this.statusBarEl, {
        childList: true,
        subtree: true,
        characterData: true
      });
      this.scheduleFix();
    });
    this.ctx.plugin.register(() => this.cleanup());
  }
  unload() {
    this.cleanup();
  }
  /** 设置页开关切换：开启→立即重算；关闭→恢复原生显示 */
  setEnabled(value) {
    if (value) {
      this.lastApplied = "";
      this.scheduleFix();
    } else {
      this.restoreOriginal();
    }
  }
  cleanup() {
    this.observer?.disconnect();
    this.observer = null;
    this.restoreOriginal();
    this.scheduleFix.cancel();
    this.cacheInput = null;
  }
  /** 恢复被我们替换过的词数 segment 原生文本 */
  restoreOriginal() {
    const el = this.findWordSegment();
    if (el && this.originalText && el.textContent !== this.originalText) {
      el.textContent = this.originalText;
    }
    this.lastApplied = "";
    this.originalText = "";
  }
  applyFix() {
    const enabled = this.ctx.getSettings().wordCountFixEnabled !== false;
    const el = this.findWordSegment();
    if (!el)
      return;
    if (!enabled) {
      if (this.originalText && el.textContent !== this.originalText) {
        el.textContent = this.originalText;
        this.lastApplied = "";
        this.originalText = "";
      }
      return;
    }
    const raw = el.textContent ?? "";
    if (raw === this.lastApplied)
      return;
    const m = NUMBER_PREFIX_RE.exec(raw);
    if (!m)
      return;
    const [, prefix, numStr, suffix] = m;
    const text = this.getSyncText();
    if (text !== null) {
      this.writeFixed(el, raw, prefix, numStr, suffix, this.countFixedWords(text));
      return;
    }
    const file = this.ctx.plugin.app.workspace.getActiveFile();
    if (!(file instanceof import_obsidian17.TFile) || file.extension !== "md")
      return;
    const token = ++this.asyncToken;
    void this.ctx.plugin.app.vault.cachedRead(file).then(
      (content) => {
        if (token !== this.asyncToken)
          return;
        const cur = this.findWordSegment();
        if (!cur || (cur.textContent ?? "") !== raw)
          return;
        this.writeFixed(cur, raw, prefix, numStr, suffix, this.countFixedWords(content));
      },
      () => {
      }
    );
  }
  /** 把修正后的词数写回 segment，保持原生数字格式（千分位）与本地化后缀 */
  writeFixed(el, raw, prefix, numStr, suffix, count) {
    const formatted = numStr.includes(",") || numStr.includes("\uFF0C") ? count.toLocaleString() : String(count);
    this.originalText = raw;
    this.lastApplied = prefix + formatted + suffix;
    el.textContent = this.lastApplied;
  }
  /**
   * 同步获取当前应统计的文本：
   * 有选区→选区文本（与原生 onSelection 一致）；否则→编辑器缓冲全文。
   * 无编辑器（阅读模式/非笔记视图）返回 null 交由异步路径处理。
   */
  getSyncText() {
    const editor = this.ctx.plugin.app.workspace.activeEditor?.editor;
    if (!editor)
      return null;
    const sel = editor.getSelection();
    return sel ? sel : editor.getValue();
  }
  /**
   * 统计修正词数（带输入缓存）。
   *
   * 没有可剥离内容时直接对原文计数，跳过 stripFrontmatter / stripImagesAndLinks
   * 的多次全文替换 —— 这是本模块在 UI 线程上的主要开销。
   */
  countFixedWords(text) {
    if (text === this.cacheInput)
      return this.cacheCount;
    const count = mayNeedStripping(text) ? countWords(stripImagesAndLinks(stripFrontmatter(text))) : countWords(stripFrontmatter(text));
    this.cacheInput = text;
    this.cacheCount = count;
    return count;
  }
  /**
   * 定位原生 word-count 的词数 segment。
   * 它是 span.status-bar-item-segment，文本为数字+本地化词单位（"个词"/"words"）；
   * 字符数 segment（"个字符"/"characters"）与反向链接等其它状态项均不匹配。
   */
  findWordSegment() {
    if (!this.statusBarEl)
      this.statusBarEl = document.querySelector(".status-bar");
    const bar = this.statusBarEl;
    if (!bar)
      return null;
    for (const el of Array.from(bar.querySelectorAll(".status-bar-item-segment"))) {
      const text = el.textContent ?? "";
      if (text && WORD_SEGMENT_RE.test(text))
        return el;
    }
    return null;
  }
};

// modules/SearchEnhancementModule.ts
var import_obsidian18 = require("obsidian");
var TOGGLE_CLASS = "literature-reader-search-ignore-links";
var PARAMS_SELECTOR = ".search-params";
var MAX_PENDING_ATTEMPTS = 20;
var SearchEnhancementModule = class {
  constructor(ctx) {
    /** 已处理的视图 -> 是否安装了 searchQuery 访问器（卸载时逐个还原） */
    this.attachedViews = /* @__PURE__ */ new Map();
    /** 已注入的开关组件，用于搜索面板多视图/设置页之间同步显示 */
    this.toggles = /* @__PURE__ */ new Set();
    /** 被包装的查询类原型及其原 match */
    this.wrappedQueryProto = null;
    this.origMatch = null;
    /** 面板尚未就绪的视图 -> 已搭车重试次数（避免事件时序导致的永久漏挂） */
    this.pendingViews = /* @__PURE__ */ new Map();
    /** 已就未绪告警过的视图（每视图最多一条，避免事件频繁触发时刷屏） */
    this.warnedViews = /* @__PURE__ */ new WeakSet();
    this.ctx = ctx;
  }
  load() {
    const workspace = this.ctx.plugin.app.workspace;
    this.ctx.plugin.registerEvent(workspace.on("layout-change", () => this.attachAll()));
    this.ctx.plugin.registerEvent(workspace.on("active-leaf-change", () => this.attachAll()));
    this.attachAll();
  }
  unload() {
    if (this.wrappedQueryProto && this.origMatch) {
      this.wrappedQueryProto.match = this.origMatch;
      this.wrappedQueryProto = null;
      this.origMatch = null;
    }
    for (const view of Array.from(this.attachedViews.keys())) {
      this.uninstallQueryAccessor(view);
    }
    this.attachedViews.clear();
    this.pendingViews.clear();
    document.querySelectorAll("." + TOGGLE_CLASS).forEach((el) => el.remove());
    this.toggles.clear();
  }
  /**
   * 诊断快照（控制台可调用，用于确认开关是否真的挂上了）：
   * 打开搜索面板后执行 `app.plugins.plugins['pdf-reader'].searchDiagnostics()`
   */
  searchDiagnostics() {
    return {
      \u5DF2\u6302\u8F7D\u89C6\u56FE\u6570: this.attachedViews.size,
      \u5F85\u5C31\u7EEA\u89C6\u56FE\u6570: this.pendingViews.size,
      \u67E5\u8BE2\u7C7B\u5DF2\u5305\u88C5: this.wrappedQueryProto !== null,
      \u5F00\u5173\u7EC4\u4EF6\u6570: this.toggles.size,
      \u641C\u7D22\u53F6\u5B50\u6570: this.ctx.plugin.app.workspace.getLeavesOfType("search").length,
      \u9875\u9762\u5185\u9762\u677F\u6570: document.querySelectorAll(PARAMS_SELECTOR).length,
      \u9875\u9762\u5185\u5F00\u5173\u6570: document.querySelectorAll("." + TOGGLE_CLASS).length,
      \u5FFD\u7565\u94FE\u63A5\u5F00\u5173: this.ignoreLinksEnabled()
    };
  }
  /** 子功能开关当前状态 */
  ignoreLinksEnabled() {
    return this.ctx.getSettings().searchIgnoreLinks === true;
  }
  /** 枚举所有搜索视图（含弹窗窗口）并注入开关、确保补丁就位 */
  attachAll() {
    const leaves = this.ctx.plugin.app.workspace.getLeavesOfType("search");
    for (const leaf of leaves) {
      this.attachView(leaf.view);
    }
    this.retryPendingViews();
  }
  /**
   * 为「上次没找到面板」的视图补挂。
   *
   * 搜索视图在叶子出现时可能尚未构造完（layout-change 早于视图 DOM 就绪），
   * 那时取不到面板；只等下一个 layout-change 有可能一直等不到（用户不再开关面板），
   * 所以让后续的 attachAll（本身由事件驱动）顺带重试，次数用尽后停止。
   */
  retryPendingViews() {
    if (this.pendingViews.size === 0)
      return;
    for (const [view, attempts] of Array.from(this.pendingViews.entries())) {
      if (this.attachedViews.has(view)) {
        this.pendingViews.delete(view);
        continue;
      }
      if (attempts >= MAX_PENDING_ATTEMPTS) {
        this.pendingViews.delete(view);
        console.warn(
          "[LiteratureReader] \u641C\u7D22\u589E\u5F3A\uFF1A\u591A\u6B21\u91CD\u8BD5\u4ECD\u672A\u627E\u5230\u641C\u7D22\u9009\u9879\u9762\u677F\uFF0C\u5FFD\u7565\u94FE\u63A5\u529F\u80FD\u5728\u672C\u89C6\u56FE\u4E2D\u4E0D\u53EF\u7528",
          this.searchDiagnostics()
        );
        continue;
      }
      this.pendingViews.set(view, attempts + 1);
      this.attachView(view);
    }
  }
  attachView(view) {
    if (!view || this.attachedViews.has(view))
      return;
    const paramsEl = this.findParamsPanel(view);
    if (!paramsEl) {
      if (!this.pendingViews.has(view))
        this.pendingViews.set(view, 0);
      if (!this.warnedViews.has(view)) {
        this.warnedViews.add(view);
        console.warn(
          "[LiteratureReader] \u641C\u7D22\u589E\u5F3A\uFF1A\u641C\u7D22\u89C6\u56FE\u5C1A\u672A\u5C31\u7EEA\uFF0C\u5FFD\u7565\u94FE\u63A5\u5F00\u5173\u5C06\u5EF6\u540E\u6CE8\u5165",
          this.searchDiagnostics()
        );
      }
      return;
    }
    this.pendingViews.delete(view);
    this.attachedViews.set(view, false);
    new import_obsidian18.Setting(paramsEl).setName("\u5FFD\u7565\u94FE\u63A5").setClass("mod-toggle").setClass(TOGGLE_CLASS).addToggle((toggle) => {
      toggle.setValue(this.ignoreLinksEnabled());
      toggle.onChange((value) => void this.setIgnoreLinks(value, view));
      this.toggles.add(toggle);
    });
    this.watchPanelDetach(view, paramsEl);
    this.installQueryAccessor(view);
  }
  /**
   * 定位搜索选项面板。命中顺序：
   *  1. 视图自身的 searchParamsContainerEl（官方内部属性，与原生开关同容器）；
   *  2. 视图容器内按类名查 .search-params —— 个别版本该属性未挂出/被改名时仍能命中；
   *  3. 已在同一文档里注入过开关的面板（面板重建且视图引用未更新时复用，避免重复注入）。
   * 找不到（视图尚未构造完）时返回 null，由调用方登记重试。
   */
  findParamsPanel(view) {
    const own = view.searchParamsContainerEl;
    if (own && this.isElement(own) && own.isConnected)
      return own;
    const container = view.containerEl;
    const doc = container?.ownerDocument ?? document;
    if (container && this.isElement(container)) {
      return container.querySelector(PARAMS_SELECTOR) ?? container.querySelector("." + TOGGLE_CLASS)?.parentElement ?? null;
    }
    const injected = doc.querySelector("." + TOGGLE_CLASS);
    return doc.querySelector(PARAMS_SELECTOR) ?? injected?.parentElement ?? null;
  }
  /** 跨 window（弹窗）安全的元素判定：不用当前 realm 的 HTMLElement 构造函数做 instanceof */
  isElement(value) {
    return !!value && typeof value === "object" && value.nodeType === 1;
  }
  /**
   * 面板若被核心搜索重建（DOM 整体重绘），已注入的开关会随之消失。
   * 用 MutationObserver 盯住当前面板：一旦脱离文档，立即重新定位并补挂。
   *
   * 只观察面板所在的叶子容器（而不是 doc.body + subtree）：面板被替换时，
   * childList 变动必然发生在它的某个祖先上，观察叶子容器同样能收到通知，
   * 却不必让引擎记录整个应用（含 CodeMirror 每次重绘）的全部 DOM 变动 ——
   * 后者每个已挂载的搜索视图都会注册一份，用户打字时持续被唤醒。
   */
  watchPanelDetach(view, paramsEl) {
    const containerEl = this.isElement(view.containerEl) ? view.containerEl : null;
    const target = paramsEl.closest(".workspace-leaf-content") ?? containerEl;
    if (!target)
      return;
    const observer = new MutationObserver(() => {
      if (this.attachedViews.has(view) && !paramsEl.isConnected) {
        observer.disconnect();
        this.attachedViews.delete(view);
        this.attachView(view);
      }
    });
    observer.observe(target, { childList: true, subtree: true });
    this.ctx.plugin.register(() => observer.disconnect());
  }
  /** 更新忽略链接开关并持久化；refreshView 为发起修改的视图，切换后立即重搜 */
  async setIgnoreLinks(value, refreshView) {
    this.ctx.getSettings().searchIgnoreLinks = value;
    await this.ctx.saveSettings();
    this.syncToggles(value);
    if (refreshView)
      this.refreshSearch(refreshView);
  }
  /** 同步所有已注入开关的显示状态（设置页修改后调用） */
  syncToggles(value) {
    for (const toggle of this.toggles) {
      if (toggle.getValue() !== value)
        toggle.setValue(value);
    }
  }
  /** 搜索框有内容时重新执行搜索，让开关改动立即作用于当前结果 */
  refreshSearch(view) {
    const query = view.searchComponent?.getValue?.() ?? "";
    if (query && typeof view.startSearch === "function")
      view.startSearch();
  }
  /**
   * 把视图的 searchQuery 包装为访问器：startSearch 内 this.searchQuery = 查询对象
   * 一执行就触发捕获，查询原型在逐文件匹配开始前完成包装，首次搜索即生效。
   */
  installQueryAccessor(view) {
    const self = this;
    const existing = view.searchQuery;
    delete view.searchQuery;
    Object.defineProperty(view, "searchQuery", {
      configurable: true,
      enumerable: true,
      get() {
        return this.__lrSearchQuery;
      },
      set(value) {
        this.__lrSearchQuery = value;
        if (value && typeof value === "object") {
          self.captureQueryProto(Object.getPrototypeOf(value));
        }
      }
    });
    this.attachedViews.set(view, true);
    view.searchQuery = existing;
  }
  /** 卸载时移除访问器并把当前查询对象还原为普通属性 */
  uninstallQueryAccessor(view) {
    const current = view.__lrSearchQuery;
    delete view.searchQuery;
    delete view.__lrSearchQuery;
    if (current !== void 0)
      view.searchQuery = current;
  }
  /** 包装查询类原型的 match(file, content)；返回是否本次新捕获 */
  captureQueryProto(proto) {
    if (this.wrappedQueryProto || !proto)
      return false;
    const queryProto = proto;
    if (typeof queryProto.match !== "function")
      return false;
    this.wrappedQueryProto = proto;
    this.origMatch = queryProto.match;
    const self = this;
    queryProto.match = function(file, content) {
      const result = self.origMatch.call(this, file, content);
      if (self.ignoreLinksEnabled() && result && typeof result === "object" && file && file.extension === "md" && typeof content === "string") {
        try {
          return filterLinkTargetMatches(result, content);
        } catch (e) {
          console.warn("[LiteratureReader] \u5FFD\u7565\u94FE\u63A5\uFF1A\u5339\u914D\u8FC7\u6EE4\u5931\u8D25\uFF0C\u6309\u539F\u6837\u8FD4\u56DE", e);
        }
      }
      return result;
    };
    return true;
  }
};
function getLinkTargetSpans(text) {
  const spans = [];
  const wikilink = /\[\[([^\]\n|]*)(\|[^\]\n]*)?\]\]/g;
  let m;
  while ((m = wikilink.exec(text)) !== null) {
    if (m[2]) {
      const aliasStart = m.index + 2 + m[1].length + 1;
      spans.push([m.index, aliasStart]);
      spans.push([aliasStart + (m[2].length - 1), m.index + m[0].length]);
    } else {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  const mdLink = /\]\(([^)\n]*)\)/g;
  while ((m = mdLink.exec(text)) !== null) {
    spans.push([m.index + 1, m.index + 1 + m[1].length + 2]);
  }
  return spans;
}
function subtractSpans(range, spans) {
  let parts = [[range[0], range[1]]];
  for (const [s, e] of spans) {
    const next = [];
    for (const [a, b] of parts) {
      if (e <= a || s >= b) {
        next.push([a, b]);
        continue;
      }
      if (s > a)
        next.push([a, s]);
      if (e < b)
        next.push([e, b]);
    }
    parts = next;
    if (!parts.length)
      break;
  }
  return parts;
}
function filterLinkTargetMatches(result, content) {
  const spans = getLinkTargetSpans(content);
  const out = {};
  for (const key of Object.keys(result)) {
    const value = result[key];
    const isContentRanges = key === "content" || key.startsWith("canvas-");
    if (!spans.length || !isContentRanges || !Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    const filtered = [];
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "number" || typeof item[1] !== "number") {
        filtered.push(item);
        continue;
      }
      filtered.push(...subtractSpans([item[0], item[1]], spans));
    }
    if (filtered.length)
      out[key] = filtered;
  }
  return Object.keys(out).length ? out : null;
}

// modules/SettingsTab.ts
var import_obsidian19 = require("obsidian");
var UnifiedSettingTab = class extends import_obsidian19.PluginSettingTab {
  constructor(app, plugin, getSettings, saveSettings, searchEnhancement, tagSync, wordCountFix) {
    super(app, plugin);
    /** 防抖保存定时器（连续输入时避免每字符一次全量写盘） */
    this.saveTimer = null;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.searchEnhancement = searchEnhancement;
    this.tagSync = tagSync;
    this.wordCountFix = wordCountFix;
  }
  /**
   * 落盘并如实反馈失败。
   *
   * 标签管理里的增删改名（↑ / ↓ / ✕ / 添加）此前都是 `void this.saveSettings()`，
   * 写盘失败（同步盘冲突、磁盘满、data.json 只读）时既不提示也不重绘，
   * 用户以为改好了，下次打开设置又回到旧值 —— 改动静默丢失。
   */
  async persist() {
    try {
      await this.saveSettings();
    } catch (e) {
      console.error("[pdf-reader] \u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25:", e);
      new import_obsidian19.Notice("\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF0C\u6539\u52A8\u672A\u5199\u5165\u78C1\u76D8\uFF0C\u8BF7\u68C0\u67E5 data.json \u662F\u5426\u53EF\u5199", 8e3);
    }
  }
  /** 500ms 防抖后保存设置 */
  scheduleSave() {
    if (this.saveTimer !== null)
      window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      this.saveTimer = null;
      try {
        await this.saveSettings();
      } catch (e) {
        console.error("[pdf-reader] \u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25:", e);
        new import_obsidian19.Notice("\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF0C\u6539\u52A8\u672A\u5199\u5165\u78C1\u76D8\uFF0C\u8BF7\u68C0\u67E5 data.json \u662F\u5426\u53EF\u5199", 8e3);
      }
    }, 500);
  }
  onClose() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveSettings().catch((e) => {
        console.error("[pdf-reader] \u5173\u95ED\u8BBE\u7F6E\u9875\u65F6\u4FDD\u5B58\u5931\u8D25:", e);
      });
    }
  }
  /**
   * 渲染标签行编辑器：名称 + 描述 + 上移/下移/删除。
   *
   * 名称输入即调用 renameTag() 登记待同步改名 —— 因为每条标签都有永不改变的 id，
   * 「哪个标签改名了」是界面操作的记录，不需要任何推断，也就没有歧义。
   */
  renderTagEditor(rowsHost, pendingHost) {
    rowsHost.empty();
    const settings = this.getSettings();
    const rows = rowsHost.createDiv({ cls: "pdfreader-tag-rows" });
    for (const tag of settings.quickTags) {
      const id = tag.id;
      const row = rows.createDiv({ cls: "pdfreader-tag-row" });
      row.createSpan({ cls: "pdfreader-tag-hash", text: "#" });
      const nameInput = row.createEl("input", { type: "text", cls: "pdfreader-tag-name" });
      nameInput.value = tag.name;
      nameInput.placeholder = "\u6807\u7B7E\u540D";
      const descInput = row.createEl("input", { type: "text", cls: "pdfreader-tag-desc" });
      descInput.value = tag.description;
      descInput.placeholder = "\u63CF\u8FF0\uFF08\u53EF\u7559\u7A7A\uFF09";
      nameInput.addEventListener("input", () => {
        const s = this.getSettings();
        const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, nameInput.value);
        s.quickTags = r.tags;
        s.pendingTagRenames = r.pending;
        this.renderPendingRenames(pendingHost);
        this.scheduleSave();
      });
      nameInput.addEventListener("blur", () => {
        const s = this.getSettings();
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.value = this.revertTagName(id, tag.name);
          new import_obsidian19.Notice("\u6807\u7B7E\u540D\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5DF2\u8FD8\u539F");
        } else if (findDuplicateName(s.quickTags, name, id)) {
          nameInput.value = this.revertTagName(id, tag.name);
          new import_obsidian19.Notice(`\u5DF2\u5B58\u5728\u540C\u540D\u6807\u7B7E\u300C${name}\u300D\uFF0C\u5DF2\u8FD8\u539F`);
        } else {
          const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, name);
          s.quickTags = r.tags;
          s.pendingTagRenames = r.pending;
          if (nameInput.value !== name)
            nameInput.value = name;
        }
        this.renderPendingRenames(pendingHost);
        void this.persist();
      });
      descInput.addEventListener("input", () => {
        const cur = this.getSettings().quickTags.find((t) => t.id === id);
        if (cur)
          cur.description = descInput.value;
        this.scheduleSave();
      });
      const buttons = row.createDiv({ cls: "pdfreader-tag-row-buttons" });
      const up = buttons.createEl("button", { cls: "pdfreader-tag-icon-btn", text: "\u2191" });
      up.setAttribute("aria-label", "\u4E0A\u79FB");
      up.disabled = settings.quickTags[0]?.id === id;
      up.addEventListener("click", () => {
        this.getSettings().quickTags = moveTag(this.getSettings().quickTags, id, -1);
        void this.persist().then(() => this.display());
      });
      const down = buttons.createEl("button", { cls: "pdfreader-tag-icon-btn", text: "\u2193" });
      down.setAttribute("aria-label", "\u4E0B\u79FB");
      down.disabled = settings.quickTags[settings.quickTags.length - 1]?.id === id;
      down.addEventListener("click", () => {
        this.getSettings().quickTags = moveTag(this.getSettings().quickTags, id, 1);
        void this.persist().then(() => this.display());
      });
      const del = buttons.createEl("button", { cls: "pdfreader-tag-icon-btn is-danger", text: "\u2715" });
      del.setAttribute("aria-label", "\u5220\u9664\u6807\u7B7E");
      del.addEventListener("click", () => void this.deleteTagRow(id));
    }
    const addBtn = rowsHost.createEl("button", { text: "\uFF0B \u6DFB\u52A0\u6807\u7B7E", cls: "pdfreader-tag-add" });
    addBtn.addEventListener("click", () => {
      this.getSettings().quickTags.push({ id: newTagId(), name: "\u65B0\u6807\u7B7E", description: "" });
      void this.persist().then(() => this.display());
    });
  }
  /**
   * 把标签名回退到旧名（优先用待办里的 from），并撤销对应的待同步项。
   * @returns 回退后实际生效的名称
   */
  revertTagName(id, fallback) {
    const s = this.getSettings();
    const pending = (s.pendingTagRenames ?? []).find((p) => p.id === id);
    const back = pending ? pending.from : fallback;
    const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, back);
    s.quickTags = r.tags;
    s.pendingTagRenames = r.pending;
    void this.persist();
    return back;
  }
  /**
   * 删除一行标签：先从词表移除（非破坏性），再询问是否清理笔记里的残留引用。
   *
   * 按 id 现查名字，不用渲染期的快照：改名走的是 renameTag（返回新对象），
   * 只要期间发生过一次重绘（↑ / ↓ / 添加标签），闭包里的旧名字就过期了。
   * 而过期的名字正是「尚未同步的旧名」—— 用新名去全库查找会一无所获，
   * 直接把 offerNoteCleanup 变成静默空转：词表没了、待办没了、笔记里的旧标签永久残留。
   * 因此这里同时用「当前名」和待办里的 from（笔记中实际存在的旧名）作为清理目标。
   */
  async deleteTagRow(id) {
    const s = this.getSettings();
    const currentName = s.quickTags.find((t) => t.id === id)?.name;
    const oldName = (s.pendingTagRenames ?? []).find((p) => p.id === id)?.from;
    const r = removeTag(s.quickTags, s.pendingTagRenames ?? [], id);
    s.quickTags = r.tags;
    s.pendingTagRenames = r.pending;
    await this.persist();
    this.display();
    if (!this.tagSync)
      return;
    const targets = [currentName, oldName].filter((n) => !!n);
    if (targets.length === 0)
      return;
    if (oldName && currentName && oldName !== currentName) {
      new import_obsidian19.Notice(`\u6807\u7B7E #${oldName} \u7684\u6539\u540D\u5C1A\u672A\u540C\u6B65\uFF0C\u5DF2\u968F\u5220\u9664\u4E00\u5E76\u53D6\u6D88`, 6e3);
    }
    await this.tagSync.offerNoteCleanupForNames(targets);
  }
  /** 渲染待同步改名区：列出待办 + 同步/撤销按钮 */
  renderPendingRenames(host) {
    host.empty();
    const tagSync = this.tagSync;
    if (!tagSync)
      return;
    const pending = tagSync.getPendingRenames();
    if (pending.length === 0)
      return;
    const box = host.createDiv({ cls: "pdfreader-tag-changes" });
    box.createEl("h4", { text: `${pending.length} \u9879\u6539\u540D\u5F85\u540C\u6B65\u5230\u7B14\u8BB0` });
    const list = box.createDiv({ cls: "pdfreader-tag-change-list" });
    for (const p of pending) {
      const row = list.createDiv({ cls: "pdfreader-tag-change-row" });
      row.createSpan({ cls: "pdfreader-tag-change-text", text: `#${p.from} \u2192 #${p.to}` });
    }
    const buttons = box.createDiv({ cls: "pdfreader-tag-actions" });
    const syncBtn = buttons.createEl("button", { text: "\u540C\u6B65\u5230\u7B14\u8BB0", cls: "mod-cta" });
    syncBtn.addEventListener("click", () => {
      void tagSync.applyPendingRenames().then(() => this.display());
    });
    const revertBtn = buttons.createEl("button", { text: "\u64A4\u9500\u6539\u540D" });
    revertBtn.addEventListener("click", () => {
      void tagSync.revertPendingRenames().then(() => this.display());
    });
    box.createEl("p", {
      cls: "pdfreader-tag-hint",
      text: "\u300C\u540C\u6B65\u5230\u7B14\u8BB0\u300D\u628A\u7B14\u8BB0\u91CC\u7684\u65E7\u540D\u6279\u91CF\u6362\u6210\u65B0\u540D\uFF08\u76F4\u63A5\u6539\u5199\u7B14\u8BB0\u539F\u6587\uFF0C\u65E0\u6CD5\u64A4\u9500\uFF09\uFF1B\u300C\u64A4\u9500\u6539\u540D\u300D\u628A\u8BCD\u8868\u6539\u56DE\u65E7\u540D\u5E76\u6E05\u7A7A\u5F85\u529E\uFF0C\u4E24\u8005\u90FD\u80FD\u8BA9\u8BCD\u8868\u4E0E\u7B14\u8BB0\u91CD\u65B0\u4E00\u81F4\u3002"
    });
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "PDF \u9605\u8BFB\u8BBE\u7F6E" });
    new import_obsidian19.Setting(containerEl).setName("\u9605\u8BFB\u7B14\u8BB0\u6587\u4EF6\u5939").setDesc("\u65B0\u521B\u5EFA\u7684\u9605\u8BFB\u7B14\u8BB0\u5C06\u5B58\u653E\u5728\u6B64\u6587\u4EF6\u5939\u4E2D\uFF08\u76F8\u5BF9 vault \u6839\u76EE\u5F55\uFF09").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.readingNoteFolder).setValue(this.getSettings().readingNoteFolder).onChange(async (value) => {
      this.getSettings().readingNoteFolder = value.trim() || DEFAULT_SETTINGS.readingNoteFolder;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u9605\u8BFB\u7B14\u8BB0\u547D\u540D\u6A21\u677F").setDesc("\u65B0\u5EFA\u9605\u8BFB\u7B14\u8BB0\u7684\u6587\u4EF6\u540D\u89C4\u5219\uFF0C{name} \u4E3A PDF \u6587\u4EF6\u540D\uFF08\u4E0D\u542B\u6269\u5C55\u540D\uFF09\u3002\u9700\u5305\u542B {name}\uFF0C\u5426\u5219\u6309\u9ED8\u8BA4\u6A21\u677F\u5904\u7406").addText((text) => text.setPlaceholder(DEFAULT_NOTE_NAME_TEMPLATE).setValue(this.getSettings().readingNoteNameTemplate || DEFAULT_NOTE_NAME_TEMPLATE).onChange(async (value) => {
      const v = value.trim();
      this.getSettings().readingNoteNameTemplate = isValidNameTemplate(v) ? v : DEFAULT_NOTE_NAME_TEMPLATE;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u7B14\u8BB0\u6B63\u6587\u6A21\u677F").setDesc("\u65B0\u521B\u5EFA\u9605\u8BFB\u7B14\u8BB0\u7684\u6B63\u6587\u5185\u5BB9\uFF0C\u53EF\u81EA\u7531\u4FEE\u6539\u677F\u5757\u6807\u9898\uFF1B\u7559\u7A7A\u5219\u6B63\u6587\u4E3A\u7A7A").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.setPlaceholder("\u7559\u7A7A\u5219\u65B0\u5EFA\u7B14\u8BB0\u6B63\u6587\u4E3A\u7A7A").setValue(this.getSettings().readingNoteBodyTemplate || "").onChange(async (value) => {
        this.getSettings().readingNoteBodyTemplate = value.replace(/\r\n/g, "\n");
        this.scheduleSave();
      });
    });
    new import_obsidian19.Setting(containerEl).setName("\u9AD8\u4EAE\u989C\u8272").setDesc("\u6279\u6CE8\u5728 PDF \u4E0A\u6301\u4E45\u9AD8\u4EAE\u7684\u586B\u5145\u8272\uFF08\u6587\u5B57\u6279\u6CE8\u4E0E OCR \u533A\u57DF\u9AD8\u4EAE\u5171\u7528\uFF09").addColorPicker((color) => color.setValue(this.normalizeHex(this.getSettings().highlightColor)).onChange(async (value) => {
      this.getSettings().highlightColor = value;
      await this.saveSettings();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u9AD8\u4EAE\u900F\u660E\u5EA6").setDesc("\u6301\u4E45\u9AD8\u4EAE\u7684\u4E0D\u900F\u660E\u5EA6\uFF080.05 - 1\uFF09").addSlider((slider) => slider.setLimits(0.05, 1, 0.05).setDynamicTooltip().setValue(this.clampOpacity(this.getSettings().highlightOpacity)).onChange(async (value) => {
      this.getSettings().highlightOpacity = value;
      await this.saveSettings();
    }));
    containerEl.createEl("hr");
    containerEl.createEl("h2", { text: "\u6279\u6CE8\u683C\u5F0F\u4E0E\u754C\u9762" });
    new import_obsidian19.Setting(containerEl).setName("\u6279\u6CE8\u94FE\u63A5\u522B\u540D").setDesc("\u6279\u6CE8\u56DE\u94FE PDF \u7684\u94FE\u63A5\u663E\u793A\u6587\u5B57\uFF08\u5199\u5165\u7B14\u8BB0\u6B63\u6587\uFF09\uFF0C\u7559\u7A7A\u6062\u590D\u9ED8\u8BA4\uFF1B\u4E0D\u80FD\u542B | [ ] \u6216\u6362\u884C\uFF08\u4F1A\u7834\u574F\u751F\u6210\u7684\u94FE\u63A5\uFF09\uFF0C\u8FD9\u4E9B\u5B57\u7B26\u4F1A\u88AB\u81EA\u52A8\u53BB\u6389").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.annotationLinkLabel).setValue(this.getSettings().annotationLinkLabel || DEFAULT_SETTINGS.annotationLinkLabel).onChange(async (value) => {
      const clean = sanitizeLinkAlias(value);
      if (value.trim() && !clean) {
        new import_obsidian19.Notice("\u522B\u540D\u4E0D\u80FD\u53EA\u7531 | [ ] \u6216\u6362\u884C\u7EC4\u6210\uFF0C\u5DF2\u6062\u590D\u9ED8\u8BA4");
      } else if (clean !== value.trim()) {
        new import_obsidian19.Notice(`\u522B\u540D\u4E2D\u7684 | [ ] \u4E0E\u6362\u884C\u4F1A\u88AB\u81EA\u52A8\u53BB\u6389\uFF1A\u300C${clean || DEFAULT_SETTINGS.annotationLinkLabel}\u300D`);
        text.setValue(clean || DEFAULT_SETTINGS.annotationLinkLabel);
      }
      this.getSettings().annotationLinkLabel = clean || DEFAULT_SETTINGS.annotationLinkLabel;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u6279\u6CE8\u63D0\u793A\u884C").setDesc("\u6279\u6CE8 callout \u672B\u5C3E\u7684\u63D0\u793A\u884C\uFF08\u5199\u5165\u7B14\u8BB0\u6B63\u6587\uFF09\uFF1B\u9700\u4EE5 > \u5F00\u5934\uFF0C\u4E0D\u8DB3\u65F6\u81EA\u52A8\u8865\u5168").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.annotationPromptLine).setValue(this.getSettings().annotationPromptLine || DEFAULT_SETTINGS.annotationPromptLine).onChange(async (value) => {
      const v = value.trim();
      let line = v || DEFAULT_SETTINGS.annotationPromptLine;
      if (!line.startsWith(">"))
        line = `> ${line}`;
      this.getSettings().annotationPromptLine = line;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u9ED8\u8BA4\u9644\u5E26\u539F\u6587").setDesc("\u5F00\u542F\u540E\u5DE5\u5177\u6761\u300C\u9644\u5E26\u539F\u6587\u300D\u6309\u94AE\u521D\u59CB\u4E3A\u6253\u5F00\u72B6\u6001\uFF1B\u7528\u6309\u94AE\u5207\u6362\u4E5F\u4F1A\u88AB\u8BB0\u4F4F").addToggle((toggle) => toggle.setValue(this.getSettings().annotationIncludeOriginalText === true).onChange(async (value) => {
      this.getSettings().annotationIncludeOriginalText = value;
      await this.saveSettings();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u6587\u4EF6\u7BA1\u7406\u5668\u9605\u8BFB\u7B14\u8BB0\u6807\u8BB0").setDesc("\u4E3A\u5DF2\u6709\u9605\u8BFB\u7B14\u8BB0\u7684 PDF \u4E0E Markdown \u6587\u732E\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u663E\u793A\u5C0F\u56FE\u6807\uFF1B\u5173\u95ED\u540E\u9690\u85CF\uFF08\u4EFB\u610F\u5E03\u5C40\u53D8\u5316\u5373\u6E05\u7A7A\uFF09").addToggle((toggle) => toggle.setValue(this.getSettings().fileMarkerEnabled !== false).onChange(async (value) => {
      this.getSettings().fileMarkerEnabled = value;
      await this.saveSettings();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u5B57\u6570\u7EDF\u8BA1\u4FEE\u6B63").setDesc("\u72B6\u6001\u680F\u8BCD\u6570\u4E0D\u518D\u628A\u56FE\u7247\u5D4C\u5165\u3001\u94FE\u63A5\u4E0E base64 \u6570\u636E\u7B97\u4F5C\u6B63\u6587\uFF1A![[\u56FE\u7247]]/![](data:...) \u6574\u4F53\u79FB\u9664\uFF0C[[\u76EE\u6807|\u522B\u540D]] \u53EA\u8BA1\u522B\u540D\uFF0C[[\u76EE\u6807]] \u53EA\u8BA1\u663E\u793A\u540D\uFF0C[\u6587\u5B57](\u7F51\u5740) \u53EA\u8BA1\u6587\u5B57\uFF0C\u88F8\u7F51\u5740\u79FB\u9664\uFF1B\u5B57\u7B26\u6570\u4FDD\u6301\u539F\u751F\u4E0D\u53D8\u3002\u7EDF\u8BA1\u53E3\u5F84\u4E0E Obsidian \u539F\u751F\u5B8C\u5168\u4E00\u81F4\uFF0C\u4EC5\u5254\u9664\u56FE\u7247\u4E0E\u94FE\u63A5").addToggle((toggle) => toggle.setValue(this.getSettings().wordCountFixEnabled !== false).onChange(async (value) => {
      this.getSettings().wordCountFixEnabled = value;
      await this.saveSettings();
      this.wordCountFix?.setEnabled(value);
    }));
    containerEl.createEl("hr");
    containerEl.createEl("h2", { text: "\u6807\u7B7E\u7BA1\u7406" });
    containerEl.createEl("p", {
      text: "\u6BCF\u4E2A\u6807\u7B7E\u6709\u4E00\u4E2A\u4E0D\u4F1A\u6539\u53D8\u7684\u5185\u90E8 id\uFF0C\u56E0\u6B64\u6539\u540D\u662F\u53EF\u7CBE\u786E\u8BB0\u5F55\u7684\uFF0C\u4E0D\u9700\u8981\u4EFB\u4F55\u731C\u6D4B\u914D\u5BF9\u3002\u63CF\u8FF0\u53EA\u663E\u793A\u5728\u5FEB\u901F\u6807\u7B7E\u9009\u62E9\u5668\u91CC\uFF0C\u4E0D\u4F1A\u5199\u8FDB\u7B14\u8BB0\uFF0C\u53EF\u7701\u7565\u3002\u9605\u8BFB\u65F6\u7ECF PDF \u5DE5\u5177\u6761\u300C\u6807\u7B7E\u300D\u6309\u94AE\u6216\u5FEB\u6377\u952E\uFF0C\u4E00\u6B65\u63D2\u5165\u5230\u9605\u8BFB\u7B14\u8BB0\u7684\u5149\u6807\u5904\uFF1B\u63D2\u5165\u843D\u70B9\u4E0E\u6279\u6CE8\u4E00\u81F4 \u2014\u2014 \u90FD\u662F\u4F60\u5149\u6807\u6240\u5728\u7684\u90A3\u7BC7\u7B14\u8BB0\u3002"
    });
    const tagRowsHost = containerEl.createDiv();
    const tagPendingHost = containerEl.createDiv({ cls: "pdfreader-tag-changes-host" });
    this.renderTagEditor(tagRowsHost, tagPendingHost);
    this.renderPendingRenames(tagPendingHost);
    new import_obsidian19.Setting(containerEl).setName("\u5DE5\u5177\u6761\u300C\u6807\u7B7E\u300D\u6309\u94AE").setDesc("\u5728\u6BCF\u4E2A PDF \u89C6\u56FE\u7684\u9875\u7801\u65C1\u663E\u793A\u300C\u6807\u7B7E\u300D\u6309\u94AE\u3002\u5173\u95ED\u540E\u4ECD\u53EF\u7528\u547D\u4EE4\u300C\u5FEB\u901F\u6DFB\u52A0\u6807\u7B7E\u300D\uFF1B\u5728 \u8BBE\u7F6E \u2192 \u5FEB\u6377\u952E \u4E2D\u641C\u7D22\u8BE5\u547D\u4EE4\u5373\u53EF\u7ED1\u5B9A\u4EFB\u610F\u6309\u952E").addToggle((toggle) => toggle.setValue(this.getSettings().quickTagToolbarButton !== false).onChange(async (value) => {
      this.getSettings().quickTagToolbarButton = value;
      await this.saveSettings();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u4ECE\u7B14\u8BB0\u4E2D\u5220\u9664\u6807\u7B7E").setDesc("\u4ECE\u6240\u6709\u7B14\u8BB0\u4E2D\u79FB\u9664\u67D0\u4E2A\u6807\u7B7E\u7684\u6B63\u6587\u5F15\u7528\u3002\u4F1A\u5148\u5217\u51FA\u5168\u5E93\u5B9E\u9645\u51FA\u73B0\u7684\u6807\u7B7E\u3001\u663E\u793A\u9010\u884C\u9884\u89C8\u5E76\u4E8C\u6B21\u786E\u8BA4\uFF1B\u76F4\u63A5\u6539\u5199\u7B14\u8BB0\u539F\u6587\uFF0C\u65E0\u6CD5\u64A4\u9500").addButton((btn) => btn.setButtonText("\u9009\u62E9\u6807\u7B7E\u2026").onClick(() => {
      if (this.tagSync)
        void this.tagSync.openDeletePicker();
    }));
    containerEl.createEl("hr");
    containerEl.createEl("h2", { text: "\u641C\u7D22\u589E\u5F3A" });
    new import_obsidian19.Setting(containerEl).setName("\u5FFD\u7565\u94FE\u63A5").setDesc("\u6838\u5FC3\u641C\u7D22\u65F6\u5FFD\u7565 [[\u94FE\u63A5\u76EE\u6807|\u522B\u540D]] \u7684\u76EE\u6807\u6587\u672C\uFF08\u542B PDF \u8DEF\u5F84\u4E0E #page \u5B9A\u4F4D\u53C2\u6570\uFF09\uFF0C\u53EA\u5339\u914D\u6B63\u6587\u4E0E\u522B\u540D\uFF0C\u6279\u6CE8\u56DE\u94FE\u4E0D\u518D\u6DF9\u6CA1\u641C\u7D22\u7ED3\u679C\u3002\u5F00\u5173\u4E5F\u4F4D\u4E8E\u641C\u7D22\u9762\u677F\u9009\u9879\u533A\uFF08\u6ED1\u5757\u56FE\u6807\uFF09\uFF0C\u5728\u90A3\u91CC\u5207\u6362\u4F1A\u7ACB\u5373\u91CD\u65B0\u641C\u7D22").addToggle((toggle) => toggle.setValue(this.getSettings().searchIgnoreLinks === true).onChange(async (value) => {
      this.getSettings().searchIgnoreLinks = value;
      await this.saveSettings();
      this.searchEnhancement?.syncToggles(value);
    }));
    containerEl.createEl("hr");
    containerEl.createEl("h2", { text: "DeepSeek \u7A97\u53E3\u8BBE\u7F6E" });
    containerEl.createEl("p", {
      text: "\u63D0\u793A\uFF1A\u9009\u62E9\u300C\u6D6E\u52A8\u7A97\u53E3\u300D\u65F6\u53EF\u62D6\u52A8\u6807\u9898\u680F\u79FB\u52A8\u3001\u62D6\u52A8\u8FB9\u7F18\u8C03\u6574\u5927\u5C0F\uFF0C\u4F4D\u7F6E\u4E0E\u5927\u5C0F\u81EA\u52A8\u8BB0\u4F4F\uFF1B\u9009\u62E9\u300C\u6807\u7B7E\u9875\u300D\u65F6\u5728 Obsidian \u5DE5\u4F5C\u533A\u4E2D\u4EE5\u6807\u7B7E\u9875\u6253\u5F00\u3002",
      cls: "setting-item-description"
    });
    new import_obsidian19.Setting(containerEl).setName("DeepSeek URL").setDesc("\u5D4C\u5165 DeepSeek \u7A97\u53E3/\u6807\u7B7E\u9875\u7684\u7F51\u9875\u5730\u5740\uFF1B\u4FEE\u6539\u540E\u4E0B\u6B21\u6253\u5F00\u65F6\u81EA\u52A8\u91CD\u65B0\u52A0\u8F7D\uFF08\u987B\u4E3A http/https \u5730\u5740\uFF09").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.deepseekUrl).setValue(this.getSettings().deepseekUrl).onChange(async (value) => {
      const raw = value.trim();
      if (!raw) {
        this.getSettings().deepseekUrl = DEFAULT_SETTINGS.deepseekUrl;
      } else if (isValidHttpUrl(raw)) {
        this.getSettings().deepseekUrl = raw;
      } else {
        new import_obsidian19.Notice(`\u300C${raw}\u300D\u4E0D\u662F\u6709\u6548\u7684 http/https \u5730\u5740\uFF0C\u5DF2\u8FD8\u539F\u4E3A ${DEFAULT_SETTINGS.deepseekUrl}`);
        this.getSettings().deepseekUrl = DEFAULT_SETTINGS.deepseekUrl;
        text.setValue(DEFAULT_SETTINGS.deepseekUrl);
      }
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u9ED8\u8BA4\u6253\u5F00\u65B9\u5F0F").setDesc("\u70B9\u51FB\u5DE6\u4FA7\u680F\u673A\u5668\u4EBA\u56FE\u6807\u6216\u4F7F\u7528\u300C\u6253\u5F00 DeepSeek\u300D\u547D\u4EE4\u65F6\u91C7\u7528\u7684\u65B9\u5F0F\uFF1B\u4E5F\u53EF\u7528\u547D\u4EE4\u5355\u72EC\u6253\u5F00\u6D6E\u52A8\u7A97\u53E3\u6216\u6807\u7B7E\u9875").addDropdown((dropdown) => dropdown.addOption("floating", "\u6D6E\u52A8\u7A97\u53E3").addOption("tab", "\u6807\u7B7E\u9875").setValue(this.getSettings().deepseekOpenMode).onChange(async (value) => {
      this.getSettings().deepseekOpenMode = value;
      await this.saveSettings();
    }));
    containerEl.createEl("hr");
    containerEl.createEl("h2", { text: "\u622A\u56FE OCR \u6279\u6CE8\u8BBE\u7F6E" });
    new import_obsidian19.Setting(containerEl).setName("LM Studio \u670D\u52A1\u5668\u5730\u5740").setDesc("OpenAI \u517C\u5BB9\u63A5\u53E3\u5730\u5740\uFF0C\u9700\u5148\u542F\u52A8 LM Studio \u5E76\u52A0\u8F7D\u89C6\u89C9\u6A21\u578B").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.ocrServerUrl).setValue(this.getSettings().ocrServerUrl).onChange(async (value) => {
      this.getSettings().ocrServerUrl = value.trim() || DEFAULT_SETTINGS.ocrServerUrl;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("LM Studio API Key").setDesc("LM Studio \u5F00\u542F Require Authentication \u65F6\u5FC5\u586B\uFF0C\u4E0E kdata \u7684 token \u76F8\u540C\u3002\u26A0\uFE0F \u5B89\u5168\u63D0\u793A\uFF1A\u5BC6\u94A5\u4EE5\u660E\u6587\u4FDD\u5B58\u5728 vault \u5185\u63D2\u4EF6\u76EE\u5F55\u7684 data.json \u4E2D\uFF0C\u8BF7\u52FF\u5C06 vault \u540C\u6B65/\u5171\u4EAB\u5230\u4E0D\u53D7\u4FE1\u4EFB\u7684\u4F4D\u7F6E\uFF0C\u5E76\u5EFA\u8BAE\u5B9A\u671F\u5728 LM Studio \u4E2D\u8F6E\u6362\u5BC6\u94A5\uFF1B\u4E0D\u4F7F\u7528\u9274\u6743\u65F6\u53EF\u7559\u7A7A\u3002").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("sk-lm-...").setValue(this.getSettings().ocrApiKey).onChange(async (value) => {
        this.getSettings().ocrApiKey = value.trim();
        this.scheduleSave();
      });
    });
    new import_obsidian19.Setting(containerEl).setName("OCR \u6A21\u578B").setDesc("\u81EA\u7531\u586B\u5199\u670D\u52A1\u5668\u4E0A\u7684\u89C6\u89C9\u6A21\u578B\u540D\uFF1B\u63A8\u8350 paddleocr-vl-1.6\uFF0C\u7559\u7A7A\u5219\u6309\u6B64\u4F18\u5148\u81EA\u52A8\u9009\u62E9").addText((text) => text.setPlaceholder("paddleocr-vl-1.6\uFF08\u63A8\u8350\uFF09").setValue(this.getSettings().ocrModel).onChange(async (value) => {
      this.getSettings().ocrModel = value.trim();
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u8BF7\u6C42\u8D85\u65F6\uFF08\u79D2\uFF09").setDesc("\u5355\u6B21 OCR \u8BF7\u6C42\u8D85\u65F6\u65F6\u95F4").addText((text) => text.setPlaceholder(String(DEFAULT_SETTINGS.ocrRequestTimeoutSec)).setValue(String(this.getSettings().ocrRequestTimeoutSec)).onChange(async (value) => {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n) && n >= 10) {
        this.getSettings().ocrRequestTimeoutSec = n;
        this.scheduleSave();
      }
    }));
    new import_obsidian19.Setting(containerEl).setName("\u6700\u5927\u8F93\u51FA\u4EE4\u724C").setDesc("\u5355\u6B21\u8BC6\u522B\u8BF7\u6C42\u5141\u8BB8\u7684\u6700\u5927\u8F93\u51FA\u957F\u5EA6\uFF08token\uFF09\uFF0C\u6846\u9009\u533A\u57DF\u6587\u672C\u8F83\u591A\u65F6\u53EF\u8C03\u5927").addText((text) => text.setPlaceholder(String(DEFAULT_SETTINGS.ocrMaxTokens)).setValue(String(this.getSettings().ocrMaxTokens)).onChange(async (value) => {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n) && n >= 512) {
        this.getSettings().ocrMaxTokens = n;
        this.scheduleSave();
      }
    }));
    new import_obsidian19.Setting(containerEl).setName("OCR \u63D0\u793A\u8BCD").setDesc("PaddleOCR-VL \u4F7F\u7528\u5B98\u65B9\u4EFB\u52A1\u8BCD\uFF08\u5982 OCR:\uFF09").addTextArea((text) => text.setPlaceholder(DEFAULT_SETTINGS.ocrPrompt).setValue(this.getSettings().ocrPrompt).onChange(async (value) => {
      this.getSettings().ocrPrompt = value || DEFAULT_SETTINGS.ocrPrompt;
      this.scheduleSave();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u6E05\u6D17 OCR \u8F93\u51FA").setDesc("\u53BB\u9664 HTML/LaTeX \u5305\u88C5\u7B49\u6A21\u578B\u566A\u97F3\uFF1B\u5173\u95ED\u540E\u539F\u6837\u4FDD\u7559\u6A21\u578B\u8F93\u51FA\uFF08\u4FDD\u7559 LaTeX \u547D\u4EE4\u4E0E\u4EE3\u7801\u5757\uFF0C\u9002\u5408\u516C\u5F0F\u5BC6\u96C6\u573A\u666F\uFF09").addToggle((toggle) => toggle.setValue(this.getSettings().ocrSanitizeOutput !== false).onChange(async (value) => {
      this.getSettings().ocrSanitizeOutput = value;
      await this.saveSettings();
    }));
    new import_obsidian19.Setting(containerEl).setName("\u653E\u5927\u76EE\u6807\u77ED\u8FB9\uFF08\u50CF\u7D20\uFF09").setDesc("\u6846\u9009\u533A\u57DF\u77ED\u8FB9\u4E0D\u8DB3\u8BE5\u503C\u65F6\u7B49\u6BD4\u653E\u5927\u540E\u518D\u9001 OCR\uFF0C\u5C0F\u5B57\u66F4\u6E05\u6670\uFF1B\u8BBE\u4E3A 0 \u5173\u95ED\u653E\u5927").addText((text) => text.setPlaceholder(String(DEFAULT_SETTINGS.ocrMinSidePx)).setValue(String(this.getSettings().ocrMinSidePx ?? DEFAULT_SETTINGS.ocrMinSidePx)).onChange(async (value) => {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 4096) {
        this.getSettings().ocrMinSidePx = n;
        this.scheduleSave();
      }
    }));
    new import_obsidian19.Setting(containerEl).setName("\u653E\u5927\u500D\u7387\u4E0A\u9650").setDesc("\u5C0F\u533A\u57DF\u653E\u5927\u7684\u6700\u5927\u500D\u6570\uFF081 - 8\uFF09\uFF0C\u4F4E\u914D\u8BBE\u5907\u53EF\u8C03\u4F4E").addText((text) => text.setPlaceholder(String(DEFAULT_SETTINGS.ocrMaxUpscaleFactor)).setValue(String(this.getSettings().ocrMaxUpscaleFactor ?? DEFAULT_SETTINGS.ocrMaxUpscaleFactor)).onChange(async (value) => {
      const n = parseFloat(value);
      if (!Number.isNaN(n) && n >= 1 && n <= 8) {
        this.getSettings().ocrMaxUpscaleFactor = n;
        this.scheduleSave();
      }
    }));
    new import_obsidian19.Setting(containerEl).setName("\u6D4B\u8BD5\u8FDE\u63A5").setDesc("\u68C0\u6D4B\u670D\u52A1\u5668\u53EF\u8FBE\u6027\u5E76\u5217\u51FA\u53EF\u7528\u6A21\u578B").addButton((btn) => btn.setButtonText("\u6D4B\u8BD5\u8FDE\u63A5").onClick(async () => {
      const service = new OcrService(this.getSettings().ocrServerUrl, this.getSettings().ocrApiKey);
      btn.setButtonText("\u6D4B\u8BD5\u4E2D\u2026").setDisabled(true);
      try {
        const models = await service.listModels();
        new import_obsidian19.Notice(`\u8FDE\u63A5\u6210\u529F\uFF0C\u53EF\u7528\u6A21\u578B\uFF1A
${models.join("\n")}`, 8e3);
      } catch (e) {
        new import_obsidian19.Notice(`\u8FDE\u63A5\u5931\u8D25: ${e.message}`);
      } finally {
        btn.setButtonText("\u6D4B\u8BD5\u8FDE\u63A5").setDisabled(false);
      }
    }));
  }
  /** 把任意存量颜色值规范成 #RRGGBB 供取色器显示（非法值回退默认黄色） */
  normalizeHex(input) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec((input ?? "").trim());
    return m ? `#${m[1]}` : DEFAULT_SETTINGS.highlightColor;
  }
  clampOpacity(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
      return DEFAULT_SETTINGS.highlightOpacity;
    return Math.min(1, Math.max(0.05, n));
  }
};
function isValidHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

// modules/noteContentCache.ts
var NoteContentCache = class {
  constructor(plugin, ttlMs = 500) {
    this.plugin = plugin;
    this.ttlMs = ttlMs;
    this.cache = /* @__PURE__ */ new Map();
    /**
     * 每个路径的「失效代数」。
     *
     * read() 里 await 读盘期间，文件可能被修改/删除/重命名并触发失效；
     * 若不加判定就写回，会把**读取开始前**的旧内容重新塞进缓存，
     * 使接下来 TTL 内的重建读到脏数据（正是本缓存要避免的情况）。
     */
    this.generation = /* @__PURE__ */ new Map();
  }
  /** 注册写入失效监听（插件加载时调用一次；事件随插件卸载自动清理） */
  attach() {
    const invalidate = (file) => this.invalidate(file.path);
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", invalidate));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", invalidate));
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        this.invalidate(oldPath);
        this.invalidate(file.path);
      })
    );
  }
  /** 失效一条缓存：删除条目并推进代数，使在途读取的结果不再被写回 */
  invalidate(path) {
    this.cache.delete(path);
    this.generation.set(path, (this.generation.get(path) ?? 0) + 1);
  }
  /** 读取笔记内容：优先打开中的编辑器缓冲，其次磁盘（带短 TTL 缓存） */
  async read(sourceFile, opts) {
    const editorMode = opts?.editorMode ?? "any";
    const app = this.plugin.app;
    let editorContent = null;
    app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (editorContent !== null)
        return;
      const view = leaf.view;
      if (view.file?.path !== sourceFile.path || !view.editor)
        return;
      if (editorMode === "source" && view.getMode() !== "source")
        return;
      editorContent = view.editor.getValue();
    });
    if (editorContent !== null)
      return editorContent;
    const cached = this.cache.get(sourceFile.path);
    const now = Date.now();
    if (cached && now - cached.at < this.ttlMs)
      return cached.content;
    const genAtStart = this.generation.get(sourceFile.path) ?? 0;
    const content = await app.vault.read(sourceFile);
    if ((this.generation.get(sourceFile.path) ?? 0) === genAtStart) {
      this.cache.set(sourceFile.path, { content, at: now });
    }
    return content;
  }
};

// main.ts
var LiteratureReaderPlugin = class extends import_obsidian20.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.modules = [];
    /** 公开 PDF 模块实例，供 pdf-ocr 等插件调用批注 API */
    this.pdfModule = null;
  }
  async onload() {
    await this.loadSettings();
    const noteContentCache = new NoteContentCache(this);
    noteContentCache.attach();
    toolbarPoller.setGate(() => {
      let hasPdfLeaf = false;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!hasPdfLeaf && leaf.view.getViewType() === "pdf")
          hasPdfLeaf = true;
      });
      return hasPdfLeaf;
    });
    const ctx = {
      plugin: this,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      readNoteContent: (file) => noteContentCache.read(file)
    };
    const pdfModule = new PdfReaderModule(ctx);
    this.pdfModule = pdfModule;
    const quickTagModule = new QuickTagModule(ctx, pdfModule);
    const markdownReadingModule = new MarkdownReadingModule(ctx, pdfModule, quickTagModule);
    pdfModule.setReadingSourceProvider((path) => markdownReadingModule.setReadingSource(path));
    const highlightModule = new PdfHighlightModule(ctx);
    pdfModule.setRefreshHighlights((file, selections) => highlightModule.refresh(file, selections));
    const screenshotModule = new ScreenshotModule(ctx, pdfModule);
    const screenshotHighlightModule = new ScreenshotHighlightModule(ctx);
    screenshotModule.setHighlightRefresh((file, entries) => screenshotHighlightModule.refresh(file, entries));
    const ocrHighlightModule = new OcrHighlightModule(ctx);
    pdfModule.setRefreshRectHighlights((file, entries) => ocrHighlightModule.refresh(file, entries));
    const ocrModule = new OcrModule(ctx, pdfModule);
    ocrModule.setHighlightRefresh((file, entries) => ocrHighlightModule.refresh(file, entries));
    const annotationModeModule = new AnnotationModeModule(ctx, pdfModule);
    const calloutPasteModule = new CalloutPasteModule(ctx);
    const tagSyncModule = new TagSyncModule(ctx);
    const jumpModule = new PdfJumpModule(ctx);
    const readingNoteMarkerModule = new ReadingNoteMarkerModule(ctx);
    const wordCountFixModule = new WordCountFixModule(ctx);
    const searchEnhancementModule = new SearchEnhancementModule(ctx);
    const deepseekCtx = {
      ...ctx,
      getCurrentFileForUpload: () => pdfModule.getCurrentFileForUpload()
    };
    this.modules = [
      pdfModule,
      markdownReadingModule,
      annotationModeModule,
      calloutPasteModule,
      quickTagModule,
      tagSyncModule,
      highlightModule,
      screenshotModule,
      screenshotHighlightModule,
      ocrHighlightModule,
      ocrModule,
      jumpModule,
      readingNoteMarkerModule,
      wordCountFixModule,
      searchEnhancementModule,
      new DeepSeekModule(deepseekCtx)
    ];
    for (const mod of this.modules) {
      try {
        mod.load();
      } catch (e) {
        console.error("[LiteratureReader] \u6A21\u5757\u52A0\u8F7D\u5931\u8D25:", e);
      }
    }
    this.addSettingTab(
      new UnifiedSettingTab(
        this.app,
        this,
        ctx.getSettings,
        ctx.saveSettings,
        searchEnhancementModule,
        tagSyncModule,
        wordCountFixModule
      )
    );
  }
  onunload() {
    for (let i = this.modules.length - 1; i >= 0; i--) {
      try {
        this.modules[i].unload();
      } catch (e) {
        console.error("[LiteratureReader] \u6A21\u5757\u5378\u8F7D\u5931\u8D25:", e);
      }
    }
    this.modules = [];
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.applyHighlightStyle();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.applyHighlightStyle();
  }
  /**
   * 把高亮颜色/透明度写入 body 级 CSS 变量，styles.css 中的持久高亮规则引用它们。
   * 颜色转为 "R, G, B" 三元组以便在 rgba() 中复用（文字填充、OCR 边框/填充）。
   */
  applyHighlightStyle() {
    const body = document.body;
    const opacity = Math.min(1, Math.max(0, Number(this.settings.highlightOpacity)));
    if (Number.isFinite(opacity)) {
      body.style.setProperty("--pdf-reader-highlight-opacity", String(opacity));
      body.style.setProperty(
        "--pdf-reader-highlight-border-opacity",
        String(Math.min(1, opacity + 0.2))
      );
    } else {
      body.style.removeProperty("--pdf-reader-highlight-opacity");
      body.style.removeProperty("--pdf-reader-highlight-border-opacity");
    }
    const rgb = hexToRgbTriplet(this.settings.highlightColor);
    if (rgb) {
      body.style.setProperty("--pdf-reader-highlight-rgb", rgb);
    } else {
      body.style.removeProperty("--pdf-reader-highlight-rgb");
    }
  }
};
function hexToRgbTriplet(input) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((input ?? "").trim());
  if (!m)
    return null;
  const n = parseInt(m[1], 16);
  return `${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}`;
}
