import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { DeepSeekOpenMode, PluginSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { OcrService } from './OcrService';
import { findDuplicateName, moveTag, newTagId, removeTag, renameTag } from './tagVocabulary';
import type { TagSyncModule } from './TagSyncModule';
import type { WordCountFixModule } from './WordCountFixModule';
import {
    DEFAULT_NOTE_NAME_TEMPLATE,
    isValidNameTemplate,
    sanitizeLinkAlias,
} from './noteNaming';

/** 搜索增强模块暴露给设置页的最小接口（开关状态同步） */
interface SearchEnhancementSync {
    syncToggles(value: boolean): void;
}

/**
 * 合并插件的统一设置面板
 *
 * 包含：PDF 阅读（笔记文件夹/命名模板/正文模板/高亮外观）、批注格式与界面、
 * 搜索增强、DeepSeek 窗口、截图 OCR 批注等部分。
 */
export class UnifiedSettingTab extends PluginSettingTab {
    private getSettings: () => PluginSettings;
    private saveSettings: () => Promise<void>;
    /** 搜索增强模块（可选，用于设置页开关与搜索面板开关互相同步） */
    private searchEnhancement?: SearchEnhancementSync;
    /** 标签同步模块（可选，用于渲染待同步变更与删除/撤销入口） */
    private tagSync?: TagSyncModule;
    /** 字数统计修正模块（可选，用于开关切换时立即生效/还原） */
    private wordCountFix?: WordCountFixModule;
    /** 防抖保存定时器（连续输入时避免每字符一次全量写盘） */
    private saveTimer: number | null = null;

    constructor(
        app: App,
        plugin: Plugin,
        getSettings: () => PluginSettings,
        saveSettings: () => Promise<void>,
        searchEnhancement?: SearchEnhancementSync,
        tagSync?: TagSyncModule,
        wordCountFix?: WordCountFixModule
    ) {
        super(app, plugin);
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;
        this.searchEnhancement = searchEnhancement;
        this.tagSync = tagSync;
        this.wordCountFix = wordCountFix;
    }

    /**
     * 落盘并如实反馈失败。
     *
     * 标签管理里的增删改名（↑ / ↓ / ✕ / 添加）此前都是 `void this.saveSettings()`，
     * 写盘失败（同步盘冲突、磁盘满、data.json 只读）时既不提示也不重绘，
     * 用户以为改好了，下次打开设置又回到旧值 —— 改动静默丢失。
     */
    private async persist(): Promise<void> {
        try {
            await this.saveSettings();
        } catch (e) {
            console.error('[pdf-reader] 保存设置失败:', e);
            new Notice('设置保存失败，改动未写入磁盘，请检查 data.json 是否可写', 8000);
        }
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
                new Notice('设置保存失败，改动未写入磁盘，请检查 data.json 是否可写', 8000);
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

    /**
     * 渲染标签行编辑器：名称 + 描述 + 上移/下移/删除。
     *
     * 名称输入即调用 renameTag() 登记待同步改名 —— 因为每条标签都有永不改变的 id，
     * 「哪个标签改名了」是界面操作的记录，不需要任何推断，也就没有歧义。
     */
    private renderTagEditor(rowsHost: HTMLElement, pendingHost: HTMLElement): void {
        rowsHost.empty();
        const settings = this.getSettings();
        const rows = rowsHost.createDiv({ cls: 'pdfreader-tag-rows' });

        for (const tag of settings.quickTags) {
            const id = tag.id;
            const row = rows.createDiv({ cls: 'pdfreader-tag-row' });
            row.createSpan({ cls: 'pdfreader-tag-hash', text: '#' });

            const nameInput = row.createEl('input', { type: 'text', cls: 'pdfreader-tag-name' });
            nameInput.value = tag.name;
            nameInput.placeholder = '标签名';

            const descInput = row.createEl('input', { type: 'text', cls: 'pdfreader-tag-desc' });
            descInput.value = tag.description;
            descInput.placeholder = '描述（可留空）';

            // 名称：输入即登记待同步改名。注意 renameTag 会返回新数组，
            // 因此后续一律按 id 重新查找，不能持有 tag 引用
            nameInput.addEventListener('input', () => {
                const s = this.getSettings();
                const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, nameInput.value);
                s.quickTags = r.tags;
                s.pendingTagRenames = r.pending;
                this.renderPendingRenames(pendingHost);
                this.scheduleSave();
            });

            // 名称：失焦时做有效性校验，非法（空/重名）则回退到旧名
            nameInput.addEventListener('blur', () => {
                const s = this.getSettings();
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.value = this.revertTagName(id, tag.name);
                    new Notice('标签名不能为空，已还原');
                } else if (findDuplicateName(s.quickTags, name, id)) {
                    nameInput.value = this.revertTagName(id, tag.name);
                    new Notice(`已存在同名标签「${name}」，已还原`);
                } else {
                    // 用 trim 后的名字**重新登记一次**：input 事件里登记的是未规范化的原始值，
                    // 若只改词表名，pending 里的 to 会残留首尾空白，同步时会写出 `# 名`
                    // —— `#` 后跟空格在 Obsidian 里不是标签，词表与笔记就此不一致
                    const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, name);
                    s.quickTags = r.tags;
                    s.pendingTagRenames = r.pending;
                    if (nameInput.value !== name) nameInput.value = name;
                }
                this.renderPendingRenames(pendingHost);
                void this.persist();
            });

            descInput.addEventListener('input', () => {
                const cur = this.getSettings().quickTags.find((t) => t.id === id);
                if (cur) cur.description = descInput.value;
                this.scheduleSave();
            });

            const buttons = row.createDiv({ cls: 'pdfreader-tag-row-buttons' });
            const up = buttons.createEl('button', { cls: 'pdfreader-tag-icon-btn', text: '↑' });
            up.setAttribute('aria-label', '上移');
            up.disabled = settings.quickTags[0]?.id === id;
            up.addEventListener('click', () => {
                this.getSettings().quickTags = moveTag(this.getSettings().quickTags, id, -1);
                void this.persist().then(() => this.display());
            });

            const down = buttons.createEl('button', { cls: 'pdfreader-tag-icon-btn', text: '↓' });
            down.setAttribute('aria-label', '下移');
            down.disabled = settings.quickTags[settings.quickTags.length - 1]?.id === id;
            down.addEventListener('click', () => {
                this.getSettings().quickTags = moveTag(this.getSettings().quickTags, id, 1);
                void this.persist().then(() => this.display());
            });

            const del = buttons.createEl('button', { cls: 'pdfreader-tag-icon-btn is-danger', text: '✕' });
            del.setAttribute('aria-label', '删除标签');
            // 只捕获 id，名字在点击时按 id 现查：渲染期间用户可能改过名，
            // 闭包里捕获的 tag.name 会是过期快照（详见 deleteTagRow 的注释）
            del.addEventListener('click', () => void this.deleteTagRow(id));
        }

        const addBtn = rowsHost.createEl('button', { text: '＋ 添加标签', cls: 'pdfreader-tag-add' });
        addBtn.addEventListener('click', () => {
            this.getSettings().quickTags.push({ id: newTagId(), name: '新标签', description: '' });
            void this.persist().then(() => this.display());
        });
    }

    /**
     * 把标签名回退到旧名（优先用待办里的 from），并撤销对应的待同步项。
     * @returns 回退后实际生效的名称
     */
    private revertTagName(id: string, fallback: string): string {
        const s = this.getSettings();
        const pending = (s.pendingTagRenames ?? []).find((p) => p.id === id);
        const back = pending ? pending.from : fallback;
        const r = renameTag(s.quickTags, s.pendingTagRenames ?? [], id, back);
        s.quickTags = r.tags;
        s.pendingTagRenames = r.pending;
        void this.persist();
        return back;
    }

    /**
     * 删除一行标签：先从词表移除（非破坏性），再询问是否清理笔记里的残留引用。
     *
     * 按 id 现查名字，不用渲染期的快照：改名走的是 renameTag（返回新对象），
     * 只要期间发生过一次重绘（↑ / ↓ / 添加标签），闭包里的旧名字就过期了。
     * 而过期的名字正是「尚未同步的旧名」—— 用新名去全库查找会一无所获，
     * 直接把 offerNoteCleanup 变成静默空转：词表没了、待办没了、笔记里的旧标签永久残留。
     * 因此这里同时用「当前名」和待办里的 from（笔记中实际存在的旧名）作为清理目标。
     */
    private async deleteTagRow(id: string): Promise<void> {
        const s = this.getSettings();
        const currentName = s.quickTags.find((t) => t.id === id)?.name;
        const oldName = (s.pendingTagRenames ?? []).find((p) => p.id === id)?.from;

        const r = removeTag(s.quickTags, s.pendingTagRenames ?? [], id);
        s.quickTags = r.tags;
        s.pendingTagRenames = r.pending;
        await this.persist();
        this.display();

        // 从词表删除本身不改笔记；笔记里若还有引用，再单独询问是否一并清理
        if (!this.tagSync) return;
        const targets = [currentName, oldName].filter((n): n is string => !!n);
        if (targets.length === 0) return;
        // 旧名与新名不同 = 有一条尚未同步的改名被这次删除一并取消了，如实告知
        if (oldName && currentName && oldName !== currentName) {
            new Notice(`标签 #${oldName} 的改名尚未同步，已随删除一并取消`, 6000);
        }
        await this.tagSync.offerNoteCleanupForNames(targets);
    }

    /** 渲染待同步改名区：列出待办 + 同步/撤销按钮 */
    private renderPendingRenames(host: HTMLElement): void {
        host.empty();
        const tagSync = this.tagSync;
        if (!tagSync) return;

        const pending = tagSync.getPendingRenames();
        if (pending.length === 0) return;

        const box = host.createDiv({ cls: 'pdfreader-tag-changes' });
        box.createEl('h4', { text: `${pending.length} 项改名待同步到笔记` });

        const list = box.createDiv({ cls: 'pdfreader-tag-change-list' });
        for (const p of pending) {
            const row = list.createDiv({ cls: 'pdfreader-tag-change-row' });
            row.createSpan({ cls: 'pdfreader-tag-change-text', text: `#${p.from} → #${p.to}` });
        }

        const buttons = box.createDiv({ cls: 'pdfreader-tag-actions' });
        const syncBtn = buttons.createEl('button', { text: '同步到笔记', cls: 'mod-cta' });
        syncBtn.addEventListener('click', () => {
            void tagSync.applyPendingRenames().then(() => this.display());
        });
        const revertBtn = buttons.createEl('button', { text: '撤销改名' });
        revertBtn.addEventListener('click', () => {
            void tagSync.revertPendingRenames().then(() => this.display());
        });

        box.createEl('p', {
            cls: 'pdfreader-tag-hint',
            text: '「同步到笔记」把笔记里的旧名批量换成新名（直接改写笔记原文，无法撤销）；'
                + '「撤销改名」把词表改回旧名并清空待办，两者都能让词表与笔记重新一致。',
        });
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
            .setDesc('新创建阅读笔记的正文内容，可自由修改板块标题；留空则正文为空')
            .addTextArea((text) => {
                text.inputEl.rows = 4;
                text.setPlaceholder('留空则新建笔记正文为空')
                    .setValue(this.getSettings().readingNoteBodyTemplate || '')
                    .onChange(async (value) => {
                        this.getSettings().readingNoteBodyTemplate = value.replace(/\r\n/g, '\n');
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
            .setDesc('批注回链 PDF 的链接显示文字（写入笔记正文），留空恢复默认；'
                + '不能含 | [ ] 或换行（会破坏生成的链接），这些字符会被自动去掉')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.annotationLinkLabel)
                .setValue(this.getSettings().annotationLinkLabel || DEFAULT_SETTINGS.annotationLinkLabel)
                .onChange(async (value) => {
                    const clean = sanitizeLinkAlias(value);
                    if (value.trim() && !clean) {
                        new Notice('别名不能只由 | [ ] 或换行组成，已恢复默认');
                    } else if (clean !== value.trim()) {
                        new Notice(`别名中的 | [ ] 与换行会被自动去掉：「${clean || DEFAULT_SETTINGS.annotationLinkLabel}」`);
                        text.setValue(clean || DEFAULT_SETTINGS.annotationLinkLabel);
                    }
                    this.getSettings().annotationLinkLabel = clean || DEFAULT_SETTINGS.annotationLinkLabel;
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
            .setDesc('为已有阅读笔记的 PDF 与 Markdown 文献在文件管理器中显示小图标；关闭后隐藏（任意布局变化即清空）')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().fileMarkerEnabled !== false)
                .onChange(async (value) => {
                    this.getSettings().fileMarkerEnabled = value;
                    await this.saveSettings();
                }));

        new Setting(containerEl)
            .setName('字数统计修正')
            .setDesc('状态栏词数不再把图片嵌入、链接与 base64 数据算作正文：![[图片]]/![](data:...) 整体移除，[[目标|别名]] 只计别名，[[目标]] 只计显示名，[文字](网址) 只计文字，裸网址移除；字符数保持原生不变。统计口径与 Obsidian 原生完全一致，仅剔除图片与链接')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().wordCountFixEnabled !== false)
                .onChange(async (value) => {
                    this.getSettings().wordCountFixEnabled = value;
                    await this.saveSettings();
                    this.wordCountFix?.setEnabled(value);
                }));

        // ===== 标签管理 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: '标签管理' });

        containerEl.createEl('p', {
            text: '每个标签有一个不会改变的内部 id，因此改名是可精确记录的，不需要任何猜测配对。'
                + '描述只显示在快速标签选择器里，不会写进笔记，可省略。'
                + '阅读时经 PDF 工具条「标签」按钮或快捷键，一步插入到阅读笔记的光标处；'
                + '插入落点与批注一致 —— 都是你光标所在的那篇笔记。',
        });

        const tagRowsHost = containerEl.createDiv();
        const tagPendingHost = containerEl.createDiv({ cls: 'pdfreader-tag-changes-host' });
        this.renderTagEditor(tagRowsHost, tagPendingHost);
        this.renderPendingRenames(tagPendingHost);

        new Setting(containerEl)
            .setName('工具条「标签」按钮')
            .setDesc('在每个 PDF 视图的页码旁显示「标签」按钮。关闭后仍可用命令「快速添加标签」；'
                + '在 设置 → 快捷键 中搜索该命令即可绑定任意按键')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().quickTagToolbarButton !== false)
                .onChange(async (value) => {
                    this.getSettings().quickTagToolbarButton = value;
                    await this.saveSettings();
                }));

        new Setting(containerEl)
            .setName('从笔记中删除标签')
            .setDesc('从所有笔记中移除某个标签的正文引用。会先列出全库实际出现的标签、'
                + '显示逐行预览并二次确认；直接改写笔记原文，无法撤销')
            .addButton((btn) => btn.setButtonText('选择标签…').onClick(() => {
                if (this.tagSync) void this.tagSync.openDeletePicker();
            }));


        // ===== 搜索增强 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: '搜索增强' });

        new Setting(containerEl)
            .setName('忽略链接')
            .setDesc('核心搜索时忽略 [[链接目标|别名]] 的目标文本（含 PDF 路径与 #page 定位参数），只匹配正文与别名，批注回链不再淹没搜索结果。开关也位于搜索面板选项区（滑块图标），在那里切换会立即重新搜索')
            .addToggle((toggle) => toggle
                .setValue(this.getSettings().searchIgnoreLinks === true)
                .onChange(async (value) => {
                    this.getSettings().searchIgnoreLinks = value;
                    await this.saveSettings();
                    this.searchEnhancement?.syncToggles(value);
                }));

        // ===== DeepSeek 设置 =====
        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: 'DeepSeek 窗口设置' });
        containerEl.createEl('p', {
            text: '提示：选择「浮动窗口」时可拖动标题栏移动、拖动边缘调整大小，位置与大小自动记住；选择「标签页」时在 Obsidian 工作区中以标签页打开。',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('DeepSeek URL')
            .setDesc('嵌入 DeepSeek 窗口/标签页的网页地址；修改后下次打开时自动重新加载（须为 http/https 地址）')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.deepseekUrl)
                .setValue(this.getSettings().deepseekUrl)
                .onChange(async (value) => {
                    const raw = value.trim();
                    // 空值回退默认；非法地址回退默认并提示，避免窗口/标签页只剩一片空白错误页
                    if (!raw) {
                        this.getSettings().deepseekUrl = DEFAULT_SETTINGS.deepseekUrl;
                    } else if (isValidHttpUrl(raw)) {
                        this.getSettings().deepseekUrl = raw;
                    } else {
                        new Notice(`「${raw}」不是有效的 http/https 地址，已还原为 ${DEFAULT_SETTINGS.deepseekUrl}`);
                        this.getSettings().deepseekUrl = DEFAULT_SETTINGS.deepseekUrl;
                        text.setValue(DEFAULT_SETTINGS.deepseekUrl);
                    }
                    this.scheduleSave();
                }));

        new Setting(containerEl)
            .setName('默认打开方式')
            .setDesc('点击左侧栏机器人图标或使用「打开 DeepSeek」命令时采用的方式；也可用命令单独打开浮动窗口或标签页')
            .addDropdown((dropdown) => dropdown
                .addOption('floating', '浮动窗口')
                .addOption('tab', '标签页')
                .setValue(this.getSettings().deepseekOpenMode)
                .onChange(async (value) => {
                    this.getSettings().deepseekOpenMode = value as DeepSeekOpenMode;
                    await this.saveSettings();
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

/** 校验是否为可嵌入的 http/https 地址（浮窗 webview 只接受这两种协议） */
function isValidHttpUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return url.protocol === 'http:' || url.protocol === 'https:';
}
