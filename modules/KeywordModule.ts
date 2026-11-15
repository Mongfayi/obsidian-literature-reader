import { App, FuzzySuggestModal, Modal, Notice, TFile, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, type ModuleContext, type PluginModule } from '../types';
import type { PdfReaderModule } from './PdfReaderModule';
import {
    extractKeywordsFromText,
    getKeywordConcept,
    mergeFrontmatterTags,
    parseFrontmatterTags,
} from './keywordEngine';
import { serializeLexiconText } from './keywordLexicon';
import { renderNoteBaseName } from './noteNaming';

/**
 * 关键词模块
 *
 * 提供命令「为当前文献笔记添加关键词」：
 *  - 当前打开 PDF：找到它的阅读笔记，提取关键词后弹窗勾选写入；
 *  - 当前打开阅读笔记：按 frontmatter 的 pdf / source 字段反查 PDF；
 *  - 弹窗只「增加」标签，不覆盖笔记里已有的标签，也不改写正文。
 *
 * 新建阅读笔记时的自动提取仍由 PdfReaderModule.generateNoteContent 调用 keywordEngine 完成；
 * 本模块只负责「对已有笔记补标签」这个入口，以及给用户一次确认/挑选的机会。
 */

type KeywordSource = 'keywords' | 'inferred' | 'none';

interface ActiveTarget {
    note: TFile | null;
    source: TFile | null;
}

interface ResolvedTarget {
    note: TFile;
    source: TFile;
}

interface PickerOptions {
    sourceName: string;
    source: KeywordSource;
    existing: string[];
    candidates: string[];
    onChoose: (selected: string[]) => void | Promise<void>;
}

/** 关键词勾选弹窗：候选默认全选，已有标签只展示不可选 */
class KeywordPickerModal extends Modal {
    private readonly options: PickerOptions;
    private readonly selected: Set<string>;
    private submitButton: HTMLButtonElement | null = null;

    constructor(app: App, options: PickerOptions) {
        super(app);
        this.options = options;
        this.selected = new Set(options.candidates);
    }

    onOpen(): void {
        this.modalEl.addClass('pdfreader-keyword-modal');
        this.titleEl.setText('添加关键词');
        const { contentEl } = this;
        contentEl.empty();

        const info = contentEl.createDiv({ cls: 'pdfreader-keyword-info' });
        info.createSpan({ text: `来源：${this.options.sourceName}` });
        if (this.options.source === 'inferred') {
            info.createSpan({
                text: '（没有作者关键词段，按标题/摘要推断）',
                cls: 'pdfreader-keyword-hint',
            });
        }
        const summary = contentEl.createDiv({ cls: 'pdfreader-keyword-summary' });
        summary.setText(`识别到 ${this.options.candidates.length} 个新关键词`
            + (this.options.existing.length > 0 ? `；笔记已有 ${this.options.existing.length} 个标签` : ''));

        if (this.options.existing.length > 0) {
            const box = contentEl.createDiv({ cls: 'pdfreader-keyword-existing' });
            box.createSpan({ text: '已有：', cls: 'pdfreader-keyword-existing-label' });
            for (const tag of this.options.existing) {
                box.createSpan({ text: `#${tag.replace(/^#/, '')}`, cls: 'pdfreader-keyword-chip' });
            }
        }

        const list = contentEl.createDiv({ cls: 'pdfreader-keyword-list' });
        for (const tag of this.options.candidates) {
            const row = list.createEl('label', { cls: 'pdfreader-keyword-item' });
            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = true;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.selected.add(tag);
                else this.selected.delete(tag);
                this.refreshSubmitLabel();
            });

            const body = row.createDiv({ cls: 'pdfreader-keyword-body' });
            body.createDiv({ text: `#${tag}`, cls: 'pdfreader-keyword-tag' });
            const concept = getKeywordConcept(tag);
            if (concept) {
                const meta = concept.category ? ` · ${concept.category}` : '';
                const desc = concept.description ? `${concept.description}${meta}` : `词表概念${meta}`;
                body.createDiv({ text: desc, cls: 'pdfreader-keyword-desc' });
            } else {
                body.createDiv({ text: '原文关键词（不在你的词表里）', cls: 'pdfreader-keyword-desc' });
            }
        }

        const footer = contentEl.createDiv({ cls: 'pdfreader-keyword-footer' });
        const toggleAll = footer.createEl('button', { text: '全不选' });
        toggleAll.addEventListener('click', () => {
            const selectAll = this.selected.size === 0;
            for (const input of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
                input.checked = selectAll;
            }
            this.selected.clear();
            if (selectAll) {
                for (const tag of this.options.candidates) this.selected.add(tag);
            }
            toggleAll.setText(selectAll ? '全不选' : '全选');
            this.refreshSubmitLabel();
        });

        footer.createDiv({ cls: 'pdfreader-keyword-spacer' });
        const cancel = footer.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());
        this.submitButton = footer.createEl('button', {
            text: `添加所选 (${this.selected.size})`,
            cls: 'mod-cta',
        });
        this.submitButton.addEventListener('click', () => {
            const chosen = [...this.selected];
            this.close();
            void this.options.onChoose(chosen);
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private refreshSubmitLabel(): void {
        if (!this.submitButton) return;
        this.submitButton.setText(`添加所选 (${this.selected.size})`);
        this.submitButton.toggleClass('is-disabled', this.selected.size === 0);
        this.submitButton.disabled = this.selected.size === 0;
    }
}

/** 在 vault 里挑一个词表文件（.json / .txt / .md 都接受） */
class LexiconFileSuggestModal extends FuzzySuggestModal<TFile> {
    private readonly files: TFile[];
    private readonly onPick: (file: TFile) => void;

    constructor(app: App, files: TFile[], onPick: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onPick = onPick;
        this.setPlaceholder('选择词表文件（.json / .txt / .md）');
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.onPick(file);
    }
}

export class KeywordModule implements PluginModule {
    private readonly ctx: ModuleContext;
    private readonly pdfModule: PdfReaderModule;

    constructor(ctx: ModuleContext, pdfModule: PdfReaderModule) {
        this.ctx = ctx;
        this.pdfModule = pdfModule;
    }

    load(): void {
        this.ctx.plugin.addCommand({
            id: 'add-keywords-to-note',
            name: '为当前文献笔记添加关键词',
            checkCallback: (checking) => {
                if (!this.getActiveTargetSync()) return false;
                if (!checking) void this.run();
                return true;
            },
        });
    }

    unload(): void {
        // 命令随插件卸载自动注销，无需额外清理
    }

    // ========== 目标解析 ==========

    /**
     * 同步判断当前上下文是否有关键词入口：
     *  - PDF：总是可用（run() 里再找/提示阅读笔记）
     *  - 笔记：frontmatter 有 pdf（或 source 指向 PDF），或本身就是阅读笔记
     */
    private getActiveTargetSync(): ActiveTarget | null {
        const app = this.ctx.plugin.app;
        const active = app.workspace.getActiveFile();
        if (!active) return null;
        if (active.extension === 'pdf') {
            return { note: null, source: active };
        }
        if (active.extension !== 'md') return null;

        const frontmatter = app.metadataCache.getFileCache(active)?.frontmatter;
        const link = this.firstString(frontmatter?.pdf ?? frontmatter?.source);
        if (link) {
            const source = this.resolveLink(link, active);
            if (source instanceof TFile && source.extension === 'pdf') {
                return { note: active, source };
            }
        }
        if (this.pdfModule.isReadingNote(active)) {
            return { note: active, source: null };
        }
        return null;
    }

    /** 把同步结果补全成 note + PDF；缺一边就按 frontmatter / 命名模板反查 */
    private resolveTarget(target: ActiveTarget): ResolvedTarget | null {
        if (target.note && target.source) {
            return { note: target.note, source: target.source };
        }
        if (target.source) {
            const note = this.findReadingNote(target.source);
            return note ? { note, source: target.source } : null;
        }
        if (target.note) {
            const source = this.pdfModule.resolveNoteSource(target.note);
            if (source instanceof TFile && source.extension === 'pdf') {
                return { note: target.note, source };
            }
        }
        return null;
    }

    /** 为一篇 PDF 找它的阅读笔记：frontmatter pdf/source 反查，再按命名模板兜底 */
    private findReadingNote(pdf: TFile): TFile | null {
        const app = this.ctx.plugin.app;
        for (const file of app.vault.getMarkdownFiles()) {
            const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
            const link = this.firstString(frontmatter?.pdf ?? frontmatter?.source);
            if (!link) continue;
            const dest = this.resolveLink(link, file);
            if (dest instanceof TFile && dest.path === pdf.path) return file;
        }

        const settings = this.ctx.getSettings();
        const folder = normalizePath(settings.readingNoteFolder || '');
        const base = renderNoteBaseName(pdf.basename, settings.readingNoteNameTemplate);
        const path = normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
        const candidate = app.vault.getAbstractFileByPath(path);
        return candidate instanceof TFile ? candidate : null;
    }

    /** 解析 frontmatter 里的 [[路径]] / 纯路径 */
    private resolveLink(raw: string, from: TFile): TFile | null {
        const app = this.ctx.plugin.app;
        const match = raw.match(/\[\[(.+?)\]\]/);
        const path = (match ? match[1] : raw).split('|')[0].split('#')[0].trim();
        if (!path) return null;
        const direct = app.vault.getAbstractFileByPath(normalizePath(path));
        if (direct instanceof TFile) return direct;
        return app.metadataCache.getFirstLinkpathDest(path, from.path);
    }

    private firstString(value: unknown): string | null {
        const raw = Array.isArray(value) ? value[0] : value;
        return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }

    /** 设置页「选择关键词…」按钮入口：对当前活动文件执行一次提取 */
    openForActiveFile(): void {
        void this.run();
    }

    // ========== 词表（用户自己维护） ==========

    /** 从 vault 里选一个文件导入词表，读成功后把文本交给回调 */
    importLexiconFile(onLoad: (text: string, path: string) => void): void {
        const app = this.ctx.plugin.app;
        const files = app.vault
            .getFiles()
            .filter((file) => ['json', 'txt', 'md'].includes(file.extension));
        if (files.length === 0) {
            new Notice('vault 里没有 .json / .txt / .md 文件可导入');
            return;
        }
        new LexiconFileSuggestModal(app, files, (file) => {
            void (async () => {
                try {
                    const text = await app.vault.read(file);
                    onLoad(text, file.path);
                } catch (e) {
                    console.error('[Keyword] 读取词表文件失败:', e);
                    new Notice(`读取 ${file.path} 失败`);
                }
            })();
        }).open();
    }

    /** 把词表写到 vault 根目录，便于备份 / 共享 / 纳入版本管理 */
    async exportLexiconFile(text: string): Promise<string | null> {
        const app = this.ctx.plugin.app;
        const path = normalizePath('pdf-reader-keyword-lexicon.json');
        try {
            const exists = await app.vault.adapter.exists(path);
            if (exists) {
                await app.vault.adapter.write(path, text);
                new Notice(`已覆盖 vault 根目录的 ${path}`);
            } else {
                await app.vault.create(path, text);
                new Notice(`已导出到 vault 根目录的 ${path}`);
            }
            return path;
        } catch (e) {
            console.error('[Keyword] 导出词表失败:', e);
            new Notice('导出词表失败，请检查 vault 根目录是否可写');
            return null;
        }
    }

    // ========== 主流程 ==========

    private async run(): Promise<void> {
        const app = this.ctx.plugin.app;
        const active = this.getActiveTargetSync();
        if (!active) {
            new Notice('请先打开一篇 PDF，或它的阅读笔记');
            return;
        }
        const target = this.resolveTarget(active);
        if (!target) {
            new Notice(
                active.source
                    ? '这篇 PDF 还没有阅读笔记。请先右键 PDF →「开始阅读」创建阅读笔记，再回来添加关键词'
                    : '这篇笔记没有关联到 PDF，无法提取关键词'
            );
            return;
        }

        const settings = this.ctx.getSettings();
        let text = '';
        try {
            text = await this.pdfModule.extractPdfText(target.source);
        } catch (e) {
            console.error('[Keyword] 提取 PDF 文本失败:', e);
            new Notice('读取 PDF 文本失败，无法提取关键词');
            return;
        }

        let existingContent = '';
        try {
            existingContent = this.ctx.readNoteContent
                ? await this.ctx.readNoteContent(target.note)
                : await app.vault.read(target.note);
        } catch (e) {
            console.warn('[Keyword] 读取笔记失败，将按无已有标签处理:', e);
        }
        const existing = parseFrontmatterTags(existingContent);
        const existingKeys = new Set(existing.map((t) => t.toLowerCase()));

        const result = extractKeywordsFromText(text, {
            normalize: settings.keywordNormalize !== false,
            fallback: settings.keywordFallbackInfer !== false,
            maxTags: settings.keywordMaxTags ?? DEFAULT_SETTINGS.keywordMaxTags,
        });
        if (result.tags.length === 0) {
            new Notice('没有从这篇 PDF 里提取到关键词（可能是扫描件，或没有文本层）');
            return;
        }
        const candidates = result.tags.filter((t) => !existingKeys.has(t.toLowerCase()));
        if (candidates.length === 0) {
            new Notice('这篇笔记已经包含识别出的全部关键词');
            return;
        }

        new KeywordPickerModal(app, {
            sourceName: target.source.basename,
            source: result.source,
            existing,
            candidates,
            onChoose: async (selected) => {
                if (selected.length === 0) return;
                try {
                    let added: string[] = [];
                    await app.vault.process(target.note, (data) => {
                        const merged = mergeFrontmatterTags(data, selected);
                        added = merged.added;
                        return merged.content;
                    });
                    if (added.length > 0) {
                        new Notice(`已添加 ${added.length} 个关键词：${added.map((t) => `#${t}`).join(' ')}`, 4000);
                    } else {
                        new Notice('所选关键词都已存在，笔记未改动');
                    }
                } catch (e) {
                    console.error('[Keyword] 写入关键词失败:', e);
                    new Notice('写入关键词失败，请确认笔记没有被其他程序占用');
                }
            },
        }).open();
    }
}
