import { TFile, Notice, WorkspaceLeaf, FileView, setIcon, setTooltip, Component } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';

/**
 * 截图批注模块
 *
 * 流程：PDF 工具条「截图批注」按钮 → 进入截图模式（crosshair 光标，不遮挡视图）
 *      → 在页面上拖拽框选区域 → 屏幕坐标转为 PDF 坐标
 *      → 在阅读笔记中插入嵌入链接 ![[file.pdf#page=N&rect=...]]（不产生图片文件）
 *      → 自定义 EmbedCreator 用 pdfjs 实时渲染裁剪区域
 *
 * 框选交互与 pdf-ocr 的 OCR 批注一致（不遮挡视图、框挂页面内随滚动移动）。
 * 通过 window.__pdfCropExit 与 pdf-ocr 互斥，避免两种截图模式同时激活导致一次拖拽触发两次。
 *
 * 注：PDF 裁剪嵌入的思路（EmbedCreator + pdfjs 渲染 rect 区域）受 pdf-plus 插件启发，
 */

/** 最小框选尺寸（CSS px），过小视为误触 */
const MIN_CROP_SIZE = 8;

/** 跨插件截图模式互斥：当前激活者的退出函数 */
interface PdfCropGlobal {
    __pdfCropExit?: (() => void) | null;
}

export class ScreenshotModule implements PluginModule {
    private ctx: ModuleContext;
    private pdfModule: PdfReaderModule;

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
    /** 原始 PDF EmbedCreator（注册自定义裁剪嵌入前保存，卸载时恢复） */
    private originalPdfEmbedCreator: any = null;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        plugin.registerEvent(
            plugin.app.workspace.on('layout-change', () => this.injectToolbarButtons())
        );
        plugin.registerEvent(
            plugin.app.workspace.on('active-leaf-change', () => this.injectToolbarButtons())
        );

        // PDF 视图可能被重建，事件驱动注入不可靠，用轻量定时轮询兜底（幂等）
        this.injectionTimer = window.setInterval(() => this.injectToolbarButtons(), 2000);

        plugin.addCommand({
            id: 'screenshot-annotate',
            name: '截图批注到笔记',
            checkCallback: (checking) => {
                const leaf = plugin.app.workspace.getLeavesOfType('pdf')[0];
                if (!leaf) return false;
                if (!checking) this.startCropMode(leaf);
                return true;
            },
        });

        this.injectToolbarButtons();
        this.registerCropEmbedCreator();
    }

    unload(): void {
        if (this.injectionTimer !== null) {
            window.clearInterval(this.injectionTimer);
            this.injectionTimer = null;
        }
        this.cancelCropMode();
        this.restoreCropEmbedCreator();
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

            // 页码显示元素：其右侧即为目标位置
            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 以「当前工具条上是否已有按钮」为准，避免重建后重复注入
            if (pageNumberEl.parentElement.querySelector('.pdfreader-screenshot-button')) return;

            const btn = document.createElement('div');
            btn.addClass('clickable-icon');
            btn.addClass('pdfreader-screenshot-button');
            setIcon(btn, 'image-plus');
            setTooltip(btn, '截图批注到笔记');
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                this.startCropMode(leaf);
            });

            // 插到页码显示之后（与 OCR 批注按钮并排）
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

        // 跨插件互斥：退出其它插件（如 pdf-ocr）可能正在进行的截图模式
        const g = window as unknown as PdfCropGlobal;
        if (typeof g.__pdfCropExit === 'function') {
            g.__pdfCropExit();
            g.__pdfCropExit = null;
        }

        const root = (leaf.view as any).containerEl as HTMLElement;
        if (!root) return;
        const win = root.ownerDocument.defaultView;
        if (!win) return;

        root.addClass('pdf-screenshot-selecting');
        this.cropButtons.get(leaf)?.addClass('is-active');
        this.cropRoot = root;
        this.cropLeaf = leaf;
        // 注册本模式的退出函数，供其它截图模式进入时调用
        g.__pdfCropExit = () => this.cancelCropMode();

        // capture 阶段在 window 层监听，避免被 PDF 视图内部事件处理器拦截
        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;
            if (this.dragState) return;
            const target = e.target as HTMLElement;
            const pageEl = target.closest?.('[data-page-number]') as HTMLElement | null;
            if (!pageEl || !pageEl.isConnected) return;
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

        const boxEl = pageEl.createDiv('pdf-screenshot-box');
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

            const box = boxEl.getBoundingClientRect();
            boxEl.remove();
            const width = box.width;
            const height = box.height;
            if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
                new Notice('框选区域过小，已取消');
                return;
            }
            const pr = pageEl.getBoundingClientRect();
            const pageRect = {
                x: box.left - pr.left,
                y: box.top - pr.top,
                width,
                height,
            };
            const leaf = this.cropLeaf;
            this.cancelCropMode();
            void this.captureScreenshot(leaf, pageEl, pageRect);
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
            this.cropRoot.removeClass('pdf-screenshot-selecting');
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
        if (this.cropLeaf) {
            this.cropButtons.get(this.cropLeaf)?.removeClass('is-active');
        }
        this.cropLeaf = null;
        // 清除跨插件互斥注册（仅当仍指向本模式时）
        const g = window as unknown as PdfCropGlobal;
        if (g.__pdfCropExit) {
            g.__pdfCropExit = null;
        }
    }

    // ========== 图像截取 + 批注 ==========

    /**
     * 注册自定义 PDF EmbedCreator：当嵌入链接含 rect 参数时，用 pdfjs 实时渲染裁剪区域，
     * 不产生图片文件。无 rect 参数时回退到原始创建器。
     */
    private registerCropEmbedCreator(): void {
        const app = this.ctx.plugin.app as any;
        this.originalPdfEmbedCreator = app.embedRegistry.embedByExtension['pdf'];
        app.embedRegistry.unregisterExtension('pdf');
        app.embedRegistry.registerExtension('pdf', (ctx: any, file: TFile, subpath: string) => {
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
        });
    }

    /** 恢复原始 PDF EmbedCreator */
    private restoreCropEmbedCreator(): void {
        const app = this.ctx.plugin.app as any;
        if (this.originalPdfEmbedCreator) {
            app.embedRegistry.unregisterExtension('pdf');
            app.embedRegistry.registerExtension('pdf', this.originalPdfEmbedCreator);
            this.originalPdfEmbedCreator = null;
        }
    }

    private async captureScreenshot(
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
        const rect = this.screenToPdfRect(leaf, pageDiv, pageRect);
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
        const buffer = await this.app.vault.readBinary(this.file);
        const pdfjs = (window as any).pdfjsLib;
        const task = pdfjs.getDocument({
            data: buffer,
            cMapPacked: true,
            cMapUrl: '/lib/pdfjs/cmaps/',
        });
        const doc = await task.promise;
        try {
            const page = await doc.getPage(this.pageNumber);
            const fullCanvas = await this.renderFullPage(page, pdfjs);
            return this.cropToRect(fullCanvas, page, pdfjs);
        } finally {
            await doc.destroy();
        }
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

/** 把坐标夹取到 [0, size] 区间（页面内坐标不越界） */
function clampCoord(value: number, size: number): number {
    if (size <= 0) return 0;
    return Math.min(Math.max(value, 0), size);
}
