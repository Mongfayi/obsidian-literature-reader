import { TFile, WorkspaceLeaf, FileView, setIcon, setTooltip } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';

/**
 * 主文献批注汇集模块
 *
 * 在每个 PDF 视图工具条注入「主文献」切换按钮。将某篇 PDF 设为主文献后，
 * 无论从哪篇 PDF 批注（文字选中 / 截图 / OCR），批注内容都写入主文献对应的阅读笔记；
 * 批注 callout 内的原文链接仍指向被批注的源 PDF（由 PdfReaderModule 构造），点击可跳回源页。
 *
 * 状态为会话级（内存），重载插件自动清除。
 *
 * 工具条按钮注入范式与 ScreenshotModule / OcrModule 一致：
 *  监听 layout-change / active-leaf-change + 2s 轮询兜底，经 viewer.child.toolbar.pageNumberEl.after(btn) 插入。
 */
export class MainArticleModule implements PluginModule {
    private ctx: ModuleContext;
    private pdfModule: PdfReaderModule;

    /** 当前主文献 PDF 路径（null = 未设置，批注走默认逻辑写入源 PDF 对应笔记） */
    private mainArticlePdfPath: string | null = null;
    /** 已注入按钮的叶子 → 按钮元素 */
    private toolbarButtons = new Map<WorkspaceLeaf, HTMLElement>();
    /** 工具条注入轮询定时器 */
    private injectionTimer: number | null = null;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        // 向 PdfReaderModule 注入重定向解析器：批注入口询问主文献笔记
        this.pdfModule.setRedirectResolver(() => this.resolveMainArticleNote());

        plugin.registerEvent(
            plugin.app.workspace.on('layout-change', () => {
                this.injectToolbarButtons();
                this.refreshAllButtonStates();
            })
        );
        plugin.registerEvent(
            plugin.app.workspace.on('active-leaf-change', () => {
                this.injectToolbarButtons();
                this.refreshAllButtonStates();
            })
        );

        // PDF 视图可能被重建，事件驱动注入不可靠，用轻量定时轮询兜底（幂等）
        this.injectionTimer = window.setInterval(() => this.injectToolbarButtons(), 2000);

        plugin.addCommand({
            id: 'toggle-main-article',
            name: '设为/取消主文献（批注汇集到本篇笔记）',
            checkCallback: (checking) => {
                const leaf = plugin.app.workspace.activeLeaf;
                if (!leaf || leaf.view.getViewType() !== 'pdf') return false;
                const file = (leaf.view as FileView).file;
                if (!file) return false;
                if (!checking) this.toggleMainArticle(file);
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
        this.toolbarButtons.clear();
        this.mainArticlePdfPath = null;
    }

    // ========== 主文献状态 ==========

    /**
     * 解析主文献对应的阅读笔记（已存在则返回，否则由 PdfReaderModule 创建）。
     * 未设主文献 / 主文献 PDF 已失效时返回 null，调用方回退默认逻辑。
     */
    private async resolveMainArticleNote(): Promise<TFile | null> {
        if (!this.mainArticlePdfPath) return null;
        const pdfFile = this.ctx.plugin.app.vault.getAbstractFileByPath(this.mainArticlePdfPath);
        if (!(pdfFile instanceof TFile)) return null;
        return await this.pdfModule.createReadingNote(pdfFile);
    }

    /** 切换主文献：同路径 → 取消；否则设为新主文献（替换原值）。反馈仅靠按钮高亮 + tooltip 变化 */
    private toggleMainArticle(pdfFile: TFile): void {
        if (this.mainArticlePdfPath === pdfFile.path) {
            this.mainArticlePdfPath = null;
        } else {
            this.mainArticlePdfPath = pdfFile.path;
        }
        this.refreshAllButtonStates();
    }

    // ========== 工具条按钮 ==========

    private injectToolbarButtons(): void {
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;

            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            if (!toolbar) return; // 轮询会重试

            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 以「当前工具条上是否已有按钮」为准，避免重建后重复注入
            if (pageNumberEl.parentElement.querySelector('.pdfreader-main-article-button')) return;

            const btn = document.createElement('div');
            btn.addClass('clickable-icon');
            btn.addClass('pdfreader-main-article-button');
            setIcon(btn, 'bookmark');
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                const currentFile = (leaf.view as FileView).file;
                if (currentFile) this.toggleMainArticle(currentFile);
            });

            pageNumberEl.after(btn);

            this.toolbarButtons.set(leaf, btn);
            this.applyButtonState(leaf, btn);
            this.ctx.plugin.register(() => {
                btn.remove();
                this.toolbarButtons.delete(leaf);
            });
        });
    }

    /** 切换主文献 / 叶子文件切换后重算所有按钮激活态 */
    private refreshAllButtonStates(): void {
        this.toolbarButtons.forEach((btn, leaf) => {
            this.applyButtonState(leaf, btn);
        });
    }

    /** 按「该叶子当前 PDF 是否为主文献」切换激活态与提示文案 */
    private applyButtonState(leaf: WorkspaceLeaf, btn: HTMLElement): void {
        const file = (leaf.view as FileView)?.file;
        const isMain = !!file && this.mainArticlePdfPath === file.path;
        btn.toggleClass('is-active', isMain);
        if (isMain) {
            setTooltip(btn, '主文献已开启（点击取消）\n批注将汇集到本篇笔记');
        } else {
            setTooltip(btn, '设为主文献：批注汇集到本篇笔记');
        }
    }
}
