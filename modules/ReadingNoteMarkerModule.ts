import { TFile, debounce, setIcon, setTooltip, normalizePath } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { buildNoteBaseRegex } from './noteNaming';

/**
 * 文件管理器标记模块
 *
 * 在 Obsidian 左侧文件管理器中，为「已有阅读笔记」的文献文件（PDF 或 Markdown 文献）显示一个小图标。
 *
 * 识别依据：
 *  1. 任意 Markdown 笔记 frontmatter 中的 `pdf: "[[xxx.pdf]]"`（PDF 文献）或
 *     `source: "[[xxx.md]]"`（md 文献）字段；
 *  2. 兼容早期没有 pdf 字段的旧 PDF 笔记：在阅读笔记文件夹内按命名模板（设置「阅读笔记命名模板」）
 *     渲染出的文件名匹配。md 文献笔记从诞生起就写 source 字段，不需要、也不做命名兜底
 *     （否则会给「同名 PDF 的旧笔记」误配一篇恰好同名的 md）。
 *
 * 可通过设置 fileMarkerEnabled 关闭；关闭后任何刷新都会清空既有标记。
 *
 * 实现方式：
 *  - 使用 metadataCache 建立 PDF 路径 -> 有笔记 的索引，避免逐个读文件；
 *  - 监听 vault / metadataCache / workspace 事件，实时刷新；
 *  - 使用 MutationObserver 处理文件管理器虚拟滚动/重建导致的 DOM 更新。
 */
export class ReadingNoteMarkerModule implements PluginModule {
    private ctx: ModuleContext;

    /** 已有阅读笔记的文献路径集合（PDF 或 md 文献） */
    private sourcePathsWithNotes = new Set<string>();

    /** 文献路径被多少篇笔记引用，用于增量刷新时安全移除 */
    private sourceContributionCounts = new Map<string, number>();

    /** 各文件管理器叶子的 MutationObserver，用于 DOM 动态重建后重新装饰 */
    private observers: MutationObserver[] = [];

    /** PDF basename → 同名 PDF 路径列表，用于旧笔记命名兜底 */
    private pdfsByBasename = new Map<string, string[]>();

    /** 每个 Markdown 笔记当前贡献的 PDF 路径，便于增量更新时精确移除 */
    private noteContributions = new Map<string, Set<string>>();

    /** 增量刷新（单笔记）的待处理队列与定时器 */
    private pendingNotePaths = new Set<string>();
    private noteRefreshTimer: number | null = null;

    /** 命名模板正则缓存，避免每次重建都重新构造 */
    private nameRegexCache: RegExp | null = null;
    private nameTemplateCache = '';

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        // 布局就绪后先扫描一次，避免启动阶段文件尚未索引完成
        plugin.app.workspace.onLayoutReady(() => {
            void this.scheduleRefresh();
            this.watchExplorers();
        });

        // 笔记/PDF 增删改、metadataCache 解析完成时全量重建索引
        plugin.registerEvent(plugin.app.vault.on('create', () => this.scheduleRefresh()));
        plugin.registerEvent(plugin.app.vault.on('delete', () => this.scheduleRefresh()));
        plugin.registerEvent(plugin.app.vault.on('rename', () => this.scheduleRefresh()));
        // 普通 Markdown 内容变化只增量刷新对应笔记，避免每次输入都全量扫描
        plugin.registerEvent(plugin.app.metadataCache.on('changed', (file) => {
            if (file.extension === 'md') this.scheduleNoteRefresh(file.path);
        }));
        plugin.registerEvent(plugin.app.metadataCache.on('resolved', () => this.scheduleRefresh()));

        // 文件管理器可能新建/移动/重建，只需要重新挂 MutationObserver 并刷新装饰，
        // 不需要重建 PDF 索引
        plugin.registerEvent(plugin.app.workspace.on('layout-change', () => {
            this.watchExplorers();
            this.decorateAll();
        }));

        // 插件卸载时统一清理
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

    unload(): void {
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
    private markerEnabled(): boolean {
        return this.ctx.getSettings().fileMarkerEnabled !== false;
    }

    /**
     * 重建「文献路径 -> 已有阅读笔记」索引。
     * 优先使用 frontmatter 的 pdf 字段（PDF 文献）或 source 字段（md 文献）；
     * 旧 PDF 笔记无该字段时按命名模板在阅读笔记文件夹内兜底。
     * 全量重建只在文献/笔记结构性变化时执行；普通 Markdown 编辑走增量 refreshNote。
     */
    private async rebuildIndex(): Promise<void> {
        // 收集所有 PDF 的 basename -> 路径列表，用于旧笔记命名兜底
        const nextPdfsByBasename = new Map<string, string[]>();
        for (const file of this.ctx.plugin.app.vault.getFiles()) {
            if (file.extension !== 'pdf') continue;
            const arr = nextPdfsByBasename.get(file.basename) ?? [];
            arr.push(file.path);
            nextPdfsByBasename.set(file.basename, arr);
        }
        this.pdfsByBasename = nextPdfsByBasename;

        const next = new Set<string>();
        const nextContributions = new Map<string, Set<string>>();
        const nextCounts = new Map<string, number>();
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
    private computeNoteContributions(note: TFile): Set<string> {
        const sourcePath = this.extractSourcePath(note);
        if (sourcePath) return new Set([sourcePath]);

        // 旧笔记没有 pdf 字段：仅匹配阅读笔记文件夹内按模板命名的笔记
        // （folderPath 为空表示 vault 根目录，此时所有笔记都在文件夹内）
        const folderPath = normalizePath(this.ctx.getSettings().readingNoteFolder);
        const inReadingFolder = !folderPath || note.path.startsWith(folderPath + '/');
        if (!inReadingFolder) return new Set();

        const m = note.basename.match(this.getNameRegex());
        if (!m) return new Set();

        const matches = this.pdfsByBasename.get(m[1]);
        return matches?.length === 1 ? new Set([matches[0]]) : new Set();
    }

    /** 获取命名模板正则（带缓存，避免每个笔记重复构造） */
    private getNameRegex(): RegExp {
        const template = this.ctx.getSettings().readingNoteNameTemplate;
        if (!this.nameRegexCache || this.nameTemplateCache !== template) {
            this.nameRegexCache = buildNoteBaseRegex(template);
            this.nameTemplateCache = template;
        }
        return this.nameRegexCache;
    }

    /** 增量刷新单个 Markdown 笔记对文献标记的贡献 */
    private refreshNote(note: TFile): void {
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
    private scheduleNoteRefresh(notePath: string): void {
        this.pendingNotePaths.add(notePath);
        if (this.noteRefreshTimer !== null) return;

        this.noteRefreshTimer = window.setTimeout(() => {
            this.noteRefreshTimer = null;
            const paths = [...this.pendingNotePaths];
            this.pendingNotePaths.clear();

            for (const path of paths) {
                const note = this.ctx.plugin.app.vault.getAbstractFileByPath(path);
                if (note instanceof TFile) {
                    try {
                        this.refreshNote(note);
                    } catch (e) {
                        console.error('[ReadingNoteMarker] 增量刷新笔记标记失败:', path, e);
                    }
                }
            }
            this.decorateAll();
        }, 200);
    }

    private clearNoteRefreshTimer(): void {
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
    private extractSourcePath(note: TFile): string | null {
        const fm = this.ctx.plugin.app.metadataCache.getFileCache(note)?.frontmatter;
        const raw = fm?.pdf ?? fm?.source;
        if (typeof raw !== 'string') return null;

        const m = raw.match(/\[\[(.+?)\]\]/);
        const linktext = (m ? m[1] : raw.trim()) || '';
        const literal = linktext.split('|')[0].trim();
        if (!literal) return null;

        const direct = this.ctx.plugin.app.vault.getAbstractFileByPath(normalizePath(literal));
        if (direct instanceof TFile) return direct.path;

        const path = literal.split('#')[0].trim();
        if (path) {
            if (this.ctx.plugin.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile) {
                return normalizePath(path);
            }
            const dest = this.ctx.plugin.app.metadataCache.getFirstLinkpathDest(path, note.path);
            if (dest instanceof TFile) return dest.path;
        }
        return null;
    }

    // ========== 文件管理器 DOM 装饰 ==========

    /** 遍历所有文件管理器叶子，重新装饰所有文献行（PDF 与 md 文献）；关闭开关时清空标记 */
    private decorateAll(): void {
        if (!this.markerEnabled()) {
            this.clearAll();
            return;
        }
        for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType('file-explorer')) {
            const container = leaf.view.containerEl;
            if (!container) continue;
            container
                .querySelectorAll<HTMLElement>('.nav-file-title[data-path]')
                .forEach((el) => this.decorateEl(el));
        }
    }

    /** 装饰单个文件管理器行：有笔记的文献（PDF 或 md 文献）加 class + 小图标 */
    private decorateEl(el: HTMLElement): void {
        const path = el.getAttribute('data-path') || '';
        const lower = path.toLowerCase();
        const hasNote = (lower.endsWith('.pdf') || lower.endsWith('.md')) && this.sourcePathsWithNotes.has(path);

        el.toggleClass('pdf-reader-has-note', hasNote);

        let marker = el.querySelector(':scope > .pdf-reader-has-note-marker') as HTMLElement | null;
        if (hasNote) {
            if (!marker) {
                marker = el.createSpan({ cls: 'pdf-reader-has-note-marker' });
                setIcon(marker, 'file-check');
                setTooltip(marker, '已有阅读笔记');
                const content = el.querySelector('.nav-file-title-content');
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
    private clearAll(): void {
        for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType('file-explorer')) {
            const container = leaf.view.containerEl;
            if (!container) continue;
            container
                .querySelectorAll<HTMLElement>('.pdf-reader-has-note-marker')
                .forEach((el) => el.remove());
            container
                .querySelectorAll<HTMLElement>('.nav-file-title.pdf-reader-has-note')
                .forEach((el) => el.removeClass('pdf-reader-has-note'));
        }
    }

    // ========== 监听与防抖 ==========

    /** 文件管理器虚拟滚动/重建时，只需要重新装饰，不重建索引 */
    private decorateAllDebounced = debounce(() => {
        this.decorateAll();
    }, 100, true);

    /** 文件/笔记变化时，重建索引并重新装饰 */
    private scheduleRefresh = debounce(async () => {
        try {
            await this.rebuildIndex();
            this.decorateAll();
        } catch (e) {
            console.error('[ReadingNoteMarker] 刷新阅读笔记标记失败:', e);
        }
    }, 200, true);

    /** 为每个文件管理器叶子挂 MutationObserver，处理虚拟化/重建 */
    private watchExplorers(): void {
        this.disconnectObservers();

        for (const leaf of this.ctx.plugin.app.workspace.getLeavesOfType('file-explorer')) {
            const container = leaf.view.containerEl;
            if (!container) continue;
            const observer = new MutationObserver(() => this.decorateAllDebounced());
            observer.observe(container, { subtree: true, childList: true });
            this.observers.push(observer);
        }
    }

    private disconnectObservers(): void {
        for (const observer of this.observers) {
            observer.disconnect();
        }
        this.observers = [];
    }
}
