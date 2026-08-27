import { TFile, WorkspaceLeaf, FileView, MarkdownView, Menu, Notice, Editor } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';

/**
 * 笔记 ↔ PDF 双向跳转模块
 *
 * 职责：
 *  - 点击 PDF 中的持久高亮（文本选区高亮 / OCR 区域高亮）→ 跳到笔记中对应批注的位置
 *  - 点击笔记中指向 PDF 的链接（`#page=N&selection=…` / `#page=N&ocr=…`）→ 跳到 PDF 对应位置
 *  - 目标文件未打开时：
 *      · 笔记 → PDF：在「笔记所在叶子」的左侧分屏打开 PDF（而非在焦点所在叶子直接打开）
 *      · PDF 高亮 → 笔记：在「PDF 所在叶子」的右侧分屏打开笔记（与阅读布局镜像）
 *
 * 实现要点：
 *  - 高亮跳转依赖「链接出现位置索引」：扫描笔记原文中指向各 PDF 的批注链接，
 *    记录页码、锚点 key（selection 选区 / ocr 矩形）以及链接所在行/列，随笔记增删改防抖重建。
 *  - 笔记链接点击在 document 捕获阶段拦截（Obsidian 自带的链接处理器检查
 *    `defaultPrevented` 且挂载在目标/内容节点上，捕获阶段 preventDefault + stopPropagation
 *    可完全接管）；仅拦截目标为 PDF 的链接，其余链接行为不受影响。
 *  - PDF 打开与页码跳转复用 Obsidian 原生能力：`leaf.openFile(file, { eState: { subpath } })`
 *    会触发内置 PDF 视图 applySubpath（page + selection 原生高亮）；本模块再轮询
 *    持久高亮层（带 data-pdf-jump-* 属性）滚动到具体位置并闪烁提示。
 */

/** 批注链接在笔记中的一次出现（跳转目标） */
interface NoteOccurrence {
    notePath: string;
    /** 链接所在行（0 起） */
    line: number;
    /** 链接起点列（0 起） */
    ch: number;
    /** 笔记原文中的链接目标（path#page=…），用于阅读模式定位渲染出的锚点 */
    linktext: string;
}

/** page → 锚点 key → 出现位置列表（key: s:bi,bo,ei,eo 或 o:x,y,w,h） */
type PageJumpIndex = Map<string, NoteOccurrence[]>;
/** pdfPath → page → … */
type PdfJumpIndex = Map<number, PageJumpIndex>;

/** 链接片段解析结果 */
interface ParsedFragment {
    page: number;
    /** 锚点 key（s:… 选区 / o:… OCR 矩形），null = 仅页码 */
    key: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PdfJumpModule implements PluginModule {
    private ctx: ModuleContext;
    /** pdfPath → 跳转索引 */
    private indexCache = new Map<string, PdfJumpIndex>();
    /** 索引重建防抖定时器 */
    private rebuildTimer: number | null = null;
    /** 防抖窗口内待重建的 PDF：'full' = 全量，string[] = 局部路径集，null = 无待办 */
    private pendingRebuild: 'full' | string[] | null = null;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const app = this.ctx.plugin.app;

        // ---------- 跳转索引维护（与高亮模块同源：笔记驱动 + 防抖重建） ----------

        // PDF 打开 → 精确重建该 PDF 的索引，保证首次打开即可跳转
        this.ctx.plugin.registerEvent(
            app.workspace.on('file-open', (file: TFile | null) => {
                if (file && file.extension === 'pdf') {
                    this.scheduleRebuildForPdfs([file.path]);
                }
            })
        );
        // 笔记修改（批注写入/删除）→ 防抖重建受影响的 PDF
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('changed', (file: TFile) => {
                const links = app.metadataCache.resolvedLinks[file.path];
                if (!links) return;
                const affected = Object.keys(links).filter((t) => t.endsWith('.pdf'));
                if (affected.length > 0) {
                    this.scheduleRebuildForPdfs(affected);
                }
            })
        );
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('deleted', () => this.scheduleRebuild())
        );
        this.ctx.plugin.registerEvent(
            app.vault.on('rename', () => this.scheduleRebuild())
        );

        // ---------- 点击拦截 ----------

        // 1) 笔记中的 PDF 链接 → 跳 PDF（捕获阶段，先于 Obsidian 链接处理器）
        this.ctx.plugin.registerDomEvent(document, 'click', this.handleNoteLinkClick, true);

        // 2) PDF 高亮区域 → 跳笔记（冒泡阶段委托，高亮矩形带 data-pdf-jump-* 属性）
        this.ctx.plugin.registerDomEvent(document, 'click', this.handleHighlightClick);

        // 插件加载时对已打开 PDF 建立索引
        this.scheduleRebuild();
    }

    unload(): void {
        this.indexCache.clear();
        this.pendingRebuild = null;
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
    }

    // ========== 索引维护 ==========

    /** 全部重建（删除/重命名等路径级变更） */
    private scheduleRebuild(): void {
        this.scheduleTimer('full');
    }

    /** 精确重建指定 PDF（笔记编辑的常规路径），防抖合并 */
    private scheduleRebuildForPdfs(pdfPaths: string[]): void {
        if (pdfPaths.length === 0) return;
        this.scheduleTimer(pdfPaths);
    }

    private scheduleTimer(request: 'full' | string[]): void {
        if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
        if (request === 'full' || this.pendingRebuild === 'full') {
            this.pendingRebuild = 'full';
        } else if (this.pendingRebuild === null) {
            this.pendingRebuild = request;
        } else {
            this.pendingRebuild = [...new Set([...this.pendingRebuild, ...request])];
        }
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            const pending = this.pendingRebuild;
            this.pendingRebuild = null;
            if (pending === 'full' || !pending) {
                this.rebuildAllIndexes();
            } else {
                this.rebuildIndexes(pending);
            }
        }, 300);
    }

    private async rebuildAllIndexes(): Promise<void> {
        const paths = new Set<string>();
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === 'pdf') {
                const file = (leaf.view as FileView).file;
                if (file) paths.add(file.path);
            }
        });
        for (const path of paths) {
            await this.rebuildIndex(path);
        }
        // 清理已删除/不再打开 PDF 的缓存
        for (const path of [...this.indexCache.keys()]) {
            if (!paths.has(path) && !this.ctx.plugin.app.vault.getAbstractFileByPath(path)) {
                this.indexCache.delete(path);
            }
        }
    }

    private async rebuildIndexes(pdfPaths: string[]): Promise<void> {
        for (const path of pdfPaths) {
            await this.rebuildIndex(path);
        }
    }

    /**
     * 重建单个 PDF 的跳转索引。
     * metadataCache 不记录指向 PDF 的正文链接，因此通过 resolvedLinks 反查
     * 链接到该 PDF 的笔记，再读取笔记原文提取带页码/锚点的链接并记录行号。
     */
    private async rebuildIndex(pdfPath: string): Promise<void> {
        const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
        if (!(pdfFile instanceof TFile)) return;

        const newIndex: PdfJumpIndex = new Map();
        const app = this.ctx.plugin.app;

        for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
            if (!links[pdfPath]) continue;
            const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;
            try {
                // 优先取打开的编辑器缓冲（批注写入后可能尚未落盘）
                const content = await this.readNoteContent(sourceFile);
                this.extractOccurrences(content, pdfFile, sourcePath, newIndex);
            } catch (e) {
                console.warn('[PdfJump] 读取笔记失败:', sourcePath, e);
            }
        }

        this.indexCache.set(pdfPath, newIndex);
    }

    /** 从笔记原文提取指向指定 PDF 的批注链接并写入索引 */
    private extractOccurrences(
        content: string, pdfFile: TFile, sourcePath: string, index: PdfJumpIndex
    ): void {
        const app = this.ctx.plugin.app;

        // 文本选区链接：[[path#page=N&selection=bi,bo,ei,eo]]
        const selRegex = /\[\[([^\]#|]+?)#page=(\d+)&selection=([\d,\s-]+)/g;
        // OCR 矩形链接：[[path#page=N&ocr=x,y,w,h|alias]]（含别名结尾）
        const ocrRegex = /\[\[([^\]#|]+?)#page=(\d+)&ocr=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
        // 截图批注嵌入链接：[[path#page=N&rect=x1,y1,x2,y2]]（含 ![[...]] 嵌入形式）
        const rectRegex = /\[\[([^\]#|]+?)#page=(\d+)&rect=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;

        this.scanMatches(content, selRegex, pdfFile, sourcePath, index, (m) => {
            const sel = this.normalizeSelectionKey(m[3]);
            if (!sel) return null;
            const linktext = `${m[1].trim()}#page=${m[2]}&selection=${sel}`;
            return { page: parseInt(m[2], 10), key: `s:${sel}`, linktext };
        });
        this.scanMatches(content, ocrRegex, pdfFile, sourcePath, index, (m) => {
            const ocr = this.normalizeOcrKey(m[3]);
            if (!ocr) return null;
            const linktext = `${m[1].trim()}#page=${m[2]}&ocr=${ocr}`;
            return { page: parseInt(m[2], 10), key: `o:${ocr}`, linktext };
        });
        this.scanMatches(content, rectRegex, pdfFile, sourcePath, index, (m) => {
            const rect = this.normalizeRectKey(m[3]);
            if (!rect) return null;
            const linktext = `${m[1].trim()}#page=${m[2]}&rect=${rect}`;
            return { page: parseInt(m[2], 10), key: `r:${rect}`, linktext };
        });
    }

    /** 通用扫描：解析链接、校验目标 PDF、计算行/列并写入索引 */
    private scanMatches(
        content: string,
        regex: RegExp,
        pdfFile: TFile,
        sourcePath: string,
        index: PdfJumpIndex,
        makeEntry: (m: RegExpExecArray) => { page: number; key: string; linktext: string } | null
    ): void {
        const app = this.ctx.plugin.app;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const linkpath = m[1].trim();
            const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
            if (target !== pdfFile) continue;

            const entry = makeEntry(m);
            if (!entry || !Number.isInteger(entry.page)) continue;

            const line = content.slice(0, m.index).split('\n').length - 1;
            const lineStart = content.lastIndexOf('\n', m.index - 1) + 1;
            const ch = m.index - lineStart;

            const pageIndex = index.get(entry.page) ?? new Map<string, NoteOccurrence[]>();
            const list = pageIndex.get(entry.key) ?? [];
            list.push({ notePath: sourcePath, line, ch, linktext: entry.linktext });
            pageIndex.set(entry.key, list);
            index.set(entry.page, pageIndex);
        }
    }

    /** 读取笔记内容：优先打开中的编辑器缓冲（仅编辑模式，缓冲与磁盘一致），其次磁盘 */
    private async readNoteContent(sourceFile: TFile): Promise<string> {
        const app = this.ctx.plugin.app;
        let editorContent: string | null = null;
        app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
            if (editorContent !== null) return;
            const view = leaf.view as MarkdownView;
            // 阅读模式下编辑器缓冲可能为空/过期，回退磁盘读取
            if (view.file?.path === sourceFile.path && view.getMode() === 'source' && view.editor) {
                editorContent = view.editor.getValue();
            }
        });
        if (editorContent !== null) return editorContent;
        return await app.vault.read(sourceFile);
    }

    // ========== 笔记链接 → PDF ==========

    /**
     * 笔记链接点击拦截（document 捕获阶段）：
     *  - 阅读模式/渲染视图：`a.internal-link` 的 data-href 含完整链接目标（path#subpath）
     *  - Live Preview：经编辑器内部 token API 取点击位置的链接文本
     * 仅接管目标为 PDF 的链接；Mod/右键等交还 Obsidian 默认行为。
     */
    private handleNoteLinkClick = (evt: MouseEvent): void => {
        if (evt.button !== 0) return;
        if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
        const target = evt.target as HTMLElement | null;
        if (!target || !(target instanceof Element)) return;

        let linktext: string | null = null;
        let sourcePath = '';

        // 阅读模式（及所有渲染出的 internal-link 锚点）
        const anchor = target.closest<HTMLElement>('a.internal-link');
        if (anchor) {
            linktext = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
            const leaf = this.findLeafContaining(anchor);
            sourcePath = leaf?.view instanceof MarkdownView
                ? (leaf.view.file?.path ?? '')
                : (this.ctx.plugin.app.workspace.getActiveFile()?.path ?? '');
        } else {
            // Live Preview：点击位置在内部链接渲染范围内（cm-hmd-internal-link 包裹整个
            // [[path#subpath|alias]]，含可见别名），再经编辑器 token API 取完整链接文本
            const inEditorLink = target.closest('.cm-hmd-internal-link, .cm-link');
            if (!inEditorLink) return;
            const leaf = this.findLeafContaining(target);
            if (!leaf || !(leaf.view instanceof MarkdownView)) return;
            // Source 视图（编辑模式下关闭实时预览）：普通点击不导航，维持 Obsidian 原行为
            const editMode = (leaf.view as any).editMode;
            if (editMode?.sourceMode) return;
            const editor = (leaf.view as any).editor;
            if (!editor || typeof editor.getClickableTokenAt !== 'function') return;
            try {
                const pos = editor.posAtMouse(evt);
                const token = pos != null ? editor.getClickableTokenAt(pos) : null;
                if (!token || token.type !== 'internal-link') return;
                linktext = token.text;
                sourcePath = leaf.view.file?.path ?? '';
            } catch (e) {
                console.warn('[PdfJump] 读取编辑器链接 token 失败:', e);
                return;
            }
        }

        if (!linktext) return;

        const hashIdx = linktext.indexOf('#');
        const pathPart = (hashIdx >= 0 ? linktext.slice(0, hashIdx) : linktext).trim();
        const fragment = hashIdx >= 0 ? linktext.slice(hashIdx) : '';
        const pdfFile = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(pathPart, sourcePath);
        if (!(pdfFile instanceof TFile) || pdfFile.extension !== 'pdf') return;

        // 完全接管本次点击，阻止 Obsidian 默认的「在焦点叶子打开」
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        const sourceLeaf = this.findLeafContaining(target) ?? this.ctx.plugin.app.workspace.activeLeaf;
        this.jumpToPdf(pdfFile, fragment, sourceLeaf);
    };

    /**
     * 跳转到 PDF 的指定位置：
     *  - PDF 已打开 → 聚焦现有叶子并应用 subpath（原生页码/选区高亮）
     *  - 未打开 → 在来源叶子（笔记）的左侧分屏打开
     *  - 打开后轮询持久高亮层，滚动到具体锚点并闪烁提示
     */
    private async jumpToPdf(
        pdfFile: TFile, fragment: string, sourceLeaf: WorkspaceLeaf | null
    ): Promise<void> {
        const app = this.ctx.plugin.app;

        const existingLeaf = this.findLeafByPath(pdfFile.path);
        let leaf: WorkspaceLeaf;
        if (existingLeaf) {
            leaf = existingLeaf;
        } else if (sourceLeaf) {
            // 在笔记左侧分屏打开（before=true → 左）
            leaf = app.workspace.createLeafBySplit(sourceLeaf, 'vertical', true);
        } else {
            leaf = app.workspace.getLeaf(false);
        }

        app.workspace.setActiveLeaf(leaf, { focus: true });
        // subpath 经 eState 传入：触发内置 PDF 视图 applySubpath（page + selection 原生高亮）
        await leaf.openFile(pdfFile, { eState: { subpath: fragment }, active: true });

        const parsed = this.parseFragment(fragment);
        if (parsed) {
            this.scrollToPdfAnchor(leaf, parsed);
        }
    }

    /** 解析 #page=N&selection=… / #page=N&ocr=… / #page=N&rect=… 片段 */
    private parseFragment(fragment: string): ParsedFragment | null {
        const m = fragment.match(/^#page=(\d+)(?:&(selection|ocr|rect)=([\d.,\s-]+))?/);
        if (!m) return null;
        const page = parseInt(m[1], 10);
        if (!Number.isInteger(page)) return null;
        let key: string | null = null;
        if (m[2] === 'selection') {
            const sel = this.normalizeSelectionKey(m[3] ?? '');
            if (!sel) return null;
            key = `s:${sel}`;
        } else if (m[2] === 'ocr') {
            const ocr = this.normalizeOcrKey(m[3] ?? '');
            if (!ocr) return null;
            key = `o:${ocr}`;
        } else if (m[2] === 'rect') {
            const rect = this.normalizeRectKey(m[3] ?? '');
            if (!rect) return null;
            key = `r:${rect}`;
        }
        return { page, key };
    }

    /**
     * 等待目标页面的持久高亮渲染后滚动到锚点并闪烁提示。
     * 轮询 8 秒：PDF 首次打开时索引/高亮层需要时间构建。
     */
    private async scrollToPdfAnchor(leaf: WorkspaceLeaf, parsed: ParsedFragment): Promise<void> {
        if (!parsed.key) return; // 仅页码：Obsidian 原生已滚动到页
        const selAttr = parsed.key.startsWith('s:') ? parsed.key.slice(2) : null;
        const ocrAttr = parsed.key.startsWith('o:') ? parsed.key.slice(2) : null;
        const rectAttr = parsed.key.startsWith('r:') ? parsed.key.slice(2) : null;

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            if (leaf.view.getViewType() !== 'pdf') return; // 叶子已被复用/关闭
            const pageEl = leaf.view.containerEl.querySelector<HTMLElement>(
                `[data-page-number="${parsed.page}"]`
            );
            const targetEl = pageEl?.querySelector<HTMLElement>(
                selAttr
                    ? `[data-pdf-jump-selection="${selAttr}"]`
                    : ocrAttr
                        ? `[data-pdf-jump-ocr="${ocrAttr}"]`
                        : rectAttr
                            ? `[data-pdf-jump-rect="${rectAttr}"]`
                            : ''
            ) ?? null;
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                this.flashElement(targetEl);
                return;
            }
            await sleep(120);
        }
    }

    // ========== PDF 高亮 → 笔记 ==========

    /**
     * PDF 高亮点击（document 冒泡阶段委托）：
     * 高亮矩形（文本选区 / OCR 区域）带 data-pdf-jump-page 与
     * data-pdf-jump-selection / data-pdf-jump-ocr 属性，点击后经索引
     * 找到笔记中的批注位置并跳转；多个笔记命中时弹出菜单选择。
     */
    private handleHighlightClick = (evt: MouseEvent): void => {
        if (evt.button !== 0) return;
        if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
        const target = evt.target as HTMLElement | null;
        if (!target || !(target instanceof Element)) return;

        const jumpEl = target.closest<HTMLElement>('[data-pdf-jump-page]');
        if (!jumpEl) return;

        const leaf = this.findLeafContaining(jumpEl);
        if (!leaf || leaf.view.getViewType() !== 'pdf') return;
        const pdfFile = (leaf.view as FileView).file;
        if (!pdfFile) return;

        const page = parseInt(jumpEl.getAttribute('data-pdf-jump-page') || '', 10);
        const sel = jumpEl.getAttribute('data-pdf-jump-selection');
        const ocr = jumpEl.getAttribute('data-pdf-jump-ocr');
        const rect = jumpEl.getAttribute('data-pdf-jump-rect');
        const key = sel
            ? `s:${sel}`
            : ocr
                ? `o:${this.normalizeOcrKey(ocr)}`
                : rect
                    ? `r:${this.normalizeRectKey(rect)}`
                    : null;
        if (!Number.isInteger(page) || !key) return;

        const occurrences = this.indexCache.get(pdfFile.path)?.get(page)?.get(key);
        if (!occurrences || occurrences.length === 0) {
            new Notice('未在笔记中找到对应的批注链接');
            return;
        }

        // 按笔记去重（同一笔记内多次出现取第一处）
        const byNote = new Map<string, NoteOccurrence>();
        for (const occ of occurrences) {
            if (!byNote.has(occ.notePath)) byNote.set(occ.notePath, occ);
        }
        const notes = [...byNote.values()];

        if (notes.length === 1) {
            this.jumpToNoteOccurrence(pdfFile, leaf, notes[0]);
        } else {
            const menu = new Menu();
            for (const occ of notes) {
                const noteFile = this.ctx.plugin.app.vault.getAbstractFileByPath(occ.notePath);
                menu.addItem((item) =>
                    item
                        .setTitle(noteFile instanceof TFile ? noteFile.basename : occ.notePath)
                        .onClick(() => this.jumpToNoteOccurrence(pdfFile, leaf, occ))
                );
            }
            menu.showAtMouseEvent(evt);
        }
    };

    /** 跳转到笔记中的批注位置：未打开时在 PDF 叶子右侧分屏打开 */
    private async jumpToNoteOccurrence(
        pdfFile: TFile, pdfLeaf: WorkspaceLeaf, occ: NoteOccurrence
    ): Promise<void> {
        const app = this.ctx.plugin.app;
        const noteFile = app.vault.getAbstractFileByPath(occ.notePath);
        if (!(noteFile instanceof TFile)) return;

        let noteLeaf = this.findLeafByPath(occ.notePath);
        if (!noteLeaf) {
            // 笔记未打开：在 PDF 右侧分屏打开（before=false → 右）
            noteLeaf = app.workspace.createLeafBySplit(pdfLeaf, 'vertical', false);
            await noteLeaf.openFile(noteFile);
        }
        app.workspace.setActiveLeaf(noteLeaf, { focus: true });
        await this.scrollNoteToOccurrence(noteLeaf, occ);
    }

    /** 滚动笔记到批注行：编辑模式经编辑器，阅读模式定位渲染出的链接锚点 */
    private async scrollNoteToOccurrence(noteLeaf: WorkspaceLeaf, occ: NoteOccurrence): Promise<void> {
        const view = noteLeaf.view;
        if (!(view instanceof MarkdownView)) return;

        const editor = view.getMode() === 'source' ? view.editor : null;
        if (editor) {
            // 等待编辑器就绪（刚打开时行数可能尚未同步）
            for (let i = 0; i < 30 && editor.lastLine() < occ.line; i++) {
                await sleep(100);
            }
            if (editor.lastLine() >= occ.line) {
                // 不要把光标放进链接内部：Live Preview 会把短链接「定位」展开为完整 wikilink。
                // 这里只滚动到目标链接所在位置，并给该行/链接加临时高亮作为位置提醒。
                const lineText = editor.getLine(occ.line);
                const targetCh = Math.min(occ.ch, lineText.length);
                editor.scrollIntoView(
                    {
                        from: { line: occ.line, ch: targetCh },
                        to: { line: occ.line, ch: Math.min(targetCh + 1, lineText.length) },
                    },
                    true
                );
                this.flashNoteInEditor(editor, occ);
            }
            return;
        }

        // 阅读模式：等待渲染后定位链接锚点（链接在 callout 内，滚动整个 callout）
        const container = (view as any).previewMode?.containerEl ?? view.contentEl;
        for (let i = 0; i < 30; i++) {
            const el = this.findRenderedNoteLink(container, occ);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                this.flashElement(el.closest('.callout') ?? el);
                return;
            }
            await sleep(100);
        }
    }

    /**
     * 在编辑器（Live Preview / 源码模式）中高亮目标行，不把光标移入链接内，
     * 避免 Obsidian Live Preview 将短链接「定位」展开为完整 wikilink。
     *
     * 这里不再给 CodeMirror 的行元素临时加 class（CM 重绘会清掉），
     * 而是根据 CodeMirror 坐标在滚动容器里叠加一个临时高亮层。
     */
    private flashNoteInEditor(editor: Editor, occ: NoteOccurrence): void {
        const cm = (editor as any).cm;
        if (!cm || typeof editor.posToOffset !== 'function') return;

        const lineText = editor.getLine(occ.line);
        const targetCh = Math.min(occ.ch, lineText.length);
        const offset = editor.posToOffset({ line: occ.line, ch: targetCh });

        const showOverlay = (): boolean => {
            try {
                // 必须等目标位置已经进入 CodeMirror 绘制视口（不依赖被装饰隐藏的具体字符坐标）
                const viewport = cm.viewport;
                if (!viewport || offset < viewport.from || offset > viewport.to) return false;

                const block = cm.lineBlockAt(offset);
                const contentRect = cm.contentDOM?.getBoundingClientRect?.() ?? null;
                const scrollerRect = cm.scrollDOM?.getBoundingClientRect?.() ?? null;
                if (!scrollerRect) return false;

                const scaleX = cm.scaleX || 1;
                const scaleY = cm.scaleY || 1;
                const screenLeft = contentRect?.left ?? scrollerRect.left;
                const screenTop = cm.documentTop + block.top;
                const screenBottom = screenTop + block.height;
                // 确保高亮位置确实在编辑器可视范围内，避免把层放到屏幕外
                if (screenBottom < scrollerRect.top || screenTop > scrollerRect.bottom) return false;

                const left = screenLeft - scrollerRect.left + (cm.scrollDOM.scrollLeft || 0) * scaleX;
                const top = screenTop - scrollerRect.top + (cm.scrollDOM.scrollTop || 0) * scaleY;
                const width = contentRect?.width ?? scrollerRect.width ?? 0;
                const height = block.height;

                if (width <= 0 || height <= 0) return false;
                this.showNoteOverlay(cm, left, top, width, height);
                return true;
            } catch (e) {
                console.warn('[PdfJump] 创建笔记高亮覆盖层失败:', e);
                return false;
            }
        };

        if (showOverlay()) return;

        // 滚动/渲染可能是异步的，稍等几帧后再尝试获取坐标
        let tries = 0;
        const timer = window.setInterval(() => {
            tries++;
            if (showOverlay() || tries >= 40) {
                window.clearInterval(timer);
            }
        }, 50);
    }

    /** 在 CodeMirror 滚动容器内叠加一个临时的半透明高亮框，不依赖行 DOM 的 class 存活 */
    private showNoteOverlay(cm: any, left: number, top: number, width: number, height: number): void {
        // 移除上一次可能残留的高亮框
        document.querySelectorAll('.pdf-reader-note-overlay').forEach((el) => el.remove());

        const overlay = document.createElement('div');
        overlay.className = 'pdf-reader-note-overlay';
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
        cm.scrollDOM.appendChild(overlay);
        window.setTimeout(() => overlay.remove(), 5000);
    }

    /** 在阅读模式渲染内容中查找与批注链接匹配的锚点 */
    private findRenderedNoteLink(container: HTMLElement, occ: NoteOccurrence): HTMLElement | null {
        const expect = occ.linktext.replace(/\s+/g, '');
        const anchors = container.querySelectorAll('a.internal-link');
        for (const a of Array.from(anchors)) {
            const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
            if (href.split('|')[0].replace(/\s+/g, '') === expect) {
                return a as HTMLElement;
            }
        }
        return null;
    }

    // ========== 工具 ==========

    /** 选区 key 规范化：parseInt 后拼接，与高亮层 data-pdf-jump-selection 一致 */
    private normalizeSelectionKey(s: string): string {
        const parts = s.split(',').map((p) => parseInt(p.trim(), 10));
        if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return '';
        return parts.join(',');
    }

    /** OCR 矩形 key 规范化：4 位小数去尾零，与笔记写入的 fmtRectNum 及高亮层一致 */
    private normalizeOcrKey(s: string): string {
        const parts = s.split(',').map((p) => Number(Number(p.trim()).toFixed(4)));
        if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return '';
        return parts.join(',');
    }

    /** 截图矩形 key 规范化：4 位小数去尾零，与截图高亮层 data-pdf-jump-rect 一致 */
    private normalizeRectKey(s: string): string {
        const parts = s.split(',').map((p) => Number(Number(p.trim()).toFixed(4)));
        if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return '';
        return parts.join(',');
    }

    /** 闪烁提示元素 */
    private flashElement(el: HTMLElement): void {
        el.addClass('pdf-reader-jump-flash');
        window.setTimeout(() => el.removeClass('pdf-reader-jump-flash'), 2400);
    }

    /** 查找包含指定节点的叶子 */
    private findLeafContaining(node: Node): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (!result && leaf.view.containerEl.contains(node)) {
                result = leaf;
            }
        });
        return result;
    }

    /** 查找已打开指定文件的叶子 */
    private findLeafByPath(path: string): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (!result && leaf.view instanceof FileView && leaf.view.file?.path === path) {
                result = leaf;
            }
        });
        return result;
    }
}
