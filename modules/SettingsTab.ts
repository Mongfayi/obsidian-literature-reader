import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { PluginSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { OcrService } from './OcrService';
import {
    DEFAULT_NOTE_NAME_TEMPLATE,
    isValidNameTemplate,
} from './noteNaming';

/**
 * 合并插件的统一设置面板
 *
 * 包含：PDF 阅读（笔记文件夹/命名模板/正文模板/高亮外观）、批注格式与界面开关、
 * DeepSeek 浮动窗口、截图 OCR 批注四部分，并附带功能介绍。
 */
export class UnifiedSettingTab extends PluginSettingTab {
    private getSettings: () => PluginSettings;
    private saveSettings: () => Promise<void>;
    /** 防抖保存定时器（连续输入时避免每字符一次全量写盘） */
    private saveTimer: number | null = null;

    constructor(
        app: App,
        plugin: Plugin,
        getSettings: () => PluginSettings,
        saveSettings: () => Promise<void>
    ) {
        super(app, plugin);
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;
    }

    /** 500ms 防抖后保存设置 */
    private scheduleSave(): void {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(async () => {
            this.saveTimer = null;
            try {
                await this.saveSettings();
            } catch (e) {
                console.error('[pdf-reader] 保存设置失败:', e);
            }
        }, 500);
    }

    onClose(): void {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
            // 关闭面板时冲刷未落盘的防抖保存，避免最后 500ms 内的修改静默丢失
            void this.saveSettings().catch((e) => {
                console.error('[pdf-reader] 关闭设置页时保存失败:', e);
            });
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ===== PDF 阅读设置 =====
        containerEl.createEl('h2', { text: 'PDF 阅读设置' });

        new Setting(containerEl)
            .setName('阅读笔记文件夹')
            .setDesc('新创建的阅读笔记将存放在此文件夹中（相对 vault 根目录）')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.readingNoteFolder)
                .setValue(this.getSettings().readingNoteFolder)
                .onChange(async (value) => {
                    this.getSettings().readingNoteFolder = value.trim() || DEFAULT_SETTINGS.readingNoteFolder;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('阅读笔记命名模板')
            .setDesc('新建阅读笔记的文件名规则，{name} 为 PDF 文件名（不含扩展名）。需包含 {name}，否则按默认模板处理')
            .addText((text) => text
                .setPlaceholder(DEFAULT_NOTE_NAME_TEMPLATE)
                .setValue(this.getSettings().readingNoteNameTemplate || DEFAULT_NOTE_NAME_TEMPLATE)
                .onChange(async (value) => {
                    const v = value.trim();
                    this.getSettings().readingNoteNameTemplate =
                        isValidNameTemplate(v) ? v : DEFAULT_NOTE_NAME_TEMPLATE;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('笔记正文模板')
            .setDesc('新创建阅读笔记的正文内容，可自由修改板块标题')
            .addTextArea((text) => {
                text.inputEl.rows = 4;
                text.setPlaceholder(DEFAULT_SETTINGS.readingNoteBodyTemplate)
                    .setValue(this.getSettings().readingNoteBodyTemplate)
                    .onChange(async (value) => {
                        this.getSettings().readingNoteBodyTemplate =
                            value.trim() ? value.replace(/\r\n/g, '\n') : DEFAULT_SETTINGS.readingNoteBodyTemplate;
                        this.scheduleSave();
                    });
            });

        new Setting(containerEl)
            .setName('高亮颜色')
            .setDesc('批注在 PDF 上持久高亮的填充色（文字批注与 OCR 区域高亮共用）')
            .addColorPicker((color) => color
                .setValue(this.normalizeHex(this.getSettings().highlightColor))
                .onChange(async (value) => {
                    this.getSettings().highlightColor = value;
                    // 颜色即时生效（saveSettings 内同步刷新 CSS 变量）
                    await this.saveSettings();
                }));

        new Setting(containerEl)
            .setName('高亮透明度')
            .setDesc('持久高亮的不透明度（0.05 - 1）')
            .addSlider((slider) => slider
                .setLimits(0.05, 1, 0.05)
                .setDynamicTooltip()
                .setValue(this.clampOpacity(this.getSettings().highlightOpacity))
                .onChange(async (value) => {
                    this.getSettings().highlightOpacity = value;
                    await this.saveSettings();
                }));

        // ===== 批注格式与界面 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: '批注格式与界面' });

        new Setting(containerEl)
            .setName('批注链接别名')
            .setDesc('批注回链 PDF 的链接显示文字（写入笔记正文），留空恢复默认')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.annotationLinkLabel)
                .setValue(this.getSettings().annotationLinkLabel || DEFAULT_SETTINGS.annotationLinkLabel)
                .onChange(async (value) => {
                    this.getSettings().annotationLinkLabel = value.trim() || DEFAULT_SETTINGS.annotationLinkLabel;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('批注提示行')
            .setDesc('批注 callout 末尾的提示行（写入笔记正文）；需以 > 开头，不足时自动补全')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.annotationPromptLine)
                .setValue(this.getSettings().annotationPromptLine || DEFAULT_SETTINGS.annotationPromptLine)
                .onChange(async (value) => {
                    const v = value.trim();
                    let line = v || DEFAULT_SETTINGS.annotationPromptLine;
                    if (!line.startsWith('>')) line = `> ${line}`;
                    this.getSettings().annotationPromptLine = line;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('默认附带原文')
            .setDesc('开启后工具条「附带原文」按钮初始为打开状态；用按钮切换也会被记住')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().annotationIncludeOriginalText === true)
                .onChange(async (value) => {
                    this.getSettings().annotationIncludeOriginalText = value;
                    await this.saveSettings();
                }));

        new Setting(containerEl)
            .setName('文件管理器阅读笔记标记')
            .setDesc('为已有阅读笔记的 PDF 在文件管理器中显示小图标；关闭后隐藏（任意布局变化即清空）')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().fileMarkerEnabled !== false)
                .onChange(async (value) => {
                    this.getSettings().fileMarkerEnabled = value;
                    await this.saveSettings();
                }));

        // ===== DeepSeek 设置 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: 'DeepSeek 浮动窗口设置' });
        containerEl.createEl('p', {
            text: '提示：拖动标题栏移动窗口、拖动窗口边缘可调整大小；位置与大小会自动记住。',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('DeepSeek URL')
            .setDesc('嵌入浮动窗口的 DeepSeek 网页地址，修改后需重启插件或重新打开窗口生效')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.deepseekUrl)
                .setValue(this.getSettings().deepseekUrl)
                .onChange(async (value) => {
                    this.getSettings().deepseekUrl = value || DEFAULT_SETTINGS.deepseekUrl;
                    this.scheduleSave();
                }));

        // ===== 截图 OCR 批注设置 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: '截图 OCR 批注设置' });

        new Setting(containerEl)
            .setName('LM Studio 服务器地址')
            .setDesc('OpenAI 兼容接口地址，需先启动 LM Studio 并加载视觉模型')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.ocrServerUrl)
                .setValue(this.getSettings().ocrServerUrl)
                .onChange(async (value) => {
                    this.getSettings().ocrServerUrl = value.trim() || DEFAULT_SETTINGS.ocrServerUrl;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('LM Studio API Key')
            .setDesc('LM Studio 开启 Require Authentication 时必填，与 kdata 的 token 相同。⚠️ 安全提示：密钥以明文保存在 vault 内插件目录的 data.json 中，请勿将 vault 同步/共享到不受信任的位置，并建议定期在 LM Studio 中轮换密钥；不使用鉴权时可留空。')
            .addText((text) => {
                text.inputEl.type = 'password';
                text.setPlaceholder('sk-lm-...')
                    .setValue(this.getSettings().ocrApiKey)
                    .onChange(async (value) => {
                        this.getSettings().ocrApiKey = value.trim();
                        this.scheduleSave();
                    });
            });

        new Setting(containerEl)
            .setName('OCR 模型')
            .setDesc('自由填写服务器上的视觉模型名；推荐 paddleocr-vl-1.6，留空则按此优先自动选择')
            .addText((text) => text
                .setPlaceholder('paddleocr-vl-1.6（推荐）')
                .setValue(this.getSettings().ocrModel)
                .onChange(async (value) => {
                    this.getSettings().ocrModel = value.trim();
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('请求超时（秒）')
            .setDesc('单次 OCR 请求超时时间')
            .addText((text) => text
                .setPlaceholder(String(DEFAULT_SETTINGS.ocrRequestTimeoutSec))
                .setValue(String(this.getSettings().ocrRequestTimeoutSec))
                .onChange(async (value) => {
                    const n = parseInt(value, 10);
                    if (!Number.isNaN(n) && n >= 10) {
                        this.getSettings().ocrRequestTimeoutSec = n;
                        this.scheduleSave();
                    }
                }));

        new Setting(containerEl)
            .setName('最大输出令牌')
            .setDesc('单次识别请求允许的最大输出长度（token），框选区域文本较多时可调大')
            .addText((text) => text
                .setPlaceholder(String(DEFAULT_SETTINGS.ocrMaxTokens))
                .setValue(String(this.getSettings().ocrMaxTokens))
                .onChange(async (value) => {
                    const n = parseInt(value, 10);
                    if (!Number.isNaN(n) && n >= 512) {
                        this.getSettings().ocrMaxTokens = n;
                        this.scheduleSave();
                    }
                }));

        new Setting(containerEl)
            .setName('OCR 提示词')
            .setDesc('PaddleOCR-VL 使用官方任务词（如 OCR:）')
            .addTextArea((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.ocrPrompt)
                .setValue(this.getSettings().ocrPrompt)
                .onChange(async (value) => {
                    this.getSettings().ocrPrompt = value || DEFAULT_SETTINGS.ocrPrompt;
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('清洗 OCR 输出')
            .setDesc('去除 HTML/LaTeX 包装等模型噪音；关闭后原样保留模型输出（保留 LaTeX 命令与代码块，适合公式密集场景）')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().ocrSanitizeOutput !== false)
                .onChange(async (value) => {
                    this.getSettings().ocrSanitizeOutput = value;
                    await this.saveSettings();
                }));

        new Setting(containerEl)
            .setName('放大目标短边（像素）')
            .setDesc('框选区域短边不足该值时等比放大后再送 OCR，小字更清晰；设为 0 关闭放大')
            .addText((text) => text
                .setPlaceholder(String(DEFAULT_SETTINGS.ocrMinSidePx))
                .setValue(String(this.getSettings().ocrMinSidePx ?? DEFAULT_SETTINGS.ocrMinSidePx))
                .onChange(async (value) => {
                    const n = parseInt(value, 10);
                    if (!Number.isNaN(n) && n >= 0 && n <= 4096) {
                        this.getSettings().ocrMinSidePx = n;
                        this.scheduleSave();
                    }
                }));

        new Setting(containerEl)
            .setName('放大倍率上限')
            .setDesc('小区域放大的最大倍数（1 - 8），低配设备可调低')
            .addText((text) => text
                .setPlaceholder(String(DEFAULT_SETTINGS.ocrMaxUpscaleFactor))
                .setValue(String(this.getSettings().ocrMaxUpscaleFactor ?? DEFAULT_SETTINGS.ocrMaxUpscaleFactor))
                .onChange(async (value) => {
                    const n = parseFloat(value);
                    if (!Number.isNaN(n) && n >= 1 && n <= 8) {
                        this.getSettings().ocrMaxUpscaleFactor = n;
                        this.scheduleSave();
                    }
                }));

        new Setting(containerEl)
            .setName('测试连接')
            .setDesc('检测服务器可达性并列出可用模型')
            .addButton((btn) => btn
                .setButtonText('测试连接')
                .onClick(async () => {
                    const service = new OcrService(this.getSettings().ocrServerUrl, this.getSettings().ocrApiKey);
                    btn.setButtonText('测试中…').setDisabled(true);
                    try {
                        const models = await service.listModels();
                        new Notice(`连接成功，可用模型：\n${models.join('\n')}`, 8000);
                    } catch (e) {
                        new Notice(`连接失败: ${(e as Error).message}`);
                    } finally {
                        btn.setButtonText('测试连接').setDisabled(false);
                    }
                }));

        // ===== 功能介绍 =====
        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: '功能介绍' });

        const features = [
            {
                title: '一键开始阅读',
                desc: '在文件管理器中右键 PDF 文件，选择「开始阅读」：自动在左侧打开 PDF、右侧创建/打开阅读笔记，垂直分屏布局。',
            },
            {
                title: '自动提取关键词',
                desc: '首次创建阅读笔记时，自动从 PDF 中提取「关键词：xxx；xxx」并写入笔记的 YAML frontmatter，生成 Obsidian 标签。',
            },
            {
                title: '批注到笔记',
                desc: '阅读 PDF 时选中文字，点击浮动按钮「批注到笔记」将选中内容（含页码链接）追加到阅读笔记中。按住 Ctrl/Command 键可选择多段不连续文字，一次性批量批注。',
            },
            {
                title: 'DeepSeek 浮动窗口',
                desc: '点击左侧栏机器人图标或执行命令「切换 DeepSeek 浮动窗口」，以浮动窗口形式嵌入 DeepSeek 网页聊天，支持标题栏拖拽移动、拖动边缘调整大小与最小化，位置和大小自动记忆。',
            },
            {
                title: '上传当前文件到 DeepSeek',
                desc: '在 DeepSeek 浮动窗口标题栏点击「加载文件」按钮，或执行命令「将当前阅读文件上传到 DeepSeek 聊天框」，将当前正在阅读的 PDF 或 Markdown 笔记自动上传到 DeepSeek 聊天框（上限 100MB），便于直接与 AI 讨论。',
            },
            {
                title: '截图 OCR 批注',
                desc: '在 PDF 视图工具条点「截图 OCR 批注」按钮（crop 图标），拖拽框选区域，用 LM Studio 视觉模型识别文字并作为批注写入阅读笔记（含页码与区域链接），批注区域在 PDF 上持久高亮。适合扫描版/无文本层 PDF。',
            },
        ];

        for (const feature of features) {
            const itemEl = containerEl.createDiv();
            itemEl.style.marginBottom = '16px';
            itemEl.style.padding = '12px';
            itemEl.style.borderRadius = '8px';
            itemEl.style.backgroundColor = 'var(--background-secondary)';
            itemEl.style.border = '1px solid var(--background-modifier-border)';

            itemEl.createEl('strong', { text: feature.title });
            itemEl.createEl('br');
            itemEl.createSpan({ text: feature.desc, cls: 'setting-item-description' });
        }
    }

    /** 把任意存量颜色值规范成 #RRGGBB 供取色器显示（非法值回退默认黄色） */
    private normalizeHex(input: string): string {
        const m = /^#?([0-9a-fA-F]{6})$/.exec((input ?? '').trim());
        return m ? `#${m[1]}` : DEFAULT_SETTINGS.highlightColor;
    }

    private clampOpacity(v: number): number {
        const n = Number(v);
        if (!Number.isFinite(n)) return DEFAULT_SETTINGS.highlightOpacity;
        return Math.min(1, Math.max(0.05, n));
    }
}
