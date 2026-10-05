import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { ModuleContext, PluginModule, FileUploadData, WindowGeometry } from '../types';

/**
 * DeepSeek 模块
 *
 * 职责：
 *  - 以浮动窗口或工作区标签页两种形式嵌入 DeepSeek 网页聊天
 *  - 浮动窗口支持标题栏拖拽、拖动边缘调整大小、最小化、置顶显示；
 *    窗口位置/大小（几何信息）在拖拽/缩放后自动持久化到插件设置，重启后恢复
 *  - 提供 Ribbon 图标、设置项与命令在两种打开方式之间切换
 *  - 「加载文件」按钮/命令：将正在阅读的文件上传到 DeepSeek 聊天框
 *
 * 说明：webview 标签为 Electron 专有，Obsidian 桌面端可用。
 */
export class DeepSeekModule implements PluginModule {
    private ctx: ModuleContext;
    private floatingWindow: DeepSeekFloatingWindow | null = null;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        plugin.registerView(DEEPSEEK_TAB_VIEW_TYPE, (leaf) => new DeepSeekTabView(leaf, this.ctx));
        this.floatingWindow = new DeepSeekFloatingWindow(this.ctx);

        plugin.addRibbonIcon('bot', '打开 DeepSeek', () => {
            void this.openDefault();
        });

        plugin.addCommand({
            id: 'toggle-deepseek-float',
            name: '切换 DeepSeek 浮动窗口',
            callback: () => this.floatingWindow?.toggle(),
        });

        plugin.addCommand({
            id: 'open-deepseek-tab',
            name: '在标签页打开 DeepSeek',
            callback: () => {
                void this.openTab();
            },
        });

        plugin.addCommand({
            id: 'deepseek-add-current-file',
            name: '将当前阅读文件上传到 DeepSeek 聊天框',
            callback: () => {
                void this.addCurrentFileToChat();
            },
        });
    }

    unload(): void {
        this.floatingWindow?.destroy();
        this.floatingWindow = null;
        // 自定义视图必须在卸载时摘除：视图类型随 registerView 一起失效，
        // 留下的标签页下次启动会因类型未注册而无法还原（官方 Workspace.detachLeavesOfType）
        this.ctx.plugin.app.workspace.detachLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
    }

    /** 按设置中的默认打开方式打开：浮动窗口或标签页 */
    private async openDefault(): Promise<void> {
        if (this.ctx.getSettings().deepseekOpenMode === 'tab') {
            await this.openTab();
            return;
        }
        this.floatingWindow?.toggle();
    }

    /** 在 Obsidian 工作区以标签页打开 DeepSeek；已打开则聚焦并刷新地址 */
    private async openTab(): Promise<void> {
        const leaves = this.ctx.plugin.app.workspace.getLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
        if (leaves.length > 0) {
            const leaf = leaves[0];
            const view = leaf.view;
            if (view instanceof DeepSeekTabView) view.refreshUrlIfChanged();
            await this.ctx.plugin.app.workspace.revealLeaf(leaf);
            return;
        }
        const leaf = this.ctx.plugin.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: DEEPSEEK_TAB_VIEW_TYPE, active: true });
        await this.ctx.plugin.app.workspace.revealLeaf(leaf);
    }

    /** 取当前工作区中第一个已打开的 DeepSeek 标签页视图 */
    private getTabView(): DeepSeekTabView | null {
        const leaves = this.ctx.plugin.app.workspace.getLeavesOfType(DEEPSEEK_TAB_VIEW_TYPE);
        if (leaves.length === 0) return null;
        const view = leaves[0].view;
        return view instanceof DeepSeekTabView ? view : null;
    }

    /**
     * 把当前阅读文件上传到 DeepSeek 聊天框：
     * 优先使用当前激活的 DeepSeek 标签页；若默认打开方式为标签页则用已打开标签页；
     * 否则使用浮动窗口（懒创建并显示）。
     */
    private async addCurrentFileToChat(): Promise<void> {
        // activeLeaf 已被官方标记为 deprecated，改用 getActiveViewOfType
        const activeTab = this.ctx.plugin.app.workspace.getActiveViewOfType(DeepSeekTabView);
        if (activeTab) {
            await activeTab.addCurrentFileToChat();
            return;
        }
        const tab = this.getTabView();
        if (tab && this.ctx.getSettings().deepseekOpenMode === 'tab') {
            await tab.addCurrentFileToChat();
            return;
        }
        await this.floatingWindow?.addCurrentFileToChat();
    }
}

const DEEPSEEK_TAB_VIEW_TYPE = 'deepseek-tab-view';

/** 工作区标签页形式的 DeepSeek 视图（复用浮动窗口的 webview 创建与上传逻辑） */
class DeepSeekTabView extends ItemView {
    private host: DeepSeekFloatingWindow | null = null;

    constructor(leaf: WorkspaceLeaf, private ctx: ModuleContext) {
        super(leaf);
    }

    getViewType(): string {
        return DEEPSEEK_TAB_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'DeepSeek';
    }

    getIcon(): string {
        return 'bot';
    }

    protected async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('deepseek-tab-view');
        const content = this.contentEl.createDiv({ cls: 'deepseek-tab-webview' });
        this.host = new DeepSeekFloatingWindow(this.ctx);
        this.host.attachToTab(content);
        this.addAction('upload', '加载当前文件到 DeepSeek', () => {
            void this.addCurrentFileToChat();
        });
    }

    protected async onClose(): Promise<void> {
        this.host = null;
    }

    /** 供模块命令调用：把当前阅读文件上传到此标签页 */
    async addCurrentFileToChat(): Promise<void> {
        await this.host?.addCurrentFileToChat();
    }

    /** 设置中 DeepSeek URL 改变后刷新标签页 webview */
    refreshUrlIfChanged(): void {
        this.host?.refreshTabWebview();
    }
}

/** 上传文件大小上限（100MB），超过则提示用户 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 浮动窗口最小尺寸（拖动边缘调整大小时的下限） */
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 400;

/** 缩放手柄方向 → 对应 CSS 类名后缀（n/s/e/w/ne/nw/se/sw） */
const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

/** 鼠标左键在 MouseEvent.buttons 中的掩码位（第 0 位） */
const LEFT_BUTTON_MASK = 1;

/** guest 端探测脚本回报用的 console 标记（宿主经 console-message 事件识别） */
const POINTER_PROBE_TOKEN = '__DS_PTR_UP_ENTER__';

/**
 * guest 端指针探测脚本：指针从外部进入 webview 且未按下任何按键时，
 * 打印标记通知宿主，由宿主向 webview 注入 mouseUp 清除可能卡住的滚动条拖拽。
 * （宿主在 webview 区域收不到任何鼠标事件，只能由 guest 端回报进入时机。）
 */
const POINTER_PROBE_SCRIPT = `
(function() {
    if (window.__ds_pointer_probe) return;
    window.__ds_pointer_probe = true;
    var report = function() { console.log('${POINTER_PROBE_TOKEN}'); };
    document.addEventListener('mouseover', function(ev) {
        if (!ev.relatedTarget && ev.buttons === 0) report();
    }, true);
    document.addEventListener('mouseout', function(ev) {
        // 指针离开 guest 文档；标记离开状态，重新进入后的首个 mousemove 走 report
        if (!ev.relatedTarget) window.__ds_ptr_outside = true;
    }, true);
    document.addEventListener('mousemove', function(ev) {
        if (window.__ds_ptr_outside) {
            window.__ds_ptr_outside = false;
            if (ev.buttons === 0) report();
        }
    }, true);
})();
`.trim();

/**
 * guest 端 HTML 预览兼容脚本
 *
 * 背景：DeepSeek 网页端渲染「HTML 预览」时，桌面浏览器走 blob URL 分支——
 *   iframe.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
 * 仅 Android / 不支持 createObjectURL 的环境才回退到 iframe.srcdoc。
 * 但 Obsidian 的 Electron <webview> 中，子框架对 blob: URL 的导航会静默失败：
 * 不触发 load 事件、contentDocument 停留在 about:blank，预览区因此一片空白
 * （同一进程内普通窗口的 iframe 却正常），而 srcdoc 在 webview 中渲染正常。
 *
 * 处理：局部改写 URL.createObjectURL / HTMLIFrameElement.prototype.src，
 * 把「text/html 类型的 blob URL」在赋值给 iframe.src 时改写为 srcdoc，
 * 从而让 DeepSeek 的预览走它自带、且在 webview 中可用的 srcdoc 分支。
 * 仅拦截 text/html 的 blob，其余（图片、下载等）行为完全不变。
 */
const HTML_PREVIEW_COMPAT_SCRIPT = `
(function() {
    if (window.__ds_html_preview_fix) return;
    window.__ds_html_preview_fix = true;

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;

    // blob URL -> HTML 文本 的缓存（只记录 text/html 类型）
    var htmlBlobText = new Map();

    var origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
        var url = origCreate(obj);
        try {
            if (obj instanceof Blob && /text\\/html/i.test(obj.type || '')) {
                htmlBlobText.set(url, obj.text().catch(function() { return null; }));
            }
        } catch (e) {}
        return url;
    };

    var origRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function(url) {
        try { htmlBlobText.delete(url); } catch (e) {}
        return origRevoke(url);
    };

    var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (!desc || !desc.set || !desc.get) return;

    // 恢复原生 src 访问器的兜底路径
    var restore = function(frame, value) {
        try {
            Object.defineProperty(HTMLIFrameElement.prototype, 'src', desc);
            frame.src = value;
        } catch (e) {}
    };

    var custom = {
        configurable: true,
        enumerable: desc.enumerable,
        get: function() { return desc.get.call(this); },
        set: function(value) {
            var self = this;
            try {
                var pending = htmlBlobText.get(value);
                if (pending) {
                    htmlBlobText.delete(value);
                    pending.then(function(text) {
                        // 拿不到文本就退回原生行为，避免影响其他用途
                        if (typeof text !== 'string' || !text.length) {
                            restore(self, value);
                            return;
                        }
                        try {
                            self.removeAttribute('src');
                            self.srcdoc = text;
                        } catch (e) {
                            restore(self, value);
                        }
                    });
                    return;
                }
            } catch (e) {}
            return desc.set.call(this, value);
        },
    };
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', custom);
})();
`.trim();

/**
 * DeepSeek 浮动窗口
 * 负责窗口的创建、显示、隐藏、拖拽、边缘缩放与销毁
 */
class DeepSeekFloatingWindow {
    private ctx: ModuleContext;
    private container: HTMLElement | null = null;
    private content: HTMLElement | null = null;
    private webview: any = null;
    private isVisible = false;
    private isDragging = false;
    private dragOffset = { x: 0, y: 0 };
    /** 正在进行的边缘缩放清理函数（挂 document 级监听；销毁窗口时兜底调用） */
    private resizeCleanup: (() => void) | null = null;
    /** 宿主页面最近一次观察到的鼠标按键掩码（webview 区域收不到宿主事件，用于推断窗口外松开左键） */
    private lastHostButtons = 0;
    /** 当前 webview 实际加载的网址，用于检测设置变更后是否需要重建 */
    private currentUrl = '';

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
        // 注意：不在构造时创建窗口——webview 一旦创建就会加载完整 DeepSeek 网页
        // （独立渲染进程 + 网络开销）。改为首次 show()/上传文件时懒创建。
    }

    /**
     * 按当前设置创建 webview 并挂上就绪/探测监听。
     * 独立成方法是为了支持「改了网址就重建」：webview 的 src 只在创建时读取一次，
     * 之后 hide/show 复用同一个元素，因此改设置后必须重建才会生效。
     */
    private buildWebview(content: HTMLElement): void {
        const url = this.ctx.getSettings().deepseekUrl;
        const wv = content.createEl('webview' as keyof HTMLElementTagNameMap, {
            attr: {
                src: url,
                style: 'width: 100%; height: 100%; border: none;',
                allowpopups: '',
            },
        });
        this.webview = wv as any;
        this.currentUrl = url;

        // 页面就绪后注入 guest 端脚本（指针探测 + HTML 预览兼容；页面刷新后需重注入）
        wv.addEventListener('dom-ready', () => {
            void this.injectPointerProbe();
            void this.injectHtmlPreviewCompat();
        });
        // guest 端探测脚本回报「指针无按键进入 webview」：注入 mouseUp 结束可能卡住的拖拽
        wv.addEventListener('console-message', (e: Event) => {
            const msg = (e as any)?.message;
            if (typeof msg === 'string' && msg.indexOf(POINTER_PROBE_TOKEN) !== -1) {
                this.endStuckWebviewDrag();
            }
        });
    }

    /** 标签页视图复用：把 webview 挂到指定容器，复用后续上传逻辑而不创建浮动窗口。 */
    attachToTab(content: HTMLElement): void {
        this.content = content;
        this.container = content;
        this.buildWebview(content);
    }

    /** 标签页视图在设置 URL 变更后调用，重建 webview。 */
    refreshTabWebview(): void {
        this.refreshWebviewIfUrlChanged();
    }

    /** 设置里的网址变了就重建 webview；只在网址确实变化时重建，避免丢失聊天页面状态。 */
    private refreshWebviewIfUrlChanged(): void {
        if (!this.content) return;
        const url = this.ctx.getSettings().deepseekUrl;
        if (url === this.currentUrl) return;
        this.webview?.remove();
        this.webview = null;
        this.buildWebview(this.content);
    }

    private createWindow() {
        const container = document.body.createDiv({ cls: 'deepseek-float-container' });

        // 标题栏
        const titleBar = container.createDiv({ cls: 'deepseek-float-titlebar' });

        const titleLeft = titleBar.createDiv({ cls: 'deepseek-float-title-left' });
        titleLeft.createSpan({ text: 'DeepSeek' });

        // 右侧按钮容器：上传文件 + 最小化
        const titleRight = titleBar.createDiv({ cls: 'deepseek-float-title-right' });

        const addFileBtn = titleRight.createEl('button', {
            cls: 'deepseek-float-add-file',
        });
        addFileBtn.textContent = '加载文件';
        addFileBtn.title = '将当前阅读的文件上传到聊天框';
        addFileBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.addCurrentFileToChat();
        });

        const minimizeBtn = titleRight.createEl('button', { cls: 'deepseek-float-minimize' });
        minimizeBtn.textContent = '－';
        minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
        });

        // webview 内容区（webview 为 Electron 专有标签，需类型断言）
        const content = container.createDiv({ cls: 'deepseek-float-content' });
        this.content = content;
        this.buildWebview(content);

        // 恢复上次保存的窗口几何（位置 + 大小）
        this.applySavedGeometry(container);

        // 注入八方向缩放手柄（拖动边缘调整大小）
        for (const dir of RESIZE_DIRECTIONS) {
            const handle = container.createDiv({ cls: `deepseek-float-resize deepseek-float-resize-${dir}` });
            handle.addEventListener('mousedown', (e: MouseEvent) => {
                e.stopPropagation();
                this.beginResize(e, dir);
            });
        }

        // 拖拽：按下标题栏时记录偏移并禁用 webview 指针事件；点击按钮不触发拖拽
        titleBar.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            this.isDragging = true;
            const rect = container.getBoundingClientRect();
            this.dragOffset.x = e.clientX - rect.left;
            this.dragOffset.y = e.clientY - rect.top;
            // 交互态交给 CSS 类（.is-dragging），不写内联样式
            container.addClass('is-dragging');
        });

        const onMouseMove = (e: MouseEvent) => {
            if (!this.isDragging) return;
            // 不钳制边界：面板可自由拖出 Obsidian 窗口范围，超出部分由视口裁剪
            container.style.left = e.clientX - this.dragOffset.x + 'px';
            container.style.top = e.clientY - this.dragOffset.y + 'px';
        };

        const onMouseUp = () => {
            if (this.isDragging) {
                this.isDragging = false;
                container.removeClass('is-dragging');
                // 拖拽结束：持久化窗口位置（含大小），重启后恢复
                this.persistGeometry();
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        this.ctx.plugin.register(() => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        });

        // —— webview 滚动条拖拽跟随与卡死修复 ——
        // Electron <webview>（OOPIF）在指针移出 webview 后不再向 guest 投递任何鼠标事件：
        // ① 按住左键拖动滚动条时移出面板，拖拽会「移出即停」；
        // ② 在 webview 内按下、于 webview 之外松开左键后，guest 端拖拽状态卡死，
        //    指针回到 webview 时即使未按键滚动条也会跟随移动。
        // 此处在宿主 document 上跟踪鼠标：
        // ① 按住左键期间把观察到的 mousemove 转投进 webview（见 forwardPointerToWebview）；
        // ② 捕获左键释放（含松开点在 Obsidian 窗口外、指针回到窗口后凭按键掩码
        //    1→0 变化推断出的释放），随即向 webview 注入一次浏览器级 mouseUp
        //    终结 guest 端卡住的拖拽。
        const trackHostMouse = (e: MouseEvent) => {
            const prev = this.lastHostButtons;
            this.lastHostButtons = e.buttons;
            const hadLeft = (prev & LEFT_BUTTON_MASK) !== 0;
            const hasLeft = (e.buttons & LEFT_BUTTON_MASK) !== 0;
            // 按住左键期间转投指针移动，让 webview 内开始的拖拽在面板外继续跟随；
            // 标题栏拖拽/边缘缩放期间跳过，避免转投事件干扰 guest。
            if (hasLeft && e.type === 'mousemove' && !this.isDragging && !this.resizeCleanup) {
                this.forwardPointerToWebview(e);
            }
            const leftReleased = (e.type === 'mouseup' && e.button === 0) || (hadLeft && !hasLeft);
            if (!leftReleased) return;
            // 左键在 Obsidian 窗口外松开时宿主收不到 mouseup，指针回到窗口后补一次收尾，
            // 避免标题栏拖拽/边缘缩放也出现同样的「无按键跟随」
            if (e.type !== 'mouseup') {
                onMouseUp();
                this.resizeCleanup?.();
            }
            this.endStuckWebviewDrag(e);
        };
        document.addEventListener('mousemove', trackHostMouse, true);
        document.addEventListener('mouseup', trackHostMouse, true);

        this.ctx.plugin.register(() => {
            document.removeEventListener('mousemove', trackHostMouse, true);
            document.removeEventListener('mouseup', trackHostMouse, true);
        });

        this.container = container;
    }

    show() {
        if (!this.container) this.createWindow();
        if (!this.container) return;
        // 网址被改过：重建 webview 让新地址生效（提示语承诺「重新打开窗口生效」）
        this.refreshWebviewIfUrlChanged();
        // 先恢复显示，否则 display:none 下 getBoundingClientRect 恒为 0，
        // 会误判为「已拖出视口」而清空上次拖拽位置（导致隐藏后再显示位置丢失）
        this.container.addClass('is-visible');
        // 若面板已被完全拖出 Obsidian 可视区域，复位到 CSS 默认位置与尺寸，避免无法找回；
        // 同时清除持久化几何，否则下次创建窗口又会回到屏幕外
        const rect = this.container.getBoundingClientRect();
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            this.resetGeometryStyles(this.container);
            this.clearGeometry();
        }
        this.isVisible = true;
    }

    hide() {
        if (!this.container) return;
        this.container.removeClass('is-visible');
        this.isVisible = false;
    }

    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    destroy() {
        this.resizeCleanup?.();
        this.resizeCleanup = null;
        this.container?.remove();
        this.container = null;
        this.content = null;
        this.webview = null;
    }

    // ========== 窗口几何：持久化与恢复 ==========

    /** 恢复保存的窗口几何（非法或缺省时保持 CSS 默认值） */
    private applySavedGeometry(container: HTMLElement): void {
        const geom = this.ctx.getSettings().deepseekWindowGeometry;
        if (!isValidGeometry(geom)) return;
        container.style.width = `${geom!.width}px`;
        container.style.height = `${geom!.height}px`;
        container.style.left = `${geom!.left}px`;
        container.style.top = `${geom!.top}px`;
        // 覆盖 CSS 中的 right 定位（left/right 同时生效会拉伸元素）
        container.addClass('is-left-anchored');
    }

    /** 把当前窗口几何写入设置并落盘 */
    private persistGeometry(): void {
        if (!this.container) return;
        const rect = this.container.getBoundingClientRect();
        const geom: WindowGeometry = {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
        };
        if (!isValidGeometry(geom)) return;
        try {
            this.ctx.getSettings().deepseekWindowGeometry = geom;
            void this.ctx.saveSettings().catch((e) => {
                console.error('[DeepSeek] 保存窗口几何失败:', e);
            });
        } catch (e) {
            console.error('[DeepSeek] 写入窗口几何失败:', e);
        }
    }

    /** 清除持久化几何（面板被拖出视口复位时调用） */
    private clearGeometry(): void {
        try {
            this.ctx.getSettings().deepseekWindowGeometry = null;
            void this.ctx.saveSettings().catch((e) => {
                console.error('[DeepSeek] 清除窗口几何失败:', e);
            });
        } catch (e) {
            console.error('[DeepSeek] 清除窗口几何失败:', e);
        }
    }

    /** 清空全部内联几何样式，回退到 CSS 默认定位与尺寸 */
    private resetGeometryStyles(container: HTMLElement): void {
        container.removeClass('is-left-anchored');
        container.style.left = '';
        container.style.top = '';
        container.style.right = '';
        container.style.width = '';
        container.style.height = '';
    }

    // ========== 边缘缩放 ==========

    /**
     * 开始边缘缩放：按方向在 document 上挂一次性 move/up 监听。
     * 8 个方向复用同一套数学：n/s 改高度，e/w 改宽度，w/n 同时平移 left/top，
     * 全程从起始矩形推导（绝对量），避免累积误差；尺寸钳制到最小值。
     */
    private beginResize(e: MouseEvent, dir: string): void {
        if (e.button !== 0) return;
        const container = this.container;
        const content = this.content;
        if (!container || !content) return;

        e.preventDefault();

        const startRect = container.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        let resized = false;

        container.addClass('is-resizing');

        const MIN_W = MIN_WINDOW_WIDTH;
        const MIN_H = MIN_WINDOW_HEIGHT;

        const onMouseMove = (ev: MouseEvent) => {
            resized = true;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;

            let width = startRect.width;
            let height = startRect.height;
            let left = startRect.left;
            let top = startRect.top;

            if (dir.includes('e')) {
                width = Math.max(MIN_W, startRect.width + dx);
            }
            if (dir.includes('s')) {
                height = Math.max(MIN_H, startRect.height + dy);
            }
            if (dir.includes('w')) {
                // 钳制最小宽度后按右缘固定反推 left
                width = Math.max(MIN_W, startRect.width - dx);
                left = startRect.right - width;
            }
            if (dir.includes('n')) {
                height = Math.max(MIN_H, startRect.height - dy);
                top = startRect.bottom - height;
            }

            container.style.width = `${Math.round(width)}px`;
            container.style.height = `${Math.round(height)}px`;
            // 一旦缩放即转为左上角锚定，覆盖 CSS 的 right 默认定位
            container.addClass('is-left-anchored');
            container.style.left = `${Math.round(left)}px`;
            container.style.top = `${Math.round(top)}px`;
        };

        const finish = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', finish);
            container.removeClass('is-resizing');
            this.resizeCleanup = null;
            if (resized) this.persistGeometry();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', finish);
        this.resizeCleanup = finish;
    }

    // ========== webview 拖拽跟随与卡死修复 ==========

    /**
     * 把宿主侧指针事件坐标映射到 webview 视口内并钳制到边缘
     * （指针拖出 webview 范围时钉在边缘，与原生滚动条拖出轨道端点钉住的行为一致）。
     * 窗口隐藏或 webview 未就绪时返回 null。
     */
    private mapToWebview(e: MouseEvent): { x: number; y: number } | null {
        if (!this.isVisible || !this.webview) return null;
        const rect = this.webview.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return null;
        return {
            x: Math.round(Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 1)),
            y: Math.round(Math.min(Math.max(e.clientY - rect.top, 0), rect.height - 1)),
        };
    }

    /**
     * 按住左键期间，把宿主侧观察到的指针移动转投为 webview 输入事件。
     * webview（OOPIF）在指针离开其范围后收不到任何鼠标事件，guest 内已开始的
     * 滚动条/文本选择拖拽会因此中断；转投带左键按下状态的 mouseMove 让拖拽继续跟随。
     * 拖拽未激活时这些事件无副作用（无配套 mousedown，不会触发点击/选择/滚动）。
     */
    private forwardPointerToWebview(e: MouseEvent): void {
        if (!this.isVisible || !this.webview) return;
        const rect = this.webview.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return;
        const rawX = e.clientX - rect.left;
        const rawY = e.clientY - rect.top;
        // 垂直滚动条拖拽期间，注入点 x 若映射到滚动条图层后偏离右缘轨道太远，
        // Chromium ScrollbarController 的 SnapToDragOrigin 判定会命中：滚动位置被
        // 弹回拖拽起点，表现为「拖出面板后滚动条冻结不动」。因此指针从左右两侧
        // 离开 webview 时把注入点钉在右缘轨道内；从上下方向离开时保留真实 x
        // （竖向拖拽只由 y 驱动，此时真实 x 本就贴近轨道，文本选择也能精确跟随）。
        const x = rawX < 0 || rawX > rect.width - 1
            ? Math.round(rect.width - 1)
            : Math.round(rawX);
        const y = Math.round(Math.min(Math.max(rawY, 0), rect.height - 1));
        try {
            this.webview.sendInputEvent({
                type: 'mouseMove',
                x,
                y,
                button: 'left',
                // sendInputEvent 的 WebMouseEvent 转换器不解析 buttons 字段，
                // 按住左键必须用 modifiers 表达，guest 收到的 DOM 事件 buttons 才是 1
                modifiers: ['leftButtonDown'],
            });
        } catch {
            // webview 尚未就绪或正在导航时注入失败，可忽略
        }
    }

    /**
     * 向 webview 注入一次浏览器级 mouseUp，终结 guest 页面中卡住的滚动条/文本选择拖拽。
     * guest 未处于拖拽状态时，单独的 mouseUp 无副作用（click 需要成对的 mousedown+mouseup）。
     * 坐标取当前指针位置映射到 webview 视口内（指针在 webview 外时钳制到边缘），
     * 无指针信息时落在左上角（滚动条在右缘，左上角不会命中交互元素）。
     */
    private endStuckWebviewDrag(e?: MouseEvent): void {
        if (!this.isVisible || !this.webview) return;
        const pt = e ? this.mapToWebview(e) : { x: 1, y: 1 };
        if (!pt) return;
        try {
            this.webview.sendInputEvent({
                type: 'mouseUp',
                x: pt.x,
                y: pt.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
        } catch {
            // webview 尚未就绪或正在导航时注入失败，可忽略
        }
    }

    /** 注入 guest 端指针探测脚本（幂等，dom-ready 时调用；页面刷新后需重注入） */
    private async injectPointerProbe(): Promise<void> {
        if (!this.webview) return;
        try {
            await this.webview.executeJavaScript(POINTER_PROBE_SCRIPT);
        } catch (e) {
            console.warn('[DeepSeek] 注入指针探测脚本失败:', e);
        }
    }

    /**
     * 注入 guest 端 HTML 预览兼容脚本（幂等，dom-ready 时调用；页面刷新后需重注入）。
     * 修复：webview 中子框架无法导航到 blob: URL，导致 DeepSeek 的 HTML 预览一片空白。
     */
    private async injectHtmlPreviewCompat(): Promise<void> {
        if (!this.webview) return;
        try {
            await this.webview.executeJavaScript(HTML_PREVIEW_COMPAT_SCRIPT);
        } catch (e) {
            console.warn('[DeepSeek] 注入 HTML 预览兼容脚本失败:', e);
        }
    }

    // ========== 上传当前文件到聊天框 ==========

    async addCurrentFileToChat() {
        // 懒创建：窗口从未打开过时先创建并显示（webview 页面加载需要时间，
        // 若页面尚未就绪，下方 uploadViaWebview 会返回 not-found 并给出提示）
        if (!this.container) {
            this.createWindow();
            this.show();
        }
        if (!this.webview) {
            new Notice('DeepSeek 窗口未就绪');
            return;
        }

        if (!this.ctx.getCurrentFileForUpload) {
            new Notice('无法获取文件');
            return;
        }

        const fetchingNotice = new Notice('正在读取文件…', 0);

        let fileData: FileUploadData | null = null;
        try {
            fileData = await this.ctx.getCurrentFileForUpload();
        } catch (e) {
            console.error('[DeepSeek] 获取文件失败:', e);
            fetchingNotice.hide();
            new Notice('获取文件失败');
            return;
        }

        fetchingNotice.hide();

        if (!fileData) {
            new Notice('未找到正在阅读的文件');
            return;
        }

        // 大小检查
        const sizeMB = (fileData.data.byteLength / 1024 / 1024).toFixed(1);
        if (fileData.data.byteLength > MAX_UPLOAD_BYTES) {
            new Notice(`文件过大（${sizeMB}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`, 6000);
            return;
        }

        // ArrayBuffer → base64（分块避免栈溢出）
        const base64 = arrayBufferToBase64(fileData.data);

        const uploadingNotice = new Notice(`正在上传 ${fileData.name}（${sizeMB}MB）…`, 0);
        try {
            const result = await this.uploadViaWebview(base64, fileData);
            uploadingNotice.hide();
            if (result === 'not-found') {
                new Notice('未找到 DeepSeek 文件上传入口，请确保页面已加载完成', 6000);
            } else if (result === 'success') {
                new Notice(`已上传 ${fileData.name}`);
            } else if (result === 'drop') {
                new Notice(`已通过拖拽上传 ${fileData.name}`);
            } else {
                new Notice(`上传结果: ${result}`);
            }
        } catch (e) {
            uploadingNotice.hide();
            console.error('[DeepSeek] 文件上传失败:', e);
            new Notice('文件上传失败，请重试或手动上传', 6000);
        }
    }

    /**
     * 分块将 base64 注入 webview 页面变量，避免单次 executeJavaScript
     * 携带超大字符串导致主线程长时间阻塞；最后一步统一组装上传。
     */
    private async uploadViaWebview(base64: string, fileData: FileUploadData): Promise<string> {
        const CHUNK_SIZE = 8 * 1024 * 1024;
        // 每次上传使用独立页面变量，避免并发上传互相污染
        const varName = `__ds_upload_b64_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await this.webview.executeJavaScript(`window[${JSON.stringify(varName)}] = '';`);
        try {
            for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
                const chunk = base64.slice(i, i + CHUNK_SIZE);
                // IIFE 保证表达式返回 undefined，避免累计字符串被序列化回宿主线程
                await this.webview.executeJavaScript(
                    `(function(){ window[${JSON.stringify(varName)}] += ${JSON.stringify(chunk)}; })();`
                );
            }
            const script = this.buildUploadScript(fileData.name, fileData.mimeType, varName);
            return await this.webview.executeJavaScript(script);
        } finally {
            // 兜底释放：分块注入中途失败时上传脚本不会执行，其 finally 也就不会运行，
            // 这里补一次，避免半截 base64 永久留在 guest 页面上。
            try {
                await this.webview.executeJavaScript(`(function(){ delete window[${JSON.stringify(varName)}]; })();`);
            } catch (e) {
                // webview 可能已销毁/未就绪，忽略
            }
        }
    }

    /**
     * 构造上传脚本：
     *  1. 从 window[varName] 取回 base64 → Uint8Array → File 对象
     *  2. 策略 A：找 <input type="file">，用 DataTransfer 赋值并触发 change
     *  3. 策略 B（兜底）：在聊天输入区域模拟 dragover + drop 事件
     * 返回 'success' / 'drop' / 'not-found'
     */
    private buildUploadScript(filename: string, mimeType: string, varName: string): string {
        const escapedName = JSON.stringify(filename);
        const escapedMime = JSON.stringify(mimeType);
        const escapedVar = JSON.stringify(varName);
        return `
(function() {
    try {
        var b64 = window[${escapedVar}] || '';
        var filename = ${escapedName};
        var mimeType = ${escapedMime};

        // base64 → Uint8Array
        var byteChars = atob(b64);
        var len = byteChars.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            bytes[i] = byteChars.charCodeAt(i);
        }
        var file = new File([bytes], filename, { type: mimeType });
        b64 = null;
        byteChars = null;

        // 策略 A：通过 <input type="file"> 上传
        var inputs = document.querySelectorAll('input[type="file"]');
        for (var j = 0; j < inputs.length; j++) {
            var input = inputs[j];
            try {
                var dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return 'success';
            } catch (e) {
                // 该 input 不支持，继续尝试下一个
            }
        }

        // 策略 B：模拟拖拽放置（drag-drop）
        var dropZone = document.querySelector('textarea')
            || document.querySelector('div[contenteditable="true"]')
            || document.querySelector('[class*="upload"]')
            || document.querySelector('[class*="input"]');
        if (dropZone) {
            var dt2 = new DataTransfer();
            dt2.items.add(file);
            try {
                dropZone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt2, bubbles: true }));
                dropZone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt2, bubbles: true }));
                dropZone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true }));
                return 'drop';
            } catch (e) {
                // DragEvent 构造可能失败，忽略
            }
        }

        return 'not-found';
    } catch (e) {
        return 'error: ' + (e && e.message ? e.message : e);
    } finally {
        // 释放宿主分块注入的 base64（约为文件体积的 4/3）。deepseek 页面是常驻 SPA，
        // 变量留在 window 上会随每次上传累积（100MB 文件 ≈ 133MB 常驻字符串），
        // 而宿主侧的 fileData 早已释放 —— 表现为 DeepSeek 子进程内存只涨不落。
        try { delete window[${escapedVar}]; } catch (e) {}
    }
})();
        `.trim();
    }
}

/**
 * ArrayBuffer 转 base64 字符串（分块处理避免栈溢出与内存峰值）
 * 逐块 32KB 生成二进制串并立即 btoa 输出，避免整文件二进制字符串与
 * base64 结果同时驻留内存（100MB 文件可省约一倍峰值）。
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    // 32766 字节 = 3 * 10922，是 3 的倍数。
    // 逐块 btoa 时若块大小不是 3 的倍数，每个分块都会产生独立的 base64 padding（=），
    // 拼接后字符串中间会出现 '='，导致上传脚本里 atob(b64) 抛 Invalid character。
    // 使用 3 的倍数可保证只有整个 base64 的末尾可能出现 padding。
    const chunkSize = 0x7FFE; // 约 32KB，且可被 3 整除
    let out = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        let binary = '';
        for (let j = 0; j < sub.length; j++) {
            binary += String.fromCharCode(sub[j]);
        }
        out += btoa(binary);
    }
    return out;
}

/** 校验窗口几何是否为可用的有限数值（left/top 允许负值以支持部分拖出屏幕） */
function isValidGeometry(g: WindowGeometry | null | undefined): g is WindowGeometry {
    if (!g) return false;
    const nums = [g.left, g.top, g.width, g.height];
    return nums.every((n) => Number.isFinite(n)) && g.width > 50 && g.height > 50;
}
