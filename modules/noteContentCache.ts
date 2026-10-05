import { Plugin, TAbstractFile, TFile, MarkdownView } from 'obsidian';

export interface ReadNoteOptions {
    /**
     * 信任编辑器缓冲的模式范围：
     *  - 'any'（默认）：任何模式下打开的笔记都读实时缓冲；
     *  - 'source'：仅 source / Live Preview 模式读缓冲（阅读模式下缓冲可能为空/过期，回退磁盘）。
     */
    editorMode?: 'any' | 'source';
}

/**
 * 共享的笔记内容读取缓存。
 *
 * 一次批注写入会触发 3 个高亮模块 + 跳转模块各自防抖重建索引，
 * 过去同一防抖窗口内会各自读一遍同一篇笔记（4× 重复磁盘 I/O）。
 * 这里按笔记路径做短 TTL 缓存，一个重建窗口内只读一次磁盘。
 *
 * 新鲜度保证：
 *  - 打开中的编辑器按模式范围读实时缓冲（批注写入后可能尚未落盘），不走缓存；
 *  - vault 的 modify/delete/rename 事件立即失效对应条目，
 *    因此防抖重建读到的永远是写入后的最新内容。
 */
export class NoteContentCache {
    private cache = new Map<string, { content: string; at: number }>();
    /**
     * 每个路径的「失效代数」。
     *
     * read() 里 await 读盘期间，文件可能被修改/删除/重命名并触发失效；
     * 若不加判定就写回，会把**读取开始前**的旧内容重新塞进缓存，
     * 使接下来 TTL 内的重建读到脏数据（正是本缓存要避免的情况）。
     */
    private generation = new Map<string, number>();

    constructor(
        private readonly plugin: Plugin,
        private readonly ttlMs: number = 500
    ) {}

    /** 注册写入失效监听（插件加载时调用一次；事件随插件卸载自动清理） */
    attach(): void {
        const invalidate = (file: TAbstractFile) => this.invalidate(file.path);
        this.plugin.registerEvent(this.plugin.app.vault.on('modify', invalidate));
        this.plugin.registerEvent(this.plugin.app.vault.on('delete', invalidate));
        this.plugin.registerEvent(
            this.plugin.app.vault.on('rename', (file, oldPath) => {
                this.invalidate(oldPath);
                this.invalidate(file.path);
            })
        );
    }

    /** 失效一条缓存：删除条目并推进代数，使在途读取的结果不再被写回 */
    private invalidate(path: string): void {
        this.cache.delete(path);
        this.generation.set(path, (this.generation.get(path) ?? 0) + 1);
    }

    /** 读取笔记内容：优先打开中的编辑器缓冲，其次磁盘（带短 TTL 缓存） */
    async read(sourceFile: TFile, opts?: ReadNoteOptions): Promise<string> {
        const editorMode = opts?.editorMode ?? 'any';
        const app = this.plugin.app;
        let editorContent: string | null = null;
        app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
            if (editorContent !== null) return;
            const view = leaf.view as MarkdownView;
            if (view.file?.path !== sourceFile.path || !view.editor) return;
            if (editorMode === 'source' && view.getMode() !== 'source') return;
            editorContent = view.editor.getValue();
        });
        if (editorContent !== null) return editorContent;

        const cached = this.cache.get(sourceFile.path);
        const now = Date.now();
        if (cached && now - cached.at < this.ttlMs) return cached.content;
        // 记录读取前的代数：读盘期间若该路径被改动，代数会变，此时不能写回缓存
        const genAtStart = this.generation.get(sourceFile.path) ?? 0;
        const content = await app.vault.read(sourceFile);
        if ((this.generation.get(sourceFile.path) ?? 0) === genAtStart) {
            this.cache.set(sourceFile.path, { content, at: now });
        }
        return content;
    }
}
