import { TFile, WorkspaceLeaf, FileView, MarkdownView } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { pruneStaleLeaves } from './toolbarPoller';

/**
 * PDF 持久高亮模块公共基类
 *
 * 文本选区高亮（PdfHighlightModule）与 OCR 区域高亮（OcrHighlightModule）
 * 共享同一套骨架：事件挂载、索引防抖重建、视图渲染调度、笔记内容读取。
 * 子类只需实现：
 *  - renderEventName：页面（重新）渲染事件名（textlayerrendered / pagerendered）
 *  - rebuildIndex：解析笔记内容建立索引
 *  - renderPageHighlights：渲染单页高亮
 */
export abstract class BasePdfHighlightModule<T> implements PluginModule {
    protected ctx: ModuleContext;
    /** pdfPath → 高亮索引（索引类型由子类定义） */
    protected indexCache = new Map<string, T>();
    /** 已挂载事件监听的叶子（避免重复挂载） */
    private attachedLeaves = new Set<WorkspaceLeaf>();
    /** 重建索引的防抖定时器 */
    private rebuildTimer: number | null = null;
    /** 防抖窗口内待重建的 PDF：'full' = 全量重建（删除/重命名路径），string[] = 局部重建路径集，null = 无待办 */
    private pendingRebuild: 'full' | string[] | null = null;

    /** 页面（重新）渲染时触发的事件名，子类覆写 */
    protected abstract get renderEventName(): string;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const app = this.ctx.plugin.app;

        // 叶子布局变化（PDF 视图打开/关闭/分屏）时挂载监听
        this.ctx.plugin.registerEvent(
            app.workspace.on('layout-change', () => this.attachToPdfLeaves())
        );
        this.ctx.plugin.registerEvent(
            app.workspace.on('active-leaf-change', () => this.attachToPdfLeaves())
        );

        // PDF 打开（含 Obsidian 启动恢复工作区、会话中打开新 PDF）→ 精确重建该 PDF 索引。
        // 否则首次打开的 PDF 页渲染事件触发时 indexCache 中尚无索引，既有批注高亮不显示。
        this.ctx.plugin.registerEvent(
            app.workspace.on('file-open', (file: TFile | null) => {
                if (file && file.extension === 'pdf') {
                    this.scheduleRebuildForPdfs([file.path]);
                }
            })
        );

        // 笔记修改（批注写入、删除等）→ 防抖重建索引并刷新
        // 仅当变更的笔记链接到 PDF 时才触发重建，避免无关笔记编辑导致全量索引扫描；
        // 且只重建受影响的具体 PDF，而非全部已打开的 PDF
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

        // 插件加载时对已打开的 PDF 视图立即挂载
        this.attachToPdfLeaves();
        // 已打开视图的页面可能已渲染完毕（render 事件不再触发），主动重建索引并渲染
        this.scheduleRebuild();
    }

    unload(): void {
        this.attachedLeaves.clear();
        this.indexCache.clear();
        this.pendingRebuild = null;
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
    }

    /** 重建单个 PDF 的索引（子类解析笔记内容并填充索引） */
    protected abstract rebuildIndex(pdfPath: string): Promise<void>;

    /** 渲染单页的高亮覆盖层（子类实现；render 事件与手动刷新时调用） */
    protected abstract renderPageHighlights(pdfPath: string, pageView: any): void;

    /** 全部（已打开视图的 PDF）重建并重渲染 */
    protected scheduleRebuild(): void {
        this.scheduleTimer('full');
    }

    /**
     * 精确重建指定 PDF 并重渲染（编辑单篇笔记的常规路径）：
     * 只重建受影响且可能打开的 PDF，避免每次笔记编辑都全量重扫所有打开的 PDF。
     * 防抖窗口内多次请求会合并路径；已被全量请求（'full'）覆盖时维持全量。
     */
    protected scheduleRebuildForPdfs(pdfPaths: string[]): void {
        if (pdfPaths.length === 0) return;
        this.scheduleTimer(pdfPaths);
    }

    /** 统一防抖调度：合并窗口内请求，'full' 请求优先且不可被局部请求降级 */
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
                this.rebuildAllIndexes().then(() => this.renderAllOpenPdfs());
            } else {
                this.rebuildAndRender(pending);
            }
        }, 300);
    }

    /** 只重建指定 PDF 的索引并渲染对应视图（未打开的 PDF 渲染为空操作） */
    private async rebuildAndRender(pdfPaths: string[]): Promise<void> {
        for (const path of pdfPaths) {
            await this.rebuildIndex(path);
        }
        for (const path of pdfPaths) {
            this.renderForPdf(path);
        }
    }

    protected getOrCreateIndex(pdfPath: string, factory: () => T): T {
        let index = this.indexCache.get(pdfPath);
        if (!index) {
            index = factory();
            this.indexCache.set(pdfPath, index);
        }
        return index;
    }

    /** 重建所有「当前有视图打开」的 PDF 索引 */
    private async rebuildAllIndexes(): Promise<void> {
        const openPdfPaths = this.getOpenPdfPaths();
        for (const path of openPdfPaths) {
            await this.rebuildIndex(path);
        }
        // 清理已不再打开（或已删除）PDF 的缓存
        for (const path of [...this.indexCache.keys()]) {
            if (!openPdfPaths.has(path) && !this.ctx.plugin.app.vault.getAbstractFileByPath(path)) {
                this.indexCache.delete(path);
            }
        }
    }

    protected getOpenPdfPaths(): Set<string> {
        const paths = new Set<string>();
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === 'pdf') {
                const file = (leaf.view as FileView).file;
                if (file) paths.add(file.path);
            }
        });
        return paths;
    }

    private attachToPdfLeaves(): void {
        // 修剪已关闭叶子的陈旧缓存条目：叶子关闭时 eventBus 已失效，
        // 但 attachedLeaves 仍持有引用，长期会话下会累积泄漏
        pruneStaleLeaves(this.ctx.plugin.app, this.attachedLeaves);
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;
            if (this.attachedLeaves.has(leaf)) return;

            const viewer = (leaf.view as any).viewer;
            const eventBus = viewer?.child?.pdfViewer?.eventBus;
            if (!eventBus) return;

            this.attachedLeaves.add(leaf);
            const onRendered = (data: any) => {
                const pdfFile = (leaf.view as FileView).file;
                if (!pdfFile) return;
                this.renderPageHighlights(pdfFile.path, data?.source);
            };
            eventBus.on(this.renderEventName, onRendered);
            this.ctx.plugin.register(() => {
                eventBus.off(this.renderEventName, onRendered);
                this.attachedLeaves.delete(leaf);
            });

            // 兜底：新挂载叶子若已持有文件（file-open 事件可能早于插件加载触发），
            // 立即调度该 PDF 的索引重建，确保打开即渲染既有批注高亮。
            // （scheduleRebuildForPdfs 内部按路径合并 + 300ms 防抖，重复调度无副作用）
            const pdfFile = (leaf.view as FileView).file;
            if (pdfFile) {
                this.scheduleRebuildForPdfs([pdfFile.path]);
            }
        });
    }

    protected renderForPdf(pdfPath: string): void {
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;
            const pdfFile = (leaf.view as FileView).file;
            if (!pdfFile || pdfFile.path !== pdfPath) return;
            const viewer = (leaf.view as any).viewer;
            const pdfViewer = viewer?.child?.pdfViewer?.pdfViewer;
            if (!pdfViewer) return;
            for (const pageView of pdfViewer._pages ?? []) {
                if (pageView?.div) this.renderPageHighlights(pdfPath, pageView);
            }
        });
    }

    protected renderAllOpenPdfs(): void {
        for (const path of this.getOpenPdfPaths()) {
            this.renderForPdf(path);
        }
    }

    /** 读取笔记内容：优先打开中的编辑器缓冲，其次磁盘 */
    protected async readNoteContent(sourceFile: TFile): Promise<string> {
        const app = this.ctx.plugin.app;
        let editorContent: string | null = null;
        app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
            if (editorContent !== null) return;
            const view = leaf.view as MarkdownView;
            if (view.file?.path === sourceFile.path && view.editor) {
                editorContent = view.editor.getValue();
            }
        });
        if (editorContent !== null) return editorContent;
        return await app.vault.read(sourceFile);
    }
}
