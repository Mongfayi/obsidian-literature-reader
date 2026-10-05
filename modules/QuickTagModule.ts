import {
    App,
    Editor,
    FileView,
    Notice,
    SuggestModal,
    TFile,
    WorkspaceLeaf,
    prepareFuzzySearch,
    setIcon,
    setTooltip,
} from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import { LEGACY_VOCABULARY_FILE, newTagId, parseTagText, type TagDef } from './tagVocabulary';
import type { PdfReaderModule } from './PdfReaderModule';
import { toolbarPoller, pruneStaleLeaves } from './toolbarPoller';

/**
 * 快速添加标签模块
 *
 * 词表来自插件设置 `quickTags`（带稳定 id 的结构化列表，在 设置 → 文献阅读助手 → 标签管理
 * 中逐行编辑）。经工具条按钮或快捷键唤起选择器，把 `#标签 ` 插入笔记光标处。
 *
 * 三个入口：
 *  - PDF 工具条「标签」按钮：焦点在 PDF 上时，写入该 PDF 对应批注目标笔记的编辑器缓冲，
 *    读取光标位置但不抢焦点（笔记与 PDF 左右分屏时体验最顺）。
 *  - Markdown 编辑器顶部工具栏「标签」按钮：复用同一套目标定位与插入逻辑。
 *  - 命令 `quick-add-tag`：在 Obsidian「设置 → 快捷键」中自行绑定任意按键。
 *
 * 落点与批注 / 截图 / OCR 完全一致：统一复用 PdfReaderModule.getCursorNotePos，
 * 即「光标所在的那篇笔记」。没打开笔记时提示用户，不做任何静默改写。
 *
 * 工具条按钮注入范式与 AnnotationModeModule 一致：
 * 监听 layout-change / active-leaf-change + 2s 轮询兜底，
 * 经 viewer.child.toolbar.pageNumberEl.after(btn) 插入。
 *
 * 词表的解析/比对/批量改写逻辑见 tagVocabulary.ts，本模块只负责读取与插入。
 */

/** 标签插入点：编辑器 + 光标位置 */
interface InsertPos {
    editor: Editor;
    line: number;
    ch: number;
}

/**
 * 标签落点。
 *  - cursor：插到某篇笔记的光标处（noteName 用于提示落到哪篇）
 *  - append：笔记未打开或处于阅读模式，追加到笔记末尾
 */
type InsertTarget =
    | ({ mode: 'cursor'; noteName?: string } & InsertPos)
    | { error: string };

/** 标签选择器：第一行标签名，第二行凡例说明，支持模糊搜索 */
class QuickTagSuggestModal extends SuggestModal<TagDef> {
    private readonly items: TagDef[];
    private readonly onChoose: (item: TagDef) => void;

    constructor(app: App, items: TagDef[], onChoose: (item: TagDef) => void) {
        super(app);
        this.items = items;
        this.onChoose = onChoose;
        this.emptyStateText = '没有匹配的标签';
        this.setPlaceholder('输入标签名筛选…');
        this.setInstructions([
            { command: '↑↓', purpose: '选择' },
            { command: '↵', purpose: '插入标签' },
            { command: 'esc', purpose: '取消' },
        ]);
    }

    getSuggestions(query: string): TagDef[] {
        const q = query.trim();
        if (!q) return this.items;

        const search = prepareFuzzySearch(q);
        const scored: { item: TagDef; score: number }[] = [];
        for (const item of this.items) {
            // 标签名命中优先于描述命中（+100 加权保证排序稳定）
            const byName = search(item.name);
            if (byName) {
                scored.push({ item, score: byName.score + 100 });
                continue;
            }
            const byDesc = item.description ? search(item.description) : null;
            if (byDesc) scored.push({ item, score: byDesc.score });
        }
        return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
    }

    renderSuggestion(item: TagDef, el: HTMLElement): void {
        el.addClass('pdfreader-quick-tag-suggestion');
        el.createDiv({ cls: 'pdfreader-quick-tag-name', text: `#${item.name}` });
        if (item.description) {
            el.createDiv({ cls: 'pdfreader-quick-tag-desc', text: item.description });
        }
    }

    onChooseSuggestion(item: TagDef): void {
        this.onChoose(item);
    }
}

export class QuickTagModule implements PluginModule {
    private ctx: ModuleContext;
    private pdfModule: PdfReaderModule;

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

        // 一次性迁移：把旧版凡例文件里的标签导入设置（仅当设置词表为空时执行）
        void this.migrateTags();

        plugin.registerEvent(
            plugin.app.workspace.on('layout-change', () => this.injectToolbarButtons())
        );
        plugin.registerEvent(
            plugin.app.workspace.on('active-leaf-change', () => this.injectToolbarButtons())
        );

        // PDF 视图可能被重建，事件驱动注入不可靠，用轻量定时轮询兜底（幂等）；
        // 与截图/OCR/附带原文等模块共享同一轮询器
        this.removePollTask = toolbarPoller.add(() => this.injectToolbarButtons());
        toolbarPoller.start();

        plugin.addCommand({
            id: 'quick-add-tag',
            name: '快速添加标签（在笔记光标处插入凡例标签）',
            checkCallback: (checking) => {
                if (!this.hasTarget()) return false;
                if (!checking) this.openTagPicker();
                return true;
            },
        });

        this.injectToolbarButtons();

        // 卸载时统一移除所有已注入按钮（单次注册，避免每次注入都累积清理闭包）
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
    }

    // ========== 入口可用性 ==========

    /** 命令是否可用：存在可写入的笔记（即光标所在笔记）时可用 */
    private hasTarget(): boolean {
        return this.pdfModule.getCursorNotePos() !== null;
    }

    // ========== 目标定位 ==========

    /**
     * 解析插入目标：**光标所在的那篇笔记**，与批注 / 截图 / OCR 落点规则完全一致
     * （统一复用 PdfReaderModule.getCursorNotePos）。
     * 没打开笔记时返回可直接展示给用户的错误原因。
     */
    private resolveInsertTarget(): InsertTarget {
        const pos = this.pdfModule.getCursorNotePos();
        if (!pos) {
            return { error: '请先把光标放到要添加标签的笔记里' };
        }
        const base = pos.noteFile.path.split('/').pop() ?? '';
        return {
            mode: 'cursor',
            editor: pos.editor,
            line: pos.line,
            ch: pos.ch,
            noteName: base.replace(/\.md$/, ''),
        };
    }

    // ========== 词表 ==========

    /** 当前词表：直接取设置里的标签列表，因此在设置里改完立即生效 */
    private loadTagEntries(): TagDef[] {
        return this.ctx.getSettings().quickTags ?? [];
    }

    /**
     * 首次升级时的一次性迁移，把标签搬进带稳定 id 的 `quickTags`：
     *  1. 优先用上一版设置里的文本框内容（quickTagText）
     *  2. 其次读更早的凡例文件（LEGACY_VOCABULARY_FILE）
     * 两条路径都只在 `quickTags` 为空时执行；迁移后 id 由 `newTagId()` 生成并从此固定。
     * 凡例文件本身保持只读，不删不改，仍可作为文档与备份继续存在。
     *
     * 迁移成功后（以及发现遗留字段与已有词表并存时）会清除 `quickTagText` /
     * `quickTagApplied`，使迁移成为真正的一次性操作 —— 详见下方注释。
     */
    private async migrateTags(): Promise<void> {
        const settings = this.ctx.getSettings();

        // 已经迁移过（词表非空）：这时的遗留字段不再是数据源，清掉它们，
        // 否则「用户把标签全部删除」后 quickTags 变空，下次加载仍会把旧词表重新导入一遍。
        // 注意必须在这里也清理：此前版本迁移成功后并未清除遗留字段，老用户的 data.json
        // 里两者是并存的，只靠「空词表才迁移」的守卫永远走不到清理分支。
        if ((settings.quickTags ?? []).length > 0) {
            if (settings.quickTagText !== undefined || settings.quickTagApplied !== undefined) {
                delete settings.quickTagText;
                delete settings.quickTagApplied;
                await this.ctx.saveSettings();
            }
            return;
        }

        let entries = parseTagText(settings.quickTagText ?? '');
        if (entries.length === 0) {
            const file = this.ctx.plugin.app.vault.getAbstractFileByPath(LEGACY_VOCABULARY_FILE);
            if (file instanceof TFile) {
                try {
                    entries = parseTagText(await this.ctx.plugin.app.vault.cachedRead(file));
                } catch (e) {
                    console.error('[QuickTag] 读取凡例文件失败:', e);
                    return;
                }
            }
        }
        if (entries.length === 0) return;
        // 读盘期间用户可能已在设置面板里添加了标签，此时不能覆盖
        if ((settings.quickTags ?? []).length > 0) return;

        settings.quickTags = entries.map((e) => ({
            id: newTagId(),
            name: e.name,
            description: e.description,
        }));
        // 迁移成功后清掉遗留字段：否则「用户把标签全部删除」与「尚未迁移」两种状态
        // 无法区分（两者的 quickTags 都为空），下次加载会把旧词表重新导入一遍，
        // 用户删掉的标签自己「复活」，且改名历史一并丢失。
        delete settings.quickTagText;
        delete settings.quickTagApplied;
        await this.ctx.saveSettings();
    }

    // ========== 主流程 ==========

    /** 打开标签选择器并把选中标签插入光标所在笔记（PDF / Markdown 工具条共用） */
    openTagPicker(): void {
        const items = this.loadTagEntries();
        if (items.length === 0) {
            new Notice('快速标签：还没有标签，请在 设置 → 文献阅读助手 → 标签管理 中添加');
            return;
        }

        // 目标在弹窗打开前解析：弹窗会抢焦点，届时再读光标已不可靠
        const target = this.resolveInsertTarget();
        if ('error' in target) {
            new Notice(`快速标签：${target.error}`);
            return;
        }

        new QuickTagSuggestModal(this.ctx.plugin.app, items, (item) => {
            try {
                this.insertTag(target, item.name);
                const where = target.noteName ? ` 到「${target.noteName}」` : '';
                new Notice(`已插入 #${item.name}${where}`, 1500);
            } catch (e) {
                console.error('[QuickTag] 插入标签失败:', e);
                new Notice('快速标签：插入失败，请确认笔记处于编辑模式');
            }
        }).open();
    }

    /**
     * 在光标处插入 `#标签`，并保证标签前后有空白以便 Obsidian 正确识别：
     *  - 前一字符是 `#`：只补标签名，避免拼成 `##` 被解析为标题
     *  - 前一字符非空白且非行首：先补一个空格（`…定位]#栽培` 不会被识别为标签）
     *  - 末尾统一留一个空格，光标停在其后，便于继续输入或再打一个标签
     * 与笔记中现有的 `[[…|定位]] #栽培 ` 写法保持一致。
     */
    private insertTag(pos: InsertPos, tag: string): void {
        const { editor } = pos;
        const lineText = pos.line <= editor.lastLine() ? editor.getLine(pos.line) : '';
        // 位置在弹窗打开前捕获，期间缓冲可能被其他插件改动：夹取到行内避免越界，
        // 越界时 charAt 返回空串会被误判为行首而漏掉前导空格，导致标签识别失败
        const ch = Math.max(0, Math.min(pos.ch, lineText.length));
        const before = ch > 0 ? lineText.charAt(ch - 1) : '';

        let text: string;
        if (before === '#') {
            text = `${tag} `;
        } else if (before === '' || /\s/.test(before)) {
            text = `#${tag} `;
        } else {
            text = ` #${tag} `;
        }

        const from = { line: pos.line, ch };
        editor.replaceRange(text, from);
        // 光标落在插入内容之后，继续输入即为「… #标签 我打字的内容」
        editor.setCursor({ line: pos.line, ch: ch + text.length });
    }

    // ========== 工具条按钮 ==========

    private injectToolbarButtons(): void {
        // 设置关闭时移除已注入按钮，只保留快捷键入口
        if (this.ctx.getSettings().quickTagToolbarButton === false) {
            for (const btn of this.createdButtons) btn.remove();
            this.createdButtons.clear();
            this.toolbarButtons.clear();
            return;
        }

        // 清理已关闭叶子的陈旧按钮缓存
        pruneStaleLeaves(this.ctx.plugin.app, this.toolbarButtons);

        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'pdf') return;

            const viewer = (leaf.view as any).viewer;
            const toolbar = viewer?.child?.toolbar;
            if (!toolbar) return; // 轮询会重试

            const pageNumberEl = toolbar.pageNumberEl as HTMLElement | undefined;
            if (!pageNumberEl || !pageNumberEl.parentElement) return;

            // 以「当前工具条上是否已有按钮」为准，避免重建后重复注入
            const existing = pageNumberEl.parentElement.querySelector<HTMLElement>('.pdfreader-quick-tag-button');
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

            const btn = createDiv();
            btn.addClass('clickable-icon');
            btn.addClass('pdfreader-quick-tag-button');
            setIcon(btn, 'tags');
            setTooltip(btn, '快速添加标签\n在阅读笔记光标处插入凡例中的标签');
            btn.addEventListener('click', (evt: MouseEvent) => {
                evt.stopPropagation();
                this.openTagPicker();
            });

            pageNumberEl.after(btn);

            this.toolbarButtons.set(leaf, btn);
            this.createdButtons.add(btn);
        });
    }
}
