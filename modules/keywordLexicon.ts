/**
 * 关键词词表：数据结构 + 用户可编辑的文本 / JSON 格式
 *
 * 插件**不内置任何领域词条**：词表完全由使用者自己维护，插件只提供格式与解析。
 * 两种维护方式（设置 → PDF Reader → 关键词）：
 *  1. 在设置页的文本框里逐行写（保存即生效，写在 `data.json` 的 `keywordLexicon` 字段）；
 *  2. 导入 / 导出 JSON，便于在多台机器、多个 vault 之间共享同一份词表。
 *
 * 文本格式（一行一个概念，`#` 或 `//` 开头是注释，空行忽略）：
 *
 *     规范标签 = 别名1, 别名2, 别名3
 *     产量[表型] = yield, grain yield        ← 方括号是分类，只用于设置页展示
 *     表型* = phenotype                      ← 标签后的 * 表示泛化概念，只在标题命中时参与兜底推断
 *
 * 「规范标签」最终会写进 frontmatter `tags`（不带 `#`），所以不能包含空格与 `#`；
 * 别名只是用来把同一概念的不同写法（中英文、全称/缩写、单复数、连字符变体）收敛到该标签。
 */

/** 一个词表概念 = 一个规范标签 + 若干别名 */
export interface KeywordConcept {
    /** 规范标签（不含 #，可直接写入 Obsidian frontmatter tags） */
    tag: string;
    /** 别名：中英文、全称/缩写、常见拼写变体；匹配前会统一归一化 */
    aliases: string[];
    /** 设置页 / 关键词选择器里展示用的说明（可选） */
    description?: string;
    /** 分类（可选，仅用于设置页分组展示） */
    category?: string;
    /** 泛化概念：只在标题命中时才参与兜底推断，避免摘要里的通用词污染标签 */
    generic?: boolean;
    /** 命中次数（从库生成候选时填充，用于排序与展示） */
    corpusCount?: number;
}

/** 解析问题：行号从 1 开始，对应词表文本框里的行 */
export interface LexiconIssue {
    line: number;
    message: string;
}

export interface LexiconParseResult {
    concepts: KeywordConcept[];
    issues: LexiconIssue[];
}

/** 词表文本格式说明（设置页占位符与帮助文字共用） */
export const LEXICON_FORMAT_HELP = [
    '一行一个概念：规范标签 = 别名1, 别名2',
    '产量[表型] = yield, grain yield   ← 方括号里是分类',
    '表型* = phenotype                ← 星号表示泛化概念，只在标题命中时参与兜底推断',
].join('\n');

/** 文本版词表的文件头（导出时写入） */
const LEXICON_HEADER = [
    '# PDF Reader 关键词词表',
    '# 一行一个概念：规范标签 = 别名1, 别名2, 别名3',
    '# 别名用于把同一概念的不同写法（中英文、全称/缩写、单复数）收敛到规范标签；',
    '# 标签后的 * 表示泛化概念（只在标题命中时参与兜底推断），方括号里可以写分类。',
    '# 以 # 或 // 开头的行是注释，空行忽略。',
].join('\n');

const MAX_TAG_LENGTH = 60;
/** 单个别名最长长度：太长的多半是整段正文误捕获 */
const MAX_ALIAS_LENGTH = 80;

function normalizeKey(value: string): string {
    return value.trim().toLowerCase();
}

/** 标签是否可用作 Obsidian tag（不含空格、# 与标签非法字符） */
function isValidTag(tag: string): boolean {
    if (!tag) return false;
    if (tag.length > MAX_TAG_LENGTH) return false;
    // Obsidian 的 tag 不允许空白与这些字符
    return !/[\s#^|[\]\\]/.test(tag);
}

/**
 * 解析文本词表。
 *
 * 容错优先：一行写坏了只跳过这一行并记一条 issue，其余行照常生效 ——
 * 用户可能边写边存，不能让一个笔误把整份词表清空。
 */
export function parseLexiconText(text: string): LexiconParseResult {
    const concepts: KeywordConcept[] = [];
    const issues: LexiconIssue[] = [];
    const seen = new Map<string, KeywordConcept>();

    const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((rawLine, index) => {
        const lineNo = index + 1;
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) return;

        const eq = line.indexOf('=');
        if (eq < 0) {
            issues.push({ line: lineNo, message: '缺少「=」，格式应为「规范标签 = 别名1, 别名2」' });
            return;
        }

        let left = line.slice(0, eq).trim();
        const right = line.slice(eq + 1).trim();

        let generic = false;
        if (left.endsWith('*')) {
            generic = true;
            left = left.slice(0, -1).trim();
        }
        let category: string | undefined;
        const bracket = left.match(/^(.*?)\s*[\[［]([^\]］]*)[\]］]\s*$/);
        if (bracket) {
            left = bracket[1].trim();
            category = bracket[2].trim() || undefined;
        }

        const tag = left.replace(/^#/, '').trim();
        if (!tag) {
            issues.push({ line: lineNo, message: '规范标签为空' });
            return;
        }
        if (!isValidTag(tag)) {
            issues.push({
                line: lineNo,
                message: `标签「${tag}」不能包含空格、#、|、[ ] 等字符，也不能超过 ${MAX_TAG_LENGTH} 个字符`,
            });
            return;
        }

        const aliases: string[] = [];
        const seenAlias = new Set<string>([normalizeKey(tag)]);
        for (const piece of right.split(/[,，、;；]/)) {
            const alias = piece.trim();
            if (!alias) continue;
            if (alias.length > MAX_ALIAS_LENGTH) {
                issues.push({ line: lineNo, message: `别名「${alias.slice(0, 20)}…」过长，已忽略` });
                continue;
            }
            const key = normalizeKey(alias);
            if (seenAlias.has(key)) continue;
            seenAlias.add(key);
            aliases.push(alias);
        }

        const key = normalizeKey(tag);
        const existing = seen.get(key);
        if (existing) {
            // 同一个标签写了多行：合并别名，保留先出现的那行的分类说明
            for (const alias of aliases) {
                if (!existing.aliases.some((a) => normalizeKey(a) === normalizeKey(alias))) {
                    existing.aliases.push(alias);
                }
            }
            if (generic) existing.generic = true;
            issues.push({ line: lineNo, message: `标签「${tag}」重复出现，别名已合并到第 1 次出现的那一行` });
            return;
        }

        const concept: KeywordConcept = { tag, aliases };
        if (category) concept.category = category;
        if (generic) concept.generic = true;
        seen.set(key, concept);
        concepts.push(concept);
    });

    return { concepts, issues };
}

/** 把概念列表序列化成文本词表（导出/回填文本框） */
export function serializeLexiconText(concepts: KeywordConcept[], withHeader = true): string {
    const lines: string[] = withHeader ? [LEXICON_HEADER, ''] : [];
    for (const concept of concepts) {
        // 顺序固定为 标签[分类]*：解析端先剥掉尾部的 *，再读方括号
        const head = (concept.category ? `${concept.tag}[${concept.category}]` : concept.tag)
            + (concept.generic ? '*' : '');
        const aliases = concept.aliases.filter((alias) => normalizeKey(alias) !== normalizeKey(concept.tag));
        lines.push(aliases.length > 0 ? `${head} = ${aliases.join(', ')}` : head);
    }
    return `${lines.join('\n')}\n`;
}

/** 概念列表的紧凑 JSON 结构（导入/导出与本地词表文件共用） */
export interface LexiconFile {
    version: 1;
    concepts: KeywordConcept[];
}

/**
 * 解析 JSON 词表。
 *
 * 接受三种形态：`{"version":1,"concepts":[...]}`、裸数组 `[...]`、以及只有字符串的数组
 * （`["机器学习", "深度学习"]`，此时每个字符串当作一个无别名概念）。无法解析时返回 null。
 */
export function parseLexiconJson(text: string): LexiconParseResult | null {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }

    let rawList: unknown[];
    if (Array.isArray(data)) {
        rawList = data;
    } else if (data && typeof data === 'object' && Array.isArray((data as { concepts?: unknown[] }).concepts)) {
        rawList = (data as { concepts: unknown[] }).concepts;
    } else {
        return null;
    }

    const concepts: KeywordConcept[] = [];
    const issues: LexiconIssue[] = [];
    const seen = new Set<string>();

    rawList.forEach((item, index) => {
        const lineNo = index + 1;
        let tag = '';
        let aliases: string[] = [];
        let category: string | undefined;
        let description: string | undefined;
        let generic = false;
        let corpusCount: number | undefined;

        if (typeof item === 'string') {
            tag = item.trim();
        } else if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            tag = typeof obj.tag === 'string' ? obj.tag.trim() : '';
            if (Array.isArray(obj.aliases)) {
                aliases = obj.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean);
            }
            if (typeof obj.category === 'string' && obj.category.trim()) category = obj.category.trim();
            if (typeof obj.description === 'string' && obj.description.trim()) description = obj.description.trim();
            if (obj.generic === true) generic = true;
            if (typeof obj.corpusCount === 'number' && Number.isFinite(obj.corpusCount)) {
                corpusCount = Math.max(0, Math.floor(obj.corpusCount));
            }
        }

        const cleanTag = tag.replace(/^#/, '').trim();
        if (!cleanTag) {
            issues.push({ line: lineNo, message: '第 ' + lineNo + ' 条缺少 tag，已跳过' });
            return;
        }
        if (!isValidTag(cleanTag)) {
            issues.push({ line: lineNo, message: `标签「${cleanTag}」不合法（含空格或 #、| 等字符），已跳过` });
            return;
        }
        const key = normalizeKey(cleanTag);
        if (seen.has(key)) {
            issues.push({ line: lineNo, message: `标签「${cleanTag}」重复，已跳过` });
            return;
        }
        seen.add(key);

        const unique: string[] = [];
        const seenAlias = new Set<string>([key]);
        for (const alias of aliases) {
            const aliasKey = normalizeKey(alias);
            if (!aliasKey || seenAlias.has(aliasKey)) continue;
            seenAlias.add(aliasKey);
            unique.push(alias);
        }

        const concept: KeywordConcept = { tag: cleanTag, aliases: unique };
        if (category) concept.category = category;
        if (description) concept.description = description;
        if (generic) concept.generic = true;
        if (corpusCount) concept.corpusCount = corpusCount;
        concepts.push(concept);
    });

    return { concepts, issues };
}

/** 把解析结果导出成 JSON 文本 */
export function serializeLexiconJson(concepts: KeywordConcept[]): string {
    const payload: LexiconFile = { version: 1, concepts };
    return `${JSON.stringify(payload, null, 2)}\n`;
}

/** 词表统计（设置页摘要用） */
export function summarizeLexicon(concepts: KeywordConcept[]): {
    total: number;
    aliases: number;
    categories: string;
} {
    let aliases = 0;
    const categoryCount = new Map<string, number>();
    for (const concept of concepts) {
        aliases += concept.aliases.length;
        if (concept.category) {
            categoryCount.set(concept.category, (categoryCount.get(concept.category) ?? 0) + 1);
        }
    }
    const categories = Array.from(categoryCount.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ${count}`)
        .join(' · ');
    return { total: concepts.length, aliases, categories };
}
