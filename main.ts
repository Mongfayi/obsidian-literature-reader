import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type PluginSettings, type PluginModule, type ModuleContext } from './types';
import { PdfReaderModule } from './modules/PdfReaderModule';
import { MarkdownReadingModule } from './modules/MarkdownReadingModule';
import { DeepSeekModule } from './modules/DeepSeekModule';
import { PdfHighlightModule } from './modules/PdfHighlightModule';
import { ScreenshotModule } from './modules/ScreenshotModule';
import { ScreenshotHighlightModule } from './modules/ScreenshotHighlightModule';
import { OcrModule } from './modules/OcrModule';
import { OcrHighlightModule } from './modules/OcrHighlightModule';
import { AnnotationModeModule } from './modules/AnnotationModeModule';
import { CalloutPasteModule } from './modules/CalloutPasteModule';
import { QuickTagModule } from './modules/QuickTagModule';
import { TagSyncModule } from './modules/TagSyncModule';
import { PdfJumpModule } from './modules/PdfJumpModule';
import { ReadingNoteMarkerModule } from './modules/ReadingNoteMarkerModule';
import { WordCountFixModule } from './modules/WordCountFixModule';
import { SearchEnhancementModule } from './modules/SearchEnhancementModule';
import { UnifiedSettingTab } from './modules/SettingsTab';
import { NoteContentCache } from './modules/noteContentCache';
import { toolbarPoller } from './modules/toolbarPoller';

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

        // 共享笔记内容缓存：高亮/跳转模块的索引重建共用一次笔记读取
        const noteContentCache = new NoteContentCache(this);
        noteContentCache.attach();

        // 工具条轮询门控：没有打开的 PDF 视图或窗口隐藏时跳过轮询任务，空闲零开销
        toolbarPoller.setGate(() => {
            let hasPdfLeaf = false;
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (!hasPdfLeaf && leaf.view.getViewType() === 'pdf') hasPdfLeaf = true;
            });
            return hasPdfLeaf;
        });

        const ctx: ModuleContext = {
            plugin: this,
            getSettings: () => this.settings,
            saveSettings: () => this.saveSettings(),
            readNoteContent: (file) => noteContentCache.read(file),
        };

        // PDF 模块先行创建，以便将其 getCurrentFileForUpload 注入 DeepSeek 模块上下文
        const pdfModule = new PdfReaderModule(ctx);
        this.pdfModule = pdfModule;

        // 快速标签模块：PDF / Markdown 工具条「标签」按钮 / 快捷键，把设置的标签插入笔记光标处
        const quickTagModule = new QuickTagModule(ctx, pdfModule);

        // Markdown 批注模块：会话级“正在阅读”标记、编辑器顶部工具栏、选中文字浮动批注按钮
        const markdownReadingModule = new MarkdownReadingModule(ctx, pdfModule, quickTagModule);
        // 右键 md →「开始阅读」时，把左边那篇被当作文献阅读的 md 标记为批注来源
        pdfModule.setReadingSourceProvider((path) => markdownReadingModule.setReadingSource(path));

        // PDF 高亮模块：批注后即时高亮 + 笔记链接驱动的高亮重建
        const highlightModule = new PdfHighlightModule(ctx);
        pdfModule.setRefreshHighlights((file, selections) => highlightModule.refresh(file, selections));

        // 截图批注模块：框选 PDF 区域 → 截图保存为附件 → 嵌入阅读笔记
        const screenshotModule = new ScreenshotModule(ctx, pdfModule);

        // 截图批注高亮模块：批注后即时高亮 + 笔记 &rect= 链接驱动的高亮重建
        const screenshotHighlightModule = new ScreenshotHighlightModule(ctx);
        screenshotModule.setHighlightRefresh((file, entries) => screenshotHighlightModule.refresh(file, entries));

        // OCR 高亮模块：OCR 批注后即时高亮 + 笔记链接驱动的高亮重建
        const ocrHighlightModule = new OcrHighlightModule(ctx);
        // 无文本锚点的文字批注（如标题）回退为矩形高亮，也复用 OCR 高亮通道即时刷新
        pdfModule.setRefreshRectHighlights((file, entries) => ocrHighlightModule.refresh(file, entries));
        // 截图 OCR 批注模块：框选 PDF 区域 → LM Studio 视觉模型识别文字 → 写入阅读笔记
        const ocrModule = new OcrModule(ctx, pdfModule);
        ocrModule.setHighlightRefresh((file, entries) => ocrHighlightModule.refresh(file, entries));

        // 主文献模块已移除：批注落点改为跟随光标（PdfReaderModule.getCursorNotePos），
        // 「把多篇 PDF 的批注汇集到同一篇笔记」现在只需把那篇笔记保持在编辑状态

        // 批注原文附带模式模块（测试功能，以后可能删除）：工具条「附带原文」按钮。
        // 默认关闭 = 文字批注只写定位、OCR 只写识别文字、截图只写图片；开启后三种批注都附带定位与笔记提示
        const annotationModeModule = new AnnotationModeModule(ctx, pdfModule);

        // 批注 callout 粘贴修正：在「笔记：」处粘贴多段文本时自动补 "> " 前缀，保持内容留在蓝框内
        const calloutPasteModule = new CalloutPasteModule(ctx);

        // 标签同步模块：把词表改名/删除落到笔记正文（含逐行预览与二次确认；不提供撤销）
        const tagSyncModule = new TagSyncModule(ctx);

        // 双向跳转模块：点击 PDF 高亮 → 笔记对应批注；点击笔记 PDF 链接 → PDF 对应位置
        // （目标未打开时在笔记左侧 / PDF 右侧分屏打开，不在焦点叶子直接打开）
        const jumpModule = new PdfJumpModule(ctx);

        // 文件管理器标记模块：为已有阅读笔记的 PDF 在左侧文件管理器中显示小图标
        const readingNoteMarkerModule = new ReadingNoteMarkerModule(ctx);

        // 字数统计修正模块：状态栏词数不计图片嵌入、链接与 base64 数据（口径与原生一致）
        const wordCountFixModule = new WordCountFixModule(ctx);

        // 搜索增强模块：核心搜索行为增强（忽略链接等子功能），设置键按子功能独立扩展
        const searchEnhancementModule = new SearchEnhancementModule(ctx);

        const deepseekCtx: ModuleContext = {
            ...ctx,
            getCurrentFileForUpload: () => pdfModule.getCurrentFileForUpload(),
        };

        // 注册功能模块
        this.modules = [
            pdfModule,
            markdownReadingModule,
            annotationModeModule,
            calloutPasteModule,
            quickTagModule,
            tagSyncModule,
            highlightModule,
            screenshotModule,
            screenshotHighlightModule,
            ocrHighlightModule,
            ocrModule,
            jumpModule,
            readingNoteMarkerModule,
            wordCountFixModule,
            searchEnhancementModule,
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

        // 统一设置面板（传入搜索增强模块，设置页开关与搜索面板开关互相同步）
        this.addSettingTab(
            new UnifiedSettingTab(
                this.app,
                this,
                ctx.getSettings,
                ctx.saveSettings,
                searchEnhancementModule,
                tagSyncModule,
                wordCountFixModule
            )
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
        this.applyHighlightStyle();
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // 高亮外观即时生效：设置面板/批注按钮等任何保存动作都同步刷新 CSS 变量
        this.applyHighlightStyle();
    }

    /**
     * 把高亮颜色/透明度写入 body 级 CSS 变量，styles.css 中的持久高亮规则引用它们。
     * 颜色转为 "R, G, B" 三元组以便在 rgba() 中复用（文字填充、OCR 边框/填充）。
     */
    private applyHighlightStyle(): void {
        const body = document.body;
        const opacity = Math.min(1, Math.max(0, Number(this.settings.highlightOpacity)));
        if (Number.isFinite(opacity)) {
            body.style.setProperty('--pdf-reader-highlight-opacity', String(opacity));
            // OCR 区域边框透明度：在填充基础上略加深保证可见
            body.style.setProperty(
                '--pdf-reader-highlight-border-opacity',
                String(Math.min(1, opacity + 0.2))
            );
        } else {
            body.style.removeProperty('--pdf-reader-highlight-opacity');
            body.style.removeProperty('--pdf-reader-highlight-border-opacity');
        }
        const rgb = hexToRgbTriplet(this.settings.highlightColor);
        if (rgb) {
            body.style.setProperty('--pdf-reader-highlight-rgb', rgb);
        } else {
            // 无效颜色：移除变量，回退到主题高亮色 --text-highlight-bg-rgb
            body.style.removeProperty('--pdf-reader-highlight-rgb');
        }
    }
}

/** #RRGGBB → "R, G, B" 三元组；非法输入返回 null */
function hexToRgbTriplet(input: string): string | null {
    const m = /^#?([0-9a-fA-F]{6})$/.exec((input ?? '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
