import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { PluginSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';

/**
 * 合并插件的统一设置面板
 *
 * 将原 pdf-reader 的「阅读笔记文件夹」与原 deepseek-sidebar 的「DeepSeek URL」
 * 合并到一个设置页，并附带功能介绍。
 */
export class UnifiedSettingTab extends PluginSettingTab {
    private getSettings: () => PluginSettings;
    private saveSettings: () => Promise<void>;

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
                    await this.saveSettings();
                }));

        // ===== DeepSeek 设置 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: 'DeepSeek 浮动窗口设置' });

        new Setting(containerEl)
            .setName('DeepSeek URL')
            .setDesc('嵌入浮动窗口的 DeepSeek 网页地址，修改后需重启插件或重新打开窗口生效')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.deepseekUrl)
                .setValue(this.getSettings().deepseekUrl)
                .onChange(async (value) => {
                    this.getSettings().deepseekUrl = value || DEFAULT_SETTINGS.deepseekUrl;
                    await this.saveSettings();
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
                desc: '点击左侧栏机器人图标或执行命令「切换 DeepSeek 浮动窗口」，以浮动窗口形式嵌入 DeepSeek 网页聊天，支持标题栏拖拽移动与最小化。',
            },
            {
                title: '上传当前文件到 DeepSeek',
                desc: '在 DeepSeek 浮动窗口标题栏点击「加载文件」按钮，或执行命令「将当前阅读文件上传到 DeepSeek 聊天框」，将当前正在阅读的 PDF 或 Markdown 笔记自动上传到 DeepSeek 聊天框（上限 100MB），便于直接与 AI 讨论。',
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
}
