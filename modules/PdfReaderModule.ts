import { TFile, TFolder, Menu, WorkspaceLeaf, FileView, MarkdownView, Editor, Notice, normalizePath } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ModuleContext, PluginModule, SavedSelectionInfo, FileUploadData } from '../types';

declare const WORKER_CODE: string;
declare function require(name: string): any;

// worker 仅需初始化一次，模块加载时执行
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
    new Blob([WORKER_CODE], { type: 'application/javascript' })
);

/** 相邻文本项 Y 坐标差超过该阈值视为换行 */
const LINE_BREAK_THRESHOLD = 5;

/**
 * PDF 阅读模块
 *
 * 职责：
 *  - 右键 PDF「开始阅读」：分屏打开 PDF 与阅读笔记
 *  - 自动提取 PDF 关键词写入笔记 frontmatter
 *  - 选中文字浮动按钮批注到笔记（支持 Ctrl 多选批量批注）
 */
export class PdfReaderModule implements PluginModule {
    private ctx: ModuleContext;

    private floatingBtn: HTMLElement | null = null;
    private floatingBadge: HTMLElement | null = null;
    private savedSelections: SavedSelectionInfo[] = [];
    /** 当前选区所属的 PDF 路径，用于跨文件时重置多选缓存 */
    private currentPdfPath: string | null = null;
    /** 批注写入后回调（由主入口注入 PdfHighlightModule.refresh，用于即时渲染持久高亮） */
    private refreshHighlights: ((file: TFile, selections?: SavedSelectionInfo[]) => void) | null = null;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    /** 注入批注后的高亮刷新回调 */
    setRefreshHighlights(cb: (file: TFile, selections?: SavedSelectionInfo[]) => void): void {
        this.refreshHighlights = cb;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        // 右键菜单：开始阅读
        plugin.registerEvent(
            // @ts-ignore - Obsidian 的 file-menu 事件签名
            plugin.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
                if (file.extension === 'pdf') {
                    menu.addItem((item) => {
                        item.setTitle('开始阅读')
                            .setIcon('book-open')
                            .onClick(async () => {
                                await this.startReading(file);
                            });
                    });
                }
            })
        );

        // 浮动批注按钮
        this.initFloatingButton();

        // PDF 中选中文字后显示批注按钮
        plugin.registerDomEvent(document, 'mouseup', (evt: MouseEvent) => {
            this.handlePdfMouseUp(evt);
        });

        // 点击批注按钮外部时隐藏
        plugin.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
            if (this.floatingBtn && !this.floatingBtn.contains(evt.target as Node)) {
                this.hideFloatingButton();
            }
        });
    }

    unload(): void {
        this.removeFloatingButton();
        this.savedSelections = [];
        this.currentPdfPath = null;
    }

    // ========== 获取当前活动文件二进制数据（供 DeepSeek 上传） ==========

    /**
     * 获取当前活动文件的二进制数据用于上传：
     *  - PDF 视图：读取 PDF 原始二进制（非文本提取）
     *  - Markdown 视图：读取笔记内容并编码为 UTF-8
     *  - 其他：尝试读取活动 .md 文件
     * 无可用文件时返回 null
     */
    async getCurrentFileForUpload(): Promise<FileUploadData | null> {
        const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
        if (!activeLeaf) return null;

        const view = activeLeaf.view;

        // PDF 视图：直接读取二进制
        if (view.getViewType() === 'pdf') {
            const pdfFile = (view as FileView).file;
            if (!pdfFile) return null;
            try {
                const data = await this.ctx.plugin.app.vault.readBinary(pdfFile);
                return { data, name: pdfFile.name, mimeType: 'application/pdf' };
            } catch (e) {
                console.error('[PdfReader] 读取 PDF 二进制失败:', e);
                return null;
            }
        }

        // Markdown 视图：读取文本并编码为 UTF-8
        if (view instanceof MarkdownView) {
            const file = view.file;
            if (!file) return null;
            const text = await this.ctx.plugin.app.vault.read(file);
            return {
                data: new TextEncoder().encode(text).buffer as ArrayBuffer,
                name: file.name,
                mimeType: 'text/markdown',
            };
        }

        // 兜底：尝试活动 .md 文件
        const file = this.ctx.plugin.app.workspace.getActiveFile();
        if (file && file.extension === 'md') {
            const text = await this.ctx.plugin.app.vault.read(file);
            return {
                data: new TextEncoder().encode(text).buffer as ArrayBuffer,
                name: file.name,
                mimeType: 'text/markdown',
            };
        }

        return null;
    }

    // ========== 开始阅读主流程 ==========

    async startReading(pdfFile: TFile) {
        try {
            const noteFile = await this.createReadingNote(pdfFile);
            if (!noteFile) return;

            // PDF 已打开时复用叶子，避免重复打开
            let pdfLeaf = this.findLeafByPath(pdfFile.path);
            if (!pdfLeaf) {
                pdfLeaf = this.ctx.plugin.app.workspace.getLeaf('tab');
                await pdfLeaf.openFile(pdfFile);
            }

            // 笔记已打开时聚焦现有叶子，否则在 PDF 右侧分屏打开
            const noteLeaf = this.findLeafByPath(noteFile.path);
            if (noteLeaf) {
                this.ctx.plugin.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
            } else if (pdfLeaf) {
                const rightLeaf = this.ctx.plugin.app.workspace.createLeafBySplit(pdfLeaf, 'vertical', false);
                await rightLeaf.openFile(noteFile);
                this.ctx.plugin.app.workspace.setActiveLeaf(rightLeaf, { focus: true });
            }
        } catch (error) {
            console.error('[PdfReader] 开始阅读失败:', error);
        }
    }

    /** 查找已打开指定文件的叶子，未打开返回 null */
    private findLeafByPath(path: string): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (!result && leaf.view instanceof FileView && leaf.view.file?.path === path) {
                result = leaf;
            }
        });
        return result;
    }

    // ========== 阅读笔记创建 ==========

    async createReadingNote(pdfFile: TFile): Promise<TFile | null> {
        const folderPath = this.ctx.getSettings().readingNoteFolder;

        const folder = this.ctx.plugin.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.ctx.plugin.app.vault.createFolder(folderPath);
        }

        const notePath = await this.resolveNotePath(pdfFile, folderPath);
        const noteFile = this.ctx.plugin.app.vault.getAbstractFileByPath(notePath);
        if (noteFile instanceof TFile) return noteFile;
        // 防御：目标路径被同名文件夹占用
        if (noteFile instanceof TFolder) return null;

        const initialContent = await this.generateNoteContent(pdfFile);
        return await this.ctx.plugin.app.vault.create(notePath, initialContent) as TFile;
    }

    /**
     * 解析阅读笔记路径：
     *  - 优先 `{PDF文件名} 阅读.md`，不存在则返回
     *  - 已存在且属于同一 PDF（frontmatter pdf 字段一致或缺失）时复用
     *  - 属于其他 PDF（同名 PDF 冲突）时，按 `{文件名} 阅读 (n).md` 递增去重
     */
    private async resolveNotePath(pdfFile: TFile, folderPath: string): Promise<string> {
        const baseName = pdfFile.basename;
        const basePath = normalizePath(`${folderPath}/${baseName} 阅读.md`);

        const base = this.ctx.plugin.app.vault.getAbstractFileByPath(basePath);
        if (base instanceof TFile && await this.belongsToPdf(base, pdfFile)) {
            return basePath;
        }
        if (!base) {
            return basePath;
        }

        for (let n = 2; n <= 99; n++) {
            const candidate = normalizePath(`${folderPath}/${baseName} 阅读 (${n}).md`);
            const existing = this.ctx.plugin.app.vault.getAbstractFileByPath(candidate);
            if (existing instanceof TFile && await this.belongsToPdf(existing, pdfFile)) {
                return candidate;
            }
            if (!existing) {
                return candidate;
            }
        }
        return basePath;
    }

    /** 判断笔记是否属于指定 PDF（读取 frontmatter 的 pdf 字段） */
    private async belongsToPdf(noteFile: TFile, pdfFile: TFile): Promise<boolean> {
        try {
            const content = await this.ctx.plugin.app.vault.read(noteFile);
            const match = content.match(/^pdf:\s*["']?\[\[(.+?)\]\]["']?/m);
            // 无 pdf 字段的旧笔记/手工笔记：沿用原「存在即复用」语义
            if (!match) return true;
            const linked = match[1];
            if (linked === pdfFile.path) return true;
            // 路径不一致：若 frontmatter 引用的旧文件已不存在（PDF 被移动/改名后失效）
            // 且文件名一致，判定为同一 PDF（复用，不新建「(n)」重复笔记），并顺手修复字段
            if (!(this.ctx.plugin.app.vault.getAbstractFileByPath(linked) instanceof TFile)) {
                const linkedName = linked.split('/').pop();
                if (linkedName === pdfFile.name) {
                    await this.repairPdfField(noteFile, pdfFile);
                    return true;
                }
            }
            // 同名文件仍存在（真实的同名 PDF 冲突）→ 不属于当前 PDF，走 (n) 去重
            return false;
        } catch (e) {
            console.warn('[PdfReader] 读取笔记 frontmatter 失败，按同一 PDF 处理:', e);
            return true;
        }
    }

    /** 仅替换 frontmatter 中的 pdf 字段为当前路径，不触碰笔记正文 */
    private replacePdfField(content: string, newPath: string): string {
        const lines = content.split('\n');
        let inFrontmatter = false;
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            if (i === 0 && t === '---') { inFrontmatter = true; continue; }
            if (inFrontmatter && t === '---') break;
            if (inFrontmatter && /^pdf:/.test(lines[i])) {
                lines[i] = `pdf: "[[${newPath}]]"`;
                break;
            }
        }
        return lines.join('\n');
    }

    private async repairPdfField(noteFile: TFile, pdfFile: TFile): Promise<void> {
        try {
            await this.ctx.plugin.app.vault.process(noteFile, (data) => {
                const fixed = this.replacePdfField(data, pdfFile.path);
                if (fixed !== data) {
                    console.log(`[PdfReader] 修复笔记 ${noteFile.path} 的 pdf 字段 → ${pdfFile.path}`);
                }
                return fixed;
            });
        } catch (e) {
            console.warn('[PdfReader] 修复 pdf 字段失败:', e);
        }
    }

    async generateNoteContent(pdfFile: TFile): Promise<string> {
        const date = new Date().toISOString().split('T')[0];

        let tags: string[] = [];
        try {
            const text = await this.extractPdfText(pdfFile);
            console.log(`[PdfReader] 成功提取PDF文本，总长度: ${text.length} 字符`);
            tags = this.extractKeywords(text);
            console.log(`[PdfReader] 关键词提取结果: ${tags.length > 0 ? tags.join(', ') : '未找到关键词'}`);
        } catch (e) {
            console.warn('[PdfReader] 提取PDF关键词失败，将生成不带 tags 的笔记:', e);
        }

        let frontmatter = `---
pdf: "[[${pdfFile.path}]]"
created: ${date}`;

        if (tags.length > 0) {
            frontmatter += `\ntags:\n${tags.map(t => `  - ${t}`).join('\n')}`;
        }

        frontmatter += '\n---\n';

        // 正文：三个引导问题，每点之间空一行
        const body = [
            '1.写出你的实验思路。',
            '',
            '2.从论文中获得的信息。',
            '',
            '3.发现的问题。',
        ].join('\n');

        return frontmatter + '\n' + body + '\n';
    }

    // ========== PDF 文本提取 ==========

    private async extractPdfText(pdfFile: TFile): Promise<string> {
        const arrayBuffer = await this.ctx.plugin.app.vault.readBinary(pdfFile);

        // 优先使用 Obsidian 自带 pdfjs（渲染/字体/CMap 与视图一致），缺失时回退内置 pdfjs-dist
        const appPdfjs: any = (window as any).pdfjsLib;
        if (appPdfjs?.getDocument) {
            const loadingTask = appPdfjs.getDocument({ data: arrayBuffer });
            return await this.extractTextFromDocument(loadingTask);
        }

        const fs = require('fs');

        class PluginCMapReaderFactory {
            baseUrl: string;
            isCompressed: boolean;
            constructor({ baseUrl, isCompressed }: any) {
                this.baseUrl = baseUrl;
                this.isCompressed = isCompressed;
            }
            async fetch({ name }: { name: string }) {
                const url = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
                const urlPath = url.startsWith('file:///') ? url.slice(8) : url;
                const data = fs.readFileSync(urlPath);
                return {
                    cMapData: new Uint8Array(data),
                    isCompressed: this.isCompressed,
                };
            }
        }

        const vaultPath = (this.ctx.plugin.app.vault.adapter as any).getBasePath();
        // 优先读取 manifest 中的插件目录名（Obsidian 1.7+），旧版本回退为默认目录名
        // 注意：新版本 manifest.dir 可能返回 '.obsidian/plugins/pdf-reader' 完整相对路径，统一取末段
        const pluginDir = (this.ctx.plugin.manifest.dir ?? 'pdf-reader').split('/').pop() ?? 'pdf-reader';
        const cMapBaseUrl = 'file:///' + vaultPath.replace(/\\/g, '/') + '/.obsidian/plugins/' + pluginDir + '/cmaps/';

        const loadingTask = pdfjsLib.getDocument({
            data: arrayBuffer,
            cMapUrl: cMapBaseUrl,
            cMapPacked: true,
            useWorkerFetch: false,
            isEvalSupported: false,
            CMapReaderFactory: PluginCMapReaderFactory as any,
        });
        return await this.extractTextFromDocument(loadingTask);
    }

    /** 从加载任务中逐页提取文本（两套 pdfjs 共用） */
    private async extractTextFromDocument(loadingTask: any): Promise<string> {
        const pdf = await loadingTask.promise;

        // 页间无数据依赖，并行提取文本；单页失败不中断整篇提取
        const results = await Promise.allSettled(
            Array.from({ length: pdf.numPages }, (_, i) =>
                pdf.getPage(i + 1)
                    .then((page: any) => page.getTextContent())
                    .then((textContent: any) => this.formatPageText(textContent.items))
            )
        );

        let fullText = '';
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
                fullText += result.value + '\n';
            } else {
                console.warn(`[PdfReader] 第 ${i + 1} 页文本提取失败，已跳过:`, result.reason);
            }
        }
        pdf.destroy();
        return fullText;
    }

    /** 将单页文本项按行/空格规则拼接为页面文本（与逐页串行时的输出一致） */
    private formatPageText(items: any[]): string {
        let pageText = '';
        for (let j = 0; j < items.length; j++) {
            const item: any = items[j];
            if (j > 0) {
                const prev: any = items[j - 1];
                const prevY = prev.transform ? prev.transform[5] : null;
                const currY = item.transform ? item.transform[5] : null;
                if (prevY !== null && currY !== null && Math.abs(prevY - currY) > LINE_BREAK_THRESHOLD) {
                    pageText += '\n';
                } else {
                    const curChar = prev.str.charAt(prev.str.length - 1) || '';
                    const nextChar = item.str.charAt(0) || '';
                    if (this.needSpaceBetween(curChar, nextChar)) {
                        pageText += ' ';
                    }
                }
            }
            pageText += item.str;
        }
        return pageText;
    }

    private isCJK(ch: string): boolean {
        const cp = ch.codePointAt(0);
        if (!cp) return false;
        return (cp >= 0x2E80 && cp <= 0x2EFF)
            || (cp >= 0x3000 && cp <= 0x303F)
            || (cp >= 0x3400 && cp <= 0x4DBF)
            || (cp >= 0x4E00 && cp <= 0x9FFF)
            || (cp >= 0xF900 && cp <= 0xFAFF)
            || (cp >= 0xFF00 && cp <= 0xFFEF)
            || (cp >= 0x20000 && cp <= 0x2EBEF);
    }

    private needSpaceBetween(left: string, right: string): boolean {
        if (!left || !right) return false;
        if (this.isCJK(left) && this.isCJK(right)) return false;
        return true;
    }

    // ========== 关键词提取 ==========

    private extractKeywords(text: string): string[] {
        // 清除控制字符（保留 \t \n \r 等空白字符）
        text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        const stopMarkers = ['中图分类号', '文献标识码', '文章编号', 'DOI', 'doi', '分类号', '收稿日期', '修回日期', '基金项目', 'Abstract', 'abstract', 'Keywords', 'keywords'];

        const compactedText = text.replace(/\s+/g, '');

        const tryOnText = (source: string, pattern: RegExp): string => {
            const match = source.match(pattern);
            if (match && match[1].trim()) {
                let content = match[1].trim();
                const compactedContent = content.replace(/\s+/g, '');
                for (const marker of stopMarkers) {
                    let idx = content.indexOf(marker);
                    if (idx < 0) {
                        idx = compactedContent.indexOf(marker);
                        if (idx >= 0) {
                            // 将紧凑文本中的下标映射回原始文本（含空白）的位置
                            let accumulated = 0;
                            for (let c = 0; c < content.length; c++) {
                                if (content[c] !== ' ' && content[c] !== '\t' && content[c] !== '\n') {
                                    if (accumulated >= idx) {
                                        idx = c;
                                        break;
                                    }
                                    accumulated++;
                                }
                            }
                        }
                    }
                    if (idx >= 0) {
                        content = content.substring(0, idx).trim();
                        break;
                    }
                }
                return content;
            }
            return '';
        };

        const patterns: RegExp[] = [
            /关键词[：:∶]?\s*([^\n。]+)/,
            /关键字[：:∶]?\s*([^\n。]+)/,
            /[Kk]eywords?[：:∶]?\s*([^\n。]+)/,
        ];

        let keywordsStr = '';
        for (const pattern of patterns) {
            keywordsStr = tryOnText(text, pattern);
            if (keywordsStr) break;
            keywordsStr = tryOnText(compactedText, pattern);
            if (keywordsStr) {
                keywordsStr = keywordsStr.replace(/\s+/g, '');
                break;
            }
        }

        if (!keywordsStr) return [];

        // 优先按分号/逗号分割；不足时回退到空格分割
        let rawKeywords = keywordsStr.split(/[；;，,]/).map(k => k.trim()).filter(k => k.length > 0);
        if (rawKeywords.length <= 2) {
            const spaceSplit = keywordsStr.split(/\s+/).map(k => k.trim()).filter(k => k.length > 0);
            if (spaceSplit.length > rawKeywords.length) {
                rawKeywords = spaceSplit;
            }
        }

        const MAX_TAG_LENGTH = 40;
        const tags = rawKeywords.map(k => {
            return k.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '');
        }).filter(k => k.length > 0 && k.length <= MAX_TAG_LENGTH);

        return [...new Set(tags)];
    }

    // ========== 浮动批注按钮 ==========

    private initFloatingButton() {
        this.floatingBtn = document.createElement('div');
        this.floatingBtn.className = 'pdf-annotate-floating-btn';
        Object.assign(this.floatingBtn.style, {
            position: 'fixed',
            zIndex: '9999',
            padding: '6px 14px',
            background: 'var(--interactive-accent)',
            color: 'var(--text-on-accent)',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: '500',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            display: 'none',
            userSelect: 'none',
            transition: 'opacity 0.15s',
            whiteSpace: 'nowrap',
        });

        const label = document.createElement('span');
        label.textContent = '批注到笔记';
        this.floatingBtn.appendChild(label);

        const badge = document.createElement('sup');
        badge.style.marginLeft = '4px';
        badge.style.fontSize = '11px';
        badge.style.fontWeight = '700';
        badge.style.color = 'var(--text-on-accent)';
        badge.style.display = 'none';
        this.floatingBadge = badge;
        this.floatingBtn.appendChild(badge);

        document.body.appendChild(this.floatingBtn);

        this.ctx.plugin.registerDomEvent(this.floatingBtn, 'click', () => {
            this.handleAnnotation();
            this.hideFloatingButton();
        });

        this.ctx.plugin.registerDomEvent(this.floatingBtn, 'mouseenter', () => {
            if (this.floatingBtn) this.floatingBtn.style.opacity = '0.85';
        });

        this.ctx.plugin.registerDomEvent(this.floatingBtn, 'mouseleave', () => {
            if (this.floatingBtn) this.floatingBtn.style.opacity = '1';
        });
    }

    private removeFloatingButton() {
        if (this.floatingBtn) {
            this.floatingBtn.remove();
            this.floatingBtn = null;
            this.floatingBadge = null;
        }
    }

    private showFloatingButton(x: number, y: number) {
        if (!this.floatingBtn) return;
        this.floatingBtn.style.display = 'block';
        if (this.floatingBadge) {
            if (this.savedSelections.length > 1) {
                this.floatingBadge.textContent = `${this.savedSelections.length}`;
                this.floatingBadge.style.display = 'inline';
            } else {
                this.floatingBadge.style.display = 'none';
            }
        }
        const btnW = this.floatingBtn.offsetWidth || 80;
        let left = x - btnW / 2;
        let top = y - 42;
        if (left < 10) left = 10;
        if (top < 10) top = y + 20;
        this.floatingBtn.style.left = `${left}px`;
        this.floatingBtn.style.top = `${top}px`;
    }

    private hideFloatingButton() {
        if (this.floatingBtn) {
            this.floatingBtn.style.display = 'none';
        }
    }

    // ========== PDF 选区检测 ==========

    private handlePdfMouseUp(evt: MouseEvent) {
        setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.toString().trim()) {
                this.hideFloatingButton();
                return;
            }

            const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
            if (!activeLeaf || activeLeaf.view.getViewType() !== 'pdf') {
                this.hideFloatingButton();
                return;
            }

            const pdfFile = (activeLeaf.view as FileView).file;
            if (!pdfFile) {
                this.hideFloatingButton();
                return;
            }

            // 切换了正在阅读的 PDF 时，清空上一文件的 Ctrl 多选缓存
            if (this.currentPdfPath !== pdfFile.path) {
                this.savedSelections = [];
                this.currentPdfPath = pdfFile.path;
            }

            const text = sel.toString().trim();
            const selectionInfo = this.getPdfSelectionInfo();
            // 定位失败（跨页/文本层未渲染/内容缺失）时 page 置 null，批注不附链接
            const entry: SavedSelectionInfo = selectionInfo
                ? { text, ...selectionInfo }
                : { text, page: null, beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 0 };

            if (evt.ctrlKey || evt.metaKey) {
                // Ctrl/Command 多选追加
                this.savedSelections.push(entry);
            } else {
                // 普通选择重置
                this.savedSelections = [entry];
            }

            if (this.savedSelections.length > 0) {
                this.showFloatingButton(evt.clientX, evt.clientY);
            }
        }, 150);
    }

    private getPdfSelectionInfo(): Omit<SavedSelectionInfo, 'text'> | null {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

        try {
            const range = sel.getRangeAt(0);

            const startPageDiv = this.findPageDiv(range.startContainer);
            const endPageDiv = this.findPageDiv(range.endContainer);
            if (!startPageDiv || !endPageDiv) return null;

            const pageNumber = parseInt(startPageDiv.dataset.pageNumber || '1');

            const startTextLayer = startPageDiv.querySelector('.textLayer');
            const endTextLayer = endPageDiv === startPageDiv
                ? startTextLayer
                : endPageDiv.querySelector('.textLayer');
            if (!startTextLayer || !endTextLayer) return null;

            const textSpans = startTextLayer.querySelectorAll('span[data-idx]');
            if (textSpans.length === 0) return null;

            const textDivFirstIdx = parseInt(
                textSpans[0].getAttribute('data-idx') || '0'
            );

            const startSpan = this.findParentTextSpan(range.startContainer, startTextLayer);
            if (!startSpan) return null;

            const endSpan = this.findParentTextSpan(range.endContainer, endTextLayer);
            if (!endSpan) return null;

            const beginIndex =
                parseInt(startSpan.getAttribute('data-idx') || '0') - textDivFirstIdx;
            const endIndex =
                parseInt(endSpan.getAttribute('data-idx') || '0') - textDivFirstIdx;

            const beginOffset = this.computeOffsetInSpan(
                startSpan, range.startContainer, range.startOffset
            );
            const endOffset = this.computeOffsetInSpan(
                endSpan, range.endContainer, range.endOffset
            );

            return { page: pageNumber, beginIndex, beginOffset, endIndex, endOffset };
        } catch (e) {
            console.error('[PdfReader] 获取PDF选择信息失败:', e);
            return null;
        }
    }

    private findPageDiv(node: Node | null): HTMLElement | null {
        while (node && node !== document) {
            const el = node as HTMLElement;
            if (el.dataset?.pageNumber !== undefined) {
                return el;
            }
            node = node.parentNode;
        }
        return null;
    }

    private findParentTextSpan(node: Node, textLayer: Element): HTMLElement | null {
        let current = node instanceof HTMLElement ? node : node.parentElement;
        while (current && current !== textLayer) {
            if (current.tagName === 'SPAN' && current.hasAttribute('data-idx')) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    private computeOffsetInSpan(
        span: HTMLElement,
        container: Node,
        offset: number
    ): number {
        if (container === span) {
            let totalOffset = 0;
            for (let i = 0; i < offset; i++) {
                const child = span.childNodes[i];
                totalOffset += child.textContent?.length || 0;
            }
            return totalOffset;
        }

        if (container.nodeType === Node.TEXT_NODE && container.parentElement === span) {
            return offset;
        }

        if (container.nodeType === Node.TEXT_NODE) {
            let current = container.parentElement;
            let totalOffset = offset;
            while (current && current !== span) {
                let sibling = current.previousSibling;
                while (sibling) {
                    totalOffset += sibling.textContent?.length || 0;
                    sibling = sibling.previousSibling;
                }
                current = current.parentElement;
            }
            return totalOffset;
        }

        return offset;
    }

    // ========== 批注写入笔记 ==========

    // ========== 截图 OCR 批注入口（供 pdf-ocr 插件调用） ==========

    /**
     * 把外部传入的文本（如截图 OCR 识别结果）作为批注写入当前 PDF 的阅读笔记。
     * 无文本层锚点（beginIndex=-1）：链接仅带页码，不生成 selection 锚点。
     * ocrRect 提供时，链接附加 &ocr=x,y,w,h（归一化矩形），供 pdf-ocr 渲染持久高亮。
     * @returns 是否成功写入（笔记创建失败返回 false）
     */
    async annotateOcrText(
        pdfFile: TFile,
        text: string,
        page: number | null,
        ocrRect?: { x: number; y: number; w: number; h: number }
    ): Promise<boolean> {
        const noteFile = await this.ensureNoteOpen(pdfFile);
        if (!noteFile) return false;
        const selections: SavedSelectionInfo[] = [{
            text,
            page,
            beginIndex: -1,
            beginOffset: 0,
            endIndex: -1,
            endOffset: 0,
            ocrRect,
        }];
        try {
            await this.appendAnnotationsToNote(noteFile, selections, pdfFile);
            return true;
        } catch (e) {
            console.error('[PdfReader] OCR 批注写入失败:', e);
            new Notice('OCR 批注写入失败');
            return false;
        }
    }

    /**
     * 把截图区域作为批注写入当前 PDF 的阅读笔记：
     * 不保存图片文件，插入 PDF 嵌入链接（![[file.pdf#page=N&rect=...]]），
     * 由 ScreenshotModule 注册的自定义 EmbedCreator 实时渲染裁剪区域。
     * @param rect PDF 空间坐标 [x1, y1, x2, y2]
     * @returns 是否成功写入
     */
    async annotateScreenshot(pdfFile: TFile, page: number, rect: number[]): Promise<boolean> {
        const noteFile = await this.ensureNoteOpen(pdfFile);
        if (!noteFile) return false;
        try {
            const rectStr = rect.join(',');
            const embedLink = `![[${pdfFile.path}#page=${page}&rect=${rectStr}]]`;
            const pageLink = `[[${pdfFile.path}#page=${page}|${pdfFile.basename}, 页面 ${page}]]`;
            const block = `> [!note] 批注\n> ${embedLink}\n> ${pageLink}\n> 笔记：`;
            const annotation = '\n' + block + '\n';
            const cursorPos = this.getNoteCursorEditorPos(noteFile);
            if (cursorPos) {
                cursorPos.editor.replaceRange(annotation, { line: cursorPos.line, ch: cursorPos.ch });
            } else {
                await this.ctx.plugin.app.vault.process(noteFile, (data) => data + annotation);
            }
            await this.focusNotePrompt(noteFile, '> 笔记：');
            return true;
        } catch (e) {
            console.error('[PdfReader] 截图批注写入失败:', e);
            new Notice('截图批注写入失败');
            return false;
        }
    }

    private async handleAnnotation() {
        if (this.savedSelections.length === 0) return;

        const activeLeaf = this.ctx.plugin.app.workspace.activeLeaf;
        if (!activeLeaf || activeLeaf.view.getViewType() !== 'pdf') return;

        const pdfFile = (activeLeaf.view as FileView).file;
        if (!pdfFile) return;

        const selections = [...this.savedSelections];
        this.savedSelections = [];

        try {
            const noteFile = await this.ensureNoteOpen(pdfFile);
            if (!noteFile) {
                this.savedSelections = selections;
                return;
            }
            await this.appendAnnotationsToNote(noteFile, selections, pdfFile);
            // 批注写入后立即刷新 PDF 持久高亮（不依赖 pdf-plus）；
            // OCR 批注无文本锚点（beginIndex < 0），跳过高亮
            this.refreshHighlights?.(
                pdfFile,
                selections.filter((sel) => sel.beginIndex >= 0)
            );
        } catch (e) {
            // 写入失败时恢复选区，避免数据丢失
            this.savedSelections = [...selections, ...this.savedSelections];
            console.error('[PdfReader] 批注写入失败，选区已恢复:', e);
        }
    }

    private async ensureNoteOpen(pdfFile: TFile): Promise<TFile | null> {
        const noteFile = await this.createReadingNote(pdfFile);
        if (!noteFile) return null;

        let existingLeaf: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof FileView && leaf.view.file && leaf.view.file.path === noteFile.path) {
                existingLeaf = leaf;
            }
        });

        if (existingLeaf) {
            this.ctx.plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
        } else {
            const pdfLeaf = this.ctx.plugin.app.workspace.activeLeaf;
            if (pdfLeaf) {
                const rightLeaf = this.ctx.plugin.app.workspace.createLeafBySplit(
                    pdfLeaf, 'vertical', false
                );
                await rightLeaf.openFile(noteFile);
                this.ctx.plugin.app.workspace.setActiveLeaf(rightLeaf, { focus: true });
            }
        }

        return noteFile;
    }

    private async appendAnnotationsToNote(
        noteFile: TFile,
        selections: SavedSelectionInfo[],
        pdfFile: TFile
    ) {
        const notePrompt = '> 笔记：';
        // 多段选中合并为一个批注 callout，每段之间空行分隔并带独立页码引用
        const items = selections.map((sel) => {
            // 拍平为单行：移除换行/回车/不可见控制字符、Unicode 换行符号，
            // 以及 PDF 私有区字符（U+E000–U+F8FF，pdfjs 对无 ToUnicode 映射的字形
            // 会回退为 PUA 码点，在编辑器中渲染为 □/⏎ 等占位符，常出现在换行处）
            const flatText = sel.text.replace(
                /[\r\n\u000B\u000C\u2028\u2029\u21B5\u23CE\u240D\u2424\u2937\u0000-\u0008\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g,
                ''
            );
            if (sel.page === null) {
                // 定位失败：仅写入文字，不生成可能跳转错误的链接
                return `> ${flatText}`;
            }
            if (sel.beginIndex < 0) {
                // 无文本锚点（如截图 OCR 批注）：仅附页码链接，不生成 selection 参数；
                // 若带 ocrRect，附加 &ocr=x,y,w,h（归一化矩形）供 pdf-ocr 渲染持久高亮
                const rectParam = sel.ocrRect
                    ? `&ocr=${fmtRectNum(sel.ocrRect.x)},${fmtRectNum(sel.ocrRect.y)},`
                    + `${fmtRectNum(sel.ocrRect.w)},${fmtRectNum(sel.ocrRect.h)}`
                    : '';
                const link =
                    `[[${pdfFile.path}#page=${sel.page}${rectParam}|${pdfFile.basename}, 页面 ${sel.page}]]`;
                return `> ${flatText}\n> ${link}`;
            }
            const selectionParam =
                `${sel.beginIndex},${sel.beginOffset},` +
                `${sel.endIndex},${sel.endOffset}`;
            const link =
                `[[${pdfFile.path}#page=${sel.page}&selection=${selectionParam}|${pdfFile.basename}, 页面 ${sel.page}]]`;
            return `> ${flatText}\n> ${link}`;
        });
        if (selections.some((sel) => sel.page === null)) {
            console.warn('[PdfReader] 部分选区定位失败，批注未附原文链接');
        }
        const block = `> [!note] 批注\n${items.join('\n> \n')}\n${notePrompt}`;
        const annotation = '\n' + block + '\n';

        // 优先经编辑器缓冲插入（缓冲与光标偏移同源，无保存竞态）；
        // 无编辑器（阅读模式/笔记未打开）时回退为追加到文末
        const cursorPos = this.getNoteCursorEditorPos(noteFile);
        if (cursorPos) {
            cursorPos.editor.replaceRange(annotation, {
                line: cursorPos.line,
                ch: cursorPos.ch,
            });
        } else {
            await this.ctx.plugin.app.vault.process(noteFile, (data) => data + annotation);
        }

        await this.focusNotePrompt(noteFile, notePrompt);
    }

    private async focusNotePrompt(noteFile: TFile, prompt: string) {
        let targetLeaf: WorkspaceLeaf | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (
                leaf.view instanceof MarkdownView &&
                leaf.view.file?.path === noteFile.path
            ) {
                targetLeaf = leaf;
            }
        });
        if (!targetLeaf) return;

        const leaf = targetLeaf as WorkspaceLeaf;
        this.ctx.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });

        const editor = (leaf.view as MarkdownView).editor;
        if (!editor) return;

        // 编辑器插入路径下内容已同步；vault.process 路径需等待编辑器刷新，
        // 轮询查找提示行（最多 250ms，命中即返回）
        for (let attempt = 0; attempt < 10; attempt++) {
            const lastLine = editor.lastLine();
            for (let line = lastLine; line >= 0; line--) {
                const text = editor.getLine(line);
                if (text.includes(prompt)) {
                    editor.setCursor({ line, ch: text.length });
                    return;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    /**
     * 获取笔记编辑器中光标位置；仅在编辑器可用（source 模式）时返回。
     * 返回 null 表示无编辑器，调用方应回退为文末追加。
     */
    private getNoteCursorEditorPos(noteFile: TFile): { editor: Editor; line: number; ch: number } | null {
        let result: { editor: Editor; line: number; ch: number } | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (result !== null) return;
            if (
                leaf.view instanceof MarkdownView &&
                leaf.view.file?.path === noteFile.path
            ) {
                const editor = leaf.view.editor;
                if (!editor) return;
                const cursor = editor.getCursor();
                result = { editor, line: cursor.line, ch: cursor.ch };
            }
        });
        return result;
    }
}

/** 归一化矩形坐标格式化为 4 位小数（去尾零），用于写入批注链接的 &ocr= 参数 */
function fmtRectNum(n: number): string {
    return Number(n.toFixed(4)).toString();
}
