import {
    Editor,
    EditorPosition,
    MarkdownView,
    TAbstractFile,
    TFile,
    WorkspaceItem,
    WorkspaceLeaf,
    WorkspaceParent,
    WorkspaceSidedock,
    WorkspaceSplit,
    editorInfoField,
    parseLinktext,
    setIcon,
    setTooltip,
} from 'obsidian';
import { EditorView, showPanel } from '@codemirror/view';
import type { ModuleContext, PluginModule } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';
import type { QuickTagModule } from './QuickTagModule';
import { MarkdownAnnotationSync, type MarkdownHighlightInfo } from './MarkdownAnnotationSync';
import {
    collectRawLinks,
    countHighlightPairsBefore,
    countPrecedingSameLinks,
    extractLinkLabel,
    findLinkAtColumn,
    normalizeHighlightText,
    pickClickedLink,
    stripLinkDecorations,
    type LocatorClickInfo,
} from './linkLocator';

/**
 * Markdown 批注模块
 *
 * 把原本只服务于 PDF 的「批注到笔记」思想搬到 Markdown 笔记里：
 *  - 会话级「正在阅读的文献」标记（Obsidian 关闭后清空，不写入 data.json）
 *  - 每个 Markdown 编辑器顶部注入工具栏：正在阅读 / 附带原文 / 添加标签 / 目标提示
 *  - 在已标记的来源笔记中选中文字后，选区右上角出现「批注到笔记」浮动按钮
 *  - 点击后：来源选区自动包上 == 高亮；目标笔记光标处写入 [!pdf-annotation] 蓝框或纯链接
 *  - 点击目标笔记里的「定位」链接时，接管导航并只点亮来源笔记中对应的 == 文本
 *    （Obsidian 原生对带 #标题 的链接会闪「标题 → 下一个标题」的整节）
 *  - 删除目标笔记中的「定位」链接时，同步撤销来源笔记里对应的 == 包裹
 *
 * 目标笔记仍然复用 PdfReaderModule.getCursorNotePos()：
 * 「最近获得光标的未标记笔记」。来源笔记通过排除器不参与目标跟踪，
 * 因此从目标笔记切回来源笔记后，目标不会丢失。
 */
interface MdSelectionSnapshot {
    file: TFile;
    editor: Editor;
    text: string;
    from: EditorPosition;
    to: EditorPosition;
}

/** 目标笔记中一次链接插入的位置信息 */
interface MdTargetInsertion {
    /** 需要聚焦的「笔记：」提示行；纯链接模式为 null */
    promptLine: number | null;
    /** 刚插入的链接在目标编辑器中的起始偏移 */
    linkStartOffset: number;
}

/**
 * 笔记内跳转定位高亮样式 class。
 *
 * 刻意与 PdfJumpModule 的 `pdf-reader-note-flash-mark` **不同名**（两者共用 styles.css 里的
 * 同一套动画）：Obsidian 原生的 `Editor.removeHighlights(className)` 按 class 注销整份装饰，
 * 同名时一边的清理会把另一边正在播放的闪烁一起抹掉 —— 例如点 PDF 高亮闪笔记 callout 的同时
 * 点了「定位」链接闪来源 `==`，后发生的那个会把先发生的打断。
 */
const NOTE_FLASH_MARK_CLASS = 'pdfreader-md-note-flash-mark';
const NOTE_FLASH_MS = 1100;

/** 等待来源笔记叶子就绪的上限（与 PdfJumpModule 等待 PDF 锚点同为 8 秒） */
const SOURCE_FLASH_WAIT_MS = 8000;
/** 等待来源笔记就绪时的轮询间隔 */
const SOURCE_FLASH_POLL_MS = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 点击「定位」链接后要点亮的来源 `==…==` 高亮。
 *
 * 来源链接只指向来源笔记的标题，真正的批注位置由 MarkdownAnnotationSync 的配对记录给出：
 * 偏移是 `==…==`（含两侧 `==`）在来源笔记原文中的绝对位置。
 */
interface PendingHighlight {
    startOffset: number;
    endOffset: number;
    /** `==…==` 内部原文，阅读模式下用于核对命中的 `<mark>` */
    text: string;
    /** 该 `==…==` 在全文高亮中的序号（阅读模式按渲染顺序取 `<mark>`） */
    markIndex: number;
}

/** 点击「定位」链接后在来源笔记里要滚动并点亮的目标 */
interface SourceFlashTarget {
    /** 来源笔记路径 */
    path: string;
    /** 链接里的子路径（`#标题`）；拿不到配对记录时兜底闪烁标题 */
    subpath: string;
    /** 配对记录定位到的高亮；null = 只能闪标题 */
    highlight: PendingHighlight | null;
}

/**
 * Obsidian 未写入官方 d.ts 的原生编辑器高亮 API（与 PdfJumpModule 同源）。
 * 按 class 维护 mark decoration，可精确作用于任意文本区间并自动展开折叠。
 */
interface HighlightCapableEditor {
    addHighlights?: (
        ranges: { from: EditorPosition; to: EditorPosition }[],
        className: string,
        addToState?: boolean,
        unfoldFolds?: boolean
    ) => void;
    removeHighlights?: (className?: string) => void;
}

export class MarkdownReadingModule implements PluginModule {
    private ctx: ModuleContext;
    private pdfModule: PdfReaderModule;
    private quickTagModule: QuickTagModule;

    /** 本次插件生命周期内被标记为「正在阅读」的来源笔记路径 */
    private sourcePath: string | null;
    private floatingBtn: HTMLElement | null;
    private trackedRange: Range | null;
    private followTimerId: number | null;
    private pendingSelection: MdSelectionSnapshot | null;
    /** 点击浮动按钮后的短暂静默期，避免 mouseup 延迟检查把按钮再次弹出来 */
    private suppressCheckUntil: number;
    /** 每个编辑器顶部工具栏 DOM -> 对应 CM6 EditorView */
    private toolbarViews: Map<HTMLElement, EditorView>;
    /** 「定位」跳转代次：新跳转与卸载时自增，用于中止在途的滚动等待 */
    private flashRunId: number;
    private sourceFlashTimer: number | null;
    private sourceFlashEl: HTMLElement | null;
    /** 编辑器模式下持有跳转高亮的编辑器（到期/卸载时按 class 注销） */
    private sourceFlashEditor: Editor | null;
    /** Markdown「定位」链接 ↔ 来源 `==高亮==` 的同步器 */
    private annotationSync: MarkdownAnnotationSync;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule, quickTagModule: QuickTagModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
        this.quickTagModule = quickTagModule;
        this.sourcePath = null;
        this.floatingBtn = null;
        this.trackedRange = null;
        this.followTimerId = null;
        this.pendingSelection = null;
        this.suppressCheckUntil = 0;
        this.toolbarViews = new Map();
        this.flashRunId = 0;
        this.sourceFlashTimer = null;
        this.sourceFlashEl = null;
        this.sourceFlashEditor = null;
        this.annotationSync = new MarkdownAnnotationSync(ctx);
    }

    load(): void {
        const plugin = this.ctx.plugin;

        // 来源笔记排除器：被标记的笔记不做批注目标。
        this.pdfModule.setAnnotationTargetExclusionProvider(
            (file) => file.path === this.sourcePath
        );

        // 每个 Markdown 编辑器顶部注入一条工具栏（CM6 官方 Panel API）
        plugin.registerEditorExtension(showPanel.of((view) => this.createEditorToolbar(view)));

        plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.refreshAllToolbars()));
        plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => this.onWorkspaceChanged()));
        plugin.registerEvent(plugin.app.workspace.on('file-open', () => this.onWorkspaceChanged()));
        plugin.registerEvent(plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            if (this.sourcePath === oldPath) this.sourcePath = file.path;
            this.annotationSync.handleRename(file, oldPath);
            this.refreshAllToolbars();
        }));
        plugin.registerEvent(plugin.app.vault.on('delete', (file: TAbstractFile) => {
            if (this.sourcePath === file.path) this.sourcePath = null;
            this.annotationSync.handleDelete(file);
            this.refreshAllToolbars();
        }));
        // 目标笔记中删除「定位」链接后，metadataCache 会更新；读取编辑器缓冲并同步来源高亮
        plugin.registerEvent(plugin.app.metadataCache.on('changed', (file: TFile) => {
            if (file.extension === 'md') this.annotationSync.schedule(file.path);
        }));

        plugin.addCommand({
            id: 'markdown-toggle-reading-source',
            name: '标记/取消当前笔记为正在阅读的文献',
            checkCallback: (checking) => {
                const file = plugin.app.workspace.getActiveFile();
                if (file == null || file.extension !== 'md') return false;
                if (checking === false) this.toggleReadingSource(file.path);
                return true;
            },
        });

        plugin.addCommand({
            id: 'markdown-annotate-selection',
            name: '将当前选中的文字批注到笔记（Markdown）',
            checkCallback: (checking) => {
                const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                if (view == null || view.editor == null || view.file == null) return false;
                if (this.sourcePath !== view.file.path) return false;
                if (view.editor.somethingSelected() === false) return false;
                if (checking === false) void this.annotateActiveSelection();
                return true;
            },
        });

        this.initFloatingButton();
        plugin.registerDomEvent(document, 'click', this.handleAnnotationLinkClick, true);
        plugin.registerDomEvent(document, 'mouseup', (evt) => {
            if (evt.button !== 0) return;
            this.scheduleSelectionCheck();
        });
        plugin.registerDomEvent(document, 'mousedown', (evt) => {
            if (evt.button !== 0) return;
            const target = evt.target;
            if (this.floatingBtn != null && this.floatingBtn.contains(target as Node)) return;
            if (target instanceof Element && target.closest('.menu') != null) return;
            this.hideFloatingButton();
        });
        plugin.registerDomEvent(document, 'scroll', () => this.repositionFloatingButton(), { capture: true });
        plugin.registerDomEvent(window, 'resize', () => this.repositionFloatingButton());

        // 启动后校准一次：处理插件未运行时已删除的链接
        this.annotationSync.startInitialSync();

        this.refreshAllToolbars();
    }

    unload(): void {
        this.sourcePath = null;
        this.pdfModule.setAnnotationTargetExclusionProvider(null);
        this.removeFloatingButton();
        this.clearSourceFlash();
        this.flashRunId++; // 模块卸载：中止在途的「定位」滚动等待
        this.annotationSync.unload();
        this.toolbarViews.clear();
    }

    // ========== 编辑器顶部工具栏 ==========

    private createEditorToolbar(view: EditorView): { dom: HTMLElement; top: boolean; mount?: () => void; destroy: () => void } {
        const dom = document.createElement('div');
        dom.className = 'pdfreader-md-toolbar';

        // Obsidian 的 Live Preview 表格支持「就地编辑单元格」：点击单元格时会临时创建一个
        // 嵌套在 <td> 里的 CM6 编辑器（TableCellEditor）。registerEditorExtension 是全局注册的，
        // 面板会被一起塞进单元格，撑破笔记里的表格——这类嵌套编辑器一律不生成工具栏。
        if (this.isNestedEditorView(view)) {
            dom.style.display = 'none';
            return {
                dom,
                top: true,
                mount: () => this.hideNestedPanelWrapper(dom),
                destroy: () => { },
            };
        }

        const markBtn = document.createElement('div');
        markBtn.addClass('clickable-icon');
        markBtn.addClass('pdfreader-md-toolbar-btn');
        markBtn.addClass('pdfreader-md-mark-btn');
        setIcon(markBtn, 'book-open');
        setTooltip(markBtn, '标记/取消：当前笔记是正在阅读的文献');
        markBtn.addEventListener('click', (evt: MouseEvent) => {
            evt.stopPropagation();
            const info = this.getEditorFileInfo(view);
            if (info == null) return;
            this.toggleReadingSource(info.file.path);
        });

        // 与 PDF 工具条「附带原文」按钮保持同图标、同视觉。
        const originalBtn = document.createElement('div');
        originalBtn.addClass('clickable-icon');
        originalBtn.addClass('pdfreader-md-toolbar-btn');
        originalBtn.addClass('pdfreader-md-original-btn');
        setIcon(originalBtn, 'link');
        setTooltip(originalBtn, '开启后：目标笔记蓝框中包含选中的原文；关闭后：只写来源链接');
        originalBtn.addEventListener('click', (evt: MouseEvent) => {
            evt.stopPropagation();
            this.toggleIncludeOriginalText();
        });

        // 与 PDF 工具条「标签」按钮保持同图标、同视觉。
        const tagBtn = document.createElement('div');
        tagBtn.addClass('clickable-icon');
        tagBtn.addClass('pdfreader-md-toolbar-btn');
        tagBtn.addClass('pdfreader-md-tag-btn');
        setIcon(tagBtn, 'tags');
        setTooltip(tagBtn, '快速添加标签\n在阅读笔记光标处插入凡例中的标签');
        tagBtn.addEventListener('click', (evt: MouseEvent) => {
            evt.stopPropagation();
            this.quickTagModule.openTagPicker();
        });

        const targetEl = document.createElement('span');
        targetEl.className = 'pdfreader-md-toolbar-target';

        dom.append(markBtn, originalBtn, tagBtn, targetEl);
        this.toolbarViews.set(dom, view);
        this.applyToolbarState(dom, view);

        return {
            dom,
            top: true,
            destroy: () => {
                this.toolbarViews.delete(dom);
            },
        };
    }

    /**
     * 判断 EditorView 是否是 Obsidian 内部的「嵌套编辑器」。
     *
     * 典型场景：Live Preview 里点击表格单元格后临时创建的 TableCellEditor，
     * 它的 .cm-editor 挂在 <td> 的 .table-cell-wrapper 中，而整个表格又位于外层笔记
     * 编辑器的 .cm-editor 内。这类编辑器不应出现笔记工具栏。
     */
    private isNestedEditorView(view: EditorView): boolean {
        const parent = view.dom.parentElement;
        if (parent == null) return false;
        if (parent.closest('.table-cell-wrapper') != null) return true;
        // 通用兜底：编辑器套在另一个 CM6 编辑器里（单元格编辑器、内嵌编辑器等）
        return parent.closest('.cm-editor') != null;
    }

    /**
     * 嵌套编辑器里连 CM6 为面板生成的 .cm-panels 外壳一起隐藏：
     * 只把面板自身 display:none 的话，外壳的背景/下边框仍会在单元格里留下一条横线。
     */
    private hideNestedPanelWrapper(dom: HTMLElement): void {
        const wrapper = dom.parentElement;
        if (wrapper == null) return;
        // 外壳里只有本插件这一个面板时才隐藏，避免连带影响其它插件的面板
        if (wrapper.classList.contains('cm-panels') && wrapper.childElementCount <= 1) {
            wrapper.style.display = 'none';
        } else {
            dom.style.display = 'none';
        }
    }

    /** 从 CM6 state 里拿到当前编辑器对应的 TFile 与 Obsidian Editor。 */
    private getEditorFileInfo(view: EditorView): { file: TFile; editor: Editor } | null {
        try {
            const info = view.state.field(editorInfoField);
            const file = info?.file;
            const editor = info?.editor;
            if (file instanceof TFile && file.extension === 'md' && editor != null) {
                return { file, editor };
            }
        } catch (e) {
            // 非 Markdown 编辑器没有 editorInfoField，忽略即可
        }
        return null;
    }

    private refreshAllToolbars(): void {
        this.toolbarViews.forEach((view, dom) => this.applyToolbarState(dom, view));
        const activeFile = this.ctx.plugin.app.workspace.getActiveFile();
        if (activeFile == null || activeFile.path !== this.sourcePath) {
            this.hideFloatingButton();
        }
    }

    private applyToolbarState(dom: HTMLElement, view: EditorView): void {
        const info = this.getEditorFileInfo(view);
        if (info == null) {
            dom.style.display = 'none';
            return;
        }
        dom.style.display = '';
        const markBtn = dom.querySelector<HTMLElement>('.pdfreader-md-mark-btn');
        const originalBtn = dom.querySelector<HTMLElement>('.pdfreader-md-original-btn');
        const targetEl = dom.querySelector<HTMLElement>('.pdfreader-md-toolbar-target');
        const isSource = this.sourcePath === info.file.path;
        const includeOriginal = this.pdfModule.shouldIncludeOriginalText();

        if (markBtn != null) markBtn.classList.toggle('is-active', isSource);
        if (originalBtn != null) originalBtn.classList.toggle('is-active', includeOriginal);

        if (targetEl != null) {
            const target = this.pdfModule.getCursorNotePos();
            if (target == null) {
                targetEl.textContent = '批注目标：未指定';
                targetEl.classList.add('is-empty');
            } else {
                targetEl.textContent = '批注目标：' + target.noteFile.basename;
                targetEl.classList.remove('is-empty');
            }
        }

        dom.classList.toggle('is-source-note', isSource);
    }

    /**
     * 由「开始阅读」调用：直接把某篇笔记标记为正在阅读的文献（不切换、不取消）。
     * 用于右键 md →「开始阅读」时，把左边那篇被当作文献阅读的 md 设为批注来源。
     */
    setReadingSource(path: string): void {
        if (this.sourcePath === path) return;
        this.sourcePath = path;
        this.hideFloatingButton();
        this.refreshAllToolbars();
    }

    private toggleReadingSource(path: string): void {
        if (this.sourcePath === path) {
            this.sourcePath = null;
        } else {
            this.sourcePath = path;
        }
        this.hideFloatingButton();
        this.refreshAllToolbars();
    }

    private toggleIncludeOriginalText(): void {
        const settings = this.ctx.getSettings();
        settings.annotationIncludeOriginalText = settings.annotationIncludeOriginalText === false;
        void this.ctx.saveSettings().catch((e) => {
            console.error('[MarkdownReading] 保存「附带原文」开关失败:', e);
        });
        this.refreshAllToolbars();
    }

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
    private handleAnnotationLinkClick = (evt: MouseEvent): void => {
        if (evt.button !== 0) return;
        if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
        const target = evt.target;
        if ((target instanceof Element) === false) return;

        // 阅读模式（及所有渲染出的 internal-link 锚点）
        const anchor = target.closest<HTMLElement>('a.internal-link');
        if (anchor != null) {
            // data-href 正常不含别名；防御性地去掉可能出现的 `|别名`
            const href = (anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '')
                .split('|')[0]
                .trim();
            if (href.length === 0) return;
            const leaf = this.findLeafContaining(anchor);
            const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
            const notePath = view?.file?.path
                ?? this.ctx.plugin.app.workspace.getActiveFile()?.path
                ?? '';
            this.takeOverLocatorClick(evt, {
                linktext: href,
                href,
                label: (anchor.textContent ?? '').trim(),
                notePath,
                occurrence: countPrecedingSameLinks(view?.contentEl ?? null, anchor, href),
                clickOffset: null,
            }, leaf);
            return;
        }

        // Live Preview：点击位置落在 `[[…]]`（或折叠后的链接 widget）上，取链接原文
        const inEditorLink = target.closest('.cm-hmd-internal-link, .cm-link');
        if (inEditorLink == null) return;
        const leaf = this.findLeafContaining(target);
        if (leaf == null || (leaf.view instanceof MarkdownView) === false) return;
        const view = leaf.view;
        // Source 视图（编辑模式下关闭实时预览）：普通点击不导航，维持 Obsidian 原行为
        const editMode = (view as any).editMode;
        if (editMode?.sourceMode) return;
        const editor = view.editor;
        if (editor == null || typeof (editor as any).posAtMouse !== 'function') return;

        let pos: EditorPosition | null = null;
        let token: any = null;
        try {
            pos = (editor as any).posAtMouse?.(evt) ?? null;
            token = pos != null ? (editor as any).getClickableTokenAt(pos) : null;
        } catch (e) {
            console.warn('[MarkdownReading] 读取编辑器链接 token 失败:', e);
        }
        if (pos == null) return;

        // 优先直接从行文本取链接原文：光标在链接内部时链接展开成原始 `[[…]]`，
        // 编辑器 token 可能丢掉别名（甚至不是 internal-link），会把「定位」链接漏掉。
        const raw = findLinkAtColumn(editor.getLine(pos.line), pos.ch);
        let linktext: string | null = raw?.text ?? null;
        if (linktext == null) {
            // 退化：行文本里没有完整的 `[[…]]`（例如链接被折叠成 widget）时仍用 token
            if (token == null || token.type !== 'internal-link') return;
            linktext = String(token.text ?? '');
        }
        if (linktext.length === 0) return;

        this.takeOverLocatorClick(evt, {
            linktext,
            href: stripLinkDecorations(linktext).split('|')[0].trim(),
            label: extractLinkLabel(linktext),
            notePath: view.file?.path ?? '',
            occurrence: -1,
            clickOffset: editor.posToOffset(pos),
        }, leaf);
    };

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
    private takeOverLocatorClick(
        evt: MouseEvent, info: LocatorClickInfo, sourceLeaf: WorkspaceLeaf | null
    ): void {
        if (info.linktext.length === 0 || info.href.length === 0 || info.notePath.length === 0) return;
        const parsed = parseLinktext(info.href);
        const targetFile = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(parsed.path, info.notePath);
        if ((targetFile instanceof TFile) === false || targetFile.extension !== 'md') return;

        if (this.annotationSync.hasRecordForSource(info.notePath, targetFile.path, parsed.subpath) === false) {
            return;
        }

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        void this.jumpToSourceHighlight(targetFile, parsed.subpath, info, sourceLeaf).catch((e) => {
            console.error('[MarkdownReading] 跳转来源批注失败:', e);
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
    private async jumpToSourceHighlight(
        targetFile: TFile, subpath: string, info: LocatorClickInfo, sourceLeaf: WorkspaceLeaf | null
    ): Promise<void> {
        const app = this.ctx.plugin.app;
        const noteContent = await this.readNoteContentByPath(info.notePath);
        const clicked = noteContent != null ? pickClickedLink(noteContent, info) : null;
        const record = clicked != null
            ? this.annotationSync.resolveRecordForLink(info.notePath, clicked.text, clicked.sameTextIndex, noteContent)
            : null;

        let highlight: PendingHighlight | null = null;
        if (record != null) {
            const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
            if (sourceFile instanceof TFile && sourceFile.extension === 'md') {
                const sourceContent = await this.readNoteContentByPath(sourceFile.path);
                const range = sourceContent != null
                    ? this.annotationSync.locateHighlightRange(sourceContent, record)
                    : null;
                if (sourceContent != null && range != null) {
                    highlight = {
                        startOffset: range.start,
                        endOffset: range.end,
                        text: record.highlightText,
                        markIndex: countHighlightPairsBefore(sourceContent, range.start),
                    };
                }
            }
        }

        const existingLeaf = this.findLeafByPath(targetFile.path);
        const leaf = existingLeaf ?? this.openLiteratureLeaf(targetFile, sourceLeaf);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        // 始终显式 openFile：空标签/新标签都要把目标文件开进去；
        // 打开时**不带 `#标题`**，因此不触发 Obsidian 原生整节闪烁，定位交给下面的滚动
        await leaf.openFile(targetFile);
        await this.scrollSourceToHighlight(leaf, { path: targetFile.path, subpath, highlight });
    }

    /** 读取笔记原文（优先打开中的编辑器缓冲，其次磁盘缓存） */
    private async readNoteContentByPath(path: string): Promise<string | null> {
        const app = this.ctx.plugin.app;
        const file = app.vault.getAbstractFileByPath(path);
        if ((file instanceof TFile) === false || file.extension !== 'md') return null;
        try {
            if (this.ctx.readNoteContent != null) {
                return await this.ctx.readNoteContent(file, { editorMode: 'source' });
            }
            return await app.vault.cachedRead(file);
        } catch (e) {
            console.warn('[MarkdownReading] 读取笔记内容失败:', path, e);
            return null;
        }
    }

    private onWorkspaceChanged(): void {
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
    private async scrollSourceToHighlight(leaf: WorkspaceLeaf, flash: SourceFlashTarget): Promise<void> {
        const runId = ++this.flashRunId;
        const headingName = flash.subpath.startsWith('#') ? decodeURIComponent(flash.subpath.slice(1)) : '';
        const deadline = Date.now() + SOURCE_FLASH_WAIT_MS;
        while (Date.now() < deadline) {
            if (this.flashRunId !== runId) return; // 已有新跳转，或模块已卸载
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === flash.path) {
                if (view.containerEl.isConnected === false) return; // 叶子已被关闭/替换，放弃点亮
                if (await this.tryFlashExactHighlight(view, flash.highlight)) return;
                // 没有高亮可等：直接闪标题
                if (flash.highlight == null && this.flashSourceHeading(view, headingName)) return;
            }
            await sleep(SOURCE_FLASH_POLL_MS);
        }
        // 精确高亮始终没渲染出来（被删除/折叠/解析不一致）：退回闪标题，至少给出位置
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === flash.path) {
            this.flashSourceHeading(view, headingName);
        }
    }

    /** 闪烁来源笔记的标题；返回是否已找到并点亮 */
    private flashSourceHeading(view: MarkdownView, headingName: string): boolean {
        const el = this.findHeadingElement(view.contentEl, headingName, view.getMode());
        if (el == null) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.flashElement(el);
        return true;
    }

    /** 精确点亮来源 `==…==`（滚动到该处并闪烁）；返回 true 表示已点亮 */
    private async tryFlashExactHighlight(view: MarkdownView, highlight: PendingHighlight | null): Promise<boolean> {
        if (highlight == null) return false;

        const editor = view.getMode() === 'source' ? view.editor : null;
        if (editor != null) {
            const lastLine = editor.lastLine();
            const docEnd = editor.posToOffset({ line: lastLine, ch: editor.getLine(lastLine).length });
            // 刚打开时编辑器缓冲尚未同步：偏移超出文档长度说明还没就绪，等下一轮
            if (docEnd < highlight.endOffset) return false;
            const from = editor.offsetToPos(Math.max(0, Math.min(highlight.startOffset, docEnd)));
            const to = editor.offsetToPos(Math.max(0, Math.min(highlight.endOffset, docEnd)));
            editor.scrollIntoView({ from, to }, true);
            this.flashEditorRange(editor, from, to);
            return true;
        }

        // 阅读模式：`==…==` 渲染为 <mark>。
        // 优先按全文序号取（同一段文字被高亮多次时只有序号能区分），文本对不上时再按内容找；
        // 两者都对不上（例如高亮里含公式/链接等渲染后文本会变）时仍按序号取——
        // 序号由原文的 `==` 配对推得，通常比渲染文本可信。
        const marks = view.contentEl.querySelectorAll<HTMLElement>('mark');
        if (marks.length === 0) return false;
        const expected = normalizeHighlightText(highlight.text);
        const matches = (text: string): boolean => {
            const actual = normalizeHighlightText(text);
            return actual.length > 0 && (actual === expected || actual.includes(expected));
        };
        const indexed: HTMLElement | null = marks[highlight.markIndex] ?? null;
        let el: HTMLElement | null = indexed;
        if (expected.length > 0 && (indexed == null || matches(indexed.textContent ?? '') === false)) {
            el = Array.from(marks).find((mark) => matches(mark.textContent ?? '')) ?? indexed;
        }
        if (el == null) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.flashElement(el);
        return true;
    }

    private findHeadingElement(container: HTMLElement, headingName: string, mode: string): HTMLElement | null {
        if (mode === 'preview') {
            const headings = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
            if (headingName.length === 0) return headings[0] ?? null;
            for (const heading of Array.from(headings)) {
                const headingText = (heading.dataset.heading ?? heading.textContent ?? '').trim();
                if (headingText === headingName || headingText.includes(headingName)) return heading;
            }
            return null;
        }
        const lines = container.querySelectorAll<HTMLElement>('.cm-line');
        if (headingName.length === 0) return lines[0] ?? null;
        for (const line of Array.from(lines)) {
            const text = (line.textContent ?? '').trim();
            if (line.classList.contains('HyperMD-header') && text.includes(headingName)) return line;
            const match = /^#{1,6}\s*(.*)$/.exec(text);
            if (match != null && match[1].includes(headingName)) return line;
            if (text.startsWith('#') && text.includes(headingName)) return line;
        }
        return null;
    }

    private flashElement(el: HTMLElement): void {
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
    private flashEditorRange(editor: Editor, from: EditorPosition, to: EditorPosition): void {
        const capable = editor as unknown as HighlightCapableEditor;
        if (typeof capable.addHighlights !== 'function') return;
        this.clearSourceFlash();
        try {
            // 先按 class 注销旧高亮再重新添加：相同区间重复 add 时 CM 判定装饰未变、不重建 DOM，
            // CSS 动画不会重播；两次独立 dispatch 才能保证连续点击时动画每次从头播放
            capable.removeHighlights?.(NOTE_FLASH_MARK_CLASS);
            capable.addHighlights([{ from, to }], NOTE_FLASH_MARK_CLASS, true, true);
        } catch (e) {
            console.warn('[MarkdownReading] 点亮来源高亮失败:', e);
            return;
        }
        this.sourceFlashEditor = editor;
        this.sourceFlashTimer = window.setTimeout(() => {
            this.sourceFlashTimer = null;
            this.clearSourceFlash();
        }, NOTE_FLASH_MS);
    }

    private clearSourceFlash(): void {
        if (this.sourceFlashTimer != null) {
            window.clearTimeout(this.sourceFlashTimer);
            this.sourceFlashTimer = null;
        }
        if (this.sourceFlashEl != null) {
            if (this.sourceFlashEl.isConnected) this.sourceFlashEl.removeClass(NOTE_FLASH_MARK_CLASS);
            this.sourceFlashEl = null;
        }
        const editor = this.sourceFlashEditor;
        this.sourceFlashEditor = null;
        if (editor != null) {
            try {
                (editor as unknown as HighlightCapableEditor).removeHighlights?.(NOTE_FLASH_MARK_CLASS);
            } catch {
                // 编辑器视图可能已关闭/销毁，忽略
            }
        }
    }

    private findLeafContaining(node: Node): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (result == null && leaf.view.containerEl.contains(node)) result = leaf;
        });
        return result;
    }

    /** 查找已打开指定笔记的叶子（含其它标签页/分屏/弹出窗口），与 PdfJumpModule 同款 */
    private findLeafByPath(path: string): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (result == null && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
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
    private openLiteratureLeaf(targetFile: TFile, sourceLeaf: WorkspaceLeaf | null): WorkspaceLeaf {
        const workspace = this.ctx.plugin.app.workspace;
        const noteGroup = sourceLeaf?.parent ?? null;

        const emptyLeaf = this.findEmptyMainLeaf(sourceLeaf, noteGroup);
        if (emptyLeaf != null) return emptyLeaf;

        const neighbour = this.findNeighbourLeaf(sourceLeaf, noteGroup);
        if (neighbour != null) {
            const tab = this.createTabInGroup(neighbour.parent);
            if (tab != null) return tab;
        }

        if (sourceLeaf != null) return workspace.createLeafBySplit(sourceLeaf, 'vertical', true);
        return workspace.getLeaf('tab');
    }

    /**
     * 在指定栏（标签组）末尾新开一个标签。
     * 公开类型把 parent 写成 `WorkspaceSplit`，但传入标签组就是在那一栏新增标签
     * （同 pdf-plus 的 `createLeafInParent(leaf.parentSplit, -1)` 用法）。
     * 落点不在同一栏或调用失败时撤销并返回 null，由调用方退回分屏。
     */
    private createTabInGroup(group: WorkspaceParent): WorkspaceLeaf | null {
        try {
            const tab = this.ctx.plugin.app.workspace.createLeafInParent(
                group as unknown as WorkspaceSplit,
                -1
            );
            if (tab == null) return null;
            if (tab.parent === group) return tab;
            tab.detach(); // 落点不对：撤销，别留下不相干的标签
        } catch (e) {
            console.warn('[MarkdownReading] 在相邻栏新开标签失败，改为分屏:', e);
        }
        return null;
    }

    /** 主区域里已有的空标签（排除笔记所在栏与左右侧边栏，侧边栏不能用来承载文献） */
    private findEmptyMainLeaf(sourceLeaf: WorkspaceLeaf | null, noteGroup: WorkspaceParent | null): WorkspaceLeaf | null {
        const workspace = this.ctx.plugin.app.workspace;
        const root = sourceLeaf?.getRoot() ?? workspace.rootSplit;
        let result: WorkspaceLeaf | null = null;
        workspace.iterateAllLeaves((leaf) => {
            if (result != null) return;
            if (leaf.getRoot() !== root) return;
            if (this.isSidebarLeaf(leaf)) return;
            if (noteGroup != null && leaf.parent === noteGroup) return;
            if (leaf.view.getViewType() === 'empty') result = leaf;
        });
        return result;
    }

    /** 与笔记所在栏同级（同一分屏内）的相邻栏：多栏时优先笔记左侧、离笔记最近的那一栏 */
    private findNeighbourLeaf(sourceLeaf: WorkspaceLeaf | null, noteGroup: WorkspaceParent | null): WorkspaceLeaf | null {
        if (sourceLeaf == null || noteGroup == null) return null;
        const split = noteGroup.parent;
        if (split == null) return null;

        // 分屏的 children 顺序就是「从左到右 / 从上到下」的排列顺序
        const groups = (split as unknown as { children?: WorkspaceParent[] }).children;
        if (Array.isArray(groups)) {
            const noteIndex = groups.indexOf(noteGroup);
            for (let i = noteIndex - 1; i >= 0; i--) {
                const leaf = this.findLeafInGroup(groups[i], sourceLeaf);
                if (leaf != null) return leaf; // 左侧最近的已有栏
            }
            for (let i = noteIndex + 1; i < groups.length; i++) {
                const leaf = this.findLeafInGroup(groups[i], sourceLeaf);
                if (leaf != null) return leaf; // 笔记本来就是第一栏：退回右侧相邻栏
            }
            return null;
        }

        // children 读不到（内部结构变化）时的兜底：同分屏内任意一栏
        const workspace = this.ctx.plugin.app.workspace;
        const root = sourceLeaf.getRoot();
        let result: WorkspaceLeaf | null = null;
        workspace.iterateAllLeaves((leaf) => {
            if (result != null) return;
            if (leaf.getRoot() !== root) return;
            if (this.isSidebarLeaf(leaf)) return;
            if (leaf.parent === noteGroup) return;
            const group = leaf.parent as { parent?: WorkspaceParent | null };
            if (group.parent !== split) return;
            result = leaf;
        });
        return result;
    }

    /** 取指定栏（标签组）里的一个叶子；异窗口叶子与侧边栏不算 */
    private findLeafInGroup(group: WorkspaceParent, reference: WorkspaceLeaf): WorkspaceLeaf | null {
        const root = reference.getRoot();
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (result != null) return;
            if (leaf.parent !== group) return;
            if (leaf.getRoot() !== root) return;
            if (this.isSidebarLeaf(leaf)) return;
            result = leaf;
        });
        return result;
    }

    /** 叶子是否位于左右侧边栏：侧边栏不是「分屏的一栏」，不能用来承载文献 */
    private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
        let item: WorkspaceItem | null = leaf.parent;
        while (item != null) {
            if (item instanceof WorkspaceSidedock) return true;
            item = (item as { parent?: WorkspaceItem | null }).parent ?? null;
        }
        return false;
    }

    // ========== 浮动批注按钮 ==========

    private initFloatingButton(): void {
        const btn = document.createElement('div');
        btn.className = 'pdfreader-md-annotate-floating-btn';
        btn.textContent = '批注到笔记';
        btn.addEventListener('mousedown', (evt) => evt.preventDefault());
        btn.addEventListener('click', () => {
            const snapshot = this.pendingSelection;
            this.suppressCheckUntil = Date.now() + 800;
            this.hideFloatingButton();
            if (snapshot != null) void this.annotateSelection(snapshot);
        });
        document.body.appendChild(btn);
        this.floatingBtn = btn;
    }

    private removeFloatingButton(): void {
        this.stopFollowTimer();
        this.trackedRange = null;
        this.pendingSelection = null;
        if (this.floatingBtn != null) {
            this.floatingBtn.remove();
            this.floatingBtn = null;
        }
    }

    private scheduleSelectionCheck(): void {
        window.setTimeout(() => this.checkSelectionForFloatingButton(), 150);
    }

    private checkSelectionForFloatingButton(): void {
        if (Date.now() < this.suppressCheckUntil) return;

        const plugin = this.ctx.plugin;
        const leaf = plugin.app.workspace.activeLeaf;
        const view = leaf?.view;
        if ((view instanceof MarkdownView) === false) {
            this.hideFloatingButton();
            return;
        }
        const file = view.file;
        const editor = view.editor;
        if (file == null || editor == null || file.extension !== 'md') {
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
        if (element == null || element.closest('.cm-content') == null) {
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
        if (to.line < from.line || (to.line === from.line && to.ch < from.ch)) {
            const tmp = from;
            from = to;
            to = tmp;
        }
        this.pendingSelection = { file, editor, text, from, to };
        this.showFloatingButton(range.cloneRange());
    }

    private showFloatingButton(range: Range): void {
        const btn = this.floatingBtn;
        if (btn == null) return;
        this.trackedRange = range;
        btn.classList.add('is-visible');
        this.repositionFloatingButton();
        if (this.followTimerId == null) {
            this.followTimerId = window.setInterval(() => this.repositionFloatingButton(), 200);
        }
    }

    private hideFloatingButton(): void {
        this.stopFollowTimer();
        this.trackedRange = null;
        this.pendingSelection = null;
        if (this.floatingBtn != null) {
            this.floatingBtn.classList.remove('is-visible');
        }
    }

    private stopFollowTimer(): void {
        if (this.followTimerId != null) {
            window.clearInterval(this.followTimerId);
            this.followTimerId = null;
        }
    }

    private repositionFloatingButton(): void {
        const btn = this.floatingBtn;
        const range = this.trackedRange;
        if (btn == null || range == null) return;

        const rect = this.getRangeAnchorRect(range);
        if (rect == null) {
            this.hideFloatingButton();
            return;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
            btn.classList.remove('is-visible');
            return;
        }
        btn.classList.add('is-visible');

        const btnW = btn.offsetWidth || 96;
        const btnH = btn.offsetHeight || 30;
        let left = rect.right - btnW / 2 + btnW / 4;
        left = Math.max(10, Math.min(left, vw - btnW - 10));
        let top = rect.top - btnH - 8;
        if (top < 10) top = Math.min(rect.bottom + 8, vh - btnH - 10);
        top = Math.max(10, Math.min(top, vh - btnH - 10));
        btn.style.left = Math.round(left) + 'px';
        btn.style.top = Math.round(top) + 'px';
    }

    private getRangeAnchorRect(range: Range): DOMRect | null {
        try {
            const rects = range.getClientRects();
            let anchor: DOMRect | null = null;
            for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                if (rect.width === 0 || rect.height === 0) continue;
                if (anchor == null || rect.bottom > anchor.bottom) anchor = rect;
            }
            if (anchor != null) return anchor;
            const bbox = range.getBoundingClientRect();
            if (bbox.width > 0 || bbox.height > 0) return bbox;
        } catch (e) {
            return null;
        }
        return null;
    }

    // ========== 批注写入 ==========

    private annotateActiveSelection(): void {
        const plugin = this.ctx.plugin;
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view == null || view.editor == null || view.file == null) return;
        const editor = view.editor;
        const file = view.file;
        if (this.sourcePath !== file.path) {
            return;
        }
        if (editor.somethingSelected() === false) {
            return;
        }
        const sel = editor.listSelections()[0];
        if (sel == null) return;
        let from = sel.anchor;
        let to = sel.head;
        if (to.line < from.line || (to.line === from.line && to.ch < from.ch)) {
            const tmp = from;
            from = to;
            to = tmp;
        }
        void this.annotateSelection({
            file,
            editor,
            text: editor.getSelection(),
            from,
            to,
        });
    }

    private async annotateSelection(snapshot: MdSelectionSnapshot): Promise<void> {
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
        let insertion: MdTargetInsertion;
        try {
            if (includeOriginal) {
                insertion = this.appendCalloutToTarget(snapshot, target, link, prompt);
            } else {
                insertion = this.appendLinkToTarget(snapshot, target, link);
            }
        } catch (e) {
            console.error('[MarkdownReading] 批注写入目标笔记失败:', e);
            return;
        }

        // 只在真正新增 `==` 包裹时登记配对记录；用户原本就手动高亮的内容，
        // 删除链接时不应擅自去掉用户已有的高亮。
        let highlight: MarkdownHighlightInfo | null = null;
        try {
            highlight = this.wrapSourceSelection(snapshot);
        } catch (e) {
            console.error('[MarkdownReading] 来源笔记高亮失败:', e);
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
            // 关附带原文：只写「定位」链接，光标已停在链接后 —— 同样把焦点交给目标笔记
            this.pdfModule.focusNoteLeaf(target.noteFile);
        }
    }

    private appendCalloutToTarget(
        snapshot: MdSelectionSnapshot,
        target: { noteFile: TFile; editor: Editor; line: number; ch: number },
        link: string,
        prompt: string
    ): MdTargetInsertion {
        const flatText = this.flattenForCallout(snapshot.text);
        const prefix = '> [!pdf-annotation]\n> ' + flatText + '\n> ';
        const block = prefix + link + '\n' + prompt;
        const annotation = '\n' + block + '\n';
        const startOffset = target.editor.posToOffset({ line: target.line, ch: target.ch });
        target.editor.replaceRange(annotation, { line: target.line, ch: target.ch });
        return {
            promptLine: target.line + annotation.split('\n').length - 2,
            // annotation = 首个换行 + prefix + link + …
            linkStartOffset: startOffset + 1 + prefix.length,
        };
    }

    private appendLinkToTarget(
        snapshot: MdSelectionSnapshot,
        target: { noteFile: TFile; editor: Editor; line: number; ch: number },
        link: string
    ): MdTargetInsertion {
        const inserted = link + ' ';
        const linkStartOffset = target.editor.posToOffset({ line: target.line, ch: target.ch });
        target.editor.replaceRange(inserted, { line: target.line, ch: target.ch });
        target.editor.setCursor({ line: target.line, ch: target.ch + inserted.length });
        return { promptLine: null, linkStartOffset };
    }

    /** 生成指回来源笔记的链接；优先最近一个标题，没有标题则指向整个文件。 */
    private buildSourceLink(sourceFile: TFile, targetFile: TFile, from: EditorPosition): string {
        const app = this.ctx.plugin.app;
        const headings = app.metadataCache.getFileCache(sourceFile)?.headings ?? [];
        let headingPath = '';
        for (const heading of headings) {
            if (heading.position.start.line > from.line) break;
            headingPath = '#' + heading.heading;
        }
        const subpath = headingPath.length > 0 ? headingPath : undefined;
        return app.fileManager.generateMarkdownLink(sourceFile, targetFile.path, subpath, this.pdfModule.linkLabel);
    }

    /** 把多行选区压成适合放进 callout 单行的原文。 */
    private flattenForCallout(text: string): string {
        let normalized = text.replace(/\r\n?/g, '\n');
        // 如果用户选中的文字本身已带 == 高亮，目标笔记里去掉包裹标记，
        // 保证 == 只出现在来源笔记。
        const trimmed = normalized.trim();
        if (trimmed.startsWith('==') && trimmed.endsWith('==') && trimmed.length >= 4) {
            normalized = trimmed.slice(2, -2);
        }
        return normalized
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(' ');
    }

    /** 来源笔记：在选中文字两边加 ==。已经高亮时不重复添加。 */
    private wrapSourceSelection(snapshot: MdSelectionSnapshot): MarkdownHighlightInfo | null {
        const editor = snapshot.editor;
        const text = snapshot.text.replace(/\r\n?/g, '\n');
        if (text.length === 0) return null;
        if (this.isAlreadyHighlighted(editor, snapshot.from, snapshot.to, text)) return null;
        const startOffset = editor.posToOffset(snapshot.from);
        const wrapped = '==' + text + '==';
        editor.replaceRange(wrapped, snapshot.from, snapshot.to);
        editor.setCursor(editor.offsetToPos(startOffset + wrapped.length));
        return {
            startOffset,
            endOffset: startOffset + wrapped.length,
            innerText: text,
        };
    }

    private isAlreadyHighlighted(editor: Editor, from: EditorPosition, to: EditorPosition, text: string): boolean {
        const trimmed = text.trim();
        if (trimmed.startsWith('==') && trimmed.endsWith('==')) return true;
        const fromOffset = editor.posToOffset(from);
        const toOffset = editor.posToOffset(to);
        const lastLine = editor.lastLine();
        const docLength = editor.posToOffset({ line: lastLine, ch: editor.getLine(lastLine).length });
        const before = editor.getRange(editor.offsetToPos(Math.max(0, fromOffset - 2)), from);
        const after = editor.getRange(to, editor.offsetToPos(Math.min(docLength, toOffset + 2)));
        return before === '==' && after === '==';
    }
}
