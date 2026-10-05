import { Editor, FileView, MarkdownView, Notice, TAbstractFile, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, type FileUploadData, type ModuleContext, type PluginModule, type SavedSelectionInfo } from '../types';
import { buildNoteBaseRegex, renderNoteBaseName, sanitizeLinkAlias } from './noteNaming';
import { loadPdfjsLib } from './pdfjsLoader';

declare function require(name: string): any;
/**
 * 归一化矩形（0-1，相对 PDF 页面内边距框）：截图/OCR 批注的持久高亮区域
 */
type NormRect = { x: number; y: number; w: number; h: number };
/**
 * 矩形高亮刷新条目：页码 + 归一化矩形（由 OcrHighlightModule.refresh 消费）
 */
type RectHighlightEntry = { page: number; rect: NormRect };

/** 相邻文本项 Y 坐标差超过该阈值视为换行 */
const LINE_BREAK_THRESHOLD = 5;
export class PdfReaderModule implements PluginModule {
  private floatingBtn: HTMLElement | null;
  private floatingBadge: HTMLElement | null;
  private trackedRange: Range | null;
  private followTimerId: number | null;
  private savedSelections: SavedSelectionInfo[];
  private currentPdfPath: string | null;
  /** 批注写入后回调（由主入口注入 PdfHighlightModule.refresh） */
  private refreshHighlights: ((file: TFile, selections?: SavedSelectionInfo[]) => void) | null;
  /** 无文本锚点批注写入后的矩形高亮回调（由主入口注入 OcrHighlightModule.refresh） */
  private refreshRectHighlights: ((file: TFile, entries: RectHighlightEntry[]) => void) | null;
  /** 批注是否附带原文的模式提供者（由 AnnotationModeModule 注入） */
  private includeOriginalTextProvider: (() => boolean) | null;
  /** 「开始阅读」进行中的键（PDF 路径，或「PDF路径::笔记路径」），防重复点击并发执行 */
  private startingPdfs: Set<string>;
  private ctx: ModuleContext;
  /**
   * 最近一次获得焦点的笔记路径。
   *
   * 批注落点跟随光标：在 PDF 里选中文字时焦点已经转到 PDF 上，
   * `getActiveViewOfType(MarkdownView)` 返回 null，因此必须记住「我刚才在写的那篇笔记」。
   * 只在活动视图确实可编辑时更新，所以切到 PDF 不会把它冲掉。
   */
  private lastNotePath: string | null;
  /**
   * 最近一次获得焦点的笔记编辑器缓存（含宿主容器）。
   *
   * `getNoteCursorEditorPos` 依赖 `workspace.iterateAllLeaves` 找到笔记视图；
   * 个别时序下（叶子正在重建、或视图尚未登记）会查不到，缓存的编辑器就是兜底，
   * 保证「光标所在的笔记」这一落点语义不丢。`containerEl.isConnected` 用于
   * 判断缓存是否已随视图销毁失效。
   */
  private lastNoteEditor: { editor: Editor; file: TFile; containerEl: HTMLElement } | null;
  /**
   * 不参与批注目标跟踪的笔记过滤器（由 MarkdownReadingModule 注入）。
   * 被标记为“正在阅读的文献”的 Markdown 笔记会在这里返回 true，
   * 防止切回源笔记时把批注落点抢到源笔记自身。
   */
  private annotationTargetExclusionProvider: ((file: TFile) => boolean) | null;
  /**
   * 最近获得焦点的笔记（MRU，最多 10 条）。
   * 当 lastNotePath 被源笔记过滤器排除或已失效时，从这里回退到上一篇符合条件的笔记。
   */
  private recentNoteTargets: { editor: Editor; file: TFile; containerEl: HTMLElement }[];
  /** 「把某篇 md 标记为正在阅读的文献」入口（由 MarkdownReadingModule 注入） */
  private readingSourceProvider: ((path: string) => void) | null;
  constructor(ctx: ModuleContext) {
    this.floatingBtn = null;
    this.floatingBadge = null;
    /** 按钮当前锚定的文字选区 Range（按钮贴着它显示，并跟随其位置变化） */
    this.trackedRange = null;
    /** 选区位置轮询定时器（兜底捕获不触发 scroll/resize 的布局变化，如 pdf.js 缩放、侧栏动画） */
    this.followTimerId = null;
    this.savedSelections = [];
    /** 当前选区所属的 PDF 路径，用于跨文件时重置多选缓存 */
    this.currentPdfPath = null;
    /** 批注写入后回调（由主入口注入 PdfHighlightModule.refresh，用于即时渲染持久高亮） */
    this.refreshHighlights = null;
    /** 无文本锚点批注写入后的矩形高亮回调（由主入口注入 OcrHighlightModule.refresh） */
    this.refreshRectHighlights = null;
    /** 批注是否附带原文的模式提供者（由 AnnotationModeModule 注入；默认关闭=不附带原文） */
    this.includeOriginalTextProvider = null;
    /** 「开始阅读」进行中的键（防重复点击并发执行全量文本提取与重复分屏） */
    this.startingPdfs = /* @__PURE__ */ new Set();
    this.ctx = ctx;
    this.lastNotePath = null;
    this.lastNoteEditor = null;
    this.annotationTargetExclusionProvider = null;
    this.recentNoteTargets = [];
    /** 「把某篇 md 标记为正在阅读的文献」入口（由 MarkdownReadingModule 注入） */
    this.readingSourceProvider = null;
  }
  /** 批注回链 PDF 的链接显示文字（可配置，默认「定位」；写入用户笔记正文） */
  get linkLabel() {
    // 经 sanitizeLinkAlias 清洗：别名会被拼进 [[路径|别名]]，含 | [ ] 或换行会破坏链接。
    // 数据可能来自旧版 data.json（未经设置面板校验），所以这里也过一遍。
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
  setRefreshHighlights(cb: (file: TFile, selections?: SavedSelectionInfo[]) => void): void {
    this.refreshHighlights = cb;
  }
  /** 注入无文本锚点批注的矩形高亮刷新回调 */
  setRefreshRectHighlights(cb: (file: TFile, entries: RectHighlightEntry[]) => void): void {
    this.refreshRectHighlights = cb;
  }
  /** 注入批注原文附带模式提供者（工具栏「附带原文」切换；默认关闭=不附带原文） */
  setIncludeOriginalTextProvider(provider: () => boolean): void {
    this.includeOriginalTextProvider = provider;
  }
  /** 注入“不作为批注目标”的笔记过滤器（由 MarkdownReadingModule 注入）。 */
  setAnnotationTargetExclusionProvider(provider: ((file: TFile) => boolean) | null): void {
    this.annotationTargetExclusionProvider = provider;
  }
  /** 注入「把某篇 md 标记为正在阅读的文献」入口（由 MarkdownReadingModule 注入） */
  setReadingSourceProvider(provider: ((path: string) => void) | null): void {
    this.readingSourceProvider = provider;
  }
  load(): void {
    const plugin = this.ctx.plugin;
    plugin.registerEvent(
      plugin.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
        // file-menu 的第二个参数是 TAbstractFile（理论上也可能是文件夹），
        // 这里判 TFile 再读 extension，避免对文件夹取 extension
        if (!(file instanceof TFile))
          return;
        if (file.extension === "pdf") {
          menu.addItem((item) => {
            item.setTitle("开始阅读").setIcon("book-open").onClick(async () => {
              await this.startReading(file);
            });
          });
          return;
        }
        // 阅读笔记：右键 Markdown 也给出「开始阅读」，打开它关联的 PDF 与这篇笔记并排阅读
        if (file.extension === "md") {
          menu.addItem((item) => {
            item.setTitle("开始阅读").setIcon("book-open").onClick(async () => {
              await this.startReadingForNote(file);
            });
          });
        }
      })
    );
    plugin.addCommand({
      id: "shorten-pdf-annotation-links",
      name: `将当前笔记中的 PDF 批注链接显示文字改为「${this.linkLabel}」`,
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
      // 只响应左键释放：右键/中键的 mouseup 进入 150ms 延迟检测后，
      // 选区可能因右键菜单交互被误判无效而触发清除
      if (evt.button !== 0) return;
      this.handlePdfMouseUp(evt);
    });
    plugin.registerDomEvent(document, "mousedown", (evt) => {
      // 只响应左键按下：勾选文字后按右键（想用 pdf.js 菜单复制）或中键时，
      // mousedown 会立即触发 hideFloatingButton → removeAllRanges 清掉紫色选区，
      // 表现为「刚勾选的文字一右键就消失、右键菜单复制失效」
      if (evt.button !== 0) return;
      if (!this.floatingBtn) return;
      const target = evt.target;
      if (this.floatingBtn.contains(target as Node)) return;
      // 右键菜单（Obsidian Menu）内的点击同样不清选区：mousedown 先于菜单项
      // click 执行，若此刻 removeAllRanges，菜单「复制」等动作拿到的是空选区
      if (target instanceof Element && target.closest(".menu")) return;
      this.hideFloatingButton();
    });
    plugin.registerDomEvent(document, "scroll", () => this.repositionFloatingButton(), { capture: true });
    plugin.registerDomEvent(window, "resize", () => this.repositionFloatingButton());
    // 批注落点跟随光标：记住最近获得焦点的笔记。切到 PDF 时不会更新
    // （PDF 不是 MarkdownView），因此 lastNotePath 停在上一篇笔记
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.trackActiveNote()));
    this.trackActiveNote();
  }
  unload(): void {
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
  async getCurrentFileForUpload(): Promise<FileUploadData | null> {
    const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
    if (!activeLeaf)
      return null;
    const view = activeLeaf.view;
    if (view.getViewType() === "pdf") {
      const pdfFile = (view as FileView).file;
      if (!pdfFile)
        return null;
      try {
        const data = await this.ctx.plugin.app.vault.readBinary(pdfFile);
        return { data, name: pdfFile.name, mimeType: "application/pdf" };
      } catch (e) {
        console.error("[PdfReader] 读取 PDF 二进制失败:", e);
        return null;
      }
    }
    if (view instanceof MarkdownView) {
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
  async shortenPdfAnnotationLinks(file: TFile): Promise<void> {
    const label = this.linkLabel;
    try {
      const content = await this.ctx.plugin.app.vault.read(file);
      // 必须用函数式替换：替换「字符串」里的 $&、$1、$`、$' 会被 String.replace
      // 当成替换模式展开，别名含 $ 时会把匹配到的整段链接再抄一遍、写坏笔记正文。
      // 改用函数后 $ 只作普通字符，输出恒等于 [[路径|别名]]。
      const updated = content.replace(
        /\[\[([^\]|]+?\.pdf#[^\]|]*?)\|[^\]|]*?[,，]\s*页面\s*\d+\]\]/g,
        (_match, target: string) => `[[${target}|${label}]]`
      );
      if (updated === content) {
        new Notice("当前笔记中没有找到可缩短的 PDF 批注链接");
        return;
      }
      await this.ctx.plugin.app.vault.modify(file, updated);
      new Notice(`已将该笔记中的 PDF 批注链接显示文字改为「${label}」`);
    } catch (e) {
      console.error("[PdfReader] 缩短批注链接失败:", e);
      new Notice("缩短批注链接失败");
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
  async startReading(sourceFile: TFile, noteFile?: TFile): Promise<void> {
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
      console.error("[PdfReader] 开始阅读失败:", error);
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
  async startReadingForNote(mdFile: TFile): Promise<void> {
    if (this.isReadingNote(mdFile)) {
      const source = this.resolveNoteSource(mdFile);
      if (!source) {
        new Notice(`「${mdFile.basename}」是一篇阅读笔记，但没找到它对应的文献\n可在 frontmatter 里加 pdf / source 字段重新关联`);
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
  isReadingNote(mdFile: TFile): boolean {
    const folderPath = normalizePath(this.ctx.getSettings().readingNoteFolder);
    if (folderPath && mdFile.path.startsWith(folderPath + "/"))
      return true;
    return buildNoteBaseRegex(this.ctx.getSettings().readingNoteNameTemplate).test(mdFile.basename);
  }
  /** 把某篇 md 标记为「正在阅读的文献」（标记入口由 MarkdownReadingModule 注入） */
  private markReadingSource(file: TFile): void {
    this.readingSourceProvider?.(file.path);
  }
  /**
   * 解析笔记关联的文献（PDF 或 Markdown）：
   *  1. frontmatter 的 `pdf: "[[路径]]"`（PDF 笔记）或 `source: "[[路径]]"`（md 文献笔记）；
   *  2. 无该字段的旧笔记：按命名模板反查同名 PDF（与 ReadingNoteMarkerModule 同一套规则）。
   * 都解析不到返回 null。
   */
  resolveNoteSource(note: TFile): TFile | null {
    const linked = this.extractNoteSourceField(note);
    if (linked) {
      // 依次尝试：整段原文作字面路径（文件名本身含 # 时唯一能命中的方式）、
      // Obsidian 链接解析（相对路径、别名、未带扩展名都能命中）、截掉 #锚点 后的字面路径
      const candidates = [linked, linked.split("#")[0].trim()];
      for (const candidate of candidates) {
        if (!candidate)
          continue;
        const direct = this.ctx.plugin.app.vault.getAbstractFileByPath(normalizePath(candidate));
        if (direct instanceof TFile && (direct.extension === "pdf" || direct.extension === "md"))
          return direct;
        const dest = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(candidate, note.path);
        if (dest instanceof TFile && (dest.extension === "pdf" || dest.extension === "md"))
          return dest;
      }
      // 字段指向的文献已被移动/改名：继续按命名模板兜底，仍找不到由调用方提示
    }
    return this.findPdfByNoteName(note);
  }
  /** 读取 frontmatter 的 pdf / source 字段并取出其中的路径（`"[[路径]]"` 与纯路径都支持） */
  private extractNoteSourceField(note: TFile): string | null {
    const fm = this.ctx.plugin.app.metadataCache.getFileCache(note)?.frontmatter;
    const pick = (value: unknown): string | null => {
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw !== "string")
        return null;
      // 去掉 wikilink 包裹与别名，但保留 #：文件名本身可能含 #（如「6V#4S」），
      // 是否按锚点截断由 resolveNoteSource 的候选顺序决定
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
  private findPdfByNoteName(note: TFile): TFile | null {
    const folderPath = normalizePath(this.ctx.getSettings().readingNoteFolder);
    if (folderPath && !note.path.startsWith(folderPath + "/"))
      return null;
    const m = note.basename.match(buildNoteBaseRegex(this.ctx.getSettings().readingNoteNameTemplate));
    if (!m)
      return null;
    const matches = this.ctx.plugin.app.vault
      .getFiles()
      .filter((f) => f.extension === "pdf" && f.basename === m[1]);
    return matches.length === 1 ? matches[0] : null;
  }
  /** 查找已打开指定文件的叶子，未打开返回 null */
  findLeafByPath(path: string): WorkspaceLeaf | null {
    let result: WorkspaceLeaf | null = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!result && leaf.view instanceof FileView && leaf.view.file?.path === path) {
        result = leaf;
      }
    });
    return result;
  }
  // ========== 阅读笔记创建 ==========
  async createReadingNote(sourceFile: TFile): Promise<TFile | null> {
    const folderPath = this.ctx.getSettings().readingNoteFolder as string;
    const folder = this.ctx.plugin.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFile) {
      new Notice(`阅读笔记文件夹被同名文件占用：${folderPath}`);
      return null;
    }
    if (!folder) {
      try {
        await this.ctx.plugin.app.vault.createFolder(folderPath);
      } catch (e) {
        console.error("[PdfReader] 创建阅读笔记文件夹失败:", e);
        new Notice("创建阅读笔记文件夹失败，请检查设置");
        return null;
      }
    }
    const notePath = await this.resolveNotePath(sourceFile, folderPath);
    if (!notePath) {
      new Notice(`无法创建阅读笔记：${sourceFile.basename} 存在过多同名笔记冲突`);
      return null;
    }
    const noteFile = this.ctx.plugin.app.vault.getAbstractFileByPath(notePath);
    if (noteFile instanceof TFile)
      return noteFile;
    if (noteFile instanceof TFolder)
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
  async resolveNotePath(sourceFile: TFile, folderPath: string): Promise<string | null> {
    const baseName = renderNoteBaseName(sourceFile.basename, this.ctx.getSettings().readingNoteNameTemplate);
    const basePath = normalizePath(`${folderPath}/${baseName}.md`);
    const base = this.ctx.plugin.app.vault.getAbstractFileByPath(basePath);
    if (base instanceof TFile && await this.belongsToSource(base, sourceFile)) {
      return basePath;
    }
    if (!base) {
      return basePath;
    }
    for (let n = 2; n <= 99; n++) {
      const candidate = normalizePath(`${folderPath}/${baseName} (${n}).md`);
      const existing = this.ctx.plugin.app.vault.getAbstractFileByPath(candidate);
      if (existing instanceof TFile && await this.belongsToSource(existing, sourceFile)) {
        return candidate;
      }
      if (!existing) {
        return candidate;
      }
    }
    return null;
  }
  /** 笔记 frontmatter 里记录文献路径的字段名：PDF 用 pdf，其余（md 文献）用 source */
  private sourceFieldName(sourceFile: TFile): string {
    return sourceFile.extension === "pdf" ? "pdf" : "source";
  }
  /** 判断笔记是否属于指定文献（读取 frontmatter 的 pdf / source 字段） */
  async belongsToSource(noteFile: TFile, sourceFile: TFile): Promise<boolean> {
    try {
      const content = await this.ctx.plugin.app.vault.read(noteFile);
      const match = content.match(/^(?:pdf|source):\s*["']?\[\[(.+?)\]\]["']?/m);
      if (!match)
        return true;
      const linked = match[1];
      if (linked === sourceFile.path)
        return true;
      if (!(this.ctx.plugin.app.vault.getAbstractFileByPath(linked) instanceof TFile)) {
        const linkedName = linked.split("/").pop();
        if (linkedName === sourceFile.name) {
          await this.repairSourceField(noteFile, sourceFile);
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn("[PdfReader] 读取笔记 frontmatter 失败，按同一文献处理:", e);
      return true;
    }
  }
  /** 仅替换 frontmatter 中的文献字段（pdf / source）为当前路径，不触碰笔记正文 */
  replaceSourceField(content: string, newPath: string, field = "pdf"): string {
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
  async repairSourceField(noteFile: TFile, sourceFile: TFile): Promise<void> {
    const field = this.sourceFieldName(sourceFile);
    try {
      await this.ctx.plugin.app.vault.process(noteFile, (data) => {
        const fixed = this.replaceSourceField(data, sourceFile.path, field);
        if (fixed !== data) {
          console.log(`[PdfReader] 修复笔记 ${noteFile.path} 的 ${field} 字段 \u2192 ${sourceFile.path}`);
        }
        return fixed;
      });
    } catch (e) {
      console.warn("[PdfReader] 修复文献字段失败:", e);
    }
  }
  async generateNoteContent(sourceFile: TFile): Promise<string> {
    const now = /* @__PURE__ */ new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    let tags: string[] = [];
    // 关键词只对 PDF 提取：md 文献本身就是文本，交给用户自己打标签
    if (sourceFile.extension === "pdf") {
      try {
        const text = await this.extractPdfText(sourceFile);
        console.log(`[PdfReader] 成功提取PDF文本，总长度: ${text.length} 字符`);
        tags = this.extractKeywords(text);
        console.log(`[PdfReader] 关键词提取结果: ${tags.length > 0 ? tags.join(", ") : "未找到关键词"}`);
      } catch (e) {
        console.warn("[PdfReader] 提取PDF关键词失败，将生成不带 tags 的笔记:", e);
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
  async extractPdfText(pdfFile: TFile): Promise<string> {
    const arrayBuffer = await this.ctx.plugin.app.vault.readBinary(pdfFile);
    const appPdfjs = window.pdfjsLib;
    if (appPdfjs?.getDocument) {
      // 宿主 pdf.js 不会把 PDF 视图的 CMap 资源配置带给新的 getDocument；
      // 不显式传入时，使用 CID 字体的中文会被整段漏提取（只剩英文摘要可被关键词逻辑看到）。
      const loadingTask2 = appPdfjs.getDocument({
        data: arrayBuffer,
        cMapUrl: "/lib/pdfjs/cmaps/",
        cMapPacked: true
      });
      return await this.extractTextFromDocument(loadingTask2);
    }
    // 宿主未暴露 pdfjsLib（如仅打开笔记、没有 PDF 视图的会话）：回退用插件自带副本
    const fs = require("fs");
    class PluginCMapReaderFactory {
      baseUrl: string;
      isCompressed: boolean;
      constructor({ baseUrl, isCompressed }: { baseUrl: string; isCompressed: boolean }) {
        this.baseUrl = baseUrl;
        this.isCompressed = isCompressed;
      }
      async fetch({ name }: { name: string }) {
        const url = this.baseUrl + name + (this.isCompressed ? ".bcmap" : "");
        const urlPath = url.startsWith("file:///") ? url.slice(8) : url;
        const data = fs.readFileSync(urlPath);
        return {
          cMapData: new Uint8Array(data),
          isCompressed: this.isCompressed
        };
      }
    }
    // DataAdapter.getBasePath 是桌面端专有方法（Obsidian 类型未公开），仅桌面端使用
    const vaultPath = (this.ctx.plugin.app.vault.adapter as any).getBasePath();
    const pluginDir = (this.ctx.plugin.manifest.dir ?? "pdf-reader").split("/").pop() ?? "pdf-reader";
    const cMapBaseUrl = "file:///" + vaultPath.replace(/\\/g, "/") + "/.obsidian/plugins/" + pluginDir + "/cmaps/";
    const lib = await loadPdfjsLib(this.ctx.plugin);
    const loadingTask = lib.getDocument({
      data: arrayBuffer,
      cMapUrl: cMapBaseUrl,
      cMapPacked: true,
      useWorkerFetch: false,
      isEvalSupported: false,
      CMapReaderFactory: PluginCMapReaderFactory as any
    });
    return await this.extractTextFromDocument(loadingTask);
  }
  /** 从加载任务中分批提取文本（两套 pdfjs 共用）：每批并行、批间串行，限制同时在内存中的页面数 */
  async extractTextFromDocument(loadingTask: { promise: Promise<any> }): Promise<string> {
    const pdf = await loadingTask.promise;
    const parts: (string | null)[] = new Array(pdf.numPages).fill(null);
    const BATCH_SIZE = 32;
    try {
      for (let start = 1; start <= pdf.numPages; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, pdf.numPages);
        const results = await Promise.allSettled(
          Array.from(
            { length: end - start + 1 },
            (_, k) => pdf.getPage(start + k).then((page: any) => page.getTextContent()).then((textContent: any) => this.formatPageText(textContent.items))
          )
        );
        for (let k = 0; k < results.length; k++) {
          const result = results[k];
          if (result.status === "fulfilled") {
            parts[start - 1 + k] = result.value;
          } else {
            console.warn(`[PdfReader] 第 ${start + k} 页文本提取失败，已跳过:`, result.reason);
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
  formatPageText(items: any[]): string {
    let pageText = "";
    for (let j = 0; j < items.length; j++) {
      const item: any = items[j];
      if (j > 0) {
        const prev: any = items[j - 1];
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
  isCJK(ch: string): boolean {
    const cp = ch.codePointAt(0);
    if (!cp)
      return false;
    return cp >= 11904 && cp <= 12031 || cp >= 12288 && cp <= 12351 || cp >= 13312 && cp <= 19903 || cp >= 19968 && cp <= 40959 || cp >= 63744 && cp <= 64255 || cp >= 65280 && cp <= 65519 || cp >= 131072 && cp <= 191471;
  }
  needSpaceBetween(left: string, right: string): boolean {
    if (!left || !right)
      return false;
    if (this.isCJK(left) && this.isCJK(right))
      return false;
    return true;
  }
  // ========== 关键词提取 ==========
  extractKeywords(text: string): string[] {
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const stopMarkers = [
      "中图分类号", "文献标识码", "文章编号", "DOI", "doi", "分类号", "收稿日期", "修回日期", "基金项目",
      "摘要", "Abstract", "abstract", "Keywords", "keywords",
      // 英文期刊关键词经常换行后直接接正文一级标题，需要在标题处截断
      "Introduction", "Materials and methods", "Results", "Discussion", "Conclusions", "References", "Acknowledgements",
      "引言", "材料与方法", "结果", "讨论", "结论", "参考文献", "致谢"
    ];
    const compactedText = text.replace(/\s+/g, "");
    const isCjkChar = (ch: string): boolean =>
      ch.length > 0 && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
    /** 全角转半角，并合并 PDF 逐字排版产生的字母/数字间空格，如“Ｇ Ｗ Ａ Ｓ” → “GWAS” */
    const normalizeKeywordFragment = (s: string): string => {
      let out = s.replace(/[\uFF01-\uFF5E]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
      );
      // 合并逐字排版：G WAS → GWAS、C m b Z I P 5 3 → CmbZIP53、BSR -s e q → BSR-seq
      // 只合并“单个字母/数字”或被短缩写包围的相邻片段，保留 Deep learning 这类正常词组。
      const tokens = out.split(/\s+/);
      const merged: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i];
        while (i + 1 < tokens.length) {
          const next = tokens[i + 1];
          const nextIsSingle = /^[A-Za-z0-9]$/.test(next);
          const tokenEndsAlnum = /[A-Za-z0-9]$/.test(token);
          const acronymPrefix = /^[A-Z]$/.test(token) && /^[A-Z0-9]/.test(next);
          if ((nextIsSingle && tokenEndsAlnum) || acronymPrefix) {
            token += next;
            i++;
            continue;
          }
          break;
        }
        merged.push(token);
      }
      return merged.join(" ")
        .replace(/\s*-\s*/g, "-")
        .replace(/(?<=[A-Za-z0-9])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g, "")
        .replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[A-Za-z0-9])/g, "");
    };
    /** 单行一个英文关键词的格式（如 Elsevier 的 Keywords: 换行列表） */
    const isSingleEnglishKeywordLine = (line: string): boolean => {
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
    /**
     * 判断关键词标签后的下一行是否仍是关键词列表。
     *
     * 仅凭“标签后还有行”直接续读会误伤：中文期刊的关键词行下面常紧跟着
     * “作者 (年份). 题目. 期刊 卷, 页.” 格式的引用行，不是关键词。
     */
    const isKeywordContinuationLine = (line: string): boolean => {
      const t = line.trim();
      if (!t)
        return false;
      // 引用行中的年份
      if (/(?:19|20)\d{2}/.test(t))
        return false;
      // 英文关键词续行常以小写字母开头，且可能以句点收尾（如 Index Terms 换行后的第二行）
      if (/^[a-z]/.test(t))
        return true;
      // 句末标点/英文句点通常意味着已经进入正文或引用行
      if (/[。？！?!]/.test(t) || /\./.test(t))
        return false;
      // 纯中文短片段：是中文关键词被换行截断的特征（如“机器” + “学习”）
      const compactCjk = t.replace(
        /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
        ""
      );
      if (/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(compactCjk))
        return compactCjk.length <= 6;
      // 含关键词分隔符时，要求每个片段都足够短，避免把正文句子当成关键词续行
      if (!/[；;，,、·•‧・]/.test(t))
        return false;
      const parts = t.split(/[；;，,、·•‧・]/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length < 2)
        return false;
      return Math.max(...parts.map((s) => s.length)) <= 15;
    };
    /** 从第一行关键词之后，最多再合并两行真正的关键词续行 */
    const extendKeywordContent = (source: string, match: RegExpMatchArray): string => {
      let content = match[1].trim();
      const singleKeywordMode =
        !/[；;，,、·•‧・]/.test(content) &&
        !/\s/.test(content) &&
        /^[A-Za-z][A-Za-z0-9()\-]*$/.test(content);
      const rest = source.slice((match.index ?? 0) + match[0].length);
      const lines = rest.split("\n");
      const maxLines = singleKeywordMode ? 10 : 2;
      for (let i = 1; i <= maxLines && i < lines.length; i++) {
        const line = lines[i].trim();
        if (singleKeywordMode) {
          if (!isSingleEnglishKeywordLine(line))
            break;
          content += "；" + line;
          continue;
        }
        if (!isKeywordContinuationLine(line))
          break;
        // 下一行若以已解析出的某个关键词开头并继续成句，说明这是正文而不是关键词续行
        const firstSegment = line.split(/[；;，,、·•‧・]/)[0].trim();
        const existingKeywords = content.split(/[；;，,、·•‧・\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
        if (!/^[；;，,、·•‧・]/.test(line) &&
            existingKeywords.some((k) => k.length > 0 && firstSegment.startsWith(k) && firstSegment.length > k.length)) {
          break;
        }
        // 中文关键词被换行截断时直接拼回，避免生成“机器-学习”这种标签
        const prev = content.charAt(content.length - 1);
        const next = line.charAt(0);
        content += isCjkChar(prev) && isCjkChar(next) ? line : "\n" + line;
      }
      return content;
    };
    const tryOnText = (source: string, pattern: RegExp): string => {
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
            // 若停止标记位于后续行，切到该行行首：避免把“1. Introduction”的“1.”残留成关键词
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
    // 有些 PDF 用私有区字符当关键词分隔符；先统一成可识别的分隔符。
    keywordsStr = keywordsStr.replace(/[\uE000-\uF8FF]/g, "；").replace(/\u00A0/g, " ").trim();
    if (!/[；;，,、·•‧・]/.test(keywordsStr) && /[ \t\u3000]{2,}/.test(keywordsStr)) {
      // 没有标点分隔、但存在明显大段空白时：大空白是词间分隔，单个中文间空格是词内排版
      keywordsStr = keywordsStr
        .replace(/[ \t\u3000]{2,}/g, "；")
        .replace(
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
      // 中文 PDF 常把关键词逐字排版成“种 子 耐 淹 性”，标点分隔才可信；此时只去掉中文词内空白。
      rawKeywords = rawKeywords.map((k) =>
        k.replace(
          /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
          ""
        )
      );
    }
    const MAX_TAG_LENGTH = 40;
    const tags = rawKeywords.map((k) => {
      return normalizeKeywordFragment(k)
        .replace(/\s+/g, "-")
        .replace(/[^\w\u4e00-\u9fff-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    }).filter((k) => k.length > 0 && k.length <= MAX_TAG_LENGTH);
    return [...new Set(tags)];
  }

  // ========== 浮动批注按钮 ==========
  initFloatingButton(): void {
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
    label.textContent = "批注到笔记";
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
      // 隐藏按钮的同时清掉原生文字选区（内部先清选区再置 display:none）：
      // 紫色选区高亮必须与按钮同生共死，否则批注完成后会留下看起来“没生效”的残留高亮，
      // 且 handlePdfMouseUp 的 150ms 延迟回调会把选区重新塞回缓存、把按钮重新显示出来
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
  removeFloatingButton(): void {
    this.stopFollowTimer();
    this.trackedRange = null;
    if (this.floatingBtn) {
      this.floatingBtn.remove();
      this.floatingBtn = null;
      this.floatingBadge = null;
    }
  }
  /** 显示浮动按钮并锚定到指定文字选区旁 */
  showFloatingButton(range: Range | null): void {
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
  repositionFloatingButton(): void {
    const btn = this.floatingBtn;
    if (!btn || !this.trackedRange)
      return;
    // 末行锚点（按钮定位用）与整段选区包围盒（可见性判断用）分开取
    const anchor = this.getLastRowRect(this.trackedRange);
    const whole = this.getRangeViewportRect(this.trackedRange);
    // 定位锚点：优先末行，兜底整段；可见性探测：优先整段（部分可见即算可见）
    const rect = anchor ?? whole;
    const probe = whole ?? anchor;
    if (!rect || !probe) {
      // 选区节点已失效（textLayer 因翻页/缩放/页面回收重建）：完整收起并清理
      this.hideFloatingButton();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (probe.bottom <= 0 || probe.top >= vh || probe.right <= 0 || probe.left >= vw) {
      // 整段选区滚出视口：只隐藏按钮、保留原生选区与锚点，滚回视口时自动重现。
      // 不能在此调用 hideFloatingButton——它会 removeAllRanges 主动清掉选区，
      // 用户滚动一下页面再回来，紫色高亮就没了
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
  getSelectionAnchorRect(range: Range): DOMRect | null {
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
  getLastRowRect(range: Range): DOMRect | null {
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
  sameVisualRow(a: DOMRect, b: DOMRect): boolean {
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
  getRangeViewportRect(range: Range): DOMRect | null {
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
  stopFollowTimer(): void {
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
  clearNativeSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    // 只清「落在 PDF 文本层里的选区」——那才是本插件有权清理的紫色高亮。
    // 本方法会被全局 mousedown / mouseup 回调间接调用，若无条件 removeAllRanges()，
    // 会把 Obsidian 自己的选区一并清掉：例如文件管理器新建笔记后自动进入的重命名
    // （标题被全选 + 光标闪烁）会在约 150ms 后突然失去选区与光标，看起来就是
    // 「标题刚被勾选就被取消勾选、光标立刻消失」。
    const node = sel.anchorNode ?? sel.focusNode;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    if (!el?.closest(".textLayer")) return;
    sel.removeAllRanges();
  }
  hideFloatingButton(): void {
    // 仅当确实在收起「由 PDF 选区唤起的批注按钮」时才清选区；
    // 全局 mousedown / mouseup 回调在无关位置调用本方法时，不应改动任何选区状态。
    const wasActive = this.trackedRange !== null || this.floatingBtn?.style.display === "block";
    if (wasActive) this.clearNativeSelection();
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
  handlePdfMouseUp(evt: MouseEvent): void {
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
      const pdfFile = (activeLeaf.view as FileView).file;
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
  getPdfSelectionInfo(): Omit<SavedSelectionInfo, "text"> | null {
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
      // 起止元素命名区分「选区起点/终点所在的页」，后续取文本层与页码都以它们为准
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
      console.error("[PdfReader] 获取PDF选择信息失败:", e);
      return null;
    }
  }
  /**
   * 计算无 data-idx 文本选区的归一化矩形（0-1，相对页面内边距框）。
   * 用于标题/图表标注等文本层锚点缺失时的矩形持久高亮。
   */
  computeSelectionOcrRect(range: Range, pageDiv: HTMLElement): NormRect | null {
    try {
      const rect = range.getBoundingClientRect();
      const pageRect = pageDiv.getBoundingClientRect();
      const ox = pageRect.left + pageDiv.clientLeft;
      const oy = pageRect.top + pageDiv.clientTop;
      const pw = pageDiv.clientWidth;
      const ph = pageDiv.clientHeight;
      if (!pw || !ph || !rect.width || !rect.height)
        return null;
      const clamp012 = (n: number): number => Math.min(1, Math.max(0, n));
      return {
        x: clamp012((rect.left - ox) / pw),
        y: clamp012((rect.top - oy) / ph),
        w: clamp012(rect.width / pw),
        h: clamp012(rect.height / ph)
      };
    } catch (e) {
      console.warn("[PdfReader] 计算选区回退矩形失败:", e);
      return null;
    }
  }
  /** 向上查找承载页码的页面容器（pdf.js 的 .page[data-page-number]） */
  findPageDiv(node: Node | null): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== document) {
      const el = current as HTMLElement;
      if (el.dataset?.pageNumber !== void 0) {
        return el;
      }
      current = current.parentNode;
    }
    return null;
  }
  /** 向上查找选区端点所在的带 data-idx 的文本 span（文本锚点的最小单位） */
  findParentTextSpan(node: Node, textLayer: Element): HTMLElement | null {
    let current = node instanceof HTMLElement ? node : node.parentElement;
    while (current && current !== textLayer) {
      if (current.tagName === "SPAN" && current.hasAttribute("data-idx")) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  computeOffsetInSpan(span: HTMLElement, container: Node, offset: number): number {
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
  async annotateOcrText(pdfFile: TFile, text: string, page: number, ocrRect?: NormRect): Promise<boolean> {
    const target = this.getCursorNotePos();
    if (!target) {
      new Notice("OCR 批注写入失败：请先把光标放到要批注的笔记里");
      return false;
    }
    const selections: SavedSelectionInfo[] = [{
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
      console.error("[PdfReader] OCR 批注写入失败:", e);
      new Notice("OCR 批注写入失败");
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
  async annotateScreenshot(pdfFile: TFile, page: number, rect: number[]): Promise<boolean> {
    const target = this.getCursorNotePos();
    if (!target) {
      new Notice("截图批注失败：请先把光标放到要批注的笔记里");
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
        // 写入后焦点移到被批注的笔记（与附带原文分支的 focusNotePrompt 对齐）
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
      // 落点已在入口校验（必定有编辑器），不再保留「写文件末尾」的静默回退
      target.editor.replaceRange(annotation, { line: target.line, ch: target.ch });
      const promptLine = target.line + annotation.split("\n").length - 2;
      await this.focusNotePrompt(noteFile, prompt, promptLine);
      return true;
    } catch (e) {
      console.error("[PdfReader] 截图批注写入失败:", e);
      new Notice("截图批注写入失败");
      return false;
    }
  }
  async handleAnnotation(): Promise<void> {
    if (this.savedSelections.length === 0)
      return;
    const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
    if (!activeLeaf || activeLeaf.view.getViewType() !== "pdf")
      return;
    const pdfFile = (activeLeaf.view as FileView).file;
    if (!pdfFile)
      return;
    const selections = [...this.savedSelections];
    this.savedSelections = [];
    // 落点 = 光标所在笔记；没打开笔记就无法批注：恢复选区并明确提示，绝不静默改写到别处
    const target = this.getCursorNotePos();
    if (!target) {
      this.savedSelections = selections;
      new Notice("批注失败：请先把光标放到要批注的笔记里（右键 PDF →「开始阅读」可打开对应笔记）");
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
      console.error("[PdfReader] 批注写入失败，选区已恢复:", e);
    }
  }
  /** 当前文字批注是否附带原文（工具栏「附带原文」关闭时不附带，只写链接） */
  shouldIncludeOriginalText(): boolean {
    if (this.includeOriginalTextProvider != null)
      return this.includeOriginalTextProvider();
    return this.ctx.getSettings().annotationIncludeOriginalText === true;
  }
  async appendAnnotationsToNote(noteFile: TFile, selections: SavedSelectionInfo[], pdfFile: TFile, includeOriginalText = true): Promise<void> {
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
      console.warn("[PdfReader] 部分选区定位失败，批注未附原文链接");
    }
    const block = `> [!pdf-annotation]
${items.join("\n> \n")}
${notePrompt}`;
    const annotation = "\n" + block + "\n";
    // 落点已在入口校验（必定有编辑器）
    const cursorPos = this.getNoteCursorEditorPos(noteFile);
    if (!cursorPos)
      throw new Error("批注目标笔记没有可用的编辑器");
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
  async appendLinksOnly(noteFile: TFile, selections: SavedSelectionInfo[], pdfFile: TFile, ocrTextOnly = false): Promise<void> {
    const flatten = (text: string): string => text.replace(
      /[\r\n\u000B\u000C\u2028\u2029\u21B5\u23CE\u240D\u2424\u2937\u0000-\u0008\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g,
      ""
    );
    const lines = selections.map((sel) => {
      if (sel.page === null) {
        return flatten(sel.text);
      }
      if (sel.beginIndex < 0) {
        if (ocrTextOnly) return flatten(sel.text);
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
      throw new Error("批注目标笔记没有可用的编辑器");
    const editor = cursorPos.editor;
    const startLine = cursorPos.line;
    const startCh = cursorPos.ch;
    const content = lines.join(" ");
    if (ocrTextOnly) {
      // OCR 仅文字模式：作为独立段落插入，光标停到段落之后
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
    // 写入后焦点移到被批注的笔记：用户可直接继续输入
    this.focusNoteLeaf(noteFile);
  }
  /** 找到承载指定笔记的 Markdown 叶子（与当前焦点无关：笔记在后台标签页时也能找到） */
  private findNoteLeaf(noteFile: TFile): WorkspaceLeaf | null {
    let targetLeaf: WorkspaceLeaf | null = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === noteFile.path) {
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
  private activateNoteLeaf(noteFile: TFile): WorkspaceLeaf | null {
    const leaf = this.findNoteLeaf(noteFile);
    if (!leaf)
      return null;
    try {
      this.ctx.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
      return leaf;
    } catch (e) {
      console.warn("[PdfReader] 激活批注目标笔记失败:", e);
      return null;
    }
  }
  /**
   * 批注写入后把焦点移到被批注的笔记，让用户直接继续输入（关附带原文时只写链接，光标已停在链接后）。
   * 只激活已打开的叶子，不新建分屏：批注经编辑器缓冲写入，该笔记的叶子必定已存在。
   * @returns 是否成功聚焦
   */
  focusNoteLeaf(noteFile: TFile): boolean {
    const leaf = this.activateNoteLeaf(noteFile);
    if (!leaf)
      return false;
    const view = leaf.view;
    if (view instanceof MarkdownView)
      this.focusNoteEditor(view);
    return true;
  }
  /** 把键盘焦点交给笔记编辑器；绝不抛出（阅读模式无编辑器、视图未就绪时静默跳过） */
  private focusNoteEditor(view: MarkdownView): void {
    try {
      view.editor?.focus?.();
    } catch (e) {
      console.warn("[PdfReader] 聚焦批注目标笔记编辑器失败:", e);
    }
  }
  /**
   * 聚焦笔记中刚写入批注的提示行（如「> 笔记：」）。
   * @param exactLine 提示行的精确行号（replaceRange 后缓冲已同步）。
   * 批注必定经编辑器缓冲写入（落点已在入口校验），已无「写文件末尾」的追加路径。
   * 精确行定位避免了旧实现的缺陷：从文末向上找「最后一个」提示行，
   * 当批注插入在文件中部时会把光标带到文档末尾的旧批注上，导致后续输入写错位置。
   */
  async focusNotePrompt(noteFile: TFile, prompt: string, exactLine: number | null = null): Promise<void> {
    const leaf = this.activateNoteLeaf(noteFile);
    if (!leaf)
      return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView))
      return;
    const editor = view.editor;
    if (!editor)
      return;
    // 与 focusNoteLeaf 对齐：附带原文分支同样把键盘焦点交给编辑器（光标随后定位到提示行）
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
  private trackActiveNote(): void {
    const view = this.ctx.plugin.app.workspace.getActiveViewOfType(MarkdownView);
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
  private isAnnotationTargetExcluded(file: TFile): boolean {
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
  getCursorNotePos(): { noteFile: TFile; editor: Editor; line: number; ch: number } | null {
    const primaryPath = this.lastNotePath;
    const primaryFile = primaryPath
      ? this.ctx.plugin.app.vault.getAbstractFileByPath(primaryPath)
      : null;
    if (primaryFile instanceof TFile && this.isAnnotationTargetExcluded(primaryFile) === false) {
      const pos = this.getCursorPosForTarget(primaryFile);
      return pos ? { noteFile: primaryFile, ...pos } : null;
    }
    for (const entry of this.recentNoteTargets) {
      if (this.isAnnotationTargetExcluded(entry.file))
        continue;
      const file = this.ctx.plugin.app.vault.getAbstractFileByPath(entry.file.path);
      if (file instanceof TFile) {
        const pos = this.getCursorPosForTarget(file, entry);
        if (pos)
          return { noteFile: file, ...pos };
      }
    }
    return null;
  }

  private getCursorPosForTarget(
    file: TFile,
    cachedEntry?: { editor: Editor; file: TFile; containerEl: HTMLElement } | null
  ): { editor: Editor; line: number; ch: number } | null {
    const pos = this.getNoteCursorEditorPos(file);
    if (pos)
      return pos;
    const fallback = cachedEntry
      ?? this.recentNoteTargets.find((item) => item.file.path === file.path)
      ?? (this.lastNoteEditor?.file.path === file.path ? this.lastNoteEditor : null);
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
  getNoteCursorEditorPos(noteFile: TFile): { editor: Editor; line: number; ch: number } | null {
    let result: { editor: Editor; line: number; ch: number } | null = null;
    this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (result !== null)
        return;
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === noteFile.path) {
        const editor = leaf.view.editor;
        if (!editor)
          return;
        const cursor = editor.getCursor();
        result = { editor, line: cursor.line, ch: cursor.ch };
      }
    });
    return result;
  }
}
function fmtRectNum(n: number): string {
  return Number(n.toFixed(4)).toString();
}
