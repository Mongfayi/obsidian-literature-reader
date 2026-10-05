/**
 * 「定位」链接点击时的纯文本/DOM 定位工具。
 *
 * 从 MarkdownReadingModule 抽出来单独成文件：这些函数不依赖 Obsidian API，
 * 只做「点击的链接 → 原文里的第几个 wikilink」与「`==…==` 在全文中的序号」这类计算，
 * 因此可以脱离 Obsidian 单独验证（见仓库中对真实笔记的校验脚本）。
 */

/** 点击「定位」链接时收集到的信息 */
export interface LocatorClickInfo {
    /** 阅读模式为 data-href（`路径#子路径`），编辑器模式为完整 `[[…]]` 原文 */
    linktext: string;
    /** `路径#子路径` 形式的目标（用于在笔记原文里反查完整 wikilink） */
    href: string;
    /** 链接显示文字 */
    label: string;
    /** 链接所在笔记（= 批注目标笔记）路径 */
    notePath: string;
    /** 阅读模式下该链接在同类链接中的序号（-1 = 未知） */
    occurrence: number;
    /** 编辑器模式下点击位置在笔记中的偏移（null = 未知） */
    clickOffset: number | null;
}

/** 去掉 wikilink 包裹与别名，得到 `路径#子路径` */
export function stripLinkDecorations(linktext: string): string {
    return linktext.replace(/^\[\[/, '').replace(/\]\]$/, '');
}

/** 取 wikilink 的显示文字（无别名时返回空串） */
export function extractLinkLabel(linktext: string): string {
    const clean = stripLinkDecorations(linktext);
    const pipe = clean.indexOf('|');
    return pipe >= 0 ? clean.slice(pipe + 1).trim() : '';
}

/** 在笔记原文里收集指向 `href` 的完整 wikilink（含别名），按出现顺序 */
export function collectRawLinks(content: string, href: string): { text: string; start: number; end: number }[] {
    const result: { text: string; start: number; end: number }[] = [];
    if (href.length === 0) return result;
    const needle = '[[' + href;
    let index = content.indexOf(needle);
    while (index !== -1) {
        const close = content.indexOf(']]', index + 2);
        if (close === -1) break;
        result.push({ text: content.slice(index, close + 2), start: index, end: close + 2 });
        index = content.indexOf(needle, close + 2);
    }
    return result;
}

/**
 * 找出被点击的那个 wikilink 原文，以及它在「相同原文的链接」中的序号。
 * 编辑器模式用点击偏移命中，阅读模式用渲染顺序序号命中，两者都拿不到时返回 null。
 */
export function pickClickedLink(
    content: string, info: LocatorClickInfo
): { text: string; sameTextIndex: number } | null {
    const links = collectRawLinks(content, info.href);
    if (links.length === 0) return null;

    let hit: { text: string; start: number; end: number } | null = null;
    if (info.clickOffset != null) {
        const offset = info.clickOffset;
        hit = links.find((link) => offset >= link.start && offset <= link.end) ?? null;
    } else if (info.occurrence >= 0 && info.occurrence < links.length) {
        hit = links[info.occurrence];
    }
    if (hit == null) return null;

    let sameTextIndex = 0;
    for (const link of links) {
        if (link === hit) break;
        if (link.text === hit.text) sameTextIndex++;
    }
    return { text: hit.text, sameTextIndex };
}

/** 统计 offset 之前出现过的 `==…==` 对数：阅读模式据此按顺序取渲染出的 `<mark>` */
export function countHighlightPairsBefore(content: string, offset: number): number {
    let count = 0;
    let index = content.indexOf('==');
    while (index !== -1 && index < offset) {
        const close = content.indexOf('==', index + 2);
        if (close === -1) break;
        count++;
        index = content.indexOf('==', close + 2);
    }
    return count;
}

/**
 * 在一行原文里找出包含指定列位置的 wikilink（返回含 `[[…]]` 的完整原文）。
 *
 * Live Preview 下光标在链接内部时，链接会展开成原始文本，此时编辑器的
 * `getClickableTokenAt()` 给出的 token 可能不含别名（甚至不是 `internal-link`），
 * 导致「定位」链接被当成普通链接放行给 Obsidian 默认行为。
 * 直接读行文本可以拿到链接原文（含别名），与渲染状态无关。
 */
export function findLinkAtColumn(lineText: string, ch: number): { text: string; start: number; end: number } | null {
    let index = lineText.indexOf('[[');
    while (index !== -1) {
        const close = lineText.indexOf(']]', index + 2);
        if (close === -1) break;
        const end = close + 2;
        if (ch >= index && ch <= end) return { text: lineText.slice(index, end), start: index, end };
        index = lineText.indexOf('[[', end);
    }
    return null;
}

/** 比较 `==…==` 原文与渲染出的 `<mark>` 文本：忽略空白与常见行内标记 */
export function normalizeHighlightText(text: string): string {
    return text.replace(/[*_`~]/g, '').replace(/\s+/g, '');
}

/**
 * 统计渲染容器中位于 anchor 之前的同目标链接数量（= 该链接在阅读视图里的出现序号）。
 * 渲染顺序与原文顺序一致，因此可与原文里的出现序号对齐。
 */
export function countPrecedingSameLinks(container: HTMLElement | null, anchor: HTMLElement, href: string): number {
    if (container == null || href.length === 0) return -1;
    let count = 0;
    for (const candidate of Array.from(container.querySelectorAll<HTMLElement>('a.internal-link'))) {
        if (candidate === anchor) return count;
        const candidateHref = candidate.getAttribute('data-href') ?? candidate.getAttribute('href') ?? '';
        if (candidateHref === href) count++;
    }
    return -1;
}
