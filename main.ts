import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type PluginSettings, type PluginModule, type ModuleContext } from './types';
import { PdfReaderModule } from './modules/PdfReaderModule';
import { DeepSeekModule } from './modules/DeepSeekModule';
import { PdfHighlightModule } from './modules/PdfHighlightModule';
import { ScreenshotModule } from './modules/ScreenshotModule';
import { UnifiedSettingTab } from './modules/SettingsTab';

/**
 * 文献阅读助手（合并插件）
 *
 * 由原 pdf-reader 与 deepseek-sidebar 合并而来，包含两大功能模块：
 *  1. PdfReaderModule —— PDF 一键阅读、关键词提取、批注到笔记
 *  2. DeepSeekModule  —— DeepSeek 浮动窗口（可拖拽、最小化）
 *
 * 本类仅负责设置加载、模块编排与生命周期管理，具体功能下沉到各模块。
 */
export default class LiteratureReaderPlugin extends Plugin {
    private settings: PluginSettings = DEFAULT_SETTINGS;
    private modules: PluginModule[] = [];
    /** 公开 PDF 模块实例，供 pdf-ocr 等插件调用批注 API */
    pdfModule: PdfReaderModule | null = null;

    async onload() {
        await this.loadSettings();

        const ctx: ModuleContext = {
            plugin: this,
            getSettings: () => this.settings,
            saveSettings: () => this.saveSettings(),
        };

        // PDF 模块先行创建，以便将其 getCurrentFileForUpload 注入 DeepSeek 模块上下文
        const pdfModule = new PdfReaderModule(ctx);
        this.pdfModule = pdfModule;

        // PDF 高亮模块：批注后即时高亮 + 笔记链接驱动的高亮重建
        const highlightModule = new PdfHighlightModule(ctx);
        pdfModule.setRefreshHighlights((file, selections) => highlightModule.refresh(file, selections));

        // 截图批注模块：框选 PDF 区域 → 截图保存为附件 → 嵌入阅读笔记
        const screenshotModule = new ScreenshotModule(ctx, pdfModule);

        const deepseekCtx: ModuleContext = {
            ...ctx,
            getCurrentFileForUpload: () => pdfModule.getCurrentFileForUpload(),
        };

        // 注册功能模块
        this.modules = [
            pdfModule,
            highlightModule,
            screenshotModule,
            new DeepSeekModule(deepseekCtx),
        ];

        for (const mod of this.modules) {
            mod.load();
        }

        // 统一设置面板
        this.addSettingTab(
            new UnifiedSettingTab(this.app, this, ctx.getSettings, ctx.saveSettings)
        );
    }

    onunload() {
        // 逆序卸载，保证后注册的模块先清理
        for (let i = this.modules.length - 1; i >= 0; i--) {
            try {
                this.modules[i].unload();
            } catch (e) {
                console.error('[LiteratureReader] 模块卸载失败:', e);
            }
        }
        this.modules = [];
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
