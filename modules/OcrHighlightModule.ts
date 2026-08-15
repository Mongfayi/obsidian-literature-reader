import { TFile } from 'obsidian';
import type { ModuleContext } from '../types';
import { BasePdfHighlightModule } from './HighlightBase';

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

export class OcrHighlightModule extends BasePdfHighlightModule<PdfOcrIndex> {
    constructor(ctx: ModuleContext) {
        super(ctx);
    }

    protected get renderEventName(): string {
        return 'pagerendered';
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
                const index = this.getOrCreateIndex(pdfPath, () => new Map<number, PageHighlights>());
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

    /**
     * 重建单个 PDF 的索引。
     * 与 PdfHighlightModule 同：metadataCache 不记录指向 PDF 的正文链接，
     * 因此通过 resolvedLinks 反查链接到该 PDF 的笔记，再读取笔记原文提取 ocr 链接。
     */
    protected async rebuildIndex(pdfPath: string): Promise<void> {
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

    /** 渲染单页的高亮层（pagerendered 时调用，缩放/翻页会重发事件 → 自动重建） */
    protected renderPageHighlights(pdfPath: string, pageView: any): void {
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
            // data-pdf-jump-* 属性供 PdfJumpModule 识别点击目标（跳回笔记对应批注）
            rectEl.setAttr('data-pdf-jump-page', String(pageNumber));
            rectEl.setAttr('data-pdf-jump-ocr', rectKey({ x: h.nx, y: h.ny, w: h.nw, h: h.nh }));
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
