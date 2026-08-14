import { TFile } from 'obsidian';
import type { ModuleContext, SavedSelectionInfo } from '../types';
import { BasePdfHighlightModule } from './HighlightBase';

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

/**
 * 页面几何信息：DOM 兜底路径做「屏幕盒 → PDF 坐标」映射所需。
 * box 为页面 div 的 client 盒（getBoundingClientRect 加 clientLeft/Top 修正，
 * 与高亮层 position:absolute 的定位盒一致）；viewBox 为 PDF 空间页面范围。
 */
interface PageGeometry {
    box: { left: number; top: number; width: number; height: number };
    viewBox: number[];
}

export class PdfHighlightModule extends BasePdfHighlightModule<PdfHighlightIndex> {
    constructor(ctx: ModuleContext) {
        super(ctx);
    }

    protected get renderEventName(): string {
        return 'textlayerrendered';
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
                const index = this.getOrCreateIndex(pdfPath, () => new Map<number, Set<SelectionId>>());
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

    /**
     * 重建单个 PDF 的索引。
     * 注意：Obsidian 的 metadataCache 不记录指向 PDF 的正文链接（cache.links 为空，getBacklinksForFile
     * 也不返回），因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再直接读取笔记原文提取 selection 链接。
     */
    protected async rebuildIndex(pdfPath: string): Promise<void> {
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

    private selectionId(sel: SavedSelectionInfo): string {
        return `${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
    }

    /** 渲染单页的高亮覆盖层（textlayerrendered 时调用，缩放/翻页会重发事件 → 自动重建） */
    protected renderPageHighlights(pdfPath: string, pageView: any): void {
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

        // DOM 兜底路径的屏幕→PDF 映射几何：高亮层（absolute; top/left:0）的定位盒
        // = 页面 div 的 client 盒（content-box，与 pdf.js setLayerDimensions 的
        // calc(var(--total-scale-factor)*pageWidth) 尺寸一致）
        const pageDivRect = pageView.div.getBoundingClientRect();
        const pageGeom: PageGeometry = {
            box: {
                left: pageDivRect.left + pageView.div.clientLeft,
                top: pageDivRect.top + pageView.div.clientTop,
                width: pageView.div.clientWidth,
                height: pageView.div.clientHeight,
            },
            viewBox: pageView.pdfPage?.view ?? [0, 0, 0, 0],
        };

        const layerEl = this.getOrCreateHighlightLayer(pageView);
        for (const selectionStr of selections) {
            const [bi, bo, ei, eo] = selectionStr.split(',').map((s) => parseInt(s, 10));
            if (Number.isNaN(bi) || Number.isNaN(bo) || Number.isNaN(ei) || Number.isNaN(eo)) continue;

            const rects = this.computeMergedHighlightRects(
                textContentItems, textDivs,
                bi + firstIdx, bo, ei + firstIdx, eo,
                pageGeom
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
     * 优先使用文本项的逐字符包围盒（chars），缺失时回退文本层 div 的屏幕视觉盒。
     * 同行相邻项合并为一个矩形。
     */
    private computeMergedHighlightRects(
        items: any[], textDivs: HTMLElement[],
        beginIndex: number, beginOffset: number, endIndex: number, endOffset: number,
        pageGeom: PageGeometry
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

            const rect = this.computeRectForItem(item, textDiv, i, beginIndex, beginOffset, endIndex, endOffset, pageGeom);
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
        beginIndex: number, beginOffset: number, endIndex: number, endOffset: number,
        pageGeom: PageGeometry
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

        // 兜底：文本层 div 的屏幕视觉盒（getBoundingClientRect 含 scale/rotate 等 CSS
        // 变换）按页面 client 盒比例映射回 PDF 坐标。
        // 不能用 item.transform/width/height 拼盒：transform[5] 是文本基线而 height
        // 是字号，真实文本占据 [基线-descent, 基线+ascent]；且 pdf.js 文本 div 带
        // 行高补偿 scale(1/Xa) 变换，视觉宽度 ≈ 0.83×item.width。用 item 盒会整体
        // 偏下且偏宽（无 chars 的 PDF 全部命中此路径）。
        if (!textDiv) return null;
        const pr = textDiv.getBoundingClientRect();
        if (!pr.width || !pr.height) return null;

        // X 方向子选区用 DOM Range 的真实视觉盒（更精确）；整 div 时即 div 盒本身
        let sx0 = pr.left, sx1 = pr.right;
        const divLen = textDiv.textContent?.length ?? 0;
        if ((index === beginIndex && beginOffset > 0) || (index === endIndex && endOffset < divLen)) {
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
                // Range 计算失败时退回整 div 盒
            }
        }

        const [pageX, pageY, pageMaxX, pageMaxY] = pageGeom.viewBox;
        const pageWidth = pageMaxX - pageX;
        const pageHeight = pageMaxY - pageY;
        const { left: boxLeft, top: boxTop, width: boxW, height: boxH } = pageGeom.box;
        if (!pageWidth || !pageHeight || !boxW || !boxH) return null;

        return [
            pageX + ((sx0 - boxLeft) / boxW) * pageWidth,
            pageY + pageHeight - ((pr.bottom - boxTop) / boxH) * pageHeight,
            pageX + ((sx1 - boxLeft) / boxW) * pageWidth,
            pageY + pageHeight - ((pr.top - boxTop) / boxH) * pageHeight,
        ];
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
            // 防御：任何路径产生反向/非法矩形时钳制为非负，避免 CSS 负高度
            // 被丢弃后高亮塌缩成细线
            width: `${Math.max(0, 100 * (rect[2] - rect[0]) / pageWidth)}%`,
            height: `${Math.max(0, 100 * (rect[3] - rect[1]) / pageHeight)}%`,
        });
    }
}
