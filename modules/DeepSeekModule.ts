import { Notice } from 'obsidian';
import type { ModuleContext, PluginModule, FileUploadData, WindowGeometry } from '../types';

/**
 * DeepSeek 浮动窗口模块
 *
 * 职责：
 *  - 以浮动窗口形式嵌入 DeepSeek 网页聊天
 *  - 支持标题栏拖拽、拖动边缘调整大小、最小化、置顶显示
 *  - 窗口位置/大小（几何信息）在拖拽/缩放后自动持久化到插件设置，重启后恢复
 *  - 提供 Ribbon 图标与命令切换窗口显隐
 *  - 「添加当前文件」按钮：将正在阅读的文件上传到 DeepSeek 聊天框
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

        this.floatingWindow = new DeepSeekFloatingWindow(this.ctx);

        plugin.addRibbonIcon('bot', '打开 DeepSeek', () => {
            this.floatingWindow?.toggle();
        });

        plugin.addCommand({
            id: 'toggle-deepseek-float',
            name: '切换 DeepSeek 浮动窗口',
            callback: () => this.floatingWindow?.toggle(),
        });

        plugin.addCommand({
            id: 'deepseek-add-current-file',
            name: '将当前阅读文件上传到 DeepSeek 聊天框',
            callback: () => this.floatingWindow?.addCurrentFileToChat(),
        });
    }

    unload(): void {
        this.floatingWindow?.destroy();
        this.floatingWindow = null;
    }
}

/** 上传文件大小上限（100MB），超过则提示用户 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 浮动窗口最小尺寸（拖动边缘调整大小时的下限） */
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 400;

/** 缩放手柄方向 → 对应 CSS 类名后缀（n/s/e/w/ne/nw/se/sw） */
const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

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

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
        // 注意：不在构造时创建窗口——webview 一旦创建就会加载完整 DeepSeek 网页
        // （独立渲染进程 + 网络开销）。改为首次 show()/上传文件时懒创建。
    }

    private createWindow() {
        const container = document.body.createDiv({ cls: 'deepseek-float-container' });

        // 标题栏
        const titleBar = container.createDiv({ cls: 'deepseek-float-titlebar' });

        const titleLeft = titleBar.createDiv({ cls: 'deepseek-float-title-left' });
        titleLeft.innerHTML = '<span>DeepSeek</span>';

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
        const wv = content.createEl('webview' as keyof HTMLElementTagNameMap, {
            attr: {
                src: this.ctx.getSettings().deepseekUrl,
                style: 'width: 100%; height: 100%; border: none;',
                allowpopups: '',
            },
        });
        this.webview = wv as any;
        this.content = content;

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
            container.style.cursor = 'grabbing';
            container.style.transition = 'none';
            content.style.pointerEvents = 'none';
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
                container.style.cursor = '';
                container.style.transition = '';
                content.style.pointerEvents = '';
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

        this.container = container;
    }

    show() {
        if (!this.container) this.createWindow();
        if (!this.container) return;
        // 先恢复显示，否则 display:none 下 getBoundingClientRect 恒为 0，
        // 会误判为「已拖出视口」而清空上次拖拽位置（导致隐藏后再显示位置丢失）
        this.container.style.display = 'flex';
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
        this.container.style.display = 'none';
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
        container.style.right = 'auto';
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

        container.style.transition = 'none';
        content.style.pointerEvents = 'none';

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
            container.style.right = 'auto';
            container.style.left = `${Math.round(left)}px`;
            container.style.top = `${Math.round(top)}px`;
        };

        const finish = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', finish);
            container.style.transition = '';
            content.style.pointerEvents = '';
            this.resizeCleanup = null;
            if (resized) this.persistGeometry();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', finish);
        this.resizeCleanup = finish;
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
        for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
            const chunk = base64.slice(i, i + CHUNK_SIZE);
            // IIFE 保证表达式返回 undefined，避免累计字符串被序列化回宿主线程
            await this.webview.executeJavaScript(
                `(function(){ window[${JSON.stringify(varName)}] += ${JSON.stringify(chunk)}; })();`
            );
        }
        const script = this.buildUploadScript(fileData.name, fileData.mimeType, varName);
        return this.webview.executeJavaScript(script);
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
