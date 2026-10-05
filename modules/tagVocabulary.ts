/**
 * 标签词表解析与批量改写（纯逻辑，不依赖 Obsidian API）
 *
 * 词表以纯文本形式存在插件设置里，每行一条「标签名：描述」。
 * 本模块负责：解析 / 序列化 / 改名配对 diff / 正文标签替换 / 正文标签删除 / 正文标签扫描。
 *
 * 所有改写都只作用于**正文内联标签**：
 *  - 跳过 ``` / ~~~ 围栏代码块
 *  - 跳过行内代码（反引号包裹的片段）
 *  - 标签前必须是行首或空白（因此 [[文件#标签]] 这类标题引用不会被误伤）
 *  - 标签后不能紧跟标签字符（因此 #方向性 不会被当成 #方向）
 */

/** 旧版词表文件路径（vault 根）：首次升级时从这里做一次性导入，之后保持只读 */
export const LEGACY_VOCABULARY_FILE = '凡例“#”.md';

/**
 * 词表条目（解析纯文本时产生，仅用于迁移与导出 —— 它不是持久化格式）
 */
export interface TagEntry {
    /** 标签名（不含 #） */
    name: string;
    /** 说明；无分隔符的行为空串 */
    description: string;
    /** 在词表文本中的行号（0 基） */
    line: number;
}

/**
 * 标签定义：插件设置里的持久化格式。
 *
 * `id` 在创建时生成、此后**永不改变**，是标签的身份标识；
 * 改名只改 `name`。因此「哪个标签改名了」是用户在界面上改动的**记录**，
 * 而不是靠对比新旧文本**推断**出来的 —— 没有歧义，也就不需要人工确认配对。
 */
export interface TagDef {
    id: string;
    name: string;
    description: string;
}

/** 待同步到笔记的改名（用户在界面上改名的瞬间登记，不靠推断） */
export interface PendingRename {
    /** 标签的稳定 id（同一标签的多次改名会折叠为一条） */
    id: string;
    /** 笔记中现存的旧名 */
    from: string;
    /** 词表中的新名 */
    to: string;
}

/** 生成标签 id：优先用 crypto.randomUUID，不可用时回退到时间戳+随机串 */
export function newTagId(): string {
    // 用 window 而非 globalThis：弹出窗口场景下 activeWindow 才是正确的宿主
    const c = (window as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 改名：更新标签名并登记待同步项。
 *
 * 同一标签连续改名会**折叠成一条**（保留最初的 from、更新 to），
 * 所以 A→B→C 最终只需把笔记里的 #A 换成 #C；
 * 若改回原名，则撤销该待办。id 始终不变。
 */
export function renameTag(
    tags: TagDef[],
    pending: PendingRename[],
    id: string,
    newName: string
): { tags: TagDef[]; pending: PendingRename[] } {
    const target = tags.find((t) => t.id === id);
    if (!target) return { tags, pending };

    const nextTags = tags.map((t) => (t.id === id ? { ...t, name: newName } : t));
    const nextPending = pending.map((p) => ({ ...p }));
    const idx = nextPending.findIndex((p) => p.id === id);
    const from = idx >= 0 ? nextPending[idx].from : target.name;

    if (from === newName) {
        if (idx >= 0) nextPending.splice(idx, 1);   // 改回原名 → 撤销待办
    } else if (idx >= 0) {
        nextPending[idx] = { id, from, to: newName };
    } else {
        nextPending.push({ id, from, to: newName });
    }
    return { tags: nextTags, pending: nextPending };
}

/** 删除标签：同时清掉它尚未同步的改名待办 */
export function removeTag(
    tags: TagDef[],
    pending: PendingRename[],
    id: string
): { tags: TagDef[]; pending: PendingRename[] } {
    return {
        tags: tags.filter((t) => t.id !== id),
        pending: pending.filter((p) => p.id !== id),
    };
}

/** 上下移动标签（delta = -1 / +1），越界时原样返回 */
export function moveTag(tags: TagDef[], id: string, delta: number): TagDef[] {
    const i = tags.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= tags.length) return tags;
    const next = [...tags];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
}

/** 查重名（忽略大小写与首尾空白）；excludeId 用于排除自己 */
export function findDuplicateName(tags: TagDef[], name: string, excludeId?: string): TagDef | null {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    return tags.find((t) => t.id !== excludeId && t.name.trim().toLowerCase() === key) ?? null;
}

/** 一行内部的变化：未变前缀 / 被替换片段 / 替换成的片段 / 未变后缀 */
export interface LineDiff {
    prefix: string;
    removed: string;
    /** 删除操作时为空串 */
    added: string;
    suffix: string;
}

/**
 * 求两行的公共前缀与后缀，中间那一段就是真正被改写的内容。
 * 用于在确认框里**只高亮变化的片段**，避免整行加删除线让人误以为整行都会被重写。
 */
export function splitLineChange(before: string, after: string): LineDiff {
    const max = Math.min(before.length, after.length);
    let p = 0;
    while (p < max && before[p] === after[p]) p++;
    let s = 0;
    while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;

    let prefix = before.slice(0, p);
    let removed = before.slice(p, before.length - s);
    let added = after.slice(p, after.length - s);

    // 改名时公共前缀会吃掉标签的 `#`，导致显示成「#方向 → forward」；
    // 把 `#` 还给两侧，读起来才是「#方向 → #forward」
    if (prefix.endsWith('#') && removed && added && !removed.startsWith('#')) {
        prefix = prefix.slice(0, -1);
        removed = `#${removed}`;
        added = `#${added}`;
    }
    return { prefix, removed, added, suffix: before.slice(before.length - s) };
}

/** 正则元字符转义 */
function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析词表文本。每行「标签名：描述」，容忍：
 *  - 行首 `#`（如 `#符合：…`）、Markdown 列表符 / 引用符（从凡例文件导入时常见）
 *  - 全角 `：` 与半角 `:`（取首个出现者）
 *  - 空行、`%%` 注释行、代码围栏、frontmatter 分隔线
 *  - 无分隔符的行：整行作为标签名，描述为空
 * 同名标签去重，保留首次出现。
 */
export function parseTagText(text: string): TagEntry[] {
    const entries: TagEntry[] = [];
    const seen = new Set<string>();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    lines.forEach((raw, index) => {
        let line = raw.trim();
        if (!line) return;
        if (line.startsWith('%%')) return;
        if (line.startsWith('```')) return;
        if (/^-{3,}$/.test(line)) return;

        line = line
            .replace(/^>\s*/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/^#+\s*/, '')
            .trim();
        if (!line) return;

        const sep = line.search(/[：:]/);
        const name = (sep >= 0 ? line.slice(0, sep) : line).trim();
        const description = sep >= 0 ? line.slice(sep + 1).trim() : '';
        if (!name) return;

        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ name, description, line: index });
    });

    return entries;
}

/** 序列化词表（用于导出与从凡例文件导入后的规范化回填） */
export function formatTagText(entries: { name: string; description: string }[]): string {
    return entries
        .map((e) => (e.description ? `${e.name}：${e.description}` : e.name))
        .join('\n');
}

/** 逐行处理文本，跳过 ``` / ~~~ 围栏代码块（围栏行本身也跳过） */
function mapLines(text: string, fn: (line: string) => string): string {
    const lines = text.split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        lines[i] = fn(lines[i]);
    }
    return lines.join('\n');
}

/** 只对行内代码之外的片段应用 fn（按反引号切分，偶数下标在代码外） */
function outsideInlineCode(line: string, fn: (seg: string) => string): string {
    if (!line.includes('`')) return fn(line);
    const parts = line.split('`');
    for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
    return parts.join('`');
}

/**
 * 匹配正文中的某个标签。
 * 前导捕获组：行首或空白；尾随捕获组：紧跟的一个空格 / 制表符（可选）。
 * 负向先行断言保证标签名后不接标签字符，避免 #方向性 被误当成 #方向。
 */
function tagPattern(name: string): RegExp {
    return new RegExp(
        `(^|\\s)#${escapeRegExp(name)}(?![\\p{L}\\p{N}_\\-/])([ \\t]?)`,
        'gu'
    );
}

/** 一次批量改写中的单个操作 */
export interface TagOp {
    /** 笔记中现存的标签名（不含 #） */
    from: string;
    /** 换成的新名（不含 #）；null = 删除该标签 */
    to: string | null;
}

/** 批量前缀树节点：children 按「下一个字符」分叉，op 非空表示从根到此处构成一个已知标签名 */
interface TagOpTrieNode {
    children: Map<string, TagOpTrieNode>;
    op: TagOp | null;
}

/**
 * 批量改写正文中的标签，**一趟同时完成**。
 *
 * 为什么不能逐个 replace：逐个应用时前一次的输出会成为后一次的输入，
 * 于是 `A→B` 与 `B→C` 同批时，第一次改名产出的 `#B` 会被第二次改名再改成 `#C`
 * （原本的 A 被跳过 B 直接变成 C）；若两个标签重名，第一个改名还会吃掉第二个的源文本，
 * 导致所有出现处都变成第一个目标名，而待办记录随后被清空 → 错误结果无从追溯。
 * 一趟扫描让每个位置只被判定一次，语义与用户在界面上登记的意图一致。
 *
 * 边界行为沿用单标签版本：只在行首或空白之后识别（因此 `[[文件#标签]]` 不受影响）、
 * 标签名后不接标签字符（`#方向性` 不会被当成 `#方向`）、跳过代码块与行内代码。
 *
 * @returns 改写后的文本与命中处数
 */
export function applyTagOps(text: string, ops: TagOp[]): { text: string; count: number } {
    const root: TagOpTrieNode = { children: new Map(), op: null };
    let usable = 0;
    for (const op of ops) {
        if (!op.from) continue;
        let node = root;
        for (const ch of op.from) {
            let next = node.children.get(ch);
            if (!next) {
                next = { children: new Map(), op: null };
                node.children.set(ch, next);
            }
            node = next;
        }
        node.op = op;
        usable++;
    }
    if (usable === 0) return { text, count: 0 };

    // 标签名后不能紧跟标签字符，否则 #方向性 会被误当成 #方向。
    // 注意：这两个正则都是模块级复用且带 test()，绝不能加 g 标志 —— 带 g 时 lastIndex
    // 会在多次调用之间累积，导致同一片段里后面的标签被随机跳过。
    const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

    let count = 0;
    const out = mapLines(text, (line) => outsideInlineCode(line, (seg) => {
        let result = '';
        let i = 0;
        while (i < seg.length) {
            const c = seg.charAt(i);
            // 标签必须位于行首或空白之后：因此 [[文件#标签]] 里的 # 不会被误认
            const atLead = i === 0 || /\s/.test(seg.charAt(i - 1));
            if (c !== '#' || !atLead) {
                result += c;
                i++;
                continue;
            }

            // 贪心走到最长的已知标签名
            let node = root;
            let best: { op: TagOp; end: number } | null = null;
            let j = i + 1;
            while (j < seg.length) {
                const next = node.children.get(seg.charAt(j));
                if (!next) break;
                node = next;
                j++;
                const after = j < seg.length ? seg.charAt(j) : '';
                if (node.op && !(after && TAG_CHAR.test(after))) {
                    best = { op: node.op, end: j };
                }
            }
            if (!best) {
                // 不是已知标签：# 原样保留，后续字符照常处理
                result += c;
                i++;
                continue;
            }

            count++;
            if (best.op.to === null) {
                // 删除标签，并让它两侧一处的空白承担词间分隔，避免留下双空格或行尾空格：
                //   a #方向 b   → a b   （吃掉后随空格，保留前导空格作分隔）
                //   a #方向     → a     （标签是行尾词，前导空格一并删掉）
                //   a #方向␣    → a     （后随空格被吃掉，前导空格随之成为行尾空格 → 也删掉）
                //   #方向 #栽培 → #栽培 （行首标签，吃掉后随空格）
                // 行尾符本身绝不当作可吞掉的空白：否则 CRLF 会被改成 LF。
                let end = best.end;
                // 段落在 \r 处结束等价于行尾（CRLF 按 \n 切分后 \r 留在段尾）
                const endsLine = end >= seg.length || seg.charAt(end) === '\r';
                if (!endsLine && /\s/.test(seg.charAt(end))) {
                    end++;
                    const restIsEmpty = end >= seg.length || /\s/.test(seg.charAt(end));
                    // 吃掉后随空白；若其后再无正文，标签就是行尾词，前导空格也不再需要
                    if (restIsEmpty && result.endsWith(' ')) result = result.slice(0, -1);
                } else if (endsLine && result.endsWith(' ')) {
                    // 标签已是行尾词：前导空格就是行尾空格，删掉
                    result = result.slice(0, -1);
                }
                i = end;
            } else {
                result += `#${best.op.to}`;
                i = best.end;
            }
        }
        return result;
    }));
    return { text: out, count };
}

/**
 * 把正文中的 `#from` 改名为 `#to`（保留前后空白与行内代码、代码块）。
 * @returns 改写后的文本与命中处数
 */
export function replaceTagInText(text: string, from: string, to: string): { text: string; count: number } {
    // 单操作走旧的逐段正则路径：保留「尾随空格也算匹配」的语义（换名后空白原样不动）
    let count = 0;
    const out = mapLines(text, (line) => outsideInlineCode(line, (seg) => {
        return seg.replace(tagPattern(from), (_m, lead: string, trail: string) => {
            count++;
            // 原样保留前后空白，只换标签名
            return `${lead}#${to}${trail}`;
        });
    }));
    return { text: out, count };
}

/**
 * 从正文中删除 `#name`，同时吃掉一个相邻空白，避免留下双空格或行尾空格：
 *  - `a #方向 b`    → `a b`
 *  - `#方向 #栽培`  → `#栽培`
 *  - `a #方向`      → `a`（行尾，连前导空格一起删）
 *  - `a #方向 `     → `a`（标签后还有空格且已到行尾，同样不留行尾空格）
 *  - `#方向`        → 空行（不删行，保持文档结构不变）
 *
 * 规则：匹配延伸到**整行**末尾 → 整段删除；否则只删标签与后随空格、保留前导空格作为词间分隔。
 * @returns 改写后的文本与命中处数
 */
export function removeTagFromText(text: string, name: string): { text: string; count: number } {
    return applyTagOps(text, [{ from: name, to: null }]);
}

/**
 * 扫描正文中出现的全部标签名及次数（同样跳过代码块与行内代码）。
 * 用于「删除标签」时列出候选——包括已经不在词表里、但笔记中仍有引用的旧标签。
 */
export function collectTagsFromText(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    mapLines(text, (line) => {
        outsideInlineCode(line, (seg) => {
            const re = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;
            let m: RegExpExecArray | null;
            while ((m = re.exec(seg)) !== null) {
                counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
            }
            return seg;
        });
        return line;
    });
    return counts;
}
