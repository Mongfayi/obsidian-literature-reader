import { Editor, MarkdownView, TAbstractFile, TFile, parseLinktext } from 'obsidian';
import type { MarkdownAnnotationRecord, ModuleContext } from '../types';

/** 来源笔记中新建的 `==...==` 高亮信息 */
export interface MarkdownHighlightInfo {
    /** 第一个 `==` 的绝对偏移 */
    startOffset: number;
    /** 最后一个 `==` 之后的绝对偏移 */
    endOffset: number;
    /** `==` 内部的原文字 */
    innerText: string;
}

/** 目标笔记中匹配到的链接出现位置 */
interface LinkOccurrence {
    start: number;
    end: number;
    before: string;
    after: string;
}

/** 配对记录保存的目标链接前后上下文长度；用于区分多个相同链接 */
const CONTEXT_BEFORE = 100;
const CONTEXT_AFTER = 160;

/**
 * Markdown 批注链接 ↔ 来源 `==高亮==` 同步器。
 *
 * 目标笔记中的「定位」链接只指向来源文件的标题，无法直接从链接文本定位到具体高亮；
 * 因此批注创建时在设置里登记配对记录（链接文本 + 目标侧上下文 + 来源侧原文/偏移）。
 * 删除链接后匹配不到记录，就撤销来源笔记中由插件写入的 `==` 包裹（保留正文文字）。
 */
export class MarkdownAnnotationSync {
    private readonly syncTimers = new Map<string, number>();
    private readonly syncingTargets = new Set<string>();
    private initialSyncTimer: number | null = null;

    constructor(private readonly ctx: ModuleContext) {}

    /** 批注创建成功后登记配对记录 */
    record(
        sourceFile: TFile,
        targetFile: TFile,
        link: string,
        linkStartOffset: number,
        highlight: MarkdownHighlightInfo,
        targetEditor: Editor
    ): void {
        const content = targetEditor.getValue();
        const linkEnd = linkStartOffset + link.length;
        const innerLink = link.replace(/^\[\[/, '').replace(/\]\]$/, '');
        const pipeIndex = innerLink.indexOf('|');
        const rawTarget = pipeIndex >= 0 ? innerLink.slice(0, pipeIndex) : innerLink;
        const rawLabel = pipeIndex >= 0 ? innerLink.slice(pipeIndex + 1) : '';
        const parsedTarget = parseLinktext(rawTarget);
        const record: MarkdownAnnotationRecord = {
            id: newMarkdownAnnotationId(),
            targetPath: targetFile.path,
            sourcePath: sourceFile.path,
            linkText: link,
            sourceSubpath: parsedTarget.subpath,
            linkLabel: rawLabel || this.ctx.getSettings().annotationLinkLabel,
            targetBefore: content.slice(Math.max(0, linkStartOffset - CONTEXT_BEFORE), linkStartOffset),
            targetAfter: content.slice(linkEnd, Math.min(content.length, linkEnd + CONTEXT_AFTER)),
            highlightText: highlight.innerText,
            sourceStartOffset: highlight.startOffset,
            createdAt: Date.now(),
        };
        this.getRecords().push(record);
        void this.saveSafely();
    }

    /**
     * 是否存在指向给定来源（路径 + 子路径）的配对记录。
     *
     * 这是判断「点击的链接是否本插件生成的『定位』链接」的**唯一**判据
     * （见 `MarkdownReadingModule.takeOverLocatorClick`）：只有登记过的链接才接管导航，
     * 用户手写的同名链接、以及没有配对记录的旧链接都保持 Obsidian 原生行为。
     */
    hasRecordForSource(targetPath: string, sourcePath: string, subpath: string): boolean {
        if (targetPath.length === 0 || sourcePath.length === 0) return false;
        return this.getRecords().some(
            (record) =>
                record.targetPath === targetPath
                && record.sourcePath === sourcePath
                && record.sourceSubpath === subpath
        );
    }

    /**
     * 找到「定位」链接对应的配对记录。
     *
     * 同一链接文本可能在目标笔记里出现多次（同一处批注被重复插入链接），
     * 因此用「第几次出现」（occurrenceIndex，从 0 起）+ 记录里登记的前后文上下文
     * 把记录与出现位置一一配对；无法配对时退回该链接文本的第一条记录。
     */
    resolveRecordForLink(
        targetPath: string,
        linkText: string,
        occurrenceIndex: number,
        targetContent: string | null
    ): MarkdownAnnotationRecord | null {
        const records = this.getRecords().filter(
            (record) => record.targetPath === targetPath && record.linkText === linkText
        );
        if (records.length === 0) return null;
        if (records.length === 1 || targetContent == null || occurrenceIndex < 0) return records[0];

        const occurrences = this.findLinkOccurrences(targetContent, linkText);
        if (occurrenceIndex >= occurrences.length) return records[0];

        const { matched, removed } = this.matchRecordsToOccurrences(records, occurrences);
        const hit = matched.find((pair) => pair.occurrence === occurrences[occurrenceIndex]);
        return hit?.record ?? removed[0] ?? records[0];
    }

    /**
     * 在来源笔记内容中定位配对记录对应的 `==…==` 范围（含两侧 `==`）。
     * 点击「定位」链接时用它把「只指向标题的链接」还原成真正被批注的那段文字。
     */
    locateHighlightRange(content: string, record: MarkdownAnnotationRecord): { start: number; end: number } | null {
        return this.findWrappedRange(content, record);
    }

    handleRename(file: TAbstractFile, oldPath: string): void {
        if ((file instanceof TFile) === false || file.extension !== 'md') return;
        const app = this.ctx.plugin.app;
        let changed = false;
        for (const record of this.getRecords()) {
            const targetChanged = record.targetPath === oldPath;
            const sourceChanged = record.sourcePath === oldPath;
            if (targetChanged) {
                record.targetPath = file.path;
                changed = true;
            }
            if (sourceChanged) {
                record.sourcePath = file.path;
                changed = true;
                // 来源文件改名后，Obsidian 会更新目标笔记里的链接；这里同步生成新链接文本。
                const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
                if (sourceFile instanceof TFile && sourceFile.extension === 'md') {
                    record.linkText = app.fileManager.generateMarkdownLink(
                        sourceFile,
                        record.targetPath,
                        record.sourceSubpath || undefined,
                        record.linkLabel || undefined
                    );
                }
            }
        }
        if (changed) void this.saveSafely();
    }

    handleDelete(file: TAbstractFile): void {
        if ((file instanceof TFile) === false || file.extension !== 'md') return;
        const sourceRecordIds = new Set<string>();
        let hasTargetRecord = false;
        for (const record of this.getRecords()) {
            if (record.sourcePath === file.path) sourceRecordIds.add(record.id);
            if (record.targetPath === file.path) hasTargetRecord = true;
        }
        if (sourceRecordIds.size > 0) {
            this.deleteRecords(sourceRecordIds);
            void this.saveSafely();
        }
        if (hasTargetRecord) this.schedule(file.path);
    }

    schedule(targetPath: string): void {
        const existing = this.syncTimers.get(targetPath);
        if (existing != null) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
            this.syncTimers.delete(targetPath);
            void this.syncTarget(targetPath);
        }, 300);
        this.syncTimers.set(targetPath, timer);
    }

    startInitialSync(delay = 800): void {
        if (this.initialSyncTimer != null) window.clearTimeout(this.initialSyncTimer);
        this.initialSyncTimer = window.setTimeout(() => {
            this.initialSyncTimer = null;
            void this.syncAll();
        }, delay);
    }

    unload(): void {
        if (this.initialSyncTimer != null) {
            window.clearTimeout(this.initialSyncTimer);
            this.initialSyncTimer = null;
        }
        for (const timer of this.syncTimers.values()) window.clearTimeout(timer);
        this.syncTimers.clear();
        this.syncingTargets.clear();
    }

    async syncAll(): Promise<void> {
        const targets = new Set(this.getRecords().map((record) => record.targetPath));
        for (const targetPath of targets) {
            await this.syncTarget(targetPath);
        }
    }

    /**
     * 读取目标笔记当前内容，并与配对记录中的链接做匹配。
     * 匹配不到链接的记录视为“链接已被删除”，随后撤销来源笔记中的高亮。
     */
    private async syncTarget(targetPath: string): Promise<void> {
        if (this.syncingTargets.has(targetPath)) return;
        this.syncingTargets.add(targetPath);
        try {
            const targetRecords = this.getRecords().filter((record) => record.targetPath === targetPath);
            if (targetRecords.length === 0) return;

            const app = this.ctx.plugin.app;
            const file = app.vault.getAbstractFileByPath(targetPath);
            let content: string | null = null;
            if (file instanceof TFile && file.extension === 'md') {
                content = await this.readMarkdownContent(file);
            }
            if (content == null) {
                // 目标文件仍存在但读取失败：不能据此判断链接已删除，保持原状。
                if (file instanceof TFile) return;
                // 目标笔记已删除：链接全部消失，来源高亮也应同步撤销。
                await this.removeSourceHighlights(targetRecords);
                this.deleteRecords(new Set(targetRecords.map((record) => record.id)));
                await this.saveSafely();
                return;
            }

            const groups = new Map<string, MarkdownAnnotationRecord[]>();
            for (const record of targetRecords) {
                const group = groups.get(record.linkText) ?? [];
                group.push(record);
                groups.set(record.linkText, group);
            }

            const removed: MarkdownAnnotationRecord[] = [];
            let changed = false;
            for (const [linkText, group] of groups) {
                const occurrences = this.findLinkOccurrences(content, linkText);
                const result = this.matchRecordsToOccurrences(group, occurrences);
                for (const { record, occurrence } of result.matched) {
                    if (record.targetBefore !== occurrence.before || record.targetAfter !== occurrence.after) {
                        record.targetBefore = occurrence.before;
                        record.targetAfter = occurrence.after;
                        changed = true;
                    }
                }
                removed.push(...result.removed);
            }

            if (removed.length > 0) {
                await this.removeSourceHighlights(removed);
                this.deleteRecords(new Set(removed.map((record) => record.id)));
                changed = true;
            }
            if (changed) await this.saveSafely();
        } catch (e) {
            console.warn('[MarkdownAnnotationSync] 同步 Markdown 批注高亮失败:', e);
        } finally {
            this.syncingTargets.delete(targetPath);
        }
    }

    private async readMarkdownContent(file: TFile): Promise<string | null> {
        try {
            if (this.ctx.readNoteContent != null) {
                return await this.ctx.readNoteContent(file, { editorMode: 'source' });
            }
            return await this.ctx.plugin.app.vault.cachedRead(file);
        } catch (e) {
            console.warn('[MarkdownAnnotationSync] 读取批注目标笔记失败:', e);
            return null;
        }
    }

    private findLinkOccurrences(content: string, linkText: string): LinkOccurrence[] {
        const result: LinkOccurrence[] = [];
        if (linkText.length === 0) return result;
        let index = content.indexOf(linkText);
        while (index !== -1) {
            const end = index + linkText.length;
            result.push({
                start: index,
                end,
                before: content.slice(Math.max(0, index - CONTEXT_BEFORE), index),
                after: content.slice(end, Math.min(content.length, end + CONTEXT_AFTER)),
            });
            index = content.indexOf(linkText, end);
        }
        return result;
    }

    private matchRecordsToOccurrences(
        records: MarkdownAnnotationRecord[],
        occurrences: LinkOccurrence[]
    ): { matched: Array<{ record: MarkdownAnnotationRecord; occurrence: LinkOccurrence }>; removed: MarkdownAnnotationRecord[] } {
        const pairs: Array<{
            record: MarkdownAnnotationRecord;
            occurrence: LinkOccurrence;
            occurrenceIndex: number;
            score: number;
        }> = [];
        for (const record of records) {
            for (let i = 0; i < occurrences.length; i++) {
                pairs.push({
                    record,
                    occurrence: occurrences[i],
                    occurrenceIndex: i,
                    score: this.contextMatchScore(record, occurrences[i]),
                });
            }
        }
        // 强上下文优先；分数相同时保留更早创建的记录，删除后来创建的重复链接更符合直觉。
        pairs.sort((a, b) => b.score - a.score || a.record.createdAt - b.record.createdAt);

        const usedOccurrences = new Set<number>();
        const matchedRecords = new Set<MarkdownAnnotationRecord>();
        const matched: Array<{ record: MarkdownAnnotationRecord; occurrence: LinkOccurrence }> = [];
        for (const pair of pairs) {
            if (usedOccurrences.has(pair.occurrenceIndex) || matchedRecords.has(pair.record)) continue;
            usedOccurrences.add(pair.occurrenceIndex);
            matchedRecords.add(pair.record);
            matched.push({ record: pair.record, occurrence: pair.occurrence });
        }
        return {
            matched,
            removed: records.filter((record) => matchedRecords.has(record) === false),
        };
    }

    private contextMatchScore(record: MarkdownAnnotationRecord, occurrence: LinkOccurrence): number {
        let score = this.commonSuffixLength(record.targetBefore, occurrence.before)
            + this.commonPrefixLength(record.targetAfter, occurrence.after);
        if (record.targetBefore.length > 0 && occurrence.before.endsWith(record.targetBefore)) score += 10000;
        if (record.targetAfter.length > 0 && occurrence.after.startsWith(record.targetAfter)) score += 10000;
        return score;
    }

    private commonSuffixLength(a: string, b: string): number {
        const max = Math.min(a.length, b.length);
        let count = 0;
        while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
        return count;
    }

    private commonPrefixLength(a: string, b: string): number {
        const max = Math.min(a.length, b.length);
        let count = 0;
        while (count < max && a[count] === b[count]) count++;
        return count;
    }



    private getRecords(): MarkdownAnnotationRecord[] {
        const settings = this.ctx.getSettings();
        if (!Array.isArray(settings.markdownAnnotationRecords)) {
            settings.markdownAnnotationRecords = [];
        }
        return settings.markdownAnnotationRecords;
    }

    private deleteRecords(ids: Set<string>): void {
        if (ids.size === 0) return;
        const records = this.getRecords();
        this.ctx.getSettings().markdownAnnotationRecords = records.filter((record) => ids.has(record.id) === false);
    }

    private async removeSourceHighlights(records: MarkdownAnnotationRecord[]): Promise<void> {
        for (const record of records) {
            await this.removeSourceHighlight(record);
        }
    }

    private async removeSourceHighlight(record: MarkdownAnnotationRecord): Promise<void> {
        const app = this.ctx.plugin.app;
        const sourceFile = app.vault.getAbstractFileByPath(record.sourcePath);
        if (sourceFile instanceof TFile === false || sourceFile.extension !== 'md') return;

        const editor = this.findMarkdownEditor(sourceFile);
        if (editor != null) {
            const content = editor.getValue();
            const range = this.findWrappedRange(content, record);
            if (range == null) return;
            const inner = content.slice(range.start + 2, range.end - 2);
            editor.replaceRange(inner, editor.offsetToPos(range.start), editor.offsetToPos(range.end));
            return;
        }

        try {
            await app.vault.process(sourceFile, (data) => {
                const range = this.findWrappedRange(data, record);
                if (range == null) return data;
                return data.slice(0, range.start)
                    + data.slice(range.start + 2, range.end - 2)
                    + data.slice(range.end);
            });
        } catch (e) {
            console.warn('[MarkdownAnnotationSync] 撤销来源高亮失败:', e);
        }
    }

    private findMarkdownEditor(file: TFile): Editor | null {
        let result: Editor | null = null;
        this.ctx.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (result != null) return;
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
                const editor = leaf.view.editor;
                if (editor != null) result = editor;
            }
        });
        return result;
    }

    /** 在来源内容中定位 `==...==`。优先按当时记录的原文精确匹配，内容变动后按偏移就近兜底。 */
    private findWrappedRange(content: string, record: MarkdownAnnotationRecord): { start: number; end: number } | null {
        const wrapped = '==' + record.highlightText + '==';
        let exactStart = -1;
        let search = content.indexOf(wrapped);
        while (search !== -1) {
            if (exactStart === -1
                || Math.abs(search - record.sourceStartOffset) < Math.abs(exactStart - record.sourceStartOffset)) {
                exactStart = search;
            }
            search = content.indexOf(wrapped, search + wrapped.length);
        }
        if (exactStart !== -1) return { start: exactStart, end: exactStart + wrapped.length };

        const expected = record.sourceStartOffset;
        if (expected >= 0 && content.startsWith('==', expected)) {
            const close = content.indexOf('==', expected + 2);
            if (close !== -1) return { start: expected, end: close + 2 };
        }

        // 高亮内部文字被改过时，仍尝试在预期偏移附近找到一对 `==` 包裹。
        const searchStart = Math.max(0, expected - 200);
        const searchEnd = Math.min(content.length, expected + Math.max(record.highlightText.length, 20) + 400);
        let best: { start: number; end: number } | null = null;
        let index = content.indexOf('==', searchStart);
        while (index !== -1 && index < searchEnd) {
            const close = content.indexOf('==', index + 2);
            if (close !== -1 && this.isRelatedHighlight(content.slice(index + 2, close), record.highlightText)) {
                const candidate = { start: index, end: close + 2 };
                if (best == null
                    || Math.abs(candidate.start - expected) < Math.abs(best.start - expected)) {
                    best = candidate;
                }
            }
            index = content.indexOf('==', index + 2);
        }
        return best;
    }

    /** 仅当附近 `==...==` 的内部文字与记录原文明显相关时，才允许按偏移兜底删除。 */
    private isRelatedHighlight(candidate: string, original: string): boolean {
        if (candidate.length === 0 || original.length === 0) return false;
        if (candidate.includes(original) || original.includes(candidate)) return true;
        const minLength = Math.min(candidate.length, original.length);
        return this.commonPrefixLength(candidate, original) >= Math.min(8, Math.ceil(minLength * 0.6));
    }

    private async saveSafely(): Promise<void> {
        try {
            await this.ctx.saveSettings();
        } catch (e) {
            console.error('[MarkdownAnnotationSync] 保存 Markdown 批注配对记录失败:', e);
        }
    }
}

/** 生成 Markdown 批注配对记录 id。 */
function newMarkdownAnnotationId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
