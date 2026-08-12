import { TFile, WorkspaceLeaf, FileView, MarkdownView } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';

/**
 * 截图 OCR 区域持久高亮模块
 *
 * 设计与 pdf-reader 的 PdfHighlightModule 同源：高亮由「笔记内容」驱动，
 * 而非内存状态。批注写入笔记时链接附带 `&ocr=x,y,w,h`（归一化矩形），
 * 本模块扫描指向该 PDF 的笔记、提取这些链接建立索引，并在 PDF 视图上
 * 渲染高亮矩形（仅作标记，不可交互）。
 *
 * 关键特性：
 *  - 持久：翻页/缩放/重开 PDF 都会重新渲染（pagerendered 事件 + 索引重建）
 *  - 删除同步：笔记中删掉批注 → 300ms 防抖重建索引 → 高亮随即消失
 */

/** 归一化矩形（0-1，相对页面尺寸） */
export interface OcrRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 一次刷新显式注入的高亮条目（笔记可能尚未落盘，用于批注后即时高亮） */
export interface OcrHighlightEntry {
    page: number;
    rect: OcrRect;
}

interface IndexedHighlight {
    nx: number;
    ny: number;
    nw: number;
    nh: number;
}

/** page → (rectKey → highlight) */
type PageHighlights = Map<string, IndexedHighlight>;
/** pdfPath → page → highlights */
type PdfOcrIndex = Map<number, PageHighlights>;

export class OcrHighlightModule implements PluginModule {
    private ctx: ModuleContext;
    /** pdfPath → 高亮索引 */
    private indexCache = new Map<string, PdfOcrIndex>();
    /** 已挂载事件监听的叶子 */
    private attachedLeaves = new Set<WorkspaceLeaf>();
    /** 重建索引的防抖定时器 */
    private rebuildTimer: number | null = null;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const app = this.ctx.plugin.app;

        this.ctx.plugin.registerEvent(
            app.workspace.on('layout-change', () => this.attachToPdfLeaves())
        );
        this.ctx.plugin.registerEvent(
            app.workspace.on('active-leaf-change', () => this.attachToPdfLeaves())
        );

        // 笔记增删改 → 防抖重建索引并刷新（删除批注后高亮随即消失）
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('changed', () => this.scheduleRebuild())
        );
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('deleted', () => this.scheduleRebuild())
        );
        this.ctx.plugin.registerEvent(
            app.vault.on('rename', () => this.scheduleRebuild())
        );

        this.attachToPdfLeaves();
        // 已打开视图的页面可能已渲染完毕（pagerendered 不再触发），主动重建并渲染
        this.scheduleRebuild();
    }

    unload(): void {
        this.attachedLeaves.clear();
        this.indexCache.clear();
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
    }

    /**
     * 刷新指定 PDF 的高亮：
     *  - 先从笔记内容重建索引
     *  - explicit 为刚批注写入的条目，直接并入索引（规避 metadataCache 落盘延迟，实现即时高亮）
     *  - 最后重渲染所有已打开该 PDF 的视图
     */
    refresh(pdfFile: TFile, explicit?: OcrHighlightEntry[]): void {
        const pdfPath = pdfFile.path;
        this.rebuildIndex(pdfPath).then(() => {
            if (explicit && explicit.length > 0) {
                const index = this.getOrCreateIndex(pdfPath);
                for (const e of explicit) {
                    const pageMap = index.get(e.page) ?? new Map<string, IndexedHighlight>();
                    pageMap.set(rectKey(e.rect), {
                        nx: e.rect.x, ny: e.rect.y, nw: e.rect.w, nh: e.rect.h,
                    });
                    index.set(e.page, pageMap);
                }
            }
            this.renderForPdf(pdfPath);
        });
    }

    /** 全部（已打开视图的 PDF）重建并重渲染 */
    private scheduleRebuild(): void {
        if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            this.rebuildAllIndexes().then(() => this.renderAllOpenPdfs());
        }, 300);
    }

    // ========== 索引构建 ==========

    private getOrCreateIndex(pdfPath: string): PdfOcrIndex {
        let index = this.indexCache.get(pdfPath);
        if (!index) {
            index = new Map<number, PageHighlights>();
            this.indexCache.set(pdfPath, index);
        }
        return index;
    }

    /**
     * 重建单个 PDF 的索引。
     * 与 PdfHighlightModule 同：metadataCache 不记录指向 PDF 的正文链接，
     * 因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再读取笔记原文提取 ocr 链接。
     */
    private async rebuildIndex(pdfPath: string): Promise<void> {
        const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
        if (!(pdfFile instanceof TFile)) return;

        const newIndex: PdfOcrIndex = new Map();
        const app = this.ctx.plugin.app;

        for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
            if (!links[pdfPath]) continue;
            const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;
            try {
                // 优先取打开的编辑器缓冲（批注写入后可能尚未落盘）
                const content = await this.readNoteContent(sourceFile);
                this.extractOcrLinks(content, pdfFile, sourcePath, newIndex);
            } catch (e) {
                console.warn('[OcrHighlight] 读取笔记失败:', sourcePath, e);
            }
        }

        this.indexCache.set(pdfPath, newIndex);
    }

    /** 读取笔记内容：优先打开中的编辑器缓冲，其次磁盘 */
    private async readNoteContent(sourceFile: TFile): Promise<string> {
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

    /** 从笔记原文中提取指向指定 PDF 的 ocr 链接并写入索引 */
    private extractOcrLinks(
        content: string,
        pdfFile: TFile,
        sourcePath: string,
        index: PdfOcrIndex
    ): void {
        const app = this.ctx.plugin.app;
        // 匹配 [[path#page=N&ocr=x,y,w,h|alias]] 与无别名形式
        const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&ocr=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = linkRegex.exec(content)) !== null) {
            const linkpath = m[1].trim();
            const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
            if (target !== pdfFile) continue;

            const page = parseInt(m[2], 10);
            const parts = m[3].split(',').map((s) => parseFloat(s.trim()));
            if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p))) continue;

            const [nx, ny, nw, nh] = parts;
            const pageMap = index.get(page) ?? new Map<string, IndexedHighlight>();
            pageMap.set(rectKey({ x: nx, y: ny, w: nw, h: nh }), { nx, ny, nw, nh });
            index.set(page, pageMap);
        }
    }

    /** 重建所有「当前有视图打开」的 PDF 索引 */
    private async rebuildAllIndexes(): Promise<void> {
        const openPdfPaths = this.getOpenPdfPaths();
        for (const path of openPdfPaths) {
            await this.rebuildIndex(path);
        }
        for (const path of [...this.indexCache.keys()]) {
            if (!openPdfPaths.has(path) && !this.ctx.plugin.app.vault.getAbstractFileByPath(path)) {
                this.indexCache.delete(path);
            }
        }
    }

    // ========== 视图挂载与渲染 ==========

    private getOpenPdfPaths(): Set<string> {
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
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;
            if (this.attachedLeaves.has(leaf)) return;

            const viewer = (leaf.view as any).viewer;
            const eventBus = viewer?.child?.pdfViewer?.eventBus;
            if (!eventBus) return;

            this.attachedLeaves.add(leaf);
            // pagerendered：页面（重新）渲染后放置高亮；覆盖首次渲染、翻页、缩放
            const onPageRendered = (data: any) => {
                const pdfFile = (leaf.view as FileView).file;
                if (!pdfFile) return;
                this.renderPageHighlights(pdfFile.path, data?.source);
            };
            eventBus.on('pagerendered', onPageRendered);
            this.ctx.plugin.register(() => {
                eventBus.off('pagerendered', onPageRendered);
                this.attachedLeaves.delete(leaf);
            });
        });
    }

    private renderForPdf(pdfPath: string): void {
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

    private renderAllOpenPdfs(): void {
        for (const path of this.getOpenPdfPaths()) {
            this.renderForPdf(path);
        }
    }

    /** 渲染单页的高亮层（pagerendered 时调用，缩放/翻页会重发事件 → 自动重建） */
    private renderPageHighlights(pdfPath: string, pageView: any): void {
        if (!pageView?.div) return;
        const pageDiv = pageView.div as HTMLElement;
        const pageNumber = parseInt(pageDiv.dataset.pageNumber ?? '0', 10) || 0;

        // 移除旧高亮层（页面重渲染时重建）
        pageDiv.querySelector('.ocr-highlight-layer')?.remove();

        const index = this.indexCache.get(pdfPath);
        const pageMap = index?.get(pageNumber);
        if (!pageMap || pageMap.size === 0) return;

        const layerEl = pageDiv.createDiv('ocr-highlight-layer');
        for (const h of pageMap.values()) {
            const rectEl = layerEl.createDiv('ocr-crop-highlight');
            Object.assign(rectEl.style, {
                left: `${(h.nx * 100).toFixed(3)}%`,
                top: `${(h.ny * 100).toFixed(3)}%`,
                width: `${(h.nw * 100).toFixed(3)}%`,
                height: `${(h.nh * 100).toFixed(3)}%`,
            });
        }
    }
}

/** 归一化矩形→索引键（去重用，4 位小数与笔记中 fmtRectNum 格式一致） */
function rectKey(r: OcrRect): string {
    return `${Number(r.x.toFixed(4))},${Number(r.y.toFixed(4))},${Number(r.w.toFixed(4))},${Number(r.h.toFixed(4))}`;
}
