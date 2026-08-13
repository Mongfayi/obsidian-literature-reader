import { Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { toolbarPoller, pruneStaleLeaves } from './toolbarPoller';

/**
 * 截图模式公共基类
 *
 * 截图批注（ScreenshotModule）与 OCR 批注（OcrModule）共享同一套框选交互：
 *  - PDF 视图工具条按钮注入（layout/active-leaf 事件 + 轮询兜底）
 *  - 进入/退出截图模式（crosshair 光标，不遮挡视图，框挂页面内随滚动移动）
 *  - 跨插件互斥（__pdfCropExit：避免两种模式同时激活导致一次拖拽触发两次）
 *
 * 子类只需提供按钮配置（class/icon/tooltip/命令）并实现 onCropComplete。
 */

/** 最小框选尺寸（CSS px），过小视为误触 */
const MIN_CROP_SIZE = 8;

/** 跨插件截图模式互斥：当前激活者的退出函数 */
interface PdfCropGlobal {
    __pdfCropExit?: (() => void) | null;
}

/** 框选拖拽状态 */
interface DragState {
    pageEl: HTMLElement;
    boxEl: HTMLElement;
    downPX: number;
    downPY: number;
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
}

export abstract class BaseCropModeModule implements PluginModule {
    protected ctx: ModuleContext;

    /** 已注入工具条按钮的叶子 */
    private toolbarLeaves = new Set<WorkspaceLeaf>();
    /** 各叶子工具条按钮（激活态高亮用） */
    private cropButtons = new Map<WorkspaceLeaf, HTMLElement>();
    /** 轮询任务移除函数（卸载时注销共享轮询） */
    private removePollTask: (() => void) | null = null;
    /** 截图模式激活的视图容器（非 null = 截图模式中） */
    protected cropRoot: HTMLElement | null = null;
    /** 截图模式对应的叶子 */
    protected cropLeaf: WorkspaceLeaf | null = null;
    /** 截图模式监听器（供取消时移除） */
    private cropPointerDown: ((e: PointerEvent) => void) | null = null;
    private cropKeyDown: ((e: KeyboardEvent) => void) | null = null;
    /** 当前拖拽状态（非 null = 正在框选） */
    private dragState: DragState | null = null;

    // ===== 子类提供的配置 =====
    /** 工具条按钮的额外 class（用于查重与样式） */
    protected abstract readonly buttonClass: string;
    /** 截图模式激活时加到视图容器的 class（光标样式等） */
    protected abstract readonly selectingClass: string;
    /** 框选 div 的 class */
    protected abstract readonly boxClass: string;
    /** 工具条按钮图标（Obsidian 内置图标名） */
    protected abstract readonly buttonIcon: string;
    /** 工具条按钮 tooltip */
    protected abstract readonly buttonTooltip: string;
    /** 命令 ID */
    protected abstract readonly commandId: string;
    /** 命令名称 */
    protected abstract readonly commandName: string;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
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
        // 用轻量定时轮询兜底（幂等：已注入的叶子跳过）；与其他模块共享同一轮询器
        this.removePollTask = toolbarPoller.add(() => this.injectToolbarButtons());
        toolbarPoller.start();

        plugin.addCommand({
            id: this.commandId,
            name: this.commandName,
            checkCallback: (checking) => {
                const leaf = plugin.app.workspace.getLeavesOfType('pdf')[0];
                if (!leaf) return false;
                if (!checking) this.startCropMode(leaf);
                return true;
            },
        });

        this.injectToolbarButtons();

        // 卸载时统一移除所有已注入按钮（单次注册，避免每次注入都累积一个清理闭包）
        plugin.register(() => {
            for (const btn of this.cropButtons.values()) {
                btn.remove();
            }
            this.cropButtons.clear();
            this.toolbarLeaves.clear();
        });
    }

    unload(): void {
        this.removePollTask?.();
        this.removePollTask = null;
        this.cancelCropMode();
        this.toolbarLeaves.clear();
        this.cropButtons.clear();
    }

    // ========== 工具条按钮 ==========

    protected injectToolbarButtons(): void {
        // 清理已关闭叶子的陈旧缓存条目；若截图模式所在叶子已被关闭，同步退出截图模式
        pruneStaleLeaves(this.ctx.plugin.app, this.toolbarLeaves);
        pruneStaleLeaves(this.ctx.plugin.app, this.cropButtons);
        if (this.cropRoot && !this.cropRoot.isConnected) {
            this.cancelCropMode();
        }

        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;

            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            if (!toolbar) return; // 轮询会重试

            // 页码显示元素：其右侧即为目标位置
            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 以「当前工具条上是否已有按钮」为准，避免重建后重复注入
            if (pageNumberEl.parentElement.querySelector('.' + this.buttonClass)) return;

            // 工具条重建后旧按钮已脱离 DOM：清掉缓存引用，避免闭包与脏引用累积
            const stale = this.cropButtons.get(leaf);
            if (stale && !stale.isConnected) {
                stale.remove();
                this.toolbarLeaves.delete(leaf);
                this.cropButtons.delete(leaf);
            }

            const btn = document.createElement('div');
            btn.addClass('clickable-icon');
            btn.addClass(this.buttonClass);
            setIcon(btn, this.buttonIcon);
            setTooltip(btn, this.buttonTooltip);
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                this.startCropMode(leaf);
            });

            // 插到页码显示之后（与其他工具条按钮并排）
            pageNumberEl.after(btn);

            this.toolbarLeaves.add(leaf);
            this.cropButtons.set(leaf, btn);
            // 工具条可能被 Obsidian 重建：若该叶子正处于截图模式，恢复激活态
            if (this.cropLeaf === leaf && this.cropRoot) {
                btn.addClass('is-active');
            }
        });
    }

    // ========== 截图模式 ==========

    /** 进入/退出截图模式：不遮挡视图，在页面上拖拽框选，可随时滚动页面 */
    protected startCropMode(leaf: WorkspaceLeaf): void {
        // 已处于截图模式：同一视图 → 取消；另一视图 → 切换过去
        if (this.cropRoot) {
            if (this.cropLeaf === leaf) {
                this.cancelCropMode();
                return;
            }
            this.cancelCropMode();
        }

        // 跨插件互斥：退出其它插件可能正在进行的截图模式
        const g = window as unknown as PdfCropGlobal;
        if (typeof g.__pdfCropExit === 'function') {
            g.__pdfCropExit();
            g.__pdfCropExit = null;
        }

        const root = (leaf.view as any).containerEl as HTMLElement;
        if (!root) return;
        const win = root.ownerDocument.defaultView;
        if (!win) return;

        root.addClass(this.selectingClass);
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

        const boxEl = pageEl.createDiv(this.boxClass);
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
            void this.onCropComplete(leaf, pageEl, pageRect);
        };

        this.dragState = { pageEl, boxEl, downPX, downPY, move, up };
        win.addEventListener('pointermove', move, true);
        win.addEventListener('pointerup', up, true);
    }

    /**
     * 框选完成后的处理（子类实现）：
     *  - ScreenshotModule：屏幕坐标 → PDF 坐标 → 写入嵌入链接批注
     *  - OcrModule：截取 canvas → OCR 识别 → 写入文字批注
     */
    protected abstract onCropComplete(
        leaf: WorkspaceLeaf | null,
        pageEl: HTMLElement,
        pageRect: { x: number; y: number; width: number; height: number }
    ): Promise<void> | void;

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

    protected cancelCropMode(): void {
        this.cancelDrag();
        if (this.cropRoot) {
            const win = this.cropRoot.ownerDocument.defaultView;
            this.cropRoot.removeClass(this.selectingClass);
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
}

/** 把坐标夹取到 [0, size] 区间（页面内坐标不越界） */
function clampCoord(value: number, size: number): number {
    if (size <= 0) return 0;
    return Math.min(Math.max(value, 0), size);
}
