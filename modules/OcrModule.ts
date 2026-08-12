import { TFile, Notice, WorkspaceLeaf, FileView, setIcon, setTooltip } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { OcrService } from './OcrService';
import type { OcrHighlightEntry, OcrRect } from './OcrHighlightModule';
import type { PdfReaderModule } from './PdfReaderModule';

/**
 * 截图 OCR 批注模块
 *
 * 流程：PDF 工具条「截图批注」按钮 → 进入截图模式（crosshair 光标，不遮挡视图）
 *      → 在页面上拖拽框选区域 → 从 pdfjs 已渲染页面的 canvas 截取图像
 *      → LM Studio 视觉模型识别文字 → 复用 pdf-reader 插件的批注入口写入阅读笔记
 *
 * 框选交互借鉴 pdf-plus 的设计思路（不照抄）：
 *  - 不叠加全屏遮罩：滚轮、滚动条、平移等页面移动操作在框选过程中照常可用
 *  - 框元素挂在页面 div 内，坐标全程使用「页面内坐标」并随页面实时换算，
 *    因此画框中途滚动页面时框会贴住页面移动，截图区域始终与框选一致
 *
 * 与「选中文字批注」互补：扫描版/无文本层的 PDF 也能框选关键段落批注到笔记。
 */

/** 最小框选尺寸（CSS px），过小视为误触 */
const MIN_CROP_SIZE = 8;
/** 截图区域短边不足该像素时等比放大，保证 OCR 清晰度 */
const MIN_OCR_SIDE = 512;
/** 截图缩放上限 */
const MAX_CROP_SCALE = 4;

/** 跨插件截图模式互斥：当前激活者的退出函数 */
interface PdfCropGlobal {
    __pdfCropExit?: (() => void) | null;
}

export class OcrModule implements PluginModule {
    private ctx: ModuleContext;
    private service = new OcrService('http://127.0.0.1:1234');

    /** 已注入工具条按钮的叶子 */
    private toolbarLeaves = new Set<WorkspaceLeaf>();
    /** 各叶子「截图批注」工具条按钮（激活态高亮用） */
    private cropButtons = new Map<WorkspaceLeaf, HTMLElement>();
    /** 工具条注入轮询定时器 */
    private injectionTimer: number | null = null;
    /** 截图模式激活的视图容器（非 null = 截图模式中） */
    private cropRoot: HTMLElement | null = null;
    /** 截图模式对应的叶子 */
    private cropLeaf: WorkspaceLeaf | null = null;
    /** 截图模式监听器（供取消时移除） */
    private cropPointerDown: ((e: PointerEvent) => void) | null = null;
    private cropKeyDown: ((e: KeyboardEvent) => void) | null = null;
    /** 当前拖拽状态（非 null = 正在框选） */
    private dragState: {
        pageEl: HTMLElement;
        boxEl: HTMLElement;
        downPX: number;
        downPY: number;
        move: (e: PointerEvent) => void;
        up: (e: PointerEvent) => void;
    } | null = null;

    private pdfModule: PdfReaderModule;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
        this.service.setBaseUrl(this.ctx.getSettings().ocrServerUrl);
    }

    /** 高亮模块刷新回调（批注成功后触发即时高亮），由 main.ts 注入 */
    private refreshHighlights: ((file: TFile, entries: OcrHighlightEntry[]) => void) | null = null;
    setHighlightRefresh(cb: (file: TFile, entries: OcrHighlightEntry[]) => void): void {
        this.refreshHighlights = cb;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        plugin.registerEvent(
            plugin.app.workspace.on('layout-change', () => this.injectToolbarButtons())
        );
        plugin.registerEvent(
            plugin.app.workspace.on('active-leaf-change', () => this.injectToolbarButtons())
        );

        // PDF 视图可能被重建（rebuildView/切换文件），事件驱动注入不可靠，
        // 用轻量定时轮询兜底（幂等：已注入的叶子跳过）
        this.injectionTimer = window.setInterval(() => this.injectToolbarButtons(), 2000);

        // 命令
        plugin.addCommand({
            id: 'ocr-screenshot-annotate',
            name: '截图 OCR 批注到笔记',
            checkCallback: (checking) => {
                const leaf = plugin.app.workspace.getLeavesOfType('pdf')[0];
                if (!leaf) return false;
                if (!checking) this.startCropMode(leaf);
                return true;
            },
        });

        this.injectToolbarButtons();
    }

    unload(): void {
        if (this.injectionTimer !== null) {
            window.clearInterval(this.injectionTimer);
            this.injectionTimer = null;
        }
        this.cancelCropMode();
        this.toolbarLeaves.clear();
        this.cropButtons.clear();
    }

    // ========== 工具条按钮 ==========

    private injectToolbarButtons(): void {
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;

            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            if (!toolbar) return; // 轮询会重试

            // 页码显示元素：其右侧为按钮目标位置（与「截图批注」按钮并排）
            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 视图/工具条可能被 Obsidian 重建（旧 DOM 移除后集合状态失效），
            // 以「当前工具条上是否已有按钮」为准，而非缓存集合
            if (pageNumberEl.parentElement.querySelector('.ocr-toolbar-button')) return;

            // 「截图批注」按钮
            const btn = document.createElement('div');
            btn.addClass('clickable-icon');
            btn.addClass('ocr-toolbar-button');
            setIcon(btn, 'crop');
            setTooltip(btn, '截图 OCR 批注到笔记');
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                this.startCropMode(leaf);
            });

            // 插到页码显示之后（与「截图批注」按钮并排）
            pageNumberEl.after(btn);

            this.toolbarLeaves.add(leaf);
            this.cropButtons.set(leaf, btn);
            // 工具条可能被 Obsidian 重建：若该叶子正处于截图模式，恢复激活态
            if (this.cropLeaf === leaf && this.cropRoot) {
                btn.addClass('is-active');
            }
            this.ctx.plugin.register(() => {
                btn.remove();
                this.toolbarLeaves.delete(leaf);
                this.cropButtons.delete(leaf);
            });
        });
    }

    // ========== 截图模式 ==========

    /** 进入/退出截图模式：不遮挡视图，在页面上拖拽框选，可随时滚动页面 */
    private startCropMode(leaf: WorkspaceLeaf): void {
        // 已处于截图模式：同一视图 → 取消；另一视图 → 切换过去
        if (this.cropRoot) {
            if (this.cropLeaf === leaf) {
                this.cancelCropMode();
                return;
            }
            this.cancelCropMode();
        }

        // 跨插件互斥：退出其它插件（如 pdf-reader 截图批注）可能正在进行的截图模式，
        // 避免两种模式同时激活导致一次拖拽触发两次
        const g = window as unknown as PdfCropGlobal;
        if (typeof g.__pdfCropExit === 'function') {
            g.__pdfCropExit();
            g.__pdfCropExit = null;
        }

        const root = (leaf.view as any).containerEl as HTMLElement;
        if (!root) return;
        const win = root.ownerDocument.defaultView;
        if (!win) return;

        // 模式指示：crosshair 光标 + 禁止文本选中（不遮滚动条、不拦截滚轮）
        root.addClass('ocr-selecting');
        // 按钮高亮：通过激活态直观反映截图模式是否开启（取代通知）
        this.cropButtons.get(leaf)?.addClass('is-active');
        this.cropRoot = root;
        this.cropLeaf = leaf;
        // 注册本模式的退出函数，供其它截图模式进入时调用
        g.__pdfCropExit = () => this.cancelCropMode();

        // 用 capture 阶段在 window 层监听：PDF 视图内部的划词/标注事件处理器
        // 可能在中间层 stopPropagation，capture 阶段最先执行、任何拦截都无法阻断
        const onPointerDown = (e: PointerEvent) => {
            // 仅左键；目标必须是页面元素（点滚动条/空白/工具栏不启动）
            if (e.button !== 0) return;
            if (this.dragState) return; // 已有拖拽进行中
            const target = e.target as HTMLElement;
            const pageEl = target.closest?.('[data-page-number]') as HTMLElement | null;
            if (!pageEl || !pageEl.isConnected) return;

            // 取消 pointerdown 会抑制派生 mousedown → 顺带阻止原生文本选择
            e.preventDefault();
            this.startDrag(win, e, pageEl);
        };

        const onKeyDown = (evt: KeyboardEvent) => {
            if (evt.key === 'Escape') {
                evt.preventDefault();
                this.cancelCropMode();
            }
        };

        this.cropPointerDown = onPointerDown;
        this.cropKeyDown = onKeyDown;
        win.addEventListener('pointerdown', onPointerDown, true);
        win.addEventListener('keydown', onKeyDown, true);
    }

    /** 开始一次框选拖拽：框挂页面内，坐标全程锚定页面（页面滚动不漂移） */
    private startDrag(win: Window, e: PointerEvent, pageEl: HTMLElement): void {
        this.cancelDrag();

        // 框选 div 是页面 div 的绝对定位子元素，left/top 相对「内边距框」，
        // 而 clientX 减 getBoundingClientRect().left 得到的是「边框外缘」相对坐标。
        // 页面 div 带边框时两者差一个边框宽度，会导致框整体偏到光标右下角，
        // 因此统一换算到内边距框坐标系（原点 = 边框外缘 + clientLeft/Top）。
        const pr0 = pageEl.getBoundingClientRect();
        const ox0 = pr0.left + pageEl.clientLeft;
        const oy0 = pr0.top + pageEl.clientTop;
        const pw0 = pageEl.clientWidth;
        const ph0 = pageEl.clientHeight;
        const downPX = clampCoord(e.clientX - ox0, pw0);
        const downPY = clampCoord(e.clientY - oy0, ph0);
        const pointerId = e.pointerId;

        const boxEl = pageEl.createDiv('ocr-crop-box');
        Object.assign(boxEl.style, {
            left: `${downPX}px`,
            top: `${downPY}px`,
            width: '0px',
            height: '0px',
        });

        const move = (evt: PointerEvent) => {
            if (evt.pointerId !== pointerId) return;
            evt.preventDefault();
            const pr = pageEl.getBoundingClientRect();
            const ox = pr.left + pageEl.clientLeft;
            const oy = pr.top + pageEl.clientTop;
            const px = clampCoord(evt.clientX - ox, pageEl.clientWidth);
            const py = clampCoord(evt.clientY - oy, pageEl.clientHeight);
            Object.assign(boxEl.style, {
                left: `${Math.min(downPX, px)}px`,
                top: `${Math.min(downPY, py)}px`,
                width: `${Math.abs(px - downPX)}px`,
                height: `${Math.abs(py - downPY)}px`,
            });
        };

        const up = (evt: PointerEvent) => {
            if (evt.pointerId !== pointerId) return;
            win.removeEventListener('pointermove', move, true);
            win.removeEventListener('pointerup', up, true);
            if (this.dragState) this.dragState = null;

            // 先取几何再移除框（remove 后 getBoundingClientRect 恒为 0）
            const box = boxEl.getBoundingClientRect();
            boxEl.remove();
            const width = box.width;
            const height = box.height;
            if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
                new Notice('框选区域过小，已取消');
                return;
            }
            // 框最终几何换算回页面内坐标（滚动后仍准确：起终点都锚定页面）
            const pr = pageEl.getBoundingClientRect();
            const pageRect = {
                x: box.left - pr.left,
                y: box.top - pr.top,
                width,
                height,
            };
            // 完成本次框选，退出截图模式
            const leaf = this.cropLeaf;
            this.cancelCropMode();
            void this.captureAndAnnotate(leaf, pageEl, pageRect);
        };

        this.dragState = { pageEl, boxEl, downPX, downPY, move, up };
        win.addEventListener('pointermove', move, true);
        win.addEventListener('pointerup', up, true);
    }

    /** 取消当前拖拽（保留截图模式） */
    private cancelDrag(): void {
        if (!this.dragState) return;
        const { boxEl, move, up } = this.dragState;
        this.dragState = null;
        boxEl.remove();
        const win = boxEl.ownerDocument.defaultView;
        win?.removeEventListener('pointermove', move, true);
        win?.removeEventListener('pointerup', up, true);
    }

    private cancelCropMode(): void {
        this.cancelDrag();
        if (this.cropRoot) {
            const win = this.cropRoot.ownerDocument.defaultView;
            this.cropRoot.removeClass('ocr-selecting');
            if (this.cropPointerDown) {
                win?.removeEventListener('pointerdown', this.cropPointerDown, true);
                this.cropPointerDown = null;
            }
            if (this.cropKeyDown) {
                win?.removeEventListener('keydown', this.cropKeyDown, true);
                this.cropKeyDown = null;
            }
            this.cropRoot = null;
        }
        // 取消按钮激活态（在读 cropLeaf 置空前操作）
        if (this.cropLeaf) {
            this.cropButtons.get(this.cropLeaf)?.removeClass('is-active');
        }
        this.cropLeaf = null;
        // 清除跨插件互斥注册
        const g = window as unknown as PdfCropGlobal;
        if (g.__pdfCropExit) {
            g.__pdfCropExit = null;
        }
    }

    // ========== 图像截取 ==========

    private async captureAndAnnotate(
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
        const canvas = pageDiv.querySelector('canvas') as HTMLCanvasElement | null;
        if (canvas && canvas.width > 0 && canvas.height > 0) {
            imageDataUrl = cropFromCanvas(canvas, pageRect, pageDiv);
        }

        // 2) 兜底：整页重新渲染后再裁剪
        if (!imageDataUrl) {
            try {
                const proxy = this.getPdfDocumentProxy(leaf);
                if (!proxy) throw new Error('无法获取 PDF 文档代理');
                imageDataUrl = await this.renderCropFallback(proxy, pageNum, pageRect, pageDiv);
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

        let model: string;
        try {
            model = await this.service.resolveModel(settings.ocrModel);
        } catch (e) {
            new Notice(`无法连接 OCR 服务器: ${(e as Error).message}`);
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

    // ========== 兜底整页渲染（canvas 缺失时） ==========

    private async renderCropFallback(
        proxy: any,
        pageNum: number,
        pageRect: { x: number; y: number; width: number; height: number },
        pageDiv?: HTMLElement
    ): Promise<string> {
        const page = await proxy.getPage(pageNum);
        const viewport1 = page.getViewport({ scale: 1 });
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
        return cropCanvasRegion(canvas, sx, sy, sw, sh);
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
    pageDiv: HTMLElement
): string {
    const canvasRect = canvas.getBoundingClientRect();
    const pr = pageDiv.getBoundingClientRect();
    const dprX = canvas.width / canvasRect.width;
    const dprY = canvas.height / canvasRect.height;
    const sx = (pageRect.x - (canvasRect.left - pr.left)) * dprX;
    const sy = (pageRect.y - (canvasRect.top - pr.top)) * dprY;
    const sw = pageRect.width * dprX;
    const sh = pageRect.height * dprY;
    return cropCanvasRegion(canvas, sx, sy, sw, sh);
}

/** 离屏 canvas 裁剪源图区域；小区域等比放大提升 OCR 清晰度 */
function cropCanvasRegion(
    source: HTMLCanvasElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number
): string {
    // 裁剪边界夹取到源图内
    const cx = Math.max(0, sx);
    const cy = Math.max(0, sy);
    const cw = Math.min(sw, source.width - cx);
    const ch = Math.min(sh, source.height - cy);
    if (cw < 1 || ch < 1) throw new Error('截图区域超出页面范围');

    // 区域过小时等比放大（短边接近 MIN_OCR_SIDE，上限 MAX_CROP_SCALE 倍）
    const minSide = Math.min(cw, ch);
    const scale = Math.min(MAX_CROP_SCALE, Math.max(1, MIN_OCR_SIDE / minSide));

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

/** 把坐标夹取到 [0, size] 区间（页面内坐标不越界） */
function clampCoord(value: number, size: number): number {
    if (size <= 0) return 0;
    return Math.min(Math.max(value, 0), size);
}

/** 把归一化坐标夹取到 [0, 1] 区间 */
function clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}