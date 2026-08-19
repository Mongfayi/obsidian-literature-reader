import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type PluginSettings, type PluginModule, type ModuleContext } from './types';
import { PdfReaderModule } from './modules/PdfReaderModule';
import { DeepSeekModule } from './modules/DeepSeekModule';
import { PdfHighlightModule } from './modules/PdfHighlightModule';
import { ScreenshotModule } from './modules/ScreenshotModule';
import { OcrModule } from './modules/OcrModule';
import { OcrHighlightModule } from './modules/OcrHighlightModule';
import { MainArticleModule } from './modules/MainArticleModule';
import { AnnotationModeModule } from './modules/AnnotationModeModule';
import { PdfJumpModule } from './modules/PdfJumpModule';
import { ReadingNoteMarkerModule } from './modules/ReadingNoteMarkerModule';
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

        // OCR 高亮模块：OCR 批注后即时高亮 + 笔记链接驱动的高亮重建
        const ocrHighlightModule = new OcrHighlightModule(ctx);
        // 截图 OCR 批注模块：框选 PDF 区域 → LM Studio 视觉模型识别文字 → 写入阅读笔记
        const ocrModule = new OcrModule(ctx, pdfModule);
        ocrModule.setHighlightRefresh((file, entries) => ocrHighlightModule.refresh(file, entries));

        // 主文献模块：工具条「主文献」按钮，开启后所有 PDF 批注汇集到主文献笔记
        const mainArticleModule = new MainArticleModule(ctx, pdfModule);

        // 批注原文附带模式模块（测试功能，以后可能删除）：工具条「附带原文」按钮，
        // 默认关闭 = 文字选中批注只写 PDF 链接不附带原文；不影响 OCR / 截图批注
        const annotationModeModule = new AnnotationModeModule(ctx, pdfModule);

        // 双向跳转模块：点击 PDF 高亮 → 笔记对应批注；点击笔记 PDF 链接 → PDF 对应位置
        // （目标未打开时在笔记左侧 / PDF 右侧分屏打开，不在焦点叶子直接打开）
        const jumpModule = new PdfJumpModule(ctx);

        // 文件管理器标记模块：为已有阅读笔记的 PDF 在左侧文件管理器中显示小图标
        const readingNoteMarkerModule = new ReadingNoteMarkerModule(ctx);

        const deepseekCtx: ModuleContext = {
            ...ctx,
            getCurrentFileForUpload: () => pdfModule.getCurrentFileForUpload(),
        };

        // 注册功能模块
        this.modules = [
            pdfModule,
            annotationModeModule,
            mainArticleModule,
            highlightModule,
            screenshotModule,
            ocrHighlightModule,
            ocrModule,
            jumpModule,
            readingNoteMarkerModule,
            new DeepSeekModule(deepseekCtx),
        ];

        for (const mod of this.modules) {
            // 单个模块加载失败不拖垮其余模块（如依赖未公开 API 在个别版本缺失时），
            // 失败由模块内或此处兜底，保证后续模块与设置面板仍可用
            try {
                mod.load();
            } catch (e) {
                console.error('[LiteratureReader] 模块加载失败:', e);
            }
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
