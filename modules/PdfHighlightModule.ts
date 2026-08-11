import { TFile, WorkspaceLeaf, FileView, MarkdownView } from 'obsidian';
import type { ModuleContext, PluginModule, SavedSelectionInfo } from '../types';

/**
 * PDF 文本持久高亮模块
 *
 * 职责：
 *  - 扫描笔记中指向 PDF 的 `#page=N&selection=bi,bo,ei,eo` 链接（由 PdfReaderModule 批注生成），
 *    建立「PDF → 页码 → 选区」索引
 *  - 在 PDF 视图中为这些选区渲染持续高亮覆盖层（替代原 pdf-plus 的 backlink visualizer 功能）
 *  - 笔记增删改、PDF 视图打开/翻页/缩放时自动重建高亮
 */

/** 选区 ID：beginIndex,beginOffset,endIndex,endOffset（与批注链接中的 selection 参数一致） */
type SelectionId = string;
/** 每个 PDF 的索引：页码 → 去重后的选区集合 */
type PdfHighlightIndex = Map<number, Set<SelectionId>>;

export class PdfHighlightModule implements PluginModule {
    private ctx: ModuleContext;

    /** pdfPath → 高亮索引 */
    private indexCache = new Map<string, PdfHighlightIndex>();
    /** 已挂载事件监听的叶子（避免重复挂载） */
    private attachedLeaves = new Set<WorkspaceLeaf>();
    /** 重建索引的防抖定时器 */
    private rebuildTimer: number | null = null;

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

        // 笔记修改（批注写入、删除等）→ 防抖重建索引并刷新
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('changed', () => this.scheduleRebuild())
        );
        this.ctx.plugin.registerEvent(
            app.metadataCache.on('deleted', () => this.scheduleRebuild())
        );
        this.ctx.plugin.registerEvent(
            app.vault.on('rename', () => this.scheduleRebuild())
        );

        // 插件加载时对已打开的 PDF 视图立即挂载
        this.attachToPdfLeaves();
        // 已打开视图的页面可能已渲染完毕（textlayerrendered 不再触发），主动重建索引并渲染
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
     *  - explicitSelections 为刚批注写入的选区，直接并入索引（笔记可能尚未落盘，规避写入延迟，实现即时高亮）
     *  - 最后重渲染所有已打开该 PDF 的视图
     */
    refresh(pdfFile: TFile, explicitSelections?: SavedSelectionInfo[]): void {
        const pdfPath = pdfFile.path;
        this.rebuildIndex(pdfPath).then(() => {
            if (explicitSelections && explicitSelections.length > 0) {
                const index = this.getOrCreateIndex(pdfPath);
                for (const sel of explicitSelections) {
                    if (sel.page === null) continue;
                    const selections = index.get(sel.page) ?? new Set<string>();
                    selections.add(this.selectionId(sel));
                    index.set(sel.page, selections);
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

    private getOrCreateIndex(pdfPath: string): PdfHighlightIndex {
        let index = this.indexCache.get(pdfPath);
        if (!index) {
            index = new Map<number, Set<SelectionId>>();
            this.indexCache.set(pdfPath, index);
        }
        return index;
    }

    /**
     * 重建单个 PDF 的索引。
     * 注意：Obsidian 的 metadataCache 不记录指向 PDF 的正文链接（cache.links 为空，getBacklinksForFile
     * 也不返回），因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再直接读取笔记原文提取 selection 链接。
     */
    private async rebuildIndex(pdfPath: string): Promise<void> {
        const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
        if (!(pdfFile instanceof TFile)) return;

        const newIndex = new Map<number, Set<SelectionId>>();
        const app = this.ctx.plugin.app;

        for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
            if (!links[pdfPath]) continue;
            const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;
            try {
                // 优先取打开的编辑器缓冲（批注写入后可能尚未落盘），避免刚批注的高亮因磁盘滞后丢失
                const content = await this.readNoteContent(sourceFile);
                this.extractLinksFromContent(content, pdfFile, sourcePath, newIndex);
            } catch (e) {
                console.warn('[PdfHighlight] 读取笔记失败:', sourcePath, e);
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

    /** 从笔记原文中提取指向指定 PDF 的 selection 链接并写入索引 */
    private extractLinksFromContent(
        content: string, pdfFile: TFile, sourcePath: string, index: PdfHighlightIndex
    ): void {
        const app = this.ctx.plugin.app;
        // 匹配 [[...pdf#page=N&selection=bi,bo,ei,eo]] 与 ![[...]] 嵌入，路径部分不含别名（到 # 或 | 为止）
        const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&selection=([\d,\s-]+)/g;
        let m: RegExpExecArray | null;
        while ((m = linkRegex.exec(content)) !== null) {
            const linkpath = m[1].trim();
            const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
            if (target !== pdfFile) continue;

            const page = parseInt(m[2], 10);
            const parts = m[3].split(',').map((s) => parseInt(s.trim(), 10));
            if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p))) continue;

            const selections = index.get(page) ?? new Set<string>();
            selections.add(`${parts[0]},${parts[1]},${parts[2]},${parts[3]}`);
            index.set(page, selections);
        }
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

    private selectionId(sel: SavedSelectionInfo): string {
        return `${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
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
            const onTextLayerRendered = (data: any) => {
                const pdfFile = (leaf.view as FileView).file;
                if (!pdfFile) return;
                this.renderPageHighlights(pdfFile.path, data?.source);
            };
            eventBus.on('textlayerrendered', onTextLayerRendered);
            this.ctx.plugin.register(() => {
                eventBus.off('textlayerrendered', onTextLayerRendered);
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

    /** 渲染单页的高亮覆盖层（textlayerrendered 时调用，缩放/翻页会重发事件 → 自动重建） */
    private renderPageHighlights(pdfPath: string, pageView: any): void {
        if (!pageView?.div) return;
        const pageNumber = parseInt(pageView.div.dataset.pageNumber, 10) || 0;
        const index = this.indexCache.get(pdfPath);
        const selections = index?.get(pageNumber);

        // 移除旧高亮层（文本层重渲染时 div 结构已重建，这里防御性清理）
        pageView.div.querySelector('.pdf-reader-highlight-layer')?.remove();
        if (!selections || selections.size === 0) return;

        const textLayerBuilder = pageView.textLayer;
        const textLayer = textLayerBuilder?.textLayer;
        if (!textLayer) return;

        const textDivs: HTMLElement[] = textLayer.textDivs ?? [];
        const textContentItems: any[] = textLayer.textContentItems ?? [];
        if (textDivs.length === 0) return;

        // 首个文本节点的 data-idx 可能非 0，批注索引是相对值，需换算回数组下标
        const firstIdx = parseInt(textDivs[0].getAttribute('data-idx') || '0', 10) || 0;

        const layerEl = this.getOrCreateHighlightLayer(pageView);
        for (const selectionStr of selections) {
            const [bi, bo, ei, eo] = selectionStr.split(',').map((s) => parseInt(s, 10));
            if (Number.isNaN(bi) || Number.isNaN(bo) || Number.isNaN(ei) || Number.isNaN(eo)) continue;

            const rects = this.computeMergedHighlightRects(
                textContentItems, textDivs,
                bi + firstIdx, bo, ei + firstIdx, eo
            );
            for (const rect of rects) {
                this.placeRectInPage(rect, pageView, layerEl);
            }
        }
    }

    private getOrCreateHighlightLayer(pageView: any): HTMLElement {
        const pageDiv = pageView.div as HTMLElement;
        const existing = pageDiv.querySelector<HTMLElement>('.pdf-reader-highlight-layer');
        if (existing) return existing;

        const layerEl = pageDiv.createDiv('pdf-reader-highlight-layer');
        layerEl.setAttr('data-main-rotation', String(pageView.viewport?.rotation ?? 0));

        const pdfjsLib: any = (window as any).pdfjsLib;
        if (pdfjsLib?.setLayerDimensions && pageView.viewport) {
            try {
                pdfjsLib.setLayerDimensions(layerEl, pageView.viewport);
                return layerEl;
            } catch (e) {
                console.warn('[PdfHighlight] setLayerDimensions 失败，回退为百分比定位:', e);
            }
        }
        layerEl.setCssStyles({ width: '100%', height: '100%' });
        return layerEl;
    }

    /**
     * 计算选区覆盖的矩形列表（PDF 坐标，Y 轴向上）。
     * 优先使用文本项的逐字符包围盒（chars），缺失时回退文本层 DOM Range 计算。
     * 同行相邻项合并为一个矩形。
     */
    private computeMergedHighlightRects(
        items: any[], textDivs: HTMLElement[],
        beginIndex: number, beginOffset: number, endIndex: number, endOffset: number
    ): number[][] {
        const results: number[][] = [];
        let merged: number[] | null = null;

        // 选区结束于某项起点时，回退到上一项的末尾
        if (endOffset === 0 && endIndex > beginIndex) {
            endIndex--;
            endOffset = items[endIndex]?.str?.length ?? 0;
        }

        for (let i = Math.max(0, beginIndex); i <= Math.min(endIndex, items.length - 1); i++) {
            const item = items[i];
            const textDiv = textDivs[i];
            if (!item?.str) continue;

            const rect = this.computeRectForItem(item, textDiv, i, beginIndex, beginOffset, endIndex, endOffset);
            if (!rect) continue;

            if (!merged) {
                merged = rect;
            } else if (this.areRectsMergeable(merged, rect)) {
                merged = this.mergeRects(merged, rect);
            } else {
                results.push(merged);
                merged = rect;
            }
        }
        if (merged) results.push(merged);
        return results;
    }

    private computeRectForItem(
        item: any, textDiv: HTMLElement, index: number,
        beginIndex: number, beginOffset: number, endIndex: number, endOffset: number
    ): number[] | null {
        // 逐字符路径：item.chars 的 r 为 [x0, y0, x1, y1]（PDF 坐标）
        const chars: any[] = item.chars;
        if (chars && chars.length >= item.str.length) {
            // str 已 trim，chars 可能带首尾空白字符，先对齐
            const firstCharIdx = chars.findIndex((c) => c?.c === item.str.charAt(0));
            const lastCharIdx = chars.findLastIndex((c) => c?.c === item.str.charAt(item.str.length - 1));
            if (firstCharIdx < 0 || lastCharIdx < 0) return null;
            const trimmed = chars.slice(firstCharIdx, lastCharIdx + 1);

            const from = index === beginIndex ? beginOffset : 0;
            const to = (index === endIndex ? Math.min(endOffset, trimmed.length) : trimmed.length) - 1;
            if (from > trimmed.length - 1 || to < 0) return null;

            const cFrom = trimmed[from];
            const cTo = trimmed[to];
            return [
                Math.min(cFrom.r[0], cTo.r[0]), Math.min(cFrom.r[1], cTo.r[1]),
                Math.max(cFrom.r[2], cTo.r[2]), Math.max(cFrom.r[3], cTo.r[3]),
            ];
        }

        // 兜底：文本层 DOM Range 换算回 PDF 坐标
        if (!textDiv) return null;
        const x1 = item.transform?.[4] ?? 0;
        const y1 = item.transform?.[5] ?? 0;
        const w = item.width ?? 0;
        const h = item.height ?? 0;
        if (!w || !h) return null;

        try {
            const range = textDiv.ownerDocument.createRange();
            if (index === beginIndex && beginOffset > 0) {
                range.setStart(textDiv.firstChild ?? textDiv, Math.min(beginOffset, textDiv.textContent?.length ?? 0));
            } else {
                range.setStartBefore(textDiv);
            }
            if (index === endIndex && endOffset < (textDiv.textContent?.length ?? 0)) {
                range.setEnd(textDiv.lastChild ?? textDiv, Math.min(endOffset, textDiv.textContent?.length ?? 0));
            } else {
                range.setEndAfter(textDiv);
            }
            const rect = range.getBoundingClientRect();
            const parentRect = textDiv.getBoundingClientRect();
            return [
                x1 + ((rect.left - parentRect.left) / parentRect.width) * w,
                y1 + ((rect.bottom - parentRect.bottom) / parentRect.height) * h,
                x1 + ((rect.right - parentRect.left) / parentRect.width) * w,
                y1 + ((rect.top - parentRect.bottom) / parentRect.height) * h,
            ];
        } catch (e) {
            return null;
        }
    }

    /** 两个矩形中心 Y 接近（同一行）时视为可合并 */
    private areRectsMergeable(rect1: number[], rect2: number[]): boolean {
        const y1 = (rect1[1] + rect1[3]) / 2;
        const y2 = (rect2[1] + rect2[3]) / 2;
        const h1 = Math.abs(rect1[3] - rect1[1]);
        const h2 = Math.abs(rect2[3] - rect2[1]);
        return Math.abs(y1 - y2) < Math.max(h1, h2) * 0.5;
    }

    private mergeRects(rect1: number[], rect2: number[]): number[] {
        return [
            Math.min(rect1[0], rect2[0]),
            Math.min(rect1[1], rect2[1]),
            Math.max(rect1[2], rect2[2]),
            Math.max(rect1[3], rect2[3]),
        ];
    }

    /**
     * 将 PDF 坐标矩形放置到页面的高亮层中（百分比定位，Y 轴翻转）。
     * rect: [left, bottom, right, top]（PDF 坐标，Y 向上）
     */
    private placeRectInPage(rect: number[], pageView: any, layerEl: HTMLElement): void {
        const viewBox: number[] = pageView.pdfPage?.view;
        if (!viewBox || viewBox.length < 4) return;
        const pageX = viewBox[0];
        const pageY = viewBox[1];
        const pageWidth = viewBox[2] - viewBox[0];
        const pageHeight = viewBox[3] - viewBox[1];
        if (!pageWidth || !pageHeight) return;

        const rectEl = layerEl.createDiv('pdf-reader-selection-highlight');
        rectEl.setCssStyles({
            left: `${100 * (rect[0] - pageX) / pageWidth}%`,
            top: `${100 * (viewBox[3] - rect[3] + viewBox[1] - pageY) / pageHeight}%`,
            width: `${100 * (rect[2] - rect[0]) / pageWidth}%`,
            height: `${100 * (rect[3] - rect[1]) / pageHeight}%`,
        });
    }
}
