import { WorkspaceLeaf, FileView, setIcon, setTooltip } from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';
import { toolbarPoller, pruneStaleLeaves } from './toolbarPoller';

/**
 * 批注原文附带模式模块（测试功能，以后可能删除）
 *
 * 在每个 PDF 视图工具条注入「附带原文」切换按钮，默认关闭：
 *  - 关闭（默认）：文字选中批注只写 PDF 链接，不附带原文，如
 *    [[essay/xxx.pdf#page=45&selection=1903,0,1940,0|xxx, 页面 45]]
 *  - 开启：批注附带原文（历史行为）
 *
 * 该开关只影响「文字选中批注」（有文本层锚点 beginIndex>=0 的选区）；
 * OCR 批注（beginIndex<0）与截图批注的写入格式不受影响。
 *
 * 状态为会话级（内存），重载插件自动复位为默认关闭。
 *
 * 工具条按钮注入范式与 MainArticleModule 一致：
 *  监听 layout-change / active-leaf-change + 2s 轮询兜底，经 viewer.child.toolbar.pageNumberEl.after(btn) 插入。
 */
export class AnnotationModeModule implements PluginModule {
    private ctx: ModuleContext;
    private pdfModule: PdfReaderModule;

    /** 「附带原文」开关：true = 批注附带原文；false（默认）= 批注只写链接 */
    private includeOriginalText = false;
    /** 已注入按钮的叶子 → 按钮元素 */
    private toolbarButtons = new Map<WorkspaceLeaf, HTMLElement>();
    /** 本模块创建过的全部按钮（含多标签页下未进 map 的隐藏按钮），用于卸载清理 */
    private createdButtons = new Set<HTMLElement>();
    /** 轮询任务移除函数（卸载时注销共享轮询） */
    private removePollTask: (() => void) | null = null;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        // 向 PdfReaderModule 注入原文附带模式提供者：批注入口按当前开关决定是否写原文
        this.pdfModule.setIncludeOriginalTextProvider(() => this.includeOriginalText);

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

        // PDF 视图可能被重建，事件驱动注入不可靠，用轻量定时轮询兜底（幂等）；
        // 与截图/OCR/主文献模块共享同一轮询器
        this.removePollTask = toolbarPoller.add(() => {
            this.injectToolbarButtons();
            this.refreshAllButtonStates();
        });
        toolbarPoller.start();

        plugin.addCommand({
            id: 'toggle-include-original-text',
            name: '切换「附带原文」批注模式（默认关闭；关闭时批注只写 PDF 链接）',
            checkCallback: (checking) => {
                const leaf = plugin.app.workspace.activeLeaf;
                if (!leaf || leaf.view.getViewType() !== 'pdf') return false;
                if (!checking) this.toggleMode();
                return true;
            },
        });

        this.injectToolbarButtons();

        // 卸载时统一移除所有已注入按钮（单次注册，避免每次注入都累积一个清理闭包）；
        // 用 createdButtons 覆盖多标签页下未进 map 的隐藏按钮
        plugin.register(() => {
            for (const btn of this.createdButtons) {
                btn.remove();
            }
            this.createdButtons.clear();
            this.toolbarButtons.clear();
        });
    }

    unload(): void {
        this.removePollTask?.();
        this.removePollTask = null;
        this.toolbarButtons.clear();
        this.createdButtons.clear();
        this.includeOriginalText = false;
    }

    // ========== 模式状态 ==========

    /** 切换「附带原文」开关并刷新所有按钮激活态 */
    private toggleMode(): void {
        this.includeOriginalText = !this.includeOriginalText;
        this.refreshAllButtonStates();
    }

    // ========== 工具条按钮 ==========

    private injectToolbarButtons(): void {
        // 清理已关闭叶子的陈旧按钮缓存
        pruneStaleLeaves(this.ctx.plugin.app, this.toolbarButtons);

        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;

            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            if (!toolbar) return; // 轮询会重试

            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 以「当前工具条上是否已有按钮」为准，避免重建后重复注入。
            // 注意：同一叶子可含多个 PDF 标签页、各自有工具条按钮；命中已有按钮时
            // 必须把 map 重指到当前可见按钮，否则状态刷新会作用到隐藏标签页的按钮上
            // （点击功能正常但外观不更新）
            const existing = pageNumberEl.parentElement.querySelector<HTMLElement>('.pdfreader-annotation-mode-button');
            if (existing) {
                this.toolbarButtons.set(leaf, existing);
                return;
            }

            // 工具条重建后旧按钮已脱离 DOM：清掉缓存引用，避免闭包与脏引用累积
            const stale = this.toolbarButtons.get(leaf);
            if (stale && !stale.isConnected) {
                stale.remove();
                this.toolbarButtons.delete(leaf);
            }

            const btn = document.createElement('div');
            btn.addClass('clickable-icon');
            btn.addClass('pdfreader-annotation-mode-button');
            setIcon(btn, 'link');
            btn.createSpan({ text: '附带原文' });
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                this.toggleMode();
            });

            pageNumberEl.after(btn);

            this.toolbarButtons.set(leaf, btn);
            this.createdButtons.add(btn);
            this.applyButtonState(btn);
        });
    }

    /**
     * 重算所有按钮激活态（开关切换 / 工具条重建后）：
     * 直接扫描各叶子当前可见工具条上的按钮，不依赖可能指向隐藏标签页按钮的 map。
     */
    private refreshAllButtonStates(): void {
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;
            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            const pageNumberEl = toolbar?.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl?.parentElement) return;
            const btn = pageNumberEl.parentElement.querySelector<HTMLElement>('.pdfreader-annotation-mode-button');
            if (btn) this.applyButtonState(btn);
        });
    }

    /** 按当前开关切换激活态与提示文案 */
    private applyButtonState(btn: HTMLElement): void {
        const on = this.includeOriginalText;
        btn.toggleClass('is-active', on);
        if (on) {
            setTooltip(btn, '附带原文已开启（点击关闭）\n批注将包含原文文字');
        } else {
            setTooltip(btn, '附带原文已关闭（默认，点击开启）\n批注只写 PDF 链接，不附带原文');
        }
    }
}
