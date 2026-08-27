import { TFile } from 'obsidian';
import type { ModuleContext } from '../types';
import { BasePdfHighlightModule } from './HighlightBase';

/**
 * 截图批注区域持久高亮模块
 *
 * 截图批注写入笔记时链接附带 `&rect=x1,y1,x2,y2`（PDF 空间绝对坐标），
 * 本模块扫描指向该 PDF 的笔记、提取这些链接建立索引，并在 PDF 视图上
 * 渲染黄色边框高亮（内部不填充），与 OCR 矩形高亮区分。
 *
 * 关键特性：
 *  - 持久：翻页/缩放/重开 PDF 都会重新渲染（pagerendered 事件 + 索引重建）
 *  - 删除同步：笔记中删掉批注 → 300ms 防抖重建索引 → 高亮随即消失
 */

/** PDF 空间矩形 [x1, y1, x2, y2]（y 轴向上） */
export interface ScreenshotRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/** 一次刷新显式注入的高亮条目（笔记可能尚未落盘，用于批注后即时高亮） */
export interface ScreenshotHighlightEntry {
    page: number;
    rect: number[];
}

/** page → (rectKey → highlight) */
type PageHighlights = Map<string, ScreenshotRect>;
/** pdfPath → page → highlights */
type PdfScreenshotIndex = Map<number, PageHighlights>;

export class ScreenshotHighlightModule extends BasePdfHighlightModule<PdfScreenshotIndex> {
    constructor(ctx: ModuleContext) {
        super(ctx);
    }

    protected get renderEventName(): string {
        return 'pagerendered';
    }

    /**
     * 刷新指定 PDF 的截图批注高亮：
     *  - 刚批注写入的条目先记入「显式覆盖层」
     *  - 再从笔记内容重建索引
     *  - 最后重渲染所有已打开该 PDF 的视图
     */
    refresh(pdfFile: TFile, explicit?: ScreenshotHighlightEntry[]): void {
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
    protected applyExplicitEntry(index: PdfScreenshotIndex, page: number, key: string): boolean {
        const pageMap = index.get(page);
        if (pageMap?.has(key)) return true;
        const rect = parseRectKey(key);
        if (!rect) return false;
        const map = pageMap ?? new Map<string, ScreenshotRect>();
        map.set(key, rect);
        index.set(page, map);
        return false;
    }

    /**
     * 重建单个 PDF 的索引。
     * 与其它高亮模块一致：通过 resolvedLinks 反查链接到该 PDF 的笔记，
     * 再读取笔记原文提取 rect 链接。
     */
    protected async rebuildIndex(pdfPath: string): Promise<void> {
        const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(pdfPath);
        if (!(pdfFile instanceof TFile)) return;

        const newIndex: PdfScreenshotIndex = new Map();
        const app = this.ctx.plugin.app;

        for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
            if (!links[pdfPath]) continue;
            const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;
            try {
                const content = await this.readNoteContent(sourceFile);
                this.extractRectLinks(content, pdfFile, sourcePath, newIndex);
            } catch (e) {
                console.warn('[ScreenshotHighlight] 读取笔记失败:', sourcePath, e);
            }
        }

        this.indexCache.set(pdfPath, newIndex);
    }

    /** 从笔记原文中提取指向指定 PDF 的 rect 嵌入链接并写入索引 */
    private extractRectLinks(
        content: string,
        pdfFile: TFile,
        sourcePath: string,
        index: PdfScreenshotIndex
    ): void {
        const app = this.ctx.plugin.app;
        // 匹配 [[path#page=N&rect=x1,y1,x2,y2]] 与 ![[...]] 嵌入形式
        const linkRegex = /\[\[([^\]#|]+?)#page=(\d+)&rect=([\d.,\s-]+?)(?:\|[^\]]*)?\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = linkRegex.exec(content)) !== null) {
            const linkpath = m[1].trim();
            const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
            if (target !== pdfFile) continue;

            const page = parseInt(m[2], 10);
            const parts = m[3].split(',').map((s) => parseFloat(s.trim()));
            if (!Number.isInteger(page) || parts.length !== 4 || parts.some((p) => Number.isNaN(p))) continue;

            const [a, b, c, d] = parts;
            const rect: ScreenshotRect = {
                x1: Math.min(a, c),
                y1: Math.min(b, d),
                x2: Math.max(a, c),
                y2: Math.max(b, d),
            };
            const pageMap = index.get(page) ?? new Map<string, ScreenshotRect>();
            pageMap.set(rectKey([rect.x1, rect.y1, rect.x2, rect.y2]), rect);
            index.set(page, pageMap);
        }
    }

    /** 渲染单页的截图批注高亮层（pagerendered 时调用） */
    protected renderPageHighlights(pdfPath: string, pageView: any): void {
        if (!pageView?.div) return;
        const pageDiv = pageView.div as HTMLElement;
        const pageNumber = parseInt(pageDiv.dataset.pageNumber ?? '0', 10) || 0;

        const index = this.indexCache.get(pdfPath);
        const pageMap = index?.get(pageNumber);
        if (!pageMap || pageMap.size === 0) {
            pageDiv.querySelector('.pdf-screenshot-highlight-layer')?.remove();
            return;
        }

        // 需要 PDF 页面 view 才能把绝对坐标换算成百分比
        const view = pageView.pdfPage?.view as number[] | undefined;
        if (!view || view.length < 4) return;
        const [minX, minY, maxX, maxY] = view;
        const pageWidth = maxX - minX;
        const pageHeight = maxY - minY;
        if (pageWidth <= 0 || pageHeight <= 0) return;

        pageDiv.querySelector('.pdf-screenshot-highlight-layer')?.remove();
        const layerEl = pageDiv.createDiv('pdf-screenshot-highlight-layer');
        for (const h of pageMap.values()) {
            const rectEl = layerEl.createDiv('pdf-screenshot-crop-highlight');
            // 供 PdfJumpModule 识别点击目标（跳回笔记对应批注）
            rectEl.setAttr('data-pdf-jump-page', String(pageNumber));
            rectEl.setAttr('data-pdf-jump-rect', rectKey([h.x1, h.y1, h.x2, h.y2]));
            Object.assign(rectEl.style, {
                left: `${(100 * (h.x1 - minX) / pageWidth).toFixed(3)}%`,
                top: `${(100 * (maxY - h.y2) / pageHeight).toFixed(3)}%`,
                width: `${(100 * (h.x2 - h.x1) / pageWidth).toFixed(3)}%`,
                height: `${(100 * (h.y2 - h.y1) / pageHeight).toFixed(3)}%`,
            });
        }
    }
}

/** PDF 空间矩形 → 索引键 */
function rectKey(rect: number[]): string {
    return rect.map((n) => Number(n.toFixed(4))).join(',');
}

/** 索引键 → PDF 空间矩形；格式非法返回 null */
function parseRectKey(key: string): ScreenshotRect | null {
    const parts = key.split(',').map((s) => Number(s));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return null;
    const [x1, y1, x2, y2] = parts;
    return { x1, y1, x2, y2 };
}
