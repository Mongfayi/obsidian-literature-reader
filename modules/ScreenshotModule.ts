import { TFile, Notice, WorkspaceLeaf, FileView, Component } from 'obsidian';
import type { ModuleContext } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';
import { BaseCropModeModule } from './BaseCropModeModule';

/**
 * 截图批注模块
 *
 * 流程：PDF 工具条「截图批注」按钮 → 进入截图模式（crosshair 光标，不遮挡视图）
 *      → 在页面上拖拽框选区域 → 屏幕坐标转为 PDF 坐标
 *      → 在阅读笔记中插入嵌入链接 ![[file.pdf#page=N&rect=...]]（不产生图片文件）
 *      → 自定义 EmbedCreator 用 pdfjs 实时渲染裁剪区域
 *
 * 框选交互继承 BaseCropModeModule（与 OCR 批注共享），本类只负责：
 *  - 注册/恢复自定义 PDF EmbedCreator（rect 参数渲染裁剪区域）
 *  - 框选完成后：屏幕坐标 → PDF 坐标 → 写入批注
 *
 * 注：PDF 裁剪嵌入的思路（EmbedCreator + pdfjs 渲染 rect 区域）受 pdf-plus 插件启发，
 */

export class ScreenshotModule extends BaseCropModeModule {
    private pdfModule: PdfReaderModule;

    /** 原始 PDF EmbedCreator（注册自定义裁剪嵌入前保存，卸载时恢复） */
    private originalPdfEmbedCreator: any = null;
    /** 本插件注册的包装创建器（用于卸载时校验注册表归属，避免覆盖其他插件） */
    private wrappedPdfEmbedCreator: any = null;

    protected readonly buttonClass = 'pdfreader-screenshot-button';
    protected readonly selectingClass = 'pdf-screenshot-selecting';
    protected readonly boxClass = 'pdf-screenshot-box';
    protected readonly buttonIcon = 'image-plus';
    protected readonly buttonTooltip = '截图批注到笔记';
    protected readonly commandId = 'screenshot-annotate';
    protected readonly commandName = '截图批注到笔记';

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        super(ctx);
        this.pdfModule = pdfModule;
    }

    load(): void {
        super.load();
        this.registerCropEmbedCreator();
    }

    unload(): void {
        super.unload();
        this.restoreCropEmbedCreator();
        pdfDocCache.clear();
    }

    // ========== 框选完成 → 截图批注 ==========

    protected async onCropComplete(
        leaf: WorkspaceLeaf | null,
        pageDiv: HTMLElement,
        pageRect: { x: number; y: number; width: number; height: number }
    ): Promise<void> {
        // 外层兜底：基类 void 调用本方法，任何未捕获异常都会成为
        // unhandled rejection 且用户无感知，统一转为 Notice
        try {
            await this.doCaptureScreenshot(leaf, pageDiv, pageRect);
        } catch (e) {
            console.error('[Screenshot] 截图批注失败:', e);
            new Notice(`截图批注失败: ${(e as Error).message}`);
        }
    }

    private async doCaptureScreenshot(
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

        const file = (leaf.view as FileView).file;
        if (!file) {
            new Notice('无法识别当前 PDF 文件');
            return;
        }

        // 屏幕坐标 → PDF 空间坐标（供嵌入链接 &rect= 参数使用）
        // 依赖 Obsidian 内部结构（viewer.child.getPage、window.pdfjsLib），
        // 结构变动/缺失时可能抛错，单独捕获并提示，不产生未处理 rejection
        let rect: number[] | null = null;
        try {
            rect = this.screenToPdfRect(leaf, pageDiv, pageRect);
        } catch (e) {
            console.warn('[Screenshot] 坐标转换失败:', e);
        }
        if (!rect) {
            new Notice('坐标转换失败，无法生成截图嵌入');
            return;
        }

        const notice = new Notice('正在写入截图批注…', 0);
        try {
            const ok = await this.pdfModule.annotateScreenshot(file, pageNum, rect);
            notice.hide();
            if (ok) new Notice('截图批注已写入笔记');
        } catch (e) {
            notice.hide();
            new Notice(`截图批注失败: ${(e as Error).message}`);
        }
    }

    /**
     * 屏幕坐标（pageDiv 边框框相对）→ PDF 空间坐标 [x1, y1, x2, y2]。
     * 使用 pdfjs pageView.getPagePoint 进行视口→PDF 坐标转换，
     * 与 pdf-plus 的矩形选择实现一致。
     */
    private screenToPdfRect(
        leaf: WorkspaceLeaf,
        pageDiv: HTMLElement,
        pageRect: { x: number; y: number; width: number; height: number }
    ): number[] | null {
        const child = (leaf.view as any).viewer?.child;
        const pageNum = parseInt(pageDiv.dataset?.pageNumber ?? '0', 10);
        const pageView = child?.getPage?.(pageNum);
        if (!pageView?.getPagePoint) return null;

        // pageRect 相对边框框；需转到内容框（减去 border + padding），
        // getPagePoint 接收内容框（canvas 区域）相对坐标
        const style = getComputedStyle(pageDiv);
        const bl = parseFloat(style.borderLeftWidth) || 0;
        const bt = parseFloat(style.borderTopWidth) || 0;
        const pl = parseFloat(style.paddingLeft) || 0;
        const pt = parseFloat(style.paddingTop) || 0;
        const left = pageRect.x - bl - pl;
        const top = pageRect.y - bt - pt;
        const right = left + pageRect.width;
        const bottom = top + pageRect.height;

        // getPagePoint(x, y) 接收视口坐标，返回 PDF 坐标 [pdfX, pdfY]
        // PDF 坐标 y 轴向上：左下角 (left, bottom) → 右上角 (right, top)
        const pdfjsLib = (window as any).pdfjsLib;
        const rect = pdfjsLib.Util.normalizeRect([
            ...pageView.getPagePoint(left, bottom),
            ...pageView.getPagePoint(right, top),
        ]);
        return rect.map((n: number) => Math.round(n));
    }

    // ========== 自定义 PDF 嵌入创建器（rect 参数渲染裁剪区域） ==========

    /**
     * 注册自定义 PDF EmbedCreator：当嵌入链接含 rect 参数时，用 pdfjs 实时渲染裁剪区域，
     * 不产生图片文件。无 rect 参数时回退到原始创建器。
     */
    private registerCropEmbedCreator(): void {
        const app = this.ctx.plugin.app as any;
        // embedRegistry 为未公开内部 API：缺失/结构变化时降级跳过裁剪嵌入注册，
        // 不影响其余功能（框选照常写入链接，仅嵌入渲染不可用）
        try {
            this.originalPdfEmbedCreator = app.embedRegistry?.embedByExtension?.['pdf'];
        } catch (e) {
            console.warn('[Screenshot] embedRegistry 不可用，跳过裁剪嵌入注册:', e);
            return;
        }
        if (!this.originalPdfEmbedCreator) {
            console.warn('[Screenshot] 未找到内置 PDF 嵌入创建器，跳过裁剪嵌入注册');
            return;
        }
        this.wrappedPdfEmbedCreator = (ctx: any, file: TFile, subpath: string) => {
            const params = new URLSearchParams(subpath.startsWith('#') ? subpath.slice(1) : subpath);
            if (params.has('rect') && params.has('page')) {
                const pageNumber = parseInt(params.get('page')!);
                const rect = params.get('rect')!.split(',').map((n) => parseFloat(n));
                if (Number.isInteger(pageNumber) && rect.length === 4 && rect.every((n) => !isNaN(n))) {
                    return new CropEmbed(ctx, file, pageNumber, rect);
                }
            }
            return this.originalPdfEmbedCreator
                ? this.originalPdfEmbedCreator(ctx, file, subpath)
                : null;
        };
        app.embedRegistry.unregisterExtension('pdf');
        app.embedRegistry.registerExtension('pdf', this.wrappedPdfEmbedCreator);
    }

    /** 恢复原始 PDF EmbedCreator；仅当注册表中仍为本插件包装器时恢复，避免覆盖其他插件 */
    private restoreCropEmbedCreator(): void {
        const app = this.ctx.plugin.app as any;
        if (!this.originalPdfEmbedCreator) return;
        // 其他插件可能在之后注册了自己的 pdf 嵌入创建器，此时放弃恢复，保留对方的注册
        if (app.embedRegistry.embedByExtension['pdf'] !== this.wrappedPdfEmbedCreator) {
            this.originalPdfEmbedCreator = null;
            this.wrappedPdfEmbedCreator = null;
            return;
        }
        app.embedRegistry.unregisterExtension('pdf');
        app.embedRegistry.registerExtension('pdf', this.originalPdfEmbedCreator);
        this.originalPdfEmbedCreator = null;
        this.wrappedPdfEmbedCreator = null;
    }
}

/**
 * PDF 裁剪区域嵌入组件。
 *
 * 接收 PDF 文件、页码和 PDF 空间矩形 [x1,y1,x2,y2]，
 * 异步加载文档并渲染对应区域的图像到容器元素中。
 * 嵌入链接格式：![[file.pdf#page=N&rect=x1,y1,x2,y2]]
 */
class CropEmbed extends Component {
    app: import('obsidian').App;
    containerEl: HTMLElement;

    constructor(
        ctx: any,
        private file: TFile,
        private pageNumber: number,
        private pdfRect: number[]
    ) {
        super();
        this.app = ctx.app;
        this.containerEl = ctx.containerEl;
        this.containerEl.addClass('pdf-crop-embed');
    }

    async loadFile(): Promise<void> {
        this.showStatus('加载中…');
        try {
            const dataUrl = await this.renderCropRegion();
            this.containerEl.empty();
            this.containerEl.createEl('img', { attr: { src: dataUrl } });
        } catch (e) {
            console.error('[Screenshot] PDF 裁剪嵌入渲染失败:', e);
            this.showError();
        }
    }

    private showStatus(text: string): void {
        this.containerEl.empty();
        this.containerEl.createEl('div', { text, cls: 'pdf-crop-embed-loading' });
    }

    private showError(): void {
        this.containerEl.empty();
        this.containerEl.createEl('div', { text: 'PDF 截图加载失败', cls: 'pdf-crop-embed-error' });
    }

    /** 加载 PDF → 渲染整页 → 裁剪目标区域 → 返回 PNG dataURL */
    private async renderCropRegion(): Promise<string> {
        // 复用文档缓存，避免同一 PDF 被多个裁剪嵌入重复加载
        const doc = await pdfDocCache.get(this.file, this.app);
        const pdfjs = (window as any).pdfjsLib;
        const page = await doc.getPage(this.pageNumber);
        const fullCanvas = await this.renderFullPage(page, pdfjs);
        return this.cropToRect(fullCanvas, page, pdfjs);
    }

    /** 以 2x 缩放渲染整页到离屏 canvas */
    private async renderFullPage(page: any, _pdfjs: any): Promise<HTMLCanvasElement> {
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas;
    }

    /** 从整页 canvas 中裁剪 PDF 空间矩形对应的像素区域 */
    private cropToRect(source: HTMLCanvasElement, page: any, _pdfjs: any): string {
        // page.view = [minX, minY, maxX, maxY]（PDF 空间，y 轴向上）
        const [minX, minY, maxX, maxY] = page.view;
        const pageWidth = maxX - minX;
        const pageHeight = maxY - minY;
        const ratioX = source.width / pageWidth;
        const ratioY = source.height / pageHeight;

        // pdfRect = [x1, y1, x2, y2]（y1 < y2，PDF 空间）
        // canvas 原点在左上角，需翻转 y 轴
        const srcLeft = (this.pdfRect[0] - minX) * ratioX;
        const srcTop = (maxY - this.pdfRect[3]) * ratioY;
        const srcWidth = (this.pdfRect[2] - this.pdfRect[0]) * ratioX;
        const srcHeight = (this.pdfRect[3] - this.pdfRect[1]) * ratioY;

        const result = document.createElement('canvas');
        result.width = Math.max(1, Math.round(srcWidth));
        result.height = Math.max(1, Math.round(srcHeight));
        const ctx = result.getContext('2d')!;
        ctx.drawImage(source, srcLeft, srcTop, srcWidth, srcHeight, 0, 0, result.width, result.height);
        return result.toDataURL('image/png');
    }
}

/**
 * PDF 文档缓存（LRU + TTL 淘汰）
 *
 * 同一 PDF 的多个裁剪嵌入共享一个 PDFDocumentProxy，避免重复 readBinary + getDocument。
 * 每次访问重置 TTL 计时器；TTL 到期后自动 destroy 并移除缓存。
 * 并发请求同一文件时共享同一个加载 Promise，避免重复加载。
 */
class PdfDocCache {
    /** 缓存条目：pdfPath → { doc, evictTimer } */
    private cache = new Map<string, { doc: any; evictTimer: number }>();
    /** 加载中的 Promise（防止并发重复加载同一文件） */
    private pending = new Map<string, Promise<any>>();
    /** 空闲后存活时长（ms），到期销毁释放内存 */
    private readonly ttlMs: number;

    constructor(ttlMs = 60000) {
        this.ttlMs = ttlMs;
    }

    /** 获取或加载 PDF 文档代理；并发请求共享同一加载 Promise */
    async get(file: TFile, app: import('obsidian').App): Promise<any> {
        const path = file.path;
        const cached = this.cache.get(path);
        if (cached) {
            // 命中：重置淘汰计时器
            window.clearTimeout(cached.evictTimer);
            cached.evictTimer = window.setTimeout(() => this.evict(path), this.ttlMs);
            return cached.doc;
        }

        // 加载中：等待同一文件的在途 Promise
        const loading = this.pending.get(path);
        if (loading) return loading;

        const promise = (async () => {
            const buffer = await app.vault.readBinary(file);
            const pdfjs = (window as any).pdfjsLib;
            const task = pdfjs.getDocument({
                data: buffer,
                cMapPacked: true,
                cMapUrl: '/lib/pdfjs/cmaps/',
            });
            const doc = await task.promise;
            const evictTimer = window.setTimeout(() => this.evict(path), this.ttlMs);
            this.cache.set(path, { doc, evictTimer });
            return doc;
        })();

        this.pending.set(path, promise);
        // 无论加载成功或失败都清除在途标记：失败时若保留，后续所有 get() 都会复用
        // 同一个 rejected Promise，该 PDF 的截图嵌入将永久失败（直到插件重载）
        promise.then(
            () => this.pending.delete(path),
            () => this.pending.delete(path)
        );
        return promise;
    }

    /** 淘汰并销毁指定 PDF 的缓存文档 */
    private evict(path: string): void {
        const entry = this.cache.get(path);
        if (!entry) return;
        this.cache.delete(path);
        entry.doc.destroy().catch(() => {});
    }

    /** 清空全部缓存（插件卸载时调用） */
    clear(): void {
        for (const { doc, evictTimer } of this.cache.values()) {
            window.clearTimeout(evictTimer);
            doc.destroy().catch(() => {});
        }
        this.cache.clear();
        this.pending.clear();
    }
}

/** 插件级 PDF 文档缓存单例 */
const pdfDocCache = new PdfDocCache();
