import { TFile, Notice, WorkspaceLeaf, FileView } from 'obsidian';
import type { ModuleContext } from '../types';
import { OcrService } from './OcrService';
import type { OcrHighlightEntry, OcrRect } from './OcrHighlightModule';
import type { PdfReaderModule } from './PdfReaderModule';
import { BaseCropModeModule } from './BaseCropModeModule';

/**
 * 截图 OCR 批注模块
 *
 * 流程：PDF 工具条「截图 OCR 批注」按钮 → 进入截图模式（crosshair 光标，不遮挡视图）
 *      → 在页面上拖拽框选区域 → 从 pdfjs 已渲染页面的 canvas 截取图像
 *      → LM Studio 视觉模型识别文字 → 复用 pdf-reader 插件的批注入口写入阅读笔记
 *
 * 框选交互继承 BaseCropModeModule（与截图批注共享），本类只负责：
 *  - 框选完成后：截取 canvas（优先）/ 兜底整页渲染 → OCR → 写入批注 → 即时高亮
 *
 * 与「选中文字批注」互补：扫描版/无文本层的 PDF 也能框选关键段落批注到笔记。
 *
 * 放大目标短边（ocrMinSidePx）与放大倍率上限（ocrMaxUpscaleFactor）来自设置，
 * 每次框选实时读取，修改设置后立即生效；输出清洗开关由 OcrService 使用。
 */

/** 截图放大选项（供本文件内的裁剪工具函数使用） */
interface CropUpscaleOptions {
    /** 小区域放大的目标短边像素；0 = 关闭放大 */
    minSidePx: number;
    /** 放大倍率上限 */
    maxScale: number;
}

export class OcrModule extends BaseCropModeModule {
    private pdfModule: PdfReaderModule;
    private service: OcrService;

    protected readonly buttonClass = 'ocr-toolbar-button';
    protected readonly selectingClass = 'ocr-selecting';
    protected readonly boxClass = 'ocr-crop-box';
    protected readonly buttonIcon = 'crop';
    protected readonly buttonTooltip = '截图 OCR 批注到笔记';
    protected readonly commandId = 'ocr-screenshot-annotate';
    protected readonly commandName = '截图 OCR 批注到笔记';

    /** 高亮模块刷新回调（批注成功后触发即时高亮），由 main.ts 注入 */
    private refreshHighlights: ((file: TFile, entries: OcrHighlightEntry[]) => void) | null = null;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        super(ctx);
        this.pdfModule = pdfModule;
        // 从设置初始化服务器地址和 API Key
        this.service = new OcrService(this.ctx.getSettings().ocrServerUrl, this.ctx.getSettings().ocrApiKey);
    }

    setHighlightRefresh(cb: (file: TFile, entries: OcrHighlightEntry[]) => void): void {
        this.refreshHighlights = cb;
    }

    // ========== 框选完成 → 截图 OCR 批注 ==========

    protected async onCropComplete(
        leaf: WorkspaceLeaf | null,
        pageDiv: HTMLElement,
        pageRect: { x: number; y: number; width: number; height: number }
    ): Promise<void> {
        // 外层兜底：基类 void 调用本方法，任何未捕获异常都会成为
        // unhandled rejection 且用户无感知，统一转为 Notice
        try {
            await this.doCaptureAndAnnotate(leaf, pageDiv, pageRect);
        } catch (e) {
            console.error('[Ocr] 截图批注失败:', e);
            new Notice(`截图批注失败: ${(e as Error).message}`);
        }
    }

    private async doCaptureAndAnnotate(
        leaf: WorkspaceLeaf | null,
        pageDiv: HTMLElement,
        pageRect: { x: number; y: number; width: number; height: number }
    ): Promise<void> {
        if (!leaf) return;
        const pageNum = parseInt(pageDiv.dataset?.pageNumber ?? '0', 10) || 0;
        if (pageNum <= 0) {
            new Notice('无法确定截图页码');
            return;
        }

        // 归一化矩形（0-1，相对页面尺寸）：在任意 await 之前同步计算，避免页面缩放导致偏移。
        // pageRect 为边框外缘相对坐标，而高亮层填充内边距框，需换算到内边距框坐标系。
        // 写入批注链接 &ocr= 参数，供高亮模块持久渲染
        const bl = pageDiv.clientLeft;
        const bt = pageDiv.clientTop;
        const pw = pageDiv.clientWidth;
        const ph = pageDiv.clientHeight;
        const ocrRect: OcrRect | null = (pw > 0 && ph > 0)
            ? {
                x: clamp01((pageRect.x - bl) / pw),
                y: clamp01((pageRect.y - bt) / ph),
                w: clamp01(pageRect.width / pw),
                h: clamp01(pageRect.height / ph),
            }
            : null;

        let imageDataUrl: string | null = null;

        // 1) 优先用 pdfjs 已渲染 canvas（与显示一致，零额外渲染开销）
        //    裁剪可能抛错（如截图越界），失败时降级走兜底整页渲染，不中断流程
        const cropOpts = this.cropOptions();
        const canvas = pageDiv.querySelector('canvas') as HTMLCanvasElement | null;
        if (canvas && canvas.width > 0 && canvas.height > 0) {
            try {
                imageDataUrl = cropFromCanvas(canvas, pageRect, pageDiv, cropOpts);
            } catch (e) {
                console.warn('[Ocr] 画布裁剪失败，尝试兜底渲染:', e);
            }
        }

        // 2) 兜底：整页重新渲染后再裁剪
        if (!imageDataUrl) {
            try {
                const proxy = this.getPdfDocumentProxy(leaf);
                if (!proxy) throw new Error('无法获取 PDF 文档代理');
                imageDataUrl = await this.renderCropFallback(proxy, pageNum, pageRect, pageDiv, cropOpts);
            } catch (e) {
                console.warn('[Ocr] 截图兜底渲染失败:', e);
                new Notice('页面尚未渲染，请滚动视图后重试');
                return;
            }
        }
        if (!imageDataUrl) return;

        const ok = await this.ocrAndAnnotate(leaf, imageDataUrl, pageNum, ocrRect);
        // 批注成功后触发高亮模块即时渲染（笔记已写入 &ocr= 链接，删除批注后会同步消失）
        if (ok && ocrRect) {
            const file = (leaf.view as FileView).file;
            if (file) {
                this.refreshHighlights?.(file, [{ page: pageNum, rect: ocrRect }]);
            }
        }
    }

    /** 兼容不同 Obsidian/pdfjs 内部结构，多路径获取 PDFDocumentProxy */
    private getPdfDocumentProxy(leaf: WorkspaceLeaf): any {
        const v: any = (leaf.view as any).viewer;
        return v?.child?.pdfViewer?.pdfDocument
            ?? v?.child?.pdfDocument
            ?? v?.pdfDocument
            ?? null;
    }

    // ========== OCR + 批注 ==========

    private async ocrAndAnnotate(
        leaf: WorkspaceLeaf,
        imageDataUrl: string,
        pageNum: number,
        ocrRect: OcrRect | null
    ): Promise<boolean> {
        const file = (leaf.view as FileView).file;
        if (!file) {
            new Notice('无法识别当前 PDF 文件');
            return false;
        }
        const settings = this.ctx.getSettings();
        // 每次请求前同步最新服务器地址和 API Key，确保设置面板修改后立即生效
        this.service.setBaseUrl(settings.ocrServerUrl);
        this.service.setApiKey(settings.ocrApiKey);
        // 输出清洗开关：关闭时保留模型原始输出（如 LaTeX 命令、markdown 结构）
        this.service.setSanitizeOutput(settings.ocrSanitizeOutput !== false);

        let model: string;
        try {
            model = await this.service.resolveModel(settings.ocrModel);
        } catch (e) {
            new Notice(`选择 OCR 模型失败: ${(e as Error).message}`);
            return false;
        }

        const notice = new Notice('OCR 识别中…', 0);
        try {
            const { text } = await this.service.ocrText(
                imageDataUrl, model, settings.ocrPrompt,
                settings.ocrRequestTimeoutSec, settings.ocrMaxTokens
            );
            notice.hide();
            if (!text.trim()) {
                new Notice('未识别到文字，请调整框选区域后重试');
                return false;
            }

            // 复用 PDF 阅读模块的批注流程写入阅读笔记（附带归一化矩形，写入 &ocr= 链接）
            const ok = await this.pdfModule.annotateOcrText(file, text, pageNum, ocrRect ?? undefined);
            if (ok) {
                new Notice('OCR 批注已写入笔记');
            }
            return ok;
        } catch (e) {
            notice.hide();
            new Notice(`OCR 失败: ${(e as Error).message}`);
            return false;
        }
    }

    /** 从设置读取截图放大参数（非法值回退默认；minSidePx<=0 表示关闭放大） */
    private cropOptions(): CropUpscaleOptions {
        const s = this.ctx.getSettings();
        const minSidePx = Math.max(0, Math.floor(Number(s.ocrMinSidePx) || 0));
        const maxScale = Math.min(8, Math.max(1, Number(s.ocrMaxUpscaleFactor) || 4));
        return { minSidePx, maxScale };
    }

    // ========== 兜底整页渲染（canvas 缺失时） ==========

    private async renderCropFallback(
        proxy: any,
        pageNum: number,
        pageRect: { x: number; y: number; width: number; height: number },
        pageDiv?: HTMLElement,
        cropOpts: CropUpscaleOptions = { minSidePx: 512, maxScale: 4 }
    ): Promise<string> {
        const page = await proxy.getPage(pageNum);
        // 按屏幕显示尺寸渲染（无 canvas 可参考，取 2x 保证清晰）
        const scale = 2;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建画布');
        await page.render({ canvasContext: ctx, viewport, background: 'white' }).promise;

        // 用页面 div 的显示矩形换算裁剪坐标
        // （无页面 div 时退化为整页）
        if (!pageDiv) {
            return canvas.toDataURL('image/jpeg', 0.92);
        }
        const pr = pageDiv.getBoundingClientRect();
        const dpr = canvas.width / pr.width;
        const sx = pageRect.x * dpr;
        const sy = pageRect.y * dpr;
        const sw = pageRect.width * dpr;
        const sh = pageRect.height * dpr;
        return cropCanvasRegion(canvas, sx, sy, sw, sh, cropOpts);
    }
}

/**
 * 从页面 canvas 截取「页面内坐标」矩形区域。
 * 页面内坐标相对 pageDiv 左上角，与滚动/缩放无关；
 * 换算 canvas 像素时减去 canvas 相对页面的偏移（页面 div 可能有边框/内边距）
 */
function cropFromCanvas(
    canvas: HTMLCanvasElement,
    pageRect: { x: number; y: number; width: number; height: number },
    pageDiv: HTMLElement,
    cropOpts: CropUpscaleOptions
): string {
    const canvasRect = canvas.getBoundingClientRect();
    const pr = pageDiv.getBoundingClientRect();
    const dprX = canvas.width / canvasRect.width;
    const dprY = canvas.height / canvasRect.height;
    const sx = (pageRect.x - (canvasRect.left - pr.left)) * dprX;
    const sy = (pageRect.y - (canvasRect.top - pr.top)) * dprY;
    const sw = pageRect.width * dprX;
    const sh = pageRect.height * dprY;
    return cropCanvasRegion(canvas, sx, sy, sw, sh, cropOpts);
}

/** 离屏 canvas 裁剪源图区域；小区域按设置等比放大提升 OCR 清晰度 */
function cropCanvasRegion(
    source: HTMLCanvasElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    cropOpts: CropUpscaleOptions
): string {
    // 裁剪边界夹取到源图内
    const cx = Math.max(0, sx);
    const cy = Math.max(0, sy);
    const cw = Math.min(sw, source.width - cx);
    const ch = Math.min(sh, source.height - cy);
    if (cw < 1 || ch < 1) throw new Error('截图区域超出页面范围');

    // 区域短边不足目标像素时等比放大（minSidePx<=0 = 关闭放大），倍率受上限约束
    let scale = 1;
    if (cropOpts.minSidePx > 0) {
        const minSide = Math.min(cw, ch);
        scale = Math.min(
            Math.max(1, cropOpts.maxScale),
            Math.max(1, cropOpts.minSidePx / minSide)
        );
    }

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale));
    out.height = Math.max(1, Math.round(ch * scale));
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('无法创建截图画布');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, cx, cy, cw, ch, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.92);
}

/** 把归一化坐标夹取到 [0, 1] 区间 */
function clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}
