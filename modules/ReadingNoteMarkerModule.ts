import { TFile, debounce, setIcon, setTooltip, normalizePath } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { buildNoteBaseRegex } from './noteNaming';

/**
 * 文件管理器标记模块
 *
 * 在 Obsidian 左侧文件管理器中，为「已有阅读笔记」的 PDF 文件显示一个小图标。
 *
 * 识别依据：
 *  1. 任意 Markdown 笔记 frontmatter 中的 `pdf: "[[xxx.pdf]]"` 字段；
 *  2. 兼容早期没有 pdf 字段的旧笔记：在阅读笔记文件夹内按命名模板（设置「阅读笔记命名模板」）
 *     渲染出的文件名匹配。
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

    /** 已有阅读笔记的 PDF 路径集合 */
    private pdfPathsWithNotes = new Set<string>();

    /** 各文件管理器叶子的 MutationObserver，用于 DOM 动态重建后重新装饰 */
    private observers: MutationObserver[] = [];

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

        // 笔记/PDF 增删改、frontmatter 变化、metadataCache 解析完成时重建索引
        plugin.registerEvent(plugin.app.vault.on('create', () => this.scheduleRefresh()));
        plugin.registerEvent(plugin.app.vault.on('delete', () => this.scheduleRefresh()));
        plugin.registerEvent(plugin.app.vault.on('rename', () => this.scheduleRefresh()));
        plugin.registerEvent(plugin.app.metadataCache.on('changed', (file) => {
            if (file.extension === 'md') this.scheduleRefresh();
        }));
        plugin.registerEvent(plugin.app.metadataCache.on('resolved', () => this.scheduleRefresh()));

        // 文件管理器可能新建/移动/重建，需要重新挂 MutationObserver 并刷新
        plugin.registerEvent(plugin.app.workspace.on('layout-change', () => {
            this.watchExplorers();
            this.scheduleRefresh();
        }));

        // 插件卸载时统一清理
        plugin.register(() => {
            this.decorateAllDebounced.cancel();
            this.scheduleRefresh.cancel();
            this.disconnectObservers();
            this.clearAll();
            this.pdfPathsWithNotes.clear();
        });
    }

    unload(): void {
        this.decorateAllDebounced.cancel();
        this.scheduleRefresh.cancel();
        this.disconnectObservers();
        this.clearAll();
        this.pdfPathsWithNotes.clear();
    }

    // ========== 索引建立 ==========

    /** 标记开关（设置为 false 时隐藏全部标记） */
    private markerEnabled(): boolean {
        return this.ctx.getSettings().fileMarkerEnabled !== false;
    }

    /**
     * 重建“PDF 路径 -> 已有阅读笔记”索引。
     * 优先使用 frontmatter 的 pdf 字段；旧笔记无该字段时按命名模板在阅读笔记文件夹内兜底。
     */
    private async rebuildIndex(): Promise<void> {
        const next = new Set<string>();

        // 收集所有 PDF 的 basename -> 路径列表，用于旧笔记命名兜底
        const pdfsByBasename = new Map<string, string[]>();
        for (const file of this.ctx.plugin.app.vault.getFiles()) {
            if (file.extension !== 'pdf') continue;
            const arr = pdfsByBasename.get(file.basename) ?? [];
            arr.push(file.path);
            pdfsByBasename.set(file.basename, arr);
        }

        const folderPath = normalizePath(this.ctx.getSettings().readingNoteFolder);
        // 与「阅读笔记命名模板」设置保持同一套命名规则（含可选的 (n) 重名后缀）
        const nameRegex = buildNoteBaseRegex(this.ctx.getSettings().readingNoteNameTemplate);

        for (const note of this.ctx.plugin.app.vault.getMarkdownFiles()) {
            const pdfPath = this.extractPdfPath(note);
            if (pdfPath) {
                next.add(pdfPath);
                continue;
            }

            // 旧笔记没有 pdf 字段：仅匹配阅读笔记文件夹内按模板命名的笔记
            // （folderPath 为空表示 vault 根目录，此时所有笔记都在文件夹内）
            const inReadingFolder = !folderPath || note.path.startsWith(folderPath + '/');
            if (inReadingFolder) {
                const m = note.basename.match(nameRegex);
                if (!m) continue;
                const matches = pdfsByBasename.get(m[1]);
                if (matches?.length === 1) next.add(matches[0]);
            }
        }

        this.pdfPathsWithNotes = next;
    }

    /** 从笔记 frontmatter 中解析 `pdf: "[[path]]"`，返回 PDF 路径；无则返回 null */
    private extractPdfPath(note: TFile): string | null {
        const fm = this.ctx.plugin.app.metadataCache.getFileCache(note)?.frontmatter;
        const value = fm?.pdf;
        if (typeof value !== 'string') return null;

        const m = value.match(/\[\[(.+?)\]\]/);
        const path = (m ? m[1] : value.trim()) || '';
        return path || null;
    }

    // ========== 文件管理器 DOM 装饰 ==========

    /** 遍历所有文件管理器叶子，重新装饰所有 PDF 行；关闭开关时清空标记 */
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

    /** 装饰单个文件管理器行：有笔记的 PDF 加 class + 小图标 */
    private decorateEl(el: HTMLElement): void {
        const path = el.getAttribute('data-path') || '';
        const hasNote = path.toLowerCase().endsWith('.pdf') && this.pdfPathsWithNotes.has(path);

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
