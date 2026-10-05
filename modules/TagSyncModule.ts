import {
    App,
    MarkdownView,
    Modal,
    Notice,
    SuggestModal,
    TFile,
    prepareFuzzySearch,
} from 'obsidian';
import type { ModuleContext, PluginModule } from '../types';
import {
    applyTagOps,
    collectTagsFromText,
    splitLineChange,
    type LineDiff,
    type PendingRename,
    type TagOp,
} from './tagVocabulary';

/**
 * 标签同步模块
 *
 * 负责把词表变更落到笔记正文：
 *  - 改名同步：比对「上次已同步快照」与「当前词表」，列出改名，用户勾选后批量改写
 *  - 安全删除：扫描全库列出候选标签 → 逐行预览 → 二次确认 → 批量删除
 *  - 不做撤销：旧版「备份 + 一键还原」会无条件覆盖整篇笔记，把同步之后新写的内容一并抹掉，风险高于收益，已移除
 *
 * 所有改写都只作用于**正文内联标签**（详见 tagVocabulary.ts 的边界保护），
 * 且必须由用户在设置面板或命令中显式触发 —— 本模块不做任何自动改写。
 */

/** 待改写的文件 */
interface FileEdit {
    file: TFile;
    count: number;
    /** 命中的行预览（行内差异，只标出真正变化的片段） */
    preview: LineChange[];
}

/** 行内差异 + 该行行号 */
interface LineChange extends LineDiff {
    line: number;
}

/** 单个标签在全库的分布 */
interface TagUsage {
    tag: string;
    fileCount: number;
    occurrences: number;
}

/** 影响处数达到该值时，确认框要求手动输入标签名 */
const TYPING_CONFIRM_THRESHOLD = 10;

/**
 * 依次应用一组操作，返回新文本与命中总处数。
 *
 * 实现为**一趟同时匹配**（见 tagVocabulary.applyTagOps），而不是逐个 replace 串联：
 * 串联时前一次改名的产出会被后一次改名再次命中，`A→B` 与 `B→C` 同批会把 A 直接变成 C。
 */
function applyOps(text: string, ops: TagOp[]): { text: string; count: number } {
    return applyTagOps(text, ops);
}

/** 改名与删除都不会增删行，因此可逐行对比得出改动预览 */
function buildPreview(oldText: string, ops: TagOp[], limit = 3): LineChange[] {
    const after = applyOps(oldText, ops).text;
    const a = oldText.split('\n');
    const b = after.split('\n');
    const out: LineChange[] = [];
    for (let i = 0; i < a.length && out.length < limit; i++) {
        if (a[i] !== b[i]) out.push({ line: i + 1, ...splitLineChange(a[i], b[i]) });
    }
    return out;
}

/** 通用确认框：概览 + 逐文件逐行预览 + 可选的手打标签名二次确认 */
class TagChangeConfirmModal extends Modal {
    private readonly opts: {
        title: string;
        summary: string[];
        files: FileEdit[];
        requireTyping?: string;
        confirmLabel: string;
        onConfirm: () => void;
    };
    private typed = '';

    constructor(app: App, opts: TagChangeConfirmModal['opts']) {
        super(app);
        this.opts = opts;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.opts.title });

        for (const line of this.opts.summary) {
            contentEl.createEl('p', { text: line });
        }

        const list = contentEl.createDiv({ cls: 'pdfreader-tag-preview-list' });
        for (const edit of this.opts.files) {
            const box = list.createDiv({ cls: 'pdfreader-tag-preview-file' });
            box.createDiv({
                cls: 'pdfreader-tag-preview-path',
                text: `${edit.file.path}  （${edit.count} 处）`,
            });
            for (const p of edit.preview) {
                const row = box.createDiv({ cls: 'pdfreader-tag-preview-row' });
                row.createDiv({ cls: 'pdfreader-tag-preview-line', text: `第 ${p.line} 行` });
                const diff = row.createDiv({ cls: 'pdfreader-tag-preview-diff' });
                // 只把真正变化的片段标出来，其余文字原样显示
                if (p.prefix) diff.createSpan({ text: p.prefix });
                if (p.removed) {
                    diff.createSpan({ cls: 'pdfreader-tag-preview-removed', text: p.removed });
                }
                if (p.removed && p.added) {
                    diff.createSpan({ cls: 'pdfreader-tag-preview-arrow', text: '→' });
                }
                if (p.added) {
                    diff.createSpan({ cls: 'pdfreader-tag-preview-added', text: p.added });
                }
                if (p.suffix) diff.createSpan({ text: p.suffix });
            }
            if (edit.count > edit.preview.length) {
                box.createDiv({
                    cls: 'pdfreader-tag-preview-more',
                    text: `… 另有 ${edit.count - edit.preview.length} 处未显示`,
                });
            }
        }

        const buttons = contentEl.createDiv({ cls: 'pdfreader-tag-modal-buttons' });
        const confirmBtn = buttons.createEl('button', {
            text: this.opts.confirmLabel,
            cls: 'mod-warning',
        });
        const cancelBtn = buttons.createEl('button', { text: '取消' });

        if (this.opts.requireTyping) {
            const label = this.opts.requireTyping;
            contentEl.createEl('p', {
                cls: 'pdfreader-tag-typing-hint',
                text: `影响范围较大，请输入标签名「${label}」以确认：`,
            });
            const input = contentEl.createEl('input', { type: 'text' });
            input.addClass('pdfreader-tag-typing-input');
            // 输入框插在按钮之前（按钮已创建，这里把它移到输入框之后）
            contentEl.appendChild(buttons);
            input.addEventListener('input', () => {
                this.typed = input.value.trim();
                confirmBtn.toggleClass('is-disabled', this.typed !== label);
            });
            confirmBtn.toggleClass('is-disabled', true);
        }

        confirmBtn.addEventListener('click', () => {
            if (this.opts.requireTyping && this.typed !== this.opts.requireTyping) {
                new Notice(`请输入「${this.opts.requireTyping}」以确认`);
                return;
            }
            this.close();
            this.opts.onConfirm();
        });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** 删除标签时的候选选择器（列出全库实际出现的标签及次数） */
class TagPickModal extends SuggestModal<TagUsage> {
    private readonly usages: TagUsage[];
    private readonly onPick: (tag: string) => void;

    constructor(app: App, usages: TagUsage[], onPick: (tag: string) => void) {
        super(app);
        this.usages = usages;
        this.onPick = onPick;
        this.emptyStateText = '没有匹配的标签';
        this.setPlaceholder('输入标签名筛选…');
        this.setInstructions([
            { command: '↑↓', purpose: '选择' },
            { command: '↵', purpose: '查看影响范围' },
            { command: 'esc', purpose: '取消' },
        ]);
    }

    getSuggestions(query: string): TagUsage[] {
        const q = query.trim();
        if (!q) return this.usages;
        const search = prepareFuzzySearch(q);
        return this.usages
            .map((u) => ({ u, m: search(u.tag) }))
            .filter((r) => r.m)
            .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
            .map((r) => r.u);
    }

    renderSuggestion(usage: TagUsage, el: HTMLElement): void {
        el.addClass('pdfreader-quick-tag-suggestion');
        el.createDiv({ cls: 'pdfreader-quick-tag-name', text: `#${usage.tag}` });
        el.createDiv({
            cls: 'pdfreader-quick-tag-desc',
            text: `出现在 ${usage.fileCount} 篇笔记，共 ${usage.occurrences} 处`,
        });
    }

    onChooseSuggestion(usage: TagUsage): void {
        this.onPick(usage.tag);
    }
}

export class TagSyncModule implements PluginModule {
    private ctx: ModuleContext;

    constructor(ctx: ModuleContext) {
        this.ctx = ctx;
    }

    private get app(): App {
        return this.ctx.plugin.app;
    }

    load(): void {
        const plugin = this.ctx.plugin;

        plugin.addCommand({
            id: 'sync-tag-changes',
            name: '同步标签改名到笔记',
            checkCallback: (checking) => {
                if (!this.hasPendingRenames()) return false;
                if (!checking) this.openSettingsTab();
                return true;
            },
        });

        plugin.addCommand({
            id: 'delete-tag-from-notes',
            name: '删除标签（从所有笔记中移除某个标签）',
            callback: () => void this.openDeletePicker(),
        });
    }

    unload(): void {
        // 无事件注册，无需清理
    }

    // ========== 待同步改名（供设置面板使用） ==========

    /**
     * 待同步到笔记的改名。
     * 这些条目是用户在设置面板里改名的瞬间由 renameTag() 登记的，
     * 不是对比新旧词表推断出来的 —— 因此不存在歧义，也无需人工确认配对。
     */
    getPendingRenames(): PendingRename[] {
        return this.ctx.getSettings().pendingTagRenames ?? [];
    }

    /** 是否有待同步的改名 */
    hasPendingRenames(): boolean {
        return this.getPendingRenames().length > 0;
    }

    /** 仅供设置面板拉取同步入口 */
    openSettingsTab(): void {
        const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
        if (setting?.open && setting?.openTabById) {
            setting.open();
            setting.openTabById(this.ctx.plugin.manifest.id);
        } else {
            new Notice('请在 设置 → 文献阅读助手 → 标签管理 中同步标签改名');
        }
    }

    // ========== 改名同步 ==========

    /**
     * 把待同步的改名落到笔记正文，成功后清空待办。
     * 与旧版不同：这里不需要勾选与配对确认，因为每条待办都精确对应一个 id 的一次改名。
     */
    async applyPendingRenames(): Promise<void> {
        // 兜底规范化：to 两端空白会写出 `# 名`（`#` 后跟空格不是 Obsidian 标签）
        const pending = this.getPendingRenames()
            .map((p) => ({ ...p, to: p.to.trim() }))
            .filter((p) => p.from !== p.to && p.to !== '');
        if (pending.length === 0) {
            await this.clearPendingRenames();
            return;
        }

        const ops: TagOp[] = pending.map((p) => ({ from: p.from, to: p.to }));
        const summary = pending.map((p) => `#${p.from} → #${p.to}`).join('、');

        const edits = await this.planEdits(ops);
        const total = edits.reduce((sum, e) => sum + e.count, 0);

        if (edits.length === 0) {
            new Notice('没有笔记包含这些旧标签名，待办已清空');
            await this.clearPendingRenames();
            return;
        }

        new TagChangeConfirmModal(this.app, {
            title: '同步标签改名到笔记',
            summary: [
                `将执行：${summary}`,
                `影响 ${edits.length} 篇笔记，共 ${total} 处。只改写标签本身 —— `
                    + '批注链接与你写的文字保持原样，也不会增删任何一行。',
                '此操作直接改写笔记原文，无法撤销，请先确认预览内容无误。',
            ],
            files: edits,
            requireTyping: total >= TYPING_CONFIRM_THRESHOLD ? pending[0].from : undefined,
            confirmLabel: '确认同步',
            onConfirm: () => {
                void (async () => {
                    const { changed, failed } = await this.execute(edits, ops);
                    if (failed.length > 0) {
                        // 不提供撤销，因此必须如实报出失败，而不是静默跳过
                        new Notice(
                            `标签改名部分失败：成功 ${changed} 篇，失败 ${failed.length} 篇`
                                + `（${failed.join('、')}）\n失败的笔记保留旧标签名，待办未清空，可重试`,
                            8000
                        );
                    } else {
                        await this.clearPendingRenames();
                        new Notice(`标签改名完成：${changed} 篇笔记 / ${total} 处`);
                    }
                })();
            },
        }).open();
    }

    /**
     * 撤销改名：把词表里的名字改回旧名，并清空待办。
     * 等价于「我改错了」—— 词表与笔记重新一致，不留悬空状态。
     */
    async revertPendingRenames(): Promise<void> {
        const settings = this.ctx.getSettings();
        const pending = [...(settings.pendingTagRenames ?? [])];

        for (const p of pending) {
            const tag = settings.quickTags.find((t) => t.id === p.id);
            if (tag) tag.name = p.from;
        }
        settings.pendingTagRenames = [];
        await this.ctx.saveSettings();

        const names = pending.map((p) => `#${p.to} → #${p.from}`).join('、');
        new Notice(pending.length > 0 ? `已撤销改名：${names}` : '没有待撤销的改名');
    }

    /** 清空待同步改名（同步完成后调用） */
    private async clearPendingRenames(): Promise<void> {
        const settings = this.ctx.getSettings();
        settings.pendingTagRenames = [];
        await this.ctx.saveSettings();
    }

    // ========== 删除标签 ==========

    /** 打开删除候选选择器：扫描全库列出实际出现的标签 */
    async openDeletePicker(): Promise<void> {
        new Notice('正在扫描全库标签…');
        const usages = await this.scanVaultTags();
        if (usages.length === 0) {
            new Notice('没有在任何笔记中发现正文标签');
            return;
        }
        new TagPickModal(this.app, usages, (tag) => void this.confirmDeleteFromNotes(tag)).open();
    }

    /** 删除前的逐行预览与确认（设置面板删除标签行后也复用此入口） */
    async confirmDeleteFromNotes(tag: string): Promise<void> {
        const ops: TagOp[] = [{ from: tag, to: null }];
        const edits = await this.planEdits(ops);
        const total = edits.reduce((sum, e) => sum + e.count, 0);

        if (edits.length === 0) {
            new Notice(`没有笔记包含 #${tag}`);
            return;
        }
        this.showDeleteConfirm([tag], tag, null, edits, total, tag);
    }

    /**
     * 标签刚被移出词表时调用：只有笔记里仍有引用才弹出确认框，否则静默返回。
     * 供设置面板的「✕」按钮使用 —— 从词表删除本身不改笔记，清理笔记是另一件需要确认的事。
     */
    async offerNoteCleanup(tag: string): Promise<void> {
        await this.offerNoteCleanupForNames([tag]);
    }

    /**
     * 同上，但一次检查多个候选名 —— 删除一个「改过名、尚未同步」的标签时，
     * 笔记里可能同时存在旧名与新名（改名尚未落到正文），两处都要查。
     * 命中多个候选名时只弹一次确认框，否则用户要连续确认两次、第二次的标签名还对不上。
     */
    async offerNoteCleanupForNames(candidates: string[]): Promise<void> {
        const names = [...new Set(candidates.filter((n) => !!n))];
        if (names.length === 0) return;

        const seen = new Set<string>();
        const all: FileEdit[] = [];
        let total = 0;
        for (const name of names) {
            const edits = await this.planEdits([{ from: name, to: null }]);
            for (const edit of edits) {
                total += edit.count;
                if (seen.has(edit.file.path)) continue;   // 同一篇笔记命中多个旧名时只列一次
                seen.add(edit.file.path);
                all.push(edit);
            }
        }
        if (total === 0) return;
        this.showDeleteConfirm(
            names,
            names.join(' / '),
            `笔记中还有这些名字的引用：${names.map((n) => `#${n}`).join('、')}`,
            all,
            total,
            names[0]
        );
    }

    /**
     * 删除确认框：逐行预览 + 大范围时要求手打标签名。
     * @param names 本次要删除的所有标签名（改名未同步时可能是旧名 + 新名两个）
     * @param label 展示用的名字（提示文案）
     * @param vocabNote 来自词表删除时的补充说明行
     * @param typingToken 需要手打的字样；为空表示无需手打
     */
    private showDeleteConfirm(
        names: string[],
        label: string,
        vocabNote: string | null,
        edits: FileEdit[],
        total: number,
        typingToken?: string
    ): void {
        const ops: TagOp[] = names.map((from) => ({ from, to: null }));
        new TagChangeConfirmModal(this.app, {
            title: `删除标签 #${label}`,
            summary: [
                vocabNote ?? `将从 ${edits.length} 篇笔记中移除 #${label}，共 ${total} 处。`,
                '只会删掉标签本身和一个相邻空格，不会删除该行的其他内容，也不会删行。',
                '此操作无法撤销，请先确认预览内容无误。',
            ],
            files: edits,
            requireTyping: total >= TYPING_CONFIRM_THRESHOLD ? typingToken : undefined,
            confirmLabel: `删除 ${total} 处`,
            onConfirm: () => {
                void (async () => {
                    const { changed, failed } = await this.execute(edits, ops);
                    new Notice(
                        failed.length > 0
                            ? `已从 ${changed} 篇笔记中删除 #${label}，${failed.length} 篇失败：${failed.join('、')}`
                            : `已从 ${changed} 篇笔记中删除 #${label}（共 ${total} 处）`,
                        failed.length > 0 ? 8000 : 4000
                    );
                })();
            },
        }).open();
    }

    // ========== 扫描 ==========

    /** 扫描全库正文标签，返回按出现次数降序的候选列表 */
    private async scanVaultTags(): Promise<TagUsage[]> {
        const byTag = new Map<string, { files: Set<string>; count: number }>();

        for (const file of this.app.vault.getMarkdownFiles()) {
            if (this.isExcluded(file.path)) continue;
            let text: string;
            try {
                text = await this.readFileText(file);
            } catch {
                continue;   // 单文件读取失败不影响整体扫描
            }
            for (const [tag, count] of collectTagsFromText(text)) {
                const slot = byTag.get(tag) ?? { files: new Set<string>(), count: 0 };
                slot.files.add(file.path);
                slot.count += count;
                byTag.set(tag, slot);
            }
        }

        return [...byTag.entries()]
            .map(([tag, v]) => ({ tag, fileCount: v.files.size, occurrences: v.count }))
            .sort((a, b) => b.occurrences - a.occurrences || a.tag.localeCompare(b.tag));
    }

    // ========== 改写引擎 ==========

    /** 排除插件配置目录（.obsidian 内的 md 不应被改写） */
    private isExcluded(path: string): boolean {
        const configDir = this.app.vault.configDir;
        return !!configDir && (path === configDir || path.startsWith(`${configDir}/`));
    }

    /** 查找某文件已打开的 Markdown 视图（用于走编辑器缓冲读写） */
    private findView(file: TFile): MarkdownView | null {
        let found: MarkdownView | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (found) return;
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === file.path) found = view;
        });
        return found;
    }

    /** 读取文件当前文本：编辑器缓冲优先，保证未保存的修改也被纳入 */
    private async readFileText(file: TFile): Promise<string> {
        const view = this.findView(file);
        if (view?.editor) return view.editor.getValue();
        return await this.app.vault.cachedRead(file);
    }

    /** 扫描全库，算出每个待改写文件及其逐行预览 */
    private async planEdits(ops: TagOp[]): Promise<FileEdit[]> {
        const edits: FileEdit[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (this.isExcluded(file.path)) continue;

            let text: string;
            try {
                text = await this.readFileText(file);
            } catch {
                continue;
            }

            const { count } = applyOps(text, ops);
            if (count === 0) continue;

            edits.push({ file, count, preview: buildPreview(text, ops) });
        }
        return edits;
    }

    /**
     * 执行改写：逐个文件写入。
     * 未打开的文件走 vault.process()（原子读改写，避免覆盖并发修改）；
     * 已打开的文件走编辑器 setValue，避免与未保存缓冲打架。
     *
     * 注意：本插件**不提供撤销**（旧版的备份+还原会无条件覆盖整篇笔记，
     * 把同步之后新写的内容一并抹掉，风险高于收益）。因此这里把失败如实报出来，
     * 由调用方提示用户，而不是静默跳过。
     */
    private async execute(
        edits: FileEdit[],
        ops: TagOp[]
    ): Promise<{ changed: number; failed: string[] }> {
        let changed = 0;
        const failed: string[] = [];

        for (const edit of edits) {
            const view = this.findView(edit.file);
            if (view?.editor) {
                const before = view.editor.getValue();
                const { text: after, count } = applyOps(before, ops);
                if (count === 0 || after === before) continue;
                try {
                    view.editor.setValue(after);
                    changed++;
                } catch (e) {
                    console.error(`[TagSync] 改写失败：${edit.file.path}`, e);
                    failed.push(edit.file.path);
                }
            } else {
                let before = '';
                let after = '';
                try {
                    await this.app.vault.process(edit.file, (data) => {
                        before = data;
                        after = applyOps(data, ops).text;
                        return after;
                    });
                } catch (e) {
                    console.error(`[TagSync] 改写失败：${edit.file.path}`, e);
                    failed.push(edit.file.path);
                    continue;
                }
                if (after === before) continue;
                changed++;
            }
        }

        return { changed, failed };
    }

}
