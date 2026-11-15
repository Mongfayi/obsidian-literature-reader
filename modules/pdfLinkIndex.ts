import type { App } from 'obsidian';

/**
 * 「哪些笔记链接到这篇 PDF」的共享缓存。
 *
 * 高亮/跳转/截图/OCR 四个模块原先各自在每次重建时执行
 * `Object.entries(app.metadataCache.resolvedLinks)`，一次批注会触发 4 次全库扫描。
 * resolvedLinks 是不可变快照（元数据变化时整对象替换），因此用对象引用 + 1s TTL
 * 做缓存：同一轮重建里四个模块共享同一次扫描结果。
 */
interface LinkMemo {
    links: Record<string, Record<string, number>>;
    at: number;
    notes: string[];
}

const memo = new Map<string, LinkMemo>();
const TTL_MS = 1000;
/** 防止极长会话下不同 PDF 的条目无限增长 */
const MAX_ENTRIES = 500;

export function notesLinkingToPdf(app: App, pdfPath: string): string[] {
    const links = app.metadataCache.resolvedLinks;
    const now = Date.now();
    const hit = memo.get(pdfPath);
    if (hit && hit.links === links && now - hit.at < TTL_MS) return hit.notes;

    const notes: string[] = [];
    for (const [sourcePath, targets] of Object.entries(links)) {
        if (targets[pdfPath]) notes.push(sourcePath);
    }
    if (memo.size >= MAX_ENTRIES) memo.clear();
    memo.set(pdfPath, { links, at: now, notes });
    return notes;
}
