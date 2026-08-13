import { App, WorkspaceLeaf } from 'obsidian';

/**
 * 共享轮询调度器
 *
 * 截图批注 / OCR 批注 / 主文献三个模块都需要 2s 轮询兜底注入工具条按钮。
 * 共享一个 setInterval 避免每模块独立定时器；任务全部移除时自动停止。
 */
export class SharedPoller {
    private timer: number | null = null;
    private readonly tasks = new Set<() => void>();

    constructor(private readonly intervalMs: number) { }

    /** 注册轮询任务，返回移除函数 */
    add(task: () => void): () => void {
        this.tasks.add(task);
        return () => this.remove(task);
    }

    /** 启动定时器（已有定时器或没有任务时不重复启动；幂等） */
    start(): void {
        if (this.timer !== null || this.tasks.size === 0) return;
        this.timer = window.setInterval(() => {
            for (const task of this.tasks) {
                try {
                    task();
                } catch (e) {
                    console.error('[pdf-reader] 工具条轮询任务失败:', e);
                }
            }
        }, this.intervalMs);
    }

    private remove(task: () => void): void {
        this.tasks.delete(task);
        if (this.tasks.size === 0 && this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
    }
}

/** 插件级共享轮询器（所有工具条注入模块共用） */
export const toolbarPoller = new SharedPoller(2000);

/**
 * 清理已关闭叶子（或已销毁视图）的陈旧缓存条目。
 * 叶子关闭时工具栏注入模块的 Map/Set 缓存不会自动清除
 * （plugin.register 清理只在插件卸载时执行），在每次注入时顺带修剪。
 */
export function pruneStaleLeaves<T>(
    app: App,
    entries: Map<WorkspaceLeaf, T> | Set<WorkspaceLeaf>
): void {
    const openLeaves = new Set<WorkspaceLeaf>();
    app.workspace.iterateAllLeaves((leaf) => openLeaves.add(leaf));

    if (entries instanceof Set) {
        for (const leaf of entries) {
            if (!openLeaves.has(leaf)) entries.delete(leaf);
        }
    } else {
        for (const leaf of [...entries.keys()]) {
            if (!openLeaves.has(leaf)) entries.delete(leaf);
        }
    }
}
