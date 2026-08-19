import { Notice } from 'obsidian';
import type { ModuleContext, PluginModule, FileUploadData } from '../types';

/**
 * DeepSeek 浮动窗口模块
 *
 * 职责：
 *  - 以浮动窗口形式嵌入 DeepSeek 网页聊天
 *  - 支持标题栏拖拽、最小化、置顶显示
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

/**
 * DeepSeek 浮动窗口
 * 负责窗口的创建、显示、隐藏、拖拽与销毁
 */
class DeepSeekFloatingWindow {
    private ctx: ModuleContext;
    private container: HTMLElement | null = null;
    private webview: any = null;
    private isVisible = false;
    private isDragging = false;
    private dragOffset = { x: 0, y: 0 };

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
        // 若面板已被完全拖出 Obsidian 可视区域，复位到默认位置，避免无法找回
        const rect = this.container.getBoundingClientRect();
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            this.container.style.left = '';
            this.container.style.top = '';
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
        this.container?.remove();
        this.container = null;
        this.webview = null;
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
